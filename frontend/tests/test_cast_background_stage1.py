"""Casting in the background, stage 1: each failed face retries on its own (no 10-minute debounce), the image slot is
released before the vision check, the check-driven reshoot count is a setting (default = today's), and the faces in the
opening scene are shot first."""
import asyncio
import importlib

import pytest

P = importlib.import_module("src.orwell_portraits")
C = importlib.import_module("src.orwell_portrait_check")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _until(cond, timeout=3.0):
    async def _w():
        t = 0.0
        while not cond() and t < timeout:
            await asyncio.sleep(0.01)
            t += 0.01
        return cond()
    return _run(_w())


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(P, "PORTRAITS_DIR", tmp_path / "portraits")
    monkeypatch.setattr(P, "PORTRAIT_LOG_PATH", tmp_path / "log.jsonl")
    monkeypatch.setattr(P, "image_generation_available", lambda user: True)
    monkeypatch.setattr(P, "image_gen_disabled", lambda: False)
    monkeypatch.setattr(P, "portrait_parallel", lambda user=None: 3)
    P._INFLIGHT.clear()
    P._GEN_PROGRESS.clear()
    P._IMAGE_GATES.clear()
    P._FACE_RETRY.clear()
    P._OPENING_IDS.clear()
    yield tmp_path
    P.cancel_face_retries("u")
    P._FACE_RETRY.clear()
    P._OPENING_IDS.clear()


def _prompts(n):
    return [{"houseguestId": f"npc:{i}", "name": f"G{i}", "prompt": f"prompt {i}"} for i in range(1, n + 1)]


# ── 4. the per-photo retry queue ──────────────────────────────────────────────

def test_a_failed_face_retries_on_its_own_without_the_debounce(env, monkeypatch):
    monkeypatch.setattr(P, "FACE_RETRY_WAITS_S", (0.02, 0.02, 0.02))
    attempts = {"n": 0}

    async def gen(prompt, user, reference_png=None, keep_identity=True):
        attempts["n"] += 1
        if attempts["n"] <= 2:
            P._note_gen_error("http-500")
            return None
        return b"PNG"

    async def fake_backfill(ids, user):
        return await P.generate_and_store(_prompts(1), user, record_beats=False)

    monkeypatch.setattr(P, "_generate_one", gen)
    monkeypatch.setattr(P, "backfill_missing", fake_backfill)
    monkeypatch.setattr(P, "_portrait_check_pass", lambda png, *a, **k: _ret(png))
    # the lazy-path debounce is closed, as it is for ten minutes after any kick: the retry must not need it
    P._LAST_BACKFILL_AT["u"] = __import__("time").time()
    assert P.backfill_allowed("u") is False
    _run(P.generate_and_store(_prompts(1), "u", record_beats=False))
    assert P.face_retry_pending("u") == ["npc_1"]
    assert _until(lambda: P.portrait_file("u", "npc:1") is not None)
    assert attempts["n"] == 3  # first shot + two timed retries
    assert _until(lambda: P.face_retry_pending("u") == [])


async def _ret(png):
    return png, None


def test_a_billing_refusal_is_not_queued_but_an_in_flight_402_is(env):
    async def go():
        return [P._schedule_face_retry("u", "npc:1", "http-402", "Insufficient credits"),
                P._schedule_face_retry("u", "npc:2", "http-402", "would exceed your credits given your in-flight requests"),
                P._schedule_face_retry("u", "npc:2", "http-500"),  # one timer per face
                P._schedule_face_retry("u", "player", "http-500")]
    assert _run(go()) == [False, True, False, False]


def test_the_queue_gives_up_after_its_schedule(env, monkeypatch):
    monkeypatch.setattr(P, "FACE_RETRY_WAITS_S", (0.01, 0.01))
    calls = []

    async def never(ids, user):
        calls.append(ids)
        P._schedule_face_retry(user, ids[0], "http-500")

    monkeypatch.setattr(P, "backfill_missing", never)
    async def start():
        P._schedule_face_retry("u", "npc:1", "http-500")
    _run(start())
    assert _until(lambda: len(calls) == 2)
    _run(asyncio.sleep(0.1))
    assert len(calls) == 2 and P.face_retry_pending("u") == []


# ── 5. the slot is released before the vision check; the reshoot cap ───────────

def test_the_slot_is_released_before_the_vision_check(env, monkeypatch):
    monkeypatch.setattr(P, "portrait_parallel", lambda user=None: 1)  # one slot: a check holding it would serialize everything
    log = []

    async def gen(prompt, user, reference_png=None, keep_identity=True):
        log.append(("gen", prompt))
        await asyncio.sleep(0.02)
        return b"PNG"

    async def check(png, prompt, user, ref, retry_of=None, upgrade=False):
        log.append(("check-start", prompt))
        await asyncio.sleep(0.3)
        log.append(("check-end", prompt))
        return png, {"ok": True, "problems": [], "reshot": False}

    monkeypatch.setattr(P, "_generate_one", gen)
    monkeypatch.setattr(P, "_portrait_check_pass", check)
    _run(P.generate_and_store(_prompts(2), "u", record_beats=False))
    i = log.index(("gen", "prompt 2"))
    assert i < log.index(("check-end", "prompt 1"))  # the second shot began while the first was still being checked


def test_the_reshoot_cap_default_is_todays_behaviour(env):
    assert P.check_reshoot_cap() == 1 + P.PHOTO_CHECK_RETRY_BOUND == 3
    assert P.photo_check_retry_bound() == P.PHOTO_CHECK_RETRY_BOUND


def _failing_check(monkeypatch):
    async def check_portrait(png, facts, user):
        return {"ok": False, "problems": ["wrong-age"]}

    monkeypatch.setattr(C, "check_portrait", check_portrait)
    monkeypatch.setattr(C, "check_enabled", lambda user=None: True)
    monkeypatch.setattr(C, "has_border", lambda png: False)
    shots = []

    async def gen(prompt, user, reference_png=None, keep_identity=True):
        shots.append(prompt)
        return b"PNG"

    monkeypatch.setattr(P, "_generate_one", gen)
    return shots


def test_default_cap_reshoots_once_in_pass(env, monkeypatch):
    shots = _failing_check(monkeypatch)
    _png, meta = _run(P._portrait_check_pass(b"PNG", "Subject prompt", "u", None))
    assert len(shots) == 1 and meta["reshot"] is True


def test_a_cap_of_zero_turns_check_driven_reshoots_off(env, monkeypatch):
    shots = _failing_check(monkeypatch)
    monkeypatch.setattr(P, "check_reshoot_cap", lambda user=None: 0)
    _png, meta = _run(P._portrait_check_pass(b"PNG", "Subject prompt", "u", None))
    assert shots == [] and meta["reshot"] is False and meta["ok"] is False


def test_a_cap_of_one_leaves_no_upgrader_retries(env, monkeypatch):
    monkeypatch.setattr(P, "check_reshoot_cap", lambda user=None: 1)
    assert P.photo_check_retry_bound() == 0
    assert P.check_retry_ids({"npc_1": {"check": {"ok": False}, "source": "generated"}}) == []


# ── 6. opening-scene faces first ───────────────────────────────────────────────

def test_opening_scene_faces_are_granted_slots_first(env, monkeypatch):
    monkeypatch.setattr(P, "portrait_parallel", lambda user=None: 1)
    order = []

    async def gen_slot(sid):
        tok = P._CURRENT_HID.set(sid)
        try:
            async with P.image_gate().slot("u"):
                order.append(sid)
                await asyncio.sleep(0.01)
        finally:
            P._CURRENT_HID.reset(tok)

    async def go():
        gate = P.image_gate()
        hold = gate.slot("u")
        await hold.__aenter__()  # the one slot is busy while everyone queues up
        tasks = [asyncio.ensure_future(gen_slot(f"npc_{i}")) for i in range(1, 6)]
        await asyncio.sleep(0.05)
        P.set_opening_ids("u", ["npc:4", "npc:5"])  # the engine says who is in the opening scene
        await hold.__aexit__(None, None, None)
        await asyncio.gather(*tasks)

    _run(go())
    assert order[:2] == ["npc_4", "npc_5"]
    assert order[2:] == ["npc_1", "npc_2", "npc_3"]


# ── 7. the honest progress cue ──────────────────────────────────────────────────

def test_cast_progress_reports_only_what_is_true(env, monkeypatch):
    from src import orwell_prewarm as W
    W.reset()
    assert W.cast_progress("u") == {"phase": "none"}
    st = W._state("u")
    st.author_started = True
    st.prompts = [{"houseguestId": f"npc:{i}", "prompt": "p"} for i in (1, 2, 3)]
    for i in (1, 2, 3):
        st.npc_event(f"npc:{i}")
    assert W.cast_progress("u")["phase"] == "authoring"
    st.author_done.set()
    for i in (1, 2, 3):
        st.npc_event(f"npc:{i}").set()
    have = {"npc:1"}
    fake = type("F", (), {"portrait_file": staticmethod(lambda u, h: "x" if h in have else None),
                          "face_retry_pending": staticmethod(lambda u: [])})
    out = W.cast_progress("u", portraits=fake)
    assert (out["phase"], out["authored"], out["faces"], out["total"]) == ("faces", 3, 1, 3)
    have.update({"npc:2", "npc:3"})
    assert W.cast_progress("u", portraits=fake)["phase"] == "ready"
    W.reset()


def test_the_front_end_cue_reads_the_counts_endpoint_and_invents_nothing():
    from pathlib import Path
    js = (Path(__file__).resolve().parent.parent / "static" / "js" / "orwellOnboarding.js").read_text()
    assert "/api/orwell/cast-progress" in js and "_castCueStart()" in js
    assert "p.faces" in js and "p.total" in js
    assert "Math.random" not in js[js.index("_castCueText"):js.index("_castCueStart")]
