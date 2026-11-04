"""A2 (2026-07-03 final pre-ship audit) — the SCENE-level circuit-breaker + wrong-identity board guard.

The live red-team found the model fabricates closed-set outcomes wholesale even when the engine is up:
"you won HOH" narrated THREE times with zero tool calls (the engine truth: the player dropped mid-comp,
an NPC won), plus a phantom eviction and a faked nomination ceremony. The pre-existing pre-emission guard
was ineffective — it excised only the winner SENTENCE and shipped the surrounding phantom scene, and it
only checked identity on an un-moved field. This suite pins the three hardening pieces:

  (a) a whole-SCENE circuit-breaker (`screen_streamed_scene_break`) that rejects the entire fabricated
      scene, not one sentence — and fails CLOSED when the engine can't be reached while a board change
      is claimed (anti-sycophancy mandate #3);
  (b) wrong-IDENTITY detection for HOH / veto (the model crowns the wrong person, or tells the PLAYER
      they won a title the engine handed to someone else); and
  (c) the agent-loop wiring that emits a diegetic feeds-cut line in place of the lie.

Roles only: throwaway proper nouns appear INSIDE narration strings to exercise the regexes, exactly as
the sibling spine tests do, and never carry test intent.
"""

import asyncio
import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
agent_loop = importlib.import_module("src.agent_loop")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


_USER = "u-a2-breaker"


@pytest.fixture(autouse=True)
def _clean_state():
    chat_helpers._LAST_BEAT_SIG.pop(_USER, None)
    chat_helpers._DESYNC_REGROUND.pop(_USER, None)
    yield
    chat_helpers._LAST_BEAT_SIG.pop(_USER, None)
    chat_helpers._DESYNC_REGROUND.pop(_USER, None)


def _sig(**over):
    base = {
        "week": 4, "phase": "hoh", "pending": None,
        "hoh": "npc:1", "hohName": "Marcus",
        "noms": ["npc:2", "npc:3"], "nomNames": ["Sofia", "Mario"],
        "activeNames": ["Sofia", "Mario", "Marcus", "Nina", "Sam"],
        "vetoHolder": None, "vetoHolderName": None, "vetoUsed": False,
        "playerIsHoh": False, "playerHasVeto": False,
        "evicted": 2, "evictedNames": ["Trent Tucker", "Deb"],
        "finished": False, "room": "kitchen", "present": [],
    }
    base.update(over)
    return base


# ── (b) wrong-identity + self-crown: _narration_claims_outcome ─────────────── #

def test_self_hoh_win_flagged_when_player_is_not_hoh():
    """The exact audit failure: "you won HOH" while the engine shows the player is NOT the HOH. Here the
    crown really moved to an NPC and the phase rolled PAST the HOH beat — the old no-move/phase-gated
    branch would miss it, but the self-crown check (playerIsHoh False) catches it phase-independently."""
    before = _sig(phase="hoh", hoh="npc:0")
    after = _sig(phase="nominations", hoh="npc:9", hohName="Marcus", playerIsHoh=False)
    d = chat_helpers._narration_claims_outcome(
        "The lights come up and it's official — you won HOH! The house turns to you.", before, after)
    assert d and "HEAD OF HOUSEHOLD" in d


def test_self_hoh_win_not_flagged_when_player_really_is_hoh():
    before = _sig(phase="hoh", hoh="npc:0")
    after = _sig(phase="hoh", hoh="player", hohName="You", playerIsHoh=True)
    d = chat_helpers._narration_claims_outcome(
        "You won HOH — the key is yours this week.", before, after)
    assert d is None


def test_self_hoh_win_not_flagged_when_player_identity_unknown():
    """Old-style signature / pre-game: `playerIsHoh` is None → never fire (no false positive). The crown
    moved to an NPC, so the no-move branch also stays quiet."""
    before = _sig(phase="hoh", hoh="npc:0")
    after = _sig(phase="nominations", hoh="npc:9", hohName="Marcus", playerIsHoh=None)
    d = chat_helpers._narration_claims_outcome("You won HOH!", before, after)
    assert d is None


def test_conditional_self_hoh_is_not_flagged():
    """"if you win HOH" (present-tense hypothetical) is NOT a committed self-crown, and outside the HOH
    beat it is pure flavor → never flagged."""
    before = _sig(phase="social", hoh="npc:1")
    after = _sig(phase="social", hoh="npc:1", playerIsHoh=False)
    d = chat_helpers._narration_claims_outcome(
        "If you win HOH next week, you control the whole board.", before, after)
    assert d is None


def test_wrong_named_hoh_flagged_even_when_field_moved():
    """A fresh crown really happened (Marcus is HOH), but the model names the WRONG active houseguest."""
    before = _sig(hoh=None, hohName=None)
    after = _sig(hoh="npc:1", hohName="Marcus")  # engine crowned Marcus
    d = chat_helpers._narration_claims_outcome(
        "Nina wins Head of Household and grabs the key!", before, after)
    assert d and "WRONG houseguest crowned Head of Household" in d


def test_correct_named_hoh_emits():
    before = _sig(hoh=None, hohName=None)
    after = _sig(hoh="npc:1", hohName="Marcus")
    d = chat_helpers._narration_claims_outcome(
        "Marcus wins Head of Household and grabs the key!", before, after)
    assert d is None


def test_invented_name_hoh_not_flagged_here():
    """A name matching NO active houseguest is the roster guard's problem, not a wrong-identity crown."""
    after = _sig(hoh="npc:1", hohName="Marcus")
    d = chat_helpers._narration_claims_outcome(
        "Zephyrina wins Head of Household!", _sig(hoh=None, hohName=None), after)
    assert d is None


def test_self_veto_win_flagged_when_player_lacks_veto():
    d = chat_helpers._narration_claims_outcome(
        "You won the Power of Veto — you're safe and you can shake up the block.",
        _sig(phase="veto"), _sig(phase="veto", playerHasVeto=False))
    assert d and "POWER OF VETO" in d


def test_wrong_named_veto_flagged():
    after = _sig(phase="veto", vetoHolder="npc:2", vetoHolderName="Mario")
    d = chat_helpers._narration_claims_outcome(
        "Nina wins the Power of Veto!", _sig(phase="veto"), after)
    assert d and "WRONG houseguest winning the Power of Veto" in d


# ── (b2) NAR-3 (product-review, 2026-07): wrong-identity for NOMINATIONS ───── #
# nomNames was added by #561 for exactly this comparison but was never wired into a mismatch
# check — only the count-based branch existed, so a moved nominee set naming the WRONG person
# (the live "Harrison" vs "Mario" bug) slipped through untouched. These mirror the HOH/veto suite
# above, adapted for a 2-person set instead of a singleton.

def test_wrong_named_nominee_flagged_even_when_set_moved():
    """A nomination really committed this turn (Sofia + Mario), but the model names a THIRD active
    houseguest (Nina) as one of the nominees — the live #561 bug shape."""
    before = _sig(phase="nominations", noms=[], nomNames=[])
    after = _sig(phase="nominations", noms=["npc:2", "npc:3"], nomNames=["Sofia", "Mario"])
    d = chat_helpers._narration_claims_outcome(
        "Sofia and Nina are nominated for eviction this week.", before, after)
    assert d and "WRONG houseguest staged as a nominee" in d


def test_correct_named_nominees_emit():
    before = _sig(phase="nominations", noms=[], nomNames=[])
    after = _sig(phase="nominations", noms=["npc:2", "npc:3"], nomNames=["Sofia", "Mario"])
    d = chat_helpers._narration_claims_outcome(
        "Sofia and Mario are nominated for eviction this week.", before, after)
    assert d is None


def test_wrong_named_nominee_flagged_via_nominates_verb():
    before = _sig(phase="nominations", noms=[], nomNames=[])
    after = _sig(phase="nominations", noms=["npc:2", "npc:3"], nomNames=["Sofia", "Mario"])
    d = chat_helpers._narration_claims_outcome(
        "Marcus nominates Nina and Mario for eviction.", before, after)
    assert d and "WRONG houseguest staged as a nominee" in d


def test_invented_name_nominee_not_flagged_here():
    """A name matching NO active houseguest is the roster guard's problem, not a wrong-identity nom."""
    before = _sig(phase="nominations", noms=[], nomNames=[])
    after = _sig(phase="nominations", noms=["npc:2", "npc:3"], nomNames=["Sofia", "Mario"])
    d = chat_helpers._narration_claims_outcome(
        "Zephyrina and Mario are nominated for eviction.", before, after)
    assert d is None


def test_nominee_mismatch_not_flagged_when_noms_unchanged():
    """Speculation/strategy talk ("I might nominate Nina") outside a real commit must never trip the
    wrong-identity branch — only a nominee set that ACTUALLY moved this turn is policed. An unchanged
    set falls through to the existing count-based phantom branch instead (a different desync label)."""
    before = _sig(phase="nominations", noms=["npc:2", "npc:3"], nomNames=["Sofia", "Mario"])
    after = _sig(phase="nominations", noms=["npc:2", "npc:3"], nomNames=["Sofia", "Mario"])
    d = chat_helpers._narration_claims_outcome(
        "Nina and Mario are nominated for eviction.", before, after)
    assert d is not None and "WRONG houseguest staged as a nominee" not in d


def test_nominee_mismatch_scoped_to_nomination_phase():
    """Outside the nomination/veto-ceremony phases, the same phrasing is never policed (mirrors the
    HOH/veto phase-scoping — ADR 0005: never rail-correct creative prose off-beat)."""
    before = _sig(phase="social", noms=[], nomNames=[])
    after = _sig(phase="social", noms=["npc:2", "npc:3"], nomNames=["Sofia", "Mario"])
    d = chat_helpers._narration_claims_outcome(
        "Looking back, Nina and Mario ended up nominated that week.", before, after)
    assert d is None


def test_single_wrong_nominee_named_alone_still_flagged():
    """Only ONE nominee named in the sentence (not a coordinated pair) still trips when that one name
    is wrong — the model doesn't have to name both to fabricate an identity."""
    before = _sig(phase="nominations", noms=[], nomNames=[])
    after = _sig(phase="nominations", noms=["npc:2", "npc:3"], nomNames=["Sofia", "Mario"])
    d = chat_helpers._narration_claims_outcome(
        "Nina is nominated for eviction this week.", before, after)
    assert d and "WRONG houseguest staged as a nominee" in d


# ── (a) the whole-scene circuit-breaker ────────────────────────────────────── #

def _board(monkeypatch, sig):
    """Make the live board reads return exactly `sig` (as if reduced from status+state)."""
    async def fake_capture(user=None):
        return dict(sig)
    monkeypatch.setattr(chat_helpers, "_capture_beat_signature", fake_capture)


def test_scene_break_returns_directive_for_self_crown_phantom(monkeypatch):
    chat_helpers._LAST_BEAT_SIG[_USER] = _sig()
    _board(monkeypatch, _sig(playerIsHoh=False))
    d = _run(chat_helpers.screen_streamed_scene_break(
        _USER, "The feeds swing to you — you won HOH! Everyone erupts."))
    assert d is not None
    assert _USER in chat_helpers._DESYNC_REGROUND


def test_scene_break_log_names_the_phase_and_the_claim(monkeypatch, caplog):
    import logging
    chat_helpers._LAST_BEAT_SIG[_USER] = _sig()
    _board(monkeypatch, _sig(playerIsHoh=False))
    with caplog.at_level(logging.WARNING):
        _run(chat_helpers.screen_streamed_scene_break(_USER, "The feeds swing to you — you won HOH! Everyone erupts."))
    line = next(r.getMessage() for r in caplog.records if "scene circuit-breaker HELD a phantom board change" in r.getMessage())
    assert "phase=hoh" in line and len(line) > 140, line


def test_scene_break_none_for_creative_prose_even_if_engine_down(monkeypatch):
    """Creative prose has no closed-set claim → the breaker never reads the board, never cuts."""
    async def boom(user=None):
        raise AssertionError("the breaker read the board for pure creative prose (ADR 0005 #1)")
    monkeypatch.setattr(chat_helpers, "_capture_beat_signature", boom)
    chat_helpers._LAST_BEAT_SIG[_USER] = _sig()
    d = _run(chat_helpers.screen_streamed_scene_break(
        _USER, "They linger by the pool trading quiet reads; nothing is decided tonight."))
    assert d is None


def test_scene_break_fails_closed_when_engine_unreachable(monkeypatch):
    """A board change claimed while the engine can't be read → FAIL CLOSED (mandate #3): cut the scene."""
    chat_helpers._LAST_BEAT_SIG[_USER] = _sig()

    async def none_capture(user=None):
        return None  # engine unreachable / odd shape
    monkeypatch.setattr(chat_helpers, "_capture_beat_signature", none_capture)
    d = _run(chat_helpers.screen_streamed_scene_break(
        _USER, "After the vote, one houseguest is evicted from the house."))
    assert d is chat_helpers._ENGINE_UNREACHABLE_REGROUND
    assert _USER in chat_helpers._DESYNC_REGROUND


def test_scene_break_none_without_baseline(monkeypatch):
    """No BEFORE baseline this turn (engine reachable) → uncertain → do NOT cut (conservatism)."""
    chat_helpers._LAST_BEAT_SIG.pop(_USER, None)
    _board(monkeypatch, _sig(playerIsHoh=False))
    d = _run(chat_helpers.screen_streamed_scene_break(_USER, "You won HOH!"))
    assert d is None


def test_scene_break_none_when_board_backs_the_claim(monkeypatch):
    chat_helpers._LAST_BEAT_SIG[_USER] = _sig(phase="hoh", hoh="npc:0")
    _board(monkeypatch, _sig(phase="hoh", hoh="player", hohName="You", playerIsHoh=True))
    d = _run(chat_helpers.screen_streamed_scene_break(_USER, "You won HOH — the key is yours."))
    assert d is None


# ── (c) the agent-loop emit helper rejects the WHOLE scene, not one sentence ── #

def test_emit_helper_replaces_phantom_scene_with_cutaway_when_nothing_shown(monkeypatch):
    """A2's core repair: on a phantom board change the whole scene is dropped and a diegetic feeds-cut
    line replaces it — the fabricated setup + reaction never reach the player."""
    async def break_it(user, text):
        return "phantom"  # pretend the breaker fired
    monkeypatch.setattr(chat_helpers, "screen_streamed_scene_break", break_it)
    out = _run(agent_loop._emit_guarded_scene(
        "You won HOH! The whole house rushes to hug you as the confetti falls.",
        _USER, scene_broken=False, emitted_visible=False, cutaway_emitted=False))
    assert out.scene_broken is True
    assert out.cutaway_emitted is True
    assert out.text == agent_loop._SCENE_CUTAWAY_LINE
    assert "you won" not in out.text.lower()


def test_emit_helper_drops_rest_of_scene_after_break_without_second_cutaway(monkeypatch):
    """Once broken (and a legit prefix already shown), later chunks are dropped silently — no lie, and
    the cutaway line is emitted at most once."""
    async def break_it(user, text):
        return "phantom"
    monkeypatch.setattr(chat_helpers, "screen_streamed_scene_break", break_it)
    out = _run(agent_loop._emit_guarded_scene(
        "The house erupts in cheers for the new king.",
        _USER, scene_broken=True, emitted_visible=True, cutaway_emitted=False))
    assert out.text == ""
    assert out.scene_broken is True


def test_emit_helper_streams_clean_prose_untouched(monkeypatch):
    """No break, no closed-set claim → the chunk streams byte-identical (open set is never touched)."""
    async def no_break(user, text):
        return None
    monkeypatch.setattr(chat_helpers, "screen_streamed_scene_break", no_break)

    async def no_guard(text, owner):
        return text
    monkeypatch.setattr(agent_loop, "_pre_emission_outcome_guard", no_guard)
    text = "They circle the kitchen island, feeling out where the numbers really sit."
    out = _run(agent_loop._emit_guarded_scene(
        text, _USER, scene_broken=False, emitted_visible=True, cutaway_emitted=False))
    assert out.text == text
    assert out.scene_broken is False


# ── the beat signature carries the new wrong-identity fields ───────────────── #

def test_beat_signature_carries_title_names_and_player_flags():
    status = {
        "week": 3, "phase": "hoh",
        "hoh": {"id": "npc:9", "name": "Marcus"},
        "nominees": [], "veto": {"holder": {"id": "player", "name": "You"}, "used": False, "players": []},
        "pending": None,
    }
    state = {"week": 3, "phase": "hoh", "finished": False,
             "house": [{"id": "player", "status": "active", "name": "You"},
                       {"id": "npc:9", "status": "active", "name": "Marcus"}],
             "player": {"id": "player", "name": "You"}}
    sig = chat_helpers._beat_signature(status, state)
    assert sig["hohName"] == "Marcus"
    assert sig["playerIsHoh"] is False          # the player is NOT HOH (Marcus is)
    assert sig["vetoHolderName"] == "You"
    assert sig["playerHasVeto"] is True          # the player holds the veto


def test_beat_signature_player_flags_none_when_no_player_card():
    status = {"week": 1, "phase": "hoh", "hoh": {"id": "npc:1", "name": "A"},
              "nominees": [], "veto": {"holder": None, "used": False}, "pending": None}
    state = {"finished": False, "house": []}  # no player card
    sig = chat_helpers._beat_signature(status, state)
    assert sig["playerIsHoh"] is None
    assert sig["playerHasVeto"] is None


# ── source-pin: the stream loop wires the whole-scene breaker ──────────────── #

def test_stream_loop_uses_the_scene_guard_helper():
    import os
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(base, "src", "agent_loop.py"), encoding="utf-8") as fh:
        src = fh.read()
    assert "_emit_guarded_scene(" in src
    assert "screen_streamed_scene_break" in src
    assert "_SCENE_CUTAWAY_LINE" in src


# ── A/B 2026-11-04: ONE bounded in-turn re-voice after a cut that left only the cutaway ──────────────────────── #

def test_cut_retry_directive_carries_the_queued_engine_truth_when_only_the_cutaway_was_shown():
    chat_helpers._DESYNC_REGROUND.pop(_USER, None)
    chat_helpers._reground_enqueue(_USER, "RE-GROUND ON THE BOARD — the engine shows week 1, phase veto-competition.")
    d = agent_loop._scene_cut_retry_directive(True, False, agent_loop._SCENE_CUTAWAY_LINE, _USER)
    assert d and "SCENE CUT" in d and "RE-GROUND ON THE BOARD" in d and "has not happened" in d
    assert _USER in chat_helpers._DESYNC_REGROUND, "the next-turn re-ground stays queued — the retry only reads it"


def test_cut_retry_is_bounded_and_skipped_when_real_narration_was_shown_or_nothing_was_cut():
    assert agent_loop._scene_cut_retry_directive(True, True, agent_loop._SCENE_CUTAWAY_LINE, _USER) is None, "already spent"
    assert agent_loop._scene_cut_retry_directive(False, False, "", _USER) is None, "nothing cut"
    assert agent_loop._scene_cut_retry_directive(True, False, "The room goes quiet. " + agent_loop._SCENE_CUTAWAY_LINE, _USER) is None, \
        "the player saw real narration this turn — a trimmed tail is not a hole"


def test_cut_retry_works_without_a_queued_directive():
    chat_helpers._DESYNC_REGROUND.pop(_USER, None)
    d = agent_loop._scene_cut_retry_directive(True, False, "", _USER)
    assert d and "BOARD block" in d


def test_stream_loop_wires_the_single_cut_retry():
    import os
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = open(os.path.join(base, "src", "agent_loop.py"), encoding="utf-8").read()
    assert "_scene_cut_retry_directive(_scene_broken, _scene_cut_retry_used, full_response, owner)" in src
    assert "if _is_live_game and not tool_blocks and _scene_broken:" in src
    assert src.count("_scene_cut_retry_used = True") == 1 and src.count("_scene_cut_retry_used = False") == 1
