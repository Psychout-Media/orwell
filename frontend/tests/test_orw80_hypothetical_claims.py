"""ORW-80 (A96) — a conditional or hypothetical about a weekly-loop outcome is talk, not a claim.

Live replay 4: "if somebody wins the veto tomorrow" — strategy talk about a FUTURE outcome — was cut. The
closed-set detectors match committed-sounding verbs ("wins the veto", "wins HOH", "is evicted") with no
regard for a conditional in front of them, so a hypothetical was treated as an outcome claim:

  * the T0-3 hard-drop rail (`_sentence_has_chyron_covered_claim`) dropped the sentence outright;
  * the A2 scene circuit-breaker cut the WHOLE scene (`_narration_claims_outcome` in the outcome's own
    phase, `_unbacked_outcome_absent` in the premiere) and showed the "feeds cut away" line;
  * the S2a round-end belt replaced the draft.

ORW-10 already exempted hypotheticals for nominations and the player's own veto win, inside the board
verify only (#2221). These gates pin the same rule for every weekly-loop claim kind on every path: a
match whose OWN clause, before it, carries a conditional lead-in (if, unless, what if, whoever, suppose,
imagine, ...) is not a claim; a committed claim — including one in another sentence of the same text,
one with the conditional AFTER it, or one in a later clause than the lead-in — is still caught.

Review of #2290: a lead-in anywhere earlier in the sentence was enough, and the "if" in "as if" / "even if"
counted, so fabricated outcomes passed every detector ("As if on cue, Marcus wins the veto."). A lead-in now
governs only its own clause (a comma, semicolon, colon or dash ends it), and "as if", "even if" and
"whether" are never lead-ins. The review's phrasings are kept verbatim below (their names are fictional);
everything else uses roles only.
"""

import asyncio
import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
agent_loop = importlib.import_module("src.agent_loop")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


_USER = "u-orw80"
_A96 = "If somebody wins the veto tomorrow, the whole house shifts."   # the live replay 4 shape

HYPOTHETICALS = [
    _A96,
    "Whoever wins the veto tomorrow decides the week.",
    "\"If he wins HOH, we're safe,\" she says.",
    "\"If I won the veto and you were on the block.\" He says it back to you slowly.",   # #2221's line
    "What if the nominee wins the veto?",
    "Unless someone wins the veto, the noms stay the same.",
    "If he is evicted Thursday, nobody will miss him.",
    "If you won HOH, what would you even do with it?",
]

COMMITTED = [
    "The houseguest wins the veto.",
    "He wins the veto, and the room erupts.",
    "The houseguest wins the veto, if you can believe it.",   # the conditional comes AFTER the claim
    "The houseguest is evicted from the house.",
    "You won HOH!",
    # "even if" is concessive and "as if" is manner, not conditionals, and "whether" introduces both, so none
    # of them makes a claim talk, even inside the claim's own clause (review of #2290)
    "Even if he wins the veto, he's going home.",
    "As if on cue the houseguest wins the veto.",
    "Whether anyone likes it or not the houseguest wins HOH.",
    # a dash ends the lead-in's clause just like a comma or a colon
    "And then — as if on cue — the houseguest wins the veto.",
    "Imagine it - the houseguest wins HOH.",
]

# The review of #2290: every one of these passed the hard-drop rail, the closed-set pre-filter and the board
# verify on the branch, and every one is a fabricated outcome. (phase, line): the phase is the outcome's own.
REVIEW_FABRICATIONS = [
    ("veto-competition", "As if on cue, Marcus wins the veto."),
    ("hoh-competition", "Even if nobody saw it coming, Dana wins HOH."),
    ("eviction", "As if the house had been waiting, Priya is evicted."),
    ("hoh-competition", "Whether or not you believe it, you won HOH."),
    ("veto-competition", "Wondering if it was fair, you watch as Marcus wins the veto."),
    ("veto-competition", "Then, as if it were nothing, Dana wins the Power of Veto, and Marcus is evicted."),
    ("veto-competition", "Thanks, if you must know, I won the veto."),
    ("hoh-competition", "Imagine that: Dana wins HOH."),
]


@pytest.fixture(autouse=True)
def _clean():
    chat_helpers._LAST_BEAT_SIG.pop(_USER, None)
    chat_helpers._DESYNC_REGROUND.pop(_USER, None)
    yield
    chat_helpers._LAST_BEAT_SIG.pop(_USER, None)
    chat_helpers._DESYNC_REGROUND.pop(_USER, None)


def _board(phase, **kw):
    sig = {"week": 2, "phase": phase, "pending": None, "hoh": "npc:1", "hohName": "the HOH",
           "noms": ["npc:2", "npc:3"], "nomNames": ["Nominee One", "Nominee Two"], "vetoHolder": None,
           "vetoHolderName": None, "vetoUsed": False, "evicted": 2, "finished": False,
           "playerIsHoh": False, "playerHasVeto": False}
    sig.update(kw)
    return sig


def _boom_reads(monkeypatch):
    async def boom(*a, **k):
        raise AssertionError("a hypothetical must never send the guard to the board")
    monkeypatch.setattr(orwell_engine, "game_status", boom)
    monkeypatch.setattr(orwell_engine, "get_game_state", boom)


# ── the detectors ─────────────────────────────────────────────────────────────────────────────────── #

@pytest.mark.parametrize("text", HYPOTHETICALS)
def test_a_hypothetical_is_not_a_hard_drop_claim(text):
    assert not chat_helpers._sentence_has_chyron_covered_claim(text), text


@pytest.mark.parametrize("text", HYPOTHETICALS)
def test_a_hypothetical_is_not_a_closed_set_claim(text):
    assert not chat_helpers._sentence_has_closed_set_claim(text), text


@pytest.mark.parametrize("text", COMMITTED)
def test_a_committed_claim_is_still_caught(text):
    assert chat_helpers._sentence_has_chyron_covered_claim(text), text
    assert chat_helpers._sentence_has_closed_set_claim(text), text


@pytest.mark.parametrize("phase,text", REVIEW_FABRICATIONS)
def test_a_lead_in_outside_the_claims_clause_never_hides_a_fabrication(phase, text):
    """Review of #2290: each line still hard-drops, still trips the pre-filter, and the board verify still
    catches it in the outcome's own phase."""
    assert chat_helpers._sentence_has_chyron_covered_claim(text), text
    assert chat_helpers._sentence_has_closed_set_claim(text), text
    board = _board(phase)
    assert chat_helpers._narration_claims_outcome(text, board, dict(board)), text


def test_the_stream_guard_drops_a_review_fabrication_and_keeps_the_hypothetical():
    chat_helpers._LAST_BEAT_SIG[_USER] = _board("veto-competition")
    out = _run(agent_loop._pre_emission_outcome_guard("As if on cue, Marcus wins the veto. " + _A96, _USER))
    assert "Marcus wins the veto" not in out
    assert _A96 in out


# ── the board verify, in the outcome's own phase (what cut the scene) ────────────────────────────── #

@pytest.mark.parametrize("phase,text", [
    ("veto-competition", _A96),
    ("veto-competition", "Whoever wins the veto tomorrow decides the week."),
    ("hoh-competition", "\"If he wins HOH, we're safe,\" she says."),
    ("hoh-competition", "If you won HOH, what would you even do with it?"),
    ("social", "If he is evicted Thursday, nobody will miss him."),
])
def test_the_board_verify_never_reads_a_hypothetical_as_an_outcome(phase, text):
    board = _board(phase)
    assert chat_helpers._narration_claims_outcome(text, board, dict(board)) is None


@pytest.mark.parametrize("phase,text", [
    ("veto-competition", "The houseguest wins the veto."),
    ("hoh-competition", "The houseguest wins HOH!"),
    ("social", "The houseguest is evicted from the house."),
])
def test_the_board_verify_still_catches_a_phantom_outcome(phase, text):
    board = _board(phase)
    assert chat_helpers._narration_claims_outcome(text, board, dict(board))


def test_a_real_claim_next_to_a_hypothetical_is_still_caught():
    board = _board("veto-competition")
    text = "The houseguest wins the veto. " + _A96
    assert chat_helpers._narration_claims_outcome(text, board, dict(board))


def test_the_premiere_absence_check_lets_a_hypothetical_through():
    live = _board("premiere", hoh=None, hohName=None, noms=[], nomNames=[], evicted=0)
    assert chat_helpers._unbacked_outcome_absent("If he wins HOH tomorrow, we're safe.", live) is None
    assert chat_helpers._unbacked_outcome_absent(_A96, live) is None
    # a committed crown in the premiere is still a fabrication by construction
    assert chat_helpers._unbacked_outcome_absent("The houseguest wins HOH!", live)


# ── the live paths: the line streams, the scene is not cut, the draft is not replaced ──────────────── #

def test_the_stream_guard_emits_the_hypothetical_byte_identical(monkeypatch):
    chat_helpers._LAST_BEAT_SIG[_USER] = _board("veto-competition")
    _boom_reads(monkeypatch)
    text = "The backyard is loud. " + _A96 + " Nobody laughs."
    assert _run(agent_loop._pre_emission_outcome_guard(text, _USER)) == text


def test_the_scene_circuit_breaker_does_not_cut_a_hypothetical(monkeypatch):
    chat_helpers._LAST_BEAT_SIG[_USER] = _board("veto-competition")
    _boom_reads(monkeypatch)
    assert _run(chat_helpers.screen_streamed_scene_break(_USER, _A96)) is None
    assert _USER not in chat_helpers._DESYNC_REGROUND


def _readable_board(monkeypatch, phase):
    """A readable live board in `phase`, with the same board as this turn's baseline."""
    board = _board(phase)
    chat_helpers._LAST_BEAT_SIG[_USER] = dict(board)

    async def live(user):
        return dict(board)
    monkeypatch.setattr(chat_helpers, "_capture_beat_signature", live)


def test_the_round_end_belt_does_not_replace_a_hypothetical(monkeypatch):
    _readable_board(monkeypatch, "veto-competition")
    res = _run(chat_helpers.enforce_grounded_draft(_USER, _A96, []))
    assert res.action == "pass" and res.text == _A96


def test_the_round_end_belt_still_replaces_a_phantom_veto_win(monkeypatch):
    _readable_board(monkeypatch, "veto-competition")
    res = _run(chat_helpers.enforce_grounded_draft(_USER, "The houseguest wins the veto.", []))
    assert res.action == "replaced"


def test_the_stream_guard_still_drops_a_committed_claim_beside_a_hypothetical():
    chat_helpers._LAST_BEAT_SIG[_USER] = _board("veto-competition")
    out = _run(agent_loop._pre_emission_outcome_guard("The houseguest wins the veto. " + _A96, _USER))
    assert "The houseguest wins the veto." not in out
    assert _A96 in out
