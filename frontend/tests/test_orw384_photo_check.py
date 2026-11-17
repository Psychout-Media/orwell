"""ORW-384: the automatic photo check for NPC cast portraits. httpx fully faked (no network, no spend).
Sync tests driven through run_until_complete, as in test_orw362/378."""

import asyncio
import importlib
import json
import logging
import sys
import types

import pytest

P = importlib.import_module("src.orwell_portraits")
C = importlib.import_module("src.orwell_portrait_check")
ledger = importlib.import_module("src.orwell_token_ledger")

V3 = ("Official cast portrait. Waist-up portrait of a 35-year-old Black American man with deep brown skin. "
      "Wearing a crisp white oxford shirt with the sleeves rolled, slim dark trousers and a plain silver watch. "
      "He leans forward, eyes locked on the camera, a wide grin. Setting: the house kitchen, softly out of focus "
      "behind him. Light: soft. Shot on a full-frame camera with an 85mm portrait lens. The only person in the frame.")
OLD = ("Subject: a woman (feminine presentation), who looks exactly 41 years old, named Ann Secret. Physical "
       "appearance: tall. Wearing: green wool coat, jeans. Occupation: nurse. On camera: In the hall, Ann sighs.")
SECRET = "Ann Secret"
_REAL_DATA_URL = C._image_data_url
_REAL_RESOLVE = C._resolve_deepseek
_REAL_ENABLED = C.check_enabled


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


class _Resp:
    def __init__(self, status=200, body=None):
        self.status_code, self._body, self.text = status, body, ""

    def json(self):
        return self._body


def _reply(problems, cost=0.002):
    return _Resp(200, {"choices": [{"message": {"content": json.dumps({"problems": problems})}}],
                       "usage": {"prompt_tokens": 900, "completion_tokens": 12, "cost": cost}})


class _FakeHttpx(types.ModuleType):
    pass


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(P, "PORTRAITS_DIR", tmp_path / "portraits")
    monkeypatch.setattr(P, "PORTRAIT_LOG_PATH", tmp_path / "log.jsonl")
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "ledger.json")
    monkeypatch.setattr(P, "image_generation_available", lambda user: True)
    monkeypatch.setattr(P, "image_gen_disabled", lambda: False)
    monkeypatch.setattr(P, "portrait_parallel", lambda user=None: 3)
    monkeypatch.setattr(C, "check_enabled", _REAL_ENABLED)
    P._INFLIGHT.clear()
    P._GEN_PROGRESS.clear()
    st = types.SimpleNamespace(posts=[], replies=[], exc=None, settings={}, resolved=True, shots=[])

    class Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None):
            st.posts.append((url, json, headers))
            if st.exc:
                raise st.exc
            return st.replies.pop(0) if st.replies else _reply([])

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", Client)

    def resolve(model_id, owner):
        if not st.resolved:
            raise ValueError("no DeepSeek endpoint")
        st.spec = model_id
        return "https://api.deepseek.com/chat/completions", {"Authorization": "Bearer x"}

    monkeypatch.setattr(C, "_resolve_deepseek", resolve)
    settings = importlib.import_module("src.settings")
    real = settings.get_user_setting

    def gus(key, owner="", default=None):
        if key in st.settings:
            return st.settings[key]
        return real(key, owner=owner, default=default)

    monkeypatch.setattr(settings, "get_user_setting", gus)

    async def fake(prompt, user, reference_png=None, keep_identity=True):
        st.shots.append((prompt, reference_png))
        return b"PNG%d" % len(st.shots)

    monkeypatch.setattr(P, "_generate_one", fake)
    monkeypatch.setattr(C, "_image_data_url", lambda png: "data:image/png;base64,AAAA")
    return st


def _entry(hid="npc:1", prompt=V3):
    return {"houseguestId": hid, "name": "Zorvan", "prompt": prompt}


def _store(entry=None, **kw):
    return _run(P.generate_and_store([entry or _entry()], "u", record_beats=False, **kw))


def _manifest():
    return P.load_manifest("u")


def test_defaults():
    from src import settings
    assert settings.DEFAULT_SETTINGS["portrait_check_enabled"] is True
    assert settings.DEFAULT_SETTINGS["portrait_check_model"] == "deepseek-flash"


def test_pass_keeps_first_one_check_call(env):
    env.replies = [_reply([])]
    _store()
    assert len(env.shots) == 1 and len(env.posts) == 1
    assert env.spec == "deepseek-flash"
    assert P.portrait_file("u", "npc:1").read_bytes() == b"PNG1"
    assert _manifest()[P._safe_id("npc:1")]["check"] == {"ok": True, "problems": [], "reshot": False}


def test_fail_reshoots_once_keeps_second(env):
    env.replies = [_reply(["messy-hair", "skin-patch", "bogus-code"]), _reply(["messy-hair"])]
    _store()
    assert len(env.shots) == 2 and len(env.posts) == 2
    assert env.shots[1][0].startswith(V3)
    assert env.shots[1][0].endswith(" Fix in this version: neat, groomed hair with no flyaways or frizz, "
                                    "clear skin with no bruise, wound, bandage or patch on the face.")
    assert P.portrait_file("u", "npc:1").read_bytes() == b"PNG2"
    chk = _manifest()[P._safe_id("npc:1")]["check"]
    assert chk == {"ok": False, "problems": ["messy-hair"], "reshot": True}
    log = P.read_attempt_log()[-1]
    assert log["check"]["first"] == ["messy-hair", "skin-patch"] and log["houseguestId"] == "npc:1"
    assert "prompt" not in json.dumps(log)


def test_second_fails_never_a_third_shot(env):
    env.replies = [_reply(["messy-hair"]), _reply(["messy-hair"]), _reply([])]
    _store()
    assert len(env.shots) == 2 and len(env.posts) == 2


def test_second_with_more_problems_keeps_first(env):
    env.replies = [_reply(["bad-hands"]), _reply(["bad-hands", "wrong-age"])]
    _store()
    assert P.portrait_file("u", "npc:1").read_bytes() == b"PNG1"
    chk = _manifest()[P._safe_id("npc:1")]["check"]
    assert chk == {"ok": False, "problems": ["bad-hands"], "reshot": True}


def test_reshoot_uses_same_reference(env):
    _store()  # first photo on disk
    env.shots.clear()
    env.replies = [_reply(["bad-hands"]), _reply([])]
    _store(force_ids=["npc:1"])
    assert len(env.shots) == 2
    assert env.shots[0][1] == b"PNG1" and env.shots[1][1] == b"PNG1"


@pytest.mark.parametrize("case", ["no-model", "timeout", "http", "badjson", "nojsonobj", "empty", "transport"])
def test_fail_open(env, case):
    if case == "no-model":
        env.resolved = False
    elif case == "timeout":
        env.exc = asyncio.TimeoutError()
    elif case == "transport":
        env.exc = RuntimeError("boom")
    elif case == "http":
        env.replies = [_Resp(500, {})]
    elif case == "badjson":
        env.replies = [_Resp(200, {"choices": [{"message": {"content": "looks fine to me"}}]})]
    elif case == "empty":
        env.replies = [_Resp(200, {"choices": [{"message": {"content": ""}}]})]
    else:
        env.replies = [_Resp(200, {"choices": [{"message": {"content": '{"problems": "none"}'}}]})]
    assert _store() == {"generated": 1, "skipped": 0, "total": 1}
    assert len(env.shots) == 1
    assert P.portrait_file("u", "npc:1").read_bytes() == b"PNG1"
    assert "check" not in _manifest()[P._safe_id("npc:1")]


def test_real_timeout_is_forty_five_seconds(env, monkeypatch):
    assert C.CHECK_TIMEOUT_S == 45.0

    async def slow(*a, **k):
        await asyncio.sleep(5)

    monkeypatch.setattr(C, "CHECK_TIMEOUT_S", 0.05)
    monkeypatch.setattr(C, "_call", slow)
    assert _run(C.check_portrait(b"x", {}, "u")) is None


def test_players_photo_never_checked(env):
    _store(_entry("player"))
    assert env.posts == [] and len(env.shots) == 1
    assert "check" not in _manifest()[P._safe_id("player")]


def test_disabled_setting_and_kill_switch_make_no_call(env, monkeypatch):
    env.settings["portrait_check_enabled"] = False
    _store()
    assert env.posts == []
    env.settings.clear()
    monkeypatch.setattr(P, "image_gen_disabled", lambda: True)
    assert _run(C.check_portrait(b"PNG", {}, "u")) is None
    assert env.posts == []


def test_request_body_is_image_plus_allowed_facts_only(env):
    env.replies = [_reply([])]
    _store(_entry(prompt=V3 + " named " + SECRET))
    (url, body, headers), = env.posts
    assert url.startswith("https://api.deepseek.com/") and body["max_tokens"] == 8000
    assert url.endswith("/chat/completions") and body["model"] == "deepseek-flash"
    (msg,) = body["messages"]
    kinds = [p["type"] for p in msg["content"]]
    assert kinds == ["text", "image_url"]
    assert msg["content"][1]["image_url"]["url"].startswith("data:image/")
    text = msg["content"][0]["text"]
    for want in ("Stated age: 35", "Stated gender presentation: man", "crisp white oxford shirt with the sleeves rolled",
                 "the house kitchen", "Eyes on camera was asked: yes"):
        assert want in text
    for leak in (SECRET, "Zorvan", "Black American", "deep brown", "Official cast portrait", "85mm"):
        assert leak not in text
    assert set(body) == {"model", "messages", "temperature", "max_tokens"}


def test_facts_parse_v3_and_older():
    f = C.facts_from_prompt(V3)
    assert f == {"age": 35, "gender": "man", "clothing": "a crisp white oxford shirt with the sleeves rolled",
                 "spot": "kitchen", "eyes_on_camera": True}
    g = C.facts_from_prompt(OLD)
    assert g == {"age": 41, "gender": "woman", "clothing": "green wool coat"}
    assert "eyes_on_camera" not in C.facts_from_prompt(V3.replace("locked on the camera", "looking away"))
    assert C.facts_from_prompt("prompt 3") == {} and C.facts_from_prompt(None) == {}
    assert C.facts_block({}) == "No stated facts."


def test_ledger_entry_recorded(env):
    env.replies = [_reply([], cost=0.0031)]
    _store()
    rows = [e for e in ledger.get_recent("u", 50) if e["callClass"] == "portrait-check"]
    assert len(rows) == 1 and rows[0]["cost"] == pytest.approx(0.0031) and rows[0]["inputTokens"] == 900 \
        and rows[0]["provider"] == "deepseek"


def test_runs_inside_the_portrait_semaphore(env, monkeypatch):
    live = {"n": 0, "max": 0}
    monkeypatch.setattr(P, "portrait_parallel", lambda user=None: 1)

    async def call(png, facts, user):
        live["n"] += 1
        live["max"] = max(live["max"], live["n"])
        await asyncio.sleep(0.02)
        live["n"] -= 1
        return {"ok": True, "problems": []}

    monkeypatch.setattr(C, "check_portrait", call)
    _run(P.generate_and_store([_entry("npc:1"), _entry("npc:2")], "u", record_beats=False))
    assert live["max"] == 1 and len(env.shots) == 2


def test_image_is_downscaled_to_768_jpeg():
    import base64
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (1536, 1536), (200, 100, 50)).save(buf, "PNG")
    url = _REAL_DATA_URL(buf.getvalue())
    assert url.startswith("data:image/jpeg;base64,")
    im = Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))
    assert im.format == "JPEG" and max(im.size) == 768
    assert _REAL_DATA_URL(b"not an image").startswith("data:image/png;base64,")


def test_non_deepseek_model_setting_is_ignored(env):
    for bad in ("anthropic/claude-haiku-5.5", "deepseek/deepseek-flash", "gpt-4o", "deepseek-flash@openrouter", ""):
        env.settings["portrait_check_model"] = bad
        assert C._check_model_id("u") == "deepseek-flash"
    env.settings["portrait_check_model"] = "deepseek-other"
    assert C._check_model_id("u") == "deepseek-other"


def test_openrouter_only_setup_makes_no_check_call(env, monkeypatch):
    """The real resolver, with only an OpenRouter endpoint enabled: no check call, photo kept."""
    class Ep:
        base_url = "https://openrouter.ai/api/v1"
        api_key = "k"

    class Q:
        def filter(self, *a):
            return self

        def all(self):
            return [Ep()]

    class DB:
        def query(self, *a):
            return Q()

        def close(self):
            pass

    database = importlib.import_module("src.database")
    monkeypatch.setattr(database, "SessionLocal", lambda: DB())
    monkeypatch.setattr(C, "_resolve_deepseek", _REAL_RESOLVE)
    with pytest.raises(ValueError):
        _REAL_RESOLVE("deepseek-flash", None)
    _store()
    assert env.posts == [] and len(env.shots) == 1
    assert P.portrait_file("u", "npc:1").read_bytes() == b"PNG1"


def test_a_deepseek_endpoint_resolves_to_its_own_host(env, monkeypatch):
    class Ep:
        base_url = "https://api.deepseek.com"
        api_key = "k"

    class Q:
        def filter(self, *a):
            return self

        def all(self):
            return [Ep()]

    class DB:
        def query(self, *a):
            return Q()

        def close(self):
            pass

    monkeypatch.setattr(importlib.import_module("src.database"), "SessionLocal", lambda: DB())
    url, headers = _REAL_RESOLVE("deepseek-flash", None)
    assert url.startswith("https://api.deepseek.com") and "Bearer k" in headers.get("Authorization", "")


def test_upgrade_reshoot_is_checked_and_reuses_the_old_face_on_the_fix(env):
    """The ORW-369/380 upgrader re-shoots through generate_and_store(force_ids=[id], silent=True) with the
    old face as the reference: the new photo is checked, and the fix re-shoot reuses that same reference."""
    P._write_portrait("u", "npc:1", b"OLD-FACE", "Zorvan", source="generated")
    env.replies = [_reply(["messy-hair"]), _reply([])]
    _run(P.generate_and_store([_entry()], "u", record_beats=False, force_ids=["npc:1"], silent=True))
    assert len(env.posts) == 2 and len(env.shots) == 2
    assert env.shots[0][1] == b"OLD-FACE" and env.shots[1][1] == b"OLD-FACE"
    assert "Fix in this version" in env.shots[1][0] and "Fix in this version" not in env.shots[0][0]
    assert P.portrait_file("u", "npc:1").read_bytes() == b"PNG2"
    assert _manifest()[P._safe_id("npc:1")]["check"] == {"ok": True, "problems": [], "reshot": True}


# ---- ORW-437 review of #2677 and #2731 -----------------------------------------------------------------------

def test_a_reply_without_a_dollar_cost_is_ledgered_with_an_estimate(env):
    env.replies = [_Resp(200, {"choices": [{"message": {"content": json.dumps({"problems": []})}}], "model": "deepseek-flash",
                               "usage": {"prompt_tokens": 900000, "completion_tokens": 12000}})]
    _store()
    rows = [e for e in ledger.get_recent("u", 50) if e["callClass"] == "portrait-check"]
    assert len(rows) == 1 and rows[0]["cost"] > 0 and rows[0].get("costEstimated") is True


def test_a_persisted_string_false_disables_the_check(env):
    for off in ("false", "False", "0", "off"):
        env.settings["portrait_check_enabled"] = off
        assert C.check_enabled("u") is False
    env.settings["portrait_check_enabled"] = "true"
    assert C.check_enabled("u") is True


def test_a_verdict_of_only_unknown_codes_skips_the_check_instead_of_passing_the_photo(env):
    env.replies = [_reply(["made-up-code"])]
    assert _run(C.check_portrait(b"PNG", {}, "u")) is None
    env.replies = [_reply(["not-one-person", "made-up-code"])]  # a known code beside an unknown one still counts
    assert _run(C.check_portrait(b"PNG", {}, "u"))["problems"] == ["not-one-person"]


def test_hair_colour_and_length_are_read_from_the_hair_clause_in_any_order():
    pr = "Waist-up portrait of a 30-year-old woman. Hair: tight black curls. Setting: the house kitchen"
    assert "black hair" in C.visible_features(pr)
    pr2 = "Waist-up portrait of a 30-year-old woman. Hair: shoulder-length waves, jet black. Setting: the house kitchen"
    f = C.visible_features(pr2)
    assert "jet black hair" in f and "shoulder-length hair" in f
    assert C.visible_features("Hair: a neat low bun. Setting: x") == ["hair in bun"]  # ORW-460: a style-only line still yields a checkable feature
    assert C.visible_features("a woman with short brown hair") == ["brown hair", "short brown hair"]  # older wording still parses, exactly
    assert "short hair" in C.visible_features("a woman with short hair")


def test_an_accessory_colour_in_the_hair_clause_is_not_the_hair_colour():
    pr = "Waist-up portrait of a 30-year-old woman. Hair: a neat low bun tied with a red ribbon. Setting: the house kitchen"
    assert not any("red" in f for f in C.visible_features(pr))
    pr2 = "Waist-up portrait of a 30-year-old woman. Hair: long black waves held back with a white clip. Setting: x"
    f = C.visible_features(pr2)
    assert "black hair" in f and "long hair" in f and not any("white" in x for x in f)


def test_nonbinary_has_no_wrong_presentation_verdict(env):
    assert "never report wrong-presentation" in C.facts_block({"gender": "nonbinary"})
    assert "never report wrong-presentation" not in C.facts_block({"gender": "woman"})
    env.replies = [_reply(["wrong-presentation", "messy-hair"])]
    assert _run(C.check_portrait(b"PNG", {"gender": "nonbinary"}, "u"))["problems"] == ["messy-hair"]
    env.replies = [_reply(["wrong-presentation"])]
    assert _run(C.check_portrait(b"PNG", {"gender": "nonbinary"}, "u")) == {"ok": True, "problems": []}
    env.replies = [_reply(["wrong-presentation"])]
    assert _run(C.check_portrait(b"PNG", {"gender": "woman"}, "u"))["problems"] == ["wrong-presentation"]


def _hair(line):
    return C.visible_features(f"Waist-up portrait of a 30-year-old woman. Hair: {line}. Setting: the house kitchen")


def test_every_real_hair_line_yields_at_least_one_checkable_feature():
    """ORW-460: 81 of 612 real hair lines (photoHair and hair) had no checkable feature, so that photo's hair was never checked."""
    import json
    import os
    lines = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures", "orw460_hair_lines.json")))
    assert len(lines) > 500
    assert [x for x in lines if not _hair(x)] == []


def test_soft_colours_cuts_and_styles_are_checkable():
    assert _hair("voluminous dark waves swept back off the forehead") == ["dark hair"]
    assert _hair("neat locs falling past the shoulder, kept immaculate") == ["hair past the shoulder"]
    assert _hair("a salt-and-pepper buzzcut") == ["salt-and-pepper hair", "hair with a buzzcut"]
    assert _hair("sleek caramel lob tucked neatly behind one ear") == ["caramel hair", "hair with a lob"]
    assert _hair("tight natural curls shaped neat") == ["hair in curls"]


def test_a_real_colour_after_an_accessory_word_is_kept_and_an_accent_is_not_the_colour():
    assert "brown hair" in _hair("buzzed close with a clean line-up, espresso-brown and neat")
    assert "dark brown hair" in _hair("tapered low fade with a twist-out top, dark brown with a cool cast")
    assert not any("copper" in f for f in _hair("close-cropped dark hair with a faint copper cast"))
    assert _hair("sleek caramel-highlighted lob, glossy") == ["hair with a lob"]
    assert not any("silver" in f for f in _hair("loose dark waves with scattered silver, neat"))
    assert not any("blond" in f for f in _hair("natural afro with a bright gold-blond top, neat"))


def test_deep_is_not_a_colour_and_the_trivial_or_odd_phrases_are_fixed():
    assert not any("deep" in f for f in _hair("glossy waves parted deep, full and neat over the shoulders"))
    assert _hair("glossy waves parted deep, full and neat over the shoulders") == ["hair in waves"]
    assert _hair("neat locs, tucked past the ears") == ["hair in locs"]  # "past the ear" is not a length worth a paid re-shoot
    assert _hair("slicked back smooth and glossy") == ["hair slicked back"]


def test_a_soft_cut_about_the_sides_is_not_a_whole_head_feature():
    assert _hair("tight natural coils with a fade at the sides") == ["hair in coils"]
    assert _hair("tight natural coils, a crop at the sides") == ["hair in coils"]


def test_an_unpriced_model_ledgers_no_made_up_zero_cost(env):
    C._record_spend("u", {"model": "an-unpriced-model", "usage": {"prompt_tokens": 100, "completion_tokens": 5}})
    assert [e for e in ledger.get_recent("u", 50) if e["callClass"] == "portrait-check"] == []


def test_a_forced_upgrade_check_reshoot_keeps_the_upgrade_identity_prefix(env):
    P._write_portrait("u", "npc:1", b"OLD-FACE", "Zorvan", source="generated")
    env.replies = [_reply(["messy-hair"]), _reply([])]
    entry = {**_entry(), "identityPrefix": True}
    _run(P.generate_and_store([entry], "u", record_beats=False, force_ids=["npc:1"], silent=True))
    assert len(env.shots) == 2
    assert env.shots[0][0].startswith(P.UPGRADE_IDENTITY_PREFIX)          # the first upgrade shot
    assert env.shots[1][0].startswith(P.UPGRADE_IDENTITY_PREFIX)          # the fix re-shoot too (ORW-437)
    assert "Fix in this version" in env.shots[1][0]


def test_nonbinary_and_mustache_are_read_from_the_brief():
    nb = "Waist-up portrait of a 30-year-old West African nonbinary person with a soft androgynous look. Hair: short dark curls. Wearing a grey hoodie."
    assert C.facts_from_prompt(nb)["gender"] == "nonbinary" and "Stated gender presentation: nonbinary" in C.facts_block(C.facts_from_prompt(nb))
    assert "moustache" in C.visible_features("a man with a mustache") and "moustache" in C.visible_features("a man with a moustache")


# ---- ORW-480: the token budget, the empty cut-off retry and the proportions code ------------------------

def test_build_request_asks_for_8000_tokens():
    body = C.build_request("deepseek-flash", "data:image/png;base64,AAAA", {})
    assert body["max_tokens"] == 8000


def _cut_off():
    return _Resp(200, {"choices": [{"finish_reason": "length", "message": {"content": ""}}]})


def test_an_empty_cut_off_retries_once_and_the_good_verdict_arrives(env):
    env.replies = [_cut_off(), _reply(["messy-hair"])]
    verdict = _run(C.check_portrait(b"PNG", {}, "u"))
    assert verdict == {"ok": False, "problems": ["messy-hair"]}
    assert len(env.posts) == 2


def test_two_empty_cut_offs_give_no_verdict_and_a_plain_empty_content_never_retries(env, caplog):
    with caplog.at_level(logging.WARNING):
        env.replies = [_cut_off(), _cut_off()]
        assert _run(C.check_portrait(b"PNG", {}, "u")) is None
    assert len(env.posts) == 2
    assert '[portrait-check] no verdict: the model ran out of tokens' in caplog.text
    env.replies = [_Resp(200, {"choices": [{"finish_reason": "stop", "message": {"content": ""}}]})]
    env.posts.clear()
    assert _run(C.check_portrait(b"PNG", {}, "u")) is None
    assert len(env.posts) == 1  # finish_reason "stop" with empty content is not a cut-off: no retry


def test_bad_proportions_is_known_and_in_both_checklists():
    assert "bad-proportions" in C.KNOWN_CODES
    assert "bad-proportions" in C._CHECKLIST and "bad-proportions" in C._REALISM_CHECKLIST
    assert "bad-proportions" in C._checklist_for({}) and "bad-proportions" in C._checklist_for({"candid": True})
    assert C.problems_in_words(["bad-proportions"]) == (
        "natural adult body proportions: hands the right size for the face, head in proportion to the body, "
        "arms and legs of natural length, every limb joined to the right shoulder or hip")


def test_a_verdict_naming_bad_proportions_parses(env):
    env.replies = [_reply(["bad-proportions"])]
    assert _run(C.check_portrait(b"PNG", {}, "u")) == {"ok": False, "problems": ["bad-proportions"]}
