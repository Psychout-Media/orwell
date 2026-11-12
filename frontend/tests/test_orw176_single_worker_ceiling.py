"""ORW-176 - the front-end is a single worker with process-global state. Pin the recorded ceiling: nobody adds workers without moving that state,
and the documented inventory still names real globals."""
import os
import re

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(FRONTEND)


def _read(*parts):
    with open(os.path.join(*parts), encoding="utf-8") as f:
        return f.read()


def test_the_frontend_unit_runs_exactly_one_worker():
    unit = _read(REPO, "deploy", "systemd", "orwell-frontend.service")
    exec_line = next(l for l in unit.splitlines() if l.startswith("ExecStart="))
    assert "uvicorn app:app" in exec_line
    assert "--workers" not in exec_line, "a second worker splits the process-global state - see docs/design/frontend-single-worker-ceiling.md"
    assert "WEB_CONCURRENCY" not in unit
    assert "WEB_CONCURRENCY" not in _read(REPO, "deploy", "orwell-env-defaults.sh")


# module (relative to frontend/) -> the module-level names the design note lists
INVENTORY = {
    "src/agent_runs.py": ["_RUNS"],
    "src/session_events.py": ["_SUBS"],
    "src/llm_core.py": ["_dead_hosts"],
    "src/orwell_engine.py": ["_DISCLOSURE_TURN", "_TELLS_TURN", "_DELIVERY_SEEN", "_MUTATION_COUNT", "_LAST_PENDING", "_ENGINE_FLAGS"],
    "src/orwell_sync_ledger.py": ["_PENDING_BELTS", "_PENDING_FORCED", "_PENDING_STALE", "_LAST_BEAT_AFTER", "_PENDING_FE_WRITES"],
    "src/engine_read_cache.py": ["_ENTRIES", "_INFLIGHT", "_INV", "_BEAT"],
}


@pytest.mark.parametrize("module,names", sorted(INVENTORY.items()))
def test_the_documented_process_globals_exist_and_are_documented(module, names):
    src = _read(FRONTEND, module)
    doc = _read(REPO, "docs", "design", "frontend-single-worker-ceiling.md")
    for n in names:
        assert re.search(rf"^{re.escape(n)}\b", src, re.M), f"{module} no longer defines {n}: update the ceiling note"
        assert f"`{n}`" in doc, f"{n} is not named in docs/design/frontend-single-worker-ceiling.md"


def test_session_manager_keeps_its_sessions_in_process():
    assert re.search(r"self\.sessions\s*:\s*Dict\[str, Session\]\s*=\s*\{\}", _read(FRONTEND, "core", "session_manager.py"))
