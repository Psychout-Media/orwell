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


def _sig(*, phase="hoh-competition", pending="comp-round", beat=7, hoh=None):
    return {"week": 1, "phase": phase, "pending": pending, "hoh": hoh, "hohName": None, "noms": [],
            "vetoHolder": None, "playerIsHoh": (False if hoh else None), "playerHasVeto": None,
            "playerStatus": "active", "evicted": 0, "finished": False, "beatSeq": beat}


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


def test_a_competition_the_engine_really_resolved_this_turn_stands_down():
    # the beat MOVED (the model called advanceGame / the approach was committed): the engine produced events.
    assert ch._unsettled_competition_result(LEAK, _sig(beat=8), _sig(beat=7)) is None
    assert ch._narration_claims_outcome(LEAK, _sig(beat=7), _sig(beat=8, pending=None)) is None


def test_it_stands_down_outside_an_unsettled_competition_and_on_unknowns():
    assert ch._unsettled_competition_result(LEAK, _sig(phase="nominations", pending=None), _sig()) is None
    assert ch._unsettled_competition_result(LEAK, _sig(pending=None), _sig()) is None         # no open approach
    assert ch._unsettled_competition_result(LEAK, _sig(), {}) is None                          # no baseline
    nobeat = _sig(); nobeat["beatSeq"] = None
    assert ch._unsettled_competition_result(LEAK, nobeat, _sig()) is None                     # unknown beatSeq


def test_the_widened_self_crown_forms_are_claims_too():
    for s in ("The HOH room is yours.", "You've taken the crown.", "You have claimed the key."):
        assert ch._CLAIM_SELF_HOH_WIN_RE.search(s), s
    for s in ("If you win HOH, the HOH room could be yours.", "Nobody has taken the crown yet."):
        assert not ch._CLAIM_SELF_HOH_WIN_RE.search(s), s


def test_beat_signature_carries_the_beat_counter():
    sig = ch._beat_signature({"phase": "hoh-competition", "beatSeq": 12, "pending": {"kind": "comp-round"}}, {})
    assert sig["beatSeq"] == 12


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
    for phantom in ("hoh room", "key ceremony", "two keys", "first key", "yard erupts", "disc sits past"):
        assert phantom not in text, f"the phantom competition result reached the player: {phantom!r}"
