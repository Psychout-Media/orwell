#!/usr/bin/env python3
"""#766 — the owed LIVE-model validation of the 0080 ACTIVE runtime overseer.

The `active` overseer dispatch path is **live-only by design** (feature 0080 ruling D4): the
seeded / stubbed test lanes never resolve a real model, so the `DeterministicOverseer` stub is
wired and the inline heuristic guardrails stay the actor — no automated gate ever exercises the
reasoning tier *acting on its own verdict*. #766 is exactly that gap. This driver is the standing
evidence run: it boots a production-shaped stack, wires a REAL utility model (so
`overseer.LlmOverseer` resolves through `_resolve_llm_fn`), forces `overseer_mode=active`, drives a
real-model game walk long enough to trip the sparse 0079 symptom gate, and asserts the active
overseer FIRED, DISPATCHED a lever with its intended effect, LOGGED it truthfully, leaked no Vault,
and DEGRADES SOFT under a real model.

It is the driver the `live-harness-nightly.yml` **overseer-live** leg auto-runs (it runs the script
iff present and uploads `frontend/data/_overseer_live/` as evidence). Full validation needs the
`OPENROUTER_API_KEY` repo secret; without a key the script prints the FAIL line and exits 1.

Fork lineage: this reuses the boot / model-wiring / teardown scaffolding of
`scripts/_verify_two_window_live.py` verbatim; only what it drives and asserts differs. It drives
via HTTP turns (no Playwright needed — the evidence is the Vault-free OVERSEER ring + the divergence
ledger, read over the admin log API, not the DOM).

Roles only in output — no houseguest / player names (CLAUDE.md testing rule): the player is created
as "Player", pending options are answered generically without echoing the option labels, and the
printed / persisted evidence refers to nominees as roles.

Usage:
    cd frontend && OPENROUTER_API_KEY=sk-... .venv/bin/python3 scripts/_verify_overseer_active_live.py

Writes evidence (per-assessment table, the OVERSEER-ring + divergence-ledger dump, a PASS/FAIL
summary) under data/_overseer_live/. Exit 0 on all-pass, 1 otherwise.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "tests"))
from _ws_turn_driver import ws_turn as _ws_turn  # noqa: E402

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(FRONTEND)
OUT = os.path.join(FRONTEND, "data", "_overseer_live")
os.makedirs(OUT, exist_ok=True)

# The two-tier topology (mirrors _verify_two_window_live.py): narration + a UTILITY model. The
# active overseer's LlmOverseer resolves the UTILITY model via _resolve_llm_fn, so utility_model +
# utility_endpoint_id MUST point at a real text/chat endpoint or the active path silently no-ops to
# the deterministic floor (§5 of 0080). We wire both to the same OpenRouter endpoint.
NARRATION = os.environ.get("OV_NARRATION_MODEL", "z-ai/glm-4.7")
UTILITY = os.environ.get("OV_UTILITY_MODEL", "qwen/qwen3.6-27b")
BASE_URL = os.environ.get("OV_BASE_URL", "https://openrouter.ai/api/v1")
SEED = int(os.environ.get("OV_SEED", "76676"))
TURN_BUDGET = int(os.environ.get("OV_TURN_BUDGET", "34"))
# A real hang ceiling (per symptomatic turn). The inline overseer model call is bounded to ~12s
# (agent_loop.py) then drops to the deterministic floor; a turn far beyond this is a latency
# regression, not the overseer working.
LATENCY_HANG_S = float(os.environ.get("OV_LATENCY_HANG_S", "200"))

# The actionable levers (a dispatched correction, distinct from the no-op 'hold').
ACTION_LEVERS = ("nudge", "force-advance", "propose-record", "reinject-delta")

# Vault-leak denylist: markers that would mean a hidden-layer scalar or a secret body leaked into
# something the overseer surfaced. The overseer is Vault-free BY CONSTRUCTION (it only ever reads
# the Signals scalars), so these must NEVER appear in any surfaced string.
_VAULT_MARKERS = (
    "trust=", "affinity=", "threat=", "suspicion=", "loyalty=",
    "vaultstore", "confessional", "diary room secret", "hidden attribute",
    "soul:", "npc secret", "secret score", "relationship score",
)


def _free_ports(n: int) -> list[int]:
    """Allocate ``n`` distinct free ports. Two sequential bind-:0-then-close calls can hand back the
    SAME ephemeral port (the OS is free to re-lease a just-closed port), which would collide
    engine_port with fe_port and fail a subprocess bind at boot — an intermittent nightly failure.
    Hold every socket open until all ``n`` ports are chosen so they can't alias, then close them."""
    socks = []
    try:
        for _ in range(n):
            s = socket.socket()
            s.bind(("127.0.0.1", 0))
            socks.append(s)
        return [s.getsockname()[1] for s in socks]
    finally:
        for s in socks:
            s.close()


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


# ── graceful-degradation (in-process, deterministic) ──────────────────────────────
#
# The active path fails SOFT to the deterministic floor on a slow / empty / garbage / out-of-
# contract model reply, and every public method swallows its own errors (0080 §7.3 / §9). That
# fail-soft surface is inherently hard to force through a live model on a wall-clock walk, so we
# exercise it deterministically in-process against the REAL overseer module — the exact code the
# live junction relies on. Vault-free (Signals scalars only); no network.
def _graceful_degradation_checks() -> list[tuple[str, bool, str]]:
    rows: list[tuple[str, bool, str]] = []
    try:
        sys.path.insert(0, FRONTEND)
        from src.overseer import (LEVERS, Signals, DeterministicOverseer, LlmOverseer,
                                  dispatch_lever, should_assess)
    except Exception as e:  # import must not crash the whole run
        return [("degrade-import", False, f"could not import src.overseer: {e!r}")]

    # A stall Signals the sparse gate accepts (parked at advance, quiet, no progression).
    sig = Signals(in_advance_phase=True, play_quiet=True, progression_tool_called=False,
                  beat_seq_before=7, beat_seq_after=7)
    gate_ok = bool(should_assess(sig))
    rows.append(("degrade-gate-trips", gate_ok, "should_assess(stall)=True" if gate_ok
                 else "the sparse gate did not accept a stall Signals"))

    def _floor(name, llm_fn):
        try:
            v = LlmOverseer(llm_fn).assess(sig)
            ok = v is not None and v.lever in LEVERS  # fell through to a valid floor verdict
            rows.append((name, ok, f"verdict lever={getattr(v, 'lever', None)!r} (floor stands)"
                         if ok else f"did NOT fall to a valid floor verdict: {v!r}"))
        except Exception as e:  # the overseer must NEVER raise into the loop
            rows.append((name, False, f"RAISED into caller: {e!r}"))

    _floor("degrade-empty-reply", lambda _p: "")
    _floor("degrade-garbage-reply", lambda _p: "the model rambled with no json at all")
    _floor("degrade-out-of-contract-lever",
           lambda _p: json.dumps({"level": "action", "kind": "x", "diagnosis": "y", "lever": "nuke"}))
    _floor("degrade-raising-llm", lambda _p: (_ for _ in ()).throw(RuntimeError("provider 500")))

    # A slow verdict: the inline call is wrapped in asyncio.wait_for(timeout=12) at the junction, but
    # the module-level fail-soft is that a raising/blocking path still yields the floor and never
    # propagates. We assert the deterministic stub itself is instant + valid (the guaranteed floor).
    try:
        dv = DeterministicOverseer().assess(sig)
        ok = dv is not None and dv.lever in ACTION_LEVERS
        rows.append(("degrade-deterministic-floor", ok,
                     f"floor verdict lever={getattr(dv, 'lever', None)!r}"))
    except Exception as e:
        rows.append(("degrade-deterministic-floor", False, f"RAISED: {e!r}"))

    # dispatch_lever fail-soft: a raising action ⇒ applied=False (never propagates); a None/garbage
    # verdict ⇒ no-op; 'hold' ⇒ no action.
    class _V:  # a minimal duck-typed verdict
        def __init__(self, lever):
            self.lever = lever
    try:
        r_raise = dispatch_lever(_V("nudge"),
                                 {"nudge": lambda: (_ for _ in ()).throw(ValueError("boom"))})
        r_none = dispatch_lever(None, {})
        r_hold = dispatch_lever(_V("hold"), {})
        ok = (not r_raise.get("applied")) and (not r_none.get("applied")) and (not r_hold.get("applied"))
        rows.append(("degrade-dispatch-failsoft", ok,
                     f"raise->{r_raise.get('applied')} none->{r_none.get('applied')} "
                     f"hold->{r_hold.get('applied')} (all must be False)"))
    except Exception as e:
        rows.append(("degrade-dispatch-failsoft", False, f"dispatch_lever RAISED: {e!r}"))

    return rows


# The body-shape bound (§ below). The overseer surfaces only SHORT structured tokens; anything a
# free-form narration body / secret payload would look like (long, multi-line, many sentences) is a
# shape violation even without a denylist marker — a marker scan alone under-tests the contract.
_SHAPE_MAX_LEN = 600          # a single structured token/line never runs this long
_SHAPE_MAX_SENTENCES = 4      # a one-line diagnosis is not a multi-sentence paragraph


def _vault_scan(strings) -> tuple[bool, str]:
    """Scan every string the overseer surfaced against TWO rules, and fail on either:

      1. **Vault-leak marker** — any ``_VAULT_MARKERS`` substring (a hidden-layer scalar / secret
         body token) must never appear.
      2. **Body shape** — the overseer surfaces only short structured tokens (a kind, a one-line
         diagnosis, a lever). A free-form paragraph is itself a leak vector, so a surfaced string is
         a shape violation when it is too long (> ``_SHAPE_MAX_LEN`` chars), spans multiple lines
         (contains a newline), or reads as many sentences (> ``_SHAPE_MAX_SENTENCES`` terminators) —
         even with no denylist marker present.

    Returns ``(clean, detail)``; on a violation ``clean`` is False and ``detail`` names the offending
    string and which rule it broke (so a failure is actionable)."""
    for s in strings:
        s = s or ""
        low = s.lower()
        for m in _VAULT_MARKERS:
            if m in low:
                return False, f"vault marker {m!r} in surfaced string: {s[:80]!r}"
        # Body-shape: a structured token is short, single-line, not a multi-sentence paragraph.
        if len(s) > _SHAPE_MAX_LEN:
            return False, (f"body-shape violation: surfaced string is {len(s)} chars "
                           f"(> {_SHAPE_MAX_LEN} — a structured token, not a paragraph): {s[:80]!r}…")
        if "\n" in s or "\r" in s:
            return False, (f"body-shape violation: surfaced string spans multiple lines "
                           f"(structured tokens are single-line): {s[:80]!r}")
        sentences = sum(s.count(p) for p in (". ", "! ", "? ")) + s.rstrip().endswith((".", "!", "?"))
        if sentences > _SHAPE_MAX_SENTENCES:
            return False, (f"body-shape violation: surfaced string reads as ~{sentences} sentences "
                           f"(> {_SHAPE_MAX_SENTENCES} — a one-line diagnosis, not prose): {s[:80]!r}")
    return True, (f"{len(strings)} surfaced strings clean — no vault markers, and every string is a "
                  f"short single-line structured token (≤{_SHAPE_MAX_LEN} chars, "
                  f"≤{_SHAPE_MAX_SENTENCES} sentences)")


def main() -> int:
    key = os.environ.get("OPENROUTER_API_KEY") or ""
    if not key:
        print("FAIL: OPENROUTER_API_KEY required (live run)")
        return 1

    # Scrub shared per-user state so a prior run can't seed a stale binding / stale settings.
    for stale in ("orwell_game_session.json", "orwell_layout.json", "orwell_sync_ledger.json"):
        try:
            os.remove(os.path.join(FRONTEND, "data", stale))
        except FileNotFoundError:
            pass

    engine_port, fe_port = _free_ports(2)
    ebase = f"http://127.0.0.1:{engine_port}"
    fbase = f"http://127.0.0.1:{fe_port}"
    # Pre-init so the `finally` teardown is always safe: if the SECOND Popen raises (e.g. uvicorn
    # missing), the already-started `engine` + its log handle must still be torn down, and the
    # finally must not NameError on an unbound `fe` / `fe_log`. The launches move INSIDE the try.
    engine = fe = None
    engine_log = fe_log = None

    verdicts: list[tuple[str, bool, str]] = []          # the assertion rows (check, ok, detail)
    assessments: list[dict] = []                        # every OVERSEER-ring entry seen
    turn_log: list[dict] = []                           # per-turn: phase, latency, ring delta
    _ring_seen_seq = 0

    def _flush() -> None:
        # Incremental: a crash mid-walk must never lose the evidence gathered so far.
        with open(os.path.join(OUT, "verdicts.json"), "w", encoding="utf-8") as fh:
            json.dump([{"check": c, "ok": ok, "detail": d} for c, ok, d in verdicts], fh, indent=1)
        with open(os.path.join(OUT, "overseer_ring.json"), "w", encoding="utf-8") as fh:
            json.dump(assessments, fh, indent=1)
        with open(os.path.join(OUT, "turn_log.json"), "w", encoding="utf-8") as fh:
            json.dump(turn_log, fh, indent=1)

    try:
        engine_log = open(os.path.join(OUT, "engine.log"), "w")
        fe_log = open(os.path.join(OUT, "fe.log"), "w")
        engine = subprocess.Popen(
            ["node", os.path.join(REPO, "dist", "main.js")], cwd=REPO,
            env=dict(os.environ, ORWELL_DATA_DIR=tempfile.mkdtemp(prefix="ov-live-engine-"),
                     ORWELL_ENGINE_PORT=str(engine_port)),
            stdout=engine_log, stderr=subprocess.STDOUT)
        fe = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1",
             "--port", str(fe_port)], cwd=FRONTEND,
            env=dict(os.environ, ORWELL_GAME_BUILD="1", AUTH_ENABLED="false",
                     LOCALHOST_BYPASS="true", ORWELL_ENGINE_MCP_URL=ebase,
                     # Belt-and-suspenders: the settings.json write below is authoritative (read
                     # per-request), but seed the env fallback too so 'active' is live from boot.
                     ORWELL_OVERSEER_MODE="active",
                     DATABASE_URL="sqlite:///" + os.path.join(
                         tempfile.mkdtemp(prefix="ov-live-fe-"), "app.db")),
            stdout=fe_log, stderr=subprocess.STDOUT)

        _wait_http(ebase + "/player/tools", engine, "engine", 60)
        _wait_http(fbase + "/openapi.json", fe, "front-end", 120)

        # ── wire the real model (fork of _verify_two_window_live.py) + force active overseer ──
        ep = _post_form(fbase, "/api/model-endpoints", {
            "name": "ov-live", "base_url": BASE_URL, "api_key": key,
            "skip_probe": "true", "endpoint_kind": "openai"})
        sfile = os.path.join(FRONTEND, "data", "settings.json")
        cur = {}
        if os.path.exists(sfile):
            with open(sfile, encoding="utf-8") as fh:
                cur = json.load(fh)
        cur.update({
            "default_model": NARRATION, "default_endpoint_id": ep["id"],
            # The overseer's LlmOverseer resolves the UTILITY model — wire it to a real text endpoint.
            "utility_model": UTILITY, "utility_endpoint_id": ep["id"],
            # 0080: force the reasoning tier to be the PRIMARY actor (settings wins over the env).
            "overseer_mode": "active",
        })
        tmp = sfile + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(cur, fh, indent=2)
        os.replace(tmp, sfile)

        # Confirm the model resolved AND the mode resolved 'active' live (the strong wiring signal).
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                if _get(fbase, "/api/default-chat").get("model") == NARRATION:
                    break
            except Exception:
                pass
            time.sleep(1)
        mode_live = ""
        try:
            mode_live = _get(fbase, "/api/admin/logs/retention").get("overseerMode", "")
        except Exception as e:
            mode_live = f"<read failed: {e}>"
        verdicts.append(("overseer-mode-active", mode_live == "active",
                         f"resolved overseerMode={mode_live!r} (expected 'active')"))
        _flush()
        print(f"  overseer mode resolved live: {mode_live!r}", flush=True)

        # Start the season (same createCharacter seam the fork uses; role-only name).
        r = _post_json(ebase, "/player/call",
                       {"name": "createCharacter", "args": {"playerName": "Player", "seed": SEED}})
        if "result" not in r:
            raise RuntimeError(f"createCharacter failed: {r}")
        sess = _post_form(fbase, "/api/session", {
            "name": "ov-live", "model": NARRATION, "skip_validation": "true",
            "endpoint_id": ep["id"]}).get("id")

        def turn(text: str, timeout=600) -> float:
            """Drive one live chat turn; return wall-clock seconds. Server-detached (agent_runs): a
            client read timeout only drops this reader — the turn finishes server-side — so a slow
            reader degrades to 'poll for settle', never a crash (mirrors the fork's turn())."""
            t0 = time.time()
            try:
                _ws_turn(fbase, sess, text, timeout=timeout)   # ORW-44 S4b3: the game build is WebSocket-only
            except Exception as e:
                print(f"  turn reader dropped ({type(e).__name__}) — run continues detached; "
                      "waiting for settle", flush=True)
                dl = time.time() + 300
                while time.time() < dl:
                    try:
                        if _get(fbase, f"/api/chat/stream_status/{sess}",
                                timeout=10).get("status") != "streaming":
                            break
                    except Exception:
                        pass
                    time.sleep(5)
            return time.time() - t0

        def status() -> dict:
            try:
                return _get(fbase, "/api/orwell/status")
            except Exception:
                return {}

        def drain_overseer_ring() -> list[dict]:
            """Pull new OVERSEER-ring entries since the last cursor (admin log API; Vault-free)."""
            nonlocal _ring_seen_seq
            try:
                resp = _get(fbase, f"/api/admin/logs?source=overseer&since={_ring_seen_seq}")
            except Exception:
                return []
            new = resp.get("lines") or []
            if isinstance(resp.get("next"), int):
                _ring_seen_seq = resp["next"]
            for e in new:
                assessments.append(e)
            return new

        def live_log_lines() -> list[str]:
            """The front-end LIVE ring tail — carries the [orwell] sync-ledger + force-advance lines
            (the divergence-ledger surface) for corroboration + the Vault scan."""
            try:
                resp = _get(fbase, "/api/admin/logs?source=live&since=0")
            except Exception:
                return []
            return [str(l.get("msg") or "") for l in (resp.get("lines") or [])]

        # ── drive the walk: bias toward LULLS at advance phases so the narrator under-calls
        # advanceGame and the sparse 0079 gate trips; answer hard pendings minimally to keep the
        # night moving toward the next advance-lull. Roles only — never echo option labels. ──
        print(f"  driving up to {TURN_BUDGET} turns to trip the symptom gate...", flush=True)
        drain_overseer_ring()  # baseline
        for i in range(TURN_BUDGET):
            st = status()
            ph = st.get("phase") or "?"
            beat_before = st.get("beatSeq")
            pending = st.get("pending") if isinstance(st.get("pending"), dict) else None
            if pending and pending.get("kind"):
                kind = pending["kind"]
                # Minimal, role-only answers — enough to satisfy a hard pending, never a name in output.
                if kind == "comp-intent":
                    msg = "I'm competing hard in this one — full effort, count me in."
                elif kind == "nominations":
                    msg = ("I'll put up the two houseguests I trust least this week — lock in my "
                           "two nominees and move us forward.")
                elif kind in ("eviction-vote", "houseguests-choice", "tie-break"):
                    msg = "I cast my vote and I'm at peace with it — take my answer and keep going."
                elif kind == "comp-round":
                    msg = "I dig in and push through this round."
                elif kind == "veto-decision":
                    msg = "I'm not using the veto. The nominations stand."
                elif kind == "replacement":
                    msg = "I name my replacement nominee and let the ceremony finish."
                else:
                    msg = "I go with my gut — take my answer and keep the night moving."
            else:
                # A pure LULL: no new play, nothing for the model to record — the exact condition
                # that makes the narrator skip advanceGame and trips should_assess.
                msg = "I just hang back and let the house breathe for a beat. What happens next?"

            lat = turn(msg)
            new_ring = drain_overseer_ring()
            st2 = status()
            ph2 = st2.get("phase") or "?"
            beat_after = st2.get("beatSeq")
            turn_log.append({
                "turn": i + 1, "phaseBefore": ph, "phaseAfter": ph2,
                "beatBefore": beat_before, "beatAfter": beat_after,
                "pending": bool(pending), "latencyS": round(lat, 1),
                "newOverseerEntries": len(new_ring),
                "moved": (ph != ph2) or (isinstance(beat_before, int) and isinstance(beat_after, int)
                                         and beat_after > beat_before),
            })
            _flush()
            # STRICT filter — must match the `lever-dispatched` pass assertion exactly, or the walk
            # could stop early on a non-ok / non-actionable entry and then spuriously FAIL.
            acted = [e for e in assessments
                     if e.get("overseerLevel") == "action" and e.get("ok")
                     and e.get("lever") in ACTION_LEVERS]
            print(f"  turn {i+1:02d} [{ph}->{ph2}] {lat:.0f}s "
                  f"ring+{len(new_ring)} (assess={len(assessments)} action={len(acted)})", flush=True)

            # Stop early once we have a full evidence set: an assessment AND a dispatched action
            # lever that was followed by an observable state move.
            if acted and any(t["moved"] for t in turn_log[-3:]):
                print("  full evidence captured (assessment + dispatched lever + effect).", flush=True)
                break
            if (st2.get("phase") or "").startswith("veto"):
                break

        drain_overseer_ring()

        # ── assertions over the captured evidence ──
        # 2) at least one overseer assessment fired (the gate woke with a real model in active mode).
        verdicts.append(("assessment-fired", len(assessments) >= 1,
                         f"{len(assessments)} OVERSEER-ring entries recorded during the walk"))

        # 3) at least one ACTIONABLE lever dispatched (an 'action' entry, ok=True, actionable lever).
        acted = [e for e in assessments
                 if e.get("overseerLevel") == "action" and e.get("ok")
                 and e.get("lever") in ACTION_LEVERS]
        levers_seen = sorted({e.get("lever") for e in acted})
        verdicts.append(("lever-dispatched", len(acted) >= 1,
                         f"{len(acted)} dispatched action lever(s): {levers_seen or '—'}"))

        # 4) intended effect: a dispatched action was followed by an observable state move (phase or
        # beatSeq advanced), OR the ring itself recorded beatAfter>beatBefore, OR a force-advance
        # line is in the divergence/live log.
        lines = live_log_lines()
        forced_line = any("overseer force" in l.lower() or "forced advance" in l.lower()
                          or "active overseer pulled" in l.lower() for l in lines)
        ring_beat_moved = any(isinstance(e.get("beatAfter"), int) and isinstance(e.get("beatBefore"), int)
                              and e["beatAfter"] > e["beatBefore"] for e in acted)
        walk_moved = any(t["moved"] and t["newOverseerEntries"] > 0 for t in turn_log)
        effect_ok = bool(acted) and (ring_beat_moved or walk_moved or forced_line)
        verdicts.append(("lever-effect", effect_ok,
                         f"ring-beat-moved={ring_beat_moved} walk-moved={walk_moved} "
                         f"force-log={forced_line}"))

        # 5) the log reads TRUE: every 'action' entry is well-formed (a valid lever, a non-empty
        # kind + diagnosis, coherent beat fields) — the audit trail is not fabricated.
        LEVERS_ALL = set(ACTION_LEVERS) | {"hold", "escalate"}
        malformed = []
        for e in assessments:
            lev = e.get("lever")
            if lev is not None and lev not in LEVERS_ALL:
                malformed.append(f"bad lever {lev!r}")
            if e.get("overseerLevel") == "action":
                if not (e.get("kind") and e.get("diagnosis")):
                    malformed.append("action entry missing kind/diagnosis")
                for bf in ("beatBefore", "beatAfter"):
                    if e.get(bf) is not None and not isinstance(e.get(bf), int):
                        malformed.append(f"non-int {bf}")
        verdicts.append(("log-truthful", not malformed,
                         "all entries well-formed" if not malformed
                         else f"{len(malformed)} malformed: {malformed[:3]}"))

        # 6) Vault-leak scan of EVERYTHING the overseer surfaced + the divergence/live log.
        surfaced = []
        for e in assessments:
            for k in ("msg", "kind", "diagnosis", "lever"):
                if e.get(k):
                    surfaced.append(str(e[k]))
        surfaced += [l for l in lines if "overseer" in l.lower() or "sync-ledger" in l.lower()]
        clean, detail = _vault_scan(surfaced)
        verdicts.append(("no-vault-leak", clean, detail))

        # 8) no latency regression: no symptomatic turn hung past the ceiling (the inline overseer
        # call is bounded; the floor catches a slow verdict).
        worst = max((t["latencyS"] for t in turn_log), default=0.0)
        verdicts.append(("no-latency-regression", worst <= LATENCY_HANG_S,
                         f"worst turn {worst:.0f}s (ceiling {LATENCY_HANG_S:.0f}s)"))

        # 7) graceful degradation (in-process, deterministic — the real overseer module).
        for row in _graceful_degradation_checks():
            verdicts.append(row)

        _flush()

        # ── summary ──
        failed = [v for v in verdicts if not v[1]]
        with open(os.path.join(OUT, "SUMMARY.md"), "w", encoding="utf-8") as fh:
            fh.write("# 0080 active-overseer LIVE validation (#766)\n\n")
            fh.write(f"- narration model: `{NARRATION}`\n- utility model: `{UTILITY}`\n")
            fh.write(f"- overseer mode resolved: `{mode_live}`\n")
            fh.write(f"- turns driven: {len(turn_log)}\n")
            fh.write(f"- overseer-ring entries: {len(assessments)} "
                     f"(actionable dispatched: {len(acted)}, levers: {levers_seen or '—'})\n\n")
            fh.write("| check | result | detail |\n|---|---|---|\n")
            for c, ok, d in verdicts:
                fh.write(f"| {c} | {'PASS' if ok else 'FAIL'} | {d} |\n")

        print("\n  ── per-check results ──", flush=True)
        for c, ok, d in verdicts:
            print(f"    [{'PASS' if ok else 'FAIL'}] {c}: {d}", flush=True)
        print(f"\n{'VERIFY OK' if not failed else 'VERIFY FAIL'} — "
              f"{len(verdicts) - len(failed)}/{len(verdicts)} checks passed; "
              f"evidence in {OUT}", flush=True)
        return 0 if not failed else 1
    finally:
        for p in (fe, engine):
            if p is None:  # a launch that never started (or raised) — nothing to tear down
                continue
            try:
                p.terminate()
                p.wait(timeout=10)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
        # Close the subprocess log handles the parent opened (never left dangling).
        for _h in (fe_log, engine_log):
            if _h is None:
                continue
            try:
                _h.close()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
