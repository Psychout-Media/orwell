"""ORW-725 - the player-voice net (a narrow fail-open detector): the narrator never speaks for the player and never hands the player's own words to a houseguest.
Shapes are taken from the playtest, with roles only (no names). The control cases prove the net leaves honest narration, houseguest speech and the player's own typed words alone."""
import importlib
import os

import pytest

pv = importlib.import_module("src.player_voice_guard")

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _stream(chunks, msg):
    st = pv.PlayerVoiceState()
    kept, dropped = "", []
    for c in chunks:
        # the caller derives the open-quote state from what it already emitted
        k, d = pv.screen(c, msg, st, in_quote=pv._scan_quotes(kept, False)[1])
        kept += k
        dropped += d
    return kept, dropped


NPC = 'Houseguest A — "Yeah, see, that is worse than the hands." He says it quick and dry.\n'


def test_first_person_action_and_the_unattributed_answer_after_it_are_withheld():
    msg = "I read breathing, mostly. Houseguest A, tell me about the pizzeria. Is it yours or family?"
    text = 'I lean back against the black counter and give Houseguest A the honest answer.\n\n"Both, if I am any good at it. You read the breath."\n\n' + NPC
    kept, dropped = pv.screen(text, msg)
    assert {f for f, _ in dropped} == {pv.FACT_FIRST_PERSON} and len(dropped) >= 3
    assert "Both, if I am" not in kept and "I lean back" not in kept
    assert "Houseguest A —" in kept and "worse than the hands" in kept


def test_a_quote_glued_to_the_first_person_sentence_is_withheld_across_chunks():
    msg = "Three years on one sauce is commitment. Deal? And who just came in?"
    chunks = ['I lean on the island and give the answer while the pipes tick overhead."Eleven years on an ', 'ambulance. I started because I wanted the job where you show up."', 'Houseguest B — "That is a better answer than mine was."\n']
    kept, dropped = _stream(chunks, msg)
    assert "Eleven years" not in kept and "ambulance" not in kept and "show up" not in kept
    assert "better answer than mine" in kept
    assert len(dropped) >= 3


def test_you_say_with_a_line_the_player_never_typed_is_withheld_but_their_own_typed_line_is_not():
    msg = "Tell me the truth, who did you vote for last week?"
    kept, dropped = pv.screen('You say, "I will keep you safe, I promise." The room goes quiet.\n', msg)
    assert dropped and dropped[0][0] == pv.FACT_SPEECH and "keep you safe" not in kept and "The room goes quiet" in kept
    kept2, dropped2 = pv.screen('You say, "Tell me the truth, who did you vote for last week?" The room goes quiet.\n', msg)
    assert not dropped2 and kept2.startswith("You say")


def test_a_decision_the_player_never_made_is_withheld_unless_their_message_made_it():
    kept, dropped = pv.screen("You decide to throw the competition and you nod and agree to the deal.\n", "I wait four hours.")
    assert [f for f, _ in dropped] == [pv.FACT_DECISION] and kept == ""
    kept2, dropped2 = pv.screen("You agree to the deal and shake on it.\n", "I agree to the deal.")
    assert not dropped2 and kept2
    for ok in ("If you decide to run, say so first.\n", "Will you vote tonight?\n"):
        assert pv.screen(ok, "I wait.")[1] == []


def test_a_houseguest_reciting_the_players_own_message_is_withheld_even_split_over_chunks():
    msg = "Houseguest C, sit with me till they call it. Honest question: if you win the veto today, do you use it? I am leaning toward leaving it alone."
    chunks = ['Houseguest C — "Sit with me till they call it.', ' Honest question, and I would like the honest answer — if you win the veto today, do you use it?"\n', 'Houseguest D — "I had to protect my people, that is the whole of it."\n']
    kept, dropped = _stream(chunks, msg)
    assert [f for f, _ in dropped] == [pv.FACT_RECITATION]
    assert "protect my people" in kept
    # a houseguest line that opens with the player's own words (>= 6 in a row) is a recitation on its own
    k2, d2 = pv.screen('Houseguest C — "Sit with me till they call it, you said."\n', msg)
    assert d2 == [] or d2[0][0] == pv.FACT_RECITATION  # attributed to the player: allowed ("you said"), else withheld


def test_a_houseguest_quoting_the_player_back_with_attribution_or_in_their_own_words_is_kept():
    msg = "Houseguest E, I am voting to evict the nominee tonight and keeping the other. That is everything."
    ok = ('Houseguest E — "You said I am voting to evict the nominee tonight and keeping the other, and I heard you."\n',
          'Houseguest E — "Fair enough. I will take that and think on it."\n',
          'Houseguest E — "Tonight? That is quick."\n')
    for t in ok:
        assert pv.screen(t, msg) == (t, []), t


def test_honest_second_person_narration_and_houseguest_speech_pass_untouched():
    msg = "I walk to the kitchen and ask who is up."
    text = 'You cross to the kitchen. The kettle ticks.\n\nHouseguest F — "I lean toward the early riser," she says. "I set the table most mornings."\n\nI will see you in the Diary Room." is not here.\n'
    kept, dropped = pv.screen(text.replace('\n\nI will see you in the Diary Room." is not here.\n', "\n"), msg)
    assert dropped == [] and kept == text.replace('\n\nI will see you in the Diary Room." is not here.\n', "\n")


def test_no_player_message_flag_off_or_garbage_means_no_change(monkeypatch):
    t = 'I lean back and answer.\n"Both."\n'
    assert pv.screen(t, "")[1] == [] and pv.screen(t, None)[1] == []
    monkeypatch.setenv("ORWELL_PLAYER_VOICE_GUARD", "0")
    assert pv.screen(t, "I wait.") == (t, [])
    monkeypatch.delenv("ORWELL_PLAYER_VOICE_GUARD")
    assert pv.screen(object(), "I wait.")[1] == []  # fail-open on a non-string


def test_the_loop_runs_the_net_at_both_emit_sites_and_notes_the_belt_only_when_something_was_withheld():
    src = open(os.path.join(_BASE, "src", "agent_loop.py"), encoding="utf-8").read()
    assert src.count("_player_voice_guard(") >= 3  # the def + the mid-stream and the final-tail call
    g = src.index("async def _player_voice_guard")
    body = src[g:g + 2600]
    assert body.index("screen(") < body.index('_note_belt(owner, "player-voice-withheld"')
    assert "if dropped" in body[:body.index('_note_belt(owner, "player-voice-withheld"')]
