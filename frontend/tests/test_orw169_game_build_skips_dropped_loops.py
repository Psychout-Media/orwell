"""ORW-169 (slice 1): the game build does not start the nightly skill audit (model calls over a skills library the game build does not have) or the cookbook serve-lifecycle sweeper. Source-pinned on app.py's lifespan, plus the non-game build still starts them. No model."""
import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app.py"


def _is_not_game_build(test) -> bool:
    return (isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not) and isinstance(test.operand, ast.Call)
            and getattr(test.operand.func, "id", "") in ("_gb_enabled", "game_build_enabled"))


def _started(node) -> set:
    """Names of every callee started via asyncio.create_task(callee(...)) under `node`."""
    return {getattr(n.args[0].func, "id", "") for n in ast.walk(node)
            if isinstance(n, ast.Call) and getattr(n.func, "attr", "") == "create_task" and n.args and isinstance(n.args[0], ast.Call)}


def _guarded_task_starts():
    """{callee: True when it is only started under `if not game_build_enabled():`}"""
    tree = ast.parse(APP.read_text())
    everything = _started(tree)
    guarded = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.If) and _is_not_game_build(n.test):
            for sub in n.body:
                guarded |= _started(sub)
    return {name: name in guarded for name in everything}


def test_the_skill_audit_and_cookbook_loops_are_not_started_in_the_game_build():
    g = _guarded_task_starts()
    assert g.get("_skill_audit_nightly_loop") is True, g
    assert g.get("cookbook_serve_lifecycle_loop") is True, g


def test_unrelated_startup_tasks_are_still_started_unconditionally():
    g = _guarded_task_starts()
    # the keepalive and the portrait/null-owner sweeps are NOT touched by this slice
    assert g.get("_keepalive_loop") is False, g
    assert g.get("_null_owner_sweep_loop") is False, g
