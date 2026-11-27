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
    # ORW-481 (review 4534603431): CAPTURE phase, so the cache is cleared before any panel's own bubble-phase gamechanged listener refetches
    assert 'addEventListener("orwell:gamechanged", clear, true)' in src


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


@pytest.mark.skipif(not shutil.which("node"), reason="node required")
def test_a_read_issued_while_a_write_is_in_flight_is_not_served_after_it_settles(tmp_path):
    """ORW-1107: the season-reset POST was in flight, a poller read the still-live state, and the New Chat guard (running right after the POST resolved) was handed that stale
    answer and asked the player to end the season a second time."""
    harness = tmp_path / "w.js"
    harness.write_text(textwrap.dedent(f"""
        let n = 0, release, fail;
        global.window = global;
        global.location = {{ href: "http://x/" }};
        global.addEventListener = () => {{}};
        const res = (tag) => ({{ ok: true, tag, clone() {{ return this; }} }});
        global.fetch = (u, init) => {{
          if (init && init.method === "POST") return new Promise((ok, no) => {{ release = () => ok(res("write")); fail = () => no(new Error("down")); }});
          return Promise.resolve(res(++n));
        }};
        require({JS!r});
        (async () => {{
          const assert = require("assert");
          for (const settle of ["ok", "fail"]) {{
            const write = fetch("/api/orwell/reset-progress", {{ method: "POST" }});
            const during = await fetch("/api/orwell/state");
            let after;
            const next = write.then(() => fetch("/api/orwell/state"), () => fetch("/api/orwell/state")).then((r) => {{ after = r; }});
            (settle === "ok" ? release : fail)();
            await next;
            assert.notStrictEqual(after.tag, during.tag, "a fresh read after the write settles (" + settle + ")");
          }}
          console.log("ok");
        }})().catch(e => {{ console.error(e); process.exit(1); }});
    """))
    r = subprocess.run(["node", str(harness)], capture_output=True, text=True)
    assert r.returncode == 0 and "ok" in r.stdout, r.stderr
