"""ORW-612 part C - the player's own claim about a third person (`statement`) rides the scene belt to the engine.

Closed-set only: the model proposes the closed promise kind + WHO + (optionally) a subject; the engine validates and judges. The belt's success-gated telemetry is unchanged. Stubbed llm and engine, roles only."""
import asyncio
import importlib
import inspect
import json

al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")
fl = importlib.import_module("src.fold_ledger")
ol = importlib.import_module("src.orwell_open_ledger")
bsp = importlib.import_module("src.belt_state_persist")

ROSTER = [{"id": f"npc:{n}", "name": f"Houseguest {n}"} for n in range(1, 5)]
IDS = [h["id"] for h in ROSTER]


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_validate_statement_closed_kinds_scene_listener_and_roster():
    v = al._validate_statement
    assert v({"to": "npc:1", "about": "npc:2", "kind": "targets-you"}, ["npc:1"], IDS) == {"to": "npc:1", "about": "npc:2", "kind": "targets-you"}
    assert v({"to": "npc:1", "about": "npc:2", "kind": "going-after", "object": "npc:3", "x": 1}, ["npc:1"], IDS) == {"to": "npc:1", "about": "npc:2", "kind": "going-after", "object": "npc:3"}
    assert v({"to": "npc:1", "about": "npc:2", "kind": "gossips"}, ["npc:1"], IDS) is None  # closed set
    assert v({"to": "npc:3", "about": "npc:2", "kind": "targets-you"}, ["npc:1"], IDS) is None  # the listener must be in the scene
    assert v({"to": "npc:1", "about": "npc:9", "kind": "targets-you"}, ["npc:1"], IDS) is None  # subject on the roster
    assert v({"to": "npc:1", "about": "npc:1", "kind": "targets-you"}, ["npc:1"], IDS) is None
    assert v({"to": "npc:1", "about": "npc:2", "kind": "going-after", "object": "npc:9"}, ["npc:1"], IDS) is None
    assert v("targets-you", ["npc:1"], IDS) is None and v(None, ["npc:1"], IDS) is None and v({}, ["npc:1"], IDS) is None


def test_the_fe_kinds_are_exactly_the_engines_closed_claim_set():
    import os
    ts = open(os.path.join(os.path.dirname(__file__), "..", "..", "src", "engine", "spokenClaims.ts"), encoding="utf-8").read()
    block = ts[ts.index("export const SPOKEN_CLAIM_KINDS"):ts.index("] as const;", ts.index("export const SPOKEN_CLAIM_KINDS"))]
    import re
    engine = set(re.findall(r'^\s*"([a-z-]+)",', block, flags=re.M))
    assert engine == set(al._STATEMENT_KINDS)


def test_wrapper_forwards_only_a_wellformed_statement(monkeypatch):
    seen = []

    async def fake_call(name, args=None, user=None, timeout=None):
        seen.append(args)
        return {"eventId": "e"}

    monkeypatch.setattr(oe, "_call", fake_call)
    _run(oe.record_interaction("c", with_ids=["npc:1"], statement={"to": "npc:1", "about": "npc:2", "kind": "targets-you", "n": 3, "text": "free"}))
    _run(oe.record_interaction("c", with_ids=["npc:1"], statement={"to": "npc:1", "about": "npc:2"}))
    _run(oe.record_interaction("c", with_ids=["npc:1"], statement="targets-you"))
    _run(oe.record_interaction("c", with_ids=["npc:1"]))
    assert seen[0]["statement"] == {"to": "npc:1", "about": "npc:2", "kind": "targets-you"}
    assert all("statement" not in s for s in seen[1:])


def test_staged_fold_carries_the_statement_and_survives_a_restore():
    fl._PENDING.clear()
    fl.stage_pending_fold("u", "s", content="c", with_ids=["npc:1"], kind="strategy", consequence=None, felt_minutes=None, idempotency_key="k", statement={"to": "npc:1", "about": "npc:2", "kind": "targets-you"})
    fl.stage_pending_fold("u", "s", content="c2", with_ids=["npc:1"], kind="strategy", consequence=None, felt_minutes=None, idempotency_key="k2")
    q = fl._PENDING[fl._key("u", "s")]
    assert q[0]["statement"]["kind"] == "targets-you" and q[1]["statement"] is None
    assert bsp._valid_fold_entry(dict(q[0], row_anchor=None)) and not bsp._valid_fold_entry(dict(q[0], statement="x"))
    fl._PENDING.clear()


class _Env:
    def __init__(self, monkeypatch):
        self.writes, self.belts = [], []
        monkeypatch.setattr(oe, "_RETRY_ATTEMPTS", 0)

        async def whereabouts(user=None):
            return {"room": "kitchen", "present": [{"id": i} for i in IDS]}

        async def state(owner=None, **k):
            return {"asleep": [], "pending": None}

        async def backfill(owner, fn, *args, **kw):
            self.writes.append(kw)
            return {"ok": True}

        monkeypatch.setattr(oe, "whereabouts", whereabouts)
        monkeypatch.setattr(oe, "get_game_state", state)
        monkeypatch.setattr(al, "_backfill_with_cas", backfill)
        monkeypatch.setattr(al, "_note_belt", lambda owner, belt, n=1: self.belts.append(belt))

    def record(self, obj):
        return _run(al._auto_record_scene("They talked.", "I promise I will not nominate you.", ROSTER, "http://x", "m", {}, "o", raw=json.dumps(obj)))


def _scene(**over):
    o = {"withIds": ["npc:1"], "kind": "alliance", "content": "The player promised not to nominate them.", "feltMinutes": 30}
    o.update(over)
    return o


def test_the_belt_forwards_a_valid_statement_and_drops_a_bad_one_without_losing_the_scene(monkeypatch):
    env = _Env(monkeypatch)
    assert env.record(_scene(statement={"to": "npc:1", "about": "npc:2", "kind": "targets-you"})) is True
    assert env.writes[0]["statement"] == {"to": "npc:1", "about": "npc:2", "kind": "targets-you"}
    assert env.record(_scene(statement={"to": "npc:1", "about": "npc:2", "kind": "bogus"})) is True  # no claim, scene still records
    assert "statement" not in env.writes[1]
    assert env.record(_scene()) is True
    assert "statement" not in env.writes[2]


def test_telemetry_stays_success_gated_a_statement_adds_no_belt_fire(monkeypatch):
    env = _Env(monkeypatch)
    env.record(_scene(statement={"to": "npc:1", "about": "npc:2", "kind": "targets-you"}))
    assert env.belts == []
    assert "statement" not in inspect.getsource(al._note_belt)


def test_belt_prompt_is_a_rule_naming_the_closed_kinds_with_no_examples_and_every_hop_is_wired():
    ins = al._SCENE_EXTRACT_INSTRUCTIONS
    seg = ins[ins.index("Add `statement` ONLY"):ins.index("Add `heardAboutMe` ONLY")]
    for bad in ("e.g.", "for example", "such as", "for instance", "|"):
        assert bad not in seg, bad
    for kind in al._STATEMENT_KINDS:
        assert kind in seg
    assert '"statement":{"to"' in ins
    src = inspect.getsource(al)
    assert '_validate_statement(obj.get("statement"), ids, valid)' in src
    assert '**({"statement": entry["statement"]} if entry.get("statement") else {})' in src
    assert '**({"statement": statement} if statement else {})' in src
    assert "statement=statement)" in src


def test_a_reputation_statement_needs_one_of_the_engines_role_words():
    """0184 part 2a: the player may tell a houseguest someone is known as a type of player; the label must be exactly one of the engine's role words."""
    v = al._validate_statement
    IDS = ["npc:1", "npc:2", "npc:3"]
    assert v({"to": "npc:1", "about": "npc:2", "kind": "has-reputation", "label": "snake"}, ["npc:1"], IDS) == {"to": "npc:1", "about": "npc:2", "kind": "has-reputation", "label": "snake"}
    assert v({"to": "npc:1", "about": "npc:2", "kind": "has-reputation"}, ["npc:1"], IDS) is None
    assert v({"to": "npc:1", "about": "npc:2", "kind": "has-reputation", "label": "the worst"}, ["npc:1"], IDS) is None


def test_the_fe_role_words_are_exactly_the_engines():
    import os
    import re
    ts = open(os.path.join(os.path.dirname(__file__), "..", "..", "src", "engine", "socialRoles.ts"), encoding="utf-8").read()
    line = ts[ts.index("export type RoleLabel"):ts.index(";", ts.index("export type RoleLabel"))]
    assert set(re.findall(r'"([a-z-]+)"', line)) == set(al._ROLE_LABELS)
