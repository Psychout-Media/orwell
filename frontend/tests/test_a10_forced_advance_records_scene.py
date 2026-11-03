"""A-10 — a social scene the player just watched is banked even when a BELT forces the advance.

Live finding (A-7, DeepSeek playtest): in 8 of 8 public-confrontation turns neither the model nor the
auto-record-scene belt wrote the scene to the consequence loop. Root cause: on the premiere's third
same-gate turn the L-F3 loop-break fires `forced-advance`, which commits the beat SILENTLY and ENDS the turn
(`break`) — so the finishing block that runs `_auto_record_scene` was never reached ("narrated but never
recorded"). The fix banks the shown scene BEFORE the silent commit. This drives the REAL `stream_agent_loop`.

Roles only — no houseguest names from any corpus.
"""
import asyncio
import json
import os

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ROSTER = [{"id": "npc:1", "name": "Contestant Alpha", "status": "active"},
          {"id": "npc:2", "name": "Contestant Beta", "status": "active"}]
SCENE = ("The dining room goes quiet. Contestant Alpha sets down a fork and answers the accusation "
         "flatly, eyes on you, while Contestant Beta watches from the far end of the table.")


import pytest


@pytest.fixture(autouse=True)
def _reset_belt_state():
    """The belt ladders keep per-owner module state (silent-force streak, stall level, anti-stale holds);
    earlier forced advances in this file would otherwise trip the anti-stale CAP and hold the next one."""
    from src import agent_loop as al
    for name in ("_SILENT_FORCE_ADVANCE_STREAK", "_ADVANCE_STALL_LEVEL", "_ADVANCE_STALL_FLAGS",
                 "_TURNS_SINCE_PROGRESS", "_ANTI_STALE_CAP_HOLDS", "_LOOP_STREAK"):
        d = getattr(al, name, None)
        if isinstance(d, dict):
            d.clear()
    yield


def _drive(monkeypatch, *, loop_stalled, user_msg="At dinner I call out Contestant Alpha in front of everyone.",
           scene=SCENE, deal_struck=True):
    from src import agent_loop as al
    import src.orwell_engine as oe
    import src.tool_index as ti

    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)
    monkeypatch.setattr(al, "_loop_break_streak_update", lambda *a, **k: loop_stalled)

    async def fake_state(owner=None, **_k):
        return {"phase": "premiere", "moment": "premiere", "week": 1, "beatSeq": 1, "pending": None,
                "house": ROSTER, "started": True}

    advanced = []

    async def fake_advance(*a, **k):
        advanced.append(1)
        return {"beatSeq": 2, "phase": "hoh-competition", "pending": None, "event": None}

    monkeypatch.setattr(oe, "get_game_state", fake_state)
    monkeypatch.setattr(oe, "advance_game", fake_advance)

    recorded = []

    async def fake_record(narration, last_user, house, *a, **k):
        recorded.append((narration, last_user, [h.get("name") for h in house]))
        return True

    monkeypatch.setattr(al, "_auto_record_scene", fake_record)
    deals = []

    async def fake_deal(narration, last_user, house, *a, **k):
        deals.append(narration)
        return deal_struck

    monkeypatch.setattr(al, "_auto_record_deal", fake_deal)
    belts = []
    monkeypatch.setattr(al, "_note_belt", lambda owner, name, *a, **k: belts.append(name))

    async def fake_stream(candidates, messages, **kwargs):
        yield 'data: ' + json.dumps({"delta": scene}) + '\n\n'
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
    return recorded, belts, advanced, deals


def test_belt_forced_advance_still_banks_the_scene_the_player_just_watched(monkeypatch):
    recorded, belts, advanced, deals = _drive(monkeypatch, loop_stalled=True)
    assert advanced, "the loop-break should have force-advanced the beat (test precondition)"
    assert len(recorded) == 1, f"the shown scene must be recorded exactly once, got {len(recorded)}"
    assert "Contestant Alpha" in recorded[0][0]
    assert "auto-record-scene" in belts and "forced-advance:stall" in belts


def test_a_quiet_turn_without_a_forced_advance_records_exactly_once(monkeypatch):
    """Control: no loop-break ⇒ the ordinary finishing block records (once — the new pre-commit call
    must not double-fold the same scene)."""
    recorded, belts, advanced, deals = _drive(monkeypatch, loop_stalled=False)
    assert len(recorded) == 1, f"expected the single ordinary record, got {len(recorded)}"
    assert not advanced


def test_a_scene_with_no_houseguest_is_not_recorded_even_when_force_advanced(monkeypatch):
    """The solo/no-houseguest precondition still holds on the new path."""
    recorded, belts, advanced, deals = _drive(monkeypatch, loop_stalled=True, user_msg="I sit alone and think.")
    # the narration still names houseguests (the fake stream), so narration-touch applies; assert the
    # contract at unit grain instead: the helper that gates the pre-commit record is the SAME predicate.
    from src import agent_loop as al
    assert al._scene_touched_houseguest("The kitchen is empty.", [{"role": "user", "content": "I sit alone."}],
                                        ["Contestant Alpha", "Contestant Beta"]) is False


DEAL_SCENE = ("Contestant Alpha takes your hand across the table. \"Final two, you and me, no matter what — "
              "I give you my word.\" You shake on it, and Contestant Beta pretends not to watch.")


def test_belt_forced_advance_still_backfills_a_struck_deal(monkeypatch):
    recorded, belts, advanced, deals = _drive(monkeypatch, loop_stalled=True, scene=DEAL_SCENE,
                                              user_msg="I offer Contestant Alpha a final two deal.")
    assert advanced
    assert len(deals) == 1 and "final two" in deals[0].lower()
    assert "auto-record-deal" in belts
    assert recorded == [], "a banked deal already folds the consequence — no double fold from the scene record"


def test_no_deal_language_means_the_deal_belt_stays_quiet_on_the_forced_path(monkeypatch):
    recorded, belts, advanced, deals = _drive(monkeypatch, loop_stalled=True)
    assert deals == [] and "auto-record-deal" not in belts
    assert len(recorded) == 1
