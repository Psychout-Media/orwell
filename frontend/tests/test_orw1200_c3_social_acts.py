"""ORW-1200: C3 (ORW-1011) commits the player's own press to open up (confide) and the player's own promise before the narrator, on the same bar as the scene.
Invented names and synthetic lines only; no prod text."""
import asyncio
import importlib
import json

pc = importlib.import_module("src.plan_commit")
ledger = importlib.import_module("src.orwell_sync_ledger")
ROOMS = ["kitchen", "living-room", "backyard", "bedroom-a", "diary-room"]
CAST = [{"id": "npc:1", "name": "Dana Park"}, {"id": "npc:2", "name": "Levi Stone"}, {"id": "npc:3", "name": "Maeve Ortiz"}]


def view(present=("npc:1",), asleep=(), earshot_out=(), lock=None):
    people = [c for c in CAST if c["id"] in present]
    return {"present": people, "awake": [p["id"] for p in people if p["id"] not in asleep], "asleep": list(asleep), "known": CAST, "rooms": ROOMS,
            "room_names": None, "here": "living-room", "prev": None, "pending": None, "earshot_out": list(earshot_out), "lock": lock}


def plan(ids, press=None, pledge=None, kind="bonding"):
    return {"act": "talk", "scene": {"withIds": ids, "kind": kind, "content": "The player spoke with them.", "feltMinutes": 30}, "moves": [], "press": press, "pledge": pledge}


PRESS = "Dana, you can trust me. What is really going on with you?"


# ── commits that fail on main ─────────────────────────────────────────────────────────────────────
def test_a_press_in_a_one_on_one_is_committed():
    v = pc.validate(plan(["npc:1"], press="npc:1"), PRESS, view())
    assert v["scene"]["withIds"] == ["npc:1"] and v["confide"] == "npc:1"


def test_a_press_under_the_private_talk_lock_is_committed_with_others_in_the_room():
    v = pc.validate(plan(["npc:1"], press="npc:1"), PRESS, view(("npc:1", "npc:2"), lock="npc:1"))
    assert v["confide"] == "npc:1"


def test_a_press_with_the_only_other_houseguest_out_of_earshot_is_one_on_one():
    v = pc.validate(plan(["npc:1"], press="npc:1"), PRESS, view(("npc:1", "npc:2"), earshot_out=("npc:2",)))
    assert v["confide"] == "npc:1"


def test_the_players_typed_promise_rides_the_scene_record():
    v = pc.validate(plan(["npc:1"], pledge={"promise": {"what": "no-nominate"}}), "Dana, I promise I will never nominate you.", view())
    assert v["pledge"] == {"promise": {"what": "no-nominate"}} and v["scene"]["pledge"] == v["pledge"]


def test_the_players_assurance_rides_the_scene_record():
    v = pc.validate(plan(["npc:1"], pledge={"assurance": {"kind": "safe"}}), "Dana, you're safe with me this week.", view())
    assert v["pledge"] == {"assurance": {"kind": "safe"}}


def test_a_promise_about_a_named_third_houseguest_keeps_its_subject():
    v = pc.validate(plan(["npc:1"], pledge={"promise": {"what": "no-evict-vote", "subject": "npc:2"}}), "Dana, I will not vote Levi out, my word on it.", view(("npc:1",)))
    assert v["pledge"] == {"promise": {"what": "no-evict-vote", "subject": "npc:2"}}


def test_loop_half_stages_the_pledge_and_the_promise_backfill_stands_down(monkeypatch):
    from src import agent_loop as al
    from src import fold_ledger as fl
    staged, noted, events = [], [], []
    monkeypatch.setattr(fl, "stage_pending_fold", lambda owner, sid, **kw: staged.append(kw))
    pledge = {"promise": {"what": "no-nominate"}}
    pc.put_stash("u-pl", {"scene": {"withIds": ["npc:1"], "kind": "bonding", "content": "The player spoke with them.", "feltMinutes": 30, "pledge": pledge},
                          "moves": [], "names": {"npc:1": "Dana Park"}})
    note = pc.loop_half("u-pl", "s1", events, 1, lambda o, b, n=1: noted.append(b))
    assert staged[0]["promise"] == {"what": "no-nominate"} and staged[0]["assurance"] is None
    assert al._model_recorded_a_promise(events) is True  # ORW-860's back-fill sees the promise was recorded
    assert noted == ["plan-commit:recordInteraction"] and "promise" in note


def test_loop_half_records_the_confide_tells_the_narrator_and_counts_it_as_the_plan(monkeypatch):
    from src import fold_ledger as fl
    monkeypatch.setattr(fl, "stage_pending_fold", lambda owner, sid, **kw: None)
    noted, events = [], []
    pc.put_stash("u-cf", {"scene": {"withIds": ["npc:1"], "kind": "bonding", "content": "The player spoke with them.", "feltMinutes": 30}, "moves": [],
                          "names": {"npc:1": "Dana Park"}, "confide": {"id": "npc:1", "disclosed": True, "tier": "partial", "content": "A synthetic confidence line."}})
    note = pc.loop_half("u-cf", "s1", events, 1, lambda o, b, n=1: noted.append(b))
    assert [e["tool"] for e in events] == ["recordInteraction", "confide"] and all(e["exit_code"] == 0 for e in events)
    assert "plan-commit:confide" in noted
    assert "A synthetic confidence line." in note and "do not call confide again" in note and "truthful" not in note
    assert ledger.classify_driver(["recordInteraction", "confide"], {n: 1 for n in noted}) == "plan"


def test_commit_confide_strips_truth_and_never_confides_twice_for_the_same_message():
    pc.reset_confide_memo()
    calls = []

    class Eng:
        async def confide(self, npc, user=None, idempotency_key=None):
            calls.append((npc, idempotency_key))
            return {"disclosed": True, "tier": "full", "truthful": False, "content": "A synthetic confidence line.", "beatSeq": 7}
    r1 = asyncio.run(pc.commit_confide(Eng(), "u-memo", "npc:1", PRESS))
    r2 = asyncio.run(pc.commit_confide(Eng(), "u-memo", "npc:1", PRESS))
    assert r1 == r2 == {"id": "npc:1", "disclosed": True, "tier": "full", "content": "A synthetic confidence line."}
    assert len(calls) == 1 and calls[0][1]
    assert "truthful" not in json.dumps(r1)


def test_commit_confide_on_a_refusal_or_an_error_lands_nothing():
    pc.reset_confide_memo()

    class Refuses:
        async def confide(self, npc, user=None, idempotency_key=None):
            return {"error": "refused"}

    class Boom:
        async def confide(self, npc, user=None, idempotency_key=None):
            raise RuntimeError("down")
    assert asyncio.run(pc.commit_confide(Refuses(), "u-r", "npc:1", PRESS)) is None
    assert asyncio.run(pc.commit_confide(Boom(), "u-b", "npc:1", PRESS)) is None


def test_the_confide_belt_stands_down_when_a_confide_landed():
    import pathlib
    src = (pathlib.Path(__file__).resolve().parents[1] / "src" / "agent_loop.py").read_text()
    i = src.index('if "confide" in _tool_names:')
    assert src.index("_want_confide = (_turn_confide_nudges < 1") > i  # set before the regex gate and the ORW-1071 gate read the counter
    assert "_turn_confide_nudges = max(_turn_confide_nudges, 1)" in src[i:i + 200]


def test_c3_never_backs_a_deal_or_an_alliance_claim(monkeypatch):
    from src import claim_commit as cc
    from src import fold_ledger as fl
    monkeypatch.setattr(fl, "stage_pending_fold", lambda owner, sid, **kw: None)
    cc.end_turn("u-cc")
    events = cc.CommitList("u-cc")
    pc.put_stash("u-cc", {"scene": {"withIds": ["npc:1"], "kind": "alliance", "content": "The player spoke with them.", "feltMinutes": 30,
                                    "pledge": {"promise": {"what": "final-two"}}}, "moves": [], "names": {"npc:1": "Dana Park"},
                          "confide": {"id": "npc:1", "disclosed": False, "tier": "none"}})
    pc.loop_half("u-cc", "s1", events, 1, lambda *a, **k: None)
    assert cc.committed("u-cc", ("confide",)) and cc.committed("u-cc", ("recordInteraction",))
    assert not cc.committed("u-cc", ("makeDeal", "submitDecision", "formAlliance", "joinAlliance"))  # ORW-1156: only the player's yes commits those
    cc.end_turn("u-cc")


def test_the_prompt_carries_no_quoted_example_lines():
    assert "e.g." not in pc.SYSTEM and "such as" not in pc.SYSTEM
    assert '"press"' in pc.SYSTEM and '"pledge"' in pc.SYSTEM


# ── false-act guards: every row must commit NO press and NO pledge ───────────────────────────────
FALSE_PRESS = [
    ("group, no lock", plan(["npc:1"], press="npc:1"), PRESS, view(("npc:1", "npc:2", "npc:3"))),
    ("no press words", plan(["npc:1"], press="npc:1"), "Dana, how was the workout?", view()),
    ("press is not the scene", plan(["npc:1"], press="npc:2"), PRESS, view(("npc:1", "npc:2"), lock="npc:1")),
    ("two-person scene", plan(["npc:1", "npc:2"], press="npc:1"), "Dana and Levi, you can trust me, what is going on?", view(("npc:1", "npc:2"))),
    ("target out of earshot", plan(["npc:2"], press="npc:2"), "Levi, you can trust me, what is going on?", view(("npc:1", "npc:2"), earshot_out=("npc:2",))),
    ("target asleep", plan(["npc:1"], press="npc:1"), PRESS, view(asleep=("npc:1",))),
    ("target elsewhere", plan(["npc:2"], press="npc:2"), "Levi, you can trust me, what is going on?", view(("npc:1",))),
    ("invented id", plan(["npc:1"], press="npc:9"), PRESS, view()),
    ("no scene", {"act": "talk", "scene": None, "moves": [], "press": "npc:1"}, PRESS, view()),
    ("not a talk", {"act": "other", "scene": {"withIds": ["npc:1"], "kind": "bonding", "content": "x"}, "moves": [], "press": "npc:1"}, PRESS, view()),
]
FALSE_PLEDGE = [
    ("conditional", {"promise": {"what": "no-nominate"}}, "Dana, I promise I won't nominate you if you keep me safe.", view()),
    ("hedged", {"promise": {"what": "no-nominate"}}, "Dana, I will try not to nominate you.", view()),
    ("vote out", {"promise": {"what": "no-evict-vote", "subject": "npc:2"}}, "Dana, I swear I am voting Levi out.", view()),
    ("vote out as assurance", {"assurance": {"kind": "vote"}}, "Dana, I swear I am voting you out.", view()),
    ("putting up", {"assurance": {"kind": "loyal"}}, "Dana, I'm going to put you up.", view()),
    ("no commit words", {"assurance": {"kind": "safe"}}, "Dana, nice weather today.", view()),
    ("subject never named", {"promise": {"what": "no-nominate", "subject": "npc:3"}}, "Dana, I will never nominate them.", view()),
    ("subject junk", {"promise": {"what": "no-nominate", "subject": "Lorenzo"}}, "Dana, I will never nominate him.", view()),
    ("listener out of earshot", {"assurance": {"kind": "safe"}}, "Dana, you're safe with me.", view(("npc:1", "npc:2"), earshot_out=("npc:1",), lock="npc:1")),
    ("a houseguest's promise", {"promise": {"what": "no-nominate", "by": "npc:1"}}, "Dana, I will hold you to that.", view()),
    ("a houseguest's assurance", {"assurance": {"kind": "safe", "by": "npc:1"}}, "Dana, I will remember that.", view()),
    ("bad kind", {"promise": {"what": "evict"}}, "Dana, I will evict everyone.", view()),
    ("a deal is not a pledge", {"deal": {"kind": "final-two"}}, "Dana, I will take you to the end, deal?", view()),
]


def test_false_press_guards_stay_at_zero():
    hits = [name for name, obj, text, v in FALSE_PRESS if pc.validate(obj, text, v).get("confide")]
    assert hits == []


def test_false_pledge_guards_stay_at_zero():
    hits = [name for name, pl, text, v in FALSE_PLEDGE if pc.validate(plan(["npc:1"], pledge=pl), text, v).get("pledge")]
    assert hits == []


def test_an_ooc_message_plans_nothing_even_when_the_model_names_a_press():
    async def call(**kw):
        return json.dumps(plan(["npc:1"], press="npc:1", pledge={"assurance": {"kind": "safe"}}))
    d = asyncio.run(pc.decide("((what is really going on with the scoring? you can tell me))", view(), call=call))
    assert d["outcome"].startswith("skipped") and not d.get("confide") and not d.get("pledge")
