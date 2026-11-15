"""A81 - the analyzer must have a class for every narration-guard log line the front-end can emit (drift test), and report the new guard section from tiny fixtures. Run: python3 -m pytest rehearsal-kit/test_guard_log_drift.py
FE source is read from $ORWELL_REPO (default /home/ryne/orwell). Roles only."""
import ast
import datetime as dt
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import post_session_analyzer as psa  # noqa: E402

REPO = os.environ.get("ORWELL_REPO", "/home/ryne/orwell")
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
        if not os.path.exists(path):
            continue
        tree = ast.parse(open(path, encoding="utf-8").read())
        for n in ast.walk(tree):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in ("warning", "info", "error") and n.args:
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


def test_a_renamed_fe_log_string_would_be_caught_by_the_drift_test():
    markers = [m for m, _, _ in psa.GUARD_LINES] + list(LEGACY)
    assert not any(m in "[orwell] shiny new guard line fired for user=u" for m in markers)
