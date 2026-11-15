"""ORW-378: portraits generate up to `portrait_parallel` at once; the background upgrader goes wide only
when nobody is playing; a provider 429 drops a run to one at a time."""

import asyncio
import importlib
import time

import pytest

P = importlib.import_module("src.orwell_portraits")
U = importlib.import_module("src.orwell_portrait_upgrade")
engine = importlib.import_module("src.orwell_engine")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(P, "PORTRAITS_DIR", tmp_path / "portraits")
    monkeypatch.setattr(P, "image_generation_available", lambda user: True)
    monkeypatch.setattr(P, "image_gen_disabled", lambda: False)
    monkeypatch.setattr(P, "portrait_parallel", lambda user=None: 3)
    P._INFLIGHT.clear()
    P._GEN_PROGRESS.clear()
    U._STATE.clear()
    U._BUSY.clear()
    return tmp_path


def _prompts(n):
    return [{"houseguestId": f"npc:{i}", "name": f"G{i}", "prompt": f"prompt {i}"} for i in range(1, n + 1)]


def _gen(monkeypatch, delay=0.05, fail=(), code="http-500"):
    live = {"n": 0, "max": 0}

    async def fake(prompt, user, reference_png=None, keep_identity=True):
        live["n"] += 1
        live["max"] = max(live["max"], live["n"])
        await asyncio.sleep(delay)
        live["n"] -= 1
        if any(f in prompt for f in fail):
            P._note_gen_error(code)
            return None
        return b"PNG:" + prompt.encode()

    monkeypatch.setattr(P, "_generate_one", fake)
    return live


def test_setting_default_and_clamp(monkeypatch):
    from src import settings
    assert settings.DEFAULT_SETTINGS["portrait_parallel"] == 3
    monkeypatch.undo()
    for raw, want in ((3, 3), (0, 1), (-5, 1), (9, 4), ("2", 2), ("junk", 3)):
        monkeypatch.setattr(settings, "get_setting", lambda k, d=None, raw=raw: raw)
        assert P.portrait_parallel("u") == want


def test_cast_of_six_runs_three_at_once(env, monkeypatch):
    live = _gen(monkeypatch, delay=0.2, fail=("prompt 4",))
    t0 = time.monotonic()
    out = _run(P.generate_and_store(_prompts(6), "u", record_beats=False))
    wall = time.monotonic() - t0
    assert live["max"] == 3
    assert wall < 0.2 * 2 + 0.3  # two batches, not six
    assert (out["generated"], out["skipped"], out["total"]) == (5, 1, 6)
    m = P.load_manifest("u")
    assert sorted(m) == ["npc_1", "npc_2", "npc_3", "npc_5", "npc_6"]  # the failure is isolated, no lost write
    assert all(e["promptVersion"] == P.PORTRAIT_PROMPT_VERSION for e in m.values())
    assert P.PORTRAIT_PROMPT_VERSION == 3


def test_all_six_manifest_entries_and_progress(env, monkeypatch):
    _gen(monkeypatch, delay=0.05)
    ticks = []
    orig = P._progress_tick
    monkeypatch.setattr(P, "_progress_tick", lambda user: (ticks.append(1), orig(user))[1])
    out = _run(P.generate_and_store(_prompts(6), "u", record_beats=False))
    assert out["generated"] == 6 and len(ticks) == 6
    m = P.load_manifest("u")
    assert len(m) == 6 and all(e["promptVersion"] == P.PORTRAIT_PROMPT_VERSION for e in m.values())


def test_429_drops_rest_of_run_to_one_at_a_time(env, monkeypatch):
    live = _gen(monkeypatch, delay=0.05, fail=("prompt 1",), code="http-429")
    out = _run(P.generate_and_store(_prompts(8), "u", record_beats=False))
    assert out["generated"] == 7
    # the first batch of 3 was already in flight; once the 429 lands everything after it is serial
    calls = {"n": 0}
    live2 = {"n": 0, "max": 0}

    async def fake(prompt, user, reference_png=None, keep_identity=True):
        calls["n"] += 1
        live2["n"] += 1
        live2["max"] = max(live2["max"], live2["n"])
        await asyncio.sleep(0.05)
        live2["n"] -= 1
        if calls["n"] == 1:
            P._note_gen_error("http-429")
            return None
        return b"x"

    monkeypatch.setattr(P, "_generate_one", fake)
    P.PORTRAITS_DIR = env / "p2"
    _run(P.generate_and_store(_prompts(12)[:9], "u2", record_beats=False))
    assert live2["max"] <= 3
    assert calls["n"] == 9


# ── the upgrader ──────────────────────────────────────────────────────────────────────────

def _season(monkeypatch, n=6):
    state = {"started": True, "player": {"id": "player", "name": "Me"},
             "house": [{"id": f"npc:{i}", "name": f"G{i}", "status": "active", "vocation": "t"} for i in range(1, n + 1)]}

    async def get_state(user=None, timeout=None):
        return state

    async def get_pp(hid, user=None):
        return {"houseguestId": hid, "name": "G" + hid.split(":")[1], "prompt": f"v2 {hid}"}

    monkeypatch.setattr(engine, "get_game_state", get_state)
    monkeypatch.setattr(engine, "get_portrait_prompt", get_pp)
    d = P.user_portrait_dir("u")
    d.mkdir(parents=True)
    m = {}
    for i in range(1, n + 1):
        (d / f"npc_{i}.png").write_bytes(b"old")
        m[f"npc_{i}"] = {"file": f"npc_{i}.png", "name": f"G{i}", "source": "generated", "promptVersion": 1}
    P._save_manifest("u", m)
    monkeypatch.setattr(U, "look_fill_supported", lambda: False)


def _live(monkeypatch, value):
    async def f():
        return value
    monkeypatch.setattr(U, "game_is_live", f)


def test_idle_upgrades_three_at_once_with_no_gap(env, monkeypatch):
    _season(monkeypatch)
    _live(monkeypatch, False)
    live = _gen(monkeypatch, delay=0.1)
    assert _run(U.upgrade_tick("u", now=0.0)) == "waiting"  # arms the 45 s quiet window
    assert _run(U.upgrade_tick("u", now=1000.0)) == "upgraded"
    assert live["max"] == 3
    st = U._st("u")
    assert st["done"] == 3 and st["next_ok_at"] == 1000.0
    assert _run(U.upgrade_tick("u", now=1000.0)) == "upgraded"  # no 15 s wait
    assert U._st("u")["done"] == 6


def test_live_game_one_at_a_time_with_gap(env, monkeypatch):
    _season(monkeypatch)
    _live(monkeypatch, True)
    live = _gen(monkeypatch, delay=0.01)
    assert _run(U.upgrade_tick("u", now=0.0)) == "waiting"
    assert _run(U.upgrade_tick("u", now=1000.0)) == "upgraded"
    assert live["max"] == 1 and U._st("u")["done"] == 1
    assert U._st("u")["next_ok_at"] == 1000.0 + U.GAP_S
    assert _run(U.upgrade_tick("u", now=1005.0)) == "waiting"
    assert _run(U.upgrade_tick("u", now=1000.0 + U.GAP_S)) == "upgraded"


def test_429_in_upgrader_drops_to_one_at_a_time(env, monkeypatch):
    _season(monkeypatch)
    _live(monkeypatch, False)
    live = _gen(monkeypatch, delay=0.05, fail=("npc:1",), code="http-429")
    _run(U.upgrade_tick("u", now=0.0))
    _run(U.upgrade_tick("u", now=1000.0))
    st = U._st("u")
    assert st["rate_limited"] is True and st["failed"] == 1 and st["done"] == 2
    live["max"] = 0
    _run(U.upgrade_tick("u", now=1000.0))
    assert live["max"] == 1  # one at a time for the rest of the run
