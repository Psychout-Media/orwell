"""ORW-414: two stacks booting together share frontend/data/.app_key (it sits outside the per-stack data dir). The key must be published atomically: no reader sees a partial key, and
racing creators all end with the SAME key (first writer wins)."""
import importlib
import multiprocessing
import os
import stat

import pytest


def _fresh(tmp_path, monkeypatch):
    import src.secret_storage as ss
    monkeypatch.setattr(ss, "_KEY_PATH", tmp_path / "data" / ".app_key")
    return ss


def test_creates_a_complete_owner_only_key_and_leaves_no_temp_file(tmp_path, monkeypatch):
    ss = _fresh(tmp_path, monkeypatch)
    key = ss._load_or_create_key()
    assert ss._KEY_PATH.read_bytes() == key and len(key) == 44
    assert stat.S_IMODE(os.stat(ss._KEY_PATH).st_mode) == 0o600
    assert [p.name for p in ss._KEY_PATH.parent.iterdir()] == [".app_key"]


def test_an_existing_key_is_returned_unchanged(tmp_path, monkeypatch):
    ss = _fresh(tmp_path, monkeypatch)
    ss._KEY_PATH.parent.mkdir(parents=True)
    ss._KEY_PATH.write_bytes(b"x" * 44)
    assert ss._load_or_create_key() == b"x" * 44


def test_a_lost_race_returns_the_winners_key(tmp_path, monkeypatch):
    ss = _fresh(tmp_path, monkeypatch)
    real_link = os.link

    def racing_link(src, dst, *a, **k):
        # another process publishes its key first, between our temp write and our publish
        with open(dst, "wb") as fh:
            fh.write(b"w" * 44)
        return real_link(src, dst, *a, **k)  # raises FileExistsError

    monkeypatch.setattr(os, "link", racing_link)
    assert ss._load_or_create_key() == b"w" * 44
    assert ss._KEY_PATH.read_bytes() == b"w" * 44
    assert [p.name for p in ss._KEY_PATH.parent.iterdir()] == [".app_key"]


def _create(path, out):
    import src.secret_storage as ss
    from pathlib import Path
    ss._KEY_PATH = Path(path)
    out.put(ss._load_or_create_key())


def test_many_processes_creating_at_once_agree_on_one_key(tmp_path):
    ctx = multiprocessing.get_context("fork")
    q = ctx.Queue()
    path = str(tmp_path / "data" / ".app_key")
    ps = [ctx.Process(target=_create, args=(path, q)) for _ in range(8)]
    [p.start() for p in ps]
    keys = {q.get(timeout=30) for _ in ps}
    [p.join(30) for p in ps]
    assert len(keys) == 1, "racing creators ended with different keys"
    assert open(path, "rb").read() in keys


def _no_links(monkeypatch):
    def nolink(*a, **k):
        raise OSError("hard links unavailable")
    monkeypatch.setattr(os, "link", nolink)


def test_no_link_fallback_never_overwrites_a_key_published_meanwhile(tmp_path, monkeypatch):
    ss = _fresh(tmp_path, monkeypatch)
    real_open = os.open
    state = {"done": False}

    def racing_open(path, flags, *a, **k):
        # another process publishes its key after our link attempt, before our publish
        if str(path) == str(ss._KEY_PATH) and not state["done"]:
            state["done"] = True
            with open(path, "wb") as fh:
                fh.write(b"w" * 44)
        return real_open(path, flags, *a, **k)

    _no_links(monkeypatch)
    monkeypatch.setattr(os, "open", racing_open)
    assert ss._load_or_create_key() == b"w" * 44
    assert ss._KEY_PATH.read_bytes() == b"w" * 44
    assert [p.name for p in ss._KEY_PATH.parent.iterdir()] == [".app_key"]


def test_no_link_happy_path_creates_one_owner_only_key(tmp_path, monkeypatch):
    ss = _fresh(tmp_path, monkeypatch)
    _no_links(monkeypatch)
    key = ss._load_or_create_key()
    assert len(key) == 44 and ss._KEY_PATH.read_bytes() == key
    assert stat.S_IMODE(os.stat(ss._KEY_PATH).st_mode) == 0o600
    assert ss._load_or_create_key() == key
    assert [p.name for p in ss._KEY_PATH.parent.iterdir()] == [".app_key"]


def test_no_link_empty_racing_file_is_not_returned_as_a_key(tmp_path, monkeypatch):
    ss = _fresh(tmp_path, monkeypatch)
    real_open = os.open
    real_sleep = ss.time.sleep
    state = {"done": False}

    def racing_open(path, flags, *a, **k):
        if str(path) == str(ss._KEY_PATH) and not state["done"]:
            state["done"] = True
            open(path, "wb").close()  # winner created the file but has not written yet
        return real_open(path, flags, *a, **k)

    def finishing_sleep(_):
        ss._KEY_PATH.write_bytes(b"w" * 44)  # winner's write lands while we wait
        real_sleep(0)

    _no_links(monkeypatch)
    monkeypatch.setattr(os, "open", racing_open)
    monkeypatch.setattr(ss.time, "sleep", finishing_sleep)
    assert ss._load_or_create_key() == b"w" * 44
