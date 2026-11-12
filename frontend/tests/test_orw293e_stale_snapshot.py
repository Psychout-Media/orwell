"""ORW-293e: a session rebuild must not paint a history snapshot that is BEHIND what the page already shows.

selectSession fetches /api/history, then waits out a 120 ms fade, then wipes the pane and paints that snapshot. When the turn finishes inside that window (the reply is persisted and
the settle reconcile has already painted it), the snapshot is stale and painting it removed the newer reply from the screen, with the server history still holding it (the CI
"reply shown 0 times" in test_orw139). Unit test of the pure check under node, plus a deterministic real-browser repro: seed a session, then re-select it with a history that lacks
the persisted reply, and the reply must survive. Roles only."""
import json
import os
import shutil
import subprocess
import sys

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(FRONTEND, "static", "js", "sessions.js")
NODE = shutil.which("node")
sys.path.insert(0, os.path.join(FRONTEND, "scripts"))

PROGRAM = r"""
const fs = require('fs');
const src = fs.readFileSync(process.argv[1], 'utf8');
const i = src.indexOf('export function snapshotBehindDom(');
let depth = 0, started = false, end = -1;
for (let j = src.indexOf('{', i); j < src.length; j++) {
  if (src[j] === '{') { depth++; started = true; } else if (src[j] === '}') { depth--; if (started && depth === 0) { end = j + 1; break; } }
}
const f = new Function(src.slice(i, end).replace('export function', 'function') + '; return snapshotBehindDom;')();
const h = [{ id: 'u1' }, { id: 'a1' }, { metadata: { _db_id: 'a2' } }];
process.stdout.write(JSON.stringify({
  inSync: f(h, ['u1', 'a1']),
  domAhead: f(h, ['u1', 'a1', 'a3']),
  metaIdCounts: f(h, ['a2']),
  emptyDom: f(h, []),
  noHistoryDomHasRows: f([], ['a1']),
  nulls: f(null, null),
}));
"""


@pytest.mark.skipif(NODE is None, reason="node not available")
def test_the_snapshot_is_behind_only_when_the_page_holds_a_persisted_message_it_lacks():
    res = subprocess.run([NODE, "-e", PROGRAM, "--", JS], capture_output=True, text=True, timeout=60)
    assert res.returncode == 0, res.stderr
    o = json.loads(res.stdout)
    assert o["inSync"] is False and o["metaIdCounts"] is False and o["emptyDom"] is False and o["nulls"] is False, o
    assert o["domAhead"] is True and o["noHistoryDomHasRows"] is True, o


@pytest.fixture(scope="module")
def fe():
    import responsive_matrix as rm
    proc = rm.boot_fe()
    yield rm.FE
    rm.stop_fe(proc)


def _j(o, status=200):
    return {"status": status, "content_type": "application/json", "body": json.dumps(o)}


def test_a_stale_history_does_not_wipe_a_reply_the_page_already_shows(fe):
    sync_api = pytest.importorskip("playwright.sync_api")
    # the real /api/history rows carry the persisted id in metadata._db_id (that is what stamps data-db-id on a rendered bubble)
    state = {"history": [{"role": "user", "content": "I look around the kitchen.", "metadata": {"_db_id": "u1"}},
                         {"role": "assistant", "content": "The kitchen hums with golden-one.", "metadata": {"_db_id": "a1"}}]}
    sid = "s-stale-snapshot"
    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_context(viewport={"width": 1100, "height": 800}).new_page()
            page.route("**/api/orwell/state", lambda r: r.fulfill(**_j({"started": True, "asleep": []})))
            page.route("**/api/orwell/status", lambda r: r.fulfill(**_j({})))
            page.route("**/api/orwell/roster", lambda r: r.fulfill(**_j({"roster": []})))
            page.route("**/api/orwell/whereabouts", lambda r: r.fulfill(**_j({"whereabouts": {"room": "kitchen", "present": []}})))
            page.route(f"**/api/history/{sid}", lambda r: r.fulfill(**_j({"history": state["history"], "model": None})))
            page.goto(fe, wait_until="domcontentloaded")
            page.wait_for_selector("#chat-history", timeout=15000)
            page.evaluate("(id) => window.sessionModule.selectSession(id)", sid)
            for _ in range(40):  # (wait_for_function evals a string, which the page CSP refuses - poll with evaluate)
                if page.evaluate("document.querySelectorAll('#chat-history .msg[data-db-id]').length") >= 2:
                    break
                page.wait_for_timeout(150)
            else:
                raise AssertionError("the seeded session never rendered its persisted rows")
            before = page.evaluate("Array.from(document.querySelectorAll('#chat-history .msg[data-db-id]')).map(e => e.dataset.dbId)")
            assert before == ["u1", "a1"], before
            # a turn finished and was painted while a rebuild was fading; the rebuild's snapshot predates that reply
            state["history"] = state["history"][:1]
            page.evaluate("(id) => window.sessionModule.selectSession(id)", sid)
            page.wait_for_timeout(900)
            after = page.evaluate("Array.from(document.querySelectorAll('#chat-history .msg[data-db-id]')).map(e => e.dataset.dbId)")
            assert after == ["u1", "a1"], f"the stale snapshot wiped the reply: {after}"
            assert page.evaluate("getComputedStyle(document.getElementById('chat-history')).opacity") == "1"   # and the pane is not left faded out
        finally:
            browser.close()
