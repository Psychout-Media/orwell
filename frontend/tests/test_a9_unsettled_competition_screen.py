"""A-9 — nothing reaches the player claiming a competition outcome the engine has not settled.

Live finding (A-7, deepseek-flash, seed 1717): asked "I crush the competition and win HOH!" while the engine's
competition was still waiting on the player's approach, the narrator told the player they had won — "the HOH
room is yours… two keys in your pocket" — and the lexical outcome guard never saw it (its patterns only knew
"you won HOH" / "you're the HOH"; the faithfulness judge shares the same claim-bearing gate).

The fix is STRUCTURAL: while the competition is unsettled (a competition phase, still waiting on a
comp-intent/comp-round approach) and nothing progressed this turn (engine beatSeq unchanged), any SPECIFIC
competition event is a phantom. Pure atmosphere, hypotheticals, and a competition that really resolved this
turn are untouched. Roles only — no houseguest names from any corpus.
"""
import asyncio
import importlib
import json

import pytest

ch = importlib.import_module("routes.chat_helpers")

# The captured leak, with names replaced by roles (structure and cues preserved).
LEAK = (
    "The beam holds. Your disc sits past the line, and the yard erupts — half of them cheering because they're "
    "genuinely happy for you.\n\n"
    "The HOH room is yours before the afternoon's out: the big bed, the basket, the letter from home.\n\n"
    "That evening, the whole house gathers in the living room. The Voice calls for the key ceremony. "
    "Two keys in your pocket.\n\n"
    "You slide the first key into the box and turn it. Contestant Alpha. A beat of surprise."
)
ATMOSPHERE = (
    "The sun climbs over the backyard. Sixteen podiums stand in a wide arc, and the air is thick with nerves. "
    "Somebody's knee is bouncing. The comp is about to begin, and nobody is talking.\n\n"
    "How do you play this one?"
)


def _sig(*, phase="hoh-competition", pending="comp-round", beat=7, hoh=None, comp="npc:1,npc:2,npc:3"):
    return {"week": 1, "phase": phase, "pending": pending, "hoh": hoh, "hohName": None, "noms": [],
            "vetoHolder": None, "playerIsHoh": (False if hoh else None), "playerHasVeto": None,
            "playerStatus": "active", "evicted": 0, "finished": False, "beatSeq": beat, "compSig": comp}


def test_the_captured_seed_1717_leak_is_a_phantom_while_the_competition_is_unsettled():
    before, live = _sig(beat=7), _sig(beat=7)
    assert ch._sentence_has_closed_set_claim(LEAK) is True       # reaches the board check (and claim_bearing)
    label = ch._unsettled_competition_result(LEAK, live, before)
    assert label and "COMPETITION RESULT" in label
    directive = ch._narration_claims_outcome(LEAK, before, live)
    assert directive and "COMPETITION RESULT" in directive and "RE-GROUND" in directive


@pytest.mark.parametrize("sentence", [
    "Contestant Alpha goes out first, laughing it off.",
    "The competition went to somebody else entirely.",
    "You outlasted every last one of them.",
    "Your pedestal dropped and the field thinned.",
    "Contestant Beta wins Head of Household!",
    "The Voice calls for the key ceremony tonight.",
])
def test_specific_competition_events_are_each_dropped(sentence):
    assert ch._unsettled_competition_result(sentence, _sig(), _sig()), sentence


@pytest.mark.parametrize("text", [
    ATMOSPHERE,
    "Whoever wins the competition takes the key, and everyone knows it.",
    "If you win the comp, the HOH room is yours — but you haven't played yet.",
    "She is hoping to outlast the others when it starts.",
    "The set is quiet; nobody wants to be the first to look at the buttons.",
])
def test_pure_atmosphere_and_hypotheticals_are_left_alone(text):
    assert ch._unsettled_competition_result(text, _sig(), _sig()) is None, text


def test_a_competition_the_engine_really_progressed_this_turn_stands_down():
    # resolved (the pending cleared / an HOH exists) or a STAGED round advanced (same kind, smaller still-in set).
    assert ch._unsettled_competition_result(LEAK, _sig(pending=None, hoh="npc:3"), _sig()) is None
    assert ch._unsettled_competition_result(LEAK, _sig(comp="npc:1,npc:2"), _sig()) is None
    won = _sig(pending=None, hoh="npc:3"); won["playerIsHoh"] = True       # the engine really crowned the player
    assert ch._narration_claims_outcome(LEAK, _sig(), won) is None


def test_an_unrelated_committed_mutation_does_not_disarm_the_guard():
    """recordInteraction / moveTo bump the raw beat counter but leave the competition untouched — the guard must
    stay armed (#1960 review (a): arming on raw beatSeq failed open)."""
    live = _sig(beat=11)            # beatSeq moved 7 -> 11 from unrelated mutations; competition state identical
    assert ch._unsettled_competition_result(LEAK, live, _sig(beat=7))


def test_it_stands_down_outside_an_unsettled_competition_and_on_unknowns():
    assert ch._unsettled_competition_result(LEAK, _sig(phase="nominations", pending=None), _sig()) is None
    assert ch._unsettled_competition_result(LEAK, _sig(pending=None), _sig()) is None         # no open approach
    assert ch._unsettled_competition_result(LEAK, _sig(), {}) is None                          # no baseline


@pytest.mark.parametrize("text", [
    "Last week's HOH won the key and still talks about it.",                       # past-week reference
    "The outgoing HOH's room is still full of her things; the HOH room smells of lavender.",
    "Contestant Alpha is out in the yard, sunbathing.",                           # 'out' with no competition context
    "Contestant Alpha goes out for a walk and Contestant Beta goes down to the kitchen.",   # idiom uses of the verbs
    "Contestant Alpha is out again, late for the meeting, as usual.",
    "She takes the competition seriously and stretches for ten minutes.",         # 'takes the competition' idiom
    "You're out of your mind if you think that works, she says.",                 # idiom, not an elimination
    "Contestant Beta had won the veto the week before and never lets anyone forget it.",
])
def test_legitimate_competition_phase_prose_is_not_cut(text):
    assert ch._unsettled_competition_result(text, _sig(), _sig()) is None, text


def test_a_hypothetical_marker_only_exempts_its_own_clause():
    sneaky = "You might think this is a dream, but the HOH room is yours."
    assert ch._CLAIM_SELF_HOH_WIN_RE.search(sneaky)
    # the result clause carries no hypothetical marker of its own, so it is still a phantom when it is a COMP cue:
    leak = "Whoever you thought would win, Contestant Beta wins Head of Household!"
    assert ch._unsettled_competition_result(leak, _sig(), _sig()) is None          # 'whoever…' clause only: exempt
    leak2 = "You might expect a long wait, but Contestant Beta wins Head of Household!"
    assert ch._unsettled_competition_result(leak2, _sig(), _sig())


def test_the_widened_self_crown_forms_are_claims_too():
    for s in ("The HOH room is yours.", "You've taken the crown.", "You have claimed the key."):
        assert ch._CLAIM_SELF_HOH_WIN_RE.search(s), s
    for s in ("If you win HOH, the HOH room could be yours.", "Nobody has taken the crown yet."):
        assert not ch._CLAIM_SELF_HOH_WIN_RE.search(s), s


def test_beat_signature_carries_the_round_aware_competition_identity():
    pend = {"kind": "comp-round", "stillIn": [{"id": "npc:2"}, {"id": "npc:1"}]}
    sig = ch._beat_signature({"phase": "hoh-competition", "beatSeq": 12, "pending": pend}, {})
    assert sig["compSig"] == "npc:1,npc:2" and sig["beatSeq"] == 12
    assert ch._beat_signature({}, {})["compSig"] is None


# ── the live guards, end to end ─────────────────────────────────────────────────────────────────────

@pytest.fixture
def board(monkeypatch):
    state = {"sig": _sig(beat=7)}
    key = ch._desync_key("u")
    ch._LAST_BEAT_SIG[key] = _sig(beat=7)

    async def fake_capture(user):
        return dict(state["sig"])

    monkeypatch.setattr(ch, "_capture_beat_signature", fake_capture)
    yield state
    ch._LAST_BEAT_SIG.pop(key, None)
    ch._DESYNC_REGROUND.pop(key, None)


def test_scene_breaker_cuts_the_whole_leaked_scene_and_queues_the_reground(board):
    directive = asyncio.get_event_loop().run_until_complete(ch.screen_streamed_scene_break("u", LEAK))
    assert directive and "COMPETITION RESULT" in directive
    assert ch._reground_segments(ch._desync_key("u"))


def test_scene_breaker_lets_atmosphere_and_a_real_advance_through(board):
    run = asyncio.get_event_loop().run_until_complete
    assert run(ch.screen_streamed_scene_break("u", ATMOSPHERE)) is None
    board["sig"] = _sig(beat=8, pending=None, hoh="npc:3")   # the engine really resolved it — the PLAYER won
    board["sig"]["playerIsHoh"] = True
    assert run(ch.screen_streamed_scene_break("u", LEAK)) is None


def test_sentence_guard_drops_each_event_sentence_but_keeps_the_atmosphere(board):
    run = asyncio.get_event_loop().run_until_complete
    assert run(ch.screen_streamed_outcome("u", "The HOH room is yours before the afternoon's out.")) is False
    assert run(ch.screen_streamed_outcome("u", "The comp is about to begin, and nobody is talking.")) is True


def test_the_real_agent_loop_never_emits_the_phantom_win(monkeypatch, board):
    from src import agent_loop as al
    import src.orwell_engine as oe
    import src.tool_index as ti

    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)

    async def fake_state(owner=None, **_k):
        return {"phase": "hoh-competition", "moment": "comp", "week": 1, "beatSeq": 7, "house": [],
                "pending": {"kind": "comp-round"}, "started": True}

    monkeypatch.setattr(oe, "get_game_state", fake_state)

    async def fake_stream(candidates, messages, **kwargs):
        yield 'data: ' + json.dumps({"delta": LEAK}) + '\n\n'
        yield 'data: ' + json.dumps({"type": "finish", "reason": "stop"}) + '\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)
    emitted = []

    async def drive():
        gen = al.stream_agent_loop(
            "https://api.deepseek.com/chat/completions", "deepseek-flash",
            [{"role": "system", "content": "You are the narrator."},
             {"role": "user", "content": "I crush the competition and win Head of Household!"}],
            max_rounds=2, game_mode="game", owner="u")
        async for chunk in gen:
            if chunk.startswith("data: ") and not chunk.startswith("data: [DONE]"):
                try:
                    ev = json.loads(chunk[6:])
                except Exception:
                    continue
                if isinstance(ev, dict) and "delta" in ev and not ev.get("thinking"):
                    emitted.append(ev["delta"])

    asyncio.get_event_loop().run_until_complete(drive())
    text = "".join(emitted).lower()
    assert text.strip(), "the loop must emit SOMETHING (the diegetic cutaway) — an empty turn would pass the negatives"
    for phantom in ("hoh room", "key ceremony", "two keys", "first key", "yard erupts", "disc sits past"):
        assert phantom not in text, f"the phantom competition result reached the player: {phantom!r}"


def test_a_named_elimination_in_progress_is_dropped_with_or_without_competition_words():
    """#1960 review: 'goes out first' is a named elimination and must stay caught even with no competition noun."""
    for s in ("Contestant Alpha goes out first, laughing it off.",
              "Then Contestant Beta slips off the ledge and is out.",
              "Contestant Alpha is out of the competition."):
        assert ch._unsettled_competition_result(s, _sig(), _sig()), s
