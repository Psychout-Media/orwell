"""M0-3 — the owed ADR-0008/0012 mid-generation-join pin (F5 realtime two-window parity).

The residual on the ADR 0008/0012 verification list: a SECOND window opening while a
narration is MID-GENERATION must attach to the in-flight run (the Messenger-mirror seam:
canonical session resolve → `GET /api/chat/events/{id}` subscribe → `deferPeerResume`
while streaming → converge on settle) and end byte-identical to the first window — never
a blank chat, never a duplicate bubble, never a stripped reply (#1086's class).

This is the DETERMINISTIC pin: a real engine (seeded season, logical-clock-free), the
real FE, and a scripted OpenAI-compatible stub whose final narration streams SLOWLY
(~20s) so "mid-generation" is a wide, reliably-hittable window. The run is kicked over
REST (a third device), window A joins from the start of the stream, window B joins
mid-stream; both must show live partial text before settle and identical settled
transcripts after. A live-model run of the same scenario is the ship-gate evidence
(`docs/audits/2026-06-27-ship-gate.md` §F5); this test keeps the seam from regressing.

Roles only — the player name is a generic label; the cast is engine-seeded.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(FRONTEND)

SEED = 30012  # any fixed seed — determinism anchor for the engine walk

# The slow narration the mirror must carry into BOTH windows. Long enough to stream
# visibly; distinctive enough that a partial sample can never false-positive. The window
# must dwarf worst-case page boot (goto + module graph + the 1.5s sessionSync tick +
# converge + resume ≈ 4–8s on a loaded CI runner) TWICE — window B opens only after A
# has sampled a partial.
# Each delta is a complete SENTENCE: the game-build leak scrub buffers the visible
# stream to sentence boundaries before the pre-emission guards run and the delta emits
# (agent_loop's `_split_complete_sentences` seam) — terminator-less prose would buffer
# the WHOLE round and emit as one settle burst, which is exactly the false negative this
# pin must not have (found the hard way: `beat-00 beat-01 …` never streamed).
SLOW_DELTAS = [f"beat-{i:02d}. " for i in range(80)]
SLOW_TEXT = "".join(SLOW_DELTAS).strip()
SLOW_DELAY_S = 0.25  # 80 × 0.25s ≈ 20s of live streaming — a wide mid-gen window


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


# ── the scripted OpenAI-compatible stub ────────────────────────────────────────────────
# One queue of scripted STREAMING replies for the game turns; anything else (background
# extractors, utility calls, probes) gets an instant generic completion so no stray FE
# call-class can wedge the run. The FINAL scripted entry streams slowly (the pin's window).

class _StubState:
    def __init__(self):
        self.lock = threading.Lock()
        self.script: list[dict] = []  # {"text": str, "delay": float}
        self.requests: list[dict] = []  # B13: every parsed request the stub saw (for pins that read what the narrator was handed)

    def pop(self):
        with self.lock:
            return self.script.pop(0) if self.script else None


STUB = _StubState()


class _StubHandler(BaseHTTPRequestHandler):
    # HTTP/1.0 semantics: every response is close-delimited (no content-length juggling on
    # the SSE stream, no chunked framing) — the client reads to EOF. Slow but correct, and
    # this stub serves a handful of requests per test.
    protocol_version = "HTTP/1.0"

    def log_message(self, *a):  # quiet
        pass

    def do_GET(self):  # health / model list probes
        body = json.dumps({"object": "list", "data": [{"id": "stub-narrator"}]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            req = {}
        with STUB.lock:
            STUB.requests.append(req)
        stream = bool(req.get("stream"))
        entry = STUB.pop() if (stream and req.get("tools")) else None
        if not stream:
            body = json.dumps({
                "id": "stub", "object": "chat.completion", "model": "stub-narrator",
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": "ok"}}],
            }).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # streaming SSE
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()

        def emit(delta: dict, finish=None):
            chunk = {"id": "stub", "object": "chat.completion.chunk", "model": "stub-narrator",
                     "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()

        emit({"role": "assistant"})
        if entry is None:
            emit({"content": "Understood."})
        else:
            for piece in entry["deltas"]:
                emit({"content": piece})
                if entry["delay"]:
                    time.sleep(entry["delay"])
            if entry.get("drop"):  # A57b: the upstream connection silently DROPS - no finish_reason, no [DONE]
                self.wfile.flush()
                self.close_connection = True
                return
        emit({}, finish="stop")
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


# ── boot: engine + FE + stub, one seeded started game ─────────────────────────────────

def _wait_http(url: str, proc, what: str, budget=120):
    for _ in range(budget):
        if proc is not None and proc.poll() is not None:
            raise RuntimeError(f"{what} exited early")
        try:
            urllib.request.urlopen(url, timeout=2)
            return
        except Exception:
            time.sleep(1)
    raise RuntimeError(f"{what} never became ready")


def _post_json(base: str, path: str, body: dict, timeout=60) -> dict:
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def _post_form(base: str, path: str, form: dict, timeout=30) -> dict:
    data = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(base + path, data=data, method="POST",
                                 headers={"content-type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


import urllib.parse  # noqa: E402  (used by _post_form)


@pytest.fixture(scope="module")
def _stack():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright not installed")
    dist = os.path.join(REPO, "dist", "main.js")
    if not os.path.isfile(dist):
        pytest.skip("engine bundle missing — run `npm run build` at the repo root")

    # The canonical-binding store is SHARED frontend/data state (first-writer-wins): a
    # stale binding from ANY earlier boot wins the warm turn's bind, the resolve route
    # then unbinds it as dead (this boot's fresh DB has no such row), and the window
    # never subscribes to the live run — the golden driver scrubs this exact file for
    # this exact reason (#1085/#1086 class).
    for stale in ("orwell_game_session.json", "orwell_layout.json"):
        try:
            os.remove(os.path.join(FRONTEND, "data", stale))
        except FileNotFoundError:
            pass

    stub_port = _free_port()
    stub = ThreadingHTTPServer(("127.0.0.1", stub_port), _StubHandler)
    threading.Thread(target=stub.serve_forever, daemon=True).start()

    engine_port = _free_port()
    engine_env = dict(os.environ, ORWELL_DATA_DIR=tempfile.mkdtemp(prefix="orwell-m03-engine-"),
                      ORWELL_ENGINE_PORT=str(engine_port))
    engine = subprocess.Popen(["node", dist], cwd=REPO, env=engine_env,
                              stdout=open("/tmp/m03-engine.log", "w"), stderr=subprocess.STDOUT)
    ebase = f"http://127.0.0.1:{engine_port}"
    fe_port = _free_port()
    fe_env = dict(
        os.environ,
        ORWELL_GAME_BUILD="1", AUTH_ENABLED="false", LOCALHOST_BYPASS="true",
        ORWELL_ENGINE_MCP_URL=ebase,
        PLAYWRIGHT_BROWSERS_PATH=os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers"),
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-m03-fe-"), "app.db"),
        ORWELL_DATA_DIR_FE=tempfile.mkdtemp(prefix="orwell-m03-data-"),
    )
    fe = subprocess.Popen([sys.executable, "-m", "uvicorn", "app:app",
                           "--host", "127.0.0.1", "--port", str(fe_port)],
                          cwd=FRONTEND, env=fe_env,
                          stdout=open("/tmp/m03-fe.log", "w"), stderr=subprocess.STDOUT)
    fbase = f"http://127.0.0.1:{fe_port}"
    try:
        _wait_http(ebase + "/player/tools", engine, "engine", 60)
        _wait_http(fbase + "/openapi.json", fe, "front-end", 120)

        # Point the FE's model resolution at the stub (skip_probe: the stub is not a real
        # provider fleet; endpoint kind auto-detects OpenAI-compatible).
        # endpoint_kind is EXPLICIT: "auto" infers the kind from recognizable hosts
        # (openrouter.ai etc.) and resolves NOTHING for a loopback stub — the stream path
        # then builds an empty request URL and every narration round reads blank.
        ep = _post_form(fbase, "/api/model-endpoints", {
            "name": "m03-stub", "base_url": f"http://127.0.0.1:{stub_port}/v1",
            "api_key": "stub-key", "skip_probe": "true", "endpoint_kind": "openai",
        })
        import importlib
        sys.path.insert(0, FRONTEND)
        settings_mod = importlib.import_module("src.settings")
        sfile = os.path.join(FRONTEND, "data", "settings.json")
        cur = {}
        if os.path.exists(sfile):
            with open(sfile, encoding="utf-8") as fh:
                cur = json.load(fh)
        prior_settings = dict(cur)  # restored on teardown — the file is SHARED checkout state
        cur.update({"default_model": "stub-narrator", "default_endpoint_id": ep["id"]})
        tmp = sfile + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(cur, fh, indent=2)
        os.replace(tmp, sfile)
        # The settings file rides a ~2s TTL cache in the FE — a turn kicked inside the
        # window resolves the PRIOR (dead) endpoint and 503s "No model endpoint
        # configured" (the golden driver's configure-race lesson). Verify-poll until the
        # stub actually resolves before any turn runs.
        deadline = time.time() + 15
        resolved = {}
        while time.time() < deadline:
            try:
                resolved = json.loads(urllib.request.urlopen(
                    fbase + "/api/default-chat", timeout=5).read() or b"{}")
            except Exception:
                resolved = {}
            if resolved.get("model") == "stub-narrator":
                break
            time.sleep(1.0)
        if resolved.get("model") != "stub-narrator":
            raise RuntimeError(f"default-chat never resolved the stub model: {resolved}")

        # A seeded, STARTED game — engine-direct (the chat casting walk is the golden
        # driver's job, not this pin's; convergence only requires started !== false).
        r = _post_json(ebase, "/player/call",
                       {"name": "createCharacter", "args": {"playerName": "P", "seed": SEED}})
        if "result" not in r:
            raise RuntimeError(f"createCharacter failed: {r}")

        yield {"fe": fbase, "engine": ebase, "settings": sfile, "prior": prior_settings,
               "endpoint_id": ep["id"]}
    finally:
        # Restore the shared settings file — the stub endpoint/model must not leak into
        # later tests or dirty the checkout (the golden driver's shared-frontend/data lesson).
        try:
            tmp2 = sfile + ".tmp"
            with open(tmp2, "w", encoding="utf-8") as fh:
                json.dump(prior_settings, fh, indent=2)
            os.replace(tmp2, sfile)
        except Exception:
            pass
        for p in (fe, engine):
            p.terminate()
            try:
                p.wait(timeout=10)
            except Exception:
                p.kill()
        stub.shutdown()


def _kick_turn_async(fbase: str, text: str, session: str):
    """POST /api/chat_stream in a daemon thread (the 'third device' kicking the run) and
    drain its stream so the server never blocks on backpressure."""
    def run():
        body = json.dumps({"message": text, "session": session}).encode()
        req = urllib.request.Request(f"{fbase}/api/chat_stream", data=body, method="POST",
                                     headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                while r.read(65536):
                    pass
        except Exception as e:  # diagnosis must never be silent — the joiner asserts on it
            print(f"[m03] chat_stream kick failed: {type(e).__name__}: {e}", flush=True)
    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


_SAMPLE_JS = """
() => {
  const box = document.getElementById('chat-history');
  if (!box) return { ready: false };
  const ai = Array.from(box.querySelectorAll('.msg.msg-ai'))
    .filter(el => !(el.style && el.style.display === 'none'));
  return {
    ready: true,
    count: ai.length,
    bodies: ai.map(el => (el.textContent || '').trim()),
  };
}
"""


def test_second_window_joins_mid_generation_and_converges(_stack):
    from playwright.sync_api import sync_playwright

    fbase = _stack["fe"]

    # A REAL FE chat-session row — the mirror stream 404s a non-row id (#1085's lesson),
    # and /api/chat_stream refuses an unknown session outright. The session carries the
    # stub ENDPOINT too: the stream path resolves the session's own endpoint, and a
    # session without one 503s "No model endpoint configured" on every round.
    sess = _post_form(fbase, "/api/session", {
        "name": "m03-midgen", "model": "stub-narrator", "skip_validation": "true",
        "endpoint_id": _stack["endpoint_id"],
    }).get("id")
    assert sess, "could not create the FE chat session"

    # One warm scripted turn binds the canonical game session + proves the plumbing.
    STUB.script.append({"deltas": ["The house settles."], "delay": 0})
    warm = _kick_turn_async(fbase, "Take stock of the house.", sess)
    warm.join(timeout=120)
    # The canonical binding must resolve to a live row before the mirror can subscribe.
    # Poll: the bind can land a beat after the stream closes (post-turn bookkeeping).
    got = {}
    deadline = time.time() + 15
    while time.time() < deadline:
        got = json.loads(urllib.request.urlopen(
            fbase + "/api/orwell/game-session", timeout=10).read())
        if got.get("sessionId"):
            break
        time.sleep(0.5)
    assert got.get("sessionId"), f"no canonical game session bound after the warm turn: {got}"

    # Arm the SLOW turn and kick it from the 'third device'.
    STUB.script.append({"deltas": SLOW_DELTAS, "delay": SLOW_DELAY_S})
    slow = _kick_turn_async(fbase, "Walk the memory wall and take it all in.", sess)

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        ctx_a = browser.new_context()
        page_a = ctx_a.new_page()
        page_a.goto(fbase + "/", wait_until="load", timeout=30000)

        # Window A must attach to the LIVE stream: partial slow-turn text before settle.
        partial_a = ""
        timeline_a: list[tuple[float, int]] = []  # (t, len) of the slow bubble per poll
        t0 = time.time()
        deadline = time.time() + 30
        while time.time() < deadline:
            s = page_a.evaluate(_SAMPLE_JS)
            bodies = s.get("bodies") or []
            live = [b for b in bodies if "beat-00" in b]
            if live:
                timeline_a.append((round(time.time() - t0, 2), len(live[-1])))
                if not partial_a:
                    partial_a = live[-1]
                if "beat-79" in live[-1]:
                    break
            page_a.wait_for_timeout(250)
        print(f"[m03] window A bubble timeline (t, chars): {timeline_a[:20]}", flush=True)
        if not partial_a:
            diag = page_a.evaluate(
                "() => ({ sid: window.sessionModule && window.sessionModule.getCurrentSessionId"
                " && window.sessionModule.getCurrentSessionId(),"
                " html: (document.getElementById('chat-history') || {innerHTML: '<none>'})"
                ".innerHTML.slice(0, 600) })")
            raise AssertionError(
                f"window A never showed the in-flight narration (mirror attach failed) — {diag}")
        assert SLOW_TEXT not in partial_a, \
            "window A only saw the SETTLED text — the stream finished before the join; widen SLOW_DELTAS"

        # Mid-generation: open window B NOW (a separate context — a second device).
        ctx_b = browser.new_context()
        page_b = ctx_b.new_page()
        page_b.goto(fbase + "/", wait_until="load", timeout=30000)
        partial_b = ""
        deadline = time.time() + 20
        while time.time() < deadline:
            s = page_b.evaluate(_SAMPLE_JS)
            bodies = s.get("bodies") or []
            live = [b for b in bodies if "beat-00" in b]
            if live:
                partial_b = live[-1]
                break
            page_b.wait_for_timeout(250)
        assert partial_b, "window B never attached to the in-flight generation (the mid-gen join)"

        # Settle, then both windows must converge on the identical full narration —
        # exactly one bubble carrying it per window (no dup, no strip — #1086/#873 class).
        slow.join(timeout=120)

        def settled(page):
            deadline2 = time.time() + 30
            while time.time() < deadline2:
                s = page.evaluate(_SAMPLE_JS)
                bodies = [b for b in (s.get("bodies") or []) if "beat-79" in b]
                if bodies:
                    return s
                page.wait_for_timeout(400)
            return page.evaluate(_SAMPLE_JS)

        sa, sb = settled(page_a), settled(page_b)
        full_a = [b for b in sa["bodies"] if "beat-79" in b]
        full_b = [b for b in sb["bodies"] if "beat-79" in b]
        assert len(full_a) == 1, f"window A must hold exactly one settled slow-turn bubble: {sa}"
        assert len(full_b) == 1, f"window B must hold exactly one settled slow-turn bubble: {sb}"
        for i, piece in enumerate((f"beat-{j:02d}" for j in (0, 26, 52, 79))):
            assert piece in full_a[0] and piece in full_b[0], \
                f"settled narration truncated (missing {piece}) — A={full_a[0][:80]!r} B={full_b[0][:80]!r}"
        assert full_a[0] == full_b[0], (
            "F5 parity broken: the two windows settled on DIFFERENT transcripts —\n"
            f"A: {full_a[0][:120]!r}\nB: {full_b[0][:120]!r}")

        browser.close()
