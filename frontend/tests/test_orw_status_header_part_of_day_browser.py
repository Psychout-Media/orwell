"""The House status panel's header names the week, the phase AND the part of day, on premiere night as at any other hour (Kevin, live: "Week 1  Premiere" with no part of day after it).
Real browser; the status payloads are the engine's own shapes (`timeOfDay`, `dayNumber`, `earlyMorning`); the premiere-night payload is what the engine now sends before the clock starts. Own module so conftest routes it to the serial browser lane."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))


def _j(o, status=200):
    return {"status": status, "content_type": "application/json", "body": json.dumps(o)}


def _status(**kw):
    base = {"started": True, "beatSeq": 5, "week": 1, "phase": "hoh-competition", "hoh": None, "nominees": [], "veto": {}, "pending": None, "asleep": [], "awake": []}
    base.update(kw)
    return base


CASES = [
    ("premiere night", _status(phase="premiere", timeOfDay="evening", dayNumber=1), "Week 1", "Premiere", "Evening, Day 1"),
    # created, premiere entrances in progress, no in-game message yet (the clock has not started): the part of day comes from the engine's premiere preview
    ("premiere entrances in progress", _status(phase="premiere", timeOfDay="evening", dayNumber=1, asleep=[], awake=[], entrance={"stage": "entrances", "arrived": 14, "total": 16}), "Week 1", "Premiere", "Evening, Day 1"),
    # the shape the engine sends once the player has spoken and the entrances are done: the clock runs, the day number rides along, the house list is present
    ("premiere night after the player has spoken", _status(phase="premiere", timeOfDay="night", dayNumber=1, asleep=[], awake=[{"id": "npc:1", "name": "Houseguest A"}]), "Week 1", "Premiere", "Night, Day 1"),
    ("a normal evening", _status(week=2, phase="hoh-competition", timeOfDay="evening", dayNumber=8), "Week 2", "HOH competition", "Evening, Day 8"),
    ("early morning", _status(week=1, phase="nominations", timeOfDay="late-night", earlyMorning=True, dayNumber=3), "Week 1", "Nominations", "Early morning, Day 3"),
    ("late night", _status(week=1, phase="nominations", timeOfDay="late-night", dayNumber=2), "Week 1", "Nominations", "Late night, Day 2"),
]


@pytest.fixture(scope="module")
def fe():
    import responsive_matrix as rm
    proc = rm.boot_fe()
    yield rm.FE
    rm.stop_fe(proc)


def _header(page):
    return page.evaluate("""() => { const q = (id) => document.getElementById(id);
      const t = q('os-tod');
      return { week: (q('os-week') || {}).textContent || '', phase: (q('os-phase') || {}).textContent || '',
               tod: t ? t.textContent : null, todShown: !!t && !t.hidden && t.getBoundingClientRect().width > 0 }; }""")


def test_the_status_header_shows_week_phase_and_part_of_day(fe):
    sync_api = pytest.importorskip("playwright.sync_api")
    state = {"payload": CASES[0][1]}
    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
            page.route("**/api/orwell/status", lambda r: r.fulfill(**_j(state["payload"])))
            page.route("**/api/orwell/state", lambda r: r.fulfill(**_j({"started": True, "asleep": []})))
            page.route("**/api/orwell/whereabouts", lambda r: r.fulfill(**_j({"whereabouts": {"room": "kitchen", "present": []}})))
            page.route("**/api/orwell/roster", lambda r: r.fulfill(**_j({"roster": []})))
            page.goto(fe, wait_until="domcontentloaded")
            for label, payload, week, phase, tod in CASES:
                state["payload"] = payload
                page.evaluate("window.dispatchEvent(new CustomEvent('orwell:gamechanged'))")
                got = None
                for _ in range(40):
                    got = _header(page)
                    if got["week"].strip() == week and got["phase"].strip() == phase and (got["tod"] or "").endswith(tod) and got["todShown"]:  # (the chip can be mid-reveal for a moment after its text changes)
                        break
                    page.wait_for_timeout(250)
                assert got["week"].strip() == week and got["phase"].strip() == phase, (label, got)
                assert got["todShown"] and got["tod"].endswith(tod) and got["tod"].count(",") == 1, (label, got)  # (the label carries a leading emoji)
        finally:
            browser.close()
