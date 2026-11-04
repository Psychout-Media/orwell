"""E-1 (live rehearsal 2026-11-04): in watch mode the narrator told an EVICTED player "…and then it's finale night… the last two come down the stairs… the room waits on
the jury to speak" while the engine sat at week 8's HOH competition. The finale / final two / jury verdict / winner are closed-set events the engine has not committed
— the narrator must not voice them as having ARRIVED. Narrow on purpose: only assertive 'it has arrived' phrasing is stripped, only for an evicted player before the
finale; hypothetical / future / past-reference wording and houseguest strategy talk ("take you to the final two") are never touched. Roles only."""
import pytest

from src import finale_claims as fc

EVICTED_WATCHING = {"phase": "hoh-competition", "playerStatus": "evicted", "finished": False}


@pytest.mark.parametrize("unit", [
    "And then it's finale night.",
    "The house is dressed up for it. Then the last two come down the stairs.",
    "The finalists stand there under the lights, and the room waits on the jury to speak.",
    "Finale night arrives, and the jury is seated.",
    "The jury casts its votes, and Role A is crowned the winner of Big Brother.",
    "Role B wins Big Brother.",
    "The winner is Role C.",
])
def test_an_arrived_finale_is_a_phantom_claim_before_the_finale(unit):
    kept, stripped = fc.strip_phantom_finale(unit, EVICTED_WATCHING)
    assert stripped, unit
    # the phantom unit is gone; innocuous lead-in prose in the same chunk may stay (it asserts nothing closed-set)
    assert not any(rx.search(kept) for rx in fc._ARRIVAL_RES), kept


@pytest.mark.parametrize("unit", [
    "The weeks burn past you in a blur, and the house keeps playing without you.",
    "Role A wants to take Role B to the final two.",
    "Somebody says the finale feels a long way off.",
    "You'll be back for finale night, and until then the house plays on.",
    "If the jury turns on him, he won't make the final two.",
    "Whoever wins Big Brother will have earned it.",
    "Week 8. The Head of Household competition comes down to two houseguests on a wall.",
    "She dreams about the finale and the last two stairs.",
])
def test_future_hypothetical_and_ordinary_talk_is_untouched(unit):
    kept, stripped = fc.strip_phantom_finale(unit, EVICTED_WATCHING)
    assert not stripped, unit
    assert kept == unit


def test_only_the_evicted_player_before_the_finale_is_screened():
    unit = "And then it's finale night."
    assert fc.strip_phantom_finale(unit, {**EVICTED_WATCHING, "playerStatus": "active"})[1] == []    # an active player: the broader guards own this
    assert fc.strip_phantom_finale(unit, {**EVICTED_WATCHING, "phase": "finale"})[1] == []           # the finale IS committed
    assert fc.strip_phantom_finale(unit, {**EVICTED_WATCHING, "finished": True})[1] == []
    assert fc.strip_phantom_finale(unit, {})[1] == []                                                # no board: fail open


def test_a_mixed_chunk_keeps_the_true_prose_and_strips_only_the_phantom_units():
    text = "Week 8 begins. And then it's finale night. The house wakes slowly."
    kept, stripped = fc.strip_phantom_finale(text, EVICTED_WATCHING)
    assert "Week 8 begins." in kept and "The house wakes slowly." in kept and "finale night" not in kept
    assert len(stripped) == 1


def test_has_finale_cue_is_a_cheap_prefilter():
    assert fc.has_finale_cue("And then it's finale night.") is True
    assert fc.has_finale_cue("Role A talks to Role B in the kitchen.") is False


def test_the_stream_screen_strips_a_phantom_finale_for_an_evicted_player_and_queues_a_reground(monkeypatch):
    import asyncio
    from routes import chat_helpers as ch

    async def fake_sig(user):
        return dict(EVICTED_WATCHING)

    monkeypatch.setattr(ch, "_capture_beat_signature", fake_sig)
    queued = []
    monkeypatch.setattr(ch, "_reground_enqueue", lambda key, directive: queued.append(directive) or True)
    kept, dropped = asyncio.new_event_loop().run_until_complete(
        ch.screen_role_claims_ex("u-fin", "Week 8 begins. And then it's finale night. The house wakes slowly."))
    assert "finale night" not in kept and "Week 8 begins." in kept
    assert len(dropped) == 1 and "finale night" in dropped[0]
    assert queued and "finale" in queued[0].lower()


def test_the_stream_screen_leaves_an_active_players_finale_talk_alone(monkeypatch):
    import asyncio
    from routes import chat_helpers as ch

    async def fake_sig(user):
        return {"phase": "hoh-competition", "playerStatus": "active", "finished": False}

    monkeypatch.setattr(ch, "_capture_beat_signature", fake_sig)
    kept, dropped = asyncio.new_event_loop().run_until_complete(ch.screen_role_claims_ex("u-fin2", "And then it's finale night."))
    assert kept == "And then it's finale night." and dropped == ()


def test_live_e1_fabricated_finale_prose_is_stripped():
    """The exact fabricated-finale phrasing the live forced E-1 narrator produced for a watching evictee (week 6, no finale on the board)."""
    from src import finale_claims as fc
    board = {"phase": "hoh-competition", "playerStatus": "evicted"}
    text = (
        "The montage stops, and the finale stage is lit and the whole thing is live.\n\n"
        "Three people are standing at the front of it. The final three.\n\n"
        "And the voice says: \"Jurors. It's time.\"\n\n"
        "The confetti comes down.\n\n"
        "That's the season - Finn Waters, crowned, with the jury's votes on the record.\n\n"
        "The house wakes slowly and Sara sets down her cereal."
    )
    kept, stripped = fc.strip_phantom_finale(text, board)
    assert "Sara sets down her cereal" in kept
    for bad in ("finale stage", "final three", "Jurors", "confetti", "crowned"):
        assert bad not in kept, bad
    assert stripped
