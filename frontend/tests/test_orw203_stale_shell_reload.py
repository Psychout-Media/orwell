"""ORW-203 — after a deploy the first load must not run the OLD cached page shell with NEW scripts.

sw.js serves "/" stale-while-revalidate, so the first load after a deploy paints the previous
index.html. The shell now carries its build id (<meta name="orwell-build">) and compares it with
/api/version's ``build``; a mismatch drops the cached "/" and reloads exactly once.

Three layers: (1) source pins, (2) the decision function run under node (mismatch -> exactly one
reload, match -> none, loop guard), (3) a real-browser old-build -> new-build sequence.
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = open(os.path.join(FRONTEND, "static", "index.html"), encoding="utf-8").read()


def _guard_fn_source():
    m = re.search(r"window\.orwellShellStale = function.*?\n\};\n", INDEX, re.S)
    assert m, "orwellShellStale missing from index.html"
    return m.group(0)


def test_shell_carries_build_stamp_and_guard_is_wired():
    assert '<meta name="orwell-build" content="{{BUILD_ID}}">' in INDEX
    assert "fetch('/api/version'" in INDEX.split("orwellShellStale")[1]
    assert "orwell-shell-reload" in INDEX


def test_reload_is_skipped_for_typed_input_or_active_stream_and_purge_is_scoped():
    seg = INDEX[INDEX.index("window.orwellShellStale = "):]
    assert "getElementById('message')" in seg and 'data-mode="streaming"' in seg
    assert "k.indexOf('orwell-') === 0" in seg and "AbortController" in seg


def test_build_id_is_html_escaped(monkeypatch):
    monkeypatch.setenv("ORWELL_FE_BUILD", 'x"><script>alert(1)</script>')
    import importlib
    from types import SimpleNamespace
    ver = importlib.import_module("src.orwell_version")
    monkeypatch.setattr(ver, "_cached_build", None)
    app_mod = importlib.import_module("app")
    req = SimpleNamespace(state=SimpleNamespace(csp_nonce="n"))
    html = app_mod._serve_html_with_nonce(req, os.path.join(FRONTEND, "static", "index.html")).body.decode()
    assert 'content="x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"' in html
    assert 'content="x"><script>' not in html


def test_server_substitutes_build_and_exposes_it(monkeypatch):
    monkeypatch.setenv("ORWELL_FE_BUILD", "abc1234")
    import importlib
    ver = importlib.import_module("src.orwell_version")
    monkeypatch.setattr(ver, "_cached_build", None)
    from fastapi.testclient import TestClient
    app_mod = importlib.import_module("app")
    c = TestClient(app_mod.app)
    assert c.get("/api/version").json()["build"] == "abc1234"
    from types import SimpleNamespace
    req = SimpleNamespace(state=SimpleNamespace(csp_nonce="n"))
    html = app_mod._serve_html_with_nonce(req, os.path.join(FRONTEND, "static", "index.html")).body.decode()
    assert '<meta name="orwell-build" content="abc1234">' in html
    assert "{{BUILD_ID}}" not in html


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_decision_function_mismatch_reloads_once_match_never():
    prog = "var window = globalThis;\n" + _guard_fn_source() + r"""
const mk = () => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); } }; };
const f = window.orwellShellStale; const out = {};
let s = mk();
out.mismatch_first = f('aaa', 'bbb', s);      // true: reload
out.mismatch_second = f('aaa', 'bbb', s);     // false: loop guard
out.match = f('bbb', 'bbb', mk());            // false
out.unknown_live = f('aaa', 'unknown', mk()); // false
out.unknown_shell = f('unknown', 'bbb', mk());
out.unsubstituted = f('{{BUILD_ID}}', 'bbb', mk());
out.empty = f('', 'bbb', mk());
out.next_deploy = f('aaa', 'ccc', s);         // a LATER deploy may reload once again
const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
{ const s2 = mk(); const t0 = 1000000;
  f('a', 'b1', s2, t0); f('a', 'b2', s2, t0 + 1000);
  out.flap_third_in_minute = f('a', 'b3', s2, t0 + 2000);   // 3rd reload inside a minute is refused
  out.flap_after_minute = f('a', 'b4', s2, t0 + 70000); }
out.storage_denied = f('aaa', 'bbb', broken); // never reload without a working loop guard
console.log(JSON.stringify(out));
"""
    res = subprocess.run(["node", "-e", prog], capture_output=True, text=True, timeout=30)
    assert res.returncode == 0, res.stderr
    out = json.loads(res.stdout)
    assert out == {
        "mismatch_first": True, "mismatch_second": False, "match": False,
        "unknown_live": False, "unknown_shell": False, "unsubstituted": False,
        "empty": False, "next_deploy": True, "storage_denied": False,
        "flap_third_in_minute": False, "flap_after_minute": True,
    }


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _boot(build, port, db):
    env = dict(
        os.environ, ORWELL_GAME_BUILD="1", AUTH_ENABLED="false", LOCALHOST_BYPASS="true",
        ORWELL_FE_BUILD=build, DATABASE_URL="sqlite:///" + db,
        PLAYWRIGHT_BROWSERS_PATH=os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers"),
    )
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env, stdout=open(f"/tmp/fe-orw203-{port}.log", "w"), stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        if proc.poll() is not None:
            raise RuntimeError("uvicorn exited early")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc
        except Exception:
            time.sleep(1)
    proc.terminate()
    raise RuntimeError("server never became ready")


def _stop(proc):
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()


def test_old_shell_after_deploy_self_corrects_once_in_a_real_browser():
    """Build A is served and cached by the SW; the app 'redeploys' as build B on the SAME origin;
    the next load must end on the B shell after exactly one extra navigation, and a further
    load must not reload again."""
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("playwright not installed")
    port = _free_port()
    db = os.path.join(tempfile.mkdtemp(prefix="orwell-203-"), "app.db")
    try:
        proc = _boot("buildAAA", port, db)
    except RuntimeError as e:
        pytest.skip(str(e))
    base = f"http://127.0.0.1:{port}"
    try:
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as e:
                pytest.skip(f"chromium unavailable: {e}")
            ctx = browser.new_context()
            page = ctx.new_page()
            page.set_default_timeout(20000)
            page.set_default_navigation_timeout(20000)
            nav = []
            page.on("framenavigated", lambda fr: nav.append(fr.url) if fr == page.main_frame else None)
            meta = "document.querySelector('meta[name=orwell-build]').content"

            page.goto(base + "/", wait_until="load")
            assert page.evaluate(meta) == "buildAAA"
            # Let the SW install and precache '/' (the old shell); bounded, never an unbounded evaluate.
            page.wait_for_timeout(3000)

            # --- 'deploy': same origin, new build ---
            _stop(proc)
            proc = _boot("buildBBB", port, db)
            nav.clear()
            page.goto(base + "/", wait_until="load")
            page.wait_for_function(f"{meta} === 'buildBBB'", timeout=15000)
            page.wait_for_timeout(1000)
            # one goto + exactly one corrective reload (never a loop)
            assert len(nav) <= 2, nav
            assert page.evaluate(meta) == "buildBBB"

            # A further load is a match: no corrective reload.
            nav.clear()
            page.goto(base + "/", wait_until="load")
            page.wait_for_timeout(1500)
            assert len(nav) == 1, nav
            assert page.evaluate(meta) == "buildBBB"
            browser.close()
    finally:
        _stop(proc)
