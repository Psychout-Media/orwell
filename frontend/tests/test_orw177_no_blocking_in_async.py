"""ORW-177 (slice 3): nothing blocks the event loop from async code.

The server is single-threaded per worker, so one synchronous HTTP call or subprocess wait inside an `async def` stalls every player until it returns (the portrait generator's
`/models` probe could hold the loop for up to 5 s per candidate model). This is an AST gate over the front-end code (tests, scripts, data and static are excluded):

  1. DIRECT: no `async def` body calls a blocking primitive: subprocess.run/check_output/call/check_call, httpx.get/post/put/delete/request, requests.get/post, time.sleep.
     (`subprocess.Popen` only spawns and returns, so it is allowed.)
  2. ONE HOP: no `async def` calls a project SYNC helper that itself contains one of those primitives, unless the call is awaited or the helper is passed to
     `asyncio.to_thread` / `run_in_executor`. Offload with `await asyncio.to_thread(helper, ...)`.

A positive control proves the checker really fires, and the two name collisions the heuristic cannot tell apart are listed with their reasons."""
import ast
import os
from pathlib import Path

FRONTEND = Path(__file__).resolve().parents[1]
BLOCKING = {("subprocess", "run"), ("subprocess", "check_output"), ("subprocess", "call"), ("subprocess", "check_call"),
            ("httpx", "get"), ("httpx", "post"), ("httpx", "put"), ("httpx", "delete"), ("httpx", "request"),
            ("requests", "get"), ("requests", "post"), ("time", "sleep")}
OFFLOADERS = {"to_thread", "run_in_executor", "run_isolated"}
# name collisions the name-based one-hop check cannot resolve (each verified by hand, 2026-11-12)
ONE_HOP_ALLOW = {
    ("src/orwell_prewarm.py", "warm_portraits", "_run"): "calls its OWN local `async def _run()` (a coroutine passed to the loop); the blocking `_run` is a different function in services/hwfit/hardware.py",
    ("src/research_handler.py", "call_research_service", "_probe_endpoint"): "is `await self._probe_endpoint(...)`, an async method; the blocking `_probe_endpoint` is a different function in routes/model_routes.py",
}


def _sources():
    for root, dirs, files in os.walk(FRONTEND):
        dirs[:] = [d for d in dirs if d not in {"tests", ".venv", "node_modules", "__pycache__", "scripts", "data", "static", ".git"}]
        for f in files:
            if f.endswith(".py"):
                p = Path(root) / f
                yield str(p.relative_to(FRONTEND)), p.read_text(encoding="utf-8")


def _blocking_call(node):
    f = node.func
    return isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and (f.value.id, f.attr) in BLOCKING


def _name(call):
    f = call.func
    return f.attr if isinstance(f, ast.Attribute) else (f.id if isinstance(f, ast.Name) else "")


def direct_hits(src):
    """(lineno, 'mod.fn') for every blocking primitive whose NEAREST enclosing function is async."""
    out = []

    class V(ast.NodeVisitor):
        def __init__(self):
            self.stack = []

        def visit_FunctionDef(self, n):
            self.stack.append(False); self.generic_visit(n); self.stack.pop()

        def visit_AsyncFunctionDef(self, n):
            self.stack.append(True); self.generic_visit(n); self.stack.pop()

        def visit_Call(self, n):
            if self.stack and self.stack[-1] and _blocking_call(n):
                out.append((n.lineno, f"{n.func.value.id}.{n.func.attr}"))
            self.generic_visit(n)
    V().visit(ast.parse(src))
    return out


def blocking_sync_helpers(trees):
    """name -> (file, line): sync functions that contain a blocking primitive."""
    found = {}
    for path, tree in trees.items():
        for n in ast.walk(tree):
            if isinstance(n, ast.FunctionDef):
                for c in ast.walk(n):
                    if isinstance(c, ast.Call) and _blocking_call(c):
                        found.setdefault(n.name, (path, c.lineno)); break
    return found


def one_hop_hits(path, tree, helpers):
    out = []
    for n in ast.walk(tree):
        if not isinstance(n, ast.AsyncFunctionDef):
            continue
        offloaded, awaited = set(), set()
        for c in ast.walk(n):
            if isinstance(c, ast.Await) and isinstance(c.value, ast.Call):
                awaited.add(id(c.value))
            if isinstance(c, ast.Call) and _name(c) in OFFLOADERS:
                for a in c.args:
                    if isinstance(a, ast.Name): offloaded.add(a.id)
                    if isinstance(a, ast.Attribute): offloaded.add(a.attr)
        for c in ast.walk(n):
            if isinstance(c, ast.Call):
                nm = _name(c)
                if nm in helpers and nm not in offloaded and nm != n.name and id(c) not in awaited:
                    out.append((c.lineno, n.name, nm))
    return out


def test_no_async_function_calls_a_blocking_primitive_directly():
    bad = [f"{p}:{ln} {call}" for p, src in _sources() for ln, call in direct_hits(src)]
    assert not bad, "a blocking call inside an async def stalls the event loop; use httpx.AsyncClient or `await asyncio.to_thread(...)`:\n" + "\n".join(bad)


def test_no_async_function_calls_a_blocking_sync_helper_without_offloading_it():
    trees = {p: ast.parse(src) for p, src in _sources()}
    helpers = blocking_sync_helpers(trees)
    assert len(helpers) > 20, "the helper census is not vacuous"
    bad = []
    for p, tree in trees.items():
        for ln, fn, callee in one_hop_hits(p, tree, helpers):
            if (p.replace(os.sep, "/"), fn, callee) in ONE_HOP_ALLOW:
                continue
            bad.append(f"{p}:{ln} async {fn} -> sync {callee}() [blocks at {helpers[callee][0]}:{helpers[callee][1]}]")
    assert not bad, "an async def calls a blocking sync helper on the event loop; wrap it in `await asyncio.to_thread(helper, ...)`:\n" + "\n".join(bad)


def test_the_checker_can_fail_positive_control():
    leaky = "import httpx, subprocess, time\nasync def f():\n    httpx.get('http://x')\n    subprocess.run(['ls'])\n    time.sleep(1)\n"
    assert [c for _, c in direct_hits(leaky)] == ["httpx.get", "subprocess.run", "time.sleep"]
    fine = "import asyncio, httpx, subprocess\nasync def f():\n    subprocess.Popen(['ls'])\n    await asyncio.to_thread(blocker)\ndef blocker():\n    httpx.get('http://x')\n"
    assert direct_hits(fine) == []
    tree = ast.parse("import httpx\ndef blocker():\n    httpx.get('x')\nasync def bad():\n    blocker()\nasync def good():\n    await asyncio.to_thread(blocker)\nasync def awaited():\n    await blocker()\n")
    helpers = blocking_sync_helpers({"m.py": tree})
    assert [(fn, callee) for _, fn, callee in one_hop_hits("m.py", tree, helpers)] == [("bad", "blocker")]


def test_the_allow_list_entries_still_describe_real_code():
    for (path, fn, callee), why in ONE_HOP_ALLOW.items():
        src = (FRONTEND / path).read_text(encoding="utf-8")
        assert f"async def {fn}(" in src and callee in src, f"stale allow-list entry {path}:{fn}:{callee} ({why})"
