"""A76 - the status panel announces a CHANGE of the part of day (morning -> afternoon ...) to screen readers through #os-announce, once, politely; never per message, never on the first poll.
Runs the real `announceDeltas` source under node against a fake element. Roles only."""
import json
import os
import re
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(ROOT, "..", "static", "js", "orwellStatusPanel.js"), encoding="utf-8").read()


def _harness(polls):
    a = SRC.index("// A3: announce only what CHANGED")
    b = SRC.index("  function render(st) {")
    chunk = SRC[a:b]
    return (
        "const PHASE_LABELS = {}; const phaseLabel = (p) => String(p || '');\n"
        "function flashRow() {}\n" + chunk + "\n"
        "const out = []; const a = { textContent: '' };\n"
        "const el = { querySelector: (q) => (q === '#os-announce' ? a : null) };\n"
        "const polls = " + json.dumps(polls) + ";\n"
        "for (const st of polls) { a.textContent = ''; announceDeltas(el, st, { hoh: '—', noms: '—', veto: '—' }); out.push(a.textContent); }\n"
        "console.log(JSON.stringify(out));\n"
    )


def _run(polls):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(_harness(polls)); path = f.name
    try:
        r = subprocess.run(["node", path], capture_output=True, text=True, timeout=20)
    finally:
        os.unlink(path)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout.strip().splitlines()[-1])


def _p(tod, phase="hoh-competition"):
    return {"phase": phase, "timeOfDay": tod}


def test_a_part_of_day_change_writes_one_line_and_nothing_else_does():
    out = _run([_p("morning"), _p("morning"), _p("afternoon"), _p("afternoon"), _p("evening")])
    assert out == ["", "", "Afternoon.", "", "Evening."]


def test_a_second_poll_inside_the_same_part_of_day_writes_nothing():
    assert _run([_p("morning"), _p("morning"), _p("morning")]) == ["", "", ""]


def test_clock_off_or_missing_timeofday_never_announces_and_does_not_poison_the_next_change():
    out = _run([{"phase": "hoh-competition"}, {"phase": "hoh-competition"}, _p("morning"), _p("afternoon")])
    assert out[:3] == ["", "", ""] and out[3] == "Afternoon."


def test_the_first_poll_is_a_baseline_not_an_announcement():
    assert _run([_p("evening")]) == [""]


def test_the_stale_opt_in_comment_is_corrected():
    assert "opt-in engine side" not in SRC and "default-ON engine side" in SRC
