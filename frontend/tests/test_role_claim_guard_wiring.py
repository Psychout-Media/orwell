"""Wiring of the role-claim guard (src/role_claims.py) into the pre-emission path: the stateful wrapper in
chat_helpers (live board read, per-turn ellipsis carry, re-ground) and the call site in agent_loop. Roles only."""
import asyncio
import importlib
import os
import re

import pytest

ch = importlib.import_module("routes.chat_helpers")
FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BOARD = {
    "phase": "veto-competition", "activeNames": ["Hoh Person", "Nom Alpha", "Nom Beta", "Vetoer Gamma"], "evictedNames": [],
    "playerName": "Player Epsilon", "hohName": "Hoh Person", "vetoHolderName": None, "nomNames": ["Nom Alpha", "Nom Beta"],
    "playerStatus": "active",
}


@pytest.fixture
def board(monkeypatch):
    state = {"sig": dict(BOARD), "calls": 0}

    async def fake_capture(user):
        state["calls"] += 1
        return state["sig"]

    monkeypatch.setattr(ch, "_capture_beat_signature", fake_capture)
    ch._ROLE_CARRY.clear()
    ch._LAST_BEAT_SIG.clear()
    ch._LAST_BEAT_SIG["gs:t"] = dict(BOARD)
    monkeypatch.setattr(ch, "_desync_key", lambda user: "gs:t")
    enq = []
    monkeypatch.setattr(ch, "_reground_enqueue", lambda k, d: enq.append(d))
    state["enq"] = enq
    return state


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_creative_prose_never_reaches_the_board_read(board):
    t = "Hoh Person pours coffee and glares at Nom Alpha across the kitchen.\n"
    assert run(ch.screen_role_claims(None, t)) == t
    assert board["calls"] == 0, "no role cue ⇒ no engine read (the open set is untouched, ADR 0005 #1)"


def test_a_phantom_veto_winner_is_stripped_across_two_stream_chunks_and_a_reground_is_queued(board):
    a = run(ch.screen_role_claims(None, '**"The winner of the Power of Veto..."**\n'))
    assert "winner of the Power of Veto" in a
    b = run(ch.screen_role_claims(None, '**"...is Player Epsilon."**\n'))
    assert "Player Epsilon" not in b
    assert board["enq"] and "RE-GROUND ON TITLES" in board["enq"][-1]


def test_the_carry_does_not_leak_into_the_next_turn(board):
    run(ch.screen_role_claims(None, '**"The winner of the Power of Veto..."**\n'))
    ch._LAST_BEAT_SIG["gs:t"] = dict(BOARD)  # a new turn re-captures the signature (a new object)
    out = run(ch.screen_role_claims(None, "Other houseguests drift in. Nom Beta laughs.\n"))
    assert "Nom Beta" in out


def test_fail_open_when_the_board_read_hiccups(board, monkeypatch):
    async def boom(user):
        raise RuntimeError("engine blip")

    monkeypatch.setattr(ch, "_capture_beat_signature", boom)
    t = "Player Epsilon takes the veto.\n"
    assert run(ch.screen_role_claims(None, t)) == t


def test_the_scene_guard_runs_the_role_screen_before_the_sentence_guard_and_mirrors_its_drops_whole():
    with open(os.path.join(FRONTEND, "src", "agent_loop.py"), encoding="utf-8") as f:
        src = f.read()
    i = src.index("async def _emit_guarded_scene(")
    body = src[i: i + 9000]
    assert "chat_helpers.screen_role_claims_ex(owner, clean)" in body
    # ORW-205: the headcount wall sits between the role screen and the sentence guard (role screen ->
    # headcount wall -> sentence guard); the scene's mirror pair still starts from `screened`.
    assert (body.index("screen_role_claims_ex") < body.index("_headcount_wall_guard(screened, owner)")
            < body.index("_pre_emission_outcome_guard(counted, owner)"))
    assert "def _scene_ops(" in src and '(d, "")' in src, "role drops are erased WHOLE from the raw round buffer"
    # …and the sentence-level guard no longer carries a second copy of the screen
    j = src.index("async def _pre_emission_outcome_guard(")
    assert "screen_role_claims" not in src[j: j + 6000]


def test_without_a_turn_signature_there_is_no_stable_turn_key_so_nothing_is_carried(board):
    ch._LAST_BEAT_SIG.clear()  # no cached signature this turn
    run(ch.screen_role_claims(None, '**"The winner of the Power of Veto..."**\n'))
    assert "gs:t" not in ch._ROLE_CARRY, "no turn key ⇒ never carry a half across calls (id() of None is constant)"


def test_screen_role_claims_ex_reports_the_exact_stripped_units_for_the_whole_unit_mirror(board):
    kept, drops = run(ch.screen_role_claims_ex(None, 'Calm line.\n**"Player Epsilon takes the Power of Veto."**\nAnother calm line.\n'))
    assert any("Player Epsilon" in d for d in drops) and "Player Epsilon" not in kept
    assert "Calm line." in kept and "Another calm line." in kept


def test_the_pre_reveal_bypass_only_reads_the_board_when_text_can_hold_a_nominee_name(board, monkeypatch):
    ch._LAST_BEAT_SIG["gs:t"] = dict(BOARD, phase="eviction", evictionBallots=0, nomNames=["Nom Alpha", "Nom Beta"])
    calls0 = board["calls"]
    assert run(ch.screen_role_claims(None, "The lamps hum and the house holds its breath.\n")) == "The lamps hum and the house holds its breath.\n"
    assert board["calls"] == calls0, "no nominee name in the text ⇒ no engine round-trips"
    board["sig"] = dict(BOARD, phase="eviction", evictionBallots=0, nomNames=["Nom Alpha", "Nom Beta"])
    out = run(ch.screen_role_claims(None, '@[Hoh Person] "Nom Alpha."\n'))
    assert "Nom Alpha" not in out and board["calls"] > calls0


def test_the_pre_reveal_bypass_matches_name_tokens_on_word_boundaries_not_substrings(board):
    # A short nominee-name token ("Al") must not fire the board read on ordinary prose that merely CONTAINS it ("also", "alone").
    ch._LAST_BEAT_SIG["gs:t"] = dict(BOARD, phase="eviction", evictionBallots=0, nomNames=["Al Short", "Nom Beta"])
    calls0 = board["calls"]
    t = "Always the lamps hum, and Alone the house waits in the dark.\n"
    assert run(ch.screen_role_claims(None, t)) == t
    assert board["calls"] == calls0, "substring 'Al' inside 'Always'/'Alone' must not trigger the engine round-trips"
