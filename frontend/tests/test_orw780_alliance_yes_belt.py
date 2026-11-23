"""ORW-780 - an alliance the player says yes to aloud must become engine membership, driven through the REAL
`stream_agent_loop` (the ORW-732 pattern for alliances). The narrator voices the handshake but never calls
joinAlliance / formAlliance; the belt `_auto_alliance` back-fills it. The engine stand-in is STATEFUL (membership
changes only when the lever is called, and it refuses the way the engine does: not an open pitch / bond-gated), so
no test sets the outcome by hand. Success-gated telemetry (`auto-alliance` counts only an APPLIED membership),
model-driven calls win, a refusal records nothing. No model: the extraction call is a stub. Roles only.
"""
import asyncio
import json

import pytest

ROSTER = [{"id": "npc:1", "name": "Contestant Alpha", "status": "active"},
          {"id": "npc:2", "name": "Contestant Beta", "status": "active"},
          {"id": "npc:3", "name": "Contestant Gamma", "status": "active"}]
SCENE = "Contestant Alpha grins and clasps your hand: the three of you are in this together."
PITCH = {"id": "alliance:7", "name": "Group Seven", "members": [{"id": "npc:1", "name": "Contestant Alpha"},
                                                                  {"id": "npc:2", "name": "Contestant Beta"}]}


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    from src import agent_loop as al
    from routes import chat_helpers as ch
    for name in ("_SILENT_FORCE_ADVANCE_STREAK", "_ADVANCE_STALL_LEVEL", "_ADVANCE_STALL_FLAGS",
                 "_TURNS_SINCE_PROGRESS", "_ANTI_STALE_CAP_HOLDS", "_LOOP_STREAK"):
        d = getattr(al, name, None)
        if isinstance(d, dict):
            d.clear()
    al._forget_season_pacing("u")
    ch._forget_season_pacing("u")
    yield


def _drive(monkeypatch, *, user_msg, extraction, pitches=(PITCH,), engine_accepts=True, model_calls_join=False):
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
        st = {"phase": "hoh-competition", "moment": "social", "week": 1, "beatSeq": 1, "pending": None,
              "house": ROSTER, "started": True}
        if engine["pitches"]:
            st["alliancePitches"] = list(engine["pitches"].values())
        if engine["alliances"]:
            st["alliances"] = list(engine["alliances"])
        return st

    async def fake_join(alliance_id, expected_beat_seq=None, user=None, name=None):
        engine["calls"].append(("join", alliance_id))
        pitch = engine["pitches"].get(alliance_id)
        if not pitch or not engine_accepts:
            return None  # the engine's own refusal: not an open pitch / not close enough
        engine["pitches"].pop(alliance_id)
        view = {"id": pitch["id"], "name": pitch["name"], "members": pitch["members"] + [{"id": "player", "name": "Player"}],
                "youAreFounder": False}
        engine["alliances"].append(view)
        return view

    async def fake_form(name, members, expected_beat_seq=None, user=None):
        engine["calls"].append(("form", name, tuple(members)))
        if not engine_accepts or len(members) < 2:
            return None
        view = {"id": "alliance:new", "name": name or "our alliance",
                "members": [{"id": m, "name": m} for m in members] + [{"id": "player", "name": "Player"}], "youAreFounder": True}
        engine["alliances"].append(view)
        return view

    async def fake_advance(*a, **k):
        return {"beatSeq": 2, "pending": None, "event": None}

    monkeypatch.setattr(oe, "get_game_state", fake_state)
    monkeypatch.setattr(oe, "join_alliance", fake_join)
    monkeypatch.setattr(oe, "form_alliance", fake_form)
    monkeypatch.setattr(oe, "advance_game", fake_advance)

    extractions = []

    async def fake_llm(*a, **k):
        sysmsg = " ".join(str(m.get("content")) for m in (k.get("messages") or []))
        if "AGREED, in this Big Brother scene, to be in an ALLIANCE" not in sysmsg:
            return ""
        extractions.append(k.get("call_class"))
        return extraction

    monkeypatch.setattr(lc, "llm_call_async", fake_llm)

    async def _no(*a, **k):
        return False

    for n in ("_auto_record_scene", "_auto_record_deal", "_auto_confide", "_auto_expose_secret", "_auto_trade_secret",
              "_auto_move_player", "_auto_move_npc", "_auto_answer_deal_offer"):
        monkeypatch.setattr(al, n, _no)
    belts = []
    monkeypatch.setattr(al, "_note_belt", lambda owner, name, *a, **k: belts.append(name))

    async def fake_stream(candidates, messages, **kwargs):
        yield 'data: ' + json.dumps({"delta": SCENE}) + '\n\n'
        yield 'data: ' + json.dumps({"type": "finish", "reason": "stop"}) + '\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    async def drive():
        gen = al.stream_agent_loop(
            "https://api.deepseek.com/chat/completions", "deepseek-flash",
            [{"role": "system", "content": "You are the narrator."}, {"role": "user", "content": user_msg}],
            max_rounds=3, game_mode="game", owner="u")
        async for _ in gen:
            pass

    asyncio.get_event_loop().run_until_complete(drive())
    return engine, belts, extractions


def _player_in_alliance(engine):
    return any(m["id"] == "player" for a in engine["alliances"] for m in a["members"])


def test_yes_to_a_pitched_alliance_puts_the_player_in_it(monkeypatch):
    engine, belts, _ = _drive(monkeypatch, user_msg="Yes, I'm in. Count me in.", extraction='{"join":"alliance:7","form":null}')
    assert _player_in_alliance(engine)
    assert engine["calls"] == [("join", "alliance:7")]
    assert belts.count("auto-alliance") == 1


def test_a_named_group_the_player_agreed_to_is_formed(monkeypatch):
    engine, belts, _ = _drive(
        monkeypatch, pitches=(), user_msg="Fine, the three of us, let's call it the Kitchen Table alliance.",
        extraction='{"join":null,"form":{"name":"Kitchen Table","members":["npc:1","npc:2"]}}')
    assert _player_in_alliance(engine)
    assert engine["calls"] == [("form", "Kitchen Table", ("npc:1", "npc:2"))]
    assert belts.count("auto-alliance") == 1


def test_an_engine_refusal_records_nothing_and_is_not_counted(monkeypatch):
    engine, belts, _ = _drive(monkeypatch, user_msg="Yes, I'm in.", extraction='{"join":"alliance:7","form":null}',
                              engine_accepts=False)
    assert not _player_in_alliance(engine)
    assert "auto-alliance" not in belts


def test_an_invented_id_or_a_lone_member_is_never_sent(monkeypatch):
    engine, belts, _ = _drive(
        monkeypatch, user_msg="Yes to the alliance.",
        extraction='{"join":"alliance:999","form":{"name":"x","members":["npc:1","npc:404"]}}')
    assert engine["calls"] == []
    assert belts == []


def test_an_ambiguous_scene_records_nothing(monkeypatch):
    engine, belts, _ = _drive(monkeypatch, user_msg="Maybe. Let me think about the alliance.", extraction='{"join":null,"form":null}')
    assert engine["calls"] == [] and belts == []


def test_no_open_pitch_and_no_alliance_talk_costs_no_model_call(monkeypatch):
    engine, belts, extractions = _drive(monkeypatch, pitches=(), user_msg="Yes, sure, sounds good.",
                                        extraction='{"join":null,"form":null}')
    assert extractions == [] and engine["calls"] == []


def test_a_model_driven_join_means_the_belt_stands_down(monkeypatch):
    from src import agent_loop as al
    src = open(al.__file__).read()
    # the per-turn counter is set the moment the model calls either lever itself, which closes the belt's gate
    assert 'block.tool_type in ("joinAlliance", "formAlliance")' in src
    assert "_turn_alliance_nudges = 1" in src
