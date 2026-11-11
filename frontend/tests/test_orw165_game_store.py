"""ORW-165 slice 1: one client game-state store. Source pins + node behaviour (browser test: test_orw165_game_store_browser.py)."""
import os
import re
import shutil
import subprocess
import textwrap

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(FRONTEND, "static", "js")
STORE = os.path.join(JS, "orwellGameStore.js")
CONSUMERS = ["orwellStatusPanel.js", "orwellRoomStrip.js", "orwellCast.js"]


def _src(name):
    return open(os.path.join(JS, name), encoding="utf-8").read()


@pytest.mark.parametrize("name", CONSUMERS)
def test_consumer_no_longer_fetches_shared_state_itself(name):
    src = _src(name)
    # no direct fetch of the three shared reads (the store is the only fetcher); getJSON helpers route them through it
    assert not re.search(r"fetch\(\s*[\"']/api/orwell/(state|status|roster)", src), name
    assert "OrwellGame.get(" in src, name


def test_only_the_store_fetches_the_three_paths():
    src = _src("orwellGameStore.js")
    for p in ("/api/orwell/state", "/api/orwell/status", "/api/orwell/roster"):
        assert p in src


def test_store_is_loaded_before_every_consumer_and_never_dispatches():
    html = open(os.path.join(FRONTEND, "static", "index.html"), encoding="utf-8").read()
    for name in CONSUMERS:
        assert html.index("orwellGameStore.js") < html.index(name), name
    src = _src("orwellGameStore.js")
    assert 'addEventListener("orwell:gamechanged"' in src
    assert "new CustomEvent" not in src and "dispatchEvent" not in src  # g15: one dispatcher (platform.js)


def test_service_worker_cache_was_bumped_for_the_new_static_file():
    sw = open(os.path.join(FRONTEND, "static", "sw.js"), encoding="utf-8").read()
    assert "orwell-v333'" not in sw


@pytest.mark.skipif(not shutil.which("node"), reason="node required")
def test_store_behaviour_single_flight_freshness_invalidation_subscribe(tmp_path):
    h = tmp_path / "h.js"
    h.write_text(textwrap.dedent(f"""
        let n = 0, fail = false; const listeners = {{}};
        global.window = global;
        global.addEventListener = (e, f) => {{ listeners[e] = f; }};
        global.fetch = (u) => {{ n++; const ok = !fail; return Promise.resolve({{ ok, status: ok ? 200 : 500, json: () => Promise.resolve({{ u, n }}) }}); }};
        require({STORE!r});
        (async () => {{
          const assert = require("assert"), G = window.OrwellGame, seen = [];
          const un = G.subscribe("state", (v) => seen.push(v.n));
          const rs = await Promise.all([G.get("state"), G.get("state"), G.get("state")]);
          assert.strictEqual(n, 1, "concurrent reads share one request");
          assert.ok(rs[0] === rs[1] && rs[1] === rs[2], "one snapshot for every caller");
          await G.get("state"); assert.strictEqual(n, 1, "freshness window");
          await G.get("roster"); assert.strictEqual(n, 2, "per kind");
          await G.get("state", {{ force: true }}); assert.strictEqual(n, 3, "force bypasses freshness");
          listeners["orwell:gamechanged"]();
          assert.strictEqual(G.peek("state"), undefined, "gamechanged drops the snapshot");
          await G.get("state"); assert.strictEqual(n, 4, "refetch after gamechanged");
          assert.deepStrictEqual(seen, [1, 3, 4], "subscribers see each fresh snapshot");
          un(); await G.get("state", {{ force: true }}); assert.deepStrictEqual(seen, [1, 3, 4], "unsubscribed");
          fail = true; listeners["orwell:gamechanged"]();
          await assert.rejects(G.get("status"), /HTTP 500/);
          fail = false; await G.get("status"); assert.strictEqual(n, 7, "a failure is never stored");
          console.log("OK");
        }})().catch((e) => {{ console.error(e); process.exit(1); }});
    """))
    r = subprocess.run(["node", str(h)], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0 and "OK" in r.stdout, r.stdout + r.stderr
