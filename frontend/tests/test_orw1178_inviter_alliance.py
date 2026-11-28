"""ORW-1178 (built on the ORW-780 harness) - a bare yes to a houseguest's invitation commits the inviter's real alliance in the same turn; a narrated roster the engine contradicts is held; the old wording follows.
ORW-780 - an alliance the player says yes to aloud must become engine membership, driven through the REAL
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


INVITE = 'Jace leans in. "There is a group. Valerie, Scott, me. I would like you in it."'


def _drive(monkeypatch, *, user_msg, extraction, pitches=(PITCH,), engine_accepts=True, model_calls_join=False, prior=INVITE):
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

    async def fake_join(alliance_id, expected_beat_seq=None, user=None, name=None, inviter=None):
        if inviter:
            engine["calls"].append(("join-inviter", inviter))
            if not engine_accepts:
                return None
            view = {"id": "alliance:6", "name": "Real Six", "members": [{"id": inviter, "name": inviter}, {"id": "npc:9", "name": "Kayla"}, {"id": "player", "name": "Player"}], "youAreFounder": False}
            engine["alliances"].append(view)
            return view
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
            [{"role": "system", "content": "You are the narrator."}, *([{"role": "assistant", "content": prior}] if prior else []), {"role": "user", "content": user_msg}],
            max_rounds=3, game_mode="game", owner="u")
        async for _ in gen:
            pass

    asyncio.get_event_loop().run_until_complete(drive())
    return engine, belts, extractions


def _player_in_alliance(engine):
    return any(m["id"] == "player" for a in engine["alliances"] for m in a["members"])


def test_a_bare_yes_to_an_invitation_commits_the_inviters_alliance_in_the_same_turn(monkeypatch):
    engine, belts, extractions = _drive(monkeypatch, pitches=(), user_msg="Im in.",
                                        extraction='{"join":null,"invited_by":"npc:1","form":null}')
    assert extractions, "the invitation in the scene before is the signal; a bare yes names no alliance"
    assert engine["calls"] == [("join-inviter", "npc:1")]
    assert _player_in_alliance(engine)
    members = {m["id"] for a in engine["alliances"] for m in a["members"]}
    assert {"player", "npc:1"} <= members
    assert belts.count("auto-alliance") == 1


def test_an_engine_refusal_of_the_invitation_records_nothing(monkeypatch):
    engine, belts, _ = _drive(monkeypatch, pitches=(), user_msg="Im in.", engine_accepts=False,
                              extraction='{"join":null,"invited_by":"npc:1","form":null}')
    assert not _player_in_alliance(engine) and "auto-alliance" not in belts


def test_an_invented_inviter_is_never_sent(monkeypatch):
    engine, belts, _ = _drive(monkeypatch, pitches=(), user_msg="Im in.", extraction='{"join":null,"invited_by":"npc:404","form":null}')
    assert engine["calls"] == [] and belts == []


def test_a_bare_yes_with_no_invitation_before_it_costs_no_model_call(monkeypatch):
    engine, belts, extractions = _drive(monkeypatch, pitches=(), user_msg="Im in.", prior="The kitchen is quiet.",
                                        extraction='{"join":null,"invited_by":"npc:1","form":null}')
    assert extractions == [] and engine["calls"] == []


def test_join_alliance_forwards_the_inviter_without_an_alliance_id(monkeypatch):
    import asyncio as aio
    import src.orwell_engine as oe
    seen = {}

    async def fake_call(tool, args, user=None):
        seen["tool"], seen["args"] = tool, args
        return {"id": "alliance:6"}

    monkeypatch.setattr(oe, "_call", fake_call)
    aio.get_event_loop().run_until_complete(oe.join_alliance("", user="u", inviter="npc:1"))
    assert seen == {"tool": "joinAlliance", "args": {"inviter": "npc:1"}}


# ── the roster the narration speaks must equal the engine's ──
STATE = {"house": [{"id": "npc:1", "name": "Jace Hale"}, {"id": "npc:2", "name": "Valerie Moss"}, {"id": "npc:3", "name": "Scott Penn"}, {"id": "npc:9", "name": "Kayla Roe"}],
         "alliances": [{"id": "alliance:6", "name": "The Late Table", "members": [{"id": "npc:1", "name": "Jace Hale"}, {"id": "npc:9", "name": "Kayla Roe"}, {"id": "player", "name": "Player"}]}]}


def test_a_narrated_roster_the_engine_contradicts_is_held_with_the_real_roster():
    from src import claim_commit as cc
    out = cc.claim_conflicts("Then you are in. The Late Table now has Valerie, Scott and Jace at it.", STATE, "u")
    assert [f for f, _ in out] == [cc.CLAIM_ROSTER]
    assert "Kayla Roe" in out[0][1] and "Valerie" not in out[0][1]
    assert "Kayla Roe" in cc.correction_for(cc.CLAIM_ROSTER, out[0][1])


def test_a_roster_that_matches_the_engine_or_names_no_group_is_untouched():
    from src import claim_commit as cc
    assert cc.claim_conflicts("The Late Table is Jace and Kayla, and now you.", STATE, "u") == []
    assert cc.claim_conflicts("Valerie and Scott whisper by the pantry.", STATE, "u") == []
    assert cc.claim_conflicts("Jace says \"The Late Table is Valerie and Scott\".", STATE, "u") == []  # speech is a character talking
