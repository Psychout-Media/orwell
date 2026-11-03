"""F-1 (A-11 playtest, #1781): the scene circuit-breaker cuts the LIVE stream, but the PERSISTED message used
to keep the cut text — a reload / second window then showed the invented outcome. Persisted == shown. Roles only."""
import os
import re

from src import agent_loop

_SRC = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "agent_loop.py"), encoding="utf-8").read()
SHOWN = "The water hits the wall in sheets."
CUT = "A named houseguest goes first and drops. Another follows. The rest hold."


def test_a_cut_round_persists_exactly_what_was_emitted():
    raw = (SHOWN + " " + CUT).strip()
    assert agent_loop._persisted_round_text(raw, scene_broken=True, scrub_active=True, round_emitted=SHOWN) == SHOWN


def test_a_cut_round_with_only_the_cutaway_persists_the_cutaway_not_the_raw_text():
    out = agent_loop._persisted_round_text(CUT, scene_broken=True, scrub_active=True, round_emitted=agent_loop._SCENE_CUTAWAY_LINE)
    assert out == agent_loop._SCENE_CUTAWAY_LINE and CUT not in out


def test_an_uncut_round_is_untouched():
    assert agent_loop._persisted_round_text(SHOWN, scene_broken=False, scrub_active=True, round_emitted="x") == SHOWN
    assert agent_loop._persisted_round_text(SHOWN, scene_broken=True, scrub_active=False, round_emitted="x") == SHOWN


def test_a_per_sentence_outcome_drop_is_mirrored_out_of_the_raw_buffer():
    before = "Keep this. Drop this invented result. Keep that."
    after = "Keep this. Keep that."
    raw = "Intro. " + before
    out = agent_loop._mirror_wall_drop(raw, before, after)
    assert "Drop this invented result." not in out and "Keep this." in out and "Keep that." in out


def test_the_stream_loop_uses_both_halves_at_every_guard_site():
    # both emit sites (mid-loop + trailing flush) accumulate the emitted text and mirror an outcome-guard drop
    assert _SRC.count("_round_emitted_text += _guarded_text") == 2
    assert len(re.findall(r"round_response = _apply_mirror_ops\(round_response, _guarded\.mirror_ops\)", _SRC)) == 2  # N-6: exact per-segment ops (a dropped aside is erased whole; the synthetic flush closer is never searched for)
    wiring = _SRC.split("round_texts.append(cleaned_round)")[0][-700:]
    assert "_persisted_round_text(" in wiring and "round_emitted=_round_emitted_text" in wiring
    # a blank-turn cutaway (guard emptied the round, scene not "broken") is persisted too (review on #1997)
    assert "_SCENE_CUTAWAY_LINE in _round_emitted_text" in wiring
