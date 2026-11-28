"""ORW-1133 - Ryne's prod premiere, 2026-11-28 (session 9faff772): "Valerie just introduced herself to me for like the 3rd time" / "a lot of these answers are really redundant".
After the champagne circle closed, houseguests recited name / hometown / job again and repeated their own lines word for word. The front end now reads each reply's tagged dialogue, remembers who has
introduced themselves and what each speaker said in the last few replies, and re-grounds the next turn on a re-introduction or a repeated clause. Lines are the 11-28 transcript's, invented names. No model."""
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")

USER = "u-orw1133"


@pytest.fixture(autouse=True)
def _clean():
    stores = [ch._VOICE_LOG, ch._VOICE_INTRODUCED, ch._PREMIERE_CIRCLE_CLOSED, ch._DESYNC_REGROUND]
    for d in stores:
        d.clear()
    yield
    for d in stores:
        d.clear()


TOAST = '@[Jolene Marsh] — "Jolene Marsh. Foster, Ohio." She tips her glass. "I run a food truck back home — same crossroads I grew up on."'
ANSWER_1 = ('@[Mara Voss] — "Win?" She laughs, low and short. "Sugar, I\'m thirty-three years old and I\'ve spent my whole twenties behind my mama\'s counter. '
            'I\'m not in here to come in fourth and be gracious about it."')
REINTRO = '@[Jolene Marsh] — "Jolene Marsh. Foster, Ohio." He leans in the doorway. "I run a food truck back home — same crossroads I grew up on. So. Barrel\'s where you landed."'
MARA_INTRO = '@[Mara Voss] — "Mara." She says her own name like she\'s putting a card down. "Greenville, Ohio. I run my family\'s jewelry store." Her chin comes up. "So I\'ll say this plain: I\'m not in here to come in fourth and be gracious about it."'
FRESH = '@[Ava Bunn] — "Brave." Ava turns that word over. "I don\'t know if it\'s brave or if the first night just has nothing to lose yet."'


def test_a_self_introduction_is_read_from_the_tagged_line():
    spans = ch._tagged_speech(TOAST)[0][1]
    assert ch._is_self_introduction("Jolene Marsh", spans)
    assert not ch._is_self_introduction("Ava Bunn", ch._tagged_speech(FRESH)[0][1])
    # a name said in passing, with no hometown or job, is not an introduction
    assert not ch._is_self_introduction("Mara Voss", ch._tagged_speech('@[Mara Voss] — "Mara. Sit down."')[0][1])


def test_reintroduction_after_the_circle_closed_is_flagged():
    ch.check_voice_repeats(USER, TOAST)  # the toast itself: first time, never flagged
    assert ch.voice_repeat_findings(USER, TOAST)["reintro"] == ["Jolene Marsh"]  # the same person introducing again
    ch._PREMIERE_CIRCLE_CLOSED.add(ch._runway_key(USER))
    # circle closed: even someone with no recorded intro (the game restarted, the toast pre-dated the log) re-introducing is a repeat
    assert ch.voice_repeat_findings(USER, MARA_INTRO)["reintro"] == ["Mara Voss"]


def test_a_speaker_repeating_their_own_clause_is_flagged_but_others_are_not():
    ch.check_voice_repeats(USER, ANSWER_1)
    again = ch.voice_repeat_findings(USER, '@[Mara Voss] — "And I mean it. I\'m not in here to come in fourth and be gracious about it."')
    assert [w for w, _ in again["repeat"]] == ["Mara Voss"]
    # someone else saying it, or the same speaker saying something new, is fine
    assert ch.voice_repeat_findings(USER, '@[Ava Bunn] — "I\'m not in here to come in fourth and be gracious about it."')["repeat"] == []
    assert ch.voice_repeat_findings(USER, FRESH)["repeat"] == []


def test_the_11_28_reply_re_grounds_the_next_turn():
    ch.check_voice_repeats(USER, TOAST)
    ch.check_voice_repeats(USER, ANSWER_1)
    ch._PREMIERE_CIRCLE_CLOSED.add(ch._runway_key(USER))
    ch.check_voice_repeats(USER, REINTRO + "\n\n" + MARA_INTRO)
    queued = ch._reground_segments(ch._desync_key(USER))
    text = " ".join(queued)
    assert "STOP RE-INTRODUCING PEOPLE" in text and "Jolene Marsh" in text and "Mara Voss" in text
    assert "NEWEST message" in text


def test_a_fresh_reply_queues_nothing_and_a_reset_forgets():
    ch.check_voice_repeats(USER, TOAST)
    ch.check_voice_repeats(USER, FRESH)
    assert not ch._reground_segments(ch._desync_key(USER))
    ch.clear_social_runway(USER)
    assert ch.voice_repeat_findings(USER, TOAST) == {"reintro": [], "repeat": []}
