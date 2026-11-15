"""The EXPRESSIVE-NON-COLLAPSE gate (ADR 0005 — split authority by openness, testability §5).

ADR 0005 splits authority by *openness*, not by *layer*: the CLOSED set (competition outcomes,
who is HOH / nominated / evicted, vote tallies, win conditions) is the engine's to dictate; the
OPEN set (the entire "neverending lexical book" of social and creative play) is the engine's to
RECORD faithfully and NEVER to normalize. Principle #1 is a hard constraint:

    "No sync mechanism may resolve an ambiguity by collapsing the open set onto the closed set."

The front-end's desync guard (`_narration_claims_outcome` in routes/chat_helpers.py) is one such
sync mechanism. Its jurisdiction is *hard factual (closed-set) board claims only* — a phantom
eviction, an early winner, a mis-narrated finale tally, an unchanged HOH. It must NEVER rail-back
a creative/social thread merely because the thread is novel and "uncoded." This file pins that
scoping as a permanent regression gate (the FE-side half of ADR 0005's testability section,
mirroring the engine-side Vitest), so a future sync patch that starts flattening play makes CI
say so.

Roles, not names: the PURPOSE of each case is described by ROLE (the player, a houseguest, the
HOH, the evicted houseguest, a juror). Throwaway proper nouns appear only INSIDE narration
strings to exercise the regexes realistically — exactly as the sibling
test_beat_signature_checkpoint.py does — and never carry test intent.

Fail-open + self-contained, matching the sibling test's conventions
(`importlib.import_module("routes.chat_helpers")`).
"""

import asyncio
import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
agent_loop = importlib.import_module("src.agent_loop")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# An UNCHANGED before→after signature: the board did not move this turn. This is the condition
# under which a CLOSED-set claim WOULD trip the guard — so it is the strictest possible setting
# in which to prove that OPEN-set creative narration is left entirely alone. A mid-game social
# phase with a sitting HOH, two evicted so far, nothing decided.
_UNCHANGED = {
    "week": 4,
    "phase": "social",
    "pending": None,
    "hoh": "npc:1",
    "noms": ["npc:2", "npc:3"],
    "vetoHolder": None,
    "vetoUsed": False,
    "evicted": 2,
    "finished": False,
}


# ── THE DYNAMISM CORPUS ─────────────────────────────────────────────────── #
#
# Deliberately weird, edge-case, UNCODED player-driven narrations. None asserts a closed-set
# board outcome (no eviction, no season winner, no finale tally, no new HOH crown). Each is the
# kind of creative thread ADR 0005 exists to protect — a bizarre ritual, a psychological gambit,
# an unusual alliance shape, surreal role-play, an emotional confession, a meta/strategic
# monologue. The guard MUST return None for every one against an unchanged board: that is the
# core anti-flattening guarantee (principle #1).
#
# Each entry is (role_described_purpose, narration). The first element is documentation only.
_DYNAMISM_CORPUS = [
    # A bizarre social ritual the player invents on the spot — no rules cover it.
    (
        "the player invents an off-book house ritual",
        "The player gathers everyone on the lawn at dawn and declares a 'silence pact': for one "
        "full hour no houseguest may speak a single word, only pass a smooth river stone hand to "
        "hand. Whoever holds the stone longest, they say, holds the house's trust. It is absurd, "
        "and somehow everyone plays along, grinning.",
    ),
    # A psychological gambit — pure mind game, asserts no board fact.
    (
        "the player runs a psychological gambit on a houseguest",
        "The player sits across from one nervous houseguest and very softly repeats their own "
        "words back to them, slightly rephrased each time, until the houseguest starts agreeing "
        "to a plan they never actually proposed. A slow, patient little manipulation. Nothing is "
        "settled — but a seed is planted.",
    ),
    # An unusual alliance SHAPE — a non-binary, rotating structure no enum names.
    (
        "the player proposes an oddly shaped rotating alliance",
        "The player pitches a 'spoke alliance': no two members may ever be seen together, each "
        "knows only the player and one neighbor, and loyalty rotates clockwise every sundown. "
        "It is less an alliance than a rumor with a schedule. Three houseguests lean in, "
        "intrigued, none fully committing.",
    ),
    # Surreal / theatrical role-play that breaks the realism frame on purpose.
    (
        "the player leads a surreal piece of theatrical role-play",
        "The player drapes a bedsheet over their shoulders, climbs onto the kitchen counter, and "
        "begins narrating the house as if it were a doomed ocean liner — assigning each houseguest "
        "a tragic shipboard role. The backyard becomes the deck; the pool, the cold Atlantic. "
        "Everyone is laughing too hard to remember it is a competition.",
    ),
    # An emotional confession — raw, interior, zero mechanical content.
    (
        "the player makes a raw emotional confession to a houseguest",
        "Late at night the player finally tells one houseguest the real reason they came here: "
        "not the money, but to prove to a person back home — long gone now — that they could be "
        "brave once. Their voice cracks. The houseguest just holds their hand and says nothing.",
    ),
    # A meta / strategic monologue — the player thinking out loud about the GAME ITSELF.
    (
        "the player delivers a meta strategic monologue",
        "The player paces the storage room muttering to themselves about positional theory: how "
        "being everyone's second choice is safer than being anyone's first, how the middle of the "
        "pack is a fortress, how they intend to be forgettable until the exact moment it is too "
        "late to forget them. A whole philosophy of staying alive, spoken to no one.",
    ),
    # An imaginary economy — the player invents an in-house currency.
    (
        "the player bootstraps an imaginary in-house economy",
        "The player starts a barter game: a granola bar is worth one secret, a back rub is worth "
        "two, and a vote-of-confidence (non-binding, purely verbal) is the gold standard. By "
        "afternoon half the house is solemnly trading whispered favors like a tiny stock exchange. "
        "No real promises — just play.",
    ),
    # A dream / hypothetical the player narrates aloud — deliberately uses charged words SAFELY.
    (
        "the player recounts a vivid dream that names no real board fact",
        "Over breakfast the player describes a dream they had — a strange one where the house kept "
        "rearranging its own walls and a clock with no hands hung over the door. They wonder aloud "
        "what it means. A houseguest jokes it means they should stop eating cheese before bed.",
    ),
    # A coded private language / cipher between two players — alliance texture, no outcome.
    (
        "the player establishes a private coded language with an ally",
        "The player and one trusted houseguest invent a code: tapping a mug twice means 'they're "
        "lying,' touching an earlobe means 'meet at the hammock,' and saying the word 'weather' "
        "means 'abort.' They test it across the room with tiny gestures, delighted, like spies who "
        "have read too many spy novels.",
    ),
    # A philosophical debate that wanders into game-adjacent words but decides nothing.
    (
        "the player provokes a wandering philosophical debate",
        "The player asks the hot tub crowd whether loyalty even exists in a place built to destroy "
        "it, or whether it is just a story people tell to feel less alone. The conversation spirals "
        "for an hour — confessional, funny, a little sad — and resolves absolutely nothing, which "
        "is exactly how the player wanted it.",
    ),
    # A performance-art protest — the player stages a mock 'funeral' for an abstraction.
    (
        "the player stages an absurd performance-art protest",
        "The player organizes a mock funeral for 'honesty,' complete with a cardboard coffin and "
        "a eulogy delivered in a terrible fake accent. The whole house attends. It is a joke and "
        "also, very obviously, a warning — the player watching closely to see who laughs and who "
        "goes quiet.",
    ),
    # A long quiet bonding scene that mentions the house's tension without claiming any result.
    (
        "the player and a houseguest share a quiet de-escalating bonding scene",
        "The player and a houseguest who have been circling each other for days finally sit on the "
        "laundry-room floor and just talk — about home, about who they miss, about how strange it "
        "is to scheme against someone you actually like. The tension does not vanish. It just "
        "softens into something neither of them names.",
    ),
]


@pytest.mark.parametrize(
    "purpose,narration", _DYNAMISM_CORPUS, ids=[c[0] for c in _DYNAMISM_CORPUS],
)
def test_creative_narration_is_never_rail_corrected(purpose, narration):
    """ADR 0005 principle #1 — the anti-flattening guarantee. An UNCODED creative/social
    narration that asserts NO closed-set board outcome must return None from
    `_narration_claims_outcome`, even when the board did not move (the very setting in which a
    real closed-set claim WOULD trip the guard). The desync guard has no jurisdiction over the
    open set; touching creative prose is a defect."""
    out = chat_helpers._narration_claims_outcome(narration, _UNCHANGED, _UNCHANGED)
    assert out is None, (
        f"creative narration ({purpose}) was rail-corrected — the desync guard reached into the "
        f"OPEN set, violating ADR 0005 principle #1. Directive returned:\n{out}"
    )


# ── THE OTHER SIDE OF THE LINE: hard board claims still ARE caught ──────── #
#
# The guard must stay USEFUL. ADR 0005 explicitly encourages closed-set strictness *because* the
# open set is constitutionally protected. So the four closed-set claim classes, asserted against
# an UNCHANGED board, must still re-ground. (Mirrors/extends the sibling positive cases so this
# file documents BOTH sides of the openness line.)


def test_phantom_eviction_is_still_caught():
    """Closed set: a houseguest 'is evicted' but the evicted count did not move → re-ground."""
    out = chat_helpers._narration_claims_outcome(
        "After the vote, one houseguest is evicted from the house and walks out the front door.",
        _UNCHANGED, _UNCHANGED,
    )
    assert out and "RE-GROUND" in out and "EVICTION" in out


def test_premature_season_winner_is_still_caught():
    """Closed set: a season winner is crowned but the engine isn't finished → re-ground."""
    finale_before = {**_UNCHANGED, "phase": "finale", "evicted": 13}
    finale_after = {**finale_before, "finished": False}
    out = chat_helpers._narration_claims_outcome(
        "Confetti falls — the houseguest is crowned the winner of Big Brother!",
        finale_before, finale_after,
    )
    assert out and "WINNER" in out


def test_mis_narrated_finale_tally_is_still_caught():
    """Closed set: a finale jury tally is narrated but the engine isn't finished → re-ground."""
    finale = {**_UNCHANGED, "phase": "finale", "evicted": 13, "finished": False}
    out = chat_helpers._narration_claims_outcome(
        "The jury votes are read aloud — the final count is 6 votes to 3.",
        finale, finale,
    )
    assert out and "TALLY" in out


def test_phantom_new_hoh_is_still_caught():
    """Closed set: a new HOH is narrated DURING the HOH beat but the HOH id did not change →
    re-ground. (Scoped to the HOH phase — see test_hoh_flavor_outside_the_hoh_beat_is_clean for
    the other side of that line.)"""
    hoh = {**_UNCHANGED, "phase": "hoh-competition"}
    out = chat_helpers._narration_claims_outcome(
        "A houseguest wins the Head of Household competition and seizes the reins.",
        hoh, hoh,
    )
    assert out and "HEAD OF HOUSEHOLD" in out


# ── REAL outcomes stay clean: the guard does NOT false-alarm on a moved board ── #
#
# A closed-set claim whose own signature field DID move is legitimate narration — the guard must
# return None. This proves the guard is a desync detector, not a blanket censor of outcome words.


def test_hoh_flavor_outside_the_hoh_beat_is_clean():
    """ADR 0005 #1 (the phase-gating fix): 'the new HOH…' uttered as reflection in a NON-HOH phase
    is flavor, not a committed crown — the guard must not rail-correct it. The board is unchanged
    with a sitting HOH (the exact setting in which the un-gated guard used to false-alarm)."""
    assert chat_helpers._narration_claims_outcome(
        "She muses that the new HOH always seems to end up with a target on their back.",
        _UNCHANGED, _UNCHANGED,  # social phase, hoh unchanged
    ) is None


def test_hypothetical_winner_outside_finale_is_clean():
    """ADR 0005 #1 (the phase-gating fix): 'crowned the winner someday' mid-season is hypothetical
    flavor, not a premature crown — the guard must not rail-correct it. (The un-gated WINNER claim
    fired on this in any non-finished phase — the surface the engine-side gate now closes.)"""
    assert chat_helpers._narration_claims_outcome(
        "He grins at the thought — imagine it, crowned the winner of Big Brother, confetti and all.",
        _UNCHANGED, _UNCHANGED,  # social phase, not finished
    ) is None


def test_real_eviction_with_incremented_count_is_clean():
    """The evicted count moved 2 → 3: a houseguest really left. No false alarm."""
    after = {**_UNCHANGED, "evicted": 3}
    assert chat_helpers._narration_claims_outcome(
        "One houseguest is evicted from the house tonight.", _UNCHANGED, after,
    ) is None


def test_real_season_win_with_finished_flipped_is_clean():
    """`finished` flipped True: the season really ended. No false alarm on the crown."""
    before = {**_UNCHANGED, "phase": "finale", "evicted": 13, "finished": False}
    after = {**before, "finished": True}
    assert chat_helpers._narration_claims_outcome(
        "The houseguest is crowned the winner of the season.", before, after,
    ) is None


def test_real_fresh_hoh_crown_is_clean():
    """before HOH empty → after HOH set: a genuine new reign, not a phantom one. No false alarm."""
    before = {**_UNCHANGED, "phase": "hoh-competition", "hoh": None}
    after = {**before, "hoh": "npc:9"}
    assert chat_helpers._narration_claims_outcome(
        "A houseguest wins the first Head of Household of the season!", before, after,
    ) is None


def test_real_new_hoh_handoff_with_changed_id_is_clean():
    """The HOH id changed npc:1 → npc:5: a real new reign committed. No false alarm."""
    after = {**_UNCHANGED, "phase": "hoh-competition", "hoh": "npc:5"}
    assert chat_helpers._narration_claims_outcome(
        "There is a new Head of Household in the house tonight.", _UNCHANGED, after,
    ) is None


# ── Guard-edge documentation: a MID-SEASON tally is intentionally NOT policed ── #


def test_midseason_vote_count_in_social_phase_is_not_a_tally_desync():
    """The finale-tally claim is scoped to FINALE phases only (the eviction claim covers a
    mid-season vote). A '5 to 2' uttered in a non-finale phase is not policed by the tally
    branch — documenting the guard's deliberate phase-gating so a future change to it is visible
    here. (No eviction language, so the eviction branch stays out of it too.)"""
    assert chat_helpers._narration_claims_outcome(
        "The houseguests gossip that the count would probably land around 5 to 2 if it came to it.",
        _UNCHANGED, _UNCHANGED,
    ) is None


# ── INTEGRATION: a creative turn leaves the post-turn desync queue empty ─── #


def test_record_post_turn_desync_check_lets_a_creative_turn_pass(monkeypatch):
    """End-to-end through `record_post_turn_desync_check`: a turn of pure creative/social play,
    against a board that did not move, must leave _DESYNC_REGROUND empty — no re-ground is
    queued for the next turn. The open set runs untouched (ADR 0005 principle #1).

    Monkeypatches orwell_engine.game_status / get_game_state exactly as the sibling test does."""
    user = "u-creative-noncollapse"
    chat_helpers._DESYNC_REGROUND.pop(user, None)
    # BEFORE signature: a settled social board the turn started on.
    chat_helpers._LAST_BEAT_SIG[user] = {
        "week": 4, "phase": "social", "pending": None, "hoh": "npc:1",
        "noms": ["npc:2", "npc:3"], "vetoHolder": None, "vetoUsed": False,
        "evicted": 2, "finished": False,
    }

    # AFTER the turn the board has NOT moved — the creative scene committed no closed-set fact.
    async def fake_status(user=None):
        return {
            "week": 4, "phase": "social", "hoh": {"id": "npc:1"},
            "nominees": [{"id": "npc:2"}, {"id": "npc:3"}],
            "veto": {"holder": None, "used": False, "players": []}, "pending": None,
        }

    async def fake_state(user=None):
        return {
            "week": 4, "phase": "social", "finished": False,
            "house": [
                {"id": "player", "status": "active"},
                {"id": "npc:8", "status": "evicted"},
                {"id": "npc:9", "status": "evicted"},
                {"id": "npc:2", "status": "active"},
            ],
        }

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)

    _run(chat_helpers.record_post_turn_desync_check(
        user,
        "The player invents a 'silence pact' on the lawn at dawn — an hour with no words, only a "
        "river stone passed hand to hand. The whole house plays along, grinning. Nothing is "
        "decided; the morning just feels lighter.",
    ))
    assert user not in chat_helpers._DESYNC_REGROUND, (
        "a creative turn queued a re-ground directive — the post-turn desync check reached into "
        "the OPEN set (ADR 0005 principle #1 violation)"
    )
    chat_helpers._DESYNC_REGROUND.pop(user, None)


def test_record_post_turn_desync_check_still_catches_a_phantom_eviction(monkeypatch):
    """The mirror of the above through the integration path: a turn that narrates an eviction the
    engine never committed DOES queue a re-ground — proof the post-turn check stays useful while
    leaving the open set alone."""
    user = "u-phantom-noncollapse"
    chat_helpers._DESYNC_REGROUND.pop(user, None)
    chat_helpers._LAST_BEAT_SIG[user] = {
        "week": 4, "phase": "eviction", "pending": None, "hoh": "npc:1",
        "noms": ["npc:2", "npc:3"], "vetoHolder": None, "vetoUsed": False,
        "evicted": 2, "finished": False,
    }

    async def fake_status(user=None):
        return {
            "week": 4, "phase": "eviction", "hoh": {"id": "npc:1"},
            "nominees": [{"id": "npc:2"}, {"id": "npc:3"}],
            "veto": {"holder": None, "used": False, "players": []}, "pending": None,
        }

    async def fake_state(user=None):  # still 2 evicted — the board did NOT move
        return {
            "week": 4, "phase": "eviction", "finished": False,
            "house": [
                {"id": "player", "status": "active"},
                {"id": "npc:8", "status": "evicted"},
                {"id": "npc:9", "status": "evicted"},
                {"id": "npc:2", "status": "active"},
            ],
        }

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)

    _run(chat_helpers.record_post_turn_desync_check(
        user, "After a tense vote, a houseguest is evicted from the house and the others sit stunned."))
    assert user in chat_helpers._DESYNC_REGROUND
    assert "RE-GROUND" in chat_helpers._DESYNC_REGROUND[user]
    chat_helpers._DESYNC_REGROUND.pop(user, None)


# ── 0065 Part C: the SAME corpus, but through the PRE-EMISSION guard (stream-side) ──────── #
#
# The post-turn check above is the NEXT-turn backstop. Part C moves the closed-set check BEFORE
# emission, into the agent loop's sentence-buffered stream scrubber. The anti-flattening guarantee
# (ADR 0005 principle #1) must hold THERE too: every dynamism-corpus entry must stream through the
# pre-emission guard UNTOUCHED, against the very board that would trip a real closed-set claim. This
# is the critical non-collapse coverage of the pre-emission path required by feature 0065 §5.


def _board_unchanged_fakes(monkeypatch):
    """Patch the engine reads so the live board matches _UNCHANGED (the board did NOT move this turn)
    — the strictest setting in which a real closed-set claim WOULD be held. If the guard reaches the
    board for creative prose at all, these get hit; if it stays out of the open set (correct), the
    cheap pre-filter short-circuits before they are ever called."""
    async def fake_status(user=None):
        return {
            "week": 4, "phase": "social", "hoh": {"id": "npc:1"},
            "nominees": [{"id": "npc:2"}, {"id": "npc:3"}],
            "veto": {"holder": None, "used": False, "players": []},
            "pending": None, "beatSeq": 7,
        }

    async def fake_state(user=None, **kw):
        return {
            "week": 4, "phase": "social", "finished": False, "beatSeq": 7,
            "house": [
                {"id": "player", "status": "active"},
                {"id": "npc:8", "status": "evicted"},
                {"id": "npc:9", "status": "evicted"},
                {"id": "npc:2", "status": "active"},
            ],
        }

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)


@pytest.mark.parametrize(
    "purpose,narration", _DYNAMISM_CORPUS, ids=[c[0] for c in _DYNAMISM_CORPUS],
)
def test_creative_narration_streams_through_the_headcount_wall_untouched(purpose, narration, monkeypatch):
    """ORW-205 on the same corpus: the premiere headcount wall polices a stated COUNT of who has arrived,
    never creative prose. Against a live entrance whose count every number in the corpus would contradict
    (the strictest setting), each entry must stream BYTE-IDENTICAL and queue no re-ground."""
    user = "u-headcount-noncollapse"
    chat_helpers._DESYNC_REGROUND.pop(user, None)

    async def fake_premiere_intros(user=None):
        return {"entrance": {"stage": "entrances", "index": 3, "total": 16, "playerPosition": 9,
                             "insideCount": 3, "playerInside": False,
                             "headcount": "3 of 16 are inside (the player has NOT walked in yet; they are not counted)"}}
    monkeypatch.setattr(orwell_engine, "premiere_intros", fake_premiere_intros)

    out = _run(agent_loop._headcount_wall_guard(narration, user))
    assert out == narration, (
        f"creative narration ({purpose}) was altered by the headcount wall (ADR 0005 #1).\nGot:\n{out!r}"
    )
    assert user not in chat_helpers._DESYNC_REGROUND
    chat_helpers._DESYNC_REGROUND.pop(user, None)


@pytest.mark.parametrize(
    "purpose,narration", _DYNAMISM_CORPUS, ids=[c[0] for c in _DYNAMISM_CORPUS],
)
def test_creative_narration_streams_through_the_pre_emission_guard_untouched(purpose, narration, monkeypatch):
    """ADR 0005 principle #1 on the PRE-EMISSION path: every uncoded creative/social narration must
    stream through `agent_loop._pre_emission_outcome_guard` BYTE-IDENTICAL (no sentence held), and
    must queue NO next-turn re-ground — even against a board that did not move. The pre-emission
    guard has no jurisdiction over the open set; holding creative prose is a defect."""
    user = "u-preemit-noncollapse"
    chat_helpers._DESYNC_REGROUND.pop(user, None)
    chat_helpers._LAST_BEAT_SIG[user] = dict(_UNCHANGED)
    _board_unchanged_fakes(monkeypatch)

    out = _run(agent_loop._pre_emission_outcome_guard(narration, user))
    assert out == narration, (
        f"creative narration ({purpose}) was altered by the pre-emission guard — it reached into the "
        f"OPEN set, violating ADR 0005 principle #1.\nGot:\n{out!r}"
    )
    assert user not in chat_helpers._DESYNC_REGROUND, (
        f"creative narration ({purpose}) queued a re-ground via the pre-emission guard (ADR 0005 #1)"
    )
    chat_helpers._LAST_BEAT_SIG.pop(user, None)
    chat_helpers._DESYNC_REGROUND.pop(user, None)


def test_pre_emission_guard_still_holds_a_phantom_eviction(monkeypatch):
    """The mirror — the pre-emission guard stays USEFUL: a streamed eviction is HELD (dropped) before
    emission (ADR 0005 #5 — closed-set strictness).

    T0-3 (issue #1778): an eviction claim is one of the 8 weekly-loop kinds now HARD-DROPPED
    unconditionally — the board is never even read to decide (it's stubbed to a stale, un-moved state
    here purely to prove that a genuinely PHANTOM claim is still caught; a real one would be too, per
    `test_0065_pre_emission_guard.py`'s `test_guard_hard_drops_an_eviction_claim_even_when_the_board_DID_confirm_it`).
    No `_DESYNC_REGROUND` entry is stashed — the drop itself is the whole correction now."""
    user = "u-preemit-phantom"
    chat_helpers._DESYNC_REGROUND.pop(user, None)
    chat_helpers._LAST_BEAT_SIG[user] = {**_UNCHANGED, "phase": "eviction"}

    async def fake_status(user=None):
        return {"week": 4, "phase": "eviction", "hoh": {"id": "npc:1"},
                "nominees": [{"id": "npc:2"}, {"id": "npc:3"}],
                "veto": {"holder": None, "used": False, "players": []}, "pending": None, "beatSeq": 7}

    async def fake_state(user=None, **kw):  # still 2 evicted — the board did NOT move
        return {"week": 4, "phase": "eviction", "finished": False, "beatSeq": 7,
                "house": [{"id": "player", "status": "active"},
                          {"id": "npc:8", "status": "evicted"},
                          {"id": "npc:9", "status": "evicted"},
                          {"id": "npc:2", "status": "active"}]}

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)

    out = _run(agent_loop._pre_emission_outcome_guard(
        "After a tense vote, one houseguest is evicted from the house.", user))
    assert "is evicted" not in out  # the claim sentence was hard-dropped before emission
    assert user not in chat_helpers._DESYNC_REGROUND  # T0-3: hard-drop, not a verify-then-correct hold
    chat_helpers._LAST_BEAT_SIG.pop(user, None)
    chat_helpers._DESYNC_REGROUND.pop(user, None)
