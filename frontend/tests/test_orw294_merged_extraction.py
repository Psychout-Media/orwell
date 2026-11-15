"""ORW-294: the per-turn scene / NPC-move / player-move extractions as ONE structured call (flag ORWELL_MERGED_EXTRACTION, default ON since the 2026-11-12 live check).

No model is called: llm_call_async and every engine write are fakes. Roles only - the replay fixture is anonymised
(`Houseguest<N>`), taken from a recorded live rehearsal's llm-io (the recorded SEPARATE replies are what the merged fake reply is
built from). Sections: prompt reuse, (b) replay parity of the engine writes, (c) fallbacks, (a) call counts through the real loop,
(d) telemetry.
"""
import asyncio
import importlib
import json
import re
from pathlib import Path

import pytest

al = importlib.import_module("src.agent_loop")
llm_core = importlib.import_module("src.llm_core")
oe = importlib.import_module("src.orwell_engine")
ledger = importlib.import_module("src.orwell_sync_ledger")

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "orw294_recorded_turns.json"


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _kind_of(messages) -> str:
    sysmsg = messages[0]["content"]
    if "SECTION 1" in sysmsg:
        return "merged"
    if "recordable consequence" in sysmsg:
        return "scene"
    if "OTHER houseguests" in sysmsg:
        return "npc"
    if "whether the PLAYER walked" in sysmsg:
        return "player"
    return "other"


class Env:
    """Fake engine + fake model. `replies` maps a call kind to a reply string or an Exception to raise."""

    def __init__(self, monkeypatch, replies, roster):
        self.calls = []      # kind per model call, in order
        self.writes = []     # engine writes, in order
        self.replies = replies
        self.roster = roster
        monkeypatch.setattr(llm_core, "llm_call_async", self._llm)
        monkeypatch.setattr(oe, "whereabouts", self._whereabouts)
        monkeypatch.setattr(oe, "move_houseguest", self._move_houseguest)
        monkeypatch.setattr(al, "_backfill_with_cas", self._backfill)

    async def _llm(self, *a, **k):
        kind = _kind_of(k["messages"])
        self.calls.append(kind)
        r = self.replies.get(kind, "")
        if isinstance(r, BaseException):
            raise r
        return r

    async def _whereabouts(self, user=None):
        return {"room": "living-room", "present": [{"id": h["id"]} for h in self.roster]}

    async def _move_houseguest(self, hid, room, user=None):
        self.writes.append(("move_houseguest", hid, room))
        return {"status": "moved"}

    async def _backfill(self, owner, fn, *args, **kw):
        kw = {k: v for k, v in kw.items() if k != "idempotency_key"}
        self.writes.append((getattr(fn, "__name__", str(fn)), args, tuple(sorted(kw.items(), key=lambda kv: kv[0]))))
        return {"ok": True}


HOUSE = [{"id": "npc:1", "name": "Houseguest One"}, {"id": "npc:2", "name": "Houseguest Two"}]
SCENE_REPLY = '{"withIds":["npc:1"],"kind":"bonding","content":"They talked.","feltMinutes":30}'
NPC_REPLY = '{"moves":[{"id":"npc:2","room":"kitchen"}]}'
PLAYER_REPLY = '{"room":"backyard"}'


def _merged(scene=SCENE_REPLY, npc=NPC_REPLY, player=PLAYER_REPLY):
    return json.dumps({"scene": json.loads(scene), "npcMoves": json.loads(npc), "playerRoom": json.loads(player)})


def _belts(house, raws=None, narration="n", last_user="u"):
    """Apply the three belts the way the call site does (player, npc, then scene), each with its section raw (None = its own call)."""
    pm, nm, sc = raws or (None, None, None)

    async def go():
        a = await al._auto_move_player(narration, last_user, "http://x", "m", {}, "o", raw=pm)
        b = await al._auto_move_npc(narration, last_user, house, "http://x", "m", {}, "o", raw=nm)
        c = await al._auto_record_scene(narration, last_user, house, "http://x", "m", {}, "o", raw=sc)
        return a, b, c
    return _run(go())


# ── the prompt is built from the same blocks ─────────────────────────────────────────────────────────────────────────────────

def test_merged_prompt_reuses_the_three_blocks_verbatim_and_keeps_the_fence(monkeypatch):
    sent = {}

    async def spy(*a, **k):
        sent["sys"] = k["messages"][0]["content"]
        return ""
    monkeypatch.setattr(llm_core, "llm_call_async", spy)
    _run(al._merged_turn_extract("n", "u", HOUSE, "http://x", "m", {}, "o"))
    sysmsg = sent["sys"]
    assert sysmsg.startswith(al._EXTRACTION_UNTRUSTED_FENCE)
    for block in (al._SCENE_EXTRACT_INSTRUCTIONS, al._npc_move_instructions(), al._player_move_instructions()):
        assert block in sysmsg
    assert "vault" not in sysmsg.lower()  # Vault-free like each block alone


def test_separate_prompts_are_built_from_the_shared_blocks(monkeypatch):
    seen = {}
    Env(monkeypatch, {}, HOUSE)

    async def spy(*a, **k):
        seen[_kind_of(k["messages"])] = k["messages"][0]["content"]
        return ""
    monkeypatch.setattr(llm_core, "llm_call_async", spy)
    _belts(HOUSE)
    assert seen["player"] == al._EXTRACTION_UNTRUSTED_FENCE + al._player_move_instructions()
    assert seen["npc"] == al._EXTRACTION_UNTRUSTED_FENCE + al._npc_move_instructions()
    assert seen["scene"] == al._EXTRACTION_UNTRUSTED_FENCE + al._SCENE_EXTRACT_INSTRUCTIONS


# ── (b) replay parity on recorded live narrations ───────────────────────────────────────────────────────────────────────────

def _recorded_turns():
    return json.loads(FIXTURE.read_text())


def _section(raw, key):
    return al._last_json_object_with_key(raw or "", key)


@pytest.mark.parametrize("idx", range(10))
def test_replay_recorded_turn_writes_identical_merged_vs_separate(monkeypatch, idx):
    turns = _recorded_turns()
    if idx >= len(turns):
        pytest.skip("fixture has fewer turns")
    t = turns[idx]
    house = [{"id": l.split(" = ")[0], "name": l.split(" = ")[1]} for l in t["roster"].split("\n") if " = " in l]
    # the separate path: three calls, each answering with the recorded raw reply
    sep = Env(monkeypatch, {"scene": t["scene"], "npc": t["npc"], "player": t["player"]}, house)
    sep_res = _belts(house, narration=t["narration"], last_user=t["last_user"])
    assert sep.calls == ["player", "npc", "scene"]
    # the merged path: ONE reply built from the recorded replies' JSON
    pr = re.findall(r"\{[^{}]*\"room\"[^{}]*\}", t["player"], re.DOTALL)
    merged = json.dumps({"scene": _section(t["scene"], "withIds") or {"withIds": []},
                         "npcMoves": _section(t["npc"], "moves") or {"moves": []},
                         "playerRoom": json.loads(pr[-1]) if pr else {"room": None}})
    mer = Env(monkeypatch, {"merged": merged}, house)
    raws = _run(al._merged_turn_extract(t["narration"], t["last_user"], house, "http://x", "m", {}, "o"))
    assert mer.calls == ["merged"] and all(v is not None for v in raws.values()), raws
    mer_res = _belts(house, raws=(raws["playerRoom"], raws["npcMoves"], raws["scene"]),
                     narration=t["narration"], last_user=t["last_user"])
    assert mer.calls == ["merged"], "the belts must not call the model again once their section is prefetched"
    assert mer_res == sep_res
    assert mer.writes == sep.writes, (mer.writes, sep.writes)


def test_replay_fixture_exercises_real_writes():
    """Guard the fixture: across the recorded turns the separate path must fold scenes AND move houseguests (else parity proves nothing)."""
    turns = _recorded_turns()
    assert len(turns) >= 5
    flat = lambda s: s.replace(" ", "")
    assert any('"withIds":[]' not in flat(t["scene"]) for t in turns)
    assert any('"moves":[{' in flat(t["npc"]) for t in turns)


# ── (c) fallbacks ──────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_section_with_invalid_json_falls_back_to_its_own_call_and_the_others_apply(monkeypatch):
    bad = json.dumps({"scene": {"withIds": ["npc:1"], "kind": "bonding", "content": "x"}, "npcMoves": "garbage",
                      "playerRoom": {"room": "backyard"}})
    env = Env(monkeypatch, {"merged": bad, "npc": NPC_REPLY}, HOUSE)
    raws = _run(al._merged_turn_extract("n", "u", HOUSE, "http://x", "m", {}, "o"))
    assert raws["npcMoves"] is None and raws["scene"] is not None and raws["playerRoom"] is not None
    # the call site hands the gather helper the prefetched pair: only the failed section is extracted again
    pm, nm = _run(al._gather_move_extractions("n", "u", HOUSE, "http://x", "m", {}, "o",
                                              prefetched=(raws["playerRoom"], raws["npcMoves"])))
    assert env.calls == ["merged", "npc"]
    assert json.loads(pm) == {"room": "backyard"} and json.loads(nm) == {"moves": [{"id": "npc:2", "room": "kitchen"}]}


def test_a_call_error_falls_back_to_the_three_separate_calls(monkeypatch):
    env = Env(monkeypatch, {"merged": RuntimeError("boom"), "scene": SCENE_REPLY, "npc": NPC_REPLY, "player": PLAYER_REPLY}, HOUSE)
    raws = _run(al._merged_turn_extract("n", "u", HOUSE, "http://x", "m", {}, "o"))
    assert raws == {"scene": None, "npcMoves": None, "playerRoom": None}
    pm, nm = _run(al._gather_move_extractions("n", "u", HOUSE, "http://x", "m", {}, "o", prefetched=(None, None)))
    res = _belts(HOUSE, raws=(pm, nm, raws["scene"]))
    assert sorted(env.calls) == sorted(["merged", "player", "npc", "scene"])
    assert res == (True, 1, True)


def test_unparseable_and_wrong_shaped_sections_are_rejected_strictly():
    p = al._parse_merged_reply
    assert p("") == {"scene": None, "npcMoves": None, "playerRoom": None}
    assert p("no json at all")["scene"] is None
    out = p('{"scene":{"withIds":"npc:1"},"npcMoves":{"moves":{}},"playerRoom":{"room":7}}')
    assert out == {"scene": None, "npcMoves": None, "playerRoom": None}
    ok = p('thinking... {"scene":{"withIds":[]},"npcMoves":{"moves":[]},"playerRoom":{"room":null}}')
    assert all(v is not None for v in ok.values())
    two = p('{"playerRoom":{"room":"kitchen"}} then {"playerRoom":{"room":"backyard"}}')  # draft-then-final: the LAST object wins
    assert json.loads(two["playerRoom"]) == {"room": "backyard"}


# ── (a) call counts through the REAL loop ───────────────────────────────────────────────────────────────────────────────────

ROSTER = [{"id": "npc:1", "name": "Contestant Alpha", "status": "active"},
          {"id": "npc:2", "name": "Contestant Beta", "status": "active"}]
TURN_SCENE = ("Contestant Alpha leans in and tells you quietly that you are safe with the group. Then Contestant Beta "
              "walks into the kitchen to start dinner, and you head out to the backyard to think it over.")


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch):
    for name in ("_SILENT_FORCE_ADVANCE_STREAK", "_ADVANCE_STALL_LEVEL", "_ADVANCE_STALL_FLAGS",
                 "_TURNS_SINCE_PROGRESS", "_ANTI_STALE_CAP_HOLDS", "_LOOP_STREAK"):
        d = getattr(al, name, None)
        if isinstance(d, dict):
            d.clear()
    monkeypatch.delenv("ORWELL_MERGED_EXTRACTION", raising=False)
    monkeypatch.delenv("ORWELL_FLAGS_OFF", raising=False)
    yield


def _drive(monkeypatch, replies, owner="u"):
    import src.tool_index as ti
    env = Env(monkeypatch, replies, ROSTER)
    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)
    monkeypatch.setattr(al, "_loop_break_streak_update", lambda *a, **k: False)

    async def fake_state(owner=None, **_k):
        return {"phase": "premiere", "moment": "premiere", "week": 1, "beatSeq": 1, "pending": None, "house": ROSTER, "started": True}

    async def fake_move_to(room, user=None, **k):
        return {"room": room}

    async def fake_record(*a, **k):
        return {"eventId": "e1"}

    async def fake_advance(*a, **k):
        return {"beatSeq": 2, "phase": "hoh-competition", "pending": None, "event": None}

    async def noop(*a, **k):
        return False

    monkeypatch.setattr(oe, "get_game_state", fake_state)
    monkeypatch.setattr(oe, "move_to", fake_move_to)
    monkeypatch.setattr(oe, "record_interaction", fake_record)
    monkeypatch.setattr(oe, "advance_game", fake_advance)
    for n in ("_auto_record_deal", "_auto_confide", "_auto_expose_secret", "_auto_trade_secret", "_auto_answer_deal_offer"):
        monkeypatch.setattr(al, n, noop)

    async def fake_stream(candidates, messages, **kwargs):
        yield 'data: ' + json.dumps({"delta": TURN_SCENE}) + '\n\n'
        yield 'data: ' + json.dumps({"type": "finish", "reason": "stop"}) + '\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)
    user_msg = "I tell Contestant Alpha I will keep the secret quiet and walk out to the backyard."

    async def drive():
        async for _ in al.stream_agent_loop(
                "https://api.deepseek.com/chat/completions", "deepseek-flash",
                [{"role": "system", "content": "You are the narrator."}, {"role": "user", "content": user_msg}],
                max_rounds=1, game_mode="game", owner=owner):
            pass
    _run(drive())
    return env


SEPARATE = {"scene": SCENE_REPLY, "npc": NPC_REPLY, "player": PLAYER_REPLY}


def _extraction_calls(env):
    return [c for c in env.calls if c in ("merged", "scene", "npc", "player")]


def test_flag_off_is_the_three_separate_calls(monkeypatch):
    monkeypatch.setenv("ORWELL_MERGED_EXTRACTION", "0")  # the default is ON now; the explicit off keeps the three-call path covered
    env = _drive(monkeypatch, SEPARATE)
    assert sorted(_extraction_calls(env)) == ["npc", "player", "scene"], env.calls
    assert ("move_houseguest", "npc:2", "kitchen") in env.writes
    assert any(w[0].endswith("move_to") and w[1] == ("backyard",) for w in env.writes), env.writes
    assert any(w[0].endswith("record") for w in env.writes), env.writes


def test_flag_on_all_three_belts_make_exactly_one_call_and_identical_writes(monkeypatch):
    off = _drive(monkeypatch, SEPARATE)
    monkeypatch.setenv("ORWELL_MERGED_EXTRACTION", "1")
    on = _drive(monkeypatch, {"merged": _merged()})
    assert _extraction_calls(on) == ["merged"], on.calls
    assert on.writes == off.writes, (on.writes, off.writes)


def test_flag_on_scene_section_failure_costs_only_the_scene_call(monkeypatch):
    monkeypatch.setenv("ORWELL_MERGED_EXTRACTION", "1")
    bad = json.dumps({"scene": "nope", "npcMoves": json.loads(NPC_REPLY), "playerRoom": json.loads(PLAYER_REPLY)})
    env = _drive(monkeypatch, {"merged": bad, "scene": SCENE_REPLY})
    assert sorted(_extraction_calls(env)) == ["merged", "scene"], env.calls
    assert any(w[0].endswith("record") for w in env.writes)
    assert ("move_houseguest", "npc:2", "kitchen") in env.writes


def test_flag_on_merged_call_error_falls_back_to_the_three_calls(monkeypatch):
    monkeypatch.setenv("ORWELL_MERGED_EXTRACTION", "1")
    env = _drive(monkeypatch, dict(SEPARATE, merged=RuntimeError("down")))
    assert sorted(_extraction_calls(env)) == ["merged", "npc", "player", "scene"], env.calls
    assert any(w[0].endswith("record") for w in env.writes)


def test_diagnostic_flags_off_profile_forces_the_flag_off(monkeypatch):
    monkeypatch.setenv("ORWELL_MERGED_EXTRACTION", "1")
    monkeypatch.setenv("ORWELL_FLAGS_OFF", "1")
    assert al._merged_extraction_enabled() is False


def test_the_flag_defaults_on_and_an_explicit_off_wins(monkeypatch):
    # deliberate re-pin (2026-11-12 live check proved it: -18% calls/turn, scene recorded 10/10): ON by default, ORWELL_MERGED_EXTRACTION=0 turns it off.
    assert al._merged_extraction_enabled() is True
    for off in ("0", "false", "no", "off"):
        monkeypatch.setenv("ORWELL_MERGED_EXTRACTION", off)
        assert al._merged_extraction_enabled() is False


# ── (d) telemetry stays success-gated ───────────────────────────────────────────────────────────────────────────────────────

def test_belt_fires_are_counted_per_applied_correction_not_per_call(monkeypatch):
    owner = "t294-telemetry-owner"
    ledger.clear(owner)
    monkeypatch.setenv("ORWELL_MERGED_EXTRACTION", "1")
    _drive(monkeypatch, {"merged": _merged()}, owner=owner)
    totals = ledger.get_belt_totals(owner)
    assert totals.get("auto-move-player") == 1 and totals.get("auto-move-npc") == 1 and totals.get("auto-record-scene") == 1, totals
    ledger.clear(owner)
    # nothing applied (empty sections) => nothing counted, even though the merged call succeeded
    _drive(monkeypatch, {"merged": _merged(scene='{"withIds":[]}', npc='{"moves":[]}', player='{"room":null}')}, owner=owner)
    assert ledger.get_belt_totals(owner) == {}
