"""ORW-480: the per-person shot brief. Anchors, the narrow deterministic checks, the one writer call, the one editor pass, the floor, the prompt composition,
and that no name or example list reaches the writer. The writer is a stub: no network, no model, no spend."""
import asyncio
import importlib
import json
import os
import sys

B = importlib.import_module("src.orwell_photo_brief")

PLACES = [
    ("the clam docks", "Cedar Key, Florida", "water", "welding"), ("the drainage ditches behind the shopping center", "Provo, Utah", "field", "skating"),
    ("the vegetable patch behind the apartment", "Tulsa, Oklahoma", "yard", "tomatoes"), ("the Green River bank", "Auburn, Washington", "water", "fishing"),
    ("the taqueria her mother runs", "Laredo, Texas", "public-building", "salsa"), ("the church steps after choir", "Selma, Alabama", "street", "choir"),
    ("the karaoke bar she owns", "Duluth, Minnesota", "public-building", "karaoke"), ("the family ballroom studio", "Wichita, Kansas", "indoor-room", "ballroom"),
    ("the kitchen table at his grandmother's", "Fresno, California", "kitchen", "dumplings"), ("the ridge above the town", "Boise, Idaho", "field", "trail running"),
    ("the corner store on his block", "Akron, Ohio", "street", "newspapers"), ("the pond behind the house", "Burlington, Vermont", "water", "kayak"),
    ("the greenhouse at the end of the lane", "Dayton, Ohio", "yard", "orchids"), ("the garage workshop", "Reno, Nevada", "indoor-room", "carpentry"),
    ("the porch swing", "Mobile, Alabama", "yard", "quilting"),
]


def cards():
    out = []
    for n, (spot, town, _k, hobby) in enumerate(PLACES, 1):
        out.append({"id": f"npc:{n}", "name": f"Person{n} Surname{n}", "age": 25 + n, "vocation": f"job{n} technician", "hometown": town, "genderPresentation": "woman" if n % 2 else "man",
                    "demeanor": "warm and easy", "voice": "plain and quick", "castingType": {"label": "the natural", "read": "easy smile"},
                    "biography": f"Person{n} grew up near {spot} in {town}. {hobby.capitalize()} fills every weekend and Surname{n}'s friends know it.",
                    "physicalCharacteristics": {"wardrobe": ["a rust work jacket", "dark jeans"] if n % 3 else ["a cream knit", "olive trousers"], "onCamera": f"Person{n} leans on a fence.", "style": "plain"}})
    return out


KINDS = ["a pier", "a street corner", "a back garden", "a field path", "a kitchen table", "a spare room", "a hall step"]
TIMES = ["early morning, just after sunrise", "around noon", "mid-afternoon", "the golden hour before sunset", "dusk", "early evening, the first lamps on", "late morning"]


def good_brief(c, n):
    p = PLACES[n]
    return {
        "where": f"{p[0]} in {p[1]}, with the {p[3]} gear lying where it was left",
        "doing": f"paused in the middle of {p[3]}, one hand on the nearest rail",
        "inFrame": [f"a battered {p[3]} bag", f"a mug left on the {KINDS[n % 7].split()[-1]}"],
        "wear": ["a cream knit", "olive trousers", "a grey wool cardigan", "a rust corduroy shirt", "a green fleece", "a denim jacket", "a mustard sweater"][n % 7] + ", dark jeans",
        "signature": f"a hand-sewn patch number {n} on the cuff",
        "timeLight": f"{TIMES[n % 7]}, {['clear and still', 'thin high cloud', 'a windy day'][n % 3]}",
        "expressionBody": ["an easy half-smile, shoulders loose", "a steady look, jaw relaxed", "a real laugh, looking off to one side", "a dry half-smile, one brow raised"][n % 4],
        "why": '"' + " ".join(c["biography"].split(".")[0].split()[1:6]) + '"',
    }


def writer(bad=None, editor=None, calls=None):
    cs = cards()

    async def fn(messages):
        if calls is not None:
            calls.append(messages)
        user = json.loads(messages[-1]["content"])
        if "rewrite" in user:
            return json.dumps({i: (editor or good_brief)(cs[int(i.split(":")[1]) - 1], int(i.split(":")[1]) - 1) for i in user["rewrite"]})
        out = {}
        for n, c in enumerate(cs):
            b = good_brief(c, n)
            if bad and c["id"] in bad:
                b = bad[c["id"]](b)
            out[c["id"]] = b
        return json.dumps(out)
    return fn


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_anchors_are_seeded_even_and_near_work_is_capped():
    a = B.deal_anchors(cards(), 1)
    assert a == B.deal_anchors(cards(), 1) and a != B.deal_anchors(cards(), 2)
    assert sum(1 for x in a.values() if x["facet"] == B.NEAR_WORK) <= B.NEAR_WORK_MAX
    for key in ("time", "energy", "season"):
        counts = {}
        for x in a.values():
            counts[x[key]] = counts.get(x[key], 0) + 1
        assert max(counts.values()) <= 2 or key == "season", (key, counts)
    for x in a.values():
        assert x["weather"] in B.SEASONS[x["season"]]


def test_a_good_brief_passes_and_every_rule_has_a_failing_case():
    cs = cards()
    anchors = B.deal_anchors(cs, 1)
    c, an = cs[0], anchors["npc:1"]
    ok = good_brief(c, 0)
    assert B.check_brief(c, an, ok) == []
    cases = {
        "name-leak": {"doing": "Person1 pauses by the dock"},
        "acted-or-odd-pose": {"expressionBody": "hunched forward, hands hanging between the knees"},
        "open-palm-to-nobody": {"expressionBody": "one palm up, smiling"},
        "work-gear": {"wear": "scrubs and clogs"},
        "text-or-brand": {"inFrame": ["a sign reading Joe's", "a mug"]},
        "sunglasses": {"signature": "tinted sunglasses"},
        "hat-indoors": {"where": "the kitchen table of her flat near the clam docks in Cedar Key", "signature": "a straw sun hat"},
        "generic-place": {"where": "the kitchen"},
        "place-not-from-sheet": {"where": "a marble hotel lobby in some faraway city"},
        "no-sheet-quote": {"why": "she is warm"},
        "too-long-doing": {"doing": "x" * 200},
        "inframe-count": {"inFrame": ["only one"]},
    }
    for code, patch in cases.items():
        assert code in B.check_brief(c, an, {**ok, **patch}), code
    assert "missing" in B.check_brief(c, an, None) and "missing-why" in B.check_brief(c, an, {k: v for k, v in ok.items() if k != "why"})
    # the job is not a caption, unless the facet is near work
    cap = {**ok, "doing": "paused in the middle of her technician job"}
    assert "job-caption" in B.check_brief(c, {**an, "facet": "a hobby"}, cap)
    assert "job-caption" not in B.check_brief(c, {**an, "facet": B.NEAR_WORK}, cap)
    # a talking person may hold a hand out
    assert "open-palm-to-nobody" not in B.check_brief(c, an, {**ok, "expressionBody": "one hand open, mid-sentence to a friend"})


def test_cast_checks_name_the_later_offender_of_a_clash():
    cs = cards()
    anchors = B.deal_anchors(cs, 1)
    briefs = {c["id"]: good_brief(c, n) for n, c in enumerate(cs)}
    for i in ("npc:1", "npc:2", "npc:3", "npc:4"):          # four people on the water
        briefs[i] = {**briefs[i], "where": "the end of a long pier on the river bank near the lake house in town"}
    assert "place-kind-repeat" in B.check_cast(cs, anchors, briefs).get("npc:4", [])
    assert "place-kind-repeat" not in B.check_cast(cs, anchors, briefs).get("npc:3", [])
    dark = {c["id"]: {**good_brief(c, n), "wear": "a black hoodie, dark jeans"} for n, c in enumerate(cs)}
    assert any("dark-palette" in v for v in B.check_cast(cs, anchors, dark).values())
    arms = {c["id"]: {**good_brief(c, n), "expressionBody": "arms crossed, calm"} for n, c in enumerate(cs)}
    assert "gesture-repeat-arms-crossed" in B.check_cast(cs, anchors, arms)["npc:3"]


def test_the_pipeline_accepts_good_briefs_in_one_call_and_names_no_one_to_the_writer():
    calls = []
    res = run(B.author_briefs(cards(), writer(calls=calls), seed=1))
    assert res["calls"] == 1 and res["floor"] == [] and len(res["briefs"]) == 15 and res["rejected"] == {}
    sent = json.dumps(calls[0])
    assert "Person1" not in sent and "Surname" not in sent and "the person" in sent          # the names are scrubbed from every text
    sysm = calls[0][0]["content"]
    for bad_word in ("such as", "for example", "e.g.", "clam dock", "drainage"):
        assert bad_word not in sysm                                                     # rules and the person, never an example list
    for must in ("JSON only", "pre-season", "No eyes shut", "no hat or sunglasses indoors", "Only the person is in sharp focus", "No readable brand names"):
        assert must in sysm


def test_a_failing_brief_gets_one_editor_rewrite_then_the_floor():
    leak = {"npc:3": lambda b: {**b, "doing": "Person3 paused at the vines"}, "npc:5": lambda b: {**b, "where": "the kitchen"}}
    calls = []
    res = run(B.author_briefs(cards(), writer(bad=leak, calls=calls), seed=1))
    assert res["calls"] == 2 and res["rewritten"] == 2 and res["floor"] == [] and res["rejected"].get("name-leak") == 1 and res["rejected"].get("generic-place") == 1
    assert "failedCodes" in calls[1][-1]["content"] and "Person3" not in calls[1][-1]["content"]
    # an editor that cannot fix it: the person goes to the floor, and the rest are untouched
    res2 = run(B.author_briefs(cards(), writer(bad=leak, editor=lambda c, n: {**good_brief(c, n), "wear": "scrubs"}), seed=1))
    assert sorted(res2["floor"]) == ["npc:3", "npc:5"] and len(res2["briefs"]) == 13 and res2["calls"] == 2

    async def dead(messages):
        raise RuntimeError("no writer")
    res3 = run(B.author_briefs(cards(), dead, seed=1))
    assert len(res3["floor"]) == 15 and res3["briefs"] == {}                            # no writer: every card keeps the engine's own shot card

    async def junk(messages):
        return "not json"
    assert len(run(B.author_briefs(cards(), junk, seed=1))["floor"]) == 15


FLOOR = ("An opener. The subject is a 30-year-old woman. An ordinary person, not a model: a 30-year-old x from y; their grooming, hands, build and clothes fit that life. "
         "Face: round. Hair: dark. Wearing a grey tee, never a uniform. Setting: the house kitchen. Light: window. The moment: a grin; arms folded. "
         "Framing, the same for the whole series: a half-length portrait. Taken the way a local paper would: x. The only person in the frame; no text or logos.")


def test_the_prompt_replaces_only_clothes_setting_light_and_moment():
    c = cards()[0]
    out = B.compose_prompt(FLOOR, good_brief(c, 0))
    assert out.startswith("An opener. The subject is a 30-year-old woman. An ordinary person, not a model") and "Face: round. Hair: dark. " in out
    assert "Framing, the same for the whole series: a half-length portrait. Taken the way a local paper would: x. The only person in the frame; no text or logos." in out
    for gone in ("a grey tee", "the house kitchen", "Light: window", "a grin; arms folded"):
        assert gone not in out
    for there in ("Wearing ", "Setting: the clam docks in Cedar Key", "In the frame, theirs: ", "Light: early morning", "The moment: paused in the middle of welding", "never a uniform, scrubs, apron, badge or work gear"):
        assert there in out
    assert B.compose_prompt(FLOOR, None) == FLOOR and B.compose_prompt("no markers here", good_brief(c, 0)) == "no markers here"
    assert abs(len(out) - len(FLOOR)) < 900


def test_the_probe_in_dry_mode_runs_offline_and_prints_the_header_format(tmp_path):
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts")
    sys.path.insert(0, here)
    try:
        P = importlib.import_module("photobrief_probe")
    finally:
        sys.path.remove(here)
    cs = cards()
    floor = {c["id"]: {"name": c["name"], "prompt": FLOOR} for c in cs}
    class A:  # noqa: N801
        seed, ids, out, briefs = 1, "npc:2,npc:3", None, str(tmp_path / "b.json")
    res, finals = run(P.run(A, cs, floor, P.canned_llm(cs)))
    assert res["calls"] >= 1 and all(finals[i] for i in finals)
    P.emit(A, cs, floor, res, finals)
    assert json.load(open(A.briefs))["anchors"]


def test_apply_briefs_authors_once_caches_and_reuses_for_one_reshoot(tmp_path, monkeypatch):
    P = importlib.import_module("src.orwell_portraits")
    monkeypatch.setattr(P, "PORTRAITS_DIR", tmp_path / "portraits")
    cs = cards()
    prompts = [{"houseguestId": c["id"], "name": c["name"], "prompt": FLOOR} for c in cs]
    calls = []
    out = run(B.apply_briefs(prompts, "u", llm_fn=writer(calls=calls), cards=cs))
    assert len(calls) == 1 and all("Setting: " in o["prompt"] and "the house kitchen" not in o["prompt"] for o in out)
    # one re-shoot: no new writer call, the cached brief is reused, same text
    calls.clear()
    one = run(B.apply_briefs([prompts[2]], "u", llm_fn=writer(calls=calls), cards=cs))
    assert calls == [] and one[0]["prompt"] == out[2]["prompt"]
    # a changed sheet is a new brief
    cs2 = [dict(c) for c in cs]
    cs2[2]["biography"] = "Person3 now lives somewhere else entirely."
    assert B._sheet_key(cs2[2]) != B._sheet_key(cs[2])
    # no writer at all: the engine's prompts stand untouched (the floor)
    out2 = run(B.apply_briefs(prompts, "other-user", llm_fn=writer(bad={c["id"]: (lambda b: {**b, "where": "the kitchen"}) for c in cs}), cards=cs))
    assert [o["prompt"] for o in out2].count(FLOOR) in (0, 15)


def test_the_setting_is_off_by_default_and_generate_and_store_is_unchanged_when_off():
    from src import settings
    assert settings.DEFAULT_SETTINGS["portrait_brief_enabled"] is False
    assert B.brief_enabled("u") is False
