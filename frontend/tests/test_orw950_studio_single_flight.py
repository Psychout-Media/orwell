"""ORW-950 — the headshot studio runs one generation per player at a time.

A page reload aborted the browser request but not the server run; the next run cleared the
files the first had written. Roles only; the image generator is faked.
"""

import asyncio
import importlib
import io

import pytest
from PIL import Image

op = importlib.import_module("src.orwell_portraits")


def _img():
    b = io.BytesIO(); Image.new("RGB", (64, 64), (70, 90, 110)).save(b, "PNG"); return b.getvalue()


@pytest.fixture
def tmp(tmp_path, monkeypatch):
    monkeypatch.setattr(op, "PORTRAITS_DIR", tmp_path / "portraits")
    monkeypatch.setattr(op, "AVATARS_DIR", tmp_path / "avatars")
    monkeypatch.setattr(op, "HEADSHOTS_DIR", tmp_path / "headshots")
    monkeypatch.setattr(op, "PORTRAIT_LOG_PATH", tmp_path / "portrait-log.jsonl")
    monkeypatch.setattr(op, "image_generation_available", lambda u: True)
    op._STUDIO_RUNS.clear() if hasattr(op, "_STUDIO_RUNS") else None
    op.save_player_intake("u", _img(), "reference")
    return tmp_path


def test_overlapping_calls_share_one_run(tmp, monkeypatch):
    calls = []

    async def gen(prompt, user, reference_png=None):
        calls.append(prompt)
        await asyncio.sleep(0.01)
        return b"\x89PNG-" + str(len(calls)).encode()
    monkeypatch.setattr(op, "_generate_one", gen)

    async def go():
        return await asyncio.gather(op.generate_studio_candidates("u", 3),
                                    op.generate_studio_candidates("u", 3))
    a, b = asyncio.run(go())
    assert len(calls) == 3
    assert a == b == {"generated": 3}
    assert op.candidate_count("u") == 3


def test_second_run_keeps_first_files_until_it_writes(tmp, monkeypatch):
    op._intake_dir("u").mkdir(parents=True, exist_ok=True)
    old = op._candidate_path("u", 0)
    old.write_bytes(b"old")
    seen = []

    async def gen(prompt, user, reference_png=None):
        seen.append(old.exists())  # still there while the new run is generating
        return b"new"
    monkeypatch.setattr(op, "_generate_one", gen)
    asyncio.run(op.generate_studio_candidates("u", 1))
    assert seen == [True]
    assert old.read_bytes() == b"new"


def test_failed_run_keeps_earlier_candidates_and_later_run_works(tmp, monkeypatch):
    op._intake_dir("u").mkdir(parents=True, exist_ok=True)
    op._candidate_path("u", 0).write_bytes(b"old")
    state = {"boom": True}

    async def gen(prompt, user, reference_png=None):
        if state["boom"]:
            raise RuntimeError("provider down")
        return b"new"
    monkeypatch.setattr(op, "_generate_one", gen)

    async def go():
        with pytest.raises(RuntimeError):
            await op.generate_studio_candidates("u", 2)
        assert op._candidate_path("u", 0).read_bytes() == b"old"
        assert not op.studio_generating("u")
        state["boom"] = False
        return await op.generate_studio_candidates("u", 2)
    assert asyncio.run(go()) == {"generated": 2}


def test_status_reports_generating(tmp, monkeypatch):
    async def gen(prompt, user, reference_png=None):
        await asyncio.sleep(0.02)
        return b"x"
    monkeypatch.setattr(op, "_generate_one", gen)

    async def go():
        t = asyncio.ensure_future(op.generate_studio_candidates("u", 1))
        await asyncio.sleep(0)
        mid = op.intake_status("u")["generating"]
        await t
        return mid, op.intake_status("u")["generating"]
    assert asyncio.run(go()) == (True, False)
