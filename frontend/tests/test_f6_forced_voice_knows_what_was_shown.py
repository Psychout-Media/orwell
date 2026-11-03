"""F-6 root cause: the anti-stale RELEASE VALVE's forced second round re-answered a question round 1 had already answered.

A's fe.log (run-20261103-0520, 05:29:45-05:29:58): round 1 voiced Houseguest1's reply (766 chars); the valve then forced an IN-TURN voice that carried only the
generic CONTINUE-NEVER-REOPEN contract, and the model produced a second, different rendition of the same reply (plus an out-of-character aside). The
render-side collapse is only a belt; this pins the CAUSE: when a scene was already shown, the forced-voice directive now QUOTES the tail of what the
player has read (and says their message was already answered) so the model knows exactly what is covered.
"""
import importlib

agent_loop = importlib.import_module("src.agent_loop")

SHOWN = ('@[Houseguest1] - She goes very still. "The diary room." She says the words slowly. "Whatever Houseguest2 said in there, I did not hear it." '
         "She takes a sip, watching you over the rim.")


def test_plain_forced_voice_when_nothing_was_shown():
    assert agent_loop._anti_stale_forced_voice(False, SHOWN) == agent_loop._ANTI_STALE_FORCED_VOICE
    assert agent_loop._anti_stale_forced_voice(False, "") == agent_loop._ANTI_STALE_FORCED_VOICE


def test_when_a_scene_was_shown_the_directive_quotes_it_and_forbids_a_re_answer():
    d = agent_loop._anti_stale_forced_voice(True, SHOWN)
    assert d.startswith(agent_loop._CONTINUE_NEVER_REOPEN)
    assert "ALREADY SHOWN TO THE PLAYER THIS TURN" in d
    assert "Whatever Houseguest2 said in there, I did not hear it" in d, "the shown text is quoted verbatim"
    assert "ALREADY answered" in d and "do NOT repeat, rephrase, re-answer" in d
    assert d.endswith(agent_loop._ANTI_STALE_FORCED_VOICE), "the forced-voice instruction still follows (bring the player to the CURRENT moment)"


def test_only_the_tail_is_quoted_and_blank_text_degrades_to_the_contract():
    long = "x" * 5000 + " THE-END"
    d = agent_loop._anti_stale_forced_voice(True, long)
    assert "THE-END" in d and d.count("x") <= agent_loop._FORCED_VOICE_SHOWN_TAIL
    d2 = agent_loop._anti_stale_forced_voice(True, "   ")
    assert "ALREADY SHOWN" not in d2 and agent_loop._CONTINUE_NEVER_REOPEN in d2


def test_the_valve_uses_it():
    src = open(agent_loop.__file__, encoding="utf-8").read()
    assert "_voice = _anti_stale_forced_voice(_emitted_visible, full_response)" in src
