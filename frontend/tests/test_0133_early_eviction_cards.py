"""0133 — early eviction: the FE can answer the two new engine decisions (a freeze if it could not).

The engine raises `spectator-choice` (watch | skip) when the PLAYER is voted out before the jury forms, and
`finale-interview` after the crowning. A pending kind the card cannot render/submit freezes the game (the 0025
lesson), so this pins the whole FE chain: the one kind source, the card-only gate (A-6), the card's wire payload,
the copy, the beat chip and the throwaway fast-forward drivers. Roles only.
"""
import importlib
import os
import re

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
orwell_engine = importlib.import_module("src.orwell_engine")
NEW = ("spectator-choice", "finale-interview")


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


def test_the_new_kinds_are_known_and_card_only():
    for k in NEW:
        assert k in orwell_engine.DECISION_KINDS, k
        assert k in orwell_engine.CARD_ONLY_KINDS, f"{k} must bind ONLY on its card, never from model prose"
        assert k not in orwell_engine.MODEL_SUBMITTABLE_KINDS


def test_the_card_submits_the_mode_and_posture_on_vote_with_optional_words():
    js = _read("static", "js", "orwellDecision.js")
    assert '"spectator-choice": "vote"' in js and '"finale-interview": "vote"' in js
    # the interview shares the exit-interview payload (stance on `vote`, optional words on `statement`)
    assert 'kind === "goodbye-message" || kind === "exit-interview" || kind === "finale-interview"' in js
    assert 'kind === "exit-interview" || kind === "finale-interview") {' in js            # render branch (posture + text)
    assert 'kind === "spectator-choice") {' in js and "Skip ahead to the finale" in js and "Keep watching" in js


def test_the_card_has_titles_hints_and_cues_for_both_kinds():
    js = _read("static", "js", "orwellDecision.js")
    for k in NEW:
        assert re.search(r'"%s": "' % k, js), f"no title/cue copy for {k}"
    assert "Choose to skip ahead or keep watching" in js
    assert "Pick a posture to enable Confirm" in js


def test_beat_chips_exist_for_the_two_new_beats():
    beats = _read("static", "js", "orwellToolBeats.js")
    assert "'spectator-choice'" in beats and "'finale-interview'" in beats


def test_the_throwaway_fast_forward_drivers_answer_both_kinds():
    py = _read("scripts", "responsive_matrix.py")
    assert 'kind == "spectator-choice"' in py and 'kind == "finale-interview"' in py
    mjs = open(os.path.join(os.path.dirname(FRONTEND), "docs", "audits", "playtest-harness", "s4ff.mjs"),
               encoding="utf-8").read()
    assert "case 'spectator-choice'" in mjs and "case 'finale-interview'" in mjs
