"""ORW-168 - the reconcile's converged-case probe and the routine-wave cache keep, proven in the REAL page (headless Chromium).

1. softReloadHistory asks `/api/history/{id}?limit=1` first. When the DOM is a plain, adopted, idle transcript whose tail bubble IS
   the server's newest row and the server's count matches, NO full fetch happens and the DOM is untouched. Anything else (a newer
   row, a count mismatch, an optimistic bubble, an older server that ignores `limit`) takes the unchanged full-fetch path, so no
   message is ever missed (F1-F5, ADR 0008/0012).
2. A routine `orwell:gamechanged` wave (turn-settled / tab-visible / decision:*) keeps the 4 s canonical-game cache; any other wave
   still drops it.
No model. Roles only. Auto-marked ``browser`` (sync_playwright).
"""
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def _app():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright not installed")
    env = dict(os.environ, ORWELL_GAME_BUILD="1", AUTH_ENABLED="false", LOCALHOST_BYPASS="true",
               PLAYWRIGHT_BROWSERS_PATH=os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers"),
               DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-168-"), "app.db"))
    port = _free_port()
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
                            cwd=FRONTEND, env=env, stdout=open(f"/tmp/fe-168-{port}.log", "w"), stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        if proc.poll() is not None:
            pytest.skip("uvicorn exited early")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            break
        except Exception:
            time.sleep(1)
    else:
        proc.terminate()
        pytest.skip("server never became ready")
    yield base
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()


def _row(seq, role, text):
    return {"role": role, "id": f"r{seq}", "seq": seq, "content": text, "metadata": {"_db_id": f"r{seq}", "_seq": seq}}


_HARNESS = r"""
async (cfg) => {
  const chat = window.chatModule, sess = window.sessionModule;
  const SID = 'orw168-session';
  sess.setCurrentSessionId(SID);
  const box = document.getElementById('chat-history');
  box.innerHTML = '';
  box.insertAdjacentHTML('beforeend', cfg.plant);
  const calls = [];
  const origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.indexOf('/api/history/' + SID) !== -1) {
      const probe = url.indexOf('limit=1') !== -1;
      calls.push(probe ? 'probe' : 'full');
      let body;
      if (probe && cfg.legacy) body = { history: cfg.server, model: 'm' };
      else if (probe) body = { history: cfg.server.slice(-1), model: 'm', page: { total: cfg.total, hasMore: cfg.server.length > 1 } };
      else body = { history: cfg.server, model: 'm' };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return origFetch(url, opts);
  };
  try { await chat.softReloadHistory(SID); } finally { window.fetch = origFetch; }
  return {
    calls,
    kept: !!box.querySelector('[data-sentinel="kept"]'),
    ids: Array.from(box.querySelectorAll('.msg[data-db-id]')).map((e) => e.dataset.dbId),
  };
}
"""

_PLANT = (
    '<div class="msg msg-user" data-db-id="r1" data-seq="1" data-sentinel="kept"><div class="body">hi</div></div>'
    '<div class="msg msg-ai" data-db-id="r2" data-seq="2"><div class="body">hello</div></div>'
)
_SERVER = [_row(1, "user", "hi"), _row(2, "assistant", "hello")]


def _run(app, cfg):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        page.goto(app + "/", wait_until="load", timeout=30000)
        page.wait_for_timeout(3000)
        out = page.evaluate(_HARNESS, cfg)
        browser.close()
    return out


def test_converged_reconcile_needs_only_the_probe_and_leaves_the_dom_alone(_app):
    out = _run(_app, {"plant": _PLANT, "server": _SERVER, "total": 2})
    assert out["calls"] == ["probe"], out
    assert out["kept"], "a converged reconcile must not rebuild"


def test_a_newer_server_row_falls_through_to_the_full_fetch_and_is_rendered(_app):
    server = _SERVER + [_row(3, "assistant", "a peer reply")]
    out = _run(_app, {"plant": _PLANT, "server": server, "total": 3})
    assert out["calls"] == ["probe", "full"], out
    assert out["ids"] == ["r1", "r2", "r3"], out


def test_a_count_mismatch_falls_through(_app):
    out = _run(_app, {"plant": _PLANT, "server": _SERVER, "total": 3})   # server claims an extra older row we do not show
    assert out["calls"] == ["probe", "full"], out


def test_an_optimistic_bubble_never_probes(_app):
    plant = _PLANT + '<div class="msg msg-user" data-client-msg-id="c1"><div class="body">typing</div></div>'
    out = _run(_app, {"plant": plant, "server": _SERVER, "total": 2})
    assert out["calls"] == ["full"], out


def test_an_older_server_that_ignores_limit_costs_one_request(_app):
    out = _run(_app, {"plant": _PLANT, "server": _SERVER, "total": 2, "legacy": True})
    assert out["calls"] == ["probe"], out        # the probe response WAS the full log; it is used, not refetched
    assert out["kept"]


_WAVE = r"""
async (reasons) => {
  const sess = window.sessionModule;
  let n = 0;
  const origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.indexOf('/api/orwell/game-session') !== -1) {
      n += 1;
      return new Response(JSON.stringify({ sessionId: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return origFetch(url, opts);
  };
  try {
    await sess._resolveCanonicalGameSession();
    const before = n;
    window.dispatchEvent(new CustomEvent('orwell:gamechanged', { detail: { reason: reasons[0], reasons } }));
    await sess._resolveCanonicalGameSession();
    return { before, after: n };
  } finally { window.fetch = origFetch; }
}
"""


def _wave(app, reasons):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        page.goto(app + "/", wait_until="load", timeout=30000)
        page.wait_for_timeout(3000)
        has = page.evaluate("() => !!(window.sessionModule && window.sessionModule._resolveCanonicalGameSession)")
        if not has:
            browser.close()
            pytest.skip("canonical-game resolver is not exposed on sessionModule")
        out = page.evaluate(_WAVE, reasons)
        browser.close()
    return out


def test_a_routine_wave_keeps_the_canonical_game_cache(_app):
    out = _wave(_app, ["turn-settled", "tab-visible"])
    assert out["after"] == out["before"], out


def test_a_real_game_change_still_drops_it(_app):
    out = _wave(_app, ["next-season"])
    assert out["after"] > out["before"], out
