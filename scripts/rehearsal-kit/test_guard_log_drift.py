"""A81 - the analyzer must have a class for every narration-guard log line the front-end can emit (drift test), and report the new guard section from tiny fixtures. Run: python3 -m pytest rehearsal-kit/test_guard_log_drift.py
FE source is read from $ORWELL_REPO (default: orwell under $ORWELL_RIG_HOME, else the home directory). Roles only."""
import ast
import datetime as dt
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import post_session_analyzer as psa  # noqa: E402

REPO = os.environ.get("ORWELL_REPO") or os.path.join(os.environ.get("ORWELL_RIG_HOME") or os.path.expanduser("~"), "orwell")
FE_FILES = ("frontend/routes/chat_helpers.py", "frontend/src/agent_loop.py")
GUARDISH = re.compile(r"guard|HELD|STRIPPED|BLOCKED|replaced|DOWN|OMISSION|dropped|replay|stood down|refused by|circuit-breaker|desync", re.I)
# the four pre-existing classes the analyzer already counts by their own branches in analyze()
LEGACY = ("role-claim guard STRIPPED", "scene circuit-breaker HELD", "presence-wall: dropped", "desync detected", "ANTI-STALE", "production hold cap", "production holds", "soft-fail")


def _literal(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(v.value if isinstance(v, ast.Constant) else "{}" for v in node.values)
    return None


def fe_guard_log_strings():
    out = []
    for rel in FE_FILES:
        path = os.path.join(REPO, rel)
        assert os.path.exists(path), f"configured FE source {path} not found under {REPO} (wrong ORWELL_REPO or checkout): the drift check would silently cover half the guards"
        tree = ast.parse(open(path, encoding="utf-8").read())
        for n in ast.walk(tree):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ("warning", "info", "error", "debug") and n.args:
                lit = _literal(n.args[0])
                if lit and lit.startswith("[orwell]") and GUARDISH.search(lit):
                    out.append((rel, n.lineno, lit))
    return out


def test_the_scan_sees_real_fe_guard_lines():
    lines = fe_guard_log_strings()
    assert len(lines) >= 15, f"only {len(lines)} guard log lines found under {REPO}: wrong ORWELL_REPO or the scan is broken"


def test_every_fe_guard_log_line_has_an_analyzer_class():
    markers = [m for m, _, _ in psa.GUARD_LINES] + list(LEGACY)
    missing = [(rel, ln, lit[:90]) for rel, ln, lit in fe_guard_log_strings() if not any(m in lit for m in markers)]
    assert not missing, "FE guard log lines the analyzer has no class for (add them to GUARD_LINES in post_session_analyzer.py):\n" + "\n".join(map(str, missing))


def _ev(msg, sec=0):
    return (dt.datetime(2026, 11, 5, 12, 0, sec), "WARNING", "fe", msg)


def test_the_report_shows_the_new_guard_section_with_down_first_and_class_tags():
    events = [
        _ev("[orwell] N-17: replaced 2 invented-confession line(s) with a deflection (user=u)", 1),
        _ev("[orwell] faithfulness guard DOWN on a closed-set outcome draft — failing closed", 2),
        _ev("[orwell] pre-emission guard HELD a phantom closed-set outcome for user=u — dropped before emission, re-grounding next turn (class=N-16; RE-GROUND ON THE BOARD ...)", 3),
        _ev("[orwell] beat-signature desync detected for user=u — re-grounding next turn (class=A-9; RE-GROUND ...)", 4),
        _ev("[orwell] pre-emission location guard skipped for user=u: boom", 5),
        _ev("[orwell] replay guard: round 2 re-told the shown scene — dropped user=u", 6),
    ]
    R = psa.analyze(events, [], [], dt.datetime(2026, 11, 5, 11, 0), None)
    assert R["guard_lines"][("down", "faithfulness guard DOWN (a closed-set draft could not be judged)")] == 1
    assert R["guard_lines"][("fired", "N-17 replaced an invented confession")] == 1
    assert R["guard_lines"][("skipped", "pre-emission location guard errored (failed open)")] == 1
    assert dict(R["guard_classes"]) == {"N-16": 1, "A-9": 1}
    since = dt.datetime(2026, 11, 5, 11, 0)
    R["clock"] = psa.clock_metrics(events, [], None)
    text = psa.fmt(R, "w", {}, 0)
    section = text[text.index("### Other guard activity"):]
    assert section.index("GUARD DOWN") < section.index("N-17 replaced") < section.index("errored (failed open)")
    assert "N-16 x1" in section and "A-9 x1" in section


def test_a_guard_log_line_with_no_analyzer_marker_is_reported_by_the_scan(tmp_path, monkeypatch):
    """The scan itself (not a restated predicate) flags a new guard-like FE log literal that has no analyzer class."""
    for rel in FE_FILES:
        f = tmp_path / rel; f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("import logging\nlogger = logging.getLogger('x')\n")
    (tmp_path / FE_FILES[0]).write_text("logger.warning('[orwell] shiny new guard line fired for user=%s', u)\n")
    monkeypatch.setattr(sys.modules[__name__], "REPO", str(tmp_path))
    found = fe_guard_log_strings()
    markers = [m for m, _, _ in psa.GUARD_LINES] + list(LEGACY)
    assert found and not any(m in found[0][2] for m in markers)
