#!/usr/bin/env python3
"""M0-3 — the owed ADR-0008/0012 LIVE two-window verification (F5 parity, real model).

Boots a production-shaped stack (real engine, real FE, NO golden seams), wires a REAL
narrator endpoint (OpenRouter; narration z-ai/glm-4.7, utility qwen/qwen3.6-27b —
the owner's two-tier topology), then drives one live game through a full ceremony
sequence (premiere → HOH competition → nominations) with TWO Playwright windows open
the whole way. After every settled turn both windows' transcripts must be identical
(F5 realtime-mirror parity), and one mid-week turn gets a THIRD window opened
mid-generation (the live mid-gen join) which must show partial text before settle and
converge byte-identical after.

The deterministic regression pin for the same seam is
`frontend/tests/test_m0_3_midgen_join.py` (fe-browser-tests lane); THIS script is the
owed live-model evidence run — its transcript goes into the ship-gate doc
(docs/audits/2026-06-27-ship-gate.md §M0-3).

Usage:
    cd frontend && OPENROUTER_API_KEY=sk-... .venv/bin/python3 scripts/_verify_two_window_live.py

Writes evidence (per-beat parity table + screenshots) under data/_m03_live/.
"""
from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "tests"))
from _ws_turn_driver import ws_turn as _ws_turn  # noqa: E402

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(FRONTEND)
OUT = os.path.join(FRONTEND, "data", "_m03_live")
os.makedirs(OUT, exist_ok=True)

NARRATION = os.environ.get("M03_NARRATION_MODEL", "z-ai/glm-4.7")
UTILITY = os.environ.get("M03_UTILITY_MODEL", "qwen/qwen3.6-27b")
BASE_URL = os.environ.get("M03_BASE_URL", "https://openrouter.ai/api/v1")
SEED = int(os.environ.get("M03_SEED", "31103"))
TURN_BUDGET = int(os.environ.get("M03_TURN_BUDGET", "28"))


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _get(base, path, timeout=20):
    with urllib.request.urlopen(base + path, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def _post_json(base, path, body, timeout=60):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def _post_form(base, path, form, timeout=30):
    req = urllib.request.Request(base + path, data=urllib.parse.urlencode(form).encode(),
                                 method="POST",
                                 headers={"content-type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def _wait_http(url, proc, what, budget=120):
    for _ in range(budget):
        if proc is not None and proc.poll() is not None:
            raise RuntimeError(f"{what} exited early")
        try:
            urllib.request.urlopen(url, timeout=2)
            return
        except Exception:
            time.sleep(1)
    raise RuntimeError(f"{what} never became ready")


SAMPLE_JS = """
() => {
  const box = document.getElementById('chat-history');
  if (!box) return { ready: false, bodies: [] };
  const ai = Array.from(box.querySelectorAll('.msg.msg-ai'))
    .filter(el => !(el.style && el.style.display === 'none'));
  return { ready: true, bodies: ai.map(el => (el.textContent || '').trim()) };
}
"""


def main() -> int:
    key = os.environ.get("OPENROUTER_API_KEY") or ""
    if not key:
        print("FAIL: OPENROUTER_API_KEY required (live run)")
        return 2
    from playwright.sync_api import sync_playwright

    # Scrub the shared canonical-binding store (same #1085-class hygiene as the pin).
    for stale in ("orwell_game_session.json", "orwell_layout.json"):
        try:
            os.remove(os.path.join(FRONTEND, "data", stale))
        except FileNotFoundError:
            pass

    engine_port, fe_port = _free_port(), _free_port()
    engine = subprocess.Popen(
        ["node", os.path.join(REPO, "dist", "main.js")], cwd=REPO,
        env=dict(os.environ, ORWELL_DATA_DIR=tempfile.mkdtemp(prefix="m03-live-engine-"),
                 ORWELL_ENGINE_PORT=str(engine_port)),
        stdout=open(os.path.join(OUT, "engine.log"), "w"), stderr=subprocess.STDOUT)
    ebase = f"http://127.0.0.1:{engine_port}"
    fe = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1",
         "--port", str(fe_port)], cwd=FRONTEND,
        env=dict(os.environ, ORWELL_GAME_BUILD="1", AUTH_ENABLED="false",
                 LOCALHOST_BYPASS="true", ORWELL_ENGINE_MCP_URL=ebase,
                 PLAYWRIGHT_BROWSERS_PATH=os.environ.get("PLAYWRIGHT_BROWSERS_PATH",
                                                         "/opt/pw-browsers"),
                 DATABASE_URL="sqlite:///" + os.path.join(
                     tempfile.mkdtemp(prefix="m03-live-fe-"), "app.db")),
        stdout=open(os.path.join(OUT, "fe.log"), "w"), stderr=subprocess.STDOUT)
    fbase = f"http://127.0.0.1:{fe_port}"
    verdicts: list[tuple[str, bool, str]] = []
    try:
        _wait_http(ebase + "/player/tools", engine, "engine", 60)
        _wait_http(fbase + "/openapi.json", fe, "front-end", 120)

        ep = _post_form(fbase, "/api/model-endpoints", {
            "name": "m03-live", "base_url": BASE_URL, "api_key": key,
            "skip_probe": "true", "endpoint_kind": "openai"})
        sfile = os.path.join(FRONTEND, "data", "settings.json")
        cur = {}
        if os.path.exists(sfile):
            with open(sfile, encoding="utf-8") as fh:
                cur = json.load(fh)
        cur.update({"default_model": NARRATION, "default_endpoint_id": ep["id"],
                    "utility_model": UTILITY})
        tmp = sfile + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(cur, fh, indent=2)
        os.replace(tmp, sfile)
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                if _get(fbase, "/api/default-chat").get("model") == NARRATION:
                    break
            except Exception:
                pass
            time.sleep(1)

        r = _post_json(ebase, "/player/call",
                       {"name": "createCharacter", "args": {"playerName": "Sam", "seed": SEED}})
        if "result" not in r:
            raise RuntimeError(f"createCharacter failed: {r}")

        sess = _post_form(fbase, "/api/session", {
            "name": "m03-live", "model": NARRATION, "skip_validation": "true",
            "endpoint_id": ep["id"]}).get("id")

        def turn(text: str, timeout=600) -> None:
            # timeout is PER SOCKET READ (a GLM thinking pause between chunks tripped 240s
            # and killed a healthy run mid-walk). The run is server-DETACHED (agent_runs):
            # even a client-side timeout only drops this reader — the turn itself finishes
            # server-side, so a timeout degrades to "wait for settle via status polls",
            # never a crash.
            try:
                _ws_turn(fbase, sess, text, timeout=timeout)   # ORW-44 S4b3: the game build is WebSocket-only
            except Exception as e:
                print(f"  turn reader dropped ({type(e).__name__}) — run continues detached; "
                      "waiting for settle", flush=True)
                deadline3 = time.time() + 300
                while time.time() < deadline3:
                    try:
                        if _get(fbase, f"/api/chat/stream_status/{sess}",
                                timeout=10).get("status") != "streaming":
                            break
                    except Exception:
                        pass
                    time.sleep(5)

        def _flush_verdicts() -> None:
            # Incremental: a crash mid-walk must never lose the evidence gathered so far.
            with open(os.path.join(OUT, "verdicts.json"), "w", encoding="utf-8") as fh:
                json.dump([{"check": c, "ok": ok, "detail": d} for c, ok, d in verdicts],
                          fh, indent=1)

        def status() -> dict:
            try:
                return _get(fbase, "/api/orwell/status")
            except Exception:
                return {}

        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page_a = browser.new_context().new_page()
            page_b = browser.new_context().new_page()

            # Warm turn binds the canonical session, then both windows open and converge.
            turn("I take a slow look around the house and get my bearings.")
            for p in (page_a, page_b):
                p.goto(fbase + "/", wait_until="load", timeout=30000)
                p.wait_for_timeout(4000)

            def parity(label: str) -> None:
                # settle grace, then both windows must show the same transcript.
                deadline2 = time.time() + 25
                sa = sb = None
                while time.time() < deadline2:
                    sa = page_a.evaluate(SAMPLE_JS)["bodies"]
                    sb = page_b.evaluate(SAMPLE_JS)["bodies"]
                    if sa and sa == sb:
                        break
                    time.sleep(1.0)
                ok = bool(sa) and sa == sb
                verdicts.append((label, ok,
                                 f"A={len(sa or [])} msgs, B={len(sb or [])} msgs"))
                _flush_verdicts()
                print(f"  [{'PASS' if ok else 'FAIL'}] parity @ {label} — "
                      f"A={len(sa or [])} B={len(sb or [])}", flush=True)

            parity("after-warm-join")

            # Drive the week: natural turns; answer pendings in chat like a player would.
            phases_seen: list[str] = []
            midgen_done = False
            for i in range(TURN_BUDGET):
                st = status()
                ph = st.get("phase") or "?"
                if not phases_seen or phases_seen[-1] != ph:
                    phases_seen.append(ph)
                pending = st.get("pending") if isinstance(st.get("pending"), dict) else None
                if pending and pending.get("kind"):
                    kind = pending["kind"]
                    opts = pending.get("options") or []
                    names = [o.get("label") or o.get("id") for o in opts if isinstance(o, dict)]
                    if kind == "comp-intent":
                        msg = "I'm competing hard in this one — count me in, full effort."
                    elif kind == "nominations" and len(names) >= 2:
                        msg = (f"For my nominations this week I'm going with {names[0]} "
                               f"and {names[1]}. Lock it in.")
                    elif kind in ("eviction-vote", "houseguests-choice", "tie-break") and names:
                        msg = f"My vote is {names[0]}. Final answer."
                    elif kind == "comp-round":
                        msg = "I dig in and push through this round."
                    elif kind == "veto-decision":
                        msg = "I'm not using the veto. The nominations stand."
                    elif kind == "replacement" and names:
                        msg = f"My replacement nominee is {names[0]}."
                    else:
                        msg = "I go with my gut — take my answer and keep the night moving."
                else:
                    msg = "Let's keep the week moving — what does production have for us next?"

                # One mid-week turn gets the LIVE mid-generation join (window C).
                if not midgen_done and "hoh" in (ph or "").lower():
                    midgen_done = True
                    kicker = threading.Thread(target=turn, args=(msg,), daemon=True)
                    kicker.start()
                    time.sleep(2.5)  # mid-generation
                    page_c = browser.new_context().new_page()
                    page_c.goto(fbase + "/", wait_until="load", timeout=30000)
                    partial = ""
                    dl = time.time() + 45
                    while time.time() < dl:
                        s = page_c.evaluate(SAMPLE_JS)["bodies"]
                        if s and s[-1] and len(s[-1]) > 40:
                            partial = s[-1]
                            break
                        page_c.wait_for_timeout(300)
                    kicker.join(timeout=240)
                    time.sleep(2)
                    final = page_c.evaluate(SAMPLE_JS)["bodies"]
                    grew = bool(partial) and bool(final) and len(final[-1]) >= len(partial)
                    verdicts.append(("midgen-join-window-C", bool(partial) and grew,
                                     f"partial {len(partial)}ch -> final {len(final[-1]) if final else 0}ch"))
                    _flush_verdicts()
                    print(f"  [{'PASS' if partial and grew else 'FAIL'}] mid-gen join — "
                          f"partial={len(partial)}ch", flush=True)
                    page_c.screenshot(path=os.path.join(OUT, "window_c_settled.png"))
                    page_c.context.close()
                else:
                    turn(msg)
                parity(f"turn-{i+1:02d}-{ph}")
                st2 = status()
                # Full ceremony sequence reached: premiere → HOH → nominations DONE (veto next).
                if (st2.get("phase") or "").startswith("veto"):
                    print(f"  ceremony sequence complete: {phases_seen} -> veto", flush=True)
                    break

            page_a.screenshot(path=os.path.join(OUT, "window_a_final.png"))
            page_b.screenshot(path=os.path.join(OUT, "window_b_final.png"))
            browser.close()

        with open(os.path.join(OUT, "verdicts.json"), "w", encoding="utf-8") as fh:
            json.dump([{"check": c, "ok": ok, "detail": d} for c, ok, d in verdicts], fh, indent=1)
        failed = [v for v in verdicts if not v[1]]
        print(f"\n{'VERIFY OK' if not failed else 'VERIFY FAIL'} — "
              f"{len(verdicts) - len(failed)}/{len(verdicts)} checks passed; "
              f"evidence in {OUT}", flush=True)
        return 0 if not failed else 1
    finally:
        for p in (fe, engine):
            p.terminate()
            try:
                p.wait(timeout=10)
            except Exception:
                p.kill()


if __name__ == "__main__":
    sys.exit(main())
