"""ORW-715: a reply that states a veto decision the engine has not made, or the wrong one, is caught by the pre-display checker (ORW-408's structure) against the engine's own ceremony
facts, quoted speech included. A faked narrator reply goes through the real stream loop; the engine side (the facts themselves) is gated by tests/unit/ceremonyFacts.test.ts. Roles only."""
import importlib
import sys
import os

import pytest

sys.path.insert(0, os.path.dirname(__file__))
t408 = importlib.import_module("test_orw408_sentence_rewrite")
from src import predisplay_check as pc  # noqa: E402

pytestmark = [pytest.mark.usefixtures("non_game_text_routing"), pytest.mark.usefixtures("zero_clocks_off")]

H = {"id": "npc:holder", "name": "Alpha Holder"}
HOH = {"id": "npc:hoh", "name": "Bravo Boss"}
N1 = {"id": "npc:n1", "name": "Charlie Nominee"}
N2 = {"id": "npc:n2", "name": "Delta Nominee"}
REPL = {"id": "npc:r", "name": "Echo Replacement"}


def cer(decision, holder=H):
    return {"hoh": HOH, "nominees": [N1, N2], "veto": {"holder": holder, "used": bool(decision and decision.get("used")), "players": [], **({"decision": decision} if decision is not None else {})}}


UNMADE = cer({"made": False})
NOT_USED = cer({"made": True, "used": False})
USED_ON_SELF = cer({"made": True, "used": True, "saved": H, "replacement": REPL})
USED_ON_NOMINEE = cer({"made": True, "used": True, "saved": N1, "replacement": REPL})


@pytest.mark.parametrize("text", [
    "I'm not using it, and I'm not taking anybody down.",
    "\"I'm not using it,\" Alpha Holder says, turning the veto over once.",
    "\"I used it. I took Charlie Nominee down.\"",
    "Alpha Holder says she has decided to use the Power of Veto.",
    "Alpha Holder uses the veto, and Bravo Boss names Echo Replacement as the replacement.",
])
def test_a_decision_stated_before_the_engine_made_one_is_a_conflict(text):
    assert pc.veto_decision_conflict(text, UNMADE), text


@pytest.mark.parametrize("text", [
    "Do you wish to use the Power of Veto?",
    "If Alpha Holder uses the veto, somebody comes down.",
    "Alpha Holder has not decided yet.",
    "Alpha Holder turns the veto over once in her fingers and does not say a word.",
    "Charlie Nominee says, \"I'd use it if I were you.\"",
    "Bravo Boss is worried about Charlie Nominee, and the room goes quiet.",
])
def test_ceremony_talk_that_states_no_decision_is_clean_before_the_decision(text):
    assert pc.veto_decision_conflict(text, UNMADE) is None, text


def test_the_wrong_announced_decision_is_a_conflict():
    # the playtest case: the engine had the holder save herself, the narrator had her take the other nominee down
    assert pc.veto_decision_conflict("\"I used it. I took Charlie Nominee down.\"", USED_ON_SELF)
    assert pc.veto_decision_conflict("Alpha Holder uses the veto on Charlie Nominee.", USED_ON_SELF)
    assert pc.veto_decision_conflict("\"I took myself down,\" she says.", USED_ON_NOMINEE)
    assert pc.veto_decision_conflict("Bravo Boss names Delta Nominee as the replacement.", USED_ON_SELF)
    assert pc.veto_decision_conflict("\"I'm not using it,\" Alpha Holder says.", USED_ON_SELF)
    assert pc.veto_decision_conflict("Alpha Holder used the veto.", NOT_USED)
    assert pc.veto_decision_conflict("Bravo Boss names Delta Nominee as the replacement.", NOT_USED)


def test_the_announced_decision_stated_correctly_is_clean():
    assert pc.veto_decision_conflict("\"I used it. I took myself down.\"", USED_ON_SELF) is None
    assert pc.veto_decision_conflict("Alpha Holder uses the veto on herself, and Bravo Boss names Echo Replacement as the replacement.", USED_ON_SELF) is None
    assert pc.veto_decision_conflict("\"I took Charlie Nominee down.\"", USED_ON_NOMINEE) is None
    assert pc.veto_decision_conflict("\"I'm not using it,\" Alpha Holder says.", NOT_USED) is None
    assert pc.veto_decision_conflict("\"I'm not using it,\" Alpha Holder says.", cer(None)) is None, "no decision field (flag off / older engine) => never judged"
    assert pc.veto_decision_conflict("\"I used it.\"", {"hoh": HOH, "nominees": [], "veto": {"holder": None, "used": False, "players": []}}) is None


def test_the_vote_result_names_only_the_engine_evictee():
    ev = {"evictee": {"id": "npc:n1", "name": "Charlie Nominee"}}
    board = cer({"made": True, "used": False})
    assert pc.evictee_conflict("Delta Nominee, you have been evicted from the Big Brother house.", ev, board)
    assert pc.evictee_conflict("Charlie Nominee, you have been evicted from the Big Brother house.", ev, board) is None
    assert pc.evictee_conflict("Delta Nominee, you have been evicted.", {}, board) is None, "no decided evictee => no fact"
    assert pc.evictee_conflict("If Delta Nominee is evicted tonight, the house changes.", ev, board) is None


def test_the_checker_flows_these_facts_through_the_same_details_and_correction_path():
    state = {"asleep": [], "ceremony": USED_ON_SELF}
    hits = pc.conflict_details("\"I used it. I took Charlie Nominee down.\"", state, zero_clocks=False)
    assert [h.fact for h in hits] == [pc.FACT_VETO]
    line = pc._correction_line(hits[0])
    assert "Alpha Holder used it on themselves" in line and "Echo Replacement is the replacement" in line
    assert "not been made" in pc._correction_line(pc.Conflict(pc.FACT_VETO, "not made"))


def test_a_faked_narrator_reply_stating_an_unmade_decision_is_counted_through_the_real_loop(monkeypatch):
    """Rewrite OFF (its shipped default): the hit is COUNTED + logged, the text is not altered. Same path and counter as the other hard facts."""
    monkeypatch.setenv("ORWELL_PREDISPLAY_REWRITE", "0")
    before = pc.PREDISPLAY_COUNTS.get(pc.FACT_VETO, 0)
    reply = "The room waits. Alpha Holder folds her arms. \"I'm not using it,\" she says flatly. "
    emitted, cont, _stored, _n = t408._drive(monkeypatch, rounds_scripts=[{"deltas": [reply]}], state={"asleep": [], "ceremony": UNMADE})
    assert pc.PREDISPLAY_COUNTS.get(pc.FACT_VETO, 0) == before + 1
    assert "I'm not using it" in emitted and cont == []


def test_with_the_rewrite_on_the_unmade_decision_is_withheld_and_revoiced_once(monkeypatch):
    monkeypatch.setenv("ORWELL_PREDISPLAY_REWRITE", "1")
    clean = "The room waits for her. "
    bad = "\"I used it. I took Charlie Nominee down,\" she says. "
    emitted, cont, _stored, _n = t408._drive(monkeypatch, rounds_scripts=[{"deltas": [clean, bad, "Nobody moves. "]}], redo="Nobody breathes, and the game has not said which way it goes.",
                                              state={"asleep": [], "ceremony": UNMADE})
    assert "I used it" not in emitted and "Charlie Nominee down" not in emitted
    assert len(cont) == 1 and "has not been made yet" in cont[0][-1]["content"]


# ── the blank quotes in a vote reveal ────────────────────────────────────────────────────────────────────
import asyncio  # noqa: E402

_EVICTION_SIG = {"phase": "eviction", "hohName": "Alpha Holder", "nomNames": ["Charlie Nominee", "Delta Nominee"], "activeNames": ["Alpha Holder", "Bravo Boss", "Charlie Nominee", "Delta Nominee"],
                 "evictedNames": [], "vetoHolderName": None, "evictionBallots": 0, "playerName": "Delta Nominee"}


def _balanced(t):
    return t.count('"') % 2 == 0


@pytest.mark.parametrize("text", [
    'The room is quiet. "A vote to evict Charlie Nominee." A slip turned. "Another." The paper goes down. "A vote to evict Delta Nominee." The room does not move.',
    'Bravo Boss unfolds the first slip. "Charlie Nominee."\n\n"Delta Nominee."\n\n"Charlie Nominee." A pause, unhurried. "That is the last of them."',
    'Progress is slow. "A vote to evict Charlie Nominee." A slip turned. Alpha Holder shifts. "A vote to evict Delta Nominee." The paper goes down on the table.',
])
def test_a_stripped_ballot_readout_never_leaves_a_stray_quote_mark(text):
    """The ballots were read before the engine revealed any (evictionBallots 0), so the role-claim screen strips them. It used to strip the opening quote and leave the closing one, so the player
    saw `quiet." A slip turned.` and empty quote pairs."""
    from src import role_claims as rc
    kept, stripped, _ = rc.screen_role_units(text, _EVICTION_SIG, {"roles": set(), "ttl": 0})
    assert stripped, "the early ballots are still stripped (the engine had revealed none)"
    assert _balanced(kept), kept
    assert '" A slip' not in kept and '."  ' not in kept
    # every stripped piece is exact text of the original, in order (the raw-buffer mirror erases each whole)
    pos = 0
    for u in stripped:
        i = text.find(u["unit"], pos)
        assert i >= 0, u
        pos = i + len(u["unit"])


def test_the_real_screen_path_strips_whole_quoted_ballots(monkeypatch):
    ch = importlib.import_module("routes.chat_helpers")

    async def fake_sig(user):
        return dict(_EVICTION_SIG)
    monkeypatch.setattr(ch, "_capture_beat_signature", fake_sig)
    ch._LAST_BEAT_SIG["orw715"] = dict(_EVICTION_SIG)
    try:
        text = 'The room is quiet. "A vote to evict Charlie Nominee." A slip turned. "A vote to evict Delta Nominee." The paper goes down.'
        kept, drops = asyncio.get_event_loop().run_until_complete(ch.screen_role_claims_ex("orw715", text))
    finally:
        ch._LAST_BEAT_SIG.pop("orw715", None)
    assert _balanced(kept) and "A vote to evict" not in kept, kept
    assert drops
