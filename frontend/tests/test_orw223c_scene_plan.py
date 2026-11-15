"""ORW-223 part C / C1 - the scene-plan schema and the pure checker. No model, roles only (npc-a, room-1...)."""
import copy
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src import orwell_scene_plan as sp  # noqa: E402

VIEW = {
    "present": ["npc-a", "npc-b", "npc-c"], "awake": ["npc-a", "npc-b"], "asleep": ["npc-c", "npc-z"],
    "known_ids": ["npc-a", "npc-b", "npc-c", "npc-d", "npc-z"], "rooms": ["room-1", "room-2"],
    "pending": None, "phase": "pre-nominations", "time_of_day": "evening", "surfaced_facts": ["fact-1"],
}


def view(**kw):
    v = copy.deepcopy(VIEW)
    v.update(kw)
    return v


def plan(**kw):
    p = {"participants": ["npc-a", "npc-b"], "act": "talk", "effects": [], "note": "a quiet chat"}
    p.update(kw)
    return p


def codes(v):
    return [r["code"] for r in v.rejections]


def good_effects():
    return [
        {"type": "record", "withIds": ["npc-a", "npc-b"], "kind": "bonding",
         "consequence": {"edges": [{"toward": "npc-a", "direction": "warmer", "emphasis": "slight"}],
                         "aboutEdges": [{"holder": "npc-b", "about": "npc-d", "direction": "more-threatened"}],
                         "rationale": "shared a laugh"}},
        {"type": "move", "who": "player", "room": "room-2"},
        {"type": "deal-offer", "with": "npc-a", "kind": "safety", "terms": "keep each other safe"},
        {"type": "disclosure", "from": "npc-b", "factId": "fact-1"},
    ]


# ---- valid plan passes untouched
def test_valid_plan_passes_untouched():
    p = plan(effects=good_effects())
    v = sp.check_plan(p, VIEW)
    assert v.rejections == [] and v.plan_trimmed == p


def test_input_not_mutated():
    p = plan(participants=["npc-a", "npc-c", "ghost"], effects=good_effects() + [{"type": "x"}])
    before = copy.deepcopy(p)
    sp.check_plan(p, VIEW)
    assert p == before


# ---- participants
def test_participant_absent_and_control():
    v = sp.check_plan(plan(participants=["npc-a", "npc-d"]), VIEW)
    assert codes(v) == ["participant-absent"] and v.plan_trimmed["participants"] == ["npc-a"]
    assert sp.check_plan(plan(participants=["npc-a"]), VIEW).rejections == []


def test_participant_asleep_and_control():
    v = sp.check_plan(plan(participants=["npc-a", "npc-c"]), VIEW)
    assert codes(v) == ["participant-asleep"] and v.plan_trimmed["participants"] == ["npc-a"]
    # asleep list wins even if the id is not in `present`
    assert codes(sp.check_plan(plan(participants=["npc-z"]), VIEW)) == ["participant-asleep"]
    # awake control
    assert sp.check_plan(plan(participants=["npc-b"]), VIEW).rejections == []


def test_unknown_id_participant_and_control():
    v = sp.check_plan(plan(participants=["npc-a", "ghost"]), VIEW)
    assert codes(v) == ["unknown-id"] and v.plan_trimmed["participants"] == ["npc-a"]
    assert sp.check_plan(plan(participants=["player", "npc-a"]), VIEW).rejections == []


def test_unknown_id_in_effects_and_control():
    e = {"type": "record", "withIds": ["npc-a", "ghost"], "kind": "bonding"}
    v = sp.check_plan(plan(effects=[e]), VIEW)
    assert "unknown-id" in codes(v) and v.plan_trimmed["effects"] == []
    e2 = {"type": "record", "withIds": ["npc-a"], "kind": "bonding",
          "consequence": {"aboutEdges": [{"holder": "npc-a", "about": "ghost", "direction": "cooler"}]}}
    v = sp.check_plan(plan(effects=[e2]), VIEW)
    assert codes(v) == ["unknown-id"] and "consequence" not in v.plan_trimmed["effects"][0]


# ---- effects
def test_effect_kind_and_control():
    v = sp.check_plan(plan(effects=[{"type": "nominate", "who": "npc-a"}]), VIEW)
    assert codes(v) == ["effect-kind"] and v.plan_trimmed["effects"] == []
    assert sp.check_plan(plan(effects=[good_effects()[1]]), VIEW).rejections == []


def test_effect_outside_scene_and_control():
    p = plan(participants=["npc-a"], effects=[{"type": "record", "withIds": ["npc-a", "npc-b"], "kind": "bonding"}])
    v = sp.check_plan(p, VIEW)
    assert codes(v) == ["effect-outside-scene"] and v.plan_trimmed["effects"] == []
    p2 = plan(participants=["npc-a"], effects=[{"type": "record", "withIds": ["npc-a"], "kind": "bonding"}])
    assert sp.check_plan(p2, VIEW).rejections == []
    # a deal with someone outside the scene
    v = sp.check_plan(plan(participants=["npc-a"], effects=[{"type": "deal-offer", "with": "npc-b", "kind": "vote"}]), VIEW)
    assert codes(v) == ["effect-outside-scene"]


def test_unknown_room_and_control():
    v = sp.check_plan(plan(effects=[{"type": "move", "who": "npc-a", "room": "nowhere"}]), VIEW)
    assert codes(v) == ["unknown-room"] and v.plan_trimmed["effects"] == []
    assert sp.check_plan(plan(effects=[{"type": "move", "who": "npc-a", "room": "room-2"}]), VIEW).rejections == []


def test_move_adjacency_is_not_checked_here():
    # any known room passes: the engine stays the final authority at commit
    far = view(rooms=["room-1", "room-9"])
    assert sp.check_plan(plan(effects=[{"type": "move", "who": "npc-b", "room": "room-9"}]), far).rejections == []


def test_deal_kind_and_sleeping_counterpart():
    v = sp.check_plan(plan(effects=[{"type": "deal-offer", "with": "npc-a", "kind": "marriage"}]), VIEW)
    assert codes(v) == ["deal-kind"] and v.plan_trimmed["effects"] == []
    v = sp.check_plan(plan(participants=["npc-a", "npc-c"], effects=[{"type": "deal-offer", "with": "npc-c", "kind": "vote"}]), VIEW)
    assert "participant-asleep" in codes(v) and v.plan_trimmed["effects"] == []
    assert sp.check_plan(plan(effects=[{"type": "deal-offer", "with": "npc-b", "kind": "vote"}]), VIEW).rejections == []


def test_record_kind():
    v = sp.check_plan(plan(effects=[{"type": "record", "withIds": ["npc-a"], "kind": "flirting"}]), VIEW)
    assert codes(v) == ["record-kind"]


def test_disclosure_not_rolled_and_control():
    v = sp.check_plan(plan(effects=[{"type": "disclosure", "from": "npc-a", "factId": "fact-9"}]), VIEW)
    assert codes(v) == ["disclosure-not-rolled"] and v.plan_trimmed["effects"] == []
    assert sp.check_plan(plan(effects=[{"type": "disclosure", "from": "npc-a", "factId": "fact-1"}]), VIEW).rejections == []
    assert codes(sp.check_plan(plan(effects=[{"type": "disclosure", "from": "npc-a", "factId": "fact-1"}]),
                               view(surfaced_facts=[]))) == ["disclosure-not-rolled"]


# ---- closed-set claims
def test_closed_set_claim_in_effects_and_note():
    v = sp.check_plan(plan(effects=[{"type": "deal-offer", "with": "npc-a", "kind": "vote", "terms": "she was nominated"}]), VIEW)
    assert codes(v) == ["closed-set-claim"] and v.plan_trimmed["effects"] == []
    e = {"type": "record", "withIds": ["npc-a"], "kind": "strategy", "consequence": {"rationale": "npc-b got evicted"}}
    v = sp.check_plan(plan(effects=[e]), VIEW)
    assert codes(v) == ["closed-set-claim"] and "consequence" not in v.plan_trimmed["effects"][0]
    v = sp.check_plan(plan(note="the HOH nominated npc-a"), VIEW)
    assert codes(v) == ["closed-set-claim"] and "note" not in v.plan_trimmed


def test_closed_set_word_list_decision():
    fires = ["She won the HOH", "he wins the veto", "won the competition", "who won the power of veto",
             "Nominated again", "was evicted", "they voted to evict her", "vetoed it", "the winner is npc-a"]
    quiet = ["won the argument", "won her over", "she won", "wins the room", "a nomination speech is coming",
             "the eviction fear is in the air", "a vote of confidence", "veto power talk", "vetoes nothing"]
    for t in fires:
        assert sp.states_closed_set_outcome(t), t
    for t in quiet:
        assert not sp.states_closed_set_outcome(t), t


# ---- act gates
def test_go_to_bed_with_pending_keeps_act_drops_effects():
    p = plan(act="go-to-bed", effects=[good_effects()[1]])
    v = sp.check_plan(p, view(pending="nominations"))
    assert codes(v) == ["pending-blocks-effects"]
    assert v.plan_trimmed["act"] == "go-to-bed" and v.plan_trimmed["effects"] == []
    assert sp.check_plan(p, VIEW).rejections == []  # control: no pending


def test_ooc_has_no_effects():
    v = sp.check_plan(plan(act="ooc", effects=[good_effects()[1]]), VIEW)
    assert codes(v) == ["ooc-no-effects"] and v.plan_trimmed["effects"] == []
    assert sp.check_plan(plan(act="ooc"), VIEW).rejections == []


def test_plan_shape_rejection():
    for bad in (None, [], {"participants": "x", "act": "talk"}, {"participants": [], "act": "dance"}):
        v = sp.check_plan(bad, VIEW)
        assert v.plan_trimmed is None and codes(v) == ["plan-shape"]


# ---- subset / determinism / purity over a seeded corpus
def _subset(out, inp):
    if isinstance(out, dict):
        return isinstance(inp, dict) and all(k in inp and _subset(v, inp[k]) for k, v in out.items())
    if isinstance(out, list):
        if not isinstance(inp, list):
            return False
        j = 0
        for o in out:  # ordered subsequence
            while j < len(inp) and not _subset(o, inp[j]):
                j += 1
            if j == len(inp):
                return False
            j += 1
        return True
    if isinstance(out, str):
        return isinstance(inp, str) and " ".join(out.split()) in " ".join(inp.split())
    return out == inp


def _rand_plan(r):
    ids = ["npc-a", "npc-b", "npc-c", "npc-d", "npc-z", "ghost", "player"]
    rooms = ["room-1", "room-2", "nowhere"]
    texts = ["a chat", "she won the HOH", "plain talk", "nominated", "x" * 300, "  spaced  out  "]

    def eff():
        t = r.choice(["record", "move", "deal-offer", "disclosure", "bogus", "record"])
        if t == "record":
            e = {"type": t, "withIds": r.sample(ids, r.randint(0, 4)), "kind": r.choice(list(sp.RECORD_KINDS) + ["bad"])}
            if r.random() < .6:
                e["consequence"] = {"edges": [{"toward": r.choice(ids), "direction": r.choice(sp.DIRECTIONS)}],
                                    "aboutEdges": [{"holder": r.choice(ids), "about": r.choice(ids), "direction": "cooler"}],
                                    "rationale": r.choice(texts)}
            return e
        if t == "move":
            return {"type": t, "who": r.choice(ids), "room": r.choice(rooms)}
        if t == "deal-offer":
            return {"type": t, "with": r.choice(ids), "kind": r.choice(list(sp.DEAL_KINDS) + ["bad"]), "terms": r.choice(texts)}
        if t == "disclosure":
            return {"type": t, "from": r.choice(ids), "factId": r.choice(["fact-1", "fact-9"])}
        return {"type": t, "junk": 1}

    p = {"participants": r.sample(ids, r.randint(0, 5)), "act": r.choice(list(sp.ACTS)),
         "effects": [eff() for _ in range(r.randint(0, 5))], "extra": "dropped"}
    if r.random() < .7:
        p["note"] = r.choice(texts)
    return p


def test_subset_determinism_no_mutation_corpus():
    r = random.Random(223)
    for n in range(500):
        p = _rand_plan(r)
        v = view(pending=r.choice([None, "nominations"]))
        before_p, before_v = copy.deepcopy(p), copy.deepcopy(v)
        a, b = sp.check_plan(p, v), sp.check_plan(p, v)
        assert p == before_p and v == before_v
        assert a == b, n
        if a.plan_trimmed is not None:
            assert _subset(a.plan_trimmed, p), (n, p, a.plan_trimmed)
            assert set(a.plan_trimmed) <= {"participants", "act", "effects", "note"}
            # idempotent: re-checking a trimmed plan rejects nothing
            again = sp.check_plan(a.plan_trimmed, v)
            assert again.rejections == [] and again.plan_trimmed == a.plan_trimmed, n
        for rj in a.rejections:
            assert set(rj) == {"code", "path", "detail"}


# ---- parse_plan
RAW = {"participants": ["npc-a"], "act": "talk", "effects": [{"type": "move", "who": "player", "room": "room-1"}]}


def test_parse_messy_replies():
    js = json.dumps(RAW)
    for reply in (js, f"Let me think {{about}} this.\n{js}", f"```json\n{js}\n```", f"{js}\nHope that helps {{!}}",
                  f'{{"participants":["x"],"act":"talk","effects":[]}} then {js}'):
        p, probs = sp.parse_plan(reply)
        assert p is not None and p["participants"] == ["npc-a"], reply
    p, _ = sp.parse_plan(f'{js} and {json.dumps(dict(RAW, participants=["npc-b"]))}')
    assert p["participants"] == ["npc-b"]  # two objects -> the last
    for bad in ("no json here", "", None, 5, "{not json}", '{"act": "talk"}', '{"participants": [], "act": "bogus"}'):
        assert sp.parse_plan(bad)[0] is None
    assert sp.parse_plan({"participants": ["a"], "act": "talk", "effects": []})[0] is not None


def test_parse_tolerates_braces_in_strings_and_clips():
    reply = json.dumps({"participants": ["npc-a"], "act": "talk", "effects": [], "note": "a } brace { inside " + "y" * 400,
                        "bogus": 1})
    p, _ = sp.parse_plan(reply)
    assert len(p["note"]) <= sp.NOTE_MAX and "bogus" not in p


def test_parse_drops_bad_effects_with_problem():
    p, probs = sp.parse_plan({"participants": [], "act": "talk", "effects": [5, {"type": "move", "who": "player"}, RAW["effects"][0]]})
    assert len(p["effects"]) == 1 and len(probs) == 2


# ---- schema <-> validator sync
def _conforms(inst, sch):
    if "oneOf" in sch:
        return sum(_conforms(inst, s) for s in sch["oneOf"]) == 1
    if "const" in sch:
        return inst == sch["const"]
    if "enum" in sch:
        return inst in sch["enum"]
    t = sch.get("type")
    if t == "string":
        return isinstance(inst, str) and len(inst) <= sch.get("maxLength", 10**9)
    if t == "array":
        return isinstance(inst, list) and len(inst) <= sch.get("maxItems", 10**9) and all(_conforms(i, sch["items"]) for i in inst)
    if t == "object":
        if not isinstance(inst, dict) or not all(k in inst for k in sch.get("required", [])):
            return False
        props = sch["properties"]
        if sch.get("additionalProperties") is False and not set(inst) <= set(props):
            return False
        return all(_conforms(v, props[k]) for k, v in inst.items() if k in props)
    return False


def test_schema_in_sync_with_validator():
    sch = sp.plan_to_json_schema()
    assert sch["properties"]["act"]["enum"] == list(sp.ACTS)
    assert set(sch["properties"]) == {"participants", "act", "effects", "note"}
    assert set(sch["required"]) == {"participants", "act", "effects"}
    types = [o["properties"]["type"]["const"] for o in sch["properties"]["effects"]["items"]["oneOf"]]
    assert tuple(types) == sp.EFFECT_TYPES
    json.dumps(sch)
    # everything the validator keeps for a known-type plan conforms to the schema
    full = plan(effects=good_effects())
    assert _conforms(full, sch)
    n, _ = sp.normalize_plan(full)
    assert n == full and _conforms(n, sch)
    r = random.Random(7)
    for _ in range(300):
        n, _ = sp.normalize_plan(_rand_plan(r))
        if n is None or any(e["type"] not in sp.EFFECT_TYPES for e in n["effects"]):
            continue
        if any(e["type"] == "record" and e.get("kind") not in (None, *sp.RECORD_KINDS) for e in n["effects"]):
            continue
        if any(e["type"] == "deal-offer" and e["kind"] not in sp.DEAL_KINDS for e in n["effects"]):
            continue
        assert _conforms(n, sch), n
    # negatives the schema must refuse
    for bad in (dict(full, act="dance"), dict(full, extra=1), {"participants": [], "act": "talk"},
                plan(effects=[{"type": "nominate"}]), plan(effects=[{"type": "move", "who": "a"}])):
        assert not _conforms(bad, sch)
