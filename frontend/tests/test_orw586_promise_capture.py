"""ORW-586 / 0187 slice 3 - a typed `promise` rides the scene belt to the engine, and the player's own typed words reach the open-ledger extractor.

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


def test_validate_promise_closed_set_roster_and_in_scene_speaker():
    v = al._validate_promise
    assert v({"what": "no-nominate"}, ["npc:1"], IDS) == {"what": "no-nominate"}
    assert v({"what": "no-evict-vote", "by": "player"}, ["npc:1"], IDS) == {"what": "no-evict-vote"}
    assert v({"what": "no-nominate", "by": "npc:1", "subject": "npc:2"}, ["npc:1"], IDS) == {"what": "no-nominate", "from": "npc:1", "subject": "npc:2"}
    assert v({"what": "final-two", "by": "npc:1", "extra": "x", "n": 3}, ["npc:1"], IDS) == {"what": "final-two", "from": "npc:1"}  # nothing else crosses
    assert v({"what": "share-info"}, ["npc:1"], IDS) is None  # open text is the ledger extractor's, never judged
    assert v({"what": "bribe"}, ["npc:1"], IDS) is None  # closed set
    assert v({"what": "no-nominate", "by": "npc:9"}, ["npc:1"], IDS) is None  # off-scene speaker dropped, never coerced
    assert v({"what": "no-nominate", "subject": "npc:9"}, ["npc:1"], IDS) is None  # not on the roster
    assert v("no-nominate", ["npc:1"], IDS) is None and v(None, ["npc:1"], IDS) is None and v({}, ["npc:1"], IDS) is None


def test_wrapper_forwards_only_a_wellformed_promise(monkeypatch):
    seen = []

    async def fake_call(name, args=None, user=None, timeout=None):
        seen.append(args)
        return {"eventId": "e"}

    monkeypatch.setattr(oe, "_call", fake_call)
    _run(oe.record_interaction("c", with_ids=["npc:1"], promise={"what": "no-nominate", "from": "npc:1", "subject": "npc:2", "text": "free", "n": 3}))
    _run(oe.record_interaction("c", with_ids=["npc:1"], promise={"what": ""}))
    _run(oe.record_interaction("c", with_ids=["npc:1"], promise="no-nominate"))
    _run(oe.record_interaction("c", with_ids=["npc:1"]))
    assert seen[0]["promise"] == {"what": "no-nominate", "from": "npc:1", "subject": "npc:2"}
    assert all("promise" not in s for s in seen[1:])  # malformed / absent => byte-identical request


def test_staged_fold_carries_the_promise_and_survives_a_restore():
    fl._PENDING.clear()
    fl.stage_pending_fold("u", "s", content="c", with_ids=["npc:1"], kind="strategy", consequence=None, felt_minutes=None, idempotency_key="k", promise={"what": "no-nominate"})
    fl.stage_pending_fold("u", "s", content="c2", with_ids=["npc:1"], kind="strategy", consequence=None, felt_minutes=None, idempotency_key="k2")
    q = fl._PENDING[fl._key("u", "s")]
    assert q[0]["promise"] == {"what": "no-nominate"} and q[1]["promise"] is None
    assert bsp._valid_fold_entry(dict(q[0], row_anchor=None)) and not bsp._valid_fold_entry(dict(q[0], promise="x"))
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


def test_the_belt_forwards_a_valid_promise_and_drops_a_bad_one_without_losing_the_scene(monkeypatch):
    env = _Env(monkeypatch)
    assert env.record(_scene(promise={"what": "no-nominate", "by": "player"})) is True
    assert env.writes[0]["promise"] == {"what": "no-nominate"}
    assert env.record(_scene(promise={"what": "bribe"})) is True  # the scene still records
    assert "promise" not in env.writes[1]
    assert env.record(_scene()) is True
    assert "promise" not in env.writes[2]  # absent => byte-identical call


def test_telemetry_stays_success_gated_a_promise_adds_no_belt_fire(monkeypatch):
    env = _Env(monkeypatch)
    env.record(_scene(promise={"what": "no-nominate"}))
    assert env.belts == []  # the promise is part of the ONE recorded scene; it is never counted as its own correction
    assert "promise" not in inspect.getsource(al._note_belt)


def test_belt_prompt_is_a_rule_with_no_examples_or_menu_and_every_hop_is_wired():
    ins = al._SCENE_EXTRACT_INSTRUCTIONS
    seg = ins[ins.index("Add `promise` ONLY"):ins.index("Add `heardAboutMe` ONLY")]
    for bad in ("e.g.", "for example", "such as", "for instance", "one of:", "|"):
        assert bad not in seg, bad
    assert '"promise":{"what"' in ins
    for what in al._PROMISE_WHATS:
        assert what in seg  # the closed kinds the engine judges are named, nothing else
    assert "share-info" not in seg
    src = inspect.getsource(al)
    assert '_validate_promise(obj.get("promise"), ids, valid)' in src
    assert '**({"promise": entry["promise"]} if entry.get("promise") else {})' in src
    assert '**({"promise": promise} if promise else {})' in src
    assert "promise=promise)" in src  # staged


def test_the_engine_closed_set_is_the_fe_set_plus_open_text():
    ts = open(__import__("os").path.join(__import__("os").path.dirname(__file__), "..", "..", "src", "engine", "promiseTerms.ts"), encoding="utf-8").read()
    line = next(l for l in ts.splitlines() if l.startswith("export const PROMISE_WHATS"))
    engine = {w for w in al._PROMISE_WHATS} | {"share-info"}
    assert all(f'"{w}"' in line for w in engine) and line.count('"') == 2 * len(engine)


def test_open_ledger_extractor_gets_the_players_message_in_its_own_labelled_block():
    prompts, sent = [], []

    async def llm(m):
        prompts.append(m)
        return '{"entries":[{"text":"I will never put you on the block","speaker":"player","addressedTo":["npc:3"],"kind":"promise"}],"resolutions":[]}'

    async def write(p):
        sent.append(p)
        return {"accepted": True}

    narr = "The kitchen was quiet and the two of them sat close, talking about the week ahead and what the house had been whispering. " * 2
    present = [{"id": "npc:3", "name": "Houseguest 3"}]
    n = _run(ol.capture_open_ledger(narr, present, llm, write, player_message="I will never put you on the block"))
    assert n == 1 and sent[0]["speaker"] == "player"
    user = prompts[0][1]["content"]
    assert "THE PLAYER'S MESSAGE (the player speaking):\nI will never put you on the block" in user
    assert user.index("THE NARRATION:") < user.index("THE PLAYER'S MESSAGE")  # a separate block after the narrator-visible text, which is unchanged
    assert "THE PLAYER'S MESSAGE" in prompts[0][0]["content"]
    # no player message => exactly the prompt it always sent
    prompts.clear()
    _run(ol.capture_open_ledger(narr, present, llm, write))
    assert "PLAYER'S MESSAGE" not in prompts[0][1]["content"] and "PLAYER'S MESSAGE" not in prompts[0][0]["content"]
    assert prompts[0][1]["content"].endswith("\n\nJSON:")


def test_the_loop_passes_the_players_message_to_the_ledger_hook():
    src = inspect.getsource(al)
    assert "_ol.after_turn(_turn_narration_visible, owner, _belt_endpoint, _belt_model, _belt_headers, player_message=_extract_last_user_message(messages)" in src
