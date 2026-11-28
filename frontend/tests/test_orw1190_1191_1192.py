"""ORW-1190 / 1191 / 1192 (audit A10 round 6): the claim check reads the engine's standing state; a pair word keeps the model's pair; ordinary words are not houseguest names.
Synthetic role sentences only (no player chat, no cast text)."""
import pytest

from src import claim_commit as cc
from src import plan_commit as pc

OWNER = "a10fx-owner"


@pytest.fixture(autouse=True)
def _clean():
    cc.end_turn(OWNER)
    cc.reset_stats()
    yield
    cc.end_turn(OWNER)


# ── ORW-1190 ───────────────────────────────────────────────────────────────────────────────────────
NEGATIVE = [
    "You made a deal with Kai on day two, and it still holds.",
    "You joined the alliance last week and have kept your word since.",
    "The alliance was formed in week one and has held through two evictions.",
    "You took the double in Barrel on the first night, and it is still yours.",
    "You shook on the deal at breakfast, and Valerie has not mentioned it since.",
    "You and Kai sealed the pact two nights ago, and the memory makes you smile.",
    "A deal was struck in the kitchen this morning between Jace and Scott.",
    "The bed that is yours sits by the window.",
    "You settled into the squad's usual corner and the squad shuffles over.",
    "You grabbed a bed earlier and then went to the pool.",
    "You agreed to a deal earlier and she keeps bringing it up.",
    "It's a deal, Jace says, and shakes your hand.",
    "You made a promise to yourself to stay out of the drama.",
    "You take a bunk bed from the storage room and carry it out.",
    "You pick a bed sheet from the pile and fold it.",
    "You form a crew of two in the kitchen for the dish rota.",
    "Welcome to the core of the house, Jace says, spreading his arms.",
    "You choose a double espresso and settle in.",
    "You close a deal with the dishwasher and it finally runs.",
    "You cut a deal for the last slice of toast.",
]
POSITIVE = [("You seal the alliance with a handshake.", cc.CLAIM_ALLIANCE), ("You strike a deal with Rowan over the counter.", cc.CLAIM_DEAL),
            ("You claim the double by the window.", cc.CLAIM_BED), ("You grab the bunk by the window.", cc.CLAIM_BED), ("The alliance is sealed.", cc.CLAIM_ALLIANCE)]


@pytest.mark.parametrize("line", NEGATIVE)
def test_back_references_and_non_game_lines_claim_nothing(line):
    assert cc.extract_claims(line) == [], line


@pytest.mark.parametrize("line,kind", POSITIVE)
def test_true_new_claims_still_extracted(line, kind):
    assert kind in {c.kind for c in cc.extract_claims(line)}, line
    assert [k for k, _ in cc.claim_conflicts(line, {}, OWNER)] == [kind]


def test_standing_state_backs_a_reference_to_a_committed_thing():
    alliance = {"alliances": [{"name": "The Late Table", "members": [{"id": "npc:1", "name": "A"}, {"id": "player", "name": "P"}]}]}
    assert cc.claim_conflicts("You seal the alliance with a handshake.", alliance, OWNER) == []
    assert cc.claim_conflicts("You seal the alliance with a handshake.", {"alliances": [{"name": "X", "members": [{"id": "npc:1"}]}]}, OWNER) != []
    assert cc.claim_conflicts("You strike a deal with Rowan over the counter.", {"deals": [{"id": "d1", "status": "open"}]}, OWNER) == []
    assert cc.claim_conflicts("You strike a deal with Rowan over the counter.", {"deals": [{"id": "d1", "status": "broken"}]}, OWNER) != []
    assert cc.claim_conflicts("You claim the double by the window.", {"whereabouts": {"playerBed": True}}, OWNER) == []
    assert cc.claim_conflicts("You claim the double by the window.", {"whereabouts": {}}, OWNER) != []


def test_new_claim_with_no_commit_and_no_record_is_unbacked_and_a_commit_backs_it():
    assert cc.claim_conflicts("You seal the alliance.", {"alliances": []}, OWNER) != []
    cc.note_event(OWNER, {"tool": "formAlliance", "exit_code": 0})
    assert cc.claim_conflicts("You seal the alliance.", {"alliances": []}, OWNER) == []


# ── ORW-1191 / 1192 ────────────────────────────────────────────────────────────────────────────────
ROOMS = ["kitchen", "living-room", "backyard"]
P3 = [{"id": "npc:1", "name": "Kai Moreno"}, {"id": "npc:2", "name": "Dana Lin"}, {"id": "npc:3", "name": "Ellis Ward"}, {"id": "npc:4", "name": "Rowan Fox"}]


def view(n, **kw):
    people = P3[:n]
    v = {"present": people, "awake": [p["id"] for p in people], "asleep": [], "known": P3, "rooms": ROOMS, "room_names": None, "here": "kitchen",
         "prev": "", "lock": None, "talk_ask": None, "last_partner": None, "last_speaker": None}
    v.update(kw)
    return v


def obj(ids, kind="conflict"):
    return {"act": "talk", "scene": {"withIds": ids, "kind": kind, "content": "The player spoke.", "feltMinutes": 30}, "moves": []}


PAIR_LINES = ["You two need to stop arguing, it is wearing on everyone.", "Both of you, listen, I am not voting for either of you.", "You both owe me an apology for the way you talked about me."]


@pytest.mark.parametrize("n", [3, 4])
@pytest.mark.parametrize("line", PAIR_LINES)
def test_pair_word_keeps_the_models_pair_never_a_third(n, line):
    v = pc.validate(obj(["npc:1", "npc:2"]), line, view(n))
    assert v["scene"] and sorted(v["scene"]["withIds"]) == ["npc:1", "npc:2"], v


def test_pair_word_with_two_present_and_no_model_pair_takes_the_two_and_with_three_commits_nothing():
    assert sorted(pc.validate(obj(["npc:1"]), "You two stop it", view(2))["scene"]["withIds"]) == ["npc:1", "npc:2"]
    v = pc.validate(obj(["npc:1"]), "You two stop it", view(3))
    assert v["scene"] is None and "unnamed-ambiguous" in v["codes"]


@pytest.mark.parametrize("n", [3, 4])
@pytest.mark.parametrize("line", ["I tell everyone I am done.", "All of you, hear me out.", "Everyone, I think we should vote the same way."])
def test_whole_room_words_still_commit_everyone_present(n, line):
    v = pc.validate(obj(["npc:1"]), line, view(n))
    assert len(v["scene"]["withIds"]) == n and "group-broadcast" in v["codes"]


def test_guys_is_whole_room_unless_the_model_names_a_subset():
    assert len(pc.validate(obj(["npc:1"]), "Okay guys, I need to tell you something", view(3))["scene"]["withIds"]) == 3
    assert sorted(pc.validate(obj(["npc:1", "npc:2"]), "You guys, stop it", view(3))["scene"]["withIds"]) == ["npc:1", "npc:2"]
    assert len(pc.validate(obj(["npc:1", "npc:2", "npc:3"]), "Okay guys, listen", view(3))["scene"]["withIds"]) == 3


HOPE = [{"id": "npc:1", "name": "Kai Moreno"}, {"id": "npc:2", "name": "Grace Lin"}, {"id": "npc:3", "name": "Hope Ellis"}, {"id": "npc:4", "name": "Chase Ward"}]
WORD_LINES = ["I hope you are not mad at me about the vote, I will make it right", "Grace under pressure, that is you, tell me what you think we should do",
              "I chase the thought around but I keep coming back to the vote, what do you think"]


@pytest.mark.parametrize("line", WORD_LINES)
def test_ordinary_words_are_not_names_and_the_lock_partner_scene_commits(line):
    assert pc.named_ids(line, HOPE) == []
    v = view(1, lock="npc:1", known=HOPE, present=HOPE[:1])
    r = pc.validate(obj(["npc:1"], "strategy"), line, v)
    assert r["scene"] and r["scene"]["withIds"] == ["npc:1"] and "not-named" not in r["codes"], r


@pytest.mark.parametrize("line", ["I hope you are not mad", "Grace under pressure, that is you"])
def test_lock_partner_is_the_addressee_with_several_awake(line):
    v = view(3, lock="npc:1", known=HOPE + P3[2:3], present=HOPE[:1] + P3[1:3], awake=["npc:1", "npc:5", "npc:6"])
    r = pc.validate(obj(["npc:1"]), line, {**v, "known": HOPE + [{"id": "npc:5", "name": "Lee Park"}, {"id": "npc:6", "name": "Moe Lamb"}],
                                           "present": [HOPE[0], {"id": "npc:5", "name": "Lee Park"}, {"id": "npc:6", "name": "Moe Lamb"}]})
    assert r["scene"]["withIds"] == ["npc:1"] and "partner:lock" in r["codes"], r


@pytest.mark.parametrize("line", ["Hope, I need to ask you something", "I need to ask Hope something", "Hey Hope?", "tell hope I said hi", "Can you tell Hope"])
def test_a_real_address_of_a_common_word_name_still_resolves(line):
    assert pc.named_ids(line, HOPE) == ["npc:3"], line


def test_full_name_and_ordinary_names_still_resolve():
    assert pc.named_ids("I ask hope ellis about it", HOPE) == ["npc:3"]
    assert pc.named_ids("what do you think dana", P3) == ["npc:2"]
    assert pc.named_ids("Kai, come here", P3) == ["npc:1"]
