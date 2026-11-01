"""R-VLT-7 — Knowledge-wall guard fails closed (issue #1872).

Ensures that when the per-source or total manifest fetch fails, the knowledge wall:
- Logs at WARNING level and calls record_soft_failure (RED-eligible) on every failure path
- Returns last-known-good cached facts on TOTAL failure (outer except block)
- On per-source failure, continues trying the other source
- Does NOT overwrite the cache with empty facts on total failure
- On per-source-only failure (one source ok, the other down), returns the success source's data
"""

import asyncio
import contextlib
import sys
import types
from importlib.abc import MetaPathFinder
from unittest.mock import AsyncMock, MagicMock, patch

# ── Import blocker for total-failure tests ────────────────────────────────────
# The function does `from src import orwell_engine` as a lazy import inside the
# outer try block. To make it fail, we need to prevent Python's import machinery
# from finding the real module on disk. A custom meta_path finder does this.

class _BlockFinder(MetaPathFinder):
    """Sys.meta_path finder that blocks a specific module by fullname."""
    def __init__(self, blocked: set):
        self._blocked = blocked
    def find_spec(self, fullname, path, target=None):
        if fullname in self._blocked:
            raise ImportError(f"Blocked by test: {fullname}")
        return None


@contextlib.contextmanager
def _block_imports(*names):
    """Context manager that blocks imports of the given dotted module names."""
    # The finder alone is not enough once ANOTHER test has already imported the module: `from pkg import
    # mod` is satisfied by the cached `sys.modules` entry / the package attribute without consulting
    # meta_path, so the "total failure" silently became a success (order-dependent flake). Hide both.
    finder = _BlockFinder(set(names))
    saved_mods, saved_attrs = {}, {}
    for full in names:
        if full in sys.modules:
            saved_mods[full] = sys.modules.pop(full)
        parent_name, _, child = full.rpartition(".")
        parent = sys.modules.get(parent_name)
        if parent is not None and child in vars(parent):
            saved_attrs[(parent_name, child)] = vars(parent)[child]
            delattr(parent, child)
    sys.meta_path.insert(0, finder)
    try:
        yield
    finally:
        sys.meta_path.remove(finder)
        sys.modules.update(saved_mods)
        for (parent_name, child), val in saved_attrs.items():
            setattr(sys.modules[parent_name], child, val)


import contextlib


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _get_chat_helpers():
    """Return the routes.chat_helpers module."""
    import routes.chat_helpers as ch
    return ch


def _fresh_engine() -> MagicMock:
    """A fresh mock orwell_engine with both async methods."""
    e = MagicMock()
    e.sealed_from_house = AsyncMock()
    e.knowledge_scope_manifest = AsyncMock()
    return e


def _src_module():
    """Return the src module (namespace package) from sys.modules."""
    return sys.modules.get("src")


# ════════════ Per-source sealed_from_house failure ═══════════════════════════

def test_per_source_sealed_from_house_failure_does_not_block_other_source():
    """When sealed_from_house raises, the knowledge-scope manifest is still fetched."""
    ch = _get_chat_helpers()
    user = "vlt7-psf-1"
    ch._KW_SEALED_CACHE.pop(ch._kw_key(user), None)

    engine = _fresh_engine()
    engine.sealed_from_house.side_effect = RuntimeError("engine hiccup")
    engine.knowledge_scope_manifest.return_value = [
        {"content": "scoped fact", "knownTo": ["someone"]}
    ]

    with patch.object(_src_module(), "orwell_engine", engine, create=True):
        with patch("routes.chat_helpers.record_soft_failure") as mock_rsf:
            facts = _run(ch.fetch_sealed_from_house(user))

    assert len(facts) == 1, f"Expected one fact, got {facts}"
    assert facts[0]["content"] == "scoped fact"
    mock_rsf.assert_called_once()
    anomaly = mock_rsf.call_args.args[0]
    assert anomaly == "knowledge-wall:sealed-from-house-fetch-failed"
    assert mock_rsf.call_args.kwargs.get("corrected") == "fail-closed:keep-last-good"
    assert mock_rsf.call_args.kwargs.get("user") == user


# ════════════ Per-source knowledge-scope-manifest failure ════════════════════

def test_per_source_ksm_failure_does_not_block_sealed_from_house():
    """When knowledge_scope_manifest raises, sealed_from_house is still fetched."""
    ch = _get_chat_helpers()
    user = "vlt7-psf-2"
    ch._KW_SEALED_CACHE.pop(ch._kw_key(user), None)

    engine = _fresh_engine()
    engine.sealed_from_house.return_value = [
        {"content": "dr secret", "knownTo": []}
    ]
    engine.knowledge_scope_manifest.side_effect = ConnectionError("ksm timeout")

    with patch.object(_src_module(), "orwell_engine", engine, create=True):
        with patch("routes.chat_helpers.record_soft_failure") as mock_rsf:
            facts = _run(ch.fetch_sealed_from_house(user))

    assert len(facts) == 1, f"Expected one fact, got {facts}"
    assert facts[0]["content"] == "dr secret"
    mock_rsf.assert_called_once()
    assert mock_rsf.call_args.args[0] == "knowledge-wall:knowledge-scope-manifest-fetch-failed"
    assert mock_rsf.call_args.kwargs.get("corrected") == "fail-closed:keep-last-good"
    assert mock_rsf.call_args.kwargs.get("user") == user


# ════════════ Outer except — import failure → cached facts ═══════════════════

def test_total_import_failure_returns_cached_facts():
    """When the import of orwell_engine fails (outer except), cached facts are returned."""
    ch = _get_chat_helpers()
    user = "vlt7-total-1"
    key = ch._kw_key(user)
    cached_facts = [
        {"content": "last known secret", "knownTo": ["someone"], "signatures": ["last known secret"]}
    ]
    ch._KW_SEALED_CACHE[key] = (0.0, cached_facts)

    with _block_imports("src.orwell_engine"):
        with patch("routes.chat_helpers.record_soft_failure") as mock_rsf:
            facts = _run(ch.fetch_sealed_from_house(user))

    assert facts == cached_facts, f"Expected cached_facts, got {facts}"
    mock_rsf.assert_called_once()
    assert mock_rsf.call_args.args[0] == "knowledge-wall:manifest-fetch-failed"
    assert mock_rsf.call_args.kwargs.get("corrected") == "fail-closed:keep-last-good"
    assert mock_rsf.call_args.kwargs.get("user") == user


# ════════════ Cache NOT overwritten with empty on total failure ═══════════════

def test_cache_not_overwritten_with_empty_on_total_failure():
    """On total failure (outer except), the cache entry preserves last-known-good."""
    ch = _get_chat_helpers()
    user = "vlt7-total-2"
    key = ch._kw_key(user)
    cached_facts = [
        {"content": "preserved secret", "knownTo": [], "signatures": ["preserved secret"]}
    ]
    ch._KW_SEALED_CACHE[key] = (0.0, cached_facts)

    with _block_imports("src.orwell_engine"):
        facts = _run(ch.fetch_sealed_from_house(user))

    assert facts == cached_facts, f"Expected cached_facts, got {facts}"
    entry = ch._KW_SEALED_CACHE.get(key)
    assert entry is not None
    assert entry[1] == cached_facts, (
        f"Cache overwritten: expected {cached_facts}, got {entry[1]}"
    )


# ════════════ First-call total failure (no prior cache) returns [] ═══════════

def test_total_failure_with_no_prior_cache_returns_empty():
    """On total failure with NO prior cache, return [] (game hasn't started)."""
    ch = _get_chat_helpers()
    user = "vlt7-first-call"
    key = ch._kw_key(user)
    ch._KW_SEALED_CACHE.pop(key, None)

    with _block_imports("src.orwell_engine"):
        facts = _run(ch.fetch_sealed_from_house(user))

    assert facts == [], f"Expected empty list, got {facts}"
    entry = ch._KW_SEALED_CACHE.get(key)
    assert entry is not None
    assert entry[1] == [], f"Expected empty list in cache, got {entry[1]}"


# ════════════ Per-source failure w/ one source succeeding ════════════════════

def test_per_source_failure_with_other_source_success():
    """A single-source failure doesn't block the other source's facts."""
    ch = _get_chat_helpers()
    user = "vlt7-mixed"
    ch._KW_SEALED_CACHE.pop(ch._kw_key(user), None)

    engine = _fresh_engine()
    engine.sealed_from_house.side_effect = RuntimeError("source1 down")
    engine.knowledge_scope_manifest.return_value = [
        {"content": "manifest fact", "knownTo": ["everyone"]}
    ]

    with patch.object(_src_module(), "orwell_engine", engine, create=True):
        with patch("routes.chat_helpers.record_soft_failure") as mock_rsf:
            facts = _run(ch.fetch_sealed_from_house(user))

    assert len(facts) == 1
    assert facts[0]["content"] == "manifest fact"
    mock_rsf.assert_called_once()
    assert mock_rsf.call_args.args[0] == "knowledge-wall:sealed-from-house-fetch-failed"
    assert mock_rsf.call_args.kwargs.get("corrected") == "fail-closed:keep-last-good"
    assert mock_rsf.call_args.kwargs.get("user") == user


# ════════════ Both per-sources fail — no outer except — returns [] ════════════

def test_both_per_source_fail_returns_last_good():
    """When BOTH sources fail, the last-good manifest is returned (not []) and the cache is preserved.
    Returning [] here silently switched the wall off for the turn — the pre-#1872 hole."""
    ch = _get_chat_helpers()
    user = "vlt7-both-fail"
    key = ch._kw_key(user)
    cached_facts = [
        {"content": "old cached", "knownTo": [], "signatures": ["old cached"]}
    ]
    ch._KW_SEALED_CACHE[key] = (0.0, cached_facts)

    engine = _fresh_engine()
    engine.sealed_from_house.side_effect = RuntimeError("both fail 1")
    engine.knowledge_scope_manifest.side_effect = RuntimeError("both fail 2")

    with patch.object(_src_module(), "orwell_engine", engine, create=True):
        with patch("routes.chat_helpers.record_soft_failure") as mock_rsf:
            facts = _run(ch.fetch_sealed_from_house(user))

    assert facts == cached_facts, f"Expected last-good cached facts, got {facts}"
    # Cache should still hold the OLD value (not overwritten)
    entry = ch._KW_SEALED_CACHE.get(key)
    assert entry is not None
    assert entry[1] == cached_facts, (
        f"Cache was overwritten: expected {cached_facts}, got {entry[1]}"
    )
    assert mock_rsf.call_count == 2
    classes = {call.args[0] for call in mock_rsf.call_args_list}
    assert classes == {
        "knowledge-wall:sealed-from-house-fetch-failed",
        "knowledge-wall:knowledge-scope-manifest-fetch-failed",
    }, f"Unexpected anomaly classes: {classes}"


# ════════════ A failed source keeps ITS OWN last-good facts ═══════════════════

def test_failed_source_contributes_its_own_last_good():
    """A source that answered last turn and fails this turn still contributes its last-good facts."""
    ch = _get_chat_helpers()
    user = "vlt7-src-last-good"
    key = ch._kw_key(user)
    ch._KW_SEALED_CACHE.pop(key, None)

    engine = _fresh_engine()
    engine.sealed_from_house.return_value = [{"content": "diary secret plan", "knownTo": []}]
    engine.knowledge_scope_manifest.return_value = [{"content": "scoped rumor detail", "knownTo": ["someone"]}]
    with patch.object(_src_module(), "orwell_engine", engine, create=True):
        first = _run(ch.fetch_sealed_from_house(user))
    assert {f["content"] for f in first} == {"diary secret plan", "scoped rumor detail"}

    ch._KW_SEALED_CACHE.pop(key, None)  # expire the TTL cache
    engine.sealed_from_house.side_effect = RuntimeError("blip")
    engine.knowledge_scope_manifest.return_value = [{"content": "fresh scoped detail", "knownTo": ["someone"]}]
    with patch.object(_src_module(), "orwell_engine", engine, create=True):
        with patch("routes.chat_helpers.record_soft_failure"):
            second = _run(ch.fetch_sealed_from_house(user))
    assert {f["content"] for f in second} == {"diary secret plan", "fresh scoped detail"}


def test_empty_answer_from_a_live_source_is_cached_as_truth():
    """An engine that ANSWERS with nothing sealed is a real empty manifest, not a failure."""
    ch = _get_chat_helpers()
    user = "vlt7-empty-truth"
    key = ch._kw_key(user)
    ch._KW_SEALED_CACHE[key] = (0.0, [{"content": "old", "knownTo": [], "signatures": ["old"]}])
    engine = _fresh_engine()
    engine.sealed_from_house.return_value = []
    engine.knowledge_scope_manifest.return_value = []
    with patch.object(_src_module(), "orwell_engine", engine, create=True):
        facts = _run(ch.fetch_sealed_from_house(user))
    assert facts == []
    assert ch._KW_SEALED_CACHE[key][1] == []


# ════════════ A season create/reset drops the last-good state ═════════════════

def test_season_reset_drops_previous_season_last_good():
    """A previous season's sealed facts must never be served as the next season's last-good."""
    ch = _get_chat_helpers()
    user = "vlt7-season-reset"
    key = ch._kw_key(user)
    ch._KW_SEALED_CACHE.pop(key, None)
    engine = _fresh_engine()
    engine.sealed_from_house.return_value = [{"content": "old season diary plan", "knownTo": []}]
    engine.knowledge_scope_manifest.return_value = []
    with patch.object(_src_module(), "orwell_engine", engine, create=True):
        _run(ch.fetch_sealed_from_house(user))
    assert (key, "sealed-from-house") in ch._KW_SOURCE_LAST_GOOD

    from src import orwell_engine as real_engine
    real_engine._notify_season_reset(user)  # what createCharacter / a sandbox reset fires
    assert key not in ch._KW_SEALED_CACHE
    assert not any(k[0] == key for k in ch._KW_SOURCE_LAST_GOOD)

    engine.sealed_from_house.side_effect = RuntimeError("blip right after the reset")
    engine.knowledge_scope_manifest.return_value = []
    with patch.object(_src_module(), "orwell_engine", engine, create=True):
        with patch("routes.chat_helpers.record_soft_failure"):
            facts = _run(ch.fetch_sealed_from_house(user))
    assert all(f["content"] != "old season diary plan" for f in facts)
