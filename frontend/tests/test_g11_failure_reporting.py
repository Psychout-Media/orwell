"""Lane G11 — the failure ring becomes the standard sink for fail-open catches.

ROOT CAUSE closed here: the house `catch (_) {}` fail-open idiom is correct UX but
structurally SILENT — every user-facing feature failure renders as absence (the
image-gen complaint, generalized). The fix is an ADDITION, never new behavior:
orwellReport.js (`window.OrwellReport.fail(surface, errorClass, detail)`) beacons
the failure to POST /api/orwell/fe-report, which logs `[fe-fail] …` so it lands in
the G1b LIVE ring (src/log_rings.py rides the root logger) and is visible on
/admin/status. Every swept catch stays fail-OPEN.

Name-agnostic (roles only). Covers:
  • the route: not admin-gated (player-context JS sends it), 204 always, the
    [fe-fail] line lands in the LIVE ring, shape validation (three short strings
    only — anything else drops silently), server-side clipping/flattening, the
    30/min/user rate limit (drop silently beyond), sendBeacon text/plain bodies;
  • source pins: the reporter exists with its contract (sendBeacon + fetch
    fallback, client throttle, never-throws), index.html loads it BEFORE the
    orwell panels, and each swept file calls OrwellReport.fail at least once —
    guarded, inside a catch, so a 404'd reporter can never break the fail-open.
"""

import importlib
import json
import os
import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

log_rings = importlib.import_module("src.log_rings")  # installs the LIVE ring root handler
orwell_routes = importlib.import_module("routes.orwell_routes")

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*parts):
    with open(os.path.join(BASE, *parts), encoding="utf-8") as f:
        return f.read()


@pytest.fixture
def client():
    # A fresh app per test = a fresh per-router rate limiter (no cross-test bleed).
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app, raise_server_exceptions=False)


def _ring_lines(cursor):
    _, lines = log_rings.LIVE.since(cursor)
    return [l["msg"] for l in lines if "[fe-fail]" in l["msg"]]


def _cursor():
    seq, _ = log_rings.LIVE.since(0)
    return seq


# ── the route: the beacon lands in the G1b LIVE ring ───────────────────────────

def test_fe_report_lands_in_the_live_ring(client):
    cur = _cursor()
    r = client.post("/api/orwell/fe-report", json={
        "surface": "g11-surface-a", "errorClass": "state-poll", "detail": "Error: HTTP 502",
    })
    assert r.status_code == 204  # the reporter never reads the response — silence by design
    lines = _ring_lines(cur)
    assert any("[fe-fail] g11-surface-a: state-poll — Error: HTTP 502" in m for m in lines), lines


def test_fe_report_is_not_admin_gated(client, monkeypatch):
    # Player-context JS sends it: under the default auth posture, with NO session at
    # all, the beacon still lands (contrast: /api/orwell/moment 403s, E15).
    monkeypatch.setenv("AUTH_ENABLED", "true")
    cur = _cursor()
    r = client.post("/api/orwell/fe-report", json={
        "surface": "g11-anon", "errorClass": "poll", "detail": "x",
    })
    assert r.status_code == 204
    assert any("g11-anon" in m for m in _ring_lines(cur))
    assert client.get("/api/orwell/moment").status_code == 403  # the admin gate is elsewhere, intact


def test_fe_report_drops_malformed_shapes_silently(client):
    cur = _cursor()
    bad = [
        ("not json at all", "text/plain"),                                # unparseable
        (json.dumps(["surface", "class", "detail"]), "application/json"),  # not a dict
        (json.dumps({"surface": 5, "errorClass": "x", "detail": "y"}), "application/json"),  # non-string
        (json.dumps({"surface": "", "errorClass": "x", "detail": "y"}), "application/json"),  # empty surface
        (json.dumps({"errorClass": "x", "detail": "y"}), "application/json"),  # missing surface
        (json.dumps({"surface": "s", "errorClass": {"a": 1}, "detail": "y"}), "application/json"),
    ]
    for body, ctype in bad:
        r = client.post("/api/orwell/fe-report", content=body, headers={"Content-Type": ctype})
        assert r.status_code == 204, "malformed input answers the same silence — nothing to probe"
    assert _ring_lines(cur) == [], "no malformed shape may reach the ring"


def test_fe_report_clips_and_flattens_fields(client):
    # Three SHORT strings only: the server clips overlong fields (the client already
    # slices detail to 300) and collapses newlines so one report = one ring line.
    cur = _cursor()
    r = client.post("/api/orwell/fe-report", json={
        "surface": "g11-clip", "errorClass": "c" * 500, "detail": "line1\nline2\n" + "d" * 5000,
    })
    assert r.status_code == 204
    lines = _ring_lines(cur)
    assert len(lines) == 1
    msg = lines[0]
    assert len(msg) < 600, "an abusive payload must not bloat the ring"
    assert "\n" not in msg
    assert "line1 line2" in msg


def test_fe_report_accepts_a_sendbeacon_text_plain_body(client):
    # navigator.sendBeacon may land as text/plain — content-type is no gate.
    cur = _cursor()
    body = json.dumps({"surface": "g11-beacon", "errorClass": "poll", "detail": "via beacon"})
    r = client.post("/api/orwell/fe-report", content=body,
                    headers={"Content-Type": "text/plain;charset=UTF-8"})
    assert r.status_code == 204
    assert any("g11-beacon" in m for m in _ring_lines(cur))


def test_fe_report_rate_limits_at_30_per_minute_and_drops_silently(client):
    cur = _cursor()
    for i in range(40):
        r = client.post("/api/orwell/fe-report", json={
            "surface": "g11-flood", "errorClass": "poll", "detail": f"n{i}",
        })
        assert r.status_code == 204, "beyond the window the answer is the SAME silence"
    flood = [m for m in _ring_lines(cur) if "g11-flood" in m]
    assert len(flood) == 30, f"exactly the window lands, the rest drop: {len(flood)}"


def test_fe_report_stores_nothing_beyond_the_ring():
    # No storage beyond the ring: the route only parses, rate-checks, and logs.
    src = _read("routes", "orwell_routes.py")
    block = src.split("fe-report", 1)[1]
    for verb in ("open(", "write_text", "sqlite", "Path(", "save_", "json.dump("):
        assert verb not in block, f"fe-report must not persist ({verb})"
    # The [fe-fail] line still logs through the standard format; the level is chosen per
    # report (INFO for genuine failures, DEBUG for a benign startup race — see below).
    assert '"[fe-fail] %s: %s — %s"' in src
    assert "logger.log(level" in src


# ── startup-race suppression: a benign boot race logs at DEBUG, not INFO ────────

def test_startup_tagged_report_is_downgraded_below_the_live_ring(client):
    # A `startup`-tagged report (a network "Failed to fetch" before the first engine
    # contact, inside the boot grace window) is a benign race — it logs at DEBUG and so
    # does NOT land in the LIVE ring (the ring handler is INFO-level). No noise at boot.
    cur = _cursor()
    r = client.post("/api/orwell/fe-report", json={
        "surface": "status-panel", "errorClass": "status-poll",
        "detail": "TypeError: Failed to fetch", "startup": True,
    })
    assert r.status_code == 204
    assert _ring_lines(cur) == [], "a startup race must not reach the INFO live ring"


def test_untagged_failure_still_logs_at_info(client):
    # The SAME shape WITHOUT the startup tag is a genuine (post-connect) failure — it
    # stays at INFO and lands in the ring. Real outages are never quieted.
    cur = _cursor()
    r = client.post("/api/orwell/fe-report", json={
        "surface": "status-panel", "errorClass": "status-poll",
        "detail": "TypeError: Failed to fetch",
    })
    assert r.status_code == 204
    assert any("status-panel: status-poll" in m for m in _ring_lines(cur))


def test_startup_flag_must_be_strictly_true_to_downgrade(client):
    # A truthy-but-not-True startup value does NOT downgrade (defensive: only the exact
    # client contract { startup: true } quiets the line).
    cur = _cursor()
    r = client.post("/api/orwell/fe-report", json={
        "surface": "g11-startupish", "errorClass": "poll", "detail": "x", "startup": "yes",
    })
    assert r.status_code == 204
    assert any("g11-startupish" in m for m in _ring_lines(cur)), "only startup:true quiets the line"


def test_reporter_tags_startup_only_for_network_errors_pre_connect():
    # Source pins on orwellReport.js: a markConnected latch, a boot grace window, the
    # network-error matcher, and the startup tag gated on all three.
    js = _read("static", "js", "orwellReport.js")
    assert "markConnected" in js
    assert "BOOT_GRACE_MS" in js
    assert "isNetworkFetchError" in js
    assert "failed to fetch" in js.lower()
    assert "startup" in js
    # the status panel latches a confirmed contact on a successful poll
    sp = _read("static", "js", "orwellStatusPanel.js")
    assert "markConnected" in sp


# ── source pins: the reporter module ───────────────────────────────────────────

def test_reporter_module_exists_with_its_contract():
    js = _read("static", "js", "orwellReport.js")
    assert "window.OrwellReport" in js
    assert "/api/orwell/fe-report" in js
    assert "navigator.sendBeacon" in js, "sendBeacon first (survives unload)"
    assert "fetch(" in js and "keepalive" in js, "fetch fallback when sendBeacon is unavailable"
    assert "MAX_PER_MIN" in js and "60000" in js, "client-side sliding-minute throttle"
    assert re.search(r"\.slice\(0,\s*n\)|slice\(0,\s*300\)", js), "detail clipped client-side"
    # NEVER throws: the entire fail() body is inside try { … } catch.
    body = js.split("function fail", 1)[1]
    # A42: the optional 4th param carries {red, corrected}
    assert body.lstrip().startswith("(surface, errorClass, detail, opts) {\n    try {"), \
        "fail() must open with try — reporting a failure can never become one"


def test_index_loads_the_reporter_before_the_orwell_panels():
    html = _read("static", "index.html")
    tag = '<script src="/static/js/orwellReport.js"></script>'
    assert tag in html, "index.html must load the reporter"
    pos = html.index(tag)
    for panel in ("orwellOnboarding.js", "orwellStatusPanel.js",
                  "orwellCast.js", "orwellPresence.js", "orwellRetrospective.js",
                  "orwellFinale.js", "orwellEngineStatus.js", "orwellDecision.js"):
        assert html.index(panel) > pos, f"the reporter must load before {panel}"


# ── source pins: the sweep — every fail-open surface reports ───────────────────

# file → minimum number of OrwellReport.fail call sites (cast: roster + backfill;
# retrospective: recap poll + vault open).
SWEPT = {
    "orwellFinale.js": 1,
    "orwellPresence.js": 1,
    "orwellRetrospective.js": 2,
    "orwellCast.js": 2,
    "orwellDecision.js": 1,
    "orwellStatusPanel.js": 1,
    "orwellEngineStatus.js": 1,
}


def test_every_swept_surface_calls_the_reporter():
    for fname, n in SWEPT.items():
        js = _read("static", "js", fname)
        calls = js.count("OrwellReport.fail(")
        assert calls >= n, f"{fname}: expected ≥{n} OrwellReport.fail sites, found {calls}"


def test_every_report_site_is_guarded_so_a_missing_reporter_cannot_break_the_catch():
    # The report is an ADDITION inside an existing fail-open catch: if orwellReport.js
    # itself 404s, the guard keeps the catch from throwing a ReferenceError.
    for fname in SWEPT:
        js = _read("static", "js", fname)
        for line in js.splitlines():
            if "OrwellReport.fail(" in line:
                assert "if (window.OrwellReport)" in line, f"unguarded report site in {fname}: {line.strip()}"


def test_report_sites_live_inside_catches_only():
    # Never new behavior: the reporter is only ever wired into a catch block —
    # each call line is preceded (within a few lines) by a `} catch (` opener.
    for fname in SWEPT:
        lines = _read("static", "js", fname).splitlines()
        for i, line in enumerate(lines):
            if "OrwellReport.fail(" not in line:
                continue
            window = "\n".join(lines[max(0, i - 4):i + 1])
            assert "catch (" in window, f"{fname}: report site not inside a catch: {line.strip()}"
