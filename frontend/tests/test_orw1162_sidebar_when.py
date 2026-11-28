"""ORW-1162: one front-end source ("orwellWhen.js") feeds every sidebar "when is it" label.

Executed in node against the real, unmodified sources: the shared helper, plus the status panel's own
headerPhase / phaseLabel / nextEventLabel and the night gadget's title.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile

import pytest

FE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(FE, "static", "js")
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not available")


def _read(name):
    with open(os.path.join(JS, name), encoding="utf-8") as fh:
        return fh.read()


def _fn(src, name):
    start = src.index("function " + name + "(")
    i = src.index("{", start)
    depth = 0
    for j in range(i, len(src)):
        depth += {"{": 1, "}": -1}.get(src[j], 0)
        if depth == 0:
            return src[start:j + 1]
    raise AssertionError(name)


def _run(call):
    panel = _read("orwellStatusPanel.js")
    names = panel[panel.index("const NEXT_EVENT_NAME"): panel.index("};", panel.index("const NEXT_EVENT_NAME")) + 2]
    labels = panel[panel.index("const PHASE_LABELS"): panel.index("};", panel.index("const PHASE_LABELS")) + 2]
    plabel = "const phaseLabel = (p) => PHASE_LABELS[p] || String(p || '').replace(/-/g, ' ');"
    fns = "\n".join(_fn(panel, n) for n in ("headerPhase", "isPreHoh", "preHohLabel", "nextEventWhen", "nextEventLabel"))
    src = (
        "global.window = {}; require(%s);\n" % json.dumps(os.path.join(JS, "orwellWhen.js"))
        + names + "\n" + labels + "\n" + plabel + "\n" + fns + "\n"
        + "console.log(JSON.stringify(" + call + "));\n"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(src)
        path = f.name
    try:
        out = subprocess.run(["node", path], capture_output=True, text=True, timeout=20)
    finally:
        os.unlink(path)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


def _day2_premiere(**over):
    gs = {
        "timeOfDay": "morning", "dayNumber": 2, "moment": "premiere", "clockLabel": "9:05am, Day 2",
        "daySchedule": {"headerPhase": "hoh-competition", "next": "hoh-competition", "phase": "afternoon", "due": False},
        "premiere": {"complete": True, "remaining": [], "met": [{"houseguest": {"id": "a", "name": "A"}}]},
    }
    gs.update(over)
    st = {"week": 1, "phase": "premiere", "timeOfDay": "morning", "dayNumber": 2, "_state": gs}
    return st


def test_day2_morning_premiere_reads_as_morning_not_night_or_comp():
    st = json.dumps(_day2_premiere())
    header = _run("phaseLabel(headerPhase(%s))" % st)
    assert header == "Premiere"
    title = _run("window.OrwellWhen.premiereTitle(%s._state)" % st)
    assert "night" not in title.lower() and "move-in night" not in title.lower()
    assert _run("window.OrwellWhen.showCastStrip(%s._state)" % st) is False
    assert _run("nextEventLabel(%s)" % st) == "First HOH: this afternoon"
    assert _run("window.OrwellWhen.band(%s._state)" % st)[1] == "Morning"


def test_night_state_still_reads_as_night():
    gs = {"timeOfDay": "night", "dayNumber": 1, "moment": "premiere", "premiere": {"complete": False, "remaining": [{"houseguest": {"id": "x"}}], "met": []},
          "daySchedule": {"headerPhase": "hoh-competition", "next": "hoh-competition", "phase": "afternoon", "tomorrow": True}}
    st = json.dumps({"week": 1, "phase": "premiere", "timeOfDay": "night", "dayNumber": 1, "_state": gs})
    assert _run("window.OrwellWhen.premiereTitle(%s._state)" % st) == "Move-in night"
    assert _run("window.OrwellWhen.showCastStrip(%s._state)" % st) is True
    assert _run("window.OrwellWhen.band(%s._state)" % st)[1] == "Night"


def test_hoh_comp_state_reads_as_the_comp():
    # the comp is due while the premiere flag lingers, and a later week in a plain HOH-competition phase
    due = _day2_premiere()
    due["_state"]["daySchedule"]["due"] = True
    assert _run("phaseLabel(headerPhase(%s))" % json.dumps(due)) == "HOH competition"
    plain = {"week": 2, "phase": "hoh-competition", "_state": {"moment": "hoh-competition", "daySchedule": {"headerPhase": "hoh-competition"}}}
    assert _run("phaseLabel(headerPhase(%s))" % json.dumps(plain)) == "HOH competition"


def test_time_gadget_title_is_never_nightfall():
    for name in ("orwellNightStatus.js", "orwellGadgetRail.js"):
        src = _read(name)
        assert 'title: "Nightfall"' not in src and 'ariaLabel: "Nightfall"' not in src
    assert 'title: "Time of day"' in _read("orwellNightStatus.js")
    assert "orwellWhen.js" in open(os.path.join(FE, "static", "index.html"), encoding="utf-8").read()
