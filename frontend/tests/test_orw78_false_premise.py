"""ORW-78 (A94): the narrator must not go along with a false premise that someone is nominated while the engine has NO nominees. Closed-set only, a next-turn re-ground (never an edit of prose),
narrow by design: no flags on hypotheticals, questions, negations, asides or future talk. Roles only."""
import asyncio
import importlib

ch = importlib.import_module("routes.chat_helpers")


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


def _setup(phase="hoh-competition", noms=None):
    ch._LAST_BEAT_SIG.clear(); ch._DESYNC_REGROUND.clear()
    key = ch._desync_key("u78")
    ch._LAST_BEAT_SIG[key] = {"phase": phase, "noms": noms or [], "nomNames": [] if not noms else ["A", "B"]}
    return key


def _pending(key):
    return ch._DESYNC_REGROUND.get(key)


def test_going_along_with_a_nominee_that_does_not_exist_stashes_a_reground():
    key = _setup()
    _run(ch.record_post_turn_false_premise_check("u78", 'The nominee sits quietly at the end of the couch, picking at a thread.'))
    assert _pending(key), "a re-ground was queued"


def test_nothing_queued_when_nominees_really_exist_or_the_phase_is_later():
    key = _setup(noms=["x", "y"])
    _run(ch.record_post_turn_false_premise_check("u78", "The nominee sits quietly."))
    assert not _pending(key)
    key = _setup(phase="veto-competition")
    _run(ch.record_post_turn_false_premise_check("u78", "The nominee sits quietly."))
    assert not _pending(key)


def test_hypotheticals_questions_negations_asides_and_future_talk_are_not_flagged():
    for text in (
        "If you were the nominee, you would be sweating by now.",
        "Who will the nominee be this week?",
        "There is no nominee yet; nominations come later.",
        "The nominees will be named tonight.",
        "((There are no nominees yet - the nominee of the week is decided at the ceremony.))",
        "Whoever ends up as the nominee will want an ally.",
        "Nobody here is the nominee.",
    ):
        key = _setup()
        _run(ch.record_post_turn_false_premise_check("u78", text))
        assert not _pending(key), text


def test_no_baseline_is_a_safe_noop():
    ch._LAST_BEAT_SIG.clear(); ch._DESYNC_REGROUND.clear()
    _run(ch.record_post_turn_false_premise_check("u78", "The nominee sits quietly."))
    assert not ch._DESYNC_REGROUND


def test_the_agent_loop_calls_the_check_after_the_roster_check():
    src = open(__import__("os").path.join(__import__("os").path.dirname(ch.__file__), "..", "src", "agent_loop.py"), encoding="utf-8").read()
    assert src.index("record_post_turn_roster_check(owner") < src.index("record_post_turn_false_premise_check(owner")
