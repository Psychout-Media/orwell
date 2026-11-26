"""ORW-1069 / ORW-1072 (audit A6, the mechanism behind ORW-1053): the promise belts recorded a vow to vote someone OUT as a promise to keep them (no-evict-vote), recorded hedged and
conditional promises as firm ones, and a validator silently dropped a houseguest's promise to the player whose subject was the player. The fixtures are the audit's own failing inputs, with the
extraction stubbed to return the wrong label the model returned; the post-filters must refuse them. No model. Roles only."""
import asyncio
import json

import pytest

from src import agent_loop as al

ROSTER = {"npc:1", "npc:2", "npc:3"}


@pytest.mark.parametrize("line", [
    "I am voting Lorenzo out and I swear it. You can count on that.",
    "Everyone here, I promise to vote out Maeve. She goes home.",
    "I swear I will vote against Dale.",
    "I promise I will evict Priya.",
])
def test_a_vow_to_vote_someone_out_is_never_a_keep_promise(line):
    assert al._promise_words_unfit(line, "vote") == "vote-out"
    items = [{"by": "npc:1", "about": "npc:2", "kind": "vote", "line": line}]
    assert al._validate_voiced_promises(items, ROSTER, set(), None) == []


@pytest.mark.parametrize("line", [
    "If you keep me this week, I'll keep you.",
    "I will keep you safe unless you put me up.",
    "As long as you vote with me, you have my vote.",
])
def test_a_conditional_promise_is_not_recorded_as_unconditional(line):
    assert al._promise_words_unfit(line, "loyal") == "conditional"
    items = [{"by": "npc:1", "about": None, "kind": "loyal", "line": line}]
    assert al._validate_voiced_promises(items, ROSTER, set(), None) == []


@pytest.mark.parametrize("line", [
    "I'll try to keep you safe, but I can't say for sure.",
    "Maybe I will vote to keep you.",
    "I hope to keep you here.",
])
def test_a_hedged_promise_is_not_recorded(line):
    assert al._promise_words_unfit(line, "vote") == "hedged"


@pytest.mark.parametrize("line", [
    "I promise you, I will vote to keep you this week. You have my vote.",
    "I will not vote you out. You have my word.",
    "I would never vote against you.",
    "I won't evict you, I swear.",
    "I will not put you on the block. Not this week, not ever.",
])
def test_a_firm_keep_promise_still_passes(line):
    assert al._promise_words_unfit(line, "vote") is None


def test_a_valid_voiced_promise_still_records():
    items = [{"by": "npc:1", "about": "npc:2", "kind": "vote", "line": "I will not vote Contestant Beta out."}]
    assert len(al._validate_voiced_promises(items, ROSTER, set(), None)) == 1


def test_a_houseguest_promise_whose_subject_is_the_player_is_kept_as_a_promise_to_the_player():
    out = al._validate_promise({"what": "no-nominate", "subject": "player", "by": "npc:4"}, ["npc:4"], ROSTER | {"npc:4"})
    assert out == {"what": "no-nominate", "from": "npc:4"}


def test_a_player_promise_about_the_player_and_a_subject_that_is_the_promiser_are_dropped_and_counted():
    al._VALIDATOR_DROPS.clear()
    assert al._validate_promise({"what": "no-nominate", "subject": "player"}, ["npc:1"], ROSTER) is None
    assert al._validate_promise({"what": "no-nominate", "subject": "npc:1", "by": "npc:1"}, ["npc:1"], ROSTER) is None
    assert al._validate_promise({"what": "no-nominate", "subject": "npc:99"}, ["npc:1"], ROSTER) is None
    assert al._VALIDATOR_DROPS == {"promise:player-promise-about-self": 1, "promise:subject-is-promiser": 1, "promise:subject-not-on-roster": 1}


def _run_player_belt(monkeypatch, words, extraction):
    import src.llm_core as lc
    import src.orwell_engine as oe
    staged = []

    async def fake_llm(*a, **k):
        return extraction

    async def fake_wb(*a, **k):
        return {"present": [{"id": "npc:1"}]}

    async def fake_record(*a, **k):
        staged.append(k)
        return {"ok": True}

    monkeypatch.setattr(lc, "llm_call_async", fake_llm)
    monkeypatch.setattr(oe, "whereabouts", fake_wb)
    monkeypatch.setattr(oe, "record_interaction", fake_record)
    monkeypatch.setattr(al, "_backfill_with_cas", lambda owner, fn, *a, **k: fn(*a, **k))
    house = [{"id": "npc:1", "name": "Contestant Alpha"}]
    ok = asyncio.new_event_loop().run_until_complete(al._auto_record_promise(words, house, "u", "m", {}, "u", None))
    return ok, staged


def test_the_player_words_belt_refuses_a_vote_out_vow_labelled_no_evict_vote(monkeypatch):
    ok, staged = _run_player_belt(monkeypatch, "Everyone, I promise to vote out Contestant Alpha.",
                                  '{"withIds":["npc:1"],"promise":{"what":"no-evict-vote","subject":"npc:1"}}')
    assert ok is False and staged == []


def test_the_player_words_belt_refuses_a_hedged_assurance(monkeypatch):
    ok, staged = _run_player_belt(monkeypatch, "I'll try to keep you safe, but I can't say for sure. I promise nothing.",
                                  '{"withIds":["npc:1"],"assurance":{"kind":"safe"}}')
    assert ok is False and staged == []


def test_the_player_words_belt_still_records_a_firm_keep_promise(monkeypatch):
    ok, staged = _run_player_belt(monkeypatch, "I promise I will not vote you out, Alpha.",
                                  '{"withIds":["npc:1"],"promise":{"what":"no-evict-vote"}}')
    assert ok is True and staged[0]["promise"] == {"what": "no-evict-vote"}


def test_a_deal_with_no_spoken_terms_is_refused_not_given_an_invented_clause(monkeypatch):
    import src.orwell_engine as oe
    import src.llm_core as lc
    made = []

    async def fake_llm(*a, **k):
        return '{"deals":[{"withId":"npc:1","kind":"final-two","terms":""}]}'

    async def fake_make(*a, **k):
        made.append(a)
        return {"id": "deal:1"}

    async def fake_guard(*a, **k):
        return None, None

    import src.tool_implementations as ti
    monkeypatch.setattr(lc, "llm_call_async", fake_llm)
    monkeypatch.setattr(oe, "make_deal", fake_make)
    monkeypatch.setattr(ti, "guard_make_deal", fake_guard)
    monkeypatch.setattr(al, "_belt_llm", fake_llm)
    monkeypatch.setattr(al, "_backfill_with_cas", lambda owner, fn, *a, **k: fn(*a, **k))
    al._VALIDATOR_DROPS.clear()
    house = [{"id": "npc:1", "name": "Contestant Alpha"}]
    ok = asyncio.new_event_loop().run_until_complete(al._auto_record_deal("They shake on it.", "deal", house, "u", "m", {}, "u"))
    assert ok is False and made == []
    assert al._VALIDATOR_DROPS.get("deal:no-terms") == 1
