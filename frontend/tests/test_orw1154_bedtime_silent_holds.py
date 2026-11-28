"""ORW-1154 (Ryne, prod 2026-11-28 04:24-04:30): the player asked to sleep four times and was never put to bed, and the narrator wrote "You go to sleep." / "The room is yours alone" while the engine
clock read night. Complements ORW-1150 (which owns WHICH words count as a bedtime request). This file pins: a held/refused turnIn is never silent, "You go to sleep." is held while no turnIn
committed, and a confused follow-up ("am i awake...?") after an unmet bedtime ask is the same ask. Stubbed model, no network. Roles only."""
import asyncio
import importlib

import pytest

pytestmark = [pytest.mark.usefixtures("non_game_text_routing"), pytest.mark.usefixtures("zero_clocks_off")]

belt = importlib.import_module("test_orw310_bedtime_belt")

PROD_FOLLOWUP = "am i awake...? dreaming...? dead?"


def test_followup_after_an_unmet_ask_is_the_same_ask():
    from src import agent_loop as al
    al.clear_bed_ask("u1154")
    assert al._player_means_bed_now(PROD_FOLLOWUP, "u1154") is False  # no ask outstanding: just a question
    al.note_bed_ask("u1154")
    assert al._player_means_bed_now(PROD_FOLLOWUP, "u1154") is True
    assert al._player_means_bed_now("why can't I go to sleep?", "u1154") is True
    assert al._player_means_bed_now("What time is the comp?", "u1154") is False
    assert al._player_means_bed_now(PROD_FOLLOWUP, "someone-else") is False  # per user
    al.clear_bed_ask("u1154")
    assert al._player_means_bed_now(PROD_FOLLOWUP, "u1154") is False


def test_followup_ask_expires(monkeypatch):
    from src import agent_loop as al
    al.note_bed_ask("u1154x")
    monkeypatch.setitem(al._BED_ASKS, "u1154x", al._BED_ASKS["u1154x"] - al._BED_ASK_TTL_S - 1)
    assert al._player_means_bed_now(PROD_FOLLOWUP, "u1154x") is False


def test_rejecter_held_turn_in_tells_the_narrator_to_say_so_and_what_happens_next(monkeypatch):
    held = belt._res("late-night", held={"next": "ceremony", "minutesUntil": 0, "reason": "ceremony"})
    rounds, belts, _, executed = belt._drive(monkeypatch, text="I sleep.", model=belt.DEEPSEEK, turn_in_result=held)
    assert executed == ["turnIn"]
    notes = [m["content"] for m in rounds[0]["msgs"] if m.get("role") == "system"]
    refused = [n for n in notes if "did NOT put the player to bed" in n]
    assert refused, notes
    assert "ceremony" in refused[0] and "what happens next" in refused[0] and "AWAKE" in refused[0]


def test_night_band_hold_with_a_decision_open_is_told_not_silent(monkeypatch):
    status = {**belt._NIGHT, "pending": {"kind": "comp-round"}}
    rounds, belts, _, executed = belt._drive(monkeypatch, text="I sleep.", model=belt.DEEPSEEK, status=status)
    assert executed == []
    notes = [m["content"] for m in rounds[0]["msgs"] if m.get("role") == "system"]
    assert any("will not let them sleep yet" in n and "comp-round" in n for n in notes), notes


def test_followup_line_puts_the_player_to_bed_in_the_loop(monkeypatch):
    from src import agent_loop as al
    al.note_bed_ask("orw310")  # the earlier "I would like to go to bed" did not end the night
    rounds, belts, _, executed = belt._drive(monkeypatch, text=PROD_FOLLOWUP, model=belt.DEEPSEEK, turn_in_result=belt._res("morning"))
    assert executed == ["turnIn"]
    al.clear_bed_ask("orw310")


@pytest.mark.parametrize("sentence", ["You go to sleep.", "You drift off to sleep.", "You fall asleep to the hum of the house.", "You're asleep, the lamp still on."])
def test_unbacked_sleep_claim_is_held_while_the_engine_clock_reads_night(monkeypatch, sentence):
    from routes import chat_helpers as ch
    from src import orwell_engine as oe

    async def fake_status(user=None):
        return {"timeOfDay": "night", "started": True}

    monkeypatch.setattr(oe, "game_status", fake_status)
    seen = []
    monkeypatch.setattr(ch, "_stash_overclaim_reground", lambda u, d: seen.append(d))
    assert ch._sentence_has_unbacked_sleep_claim(sentence)
    assert asyncio.get_event_loop().run_until_complete(ch.screen_streamed_unbacked_sleep("u", sentence)) is False
    assert seen and "turnIn" in seen[0]


@pytest.mark.parametrize("sentence", ["You can't sleep.", "You will sleep when the house is quiet.", "If you sleep now you miss the toast.", "You dream of a bright kitchen.", "You sleep badly."])
def test_sleep_talk_that_is_not_a_claim_is_left_alone(sentence):
    from routes import chat_helpers as ch
    assert not ch._sentence_has_unbacked_sleep_claim(sentence)


@pytest.mark.parametrize("tod", ["morning", "afternoon", "evening"])
def test_sleep_claim_is_emitted_once_the_clock_has_moved_on(monkeypatch, tod):
    from routes import chat_helpers as ch
    from src import orwell_engine as oe

    async def fake_status(user=None):
        return {"timeOfDay": tod, "started": True}

    monkeypatch.setattr(oe, "game_status", fake_status)
    assert asyncio.get_event_loop().run_until_complete(ch.screen_streamed_unbacked_sleep("u", "You go to sleep.")) is True


def test_pre_emission_guard_drops_the_phantom_sleep_only(monkeypatch):
    from src import agent_loop as al
    from src import orwell_engine as oe
    from routes import chat_helpers as ch

    async def fake_status(user=None):
        return {"timeOfDay": "night", "started": True}

    monkeypatch.setattr(oe, "game_status", fake_status)
    monkeypatch.setattr(ch, "_stash_overclaim_reground", lambda u, d: None)
    text = "The double's yours. Nobody's going to bother you for it. You go to sleep. The lamp stays on."
    out = asyncio.get_event_loop().run_until_complete(al._pre_emission_outcome_guard(text, "u"))
    assert "You go to sleep" not in out
    assert "Nobody's going to bother you" in out and "The lamp stays on." in out
