"""ORW-1026: no NEW bare silent ``except Exception: pass/continue`` in the three belt and guard files.

A broad handler whose whole body is `pass` or `continue` must either count the failure (call ``_failsoft_note``, which logs
rate-limited and counts) or carry ``# failsoft-ok: <reason>`` on the handler line or the body line. This gate fails on a new one.
"""
import ast
import os

import pytest

FE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Each ORW-1026 PR adds the file it cleaned; the last one covers all three.
FILES = ("src/tool_execution.py",)
MARKER = "failsoft-ok:"


def silent_sites(path):
    src = open(os.path.join(FE, path), encoding="utf-8").read()
    lines = src.split("\n")
    bad = []
    for node in ast.walk(ast.parse(src)):
        if not isinstance(node, ast.ExceptHandler):
            continue
        name = ast.unparse(node.type) if node.type else "bare"
        if name not in ("Exception", "BaseException", "bare"):
            continue
        if len(node.body) != 1 or not isinstance(node.body[0], (ast.Pass, ast.Continue)):
            continue
        span = lines[node.lineno - 1: node.body[0].end_lineno]
        if not any(MARKER in ln and len(ln.split(MARKER, 1)[1].strip()) >= 8 for ln in span):
            bad.append(node.lineno)
    return bad


@pytest.mark.parametrize("path", FILES)
def test_no_unmarked_silent_broad_except(path):
    bad = silent_sites(path)
    assert not bad, (f"{path}: silent broad except at line(s) {bad}: call _failsoft_note(site, exc) in the handler "
                     f"(src/failsoft_counter.py), or add '# failsoft-ok: <reason>' if it is intentionally silent")


def test_gate_catches_a_new_silent_except(tmp_path, monkeypatch):
    f = tmp_path / "x.py"
    f.write_text("def g():\n    try:\n        1/0\n    except Exception:\n        pass\n"
                 "    try:\n        1/0\n    except Exception:\n        pass  # failsoft-ok: teardown of a closed handle\n")
    monkeypatch.setattr(os.path, "join", lambda *a: str(f) if a[-1] == "x.py" else "/".join(a))
    assert silent_sites("x.py") == [4]


def test_counter_counts_and_rate_limits_the_log(caplog):
    from src import failsoft_counter as fc
    fc.reset_for_tests()
    with caplog.at_level("WARNING", logger="src.failsoft_counter"):
        for _ in range(50):
            fc.note("t:site:1", ValueError("secret player text"))
    assert fc.snapshot()["t:site:1"] == {"count": 50, "last_class": "ValueError"}
    msgs = [r.getMessage() for r in caplog.records if "t:site:1" in r.getMessage()]
    assert len(msgs) == 1 and "secret player text" not in msgs[0]      # one line, class name only
    fc.reset_for_tests()
