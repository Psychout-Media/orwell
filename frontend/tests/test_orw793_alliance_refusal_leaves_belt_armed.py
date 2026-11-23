"""ORW-793 - a model-driven joinAlliance / formAlliance the ENGINE REFUSED recorded nothing, so the omission remains: the alliance belt may run once more that turn,
but never for the pitch / group the engine just declined (the refusal is the authority), and telemetry stays success-gated. Driven through the REAL `stream_agent_loop`
with the stateful engine stand-in of test_orw780_alliance_yes_belt.py (membership changes only when a lever is called; the stand-in refuses the way the engine does).
The model's own tool call goes through the real tool-result handling (only `execute_tool_block` is stubbed, and it calls the stand-in lever). No state is set by hand. Roles only."""
import asyncio
import json

import pytest

ROSTER = [{"id": "npc:1", "name": "Contestant Alpha", "status": "active"},
          {"id": "npc:2", "name": "Contestant Beta", "status": "active"},
          {"id": "npc:3", "name": "Contestant Gamma", "status": "active"}]
SCENE = "Contestant Alpha grins and clasps your hand: the three of you are in this together."
P7 = {"id": "alliance:7", "name": "Group Seven", "members": [{"id": "npc:1", "name": "Contestant Alpha"}, {"id": "npc:2", "name": "Contestant Beta"}]}
P8 = {"id": "alliance:8", "name": "Group Eight", "members": [{"id": "npc:2", "name": "Contestant Beta"}, {"id": "npc:3", "name": "Contestant Gamma"}]}


@pytest.fixture(autouse=True)
def _reset():
    from src import agent_loop as al
    from routes import chat_helpers as ch
    for name in ("_SILENT_FORCE_ADVANCE_STREAK", "_ADVANCE_STALL_LEVEL", "_ADVANCE_STALL_FLAGS", "_TURNS_SINCE_PROGRESS", "_ANTI_STALE_CAP_HOLDS", "_LOOP_STREAK"):
        d = getattr(al, name, None)
        if isinstance(d, dict):
            d.clear()
    al._forget_season_pacing("u")
    ch._forget_season_pacing("u")
    yield


def _drive(monkeypatch, *, model_calls, extraction, pitches=(P7, P8), refuses_join=("alliance:7",), refuses_form_under=3):
    """`model_calls`: the narrator's own tool calls in round 1, e.g. [("joinAlliance", {"allianceId": "alliance:7"})]."""
    from src import agent_loop as al
    import src.orwell_engine as oe
    import src.tool_index as ti
    import src.llm_core as lc

    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)
    monkeypatch.setattr(al, "_loop_break_streak_update", lambda *a, **k: False)

    engine = {"pitches": {p["id"]: p for p in pitches}, "alliances": [], "calls": []}

    async def fake_state(*a, **k):
        st = {"phase": "hoh-competition", "moment": "social", "week": 1, "beatSeq": 1, "pending": None, "house": ROSTER, "started": True}
        if engine["pitches"]:
            st["alliancePitches"] = list(engine["pitches"].values())
        if engine["alliances"]:
            st["alliances"] = list(engine["alliances"])
        return st

    async def fake_join(alliance_id, expected_beat_seq=None, user=None, name=None):
        engine["calls"].append(("join", alliance_id))
        pitch = engine["pitches"].get(alliance_id)
        if not pitch or alliance_id in refuses_join:
            return None  # the engine's own refusal: not close enough to the founder
        engine["pitches"].pop(alliance_id)
        view = {"id": pitch["id"], "name": pitch["name"], "members": pitch["members"] + [{"id": "player", "name": "Player"}], "youAreFounder": False}
        engine["alliances"].append(view)
        return view

    async def fake_form(name, members, expected_beat_seq=None, user=None):
        engine["calls"].append(("form", name, tuple(members)))
        if len(members) < refuses_form_under:
            return None  # the engine's bond gate: a group this small is not taken
        view = {"id": "alliance:new", "name": name or "our alliance", "members": [{"id": m, "name": m} for m in members] + [{"id": "player", "name": "Player"}], "youAreFounder": True}
        engine["alliances"].append(view)
        return view

    async def fake_advance(*a, **k):
        return {"beatSeq": 2, "pending": None, "event": None}

    monkeypatch.setattr(oe, "get_game_state", fake_state)
    monkeypatch.setattr(oe, "join_alliance", fake_join)
    monkeypatch.setattr(oe, "form_alliance", fake_form)
    monkeypatch.setattr(oe, "advance_game", fake_advance)

    async def fake_llm(*a, **k):
        sysmsg = " ".join(str(m.get("content")) for m in (k.get("messages") or []))
        return extraction if "AGREED, in this Big Brother scene, to be in an ALLIANCE" in sysmsg else ""

    monkeypatch.setattr(lc, "llm_call_async", fake_llm)

    async def fake_exec(block, **k):  # the narrator's own lever call, carried out by the real tool implementation against the stand-in engine
        from src import tool_implementations as ti_impl
        if block.tool_type == "joinAlliance":
            return block.tool_type, await ti_impl.do_join_alliance(block.content, owner="u")
        if block.tool_type == "formAlliance":
            return block.tool_type, await ti_impl.do_form_alliance(block.content, owner="u")
        return block.tool_type, {"output": "{}", "exit_code": 0}

    monkeypatch.setattr(al, "execute_tool_block", fake_exec)

    async def _no(*a, **k):
        return False

    for n in ("_auto_record_scene", "_auto_record_deal", "_auto_confide", "_auto_expose_secret", "_auto_trade_secret", "_auto_move_player", "_auto_move_npc", "_auto_answer_deal_offer"):
        monkeypatch.setattr(al, n, _no)
    belts = []
    monkeypatch.setattr(al, "_note_belt", lambda owner, name, *a, **k: belts.append(name))

    rounds = {"n": 0}

    async def fake_stream(candidates, messages, **kwargs):
        rounds["n"] += 1
        if rounds["n"] == 1 and model_calls:
            calls = [{"id": f"c{i}", "name": n, "arguments": json.dumps(a)} for i, (n, a) in enumerate(model_calls)]
            yield 'data: ' + json.dumps({"type": "tool_calls", "calls": calls}) + '\n\n'
            yield 'data: ' + json.dumps({"type": "finish", "reason": "tool_calls"}) + '\n\n'
        else:
            yield 'data: ' + json.dumps({"delta": SCENE}) + '\n\n'
            yield 'data: ' + json.dumps({"type": "finish", "reason": "stop"}) + '\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    async def drive():
        gen = al.stream_agent_loop("https://api.deepseek.com/chat/completions", "deepseek-flash",
                                   [{"role": "system", "content": "You are the narrator."}, {"role": "user", "content": "Yes, I'm in. Count me in on the alliance."}],
                                   max_rounds=4, game_mode="game", owner="u")
        async for _ in gen:
            pass

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(drive())
    finally:
        loop.close()
    return engine, belts


def _player_in(engine, alliance_id):
    return any(a["id"] == alliance_id and any(m["id"] == "player" for m in a["members"]) for a in engine["alliances"])


def test_a_refused_model_join_leaves_the_belt_armed_for_a_different_pitch(monkeypatch):
    engine, belts = _drive(monkeypatch, model_calls=[("joinAlliance", {"allianceId": "alliance:7"})], extraction='{"join":"alliance:8","form":null}')
    assert engine["calls"] == [("join", "alliance:7"), ("join", "alliance:8")]   # the model's refused call, then the belt's different one
    assert _player_in(engine, "alliance:8") and not _player_in(engine, "alliance:7")
    assert belts.count("auto-alliance") == 1


def test_the_belt_never_re_proposes_the_pitch_the_engine_just_refused(monkeypatch):
    engine, belts = _drive(monkeypatch, model_calls=[("joinAlliance", {"allianceId": "alliance:7"})], extraction='{"join":"alliance:7","form":null}')
    assert engine["calls"] == [("join", "alliance:7")]   # only the model's call: the refused pitch is not sent again
    assert not engine["alliances"] and "auto-alliance" not in belts


def test_a_refused_model_form_is_not_repeated_but_a_larger_group_is_a_new_ask(monkeypatch):
    refused = [("formAlliance", {"name": "Kitchen Table", "members": ["npc:1", "npc:2"]})]
    again, belts = _drive(monkeypatch, pitches=(), model_calls=refused, extraction='{"join":null,"form":{"name":"Kitchen Table","members":["npc:2","npc:1"]}}')
    assert again["calls"] == [("form", "Kitchen Table", ("npc:1", "npc:2"))] and not again["alliances"] and "auto-alliance" not in belts
    larger, belts = _drive(monkeypatch, pitches=(), model_calls=refused, extraction='{"join":null,"form":{"name":"Kitchen Table","members":["npc:1","npc:2","npc:3"]}}')
    assert larger["calls"] == [("form", "Kitchen Table", ("npc:1", "npc:2")), ("form", "Kitchen Table", ("npc:1", "npc:2", "npc:3"))]
    assert larger["alliances"] and belts.count("auto-alliance") == 1


def test_a_model_join_the_engine_took_still_stands_the_belt_down(monkeypatch):
    engine, belts = _drive(monkeypatch, model_calls=[("joinAlliance", {"allianceId": "alliance:8"})], extraction='{"join":"alliance:7","form":null}')
    assert engine["calls"] == [("join", "alliance:8")]   # the model's own, taken: no back-fill on top
    assert _player_in(engine, "alliance:8") and "auto-alliance" not in belts


def test_a_belt_that_is_refused_again_is_not_counted(monkeypatch):
    engine, belts = _drive(monkeypatch, model_calls=[("joinAlliance", {"allianceId": "alliance:7"})], extraction='{"join":"alliance:8","form":null}',
                           refuses_join=("alliance:7", "alliance:8"))
    assert engine["calls"] == [("join", "alliance:7"), ("join", "alliance:8")] and not engine["alliances"]
    assert "auto-alliance" not in belts   # success-gated: a refusal is never a fired belt
