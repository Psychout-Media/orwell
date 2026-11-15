"""ORW-389: portrait log and error cleanup. The GPT Image cost line names the houseguest; a Gemini
fallback success clears the red gpt-image-failed reason and logs "fallback used" once; two concurrent
failures keep their own reasons; after a 429 the rest of a run is strictly one at a time.
Providers are stubbed (no network, no spend)."""

import asyncio
import importlib
import logging

import pytest

op = importlib.import_module("src.orwell_portraits")
t362 = importlib.import_module("test_orw362_gpt_image_route")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(op, "PORTRAITS_DIR", tmp_path / "portraits")
    monkeypatch.setattr(op, "PORTRAIT_LOG_PATH", tmp_path / "log.jsonl")  # ORW-437: every generation writes the attempt log
    monkeypatch.setattr(op, "image_generation_available", lambda user: True)
    monkeypatch.setattr(op, "image_gen_disabled", lambda: False)
    monkeypatch.setattr(op, "portrait_parallel", lambda user=None: 3)
    op._INFLIGHT.clear()
    op._GEN_PROGRESS.clear()
    op._set_gen_state(None, None)
    return tmp_path


def _prompts(n):
    return [{"houseguestId": f"npc:{i}", "name": f"G{i}", "prompt": f"prompt {i}"} for i in range(1, n + 1)]


def _no_check(monkeypatch, verdicts=None):
    from src import orwell_portrait_check as C

    async def fake(png, facts, user):
        return verdicts.pop(0) if verdicts else None
    monkeypatch.setattr(C, "check_portrait", fake)


def test_cost_line_names_the_houseguest(env, monkeypatch, caplog):
    c = t362._Client(t362._ok(b"GPT", usage={"cost": 0.04}))
    t362._setup(monkeypatch, t362.GPT, c)
    _no_check(monkeypatch)
    caplog.set_level(logging.INFO, logger="src.orwell_portraits")
    _run(op.generate_and_store(_prompts(1), "u", record_beats=False))
    lines = [r.getMessage() for r in caplog.records if "gpt-image" in r.getMessage() and "cost" in r.getMessage()]
    assert len(lines) == 1 and "npc_1" in lines[0] and t362.GPT in lines[0] and "0.04" in lines[0]


def test_photo_check_and_reshoot_lines_name_the_houseguest(env, monkeypatch, caplog):
    c = t362._Client(t362._ok(b"GPT"))
    t362._setup(monkeypatch, t362.GPT, c)
    _no_check(monkeypatch, [{"ok": False, "problems": ["hair"]}, {"ok": True, "problems": []}])
    caplog.set_level(logging.INFO, logger="src.orwell_portraits")
    _run(op.generate_and_store(_prompts(1), "u", record_beats=False))
    msgs = [r.getMessage() for r in caplog.records]
    assert any("photo check for npc_1" in m for m in msgs)
    assert any("photo re-shoot for npc_1" in m for m in msgs)


def test_fallback_success_clears_reason_and_logs_once(env, monkeypatch, caplog):
    c = t362._Client(t362._Resp(502, {}, text="x"))
    t362._setup(monkeypatch, t362.GPT, c)
    _no_check(monkeypatch)
    red = []
    monkeypatch.setattr(op, "_note_generation_failure", lambda *a, **k: red.append(a))
    caplog.set_level(logging.INFO, logger="src.orwell_portraits")
    out = _run(op.generate_and_store(_prompts(1), "u", record_beats=False))
    assert out["generated"] == 1 and red == []
    assert op._peek_gen_error()[0] is None
    used = [r.getMessage() for r in caplog.records if "fallback used" in r.getMessage()]
    assert len(used) == 1 and "npc_1" in used[0]


def test_concurrent_failures_keep_their_own_reasons(env, monkeypatch):
    async def fake(prompt, user, reference_png=None, keep_identity=True):
        slow = "prompt 1" in prompt
        await asyncio.sleep(0.01 if slow else 0.0)
        op._note_gen_error("http-500" if slow else "http-503", "d1" if slow else "d2")
        await asyncio.sleep(0.05 if slow else 0.02)  # the other task notes in the middle
        return None

    monkeypatch.setattr(op, "_generate_one", fake)
    seen = {}
    monkeypatch.setattr(op, "log_attempt", lambda hid, ok, err=None, ms=0, **kw: seen.__setitem__(hid, (err, kw.get("detail"))))
    _run(op.generate_and_store(_prompts(2), "u", record_beats=False))
    assert seen == {"npc:1": ("http-500", "d1"), "npc:2": ("http-503", "d2")}


def test_429_runs_the_rest_strictly_one_at_a_time(env, monkeypatch):
    live = {"n": 0}
    started = []  # (call number, tasks already running when it started, had the 429 landed)
    landed = {"v": False}

    async def fake(prompt, user, reference_png=None, keep_identity=True):
        started.append((len(started) + 1, live["n"], landed["v"]))
        live["n"] += 1
        await asyncio.sleep(0.05)
        live["n"] -= 1
        if prompt == "prompt 1":
            landed["v"] = True
            op._note_gen_error("http-429")
            return None
        return b"x"

    monkeypatch.setattr(op, "_generate_one", fake)
    _no_check(monkeypatch)  # ORW-437: fake images must never reach the real vision-provider path
    out = _run(op.generate_and_store(_prompts(9), "u", record_beats=False))
    assert out["generated"] == 8
    after = [s for s in started if s[2]]
    assert len(after) >= 3  # the tail really did run after the 429
    assert all(running == 0 for _, running, _ in after)  # each started alone
    assert max(r for _, r, _ in started) <= 2  # never more than 3 in flight
