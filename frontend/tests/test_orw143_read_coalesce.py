"""ORW-143: the shared /api/orwell/* reads are single-flighted client-side (JS-source pins + node behaviour)."""
import os
import shutil
import subprocess
import textwrap

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(FRONTEND, "static", "js", "orwellReadCoalesce.js")


def test_coalescer_is_loaded_before_the_engine_status_poller():
    html = open(os.path.join(FRONTEND, "static", "index.html"), encoding="utf-8").read()
    assert html.index("orwellReadCoalesce.js") < html.index("orwellEngineStatus.js")


def test_coalescer_listens_but_never_dispatches_gamechanged():
    src = open(JS, encoding="utf-8").read()
    assert 'addEventListener("orwell:gamechanged"' in src
    assert "new CustomEvent" not in src and "dispatchEvent" not in src  # g15: one dispatcher


@pytest.mark.skipif(not shutil.which("node"), reason="node required")
def test_behaviour_single_flight_ttl_and_invalidation(tmp_path):
    harness = tmp_path / "h.js"
    harness.write_text(textwrap.dedent(f"""
        let n = 0; const listeners = {{}};
        global.window = global;
        global.location = {{ href: "http://x/" }};
        global.addEventListener = (e, f) => {{ listeners[e] = f; }};
        global.fetch = (u, init) => {{ n++; return Promise.resolve({{ ok: true, clone() {{ return this; }} }}); }};
        require({JS!r});
        (async () => {{
          const assert = require("assert");
          await Promise.all([1,2,3,4,5].map(() => fetch("/api/orwell/state")));
          assert.strictEqual(n, 1, "concurrent reads share one request");
          await fetch("/api/orwell/state"); assert.strictEqual(n, 1, "TTL reuse");
          await fetch("/api/orwell/roster"); assert.strictEqual(n, 2, "per-path");
          listeners["orwell:gamechanged"]();
          await fetch("/api/orwell/state"); assert.strictEqual(n, 3, "gamechanged invalidates");
          await fetch("/api/orwell/state", {{ method: "POST" }}); assert.strictEqual(n, 4);
          await fetch("/api/orwell/state"); assert.strictEqual(n, 5, "write invalidates");
          const c = new AbortController();
          await fetch("/api/orwell/state", {{ signal: c.signal }}); assert.strictEqual(n, 6, "signal bypasses");
          await fetch("/api/other"); await fetch("/api/other"); assert.strictEqual(n, 8, "other URLs untouched");
          console.log("ok");
        }})().catch(e => {{ console.error(e); process.exit(1); }});
    """))
    r = subprocess.run(["node", str(harness)], capture_output=True, text=True)
    assert r.returncode == 0 and "ok" in r.stdout, r.stderr
