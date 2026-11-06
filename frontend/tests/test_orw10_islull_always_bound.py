"""ORW-10 (live replay 6, 01:34 UTC): a turn that ended on an ask_user question skipped the conditional finishing block that assigns `_is_lull` / `_progressed`, and the post-loop overseer hook then died with
UnboundLocalError (soft-fail overseer:hook-error, [uncorrected]). Pin: both names are assigned at the TOP LEVEL of stream_agent_loop, so every path has a value. Roles only."""
import ast
import pathlib

SRC = pathlib.Path(__file__).resolve().parents[1] / "src" / "agent_loop.py"


def test_is_lull_and_progressed_are_bound_on_every_path():
    tree = ast.parse(SRC.read_text(encoding="utf-8"))
    # the function that owns the per-turn locals (the one that assigns `_cutaway_emitted` at its top level)
    fns = [n for n in ast.walk(tree) if isinstance(n, (ast.AsyncFunctionDef, ast.FunctionDef))]
    fn = next(f for f in fns if any(isinstance(st, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "_cutaway_emitted" for t in st.targets) for st in f.body))
    top = {t.id for st in fn.body if isinstance(st, ast.Assign) for t in st.targets if isinstance(t, ast.Name)}
    assert {"_is_lull", "_progressed"} <= top, "these must be assigned unconditionally at the top of stream_agent_loop"
