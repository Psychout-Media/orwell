"""A89 - a guard-by-entry-point TABLE, so an N-guard cannot silently live in only one place (A74 was exactly that: N-16 only reached the post-turn check). For one canonical phrase per detector of
`_narration_claims_outcome`, assert where it is caught:

  gate     the cheap sentence gate `_sentence_has_closed_set_claim` (what keeps the pre-emission guards off creative prose)
  sentence `screen_streamed_outcome` as the stream scrubber really uses it: only for a sentence that passed the gate, so the cell is gate AND held
  scene    `screen_streamed_scene_break` (whole-scene cut before the player sees it)
  draft    `_detect_ungrounded_overclaim` (the grounded-draft hard block, `enforce_grounded_draft`)
  post     `record_post_turn_desync_check` (the next-turn re-ground backstop)

The intended table is encoded below. Every deliberate "not caught here" cell carries a reason; a new gap, or a fix that closes one, fails the test until the table is updated on purpose.
Mutations that must go red: drop the N-16 arm from the scene gate or from the draft check; remove a detector from the gate. Roles only."""
import asyncio
import importlib

import pytest

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")
USER = "a89-user"


def _base(**kw):
    b = {"week": 1, "phase": "veto-ceremony", "pending": None, "hoh": "npc:7", "hohName": "Hoh", "noms": ["npc:2", "npc:4"], "nomNames": ["NomOne", "NomTwo"],
         "vetoHolder": "npc:1", "vetoHolderName": "Holder", "vetoUsed": False, "playerIsHoh": False, "playerHasVeto": False, "playerStatus": "active",
         "evicted": 0, "finished": False, "beatSeq": 40, "compSig": None, "vetoFieldIds": [], "vetoFieldNames": [], "playerId": "player", "compNotDue": None,
         "activeNames": ["Hoh", "NomOne", "NomTwo", "Holder", "Rival"]}
    b.update(kw)
    return b


N16 = '"Locked in. Houseguests - take your spots." The yard moves. Sixteen bodies climb onto the platform, sixteen sets of hands find the wall, and the rope line goes taut.'
# detector -> (canonical phrase, the board that makes the claim a phantom)
PHRASES = {
    "N-16": (N16, _base(phase="hoh-competition", compNotDue=True)),
    "N-15": ("You cast your vote and step back out into the hallway.", _base(phase="eviction", pending="eviction-vote")),
    "N-3": ("Nothing's been announced - the Head of Household competition hasn't happened yet.", _base(phase="nominations")),
    "N-1": ("Rival gets there first and the bell rings.", _base()),
    "A-9": ("Contestant Alpha goes out first, laughing it off. The competition went to somebody else entirely.", _base(phase="hoh-competition", pending="comp-round", compSig="npc:1,npc:2,npc:3")),
    "F-3": ("You step up to the pedestal and take your place in the veto competition.", _base(phase="veto-competition", vetoFieldIds=["npc:1", "npc:2", "npc:3"], vetoFieldNames=["A", "B", "C"])),
    "tally": ("The votes are read: 5 to 3 to evict NomOne.", _base()),
    "expulsion": ("You're being removed from the game, effective immediately.", _base()),
    "self-crown": ("The feeds swing to you - you won HOH! Everyone erupts.", _base(phase="hoh-competition")),
}
# (gate, sentence, scene, draft, post). True = caught there.
ALL = (True, True, True, True, True)
EXPECTED = {name: ALL for name in PHRASES}
# N-16 is the one deliberate exception, and only in two cells: it carries NO closed-set OUTCOME claim (so the cheap outcome gate is False by design) and it needs >= 2 distinct start-cue families across the
# narration (so no single streamed SENTENCE can be judged). It is caught at the scene level, in the grounded draft, and post-turn.
EXPECTED["N-16"] = (False, False, True, True, True)


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _clean():
    for d in (ch._LAST_BEAT_SIG, ch._DESYNC_REGROUND):
        d.pop(USER, None)
    yield
    for d in (ch._LAST_BEAT_SIG, ch._DESYNC_REGROUND):
        d.pop(USER, None)


def _cells(monkeypatch, text, sig):
    async def cap(user=None):
        return dict(sig)
    monkeypatch.setattr(ch, "_capture_beat_signature", cap)

    def arm():
        ch._LAST_BEAT_SIG[USER] = dict(sig)
        ch._DESYNC_REGROUND.pop(USER, None)

    gate = ch._sentence_has_closed_set_claim(text)
    arm()
    sentence = gate and (_run(ch.screen_streamed_outcome(USER, text)) is False)
    arm()
    scene = _run(ch.screen_streamed_scene_break(USER, text)) is not None
    arm()
    draft = bool(_run(ch._detect_ungrounded_overclaim(USER, text, set()))[0])
    arm()
    _run(ch.record_post_turn_desync_check(USER, text, True))
    post = USER in ch._DESYNC_REGROUND
    return (gate, sentence, scene, draft, post)


@pytest.mark.parametrize("name", sorted(PHRASES))
def test_each_detector_is_caught_exactly_where_the_table_says(monkeypatch, name):
    text, sig = PHRASES[name]
    assert ch._narration_claims_outcome(text, sig, sig), f"{name}: the canonical phrase must trip the detector itself"
    got = _cells(monkeypatch, text, sig)
    assert got == EXPECTED[name], f"{name}: (gate, sentence, scene, draft, post) = {got}, intended {EXPECTED[name]}"


def test_a_board_that_backs_the_claim_is_caught_nowhere_but_the_gate(monkeypatch):
    """The other way round: the same N-16 prose when the competition IS due is never cut (the live read decides), at any entry point."""
    text, _ = PHRASES["N-16"]
    due = _base(phase="hoh-competition", compNotDue=False)
    got = _cells(monkeypatch, text, due)
    assert got[2:] == (False, False, False), got


def test_the_table_covers_every_detector_named_in_the_spec():
    assert {"N-16", "N-15", "N-3", "N-1", "A-9", "F-3", "tally", "expulsion", "self-crown"} <= set(PHRASES)
