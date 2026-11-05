"""A80 - N-3 / N-15 / N-16 phrasing no test depended on. Deleting any of these alternatives left the suite green:
N-3 `_DENY_NOMS_RE` #3 ("the nominees haven't been named"); N-15 `_PLAYER_CHOICE_BY_PENDING`: nominations #1, secret-veto #2, eviction-vote #2, tie-break #1 and #2, juror-vote #1 and #2;
N-16 `_COMP_STARTED_CUES` family #2 ("the competition begins / ready set go / three-two-one"). Each gets both ways: the claim while the matching card is open / the fact committed is flagged; the same
words with the card closed, a hypothetical, or another person's act are untouched; and the alternative's own deletion (rebuilt in-suite) stops the flag. Roles only. Indices are 0-based."""
import importlib

import pytest

from _regex_alts import top_level_alternatives, without

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")


def _n15_live(pending):
    return {"phase": "eviction", "week": 1, "pending": pending}


# (pending kind, alternative index, label, claim, closed/hypothetical/other-person variants that must stay untouched)
N15 = [
    ("nominations", 1, "your nominees are / will be", "Your nominees are NomOne and NomTwo.", ["If your nominees are NomOne and NomTwo, you will campaign.", "Her nominees are NomOne and NomTwo."]),
    ("secret-veto", 2, "you pull / take yourself off the block", "You pull yourself off the block.", ["If you pull yourself off the block, the house will notice.", "She pulls herself off the block."]),
    ("eviction-vote", 2, "you vote(d) to evict / for", "You vote for NomOne.", ["If you vote for NomOne, she will hear about it.", "He votes for NomOne."]),
    ("tie-break", 1, "your tie-break vote is cast", "Your tie-break vote is cast.", ["Once your tie-break vote is cast, the room will know.", "Her tie-break vote is cast."]),
    ("tie-break", 2, "you vote(d) to evict / for", "You vote to evict NomOne.", ["Should you vote to evict NomOne, expect a speech.", "He votes to evict NomOne."]),
    ("juror-vote", 1, "you vote for X to win", "You vote for Alpha to win.", ["If you vote for Alpha to win, say so.", "She votes for Alpha to win."]),
    ("juror-vote", 2, "you crown", "You crown Alpha.", ["Would you crown Alpha?", "She crowns Alpha."]),
]


@pytest.mark.parametrize("pending,idx,label,claim,untouched", N15, ids=[f"{c[0]}#{c[2][:14]}" for c in N15])
def test_n15_alternative_flags_the_open_card_claim_and_leaves_the_rest(monkeypatch, pending, idx, label, claim, untouched):
    rx = ch._PLAYER_CHOICE_RES[pending]
    assert len(top_level_alternatives(rx.pattern)) > idx, f"{pending} has no alternative #{idx}"
    assert ch._uncommitted_player_choice(claim, _n15_live(pending)), f"{pending}#{idx} ({label}): {claim!r} must be flagged while its card is open"
    assert not ch._uncommitted_player_choice(claim, _n15_live(None)), "same words with the card closed: untouched"
    for t in untouched:
        assert not ch._uncommitted_player_choice(t, _n15_live(pending)), f"{pending}#{idx}: {t!r} must stay untouched"
    monkeypatch.setitem(ch._PLAYER_CHOICE_RES, pending, without(rx, idx))
    assert not ch._uncommitted_player_choice(claim, _n15_live(pending)), f"{pending}#{idx} ({label}): another alternative also flags {claim!r}; the case is not isolating this one"


def _n3_live(**kw):
    base = {"phase": "veto-competition", "week": 1, "hoh": "npc:5", "hohName": "Alpha", "noms": ["npc:2", "npc:4"], "nomNames": ["Bravo", "Charlie"], "vetoHolder": None, "vetoHolderName": None}
    base.update(kw)
    return base


def test_n3_deny_noms_alternative_3_nominees_havent_been_named(monkeypatch):
    t = "The nominees haven't been named."
    assert ch._stale_denial_contradiction(t, _n3_live()), "committed nominations + 'the nominees haven't been named' => flagged"
    assert not ch._stale_denial_contradiction(t, _n3_live(noms=[], nomNames=[])), "nominations not committed: the denial is true, untouched"
    assert ch._stale_denial_contradiction("The nominees aren't set yet.", _n3_live()), "the 'aren't set yet' form is alternative #3 too"
    assert not ch._stale_denial_contradiction("If the nominees haven't been named by noon, she will panic.", _n3_live()), "a conditional clause is untouched"
    assert not ch._stale_denial_contradiction("The party is not yet set.", _n3_live()), "an unrelated 'not yet' stays untouched"
    monkeypatch.setattr(ch, "_DENY_NOMS_RE", without(ch._DENY_NOMS_RE, 3))
    assert not ch._stale_denial_contradiction(t, _n3_live()), "deleting alternative #3 must stop the flag (another alternative also matches: pick a phrase only #3 matches)"


def test_n16_second_cue_family_is_load_bearing(monkeypatch):
    live = {"week": 1, "phase": "hoh-competition", "pending": None, "compNotDue": True}
    two = '"Take your spots." Then the competition begins and the buzzer sounds.'  # family 1 (spots) + family 2 (begins)
    assert ch._comp_started_before_due(two, live), "two families while not due => flagged"
    assert not ch._comp_started_before_due('"Take your spots." The cameras settle.', live), "one family alone is a stage direction"
    assert not ch._comp_started_before_due(two, {**live, "compNotDue": False}), "due: the comp may start"
    for phrase in ("Ready, set, go.", "Three, two, one, go.", "The first round starts."):
        assert ch._comp_started_before_due('"Take your spots." ' + phrase, live), phrase
    monkeypatch.setattr(ch, "_COMP_STARTED_CUES", tuple(r for i, r in enumerate(ch._COMP_STARTED_CUES) if i != 1))
    assert not ch._comp_started_before_due(two, live), "deleting family #2 must stop the flag (it is the only second family in this phrase)"
