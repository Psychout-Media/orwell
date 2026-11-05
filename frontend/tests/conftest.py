"""Test setup for the app-admin feature (0029).

The vendored front-end's package `core/__init__.py` eagerly boots the whole app
(llm_core, the database, cryptography), which can't import in a bare test env. The
app-admin logic, though, lives entirely in the self-contained `core.auth` and
`core.middleware` modules. We load just those by stubbing the `core` package so its
heavy `__init__` never runs.
"""

import asyncio
import contextlib
import functools
import os
import pathlib
import sys
import tempfile
import types
import warnings
from collections.abc import Callable, Coroutine
from typing import Any

import pytest

FRONTEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE_DIR = os.path.join(FRONTEND_DIR, "core")

if FRONTEND_DIR not in sys.path:
    sys.path.insert(0, FRONTEND_DIR)

# Any test that imports a `core.database`-backed router (e.g. routes.model_routes for
# the agent-tools gating tests) transitively triggers core/database.py's module-load
# init_db(), which opens the app's DB. The default URL is the RELATIVE ./data/app.db,
# and CI's fresh checkout has no frontend/data/ dir → "unable to open database file".
# Point the ORM at a throwaway temp DB before that first import (conftest loads ahead of
# the test modules).
#
# Must be a FRESH temp DB PER PROCESS, not merely "per invocation" — under
# `pytest-xdist -n N` the controller process imports this conftest too (for
# collection), assigns its own tempdir via plain `setdefault`, and each worker
# subprocess then INHERITS that already-set `DATABASE_URL` from the controller's
# environment (subprocess env inheritance, independent of pytest/xdist's own
# machinery). A bare `setdefault` is therefore a no-op in every worker, and all N
# workers plus the controller silently converge on ONE shared sqlite file —
# concurrent test processes then race each other's inserts/deletes/table-clears
# against that single file (the exact intermittent
# `test_null_owner_endpoint_is_not_orphaned_and_is_adopted`-style cross-worker
# flake this guards against). Detect "the current value is one WE minted" (it
# carries our own tempdir marker, or is simply unset) and mint a brand new
# per-process tempdir in that case; a genuinely different, deliberately-configured
# `DATABASE_URL` (not carrying the marker) is still left untouched.
_AUTO_TEST_DB_MARKER = "orwell-test-db-"
_current_db_url = os.environ.get("DATABASE_URL", "")
# Leak fix (2026-11-04): every process (the xdist controller AND each worker) gets ONE private TMPDIR that is removed at exit, so the ~70 test files that
# `tempfile.mkdtemp(...)` (and this DB dir) can never pile up in the host's RAM-backed /tmp (thousands of `orwell-test-db-*` dirs had).
import atexit as _atexit
import shutil as _shutil

_RUN_TMP = tempfile.mkdtemp(prefix="orwell-run-")
os.environ["TMPDIR"] = _RUN_TMP
tempfile.tempdir = _RUN_TMP
_atexit.register(_shutil.rmtree, _RUN_TMP, ignore_errors=True)

if not _current_db_url or _AUTO_TEST_DB_MARKER in _current_db_url:
    os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(
        tempfile.mkdtemp(prefix=_AUTO_TEST_DB_MARKER), "app.db"
    )

# #1313 — the house-entry authoring gate (do_create_character) HOLDS game start until the cast is
# authored, and engages ONLY when a real utility model resolves. The FE suite stubs the LLM and must
# stay deterministic regardless of any ambient settings.json a dev may have locally, so default the
# operator escape hatch ON for the whole suite (byte-identical to the pre-gate immediate start). The
# dedicated gate tests `monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START")` + stub the model resolver to
# exercise the gate explicitly.
os.environ.setdefault("ORWELL_ALLOW_FLOOR_START", "1")

# Owner directive 2026-07-11 — the enrichment policy defaults to STRICT in production (loud failures,
# creation refusals on an unwired class; src/enrichment_policy.py). The FE suite stubs the LLM
# everywhere and its many fail-soft contracts ("absent ⇒ byte-identical deterministic floor") must
# stay green untouched, so the whole suite pins the LEGACY `soft` policy via the env seed — exactly
# like the floor-start hatch above. The dedicated strict tests (test_enrichment_policy.py) set the
# `enrichment_policy` setting / env explicitly to exercise `strict`.
os.environ.setdefault("ORWELL_ENRICHMENT_POLICY", "soft")

# Replace `core` with a lightweight package stub pointing at the real core/ dir, so
# `import core.auth` / `import core.middleware` load those files WITHOUT executing
# `core/__init__.py`. Idempotent across the session.
_existing = sys.modules.get("core")
if _existing is None or not getattr(_existing, "_orwell_test_stub", False):
    pkg = types.ModuleType("core")
    pkg.__path__ = [CORE_DIR]
    pkg._orwell_test_stub = True
    sys.modules["core"] = pkg


# ── CI lane split: auto-mark the real headless-browser tests as `browser` ────────────
#
# The FE suite's ~11 Playwright tests (they call `sync_playwright`) dominate wall-clock and carry the
# known environmental onboarding-scrim flake (#925/#1148/#930). CI runs them in a SEPARATE serial lane
# (`fe-browser-tests`, with a retry) while the ~340 non-browser tests run PARALLEL under xdist
# (`fe-unit`). Rather than hand-mark every browser file, detect them structurally: any test whose module
# source calls `sync_playwright` is the `browser` lane. Everything else is xdist-safe (verified: the only
# real fixed-port server binds in the whole suite live in `sync_playwright` files; every other port
# reference is a monkeypatched stub string). Select with `-m browser` / `-m "not browser"`.
@functools.lru_cache(maxsize=None)
def _module_launches_browser(path: str) -> bool:
    try:
        return "sync_playwright" in pathlib.Path(path).read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False


def pytest_collection_modifyitems(config, items):
    for item in items:
        if _module_launches_browser(str(item.fspath)):
            item.add_marker("browser")


# ── cross-file isolation: the M1-10 cast-authoring ledger is process-global ──────────
#
# `orwell_cast_authoring` keeps the per-season attempt/give-up ledger in module globals
# (`_attempt_ledger` / `_gaveup_logged`). Without a per-test reset it accumulates across tests
# AND across files — a burst test that drives an NPC to the give-up cap leaks that give-up into a
# later completeness/concurrency assertion, so co-run ORDER (and xdist worker distribution) decides
# pass/fail. Reset it before every test that already imported the module (cheap: no-op when it isn't
# loaded, so unrelated tests pay nothing).
# ── shared async-test helper ──────────────────────────────────────────────────────────
#
# Four cast-authoring test files each defined the same helper inline. Hoisted here so
# there is a single canonical copy: one call per test, no shared loop state. The helper
# creates a pristine loop, runs the coroutine, closes the loop, then installs a fresh
# OPEN loop so subsequent `asyncio.get_event_loop()` consumers never meet a closed loop
# (a bare `asyncio.run()` would leave the main-thread loop closed, breaking later tests).
def _run(coro: Coroutine[Any, Any, Any]) -> Any:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())


@pytest.fixture(name="run")
def _run_fixture() -> Callable[..., Any]:
    """Fixture form of the `_run` helper — accepts a coroutine and returns its result."""
    return _run


@pytest.fixture(autouse=True)
def _ensure_current_event_loop() -> None:
    """Py3.12 guard: `asyncio.get_event_loop()` RAISES ("There is no current event loop in thread
    'MainThread'") when no loop is set for the thread — unlike 3.11, which silently auto-created one.
    ~13 FE test files call `asyncio.get_event_loop().run_until_complete(...)` directly and rely on a
    loop already being current. pytest-asyncio (asyncio_mode=auto) creates a fresh loop per async
    test and, on teardown, closes it and leaves the thread loop UNSET — so a SYNC test that runs
    right after an async one on the same worker hits the raise. Under `pytest-xdist -n 4` with the
    default dynamic (`--dist load`) distribution, which test lands on which worker after which is
    timing-dependent and NON-deterministic across machines: CI can serialise an async→sync pair on
    one worker (mass "no current event loop" red) while a dev box never does. Adding/removing ANY
    test file also reshuffles the odds. Guarantee a live current loop before every test so no
    ordering can trigger it; only create one when genuinely absent or closed, leaving pytest-asyncio's
    own per-test loop management untouched for `async def` tests.
    """
    try:
        with warnings.catch_warnings():
            # 3.12 emits a DeprecationWarning right before it raises on an unset loop; we handle the
            # raise ourselves, so mute just that one line (it would otherwise fire on every boundary).
            warnings.simplefilter("ignore", DeprecationWarning)
            loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())


@pytest.fixture(autouse=True)
def _isolate_game_session_store(tmp_path, monkeypatch) -> None:
    """The canonical game-session binding (feature 0064) persists to a JSON file at a MODULE-CONSTANT
    path (`orwell_game_session.GAME_SESSION_PATH`, under the non-overridable `DATA_DIR`), so every
    test — and, under `pytest-xdist`, every WORKER — shares ONE file. A route/integration test that
    binds a session for the `"default"` bucket (the `user=None` / single-tenant key) leaves that
    binding for a later test to read: `_desync_key(None)` then resolves to `gs:<id>` instead of None,
    and an `owner=None` assertion that keys on None flakes purely by co-run order (the intermittent
    `test_1659_r5_guard_down::test_owner_none_is_admitted_and_rejudged` red — visible once a new test
    file reshuffles the xdist distribution). Redirect the store to a per-test temp file so no binding
    bleeds — generalising the per-test `_tmp_store` isolation that `test_0064_canonical_session.py`
    already applies locally. The import is lazy in production (`_desync_key` does `from src import
    orwell_game_session` on demand), so patch the module directly; guard the import so the stubbed-
    `core` unit tests (which never touch the store) pay nothing.
    """
    try:
        import src.orwell_game_session as _ogs
    except Exception:
        return
    monkeypatch.setattr(_ogs, "GAME_SESSION_PATH", tmp_path / "orwell_game_session.json")


@pytest.fixture(autouse=True)
def _reset_cast_authoring_ledger() -> None:
    mod = sys.modules.get("src.orwell_cast_authoring")
    if mod is not None:
        for attr in ("_attempt_ledger", "_gaveup_logged", "_LAST_AUTHORING_BACKFILL_AT"):
            with contextlib.suppress(AttributeError):
                getattr(mod, attr).clear()
    # The enrichment-policy failure ledger is process-global too (owner directive 2026-07-11) —
    # same cross-file bleed class as the authoring ledgers above; reset it per test when loaded.
    ep = sys.modules.get("src.enrichment_policy")
    if ep is not None:
        with contextlib.suppress(AttributeError):
            ep._FAILURES.clear()


@pytest.fixture(autouse=True)
def _join_stray_capability_probe_threads(monkeypatch):
    """T0-4 (#1821): ``capability_probe.probe_endpoint_background`` fires a REAL daemon thread
    (real network calls, real settings writes) whenever a test POSTs to
    ``/api/model-endpoints`` without mocking the capability-probe kickoff specifically — most
    pre-existing model-endpoint tests only mock model DISCOVERY (`_probe_endpoint`), not this
    newer probe arm, so they trigger a genuine background probe without meaning to. Uncontained,
    that thread can outlive its owning test and land its settings write during a LATER test's
    window — the exact background-thread race that produced a residual, non-deterministic
    full-suite flake in ``tests/test_overseer_debug_telemetry.py`` (a stray probe thread
    completing mid-test and writing into whatever settings file happened to be monkeypatched at
    that instant). ``probe_endpoint_background`` now returns its ``Thread`` for exactly this
    reason; wrap it here so every REAL thread it spawns is joined before the test ends,
    regardless of which test file triggered it. A test that monkeypatches
    ``capability_probe.probe_endpoint_background`` itself (the T0-4 test files do, to avoid the
    real network call) simply overrides this wrapper for its own duration — nothing to join
    there, so this is a no-op safety net for them."""
    try:
        import src.capability_probe as _cap
    except Exception:
        yield
        return
    threads: list = []
    _orig = _cap.probe_endpoint_background

    def _tracking(*args, **kwargs):
        t = _orig(*args, **kwargs)
        if t is not None:
            threads.append(t)
        return t

    monkeypatch.setattr(_cap, "probe_endpoint_background", _tracking)
    yield
    for t in threads:
        with contextlib.suppress(Exception):
            t.join(timeout=15)
            if t.is_alive():
                # A silent join-timeout would reintroduce the exact cross-test race this
                # fixture exists to prevent — make the miss loud enough to debug.
                warnings.warn(f"capability-probe thread {t.name!r} did not finish within 15s "
                              "and outlived its test", RuntimeWarning)


@pytest.fixture(autouse=True)
def _root_ops_route_defaults(monkeypatch) -> None:
    """Defaults for the admin routes that trigger ROOT operations (reset / update / TLS / public
    exposure), so a test about the route's OWN behavior is not also a test of the host:

    * the ops watcher reads as ACTIVE (``core.ops_watcher._systemctl_is_active`` shells out to a
      ``systemctl`` the test box does not have; a unit FILE in a tmp dir is what a test provides);
    * the strict auth-off gate (``core.admin_guard.require_root_ops``) is opened with its documented
      operator opt-in, because a ``TestClient`` is not a direct-loopback peer.

    Negative tests (inactive watcher, auth-off gate, cross-origin, missing confirmation) re-set either
    one explicitly — see ``test_admin_root_op_guards.py`` — and a monkeypatch made in the test body wins
    over this fixture."""
    try:
        from core import ops_watcher
    except Exception:
        return
    monkeypatch.setattr(ops_watcher, "_systemctl_is_active", lambda unit: True)
    monkeypatch.setenv("ORWELL_ROOT_OPS_WITHOUT_AUTH", "1")


# ── A41: the silent-skip guard (CI only: ORWELL_SKIP_GUARD=1; ORWELL_SKIP_LANE=unit|browser) ──────────────────────────────
def pytest_sessionfinish(session, exitstatus):
    import json
    import os
    if os.environ.get("ORWELL_SKIP_GUARD") != "1":
        return
    tr = session.config.pluginmanager.get_plugin("terminalreporter")
    if tr is None:
        return
    lane = os.environ.get("ORWELL_SKIP_LANE", "unit")
    skipped = []
    for rep in tr.stats.get("skipped", []):
        lr = getattr(rep, "longrepr", None)
        reason = lr[2] if isinstance(lr, tuple) and len(lr) >= 3 else str(lr)
        skipped.append((rep.nodeid, str(reason)))
    try:
        with open(os.path.join(os.path.dirname(__file__), "skip_ceiling.json"), encoding="utf-8") as f:
            ceiling = json.load(f).get(lane)
    except Exception:
        ceiling = None
    browser_ids = {i.nodeid for i in session.items if i.get_closest_marker("browser")}
    from _skip_guard import evaluate
    problems = evaluate(skipped, lane=lane, ceiling=ceiling, browser_ids=browser_ids)
    tr.write_sep("=", f"A41 skip guard (lane={lane}): {len(skipped)} skipped, ceiling={ceiling}")
    for line in sorted({r for _, r in skipped}):
        tr.write_line(f"  skip reason: {line}")
    for p in problems:
        tr.write_line(f"  VIOLATION: {p}", red=True)
    if problems and session.exitstatus == 0:
        session.exitstatus = 1
