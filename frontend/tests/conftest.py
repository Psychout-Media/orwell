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

import _run_tmp  # test temp footprint

_REAL_TMP = tempfile.gettempdir()
_RUN_TMP = tempfile.mkdtemp(prefix="orwell-run-")
os.environ["TMPDIR"] = _RUN_TMP
tempfile.tempdir = _RUN_TMP
# Every process (the controller and each xdist worker) removes ITS OWN folder when it ends, on a normal exit and on SIGTERM (a killed run skipped atexit and stranded 2-5 GB); ORWELL_KEEP_TEST_TMP=1 keeps it.
_atexit.register(_run_tmp.remove_run_folder, _RUN_TMP)
_run_tmp.install_sigterm_cleanup(_RUN_TMP)
_run_tmp.start_heartbeat(_RUN_TMP)
if not os.environ.get("PYTEST_XDIST_WORKER"):  # the controller sweeps folders an earlier killed run left behind (same owner, older than 20 minutes, not in use); workers never do
    _run_tmp.sweep_stale(_REAL_TMP, keep=_RUN_TMP)

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

# ORW-166: the HUD-poller read cache (src/engine_read_cache.py) is OFF for the suite - many tests monkeypatch the engine reads and re-poll within
# its 400 ms window, and a cache would serve one test the previous test's state. The dedicated cache tests (test_orw166_engine_read_cache.py) set a TTL explicitly.
os.environ.setdefault("ORWELL_STATE_CACHE_TTL_MS", "0")

# Owner directive 2026-07-11 — the enrichment policy defaults to STRICT in production (loud failures,
# creation refusals on an unwired class; src/enrichment_policy.py). The FE suite stubs the LLM
# everywhere and its many fail-soft contracts ("absent ⇒ byte-identical deterministic floor") must
# stay green untouched, so the whole suite pins the LEGACY `soft` policy via the env seed — exactly
# like the floor-start hatch above. The dedicated strict tests (test_enrichment_policy.py) set the
# `enrichment_policy` setting / env explicitly to exercise `strict`.
os.environ.setdefault("ORWELL_ENRICHMENT_POLICY", "soft")
os.environ.setdefault("ORWELL_CAST_GATE", "0")  # ORW-431: the end-of-creation gate is ON in product; the older stub-writer fixtures are minimal, ORW-431 tests switch it on

# Replace `core` with a lightweight package stub pointing at the real core/ dir, so
# `import core.auth` / `import core.middleware` load those files WITHOUT executing
# `core/__init__.py`. Idempotent across the session.
_existing = sys.modules.get("core")
if _existing is None or not getattr(_existing, "_orwell_test_stub", False):
    pkg = types.ModuleType("core")
    pkg.__path__ = [CORE_DIR]
    pkg._orwell_test_stub = True
    sys.modules["core"] = pkg


# ── ORW-229 flaky-test rule (docs/CI.md) ─────────────────────────────────────────────
# Two small plugins: `_quarantine` (the `quarantine(card=..., added=...)` marker: such tests are DESELECTED unless ORWELL_RUN_QUARANTINED=1, the
# nightly run) and `_flaky_report` (lists every test that passed only on CI's `--reruns 1` in the job summary). Registered here, not via
# `pytest_plugins` (only allowed in a rootdir conftest). The quarantine deselection runs inside the modifyitems wrapper below, so before the shard split.
def pytest_configure(config):
    import _flaky_report
    import _quarantine
    for plugin, name in ((_quarantine, "orwell-quarantine"), (_flaky_report, "orwell-flaky-report")):
        if not config.pluginmanager.has_plugin(name):
            config.pluginmanager.register(plugin, name)


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


# One file alone was the longest leg of the lane (about 30 s per case, 13 independent cases, each in its own chat session): let its cases spread over the workers.
_BROWSER_SPREAD_FILES = frozenset({"test_a58_golden_render_live_vs_reload.py"})


@pytest.hookimpl(hookwrapper=True)
def pytest_collection_modifyitems(config, items):
    for item in items:
        if _module_launches_browser(str(item.fspath)):
            item.add_marker("browser")
        # ORW-414: the CI browser lane runs `-n 2 --dist loadgroup`. A file's tests share ONE worker (an xdist_group named by the file) so its module-scoped stack boots once,
        # except the files in _BROWSER_SPREAD_FILES, whose tests are independent and slow: those carry no group, so xdist spreads them over the workers (each worker boots
        # its own stack on its own free ports and data dir; nothing is shared). The marker only matters under `--dist loadgroup`; every other run ignores it.
        # Every browser file is grouped, including the real-stack files marked `browser` by their own `pytestmark` that never name sync_playwright (review of #2785).
        if item.get_closest_marker("browser") is not None and item.fspath.basename not in _BROWSER_SPREAD_FILES and item.get_closest_marker("xdist_group") is None:
            item.add_marker(pytest.mark.xdist_group(name=item.fspath.basename))
    yield  # every other modifyitems hook (notably `-m` deselection) has run once we resume
    # ORW-193: optional CI sharding (ORWELL_CI_SHARD="i/n"), by test file, so each shard balances exactly the lane being run. Done here (not later in
    # pytest_collection_finish) because xdist workers report their collected ids from that later hook. Deselects (never skips) the other shards' files.
    raw = os.environ.get("ORWELL_CI_SHARD")
    if not raw:
        return
    from _ci_shard import parse_shard, select_shard
    idx, total = parse_shard(raw)
    # The shard applies to THIS session only: drop the variable now so a pytest launched by a test (a child process) is not sharded again (ORW-193 regression:
    # a nested run over another file collected 0 tests, exit 5). Belt and braces with _ci_shard.nested_env() at the call sites.
    os.environ.pop("ORWELL_CI_SHARD", None)
    browser_files = frozenset(str(i.fspath) for i in items if i.get_closest_marker("browser"))
    keep_files = select_shard([str(i.fspath) for i in items], idx, total, browser_files=browser_files)
    dropped = [i for i in items if str(i.fspath) not in keep_files]
    if dropped:
        config.hook.pytest_deselected(items=dropped)
    items[:] = [i for i in items if str(i.fspath) in keep_files]


# ── ORW-414: every browser test module gets its OWN front-end data directory ───────────
#
# The real-stack browser tests boot `uvicorn app:app` subprocesses. The app keeps settings.json, the game-session binding, the layout file and
# sessions under one data dir, which used to be the shared <checkout>/frontend/data, so two stacks at once overwrote each other's settings
# (the reason the browser lane had to be serial). `src/constants.py` honours the opt-in ORWELL_DATA_DIR_FE; this hook points it at a fresh
# temp dir per browser module (per xdist worker, so `-n 2` shares nothing) BEFORE any fixture boots a stack, and removes it for every
# other test so an in-process test never sees it. A stack that sets its own ORWELL_DATA_DIR_FE in the env it builds (m0_3, f3, h2b, h2h3) wins.
_FE_DATA_DIRS: dict[str, str] = {}


def _fe_data_dir_for(path: str) -> str:
    d = _FE_DATA_DIRS.get(path)
    if d is None:
        d = tempfile.mkdtemp(prefix="orwell-fe-data-")
        _FE_DATA_DIRS[path] = d
        _atexit.register(_shutil.rmtree, d, ignore_errors=True)
    return d


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item):
    if item.get_closest_marker("browser") is not None:
        os.environ["ORWELL_DATA_DIR_FE"] = _fe_data_dir_for(str(item.fspath))
    else:
        os.environ.pop("ORWELL_DATA_DIR_FE", None)


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
def _engine_client_no_retry_backoff(request, monkeypatch) -> None:
    """The FE engine client retries a transient failure (refused / 5xx / empty body) twice with an exponential backoff (0.25 s, 0.5 s ...). Tests that drive a game turn have no engine
    behind them, so EVERY engine read in the loop (whereabouts, status, ...) hit a closed port and slept through the whole backoff: ~7 s of pure waiting per turn-driving test
    (measured 2026-11-12 with a sleep spy: 8.3 s -> 1.4 s per drive), which is what pushed fe-unit shards toward their cap. Default the retry OFF; a test that exercises the retry or
    backoff itself opts back in with `@pytest.mark.engine_retry` (module-level `pytestmark` works)."""
    try:
        from src import orwell_engine
        monkeypatch.setattr(orwell_engine, "_ENGINE_UNREACHABLE_SINCE", None)  # ORW-404: the "unreachable since" stamp never leaks between tests
        monkeypatch.setattr(orwell_engine, "_ENGINE_UNREACHABLE_LAST", None)
    except Exception:
        pass
    if request.node.get_closest_marker("engine_retry"):
        return
    try:
        from src import orwell_engine
        monkeypatch.setattr(orwell_engine, "_RETRY_ATTEMPTS", 0)
        monkeypatch.setattr(orwell_engine, "_RESTART_WAIT_BUDGET_S", 0.0)  # ORW-404: no ~20 s restart wait either
    except Exception:
        pass


@pytest.fixture(autouse=True)
def _reset_portrait_billing_breaker() -> None:
    """ORW-397: the image-provider billing breaker is module state; a test that fakes a 402 must not leave it open for the next one."""
    try:
        from src import orwell_portraits
        orwell_portraits.reset_billing_breaker()
    except Exception:  # failsoft-ok: test-hygiene (module may be unimportable in a narrow test)
        pass
    yield
    # Casting in the background: the per-photo retry timers, the opening-scene order, the image gates and the cast-warm retry tasks are
    # process state too; a test that fakes a failed shot must not leave a timer that fires inside the next test.
    try:
        from src import orwell_portraits, orwell_prewarm
        for _u in list(orwell_portraits._FACE_RETRY):
            orwell_portraits.cancel_face_retries(_u)
        orwell_portraits._OPENING_IDS.clear()
        orwell_portraits._IMAGE_GATES.clear()
        for _st in list(orwell_prewarm._STATE.values()):
            orwell_prewarm._cancel_retry(_st)
    except Exception:  # failsoft-ok: test-hygiene
        pass


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


@pytest.fixture
def non_game_text_routing(monkeypatch) -> None:
    """ORW-287: the text-routing guard (src/text_routing.py) is ON in the suite, like prod's game build. The few test modules that
    pin the OpenRouter wire/payload shape drive llm_core with an OpenRouter-style URL on purpose (that format is still real for the
    non-game build); they opt out at module level with ``pytestmark = pytest.mark.usefixtures("non_game_text_routing")``."""
    import src.text_routing as _tr
    monkeypatch.setattr(_tr, "active", lambda: False)


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
def _isolate_sync_ledger_store(tmp_path, monkeypatch) -> None:
    """The sync ledger (`orwell_sync_ledger.LEDGER_PATH`, under the non-overridable `DATA_DIR`) is a module-constant JSON file read-modify-written on
    every recorded turn, so under `pytest-xdist` every WORKER shares ONE file and a concurrent worker's write overwrote another's entry (a lost update):
    `test_orw294_merged_extraction::test_belt_fires_are_counted_per_applied_correction_not_per_call` read `{}` for its own unique owner purely by
    co-run timing (passes alone, passes serially, fails in parallel). Redirect it per test, like the game-session store above. Tests that need a
    specific path still monkeypatch it themselves (their patch runs after this fixture and wins)."""
    try:
        import src.orwell_sync_ledger as _led
    except Exception:
        return
    monkeypatch.setattr(_led, "LEDGER_PATH", tmp_path / "orwell_sync_ledger.json")


@pytest.fixture(autouse=True)
def _isolate_recent_seasons_store(tmp_path, monkeypatch) -> None:
    """ORW-508: the recent-seasons ledger (`orwell_recent_seasons.LEDGER_PATH`, under the non-overridable `DATA_DIR`) is read on every cast warm and
    written when a season starts, so without a redirect a test that fakes `createCharacter` with a `house` would write the real data dir and feed
    `avoid` into the next test (and xdist workers would share one file). Redirect it per test, like the stores above; a test that needs a specific
    path monkeypatches it itself (its patch runs after this fixture and wins)."""
    try:
        import src.orwell_recent_seasons as _rs
    except Exception:
        return
    monkeypatch.setattr(_rs, "LEDGER_PATH", tmp_path / "orwell_recent_seasons.json")


@pytest.fixture(autouse=True)
def _isolate_season_checklist_store(tmp_path, monkeypatch) -> None:
    """ORW-970: the season-start checklist (`orwell_season_checklist.CHECKLIST_PATH`, under `DATA_DIR`) is written when a season starts, so redirect it per
    test like the stores above (a test that fakes `createCharacter` must not write the real data dir or share a file across xdist workers). In-process
    task state is cleared too."""
    try:
        import src.orwell_season_checklist as _sc
    except Exception:
        return
    monkeypatch.setattr(_sc, "CHECKLIST_PATH", tmp_path / "orwell_season_checklist.json")
    _sc._ACTIVE.clear()
    _sc._RETRY_TASKS.clear()


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
    # ORW-251b: the 0065 prewarm gate (`_STATE`, keyed by owner) is process-global too. A test that warms owner "bob" left authorStarted=True, so a later test_orwell_portraits case took the PREWARMED branch
    # (authoring before portraits: "assert 1 < 0") - an order-dependent red under xdist. Reset it per test when loaded.
    pw = sys.modules.get("src.orwell_prewarm")
    if pw is not None:
        with contextlib.suppress(Exception):
            pw.reset(None)


@pytest.fixture(autouse=True)
def _reset_scene_cut_streak():
    """ORW-10: the scene circuit-breaker's consecutive-cut streak is process-global state keyed by user. Several guard tests cut a scene as the SAME user across tests with no clean turn between,
    which (correctly, in production) turns the 2nd consecutive cut into the neutral engine-true directive and hides the specific correction the test asserts. Reset it per test."""
    ch = sys.modules.get("routes.chat_helpers")
    if ch is not None and hasattr(ch, "_CUT_STREAK"):
        ch._CUT_STREAK.clear()
    yield
    ch = sys.modules.get("routes.chat_helpers")
    if ch is not None and hasattr(ch, "_CUT_STREAK"):
        ch._CUT_STREAK.clear()


@pytest.fixture(autouse=True)
def _reset_veto_draw_holds():
    """ORW-515: the ORW-505 veto-draw hold (`chat_helpers._VETO_DRAW_HOLDS`) is process-global, keyed per owner, and only cleared when that
    owner's next framed turn begins. A test that commits a draw for the auth-off owner (None/"") left the hold set, so a later owner=None
    test in the same xdist worker lost its forced advanceGame (`test_tool_choice_force::test_loop_forces_under_no_auth_owner_none`). Reset it per test."""
    ch = sys.modules.get("routes.chat_helpers")
    if ch is not None and hasattr(ch, "_VETO_DRAW_HOLDS"):
        ch._VETO_DRAW_HOLDS.clear()
    yield
    ch = sys.modules.get("routes.chat_helpers")
    if ch is not None and hasattr(ch, "_VETO_DRAW_HOLDS"):
        ch._VETO_DRAW_HOLDS.clear()


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
    report_browser_ids = set()  # ORW-414: under xdist the controller's session.items is EMPTY (the workers collect), so read the marker off each skip report itself
    for rep in tr.stats.get("skipped", []):
        if "browser" in (getattr(rep, "keywords", None) or {}):
            report_browser_ids.add(rep.nodeid)
        lr = getattr(rep, "longrepr", None)
        reason = lr[2] if isinstance(lr, tuple) and len(lr) >= 3 else str(lr)
        skipped.append((rep.nodeid, str(reason)))
    try:
        with open(os.path.join(os.path.dirname(__file__), "skip_ceiling.json"), encoding="utf-8") as f:
            ceiling = json.load(f).get(lane)
    except Exception:
        ceiling = None
    browser_ids = {i.nodeid for i in session.items if i.get_closest_marker("browser")} | report_browser_ids
    from _skip_guard import evaluate
    problems = evaluate(skipped, lane=lane, ceiling=ceiling, browser_ids=browser_ids)
    tr.write_sep("=", f"A41 skip guard (lane={lane}): {len(skipped)} skipped, ceiling={ceiling}")
    for line in sorted({r for _, r in skipped}):
        tr.write_line(f"  skip reason: {line}")
    for p in problems:
        tr.write_line(f"  VIOLATION: {p}", red=True)
    if problems and session.exitstatus == 0:
        session.exitstatus = 1


@pytest.fixture
def zero_clocks_off(monkeypatch) -> None:
    """ORW-377: `zero_clocks` ships ON; the tests that pin the PRE-zero-clocks clock wording (the engine clock quoted to the narrator, minute counts, a stated clock time left in the stream) opt out per module with
    ``pytestmark = pytest.mark.usefixtures("zero_clocks_off")``. ON is pinned in test_orw377_zero_clocks.py."""
    import src.settings as _st
    _real = _st.get_setting
    monkeypatch.setattr(_st, "get_setting", lambda k, d=None: False if k == "zero_clocks" else _real(k, d))


@pytest.fixture(autouse=True)
def _portrait_photo_check_off(monkeypatch) -> None:
    """ORW-384: the automatic photo check adds awaits (a DeepSeek endpoint lookup) to every NPC portrait
    task. Tests of the generation pipeline stub `_generate_one` and drain with a fixed number of loop turns,
    so the check is OFF by default here; test_orw384_photo_check.py puts the real one back."""
    from src import orwell_portrait_check as _c
    monkeypatch.setattr(_c, "check_enabled", lambda user: False)


# ── ORW-867: a rerun of a browser test gets a FRESH stack, and the first attempt's failure is not hidden ──────────────────────────────────────────────────────────────────────────────
# The browser lane runs with `--reruns 1`. A module-scoped stack fixture (`_stack`, `_casting_stack`: a real engine + FE + stub narrator, see test_m0_3_midgen_join._boot_stack) survives between a
# failed first attempt and its rerun, so any state the first attempt consumed (the first-writer-wins canonical game chat, an ended season) is still there: the rerun failed BY CONSTRUCTION and
# only that second failure was printed (CI showed `R.F`). Fix: when a test that uses one of these stack fixtures fails and a rerun is coming, finish the stack before the rerun so its setup boots a
# new one; CI also prints the rerun tracebacks (`-rR --rerun-show-tracebacks`), so the first attempt's own failure is in the log whether or not the rerun passes.
_RERUN_FRESH_FIXTURES = ("_stack", "_casting_stack")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    rep = outcome.get_result()
    if rep.when == "call" and rep.failed:
        item._orw_call_failed = True


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_teardown(item, nextitem):
    if not getattr(item, "_orw_call_failed", False):
        return
    item._orw_call_failed = False
    try:
        reruns = int(item.config.getoption("reruns", 0) or 0)
    except Exception:
        reruns = 0
    marker = item.get_closest_marker("flaky")
    if marker is not None and marker.kwargs.get("reruns") is not None:
        reruns = int(marker.kwargs["reruns"])
    # pytest-rerunfailures numbers the attempts from 1 (`execution_count`); a rerun follows only while attempts <= reruns
    if getattr(item, "execution_count", 1) > reruns:
        return
    request = item._request
    for name in _RERUN_FRESH_FIXTURES:
        for fd in item._fixtureinfo.name2fixturedefs.get(name, ()):
            if fd.scope in ("module", "class") and fd.cached_result is not None:
                try:
                    fd.finish(request)  # runs the fixture's teardown (stops the stack) and clears its cached result: the rerun's setup boots a new one
                except Exception:  # a stack that will not stop cleanly must not hide the test's own failure
                    pass
