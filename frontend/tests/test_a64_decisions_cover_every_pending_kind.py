"""The hand-driven real-loop tests answer pending decisions through tests/_a64_decisions.py. If the engine gains a pending kind and that table does not, the driver raises mid-game
(the `KeyError: 'exit-interview'` flake when the player was evicted in week 1). This plain (non-browser) check fails FIRST, listing the missing kinds."""
import os
import re

from _a64_decisions import ANSWERS, NEVER_AUTO_ANSWERED, answer_for

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _engine_pending_kinds():
    src = open(os.path.join(ROOT, "src", "ports", "GameSession.ts"), encoding="utf-8").read()
    start = src.index("export interface PendingDecisionView {")
    body = src[start:src.index("deal-offer\";", start) + len("deal-offer\";")]
    body = re.sub(r"//[^\n]*", "", body)  # comments quote kinds/stances too
    return set(re.findall(r'"([a-z]+(?:-[a-z]+)*)"', body))


def test_the_engine_kind_list_was_parsed():
    kinds = _engine_pending_kinds()
    assert {"nominations", "eviction-vote", "exit-interview", "goodbye-message", "deal-offer"} <= kinds
    assert len(kinds) >= 20


def test_the_driver_answers_every_pending_kind_the_engine_can_emit():
    missing = _engine_pending_kinds() - set(ANSWERS) - NEVER_AUTO_ANSWERED
    assert not missing, f"tests/_a64_decisions.py has no answer for engine pending kinds: {sorted(missing)}"


def test_no_stale_answers_for_kinds_the_engine_no_longer_has():
    assert not (set(ANSWERS) | NEVER_AUTO_ANSWERED) - _engine_pending_kinds()


def test_exit_interview_and_goodbye_use_the_legal_options():
    assert answer_for({"kind": "exit-interview", "stances": ["defiant", "gracious"], "options": []}) == {"kind": "exit-interview", "vote": "defiant"}
    assert answer_for({"kind": "exit-interview", "options": [{"id": "gracious"}]})["vote"] == "gracious"
    assert answer_for({"kind": "goodbye-message", "options": [{"id": "warm"}]})["vote"] == "warm"
    assert answer_for({"kind": "nominations", "options": [{"id": "a"}, {"id": "b"}, {"id": "c"}]})["choice"] == ["a", "b"]


def test_an_unknown_kind_raises_instead_of_defaulting():
    import pytest
    with pytest.raises(KeyError):
        answer_for({"kind": "a-kind-that-does-not-exist"})
