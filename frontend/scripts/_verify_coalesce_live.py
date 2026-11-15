#!/usr/bin/env python3
"""#829 — turn-coalescing (ONE growing bubble per turn) LIVE verification driver.

The owed live-only acceptance for the #829 redo. #822 coalesced a turn's multiple
AGENT-LOOP ROUNDS into ONE growing message bubble (no per-round bubble mount / hide /
jump), but broke live streaming (first message hung/disappeared) and was reverted
(#825). The redo must be proven against a REAL model — not just the stubbed
browser_smoke, the exact gap that let #822 ship broken (issue #829). This driver is the
standing live evidence run: the leg-(3) auto-arm target of
`.github/workflows/live-harness-nightly.yml`.

WHAT IT ASSERTS (the #829 render invariant).
  A single player turn whose agent loop runs 2+ rounds (a tool-call round + a
  continuation round) renders as ONE growing message bubble across those rounds —
  NOT N separate bubbles that mount / hide / jump:
    • drive a genuine MULTI-ROUND turn through the real composer, confirm the loop
      actually ran multiple rounds (≥1 tool execution appears);
    • exactly ONE assistant bubble is created for the whole turn, and it GROWS across
      the rounds (its text accumulates) — observed live via a DOM MutationObserver;
    • NO per-round bubble teardown/re-mount during the stream (no msg-ai node removed
      then re-added, no hidden per-round holders left behind — the churn the reverted
      #822 and today's per-round path exhibit, incl. the WS `done`-branch discard +
      N-bubble reconstruction);
    • the preserved invariants hold where cheaply observable live: the reply / reasoning
      CHANNEL SPLIT stays intact (reasoning lives in the `.thinking-section` accordion
      and never leaks into the public reply body), and a SINGLE-round turn still renders
      as exactly ONE clean bubble (the byte-identity spirit — no regression).
  Driven through the REAL composer (a genuine, non-headless user Send) against a real
  OpenRouter model wired into the FE — the only path that reproduces the live-streaming
  class of failure (#825) the stubbed gates can't see.

THE SELF-SKIP CONTRACT (why this can land BEFORE the feature).
  The #829 coalescing change lives in the fenced `frontend/static/js/chat.js` and is
  owned by another overseer; it is NOT shipped yet. Landing this driver early must NOT
  fire the live path prematurely or spam a nightly warning. So BEFORE any live model
  call the driver probes the SERVED chat.js for the #829 feature sentinel and, when it
  is ABSENT (the pre-feature state), self-SKIPS: it makes ZERO live calls, writes a skip
  verdict, prints the SKIP line, and exits 0. Only once the feature (its sentinel) is
  present does the live path run and assert coalescing.

  The presence sentinel is the codebase's ironclad issue-tag convention: the #829 redo
  will carry the literal `#829` tag in chat.js (every other messaging-resilience change
  does — `#985`, `#830`, `#891`, `#993`, `#992`). `#829` is absent from the served
  chat.js today, which is exactly the "feature absent → self-skip" signal. A few explicit
  alternates (`coalesceRounds` / `oneBubblePerTurn` / "growing bubble"), all likewise
  absent today, are accepted so the leg still arms if the implementer tags it another way.
  Any read failure is treated as ABSENT (fail-safe: never a false "present").

USAGE (the other overseer, keyed):
    cd frontend && OPENROUTER_API_KEY=sk-... python3 scripts/_verify_coalesce_live.py

Writes evidence (verdict.json + screenshots) under frontend/data/_coalesce_live/.
Roles only — the player name is a generic label; the cast is engine-seeded.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "tests"))
from _ws_turn_driver import ws_turn as _ws_turn  # noqa: E402
import sys
import tempfile
import time
import urllib.parse
import urllib.request

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(FRONTEND)
OUT = os.path.join(FRONTEND, "data", "_coalesce_live")
os.makedirs(OUT, exist_ok=True)

NARRATION = os.environ.get("COALESCE_NARRATION_MODEL", "z-ai/glm-4.7")
UTILITY = os.environ.get("COALESCE_UTILITY_MODEL", "qwen/qwen3.6-27b")
BASE_URL = os.environ.get("COALESCE_BASE_URL", "https://openrouter.ai/api/v1")
SEED = int(os.environ.get("COALESCE_SEED", "82982"))

# ── feature-presence probe (the self-skip gate) ─────────────────────────────────────────
# The SERVED player-tier chat.js IS the on-disk static file (FastAPI serves static/js/*.js
# verbatim — no JS build step), so a source read of it is exactly "the served chat.js" and
# is boot-free + deterministic + un-hangable — the right shape for the critical keyless skip.
CHAT_JS = os.path.join(FRONTEND, "static", "js", "chat.js")
# All confirmed ABSENT from the served chat.js on main today (the pre-feature state).
_FEATURE_SENTINELS = ("#829", "coalescerounds", "onebubbleperturn", "growing bubble")

# A substantive, tool-triggering directive → the agent loop should run a tool round
# (advanceGame / recordInteraction — reliably fired by the game's under-call belts on an
# engaged, game-moving turn) plus a narration continuation round: a genuine MULTI-round turn.
MULTI_ROUND_MSG = ("I make my move for the week: I pull my closest ally aside, lock in our "
                   "final-two, and push hard to get the house moving toward the next "
                   "competition. Let's advance the game.")
# A quiet OOC beat unlikely to call any engine tool → a SINGLE-round turn (still one bubble).
SINGLE_ROUND_MSG = "Just taking a slow, quiet breath and soaking in the room for a moment — no rush."


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


def _coalescing_feature_present() -> tuple[bool, str]:
    """Probe the served chat.js for the #829 feature sentinel. Fail-safe: any read error
    ⇒ ABSENT (never a false 'present', so the key is never spent pre-feature)."""
    try:
        with open(CHAT_JS, encoding="utf-8") as fh:
            low = fh.read().lower()
    except Exception as e:  # unreadable served file ⇒ treat as absent (skip)
        return (False, f"could not read served chat.js ({type(e).__name__}) — treated as ABSENT")
    hits = [s for s in _FEATURE_SENTINELS if s in low]
    if hits:
        return (True, f"#829 coalescing sentinel present in served chat.js: {hits}")
    return (False, "no #829 round-coalescing sentinel in served chat.js (pre-feature state)")


def _write_verdict(payload: dict) -> None:
    with open(os.path.join(OUT, "verdict.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1)


# Install a MutationObserver on #chat-history that records assistant-bubble MOUNTS and
# TEARDOWNS (direct-child add/remove of `.msg-ai` nodes) for the turn about to be sent — this
# is how "one growing bubble" vs "N per-round bubbles that mount/hide/jump" is observed live.
# Must be installed BEFORE the send so the turn's first bubble mount is captured.
_OBS_INSTALL_JS = """
() => {
  const box = document.getElementById('chat-history');
  if (!box) return false;
  const isAi = (n) => n && n.nodeType === 1 && n.classList && n.classList.contains('msg-ai');
  const st = { addedAi: 0, removedAi: 0, events: [] };
  window.__coalObs = st;
  if (window.__coalMo) { try { window.__coalMo.disconnect(); } catch (e) {} }
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type !== 'childList') continue;
      m.addedNodes.forEach((n) => { if (isAi(n)) { st.addedAi++; st.events.push('add'); } });
      m.removedNodes.forEach((n) => { if (isAi(n)) { st.removedAi++; st.events.push('remove'); } });
    }
  });
  mo.observe(box, { childList: true });  // direct children only — bubbles mount at box top level
  window.__coalMo = mo;
  return true;
}
"""

_OBS_READ_JS = "() => window.__coalObs || { addedAi: 0, removedAi: 0, events: [] }"

# Rich per-turn DOM snapshot: visible/hidden assistant-bubble counts, tool-round evidence
# (`.agent-thread-node`), the last bubble's length (growth sampling), and its reply/reasoning
# split (reply = body MINUS the `.thinking-section` accordion; reasoning = the accordion).
_SNAPSHOT_JS = """
() => {
  const box = document.getElementById('chat-history');
  if (!box) return { ready: false };
  const vis = (el) => !(el.style && el.style.display === 'none');
  const aiAll = Array.from(box.querySelectorAll('.msg.msg-ai'));
  const aiVisible = aiAll.filter(vis);
  const threadNodes = box.querySelectorAll('.agent-thread-node').length;
  const last = aiVisible[aiVisible.length - 1] || null;
  let replyText = '', reasoningText = '', lastLen = 0;
  if (last) {
    lastLen = (last.textContent || '').trim().length;
    const think = last.querySelector('.thinking-section');
    reasoningText = think ? (think.textContent || '').trim() : '';
    const body = last.querySelector('.body') || last;
    const clone = body.cloneNode(true);
    clone.querySelectorAll('.thinking-section').forEach((n) => n.remove());
    replyText = (clone.textContent || '').trim();
  }
  return {
    ready: true,
    aiVisible: aiVisible.length,
    aiHidden: aiAll.length - aiVisible.length,
    threadNodes,
    lastLen,
    replyText,
    reasoningText,
  };
}
"""

# Genuine, NON-headless user send: set the composer value + dispatch a real Enter keydown,
# which routes through the app's messageInput keydown handler → handleSubmit → handleChatSubmit
# with overrideMsg=null (_headless=false, reads el('message').value). This drives a real player
# turn through the live agent loop — a programmatic handleChatSubmit(null, text) would set
# _headless=true and take a different path.
_SEND_JS = """
(txt) => {
  const ta = document.getElementById('message');
  if (!ta) return false;
  ta.value = txt;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  ta.dispatchEvent(new KeyboardEvent('keydown',
    { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  return true;
}
"""

_IS_STREAMING_JS = "() => !!(window.chatModule && window.chatModule._isStreaming && window.chatModule._isStreaming())"


def main() -> int:
    # ── STEP 1 (before ANYTHING live): feature-absence self-skip ──────────────────────────
    present, why = _coalescing_feature_present()
    if not present:
        _write_verdict({"skipped": True, "reason": why, "feature_present": False, "checks": []})
        print(f"SKIP: #829 coalescing feature not present — driver self-skipped (no live calls) — {why}",
              flush=True)
        return 0

    # ── STEP 2: key gate (only AFTER we know the feature is here) ──────────────────────────
    key = os.environ.get("OPENROUTER_API_KEY") or ""
    if not key:
        _write_verdict({"skipped": False, "reason": "OPENROUTER_API_KEY required (live run)",
                        "feature_present": True, "checks": []})
        print("FAIL: OPENROUTER_API_KEY required (live run)", flush=True)
        return 2

    print(f"ARMED: {why} — running the live coalescing verify.", flush=True)
    from playwright.sync_api import sync_playwright

    # Scrub the shared canonical-binding store (#1085/#1086 hygiene — a stale binding wins the
    # warm turn's bind, the resolve route unbinds it as dead, and the window never subscribes).
    for stale in ("orwell_game_session.json", "orwell_layout.json"):
        try:
            os.remove(os.path.join(FRONTEND, "data", stale))
        except FileNotFoundError:
            pass

    engine_port, fe_port = _free_port(), _free_port()
    engine = subprocess.Popen(
        ["node", os.path.join(REPO, "dist", "main.js")], cwd=REPO,
        env=dict(os.environ, ORWELL_DATA_DIR=tempfile.mkdtemp(prefix="coalesce-live-engine-"),
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
                     tempfile.mkdtemp(prefix="coalesce-live-fe-"), "app.db")),
        stdout=open(os.path.join(OUT, "fe.log"), "w"), stderr=subprocess.STDOUT)
    fbase = f"http://127.0.0.1:{fe_port}"

    verdicts: list[tuple[str, bool, str]] = []

    def _flush() -> None:
        _write_verdict({"skipped": False, "feature_present": True, "reason": why,
                        "checks": [{"check": c, "ok": ok, "detail": d} for c, ok, d in verdicts]})

    def _check(label: str, ok: bool, detail: str) -> None:
        verdicts.append((label, bool(ok), detail))
        _flush()
        print(f"  [{'PASS' if ok else 'FAIL'}] {label} — {detail}", flush=True)

    try:
        _wait_http(ebase + "/player/tools", engine, "engine", 60)
        _wait_http(fbase + "/openapi.json", fe, "front-end", 120)

        # Wire the real OpenRouter endpoint + default models (mirrors the two-window sibling).
        ep = _post_form(fbase, "/api/model-endpoints", {
            "name": "coalesce-live", "base_url": BASE_URL, "api_key": key,
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

        # A seeded, STARTED game (engine-direct) so composer sends are game turns, not casting.
        r = _post_json(ebase, "/player/call",
                       {"name": "createCharacter", "args": {"playerName": "Sam", "seed": SEED}})
        if "result" not in r:
            raise RuntimeError(f"createCharacter failed: {r}")

        # A real FE chat-session row carrying the endpoint (the stream path resolves the
        # session's own endpoint; a session without one 503s every round).
        sess = _post_form(fbase, "/api/session", {
            "name": "coalesce-live", "model": NARRATION, "skip_validation": "true",
            "endpoint_id": ep["id"]}).get("id")
        if not sess:
            raise RuntimeError("could not create the FE chat session")

        # One warm turn over REST binds the canonical session + proves the model resolves,
        # so the multi-round turn below fails on the coalescing render, not on plumbing.
        def _rest_turn(text: str, timeout=600) -> None:
            try:
                _ws_turn(fbase, sess, text, timeout=timeout)   # ORW-44 S4b3: the game build is WebSocket-only
            except Exception as e:
                # Server-detached run: a client read-drop degrades to "poll for settle".
                print(f"  warm-turn reader dropped ({type(e).__name__}) — waiting for settle",
                      flush=True)
                dl = time.time() + 300
                while time.time() < dl:
                    try:
                        if _get(fbase, f"/api/chat/stream_status/{sess}",
                                timeout=10).get("status") != "streaming":
                            break
                    except Exception:
                        pass
                    time.sleep(5)

        _rest_turn("I take a slow breath and get my bearings in the house.")

        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as e:
                _check("browser-launch", False, f"chromium unavailable: {e}")
                return _finish(verdicts)
            page = browser.new_context().new_page()
            page.goto(fbase + "/", wait_until="load", timeout=30000)
            page.wait_for_timeout(3000)

            # Land the window on the started game's session (deterministic — don't rely on
            # whichever session the boot happened to select).
            try:
                page.evaluate("(sid) => window.sessionModule && window.sessionModule.selectSession(sid)", sess)
            except Exception:
                pass
            dl = time.time() + 20
            on_sess = False
            while time.time() < dl:
                try:
                    cur_sid = page.evaluate(
                        "() => window.sessionModule && window.sessionModule.getCurrentSessionId "
                        "&& window.sessionModule.getCurrentSessionId()")
                except Exception:
                    cur_sid = None
                if cur_sid == sess:
                    on_sess = True
                    break
                page.wait_for_timeout(500)
            _check("window-on-started-session", on_sess,
                   f"current session id == started game session ({'yes' if on_sess else 'no'})")
            page.wait_for_timeout(1500)
            page.screenshot(path=os.path.join(OUT, "01_before_send.png"))

            # ── The MULTI-ROUND turn: the #829 "one growing bubble per turn" invariant ────
            mr = _drive_turn(page, MULTI_ROUND_MSG)
            with open(os.path.join(OUT, "multi_round_obs.json"), "w", encoding="utf-8") as fh:
                json.dump(mr, fh, indent=1)
            page.screenshot(path=os.path.join(OUT, "02_multi_round_settled.png"))

            _check("multi-round-turn-dispatched", mr["sent"] and mr["began"],
                   f"composer send dispatched and the live stream began (sent={mr['sent']}, began={mr['began']})")

            # The turn actually ran the agent loop across 2+ rounds (≥1 tool execution), else
            # the "one bubble ACROSS rounds" invariant would be untested (vacuously true).
            _check("multi-round-confirmed", mr["rounds_toolnodes"] >= 1,
                   f"tool-execution rounds observed this turn = {mr['rounds_toolnodes']} "
                   "(agent-thread nodes; ≥1 ⇒ the agent loop ran multiple rounds)")

            # THE #829 INVARIANT: exactly ONE assistant bubble is created for the whole
            # multi-round turn (it grows) — NOT N separate per-round bubbles.
            _check("one-growing-bubble", mr["added_ai"] == 1 and mr["net_ai"] == 1,
                   f"assistant bubbles mounted this turn = {mr['added_ai']}, net-new visible = "
                   f"{mr['net_ai']} (expect exactly 1 that grows)")

            # NO per-round teardown/re-mount churn: nothing removed (the WS `done`-branch
            # discard + N-bubble reconstruction the redo must eliminate), no hidden per-round
            # holders left behind, no bubble removed-then-re-added.
            _check("no-per-round-teardown", mr["removed_ai"] == 0 and mr["new_hidden"] == 0,
                   f"assistant bubbles removed this turn = {mr['removed_ai']}, new hidden = "
                   f"{mr['new_hidden']}; mount/remove event log = {mr['events']}")

            # The single bubble GREW across the rounds (accumulation — proof the rounds folded
            # into one bubble, not a single static settle paint).
            _check("bubble-grew-across-rounds", mr["grew"],
                   f"last-bubble length samples = {mr['len_samples'][:14]} "
                   "(final grew past its first paint)")

            # Reply / reasoning CHANNEL SPLIT preserved: reasoning lives in `.thinking-section`
            # and never leaks into the public reply body (a #829 must-preserve invariant).
            leak = bool(mr["final_reasoning"]) and (mr["final_reasoning"] in mr["final_reply"])
            _check("reply-reasoning-channel-split", bool(mr["final_reply"]) and not leak,
                   f"reply len={len(mr['final_reply'])}, reasoning len={len(mr['final_reasoning'])}, "
                   f"reasoning-leaked-into-public-body={leak}")

            # ── The SINGLE-ROUND turn: byte-identity spirit — still ONE clean bubble ──────
            sr = _drive_turn(page, SINGLE_ROUND_MSG)
            with open(os.path.join(OUT, "single_round_obs.json"), "w", encoding="utf-8") as fh:
                json.dump(sr, fh, indent=1)
            page.screenshot(path=os.path.join(OUT, "03_single_round_settled.png"))
            _check("single-round-one-bubble",
                   sr["added_ai"] == 1 and sr["net_ai"] == 1 and sr["removed_ai"] == 0,
                   f"single-round turn: mounted={sr['added_ai']}, net-new={sr['net_ai']}, "
                   f"removed={sr['removed_ai']}, tool-rounds={sr['rounds_toolnodes']} "
                   "(expect one clean bubble, no churn)")

            browser.close()

        return _finish(verdicts)
    except Exception as e:  # any unexpected failure is a real FAIL with evidence, never a hang
        _check("driver-exception", False, f"{type(e).__name__}: {e}")
        return _finish(verdicts)
    finally:
        for p in (fe, engine):
            try:
                p.terminate()
                p.wait(timeout=10)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass


def _drive_turn(page, text: str, begin_budget: int = 90, settle_budget: int = 300) -> dict:
    """Install the assistant-bubble MutationObserver, send `text` through the REAL composer,
    sample the growing bubble across the whole stream, and wait for a stable idle. Returns the
    per-turn observations the #829 assertions read. Never hangs — every wait is budgeted."""
    pre = page.evaluate(_SNAPSHOT_JS)
    ready = bool(pre.get("ready"))
    pre_ai = int(pre.get("aiVisible", 0)) if ready else 0
    pre_hidden = int(pre.get("aiHidden", 0)) if ready else 0
    pre_threads = int(pre.get("threadNodes", 0)) if ready else 0

    page.evaluate(_OBS_INSTALL_JS)
    sent = bool(page.evaluate(_SEND_JS, text))

    # Wait for the live stream to begin (the turn's bubble mounts + isStreaming flips true).
    began = False
    dl = time.time() + begin_budget
    while time.time() < dl:
        try:
            if bool(page.evaluate(_IS_STREAMING_JS)):
                began = True
                break
        except Exception:
            pass
        page.wait_for_timeout(300)

    # Sample the last visible assistant bubble's length across the stream (growth evidence),
    # tracking the peak tool-round count, until a stable idle (isStreaming false for ~4s).
    lens: list[int] = []
    max_threads = pre_threads
    stable_since = None
    dl = time.time() + settle_budget
    while time.time() < dl:
        try:
            streaming = bool(page.evaluate(_IS_STREAMING_JS))
        except Exception:
            streaming = True
        snap = page.evaluate(_SNAPSHOT_JS)
        if snap.get("ready"):
            lens.append(int(snap.get("lastLen", 0)))
            max_threads = max(max_threads, int(snap.get("threadNodes", 0)))
        if (not streaming) and began:
            if stable_since is None:
                stable_since = time.time()
            elif time.time() - stable_since >= 4.0:
                break
        else:
            stable_since = None
        page.wait_for_timeout(600)

    obs = page.evaluate(_OBS_READ_JS)
    final = page.evaluate(_SNAPSHOT_JS)
    fready = bool(final.get("ready"))
    post_ai = int(final.get("aiVisible", 0)) if fready else 0
    post_hidden = int(final.get("aiHidden", 0)) if fready else 0

    positive = [n for n in lens if n > 0]
    if not positive:
        grew = False
    elif len(positive) >= 2:
        grew = max(positive) > positive[0] and max(positive) > 40
    else:
        grew = positive[-1] > 40

    return {
        "sent": sent, "began": began,
        "pre_ai": pre_ai, "post_ai": post_ai, "net_ai": post_ai - pre_ai,
        "new_hidden": max(0, post_hidden - pre_hidden),
        "added_ai": int(obs.get("addedAi", 0)), "removed_ai": int(obs.get("removedAi", 0)),
        "events": obs.get("events", []),
        "rounds_toolnodes": max(0, max_threads - pre_threads),
        "len_samples": lens,
        "grew": grew,
        "final_reply": final.get("replyText", "") if fready else "",
        "final_reasoning": final.get("reasoningText", "") if fready else "",
    }


def _finish(verdicts) -> int:
    _write_verdict({"skipped": False, "feature_present": True,
                    "checks": [{"check": c, "ok": ok, "detail": d} for c, ok, d in verdicts]})
    failed = [v for v in verdicts if not v[1]]
    ok = bool(verdicts) and not failed
    print(f"\n{'VERIFY OK' if ok else 'VERIFY FAIL'} — "
          f"{len(verdicts) - len(failed)}/{len(verdicts)} checks passed; evidence in {OUT}",
          flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
