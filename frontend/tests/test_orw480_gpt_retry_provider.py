"""ORW-480: GPT Image is retried with backoff on a transient failure before anything else; the Gemini fallback is off by default (its image can carry a visible
watermark); every portrait records which provider and route made it, in the manifest and the attempt log. Providers are stubbed: no network, no spend."""
import asyncio
import importlib
import json

import pytest

op = importlib.import_module("src.orwell_portraits")
t362 = importlib.import_module("test_orw362_gpt_image_route")


def _run(c):
    return asyncio.new_event_loop().run_until_complete(c)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(op, "PORTRAITS_DIR", tmp_path / "portraits")
    monkeypatch.setattr(op, "PORTRAIT_LOG_PATH", tmp_path / "log.jsonl")
    monkeypatch.setattr(op, "image_generation_available", lambda user: True)
    monkeypatch.setattr(op, "image_gen_disabled", lambda: False)
    monkeypatch.setattr(op, "portrait_parallel", lambda user=None: 3)
    return tmp_path


def _setup(monkeypatch, client, waits=(0.0, 0.0), fallback=False):
    t362._setup(monkeypatch, t362.GPT, client)
    monkeypatch.setattr(op, "GPT_RETRY_WAITS_S", waits)
    monkeypatch.setattr(op, "gemini_fallback_enabled", lambda u: fallback)
    slept = []

    async def fake_sleep(s):
        slept.append(s)
    monkeypatch.setattr(op.asyncio, "sleep", fake_sleep)
    return slept


class _Seq(t362._Client):
    """A client whose responses come in order (the last repeats)."""
    def __init__(self, *resps):
        super().__init__(resps[0])
        self.seq = list(resps)

    async def post(self, url, json=None, headers=None):
        self.posts.append((url, json, headers))
        return self.seq.pop(0) if len(self.seq) > 1 else self.seq[0]


def test_a_transient_gpt_failure_is_retried_with_a_growing_wait_before_anything_else(env, monkeypatch):
    c = _Seq(t362._Resp(502, {}, text="x"), t362._Resp(429, {}, text="x"), t362._ok(b"GPT"))
    slept = _setup(monkeypatch, c, waits=(3.0, 9.0))
    op._consume_gen_error()
    assert _run(op._generate_one("p", "u")) == b"GPT"
    assert len(c.posts) == 3 and slept == [3.0, 9.0]
    assert op._peek_gen_provider() == {"model": t362.GPT, "route": "gpt-image"}


def test_a_permanent_gpt_failure_is_not_retried_and_a_billing_one_stops_at_once(env, monkeypatch):
    for resp in (t362._Resp(404, {}, text="x"), t362._Resp(400, {}, text="x"), t362._Resp(402, {}, text="x")):
        c = t362._Client(resp)
        slept = _setup(monkeypatch, c, waits=(3.0, 9.0))
        op._consume_gen_error()
        assert _run(op._generate_one("p", "u")) is None
        assert len(c.posts) == 1 and slept == []


def test_there_is_no_gemini_fallback_by_default_and_the_failure_is_recorded(env, monkeypatch):
    c = t362._Client(t362._Resp(502, {}, text="x"))
    slept = _setup(monkeypatch, c, waits=(1.0, 2.0))
    chat_calls = []
    monkeypatch.setattr(op, "_generate_via_chat_completions", lambda *a, **k: chat_calls.append(1))
    op._consume_gen_error()
    assert _run(op._generate_one("p", "u")) is None
    assert len(c.posts) == 3 and slept == [1.0, 2.0] and chat_calls == []                   # three GPT tries, no Gemini call at all
    assert op._peek_gen_error()[0] == "gpt-image-failed"                                    # the failure stays RED for the reconciler
    from src import settings
    assert settings.DEFAULT_SETTINGS["portrait_gemini_fallback"] is False
    assert op.gemini_fallback_enabled("nobody") is False


def test_with_the_setting_on_the_gemini_fallback_runs_after_the_retries_and_is_named(env, monkeypatch):
    c = t362._Client(t362._Resp(502, {}, text="x"))
    _setup(monkeypatch, c, waits=(1.0,), fallback=True)
    op._consume_gen_error()
    assert _run(op._generate_one("p", "u")) == b"GEMINI" and len(c.posts) == 2


def test_the_provider_of_every_portrait_is_in_the_manifest_and_the_log(env, monkeypatch):
    c = t362._Client(t362._ok(b"GPTIMG"))
    _setup(monkeypatch, c)
    async def no_check(png, facts, user):
        return None
    from src import orwell_portrait_check as C
    monkeypatch.setattr(C, "check_portrait", no_check)
    async def no_cast(pngs, user):
        return None
    monkeypatch.setattr(C, "check_cast", no_cast)
    _run(op.generate_and_store([{"houseguestId": "npc:1", "name": "G", "prompt": "p"}], "u", record_beats=False))
    entry = op.load_manifest("u")["npc_1"]
    assert entry["provider"] == {"model": t362.GPT, "route": "gpt-image"}
    log = op.read_attempt_log()
    assert log[-1]["provider"] == {"model": t362.GPT, "route": "gpt-image"} and log[-1]["ok"] is True
    # a fallback image says so
    c2 = t362._Client(t362._Resp(502, {}, text="x"))
    _setup(monkeypatch, c2, waits=(), fallback=True)
    async def gem(client, url, model_id, prompt, headers, reference_png=None):
        op._note_gen_provider(model_id, "gemini-fallback")
        return b"GEMINI"
    monkeypatch.setattr(op, "_generate_via_chat_completions", gem)
    _run(op.generate_and_store([{"houseguestId": "npc:2", "name": "H", "prompt": "p"}], "u", record_beats=False))
    assert op.load_manifest("u")["npc_2"]["provider"]["route"] == "gemini-fallback"


# ---------------------------------------------------------------------------------------------------- frame / border, watermark, hair signature
def _png(size=(200, 260), border=0, fill=(150, 120, 100), edge=(0, 0, 0)):
    PIL = pytest.importorskip("PIL.Image")
    import io
    im = PIL.new("RGB", size, fill)
    if border:
        for x in range(size[0]):
            for y in range(size[1]):
                if x < border or y < border or x >= size[0] - border or y >= size[1] - border:
                    im.putpixel((x, y), edge)
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


def test_a_black_or_white_frame_is_found_by_the_edge_test_and_an_ordinary_photo_is_not():
    C = importlib.import_module("src.orwell_portrait_check")
    assert C.has_border(_png(border=12)) is True                                    # a black frame
    assert C.has_border(_png(border=12, edge=(250, 250, 250))) is True               # a white rim
    assert C.has_border(_png()) is False                                           # a plain picture
    PIL = pytest.importorskip("PIL.Image")
    import io
    im = PIL.new("RGB", (200, 260), (20, 20, 20))                                   # a dark photo with texture at the edges is not a frame
    for x in range(0, 200, 3):
        for y in range(0, 260, 5):
            im.putpixel((x, y), (200, 180, 160))
    b = io.BytesIO(); im.save(b, "PNG")
    assert C.has_border(b.getvalue()) is False
    assert C.has_border(b"not an image") is False
    assert "frame-or-border" in C.KNOWN_CODES and "watermark" in C.KNOWN_CODES
    text = C.build_request("m", "data:x", {"candid": True})["messages"][0]["content"][0]["text"]
    assert "frame-or-border" in text and "watermark (a visible watermark, sparkle, four-point star" in text
    assert "watermark" in C.build_request("m", "data:x", {})["messages"][0]["content"][0]["text"]


def test_a_framed_photo_is_reshot_once_with_the_reason(env, monkeypatch):
    C = importlib.import_module("src.orwell_portrait_check")
    monkeypatch.setattr(C, "check_enabled", lambda u: True)
    async def ok_check(png, facts, user):
        return {"ok": True, "problems": []}
    monkeypatch.setattr(C, "check_portrait", ok_check)
    shots = []
    async def regen(prompt, user, reference_png=None, keep_identity=True):
        shots.append(prompt)
        return _png()
    monkeypatch.setattr(op, "_generate_one", regen)
    png, meta = _run(op._portrait_check_pass(_png(border=14), "p Setting: x. The moment: y.", "u", None))
    assert len(shots) == 1 and "Fix in this version: a photograph that runs to all four edges" in shots[0]
    assert meta["reshot"] is True and meta["ok"] is True and not C.has_border(png)
    # a clean photo is left alone and costs nothing more
    shots.clear()
    png2, meta2 = _run(op._portrait_check_pass(_png(), "p", "u", None))
    assert shots == [] and meta2 == {"ok": True, "problems": [], "reshot": False}


def test_the_prompt_closers_forbid_frames_and_borders(tmp_path):
    import re
    src = open(importlib.import_module("src.orwell_photo_brief").__file__.replace("frontend/src/orwell_photo_brief.py", "src/engine/portraitPrompts.ts")).read()
    assert src.count("The picture runs to all four edges") == 3          # press, documentary, minimal


def test_a_hair_signature_overrides_the_hair_line_and_is_not_listed_twice():
    B = importlib.import_module("src.orwell_photo_brief")
    floor = ("An opener. The subject is a 30-year-old woman. Face: round. Hair: long straight black hair pulled into one braid over a shoulder (the cut as written: long, black, braided down the back; "
             "exactly that length and volume, no longer or bigger). Wearing a grey tee. Setting: a dock. Light: dusk. The moment: a grin. Framing, the same for the whole series: a half-length portrait. "
             "The only person in the frame; no text or logos.")
    brief = {"where": "the clam dock behind her shop in Cedar Key", "doing": "coiling a rope", "inFrame": ["a rope coil", "a tackle box"], "wear": "a work jacket, jeans",
             "signature": "long straight jet-black hair worn down past the shoulders", "timeLight": "dusk", "why": '"x"', "tie": '"y"'}
    out = B.compose_prompt(floor, brief)
    assert "Hair: long straight jet-black hair worn down past the shoulders, exactly as the sheet says, worn this way whatever the person is doing." in out
    assert "braid" not in out and out.count("jet-black hair") == 1
    assert "In the frame, theirs: a rope coil and a tackle box." in out and "Wearing a work jacket, jeans, in their own" in out
    # a non-hair signature leaves the hair line alone
    other = B.compose_prompt(floor, {**brief, "signature": "a brass whistle on a cord"})
    assert "pulled into one braid" in other and "a brass whistle on a cord" in other
    assert B.is_hair_signature("a shaved head kept immaculate") and not B.is_hair_signature("a dark green beanie") and "Never change their hair or its styling" in B.SYSTEM
