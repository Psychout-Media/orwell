"""ORW-1156 part 1: no claim without commit. Synthetic role sentences only (no player chat, no cast text)."""
import pytest

from src import claim_commit as cc
from src import predisplay_check as pc

OWNER = "claim-owner"
NIGHT = {"timeOfDay": "night", "whereabouts": {"room": "bedroom-a", "roomNames": {}, "present": []}}
MORNING = {"timeOfDay": "morning", "whereabouts": {"room": "bedroom-a", "roomNames": {}, "present": []}}


@pytest.fixture(autouse=True)
def _clean():
    cc.end_turn(OWNER)
    cc.reset_stats()
    yield
    cc.end_turn(OWNER)


SLEEP_LINES = ["You finally drift off to sleep.", "You turn in for the night and the house goes quiet.", "You climb into bed and close your eyes.",
               "Sleep takes you before the lamp is off.", "You fall asleep to the hum of the fridge."]
BED_LINES = ["You claim the single bed by the window.", "You grab the bunk by the window.", "The bed is yours now."]
ALLIANCE_LINES = ["You shake on it: the alliance is formed.", "The alliance is sealed and you are part of it.", "Welcome to the alliance."]
DEAL_LINES = ["You strike a deal with Rowan over the kitchen counter.", "The deal is struck."]
NO_CLAIM = ["You could go to bed soon.", "Would you like to turn in for the night?", "She says she will claim the bed tomorrow.", "You don't claim the bed.",
            '"You fall asleep fast," she teases.', "Rowan pitches an alliance, and waits for your answer.", "You are tired and your eyes are heavy.",
            "You wonder whether the deal is still on the table.", "You asked if the alliance was real."]


@pytest.mark.parametrize("line,kind", [(l, cc.CLAIM_SLEEP) for l in SLEEP_LINES] + [(l, cc.CLAIM_BED) for l in BED_LINES]
                         + [(l, cc.CLAIM_ALLIANCE) for l in ALLIANCE_LINES] + [(l, cc.CLAIM_DEAL) for l in DEAL_LINES])
def test_claims_are_extracted(line, kind):
    assert kind in {c.kind for c in cc.extract_claims(line)}, line


@pytest.mark.parametrize("line", NO_CLAIM)
def test_non_claims_claim_nothing(line):
    assert cc.extract_claims(line) == [], line


def test_a_sleep_claim_with_no_commit_is_a_conflict_through_predisplay():
    facts = pc.find_conflicts("You finally drift off to sleep.", NIGHT, zero_clocks=False, owner=OWNER)
    assert cc.CLAIM_SLEEP in facts


def test_a_sleep_claim_with_a_commit_is_clean():
    cc.note_event(OWNER, {"tool": "turnIn", "exit_code": 0, "output": ""})
    assert pc.find_conflicts("You finally drift off to sleep.", MORNING, zero_clocks=False, owner=OWNER) == []


def test_a_held_turnin_is_not_a_commit():
    cc.note_event(OWNER, {"tool": "turnIn", "exit_code": 0, "engine_result": '{"held": true}'})
    assert cc.CLAIM_SLEEP in pc.find_conflicts("You fall asleep.", NIGHT, zero_clocks=False, owner=OWNER)


def test_a_turnin_that_left_the_clock_at_night_is_not_a_commit():
    cc.note_event(OWNER, {"tool": "turnIn", "exit_code": 0, "output": ""})
    assert cc.CLAIM_SLEEP in pc.find_conflicts("You fall asleep.", NIGHT, zero_clocks=False, owner=OWNER)


def test_commit_list_notes_appends_like_a_list():
    ev = cc.CommitList(OWNER)
    ev.append({"tool": "claimBed", "exit_code": 0})
    assert len(ev) == 1 and cc.committed(OWNER, ("claimBed",))
    assert pc.find_conflicts("You claim the single bed.", NIGHT, zero_clocks=False, owner=OWNER) == []


def test_alliance_and_deal_claims_need_their_own_tool():
    assert cc.CLAIM_ALLIANCE in pc.find_conflicts("The alliance is sealed.", NIGHT, zero_clocks=False, owner=OWNER)
    cc.note_event(OWNER, {"tool": "makeDeal", "exit_code": 0})
    assert cc.CLAIM_ALLIANCE in pc.find_conflicts("The alliance is sealed.", NIGHT, zero_clocks=False, owner=OWNER)
    cc.note_event(OWNER, {"tool": "formAlliance", "exit_code": 0})
    assert pc.find_conflicts("The alliance is sealed.", NIGHT, zero_clocks=False, owner=OWNER) == []


def test_no_owner_means_no_claim_check():
    assert pc.find_conflicts("You finally drift off to sleep.", NIGHT, zero_clocks=False) == []


# ── committing what the player asked for ─────────────────────────────────────────────────────────────────────────────
def _plan(user, facts, **kw):
    return cc.commit_plan([pc.Conflict(f, "") for f in facts], user, rooms=("bedroom-a", "bedroom-b", "kitchen"), here=kw.pop("here", "kitchen"), **kw)


def test_plain_sleep_request_commits_turn_in():
    assert _plan("I go to bed.", [cc.CLAIM_SLEEP]) == [("turnIn", {})]
    assert _plan("I'm going to sleep now.", [cc.CLAIM_SLEEP]) == [("turnIn", {})]


@pytest.mark.parametrize("user", ["Should I go to bed?", "I won't go to bed yet.", "If I go to bed, will Rowan stay?", "Tell Rowan about the plan.", ""])
def test_no_ask_no_commit(user):
    assert _plan(user, [cc.CLAIM_SLEEP]) == []


def test_player_never_asked_means_no_commit_even_with_sleep_words_elsewhere():
    assert _plan("Rowan says good night to everyone.", [cc.CLAIM_SLEEP]) == []


def test_alliance_and_deal_are_never_committed():
    for u in ("I agree, we have an alliance.", "Yes, deal."):
        assert _plan(u, [cc.CLAIM_ALLIANCE, cc.CLAIM_DEAL]) == []


def test_bed_ask_commits_claim_bed_in_the_named_room_here():
    plan = _plan("I claim a single bed in here.", [cc.CLAIM_BED], here="bedroom-a")
    assert plan == [("claimBed", {"room": "bedroom-a", "kind": "single"})]


def test_move_claim_commits_only_a_grounded_room():
    assert _plan("I go to the kitchen.", ["player-room"], here="bedroom-a", claimed_room_id="kitchen") == [("moveTo", {"room": "kitchen"})]
    assert _plan("I stay here.", ["player-room"], here="bedroom-a", claimed_room_id="kitchen") == []


def test_stats_count_checked_backed_unbacked_and_regenerate():
    cc.tally_chunk("You fall asleep.", NIGHT, OWNER)
    s = cc.stats()
    assert s["byKind"]["claim-sleep"]["checked"] == 1 and s["byKind"]["claim-sleep"]["unbacked"] == 1
    cc.note("claim-sleep", "regenerated")
    assert cc.stats()["unbackedShown"] == 0
    assert "claimCommit" in pc.stats_snapshot()


def test_split_withholds_an_unbacked_sleep_claim(monkeypatch):
    from src import engine_read_cache
    monkeypatch.setattr(engine_read_cache, "peek", lambda *a, **k: NIGHT)
    sp = pc.split_at_first_conflict("The kettle clicks off. You finally drift off to sleep. The house goes quiet.", OWNER)
    assert sp is not None and sp.keep.strip() == "The kettle clicks off." and sp.conflicts[0].fact == cc.CLAIM_SLEEP
    assert "game has not" in pc._correction_line(sp.conflicts[0])
