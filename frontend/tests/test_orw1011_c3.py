"""ORW-1011 C3: commit scene records and planned houseguest moves from the pre-reply plan (flag ORWELL_COMMIT_FROM_PLAN, default OFF). Invented names only; no prod text."""
import asyncio
import importlib
import json
import pathlib

pc = importlib.import_module("src.plan_commit")
ledger = importlib.import_module("src.orwell_sync_ledger")
ROOMS = ["kitchen", "living-room", "dining-room", "backyard", "hallway", "bedroom-a", "bedroom-b", "bedroom-c", "bathroom", "lounge", "hoh-room", "storage-room", "diary-room", "landing"]
CAST = [{"id": "npc:1", "name": "Dana Park"}, {"id": "npc:2", "name": "Levi Stone"}, {"id": "npc:3", "name": "Maeve Ortiz"}]


def view(present=("npc:1",), asleep=(), here="living-room"):
    people = [c for c in CAST if c["id"] in present]
    return {"present": people, "awake": [p["id"] for p in people if p["id"] not in asleep], "asleep": list(asleep), "known": CAST, "rooms": ROOMS, "room_names": None, "here": here, "prev": None, "pending": None}


def scene(ids, kind="bonding"):
    return {"act": "talk", "scene": {"withIds": ids, "kind": kind, "content": "The player spoke with them.", "feltMinutes": 30}, "moves": []}


def run(coro):
    return asyncio.run(coro)


def test_flag_default_off(monkeypatch):
    monkeypatch.delenv("ORWELL_COMMIT_FROM_PLAN", raising=False)
    assert pc.enabled() is False
    monkeypatch.setenv("ORWELL_COMMIT_FROM_PLAN", "1")
    assert pc.enabled() is True


def test_named_scene_commits_and_bare_ids_are_read():
    v = pc.validate(scene([1]), "I ask Dana how the week is going", view())
    assert v["scene"]["withIds"] == ["npc:1"]


def test_absent_asleep_and_unnamed_are_trimmed_never_added():
    assert pc.validate(scene(["npc:2"]), "I tell Levi we should talk", view(("npc:1",)))["scene"] is None  # Levi is elsewhere
    assert pc.validate(scene(["npc:1"]), "I whisper to Dana", view(("npc:1",), asleep=("npc:1",)))["scene"] is None
    assert pc.validate(scene(["npc:1"]), "I tell everyone I am done", view(("npc:1", "npc:2")))["scene"] is None  # nobody named, two could be meant: the belt keeps it
    assert pc.validate(scene(["npc:1", "npc:2"]), "I ask Dana about it", view(("npc:1", "npc:2")))["scene"]["withIds"] == ["npc:1"]  # the one named
    assert pc.validate(scene(["npc:1"]), "I say we should team up", view(("npc:1",)))["scene"]["withIds"] == ["npc:1"]  # exactly one is here


def test_closed_set_outcome_is_not_recorded():
    obj = scene(["npc:1"])
    obj["scene"]["content"] = "Dana was nominated for eviction."
    assert pc.validate(obj, "I ask Dana a question", view())["scene"]["content"] != "Dana was nominated for eviction."


def test_planned_move_needs_the_name_the_room_and_no_unrequested_arrival():
    mv = {"act": "talk", "scene": None, "moves": [{"id": "npc:1", "room": "kitchen"}]}
    assert pc.validate(mv, "I ask Dana to go to the kitchen", view())["moves"] == [("npc:1", "kitchen")]
    assert pc.validate(mv, "I go to the kitchen", view())["moves"] == []  # the player's own move, Dana never named
    assert pc.validate(mv, "I ask Dana how she is", view())["moves"] == []  # the room is not in the player's words
    arrive = {"act": "talk", "scene": None, "moves": [{"id": "npc:1", "room": "living-room"}]}
    assert pc.validate(arrive, "I tell Dana the living-room couch is nice", view())["moves"] == []  # a mention never pulls someone in
    diary = {"act": "talk", "scene": None, "moves": [{"id": "npc:1", "room": "diary-room"}]}
    assert pc.validate(diary, "I send Dana to the diary room", view())["moves"] == []


def test_decide_fails_soft_and_skips_what_has_nothing_to_plan():
    async def boom(**kw):
        raise RuntimeError("down")

    async def slow(**kw):
        await asyncio.sleep(5)
    assert run(pc.decide("I ask Dana a thing", view(), call=boom))["outcome"] == "error"
    assert run(pc.decide("((ooc note))", view(), call=boom))["outcome"].startswith("skipped")
    assert run(pc.decide("I ask Dana a thing", view(("npc:1",), asleep=("npc:1",)), call=boom))["outcome"] == "skipped:nobody-here"
    called = []

    async def ok(**kw):
        called.append(1)
        return "not json"
    assert run(pc.decide("I ask Dana a thing", view(), call=ok))["outcome"] == "unparsed" and called


def test_driver_metric_names_the_plan_not_the_narrator_or_a_belt():
    assert ledger.classify_driver(["recordInteraction"], {"plan-commit:recordInteraction": 1}) == "plan"
    assert ledger.classify_driver([], {"plan-commit:moveHouseguest": 1}) == "plan"
    assert ledger.classify_driver(["recordInteraction"], {"auto-record-scene": 1}) == "both"
    assert ledger.classify_driver(["recordInteraction"], {}) == "narrator"
    assert ledger.classify_driver([], {"plan-commit:recordInteraction": 1, "auto-move-npc": 1}) == "belt"  # a belt that fired is still counted


def test_loop_half_stages_the_scene_stands_the_belt_down_and_tells_the_narrator(monkeypatch):
    staged, noted, events = [], [], []
    from src import fold_ledger as fl
    monkeypatch.setattr(fl, "stage_pending_fold", lambda owner, sid, **kw: staged.append((owner, sid, kw)))
    pc.put_stash("u1", {"scene": {"withIds": ["npc:1"], "kind": "bonding", "content": "The player spoke with them.", "feltMinutes": 30}, "moves": [("npc:1", "kitchen")], "names": {"npc:1": "Dana Park"}})
    note = pc.loop_half("u1", "s1", events, 1, lambda o, b, n=1: noted.append(b))
    assert staged and staged[0][2]["with_ids"] == ["npc:1"] and staged[0][2]["consequence"] is None
    assert events and events[0]["tool"] == "recordInteraction" and events[0]["exit_code"] == 0
    assert noted == ["plan-commit:recordInteraction", "plan-commit:moveHouseguest"]
    assert "ALREADY recorded" in note and "kitchen" in note
    assert pc.loop_half("u1", "s1", [], 1, lambda *a, **k: None) is None  # taken once


def test_the_loop_and_the_slot_are_wired_behind_the_flag():
    root = pathlib.Path(__file__).resolve().parents[1]
    assert "plan_commit" in (root / "src" / "agent_loop.py").read_text()
    assert "commit_before_narrator" in (root / "routes" / "chat_helpers.py").read_text()
    assert '"commit_from_plan_enabled": False' in (root / "src" / "settings.py").read_text()


def test_corpus_labels_are_consistent():
    d = json.load(open(pathlib.Path(__file__).parent / "fixtures" / "orw1011_c3_corpus.json"))
    ids = {c[0] for c in d["cast"]}
    assert len(d["rows"]) >= 250
    for r in d["rows"]:
        assert set(r["view"]["present"]) <= ids and set(r["exp"]["scene"] or []) <= ids
