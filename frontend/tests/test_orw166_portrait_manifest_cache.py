"""ORW-166: the roster poll calls portrait_ref once per houseguest; manifest.json / cast.json are now parsed once per file CHANGE (stat-validated), not once per card. No model calls."""
import importlib
import json

import pytest

portraits = importlib.import_module("src.orwell_portraits")


@pytest.fixture
def tmp_portraits(tmp_path, monkeypatch):
    monkeypatch.setattr(portraits, "PORTRAITS_DIR", tmp_path / "portraits")
    portraits._JSON_CACHE.clear()
    yield tmp_path / "portraits"
    portraits._JSON_CACHE.clear()


def _seed(user, ids):
    d = portraits.user_portrait_dir(user)
    d.mkdir(parents=True, exist_ok=True)
    man = {}
    for i in ids:
        (d / f"{i}.png").write_bytes(b"x")
        man[i] = {"file": f"{i}.png", "name": "n"}
    portraits._save_manifest(user, man)


def test_roster_of_sixteen_parses_the_manifest_once(tmp_portraits, monkeypatch):
    ids = [f"npc{i}" for i in range(16)]
    _seed("bob", ids)
    portraits._JSON_CACHE.clear()
    opens = []
    real_load = json.load

    def counting_load(f, *a, **k):
        opens.append(getattr(f, "name", "?"))
        return real_load(f, *a, **k)
    monkeypatch.setattr(portraits.json, "load", counting_load)
    refs = [portraits.portrait_ref("bob", i) for i in ids]
    assert all(r and r.startswith("/api/orwell/portrait/") for r in refs)
    assert sum(1 for n in opens if str(n).endswith("manifest.json")) == 1  # was 16


def test_a_changed_manifest_is_seen_immediately(tmp_portraits):
    _seed("bob", ["npc1"])
    assert portraits.portrait_ref("bob", "npc1")
    assert portraits.portrait_ref("bob", "npc2") is None
    _seed("bob", ["npc1", "npc2"])  # os.replace -> new inode: the cache must not serve the old parse
    assert portraits.portrait_ref("bob", "npc2")


def test_a_scrubbed_file_and_a_missing_manifest_are_not_cached(tmp_portraits):
    _seed("bob", ["npc1"])
    assert portraits.portrait_ref("bob", "npc1")
    (portraits.user_portrait_dir("bob") / "npc1.png").unlink()
    assert portraits.portrait_ref("bob", "npc1") is None  # the file check stays live
    assert portraits.load_manifest("nobody") == {}
    _seed("nobody", ["npc9"])
    assert "npc9" in portraits.load_manifest("nobody")


def test_callers_cannot_poison_the_cache(tmp_portraits):
    _seed("bob", ["npc1"])
    m = portraits.load_manifest("bob")
    m["npc1"]["file"] = "evil.png"
    m["extra"] = {}
    again = portraits.load_manifest("bob")
    assert again["npc1"]["file"] == "npc1.png" and "extra" not in again
