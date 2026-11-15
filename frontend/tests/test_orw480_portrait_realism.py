"""ORW-480 D: the realism checks on finished photos. The per-photo check asks real-photo / hands / clothes and no longer
calls a laugh, a glance away or a loose hair a fault on a candid brief; ONE cast-level look over a contact sheet names
look-alike pairs and repeats; a flagged photo is re-shot once with the reason; each image's cost is logged when the provider
returns it. Providers and the vision model are stubbed (no network, no spend)."""
import asyncio
import importlib
import io
import json

import pytest

P = importlib.import_module("src.orwell_portraits")
C = importlib.import_module("src.orwell_portrait_check")
t362 = importlib.import_module("test_orw362_gpt_image_route")

NEW_PROMPT = (
    "A real photograph by a reality show's unit photographer, taken during the season: half-length, framed at the waist, at eye level, "
    "on a 35mm lens. The subject is a 31-year-old multiracial man with warm skin. Face: an oval face, a straight nose. "
    "Hair: dark curls, neatly styled. Wearing black button-down, fitted jeans. Setting: the backyard, lawn and fence behind. "
    "Light: low golden-hour sun. The moment: caught mid-laugh at something off-camera, head tipped back. "
    "The only person in the frame; no text or logos.")


def _run(c):
    return asyncio.new_event_loop().run_until_complete(c)


def test_a_candid_brief_is_read_for_its_facts_and_asks_the_realism_codes():
    f = C.facts_from_prompt(NEW_PROMPT)
    assert f["candid"] is True and f["age"] == 31 and f["gender"] == "man" and f["spot"] == "the backyard"
    assert not f.get("eyes_on_camera")                       # the moment looks off-camera: eyes-off must not be judged
    lens = C.facts_from_prompt(NEW_PROMPT.replace("caught mid-laugh at something off-camera", "arms wide, looking into the lens"))
    assert lens["eyes_on_camera"] is True
    req = C.build_request("deepseek-flash", "data:x", f)
    text = req["messages"][0]["content"][0]["text"]
    for code in ("not-a-real-photo", "bad-held-object", "fake-clothes"):
        assert code in text and code in C.KNOWN_CODES and code in C.PROBLEM_WORDS
    for code in ("messy-hair", "mouth-mid-word", "not-a-portrait"):
        assert code not in text                              # a laugh, a glance and loose hairs are asked for on a candid brief
    for code in ("not-one-person", "text-or-logo", "wrong-age", "wrong-clothes", "missing-feature"):
        assert code in text
    old = C.build_request("deepseek-flash", "data:x", C.facts_from_prompt("Official cast portrait. Waist-up portrait of a 40-year-old woman. Setting: the house kitchen."))
    assert "messy-hair" in old["messages"][0]["content"][0]["text"] and "not-a-real-photo" not in old["messages"][0]["content"][0]["text"]


def test_parse_accepts_the_new_codes_and_rejects_unknown_ones():
    ok = {"choices": [{"message": {"content": '{"problems": ["not-a-real-photo", "fake-clothes", "bad-held-object"]}'}}]}
    assert C._parse_problems(ok) == ["not-a-real-photo", "fake-clothes", "bad-held-object"]


def test_cast_reply_is_parsed_and_bounded():
    data = {"choices": [{"message": {"content": json.dumps({
        "pairs": [[2, 5], [3, 3], [0, 4], [1, 99], "x"],
        "repeats": [{"kind": "prop", "numbers": [1, 7], "what": "a white mug"}, {"kind": "room", "numbers": [2, 3], "what": "kitchen"},
                    {"kind": "room", "numbers": [4, 6, 8], "what": "living room"}, {"kind": "mood", "numbers": [1, 2, 3]}]})}}]}
    r = C._parse_cast(data, 15)
    assert r["pairs"] == [[2, 5]]
    assert [x["kind"] for x in r["repeats"]] == ["prop", "room"] and r["repeats"][1]["numbers"] == [4, 6, 8]   # a room on 2 is not a repeat
    assert C._parse_cast({"choices": [{"message": {"content": "not json"}}]}, 15) is None
    assert C._parse_cast({"choices": [{"message": {"content": '{"pairs": 3}'}}]}, 15) is None


def test_cast_sends_back_the_later_photo_once_bounded_and_spares_a_reshot_one():
    ids = [f"npc:{i}" for i in range(1, 16)]
    res = {"pairs": [[2, 5], [5, 2]], "repeats": [{"kind": "prop", "numbers": [1, 7, 9], "what": "mug"}, {"kind": "light", "numbers": [3, 4, 5], "what": "lamp"}]}
    out = C.cast_sends_back(res, ids, spared=set())
    assert list(out) == ["npc:5", "npc:7", "npc:9"] and len(out) == C.CAST_RESHOOT_MAX      # bounded; each id once
    assert "face" in out["npc:5"] and "held object" in out["npc:7"]
    assert "npc:5" not in C.cast_sends_back(res, ids, spared={"npc:5"})
    assert C.cast_sends_back({"pairs": [], "repeats": []}, ids, set()) == {}


def test_contact_sheet_is_one_numbered_grid():
    pytest.importorskip("PIL")
    from PIL import Image
    def png(c):
        b = io.BytesIO(); Image.new("RGB", (400, 500), c).save(b, "PNG"); return b.getvalue()
    url = C.contact_sheet([png("red"), png("green"), png("blue"), png("black")])
    assert url.startswith("data:image/jpeg;base64,")
    import base64
    im = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))
    assert im.size == (5 * 256, 256)


def test_check_cast_needs_three_photos_and_fails_open(monkeypatch):
    monkeypatch.setattr(P, "image_gen_disabled", lambda: False)
    monkeypatch.setattr(C, "check_enabled", lambda u: True)
    assert _run(C.check_cast([b"a", b"b"], "u")) is None
    async def boom(pngs, user):
        raise RuntimeError("x")
    monkeypatch.setattr(C, "_cast_call", boom)
    assert _run(C.check_cast([b"a", b"b", b"c"], "u")) is None


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(P, "PORTRAITS_DIR", tmp_path / "portraits")
    monkeypatch.setattr(P, "PORTRAIT_LOG_PATH", tmp_path / "log.jsonl")
    monkeypatch.setattr(P, "image_generation_available", lambda user: True)
    monkeypatch.setattr(P, "image_gen_disabled", lambda: False)
    monkeypatch.setattr(P, "portrait_parallel", lambda user=None: 3)
    return tmp_path


def _seed_cast(n=5):
    prompts = [{"houseguestId": f"npc:{i}", "name": f"G{i}", "prompt": NEW_PROMPT + f" Variant {i}."} for i in range(1, n + 1)]
    for e in prompts:
        P._write_portrait("u", e["houseguestId"], b"old-" + e["houseguestId"].encode(), e["name"], check={"ok": True, "problems": [], "reshot": False})
    return prompts


def test_cast_look_reshoots_the_flagged_photo_once_with_the_reason_and_logs_costs(env, monkeypatch):
    prompts = _seed_cast()
    async def fake_cast(pngs, user):
        return {"pairs": [[1, 3]], "repeats": [], "cost": 0.002}
    shots = []
    async def fake_gen(prompt, user, reference_png=None, keep_identity=True):
        shots.append((prompt, reference_png))
        P._note_gen_cost(0.04)
        return b"new-png"
    async def fake_check(png, facts, user):
        P._note_gen_cost(0.001)   # the real check notes its own cost on the running total
        return {"ok": True, "problems": []}
    monkeypatch.setattr(C, "check_cast", fake_cast)
    monkeypatch.setattr(C, "check_portrait", fake_check)
    monkeypatch.setattr(P, "_generate_one", fake_gen)
    out = _run(P.cast_look_pass(prompts, "u"))
    assert out["reshotIds"] == ["npc:3"] and len(shots) == 1
    assert "Fix in this version: a clearly different face" in shots[0][0] and shots[0][1] is None
    assert P.portrait_file("u", "npc:3").read_bytes() == b"new-png" and P.portrait_file("u", "npc:1").read_bytes() == b"old-npc:1"
    e = P.load_manifest("u")["npc_3"]
    assert e["castLookReshot"] is True and e["check"]["reshot"] is True and e["promptVersion"] == P.PORTRAIT_PROMPT_VERSION
    log = P.read_attempt_log()
    assert [x["costUsd"] for x in log if x["houseguestId"] == "cast-look"] == [0.002]
    assert [x["costUsd"] for x in log if x["houseguestId"] == "npc:3"] == [0.041]          # the image plus its check
    # a second look never sends the same photo back (inside the existing one-re-shoot bound)
    shots.clear()
    again = _run(P.cast_look_pass(prompts, "u"))
    assert again["reshotIds"] == [] and shots == []


def test_cast_look_skipped_changes_nothing(env, monkeypatch):
    prompts = _seed_cast()
    async def none(pngs, user):
        return None
    monkeypatch.setattr(C, "check_cast", none)
    out = _run(P.cast_look_pass(prompts, "u"))
    assert out["reshotIds"] == [] and P.portrait_file("u", "npc:2").read_bytes() == b"old-npc:2"


def test_a_worse_reshoot_keeps_the_old_photo(env, monkeypatch):
    prompts = _seed_cast()
    async def fake_cast(pngs, user):
        return {"pairs": [[1, 2]], "repeats": []}
    async def fake_gen(prompt, user, reference_png=None, keep_identity=True):
        return b"worse"
    async def bad_check(png, facts, user):
        return {"ok": False, "problems": ["fake-clothes"]}
    monkeypatch.setattr(C, "check_cast", fake_cast)
    monkeypatch.setattr(C, "check_portrait", bad_check)
    monkeypatch.setattr(P, "_generate_one", fake_gen)
    out = _run(P.cast_look_pass(prompts, "u"))
    assert out["reshotIds"] == [] and P.portrait_file("u", "npc:2").read_bytes() == b"old-npc:2"


def test_an_image_cost_is_logged_when_the_provider_returns_it_and_absent_otherwise(env, monkeypatch):
    for usage, expect in (({"cost": 0.04}, [0.04]), (None, [])):
        c = t362._Client(t362._ok(b"GPT", usage=usage))
        t362._setup(monkeypatch, t362.GPT, c)
        async def no_check(png, facts, user):
            return None
        monkeypatch.setattr(C, "check_portrait", no_check)
        async def no_cast(pngs, user):
            return None
        monkeypatch.setattr(C, "check_cast", no_cast)
        P.PORTRAIT_LOG_PATH.write_text("")
        _run(P.generate_and_store([{"houseguestId": "npc:1", "name": "G", "prompt": NEW_PROMPT}], "u", record_beats=False))
        assert [x["costUsd"] for x in P.read_attempt_log() if "costUsd" in x] == expect
