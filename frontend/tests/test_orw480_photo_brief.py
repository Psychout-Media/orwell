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


OBJ2 = ["lantern", "ladder", "kettle", "trowel", "binder", "bucket", "spade", "saddle", "anvil", "tripod", "basket", "canoe", "hammock", "radio", "easel"]
SIG = ["pocketknife", "notebook", "harmonica", "stopwatch", "whistle", "lunchbox", "telescope", "paperweight", "keychain", "pinwheel", "medallion", "ukulele", "thimble", "scrapbook", "sextant"]


def good_brief(c, n):
    p = PLACES[n]
    return {
        "where": f"{p[0]} in {p[1]}, with the {p[3]} gear lying where it was left",
        "doing": f"paused in the middle of {p[3]}, one hand on the nearest rail",
        "inFrame": [f"a battered {p[3]} bag", f"a {OBJ2[n]} left where it was put down"],
        "wear": ["a cream knit", "olive trousers", "a grey wool cardigan", "a rust corduroy shirt", "a green fleece", "a denim jacket", "a mustard sweater"][n % 7] + ", dark jeans",
        "signature": f"a {SIG[n]} that is always on them",
        "timeLight": f"{TIMES[n % 7]}, {['clear and still', 'thin high cloud', 'a windy day'][n % 3]}",
        "expressionBody": ["an easy half-smile, shoulders loose", "a steady look, jaw relaxed", "a real laugh, looking off to one side", "a dry half-smile, one brow raised"][n % 4],
        "why": '"' + " ".join(c["biography"].split(".")[0].split()[1:6]) + '"',
        "tie": '"' + p[0] + '"',
    }


def writer(bad=None, editor=None, calls=None):
    cs = cards()

    async def fn(messages):
        if calls is not None:
            calls.append(messages)
        user = json.loads(messages[-1]["content"])
        if "rewrite" in user or "complete" in user:
            ids = list(user.get("rewrite") or {}) + list(user.get("complete") or {})
            return json.dumps({i: (editor or good_brief)(cs[int(i.split(":")[1]) - 1], int(i.split(":")[1]) - 1) for i in ids})
        wanted = set(user.get("cast") or [])
        out = {}
        for n, c in enumerate(cs):
            if wanted and c["id"] not in wanted:
                continue
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
        "inframe-count": {"inFrame": ["a lantern", "a ladder", "a third thing"]},
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


def test_the_pipeline_accepts_good_briefs_in_two_writer_calls_and_names_no_one_to_the_writer():
    calls = []
    res = run(B.author_briefs(cards(), writer(calls=calls), seed=1))
    assert res["calls"] == 2 and res["floor"] == [] and len(res["briefs"]) == 15 and res["rejected"] == {}
    sent = json.dumps(calls)
    assert "Person1" not in sent and "Surname" not in sent and "the person" in sent          # the names are scrubbed from every text
    assert "alreadyUsed" not in calls[0][-1]["content"] and "alreadyUsed" in calls[1][-1]["content"]     # the second writer sees what the first used
    sysm = calls[0][0]["content"]
    for bad_word in ("such as", "for example", "e.g.", "clam dock", "drainage"):
        assert bad_word not in sysm                                                     # rules and the person, never an example list
    for must in ("JSON only", "pre-season", "No eyes shut", "no hat or sunglasses indoors", "Only the person is in sharp focus", "No readable brand names", "ONE person only", "tie:"):
        assert must in sysm


def test_a_failing_brief_gets_one_editor_rewrite_then_the_floor():
    leak = {"npc:3": lambda b: {**b, "doing": "Person3 paused at the vines"}, "npc:5": lambda b: {**b, "where": "the kitchen"}}
    calls = []
    res = run(B.author_briefs(cards(), writer(bad=leak, calls=calls), seed=1))
    # a name in a brief is repaired in place (the name becomes "the person"); a generic place goes to the editor
    assert res["calls"] == 3 and res["rewritten"] == 1 and res["floor"] == [] and "name-leak" not in res["rejected"] and res["rejected"].get("generic-place") == 1
    assert "failedCodes" in calls[2][-1]["content"] and "Person5" not in calls[2][-1]["content"] and "Person3" not in calls[2][-1]["content"]
    # an editor that cannot fix it: the person goes to the floor, and the rest are untouched
    res2 = run(B.author_briefs(cards(), writer(bad=leak, editor=lambda c, n: {**good_brief(c, n), "wear": "scrubs"}), seed=1))
    assert res2["floor"] == ["npc:5"] and len(res2["briefs"]) == 14 and res2["calls"] == 3

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
    assert len(calls) == 2 and all("Setting: " in o["prompt"] and "the house kitchen" not in o["prompt"] for o in out)
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


# ---------------------------------------------------------------------------------------------------- the coordinator's six fixes (2026-11-16)
def test_fix1_probe_relative_out_and_briefs_are_written_against_the_launch_directory(tmp_path):
    import subprocess
    repo = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
    probe = os.path.join(repo, "frontend", "scripts", "photobrief_probe.py")
    cs = cards()
    (tmp_path / "cards.json").write_text(json.dumps(cs))
    (tmp_path / "floor.json").write_text(json.dumps({c["id"]: {"name": c["name"], "prompt": FLOOR} for c in cs}))
    run_dir = tmp_path / "launch"
    run_dir.mkdir()
    for f in ("cards.json", "floor.json"):
        (run_dir / f).write_text((tmp_path / f).read_text())
    r = subprocess.run([sys.executable, probe, "--cards", "cards.json", "--floor", "floor.json", "--ids", "npc:2", "--dry", "--app", repo, "--out", "out.txt", "--briefs", "b.json"],
                       cwd=str(run_dir), capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr[-400:]
    assert (run_dir / "out.txt").read_text().startswith("\n--- npc_2 (") and "anchors" in json.loads((run_dir / "b.json").read_text())
    # a write that cannot happen fails loudly (a non-zero exit and a message), never silently
    bad = subprocess.run([sys.executable, probe, "--cards", "cards.json", "--floor", "floor.json", "--ids", "npc:2", "--dry", "--app", repo, "--out", "no/such/dir/out.txt"],
                         cwd=str(run_dir), capture_output=True, text=True, timeout=60)
    assert bad.returncode != 0 and ("No such file" in bad.stderr or "not written" in bad.stderr)


def test_fix2_a_brief_is_repaired_before_it_is_rejected_and_the_editor_can_land(tmp_path):
    cs = cards()
    c = cs[0]
    an = B.deal_anchors(cs, 1)["npc:1"]
    long = {**good_brief(c, 0), "signature": "a hand-sewn patch on the cuff, a faded stitch of red thread, and a long note about the trip, ending with a signature", "where": good_brief(c, 0)["where"] + ", with " + ", ".join(["a very long list of other things around"] * 6),
            "wear": "a cream knit, olive trousers, a hard hat for the walk"}
    fixed = B.repair_brief(c, B.clean_brief(long))
    assert len(fixed["signature"]) <= B.LIMITS["signature"] and len(fixed["where"]) <= B.LIMITS["where"] and "hard hat" not in fixed["wear"]
    assert B.check_brief(c, an, fixed) == []                 # repaired, not rejected: no editor call is needed for these
    # work boots, tools and ordinary objects are not a uniform tell
    assert "work-gear" not in B.check_brief(c, an, {**good_brief(c, 0), "wear": "a rust work jacket, work boots"})
    # an offending object is dropped by the repair (the brief is kept, not rejected) and the editor tops it up; a reply in another shape (wrapped, ids spelled npc_3) still lands
    wrong = {"npc:3": lambda b: {**b, "inFrame": [b["wear"].split(",")[0], b["inFrame"][1]]}}

    async def wrapped(messages):
        user = json.loads(messages[-1]["content"])
        if "rewrite" in user or "complete" in user:
            ids = list(user.get("rewrite") or {}) + list(user.get("complete") or {})
            return json.dumps({"rewrite": {i.replace(":", "_"): good_brief(cs[int(i.split(":")[1]) - 1], int(i.split(":")[1]) - 1) for i in ids}})
        return await writer(bad=wrong)(messages)
    res = run(B.author_briefs(cs, wrapped, seed=1))
    assert res["floor"] == [] and len(res["briefs"]["npc:3"]["inFrame"]) == 2 and res["calls"] == 3
    res_nofill = run(B.author_briefs(cs, writer(bad=wrong, editor=lambda c2, n: {**good_brief(c2, n), "inFrame": good_brief(c2, n)["inFrame"][:1]}), seed=1))
    assert res_nofill["floor"] == [] and len(res_nofill["briefs"]["npc:3"]["inFrame"]) == 1      # no top-up: the one object stands, the brief is not lost
    # a dry run where the editor can reduce the floor count (through the probe's own run())
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts")
    sys.path.insert(0, here)
    try:
        P = importlib.import_module("photobrief_probe")
    finally:
        sys.path.remove(here)
    floor = {x["id"]: {"name": x["name"], "prompt": FLOOR} for x in cs}

    class A:  # noqa: N801
        seed = 1
    generic = {"npc:3": lambda b: {**b, "where": "the kitchen"}}
    first = run(P.run(A, cs, floor, writer(bad=generic, editor=lambda c2, n: {**good_brief(c2, n), "wear": "scrubs"})))[0]
    second = run(P.run(A, cs, floor, writer(bad=generic)))[0]
    assert len(first["floor"]) == 1 and len(second["floor"]) == 0


def test_fix3_the_assembled_sentences_read_cleanly_and_the_signature_is_an_object_not_clothing():
    c = cards()[0]
    b = {**good_brief(c, 0), "wear": "Plain charcoal zip hoodie, baggy dark-wash jeans, low-top canvas sneakers.", "signature": "A skateboard with scuffed wheels, a constant companion.",
         "where": "The old drainage ditches behind the shopping center in Provo, Utah, with concrete banks", "timeLight": "Early afternoon in spring, a first warm day.",
         "doing": "Standing with one hand curled loose around a board.", "expressionBody": "Gaze just past the lens, mouth set in a wry line.", "inFrame": ["a battered rail", "a scuffed helmet."]}
    out = B.compose_prompt(FLOOR, B.repair_brief(c, b), B.proper_words(c))
    assert "Wearing plain charcoal zip hoodie, baggy dark-wash jeans, low-top canvas sneakers, in their own everyday clothes" in out
    assert "skateboard" not in out.split("Setting:")[0].split("Wearing")[1]                      # the signature object is not in the clothes clause
    assert "In the frame, theirs: a battered rail, a scuffed helmet and a skateboard with scuffed wheels, a constant companion." in out
    assert "Setting: the old drainage ditches behind the shopping center in Provo, Utah, with concrete banks." in out      # the town keeps its capitals
    assert "Light: early afternoon in spring, a first warm day." in out
    assert "The moment: standing with one hand curled loose around a board; gaze just past the lens" in out
    for bad in (".,", "..", ".;", ", and A ", "Wearing Plain", "; Gaze"):
        assert bad not in out


def test_fix4_the_two_own_objects_are_not_clothes_or_the_signature():
    cs = cards()
    c, an = cs[0], B.deal_anchors(cs, 1)["npc:1"]
    ok = good_brief(c, 0)
    assert B.check_brief(c, an, ok) == []
    for items in (["a plain charcoal hoodie", "a mug"], [ok["inFrame"][0], "the same patch on the cuff again"], ["low-top sneakers", "a rail"]):
        code = B.check_brief(c, an, {**ok, "wear": "a charcoal hoodie, low-top canvas sneakers", "inFrame": items})
        assert "inframe-worn-or-signature" in code, items
    assert "two OBJECTS in the frame" in B.SYSTEM and "not clothes or jewellery or nails they are wearing and not the signature item" in B.SYSTEM


def test_fix5_the_floor_uses_the_random_anchors_so_fallbacks_do_not_converge():
    cs = cards()
    an = B.deal_anchors(cs, 1)
    lights = {B.floor_with_anchors(FLOOR, an[c["id"]]).split("Light: ")[1].split(".")[0] for c in cs}
    assert len(lights) >= 8 and "Light: window." not in B.floor_with_anchors(FLOOR, an["npc:1"])
    assert B.floor_with_anchors("no light here", an["npc:1"]) == "no light here" and B.floor_with_anchors(FLOOR, None) == FLOOR

    async def dead(messages):
        raise RuntimeError("no writer")
    P = importlib.import_module("src.orwell_portraits")  # noqa: F841
    res = run(B.author_briefs(cs, dead, seed=1))
    assert len(res["floor"]) == 15
    two = [B.final_prompt(FLOOR, None, res["anchors"][i], cs[int(i.split(":")[1]) - 1]) for i in ("npc:14", "npc:15")]
    assert two[0] != two[1] and all("Light: " in t and "Light: window." not in t for t in two)
    # the stray comma the gloss strip used to leave (engine side) is covered by the TypeScript test


def test_run2_assembly_examples_the_clothes_clause_holds_clothes_only():
    c = cards()[0]
    an = B.deal_anchors(cards(), 1)["npc:1"]
    ok = good_brief(c, 0)
    # the real writer put a pose inside wear, repeated a worn item as the signature, and listed worn clothes as objects
    raw = {**ok, "wear": "a flowing printed tunic top, wide-leg dark-wash jeans, and long hoop earrings", "signature": "long hoop earrings and a chin dipped, eyes up, dimples just starting",
           "inFrame": ["a worn black leather jacket and dark straight-leg jeans", "a steaming pot"]}
    fixed = B.repair_brief(c, B.clean_brief(raw))
    codes = B.check_brief(c, an, fixed)
    assert "signature" not in fixed and "signature-repeats-wear" not in codes and "missing-signature" not in codes   # a repeat of what is worn is dropped, never stuffed again, and a brief without one is still accepted
    assert "inframe-worn-or-signature" in B.check_brief(c, an, {**ok, "inFrame": raw["inFrame"]})
    body = B.repair_brief(c, B.clean_brief({**ok, "wear": "a gray cotton pocket t-shirt, dark straight-leg jeans, and arms loose at her sides and shoulders squared"}))
    assert body["wear"] == "a gray cotton pocket t-shirt, dark straight-leg jeans" and "body-in-wear" not in B.check_brief(c, an, body)
    assert "body-in-wear" in B.check_brief(c, an, {**ok, "wear": "a tunic, shoulders squared"})
    assert "body-in-signature" in B.check_brief(c, an, {**ok, "signature": "a chin dipped, eyes up"})
    # the assembly: clothes in the clothes clause, once; a worn signature joins them once; an object joins the objects; nothing of the pose in Wearing
    good = {**ok, "wear": "a flowing printed tunic top, wide-leg jeans", "signature": "long hoop earrings", "inFrame": ["a heron mug", "a shell-lined rail"], "expressionBody": "chin dipped, eyes up, dimples just starting"}
    out = B.compose_prompt(FLOOR, good)
    wearing = out.split("Wearing ")[1].split(" Setting:")[0]
    assert wearing.count("hoop earrings") == 1 and "chin dipped" not in wearing and "heron mug" not in wearing
    assert "In the frame, theirs: a heron mug and a shell-lined rail." in out and "chin dipped, eyes up" in out.split("The moment:")[1]
    obj = B.compose_prompt(FLOOR, {**good, "signature": "a heron-blue skateboard"})
    assert "In the frame, theirs: a heron mug, a shell-lined rail and a heron-blue skateboard." in obj and "skateboard" not in obj.split("Setting:")[0]


# ---------------------------------------------------------------------------------------------------- the coordinator's five fixes (real run at 8d683b7a)
def test_r1_repair_keeps_the_brief_when_a_signature_or_an_object_is_the_problem():
    cs = cards()
    # ten of fifteen briefs carry the run-3 defects: a signature that repeats what is worn, a garment listed as an object, a worn accessory as an object
    def damage(b):
        wear = b["wear"].split(",")[0]
        return {**b, "signature": wear, "inFrame": [wear, b["inFrame"][1]]}
    bad = {f"npc:{i}": damage for i in (1, 3, 5, 7, 9, 11, 12, 13, 14, 15)}
    res = run(B.author_briefs(cs, writer(bad=bad), seed=1))
    assert res["floor"] == [] and len(res["briefs"]) == 15 and res["calls"] <= 3
    assert not {"missing-signature", "inframe-worn-or-signature", "inframe-count"} & set(res["rejected"])
    # nothing worn is left in the objects
    for b in res["briefs"].values():
        assert not any(B.CLOTHING_RE.search(x) for x in b["inFrame"])
    # the editor tops up the missing second object and the signature in the same call as the rewrites
    topped = [i for i in bad if len(res["briefs"][i]["inFrame"]) == 2 and res["briefs"][i].get("signature")]
    assert len(topped) == len(bad)


def test_r2_objects_signatures_are_used_by_one_person_only_and_the_writer_is_told_what_is_used():
    cs = cards()
    rod = {f"npc:{i}": (lambda b: {**b, "inFrame": ["a fishing rod leaned on the rail", b["inFrame"][1]]}) for i in (9, 14, 15)}
    hoop = {f"npc:{i}": (lambda b: {**b, "signature": "a small silver hoop earring in one ear"}) for i in (2, 6)}
    ball = {f"npc:{i}": (lambda b: {**b, "inFrame": [b["inFrame"][0], "a scuffed basketball"]}) for i in (4, 8)}
    calls = []
    res = run(B.author_briefs(cs, writer(bad={**rod, **hoop, **ball}, calls=calls), seed=1))
    objs = [t for b in res["briefs"].values() for t in B._obj_tokens(" ".join(b["inFrame"]) + " " + str(b.get("signature") or ""))]
    for word in ("fishing", "basketball"):
        assert objs.count(word) <= 1
    assert len([b for b in res["briefs"].values() if "earring" in str(b.get("signature") or "")]) <= 1
    assert res["floor"] == [] and "object-repeat" in res["rejected"]
    assert "alreadyUsed" in calls[1][-1]["content"] and "fishing rod" not in calls[0][-1]["content"]
    ed = [c for c in calls if "rewrite" in c[-1]["content"] or "complete" in c[-1]["content"]]
    assert ed and "alreadyUsed" in ed[0][-1]["content"] and "fishing rod" in ed[0][-1]["content"]
    # an editor that offers the same object again does not send the person to the floor: the repeat is dropped
    stubborn = run(B.author_briefs(cs, writer(bad=rod, editor=lambda c, n: {**good_brief(c, n), "inFrame": ["a fishing rod again", good_brief(c, n)["inFrame"][1]]}), seed=1))
    assert stubborn["floor"] == [] and sum(1 for b in stubborn["briefs"].values() if "fishing" in " ".join(b["inFrame"])) <= 1


def test_r3_worn_things_join_the_clothes_never_the_objects():
    c = cards()[10]
    ok = good_brief(c, 10)
    raw = {**ok, "wear": "a tunic top, wide-leg jeans", "signature": "dark painted nails", "inFrame": ["a vintage handbag on a shelf", "a silver chain", "a rack of colorful clothes"]}
    fixed = B.repair_brief(c, B.clean_brief(raw))
    assert fixed["inFrame"] == ["a vintage handbag on a shelf"] and "silver chain" in fixed["wear"]          # the chain is worn: it joins the clothes; the rack is clothing, not an object of theirs
    out = B.compose_prompt(FLOOR, fixed)
    assert "dark painted nails" in out.split("Wearing ")[1].split(" Setting:")[0] and "In the frame, theirs: a vintage handbag on a shelf." in out
    for worn in ("a bracelet of braided leather", "a pair of hoop earrings", "painted nails"):
        o = B.compose_prompt(FLOOR, {**ok, "signature": worn})
        assert worn in o.split("Wearing ")[1].split(" Setting:")[0] and worn not in o.split("In the frame")[1].split("Light:")[0]


def test_r4_the_place_must_tie_to_the_sheet_and_the_writer_states_the_tie():
    cs = cards()
    c = cs[4]                                               # the taqueria her mother runs in Laredo
    an = B.deal_anchors(cs, 1)["npc:5"]
    ok = good_brief(c, 4)
    assert B.check_brief(c, an, ok) == []
    assert "missing-tie" in B.check_brief(c, an, {k: v for k, v in ok.items() if k != "tie"})
    assert "no-place-tie" in B.check_brief(c, an, {**ok, "tie": "she likes shops"})
    assert "no-place-tie" in B.check_brief(c, an, {**ok, "tie": '"a quote that is not in the sheet at all"'})
    assert "place-not-tied" in B.check_brief(c, an, {**ok, "tie": '"grew up near"'})      # a real quote, but not what the place comes from
    # a consignment-shop doorway with no tie to the sheet is rejected whatever tie is claimed
    shop = {**ok, "where": "the doorway of a consignment shop on the corner of an avenue downtown", "tie": '"Salsa fills every weekend"'}
    assert any(x in B.check_brief(c, an, shop) for x in ("place-not-from-sheet", "place-not-tied"))
    assert "tie:" in B.SYSTEM and "never printed" in B.SYSTEM
    quoted = {**ok, "tie": '"Salsa fills every weekend"'}
    assert B.check_brief(c, an, quoted) == []
    assert "Salsa fills every weekend" not in B.compose_prompt(FLOOR, quoted)                  # checked, never printed


def test_r5_clothes_fit_cold_or_wet_weather_with_a_layer_from_their_own_style():
    cs = cards()
    c = cs[0]
    thin = {**good_brief(c, 0), "wear": "a short-sleeve tropical shirt, light trousers"}
    cold = {"weather": "a cool, damp day"}
    assert "weather-layer" in B.check_brief(c, {**B.deal_anchors(cs, 1)["npc:1"], **cold}, thin)
    assert "weather-layer" not in B.check_brief(c, {**B.deal_anchors(cs, 1)["npc:1"], "weather": "clear and hot"}, thin)
    fixed = B.repair_brief({**c, "physicalCharacteristics": {"wardrobe": ["a short-sleeve tropical shirt", "an olive canvas overshirt"]}}, B.clean_brief(thin), cold)
    assert "an olive canvas overshirt over it" in fixed["wear"]
    plain = B.repair_brief({**c, "physicalCharacteristics": {"wardrobe": ["a tee"]}}, B.clean_brief(thin), cold)
    assert "plain overshirt over it" in plain["wear"]
    already = B.repair_brief(c, B.clean_brief({**thin, "wear": "a tropical shirt under a wool coat"}), cold)
    assert already["wear"].count("over it") == 0
    assert "add a layer from their own style" in B.SYSTEM
