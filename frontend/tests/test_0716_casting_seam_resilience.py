"""2026-07-16 live-playthrough audit — fixes 3, 4, 5.

  #4 PRODUCTION-HOLD BEAT: `do_create_character`'s inline genesis fallback (the pre_seed_cast /
     run_genesis pre-finalize kick) can block ~70s with nothing but a bare spinner on the "Casting"
     tool-beat chip. Fix: reuse the SAME `progress_cb` seam `execute_tool_block` already threads to
     bash/python long-running tools (see tool_execution.py) to surface ONE short, diegetic,
     producer-register status line BEFORE the blocking await — never narration content, a status
     beat riding the existing tool-beat chip machinery.

  #3 PREMIERE-OPENER RESILIENCE: a live playthrough hit a round where createCharacter finalized but
     the follow-up move-in narration stream died silently (an errored/empty LLM round) — the turn
     closed with no move-in narration and the player had to speak first. Fix: chat.js already tracks
     the window via `_orwellFinalizingActive` (set true the instant createCharacter's tool result
     lands, cleared the moment the FIRST narration token arrives); if the stream's `finally` block is
     reached with that flag STILL true, auto-refire a hidden production cue through the SAME
     `_sendCueWithBackoff` kernel #967/#969 already use for the interview opener / post-photo resume.

  #5 PRODUCER-SPEAKS-FIRST HOLE: `openFreshInterviewSession()`'s `nb.click()` dispatches a click
     whose real handler (app.js's sidebar-brand-btn listener) is ASYNC — it awaits
     `window._orwellConfirmLeaveGame()`'s live-season probe (a real network round trip) BEFORE it
     arms the pending chat. `nb.click()` itself returns immediately, racing the cue backoff's first
     attempt at 250ms. Fix: poll (bounded, best-effort) for `sessionModule.hasPendingChat()` before
     returning, so the backoff's first attempt lands on a materializable target.

Behavioral tests drive the real `do_create_character` (fix 4); the rest are source pins (JS
conventions the repo already tests this way — see test_967_casting_kickoff.py / test_m1_7_season_reset.py).
Roles only; no names.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import os
import re

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ti = importlib.import_module("src.tool_implementations")
te = importlib.import_module("src.tool_execution")


def _read(*parts):
    with open(os.path.join(FRONTEND, *parts), encoding="utf-8") as f:
        return f.read()


# ── fix 4: the production-hold beat ─────────────────────────────────────────────────────────

def test_do_create_character_emits_production_hold_progress_before_genesis_await(monkeypatch):
    owner = "role-player-hold"
    oe = importlib.import_module("src.orwell_engine")

    async def _create(*a, **k):
        return {"started": True, "beatSeq": 1, "house": [], "portraitPrompts": []}

    monkeypatch.setattr(oe, "create_character", _create)
    monkeypatch.setattr(oe, "remember_pending", lambda *a, **k: None)

    events = []

    async def _progress_cb(payload):
        events.append(payload)

    asyncio.get_event_loop().run_until_complete(
        ti.do_create_character(
            '{"playerName": "role-player-hold"}', owner=owner, progress_cb=_progress_cb))

    assert events, "progress_cb must fire at least once during the inline genesis fallback"
    assert any(isinstance(e, dict) and (e.get("tail") or "").strip() for e in events), (
        "the progress event must carry a non-empty diegetic status line under 'tail' "
        "(the same shape chat.js's tool_progress handler already renders)"
    )
    # Never leak raw machinery language — this is meant to read as production, not a stack trace.
    for e in events:
        tail = (e.get("tail") or "")
        assert "Traceback" not in tail and "Exception" not in tail


def test_do_create_character_tolerates_a_raising_progress_cb(monkeypatch):
    """Best-effort: a progress_cb hiccup must never break game creation."""
    owner = "role-player-hold-2"
    oe = importlib.import_module("src.orwell_engine")

    async def _create(*a, **k):
        return {"started": True, "beatSeq": 1, "house": [], "portraitPrompts": []}

    monkeypatch.setattr(oe, "create_character", _create)
    monkeypatch.setattr(oe, "remember_pending", lambda *a, **k: None)

    async def _bad_progress_cb(payload):
        raise RuntimeError("progress channel hiccup")

    res = asyncio.get_event_loop().run_until_complete(
        ti.do_create_character(
            '{"playerName": "role-player-hold-2"}', owner=owner, progress_cb=_bad_progress_cb))

    assert isinstance(res, dict)
    assert res.get("exit_code") == 0
    assert json.loads(res["output"]).get("started") is True


def test_do_create_character_works_with_no_progress_cb(monkeypatch):
    """Backward-compatible: progress_cb is optional and defaults to None (every existing caller)."""
    owner = "role-player-hold-3"
    oe = importlib.import_module("src.orwell_engine")

    async def _create(*a, **k):
        return {"started": True, "beatSeq": 1, "house": [], "portraitPrompts": []}

    monkeypatch.setattr(oe, "create_character", _create)
    monkeypatch.setattr(oe, "remember_pending", lambda *a, **k: None)

    res = asyncio.get_event_loop().run_until_complete(
        ti.do_create_character('{"playerName": "role-player-hold-3"}', owner=owner))

    assert isinstance(res, dict)
    assert res.get("exit_code") == 0
    assert json.loads(res["output"]).get("started") is True


def test_tool_execution_forwards_progress_cb_to_create_character():
    """Wiring pin: execute_tool_block's createCharacter branch must forward its own `progress_cb`
    param into `do_create_character` — the SAME generic plumbing already used for bash/python."""
    src = _read("src", "tool_execution.py")
    anchor = src.index('elif tool == "createCharacter":')
    seg = src[anchor: anchor + 700]
    assert "do_create_character(content, owner=owner, progress_cb=progress_cb)" in seg, (
        "createCharacter must forward progress_cb so the production-hold beat can fire"
    )


def test_do_create_character_signature_accepts_progress_cb():
    import inspect
    sig = inspect.signature(ti.do_create_character)
    assert "progress_cb" in sig.parameters
    assert sig.parameters["progress_cb"].default is None


# ── fix 3: premiere-opener resilience (source pins — JS convention, mirrors test_967) ────────

def test_premiere_continue_cue_defined_and_reuses_backoff_kernel():
    js = _read("static", "js", "orwellOnboarding.js")
    assert "_orwellPremiereContinueIfSilent" in js
    fn = js[js.index("window._orwellPremiereContinueIfSilent = function"):]
    fn = fn[: fn.index("\n  };") + 5]
    # Reuses the SAME robust kernel the opener/resume cues use — never a bespoke send path.
    assert "_sendCueWithBackoff(" in fn
    assert "PREMIERE_CONTINUE_LINE" in fn
    # Game-build only, like every other OOBE cue.
    assert "data-game-build" in fn
    # Once-guard so a retry can't double-fire.
    assert "_premiereContinueSent" in fn


def test_premiere_continue_line_is_a_cue_never_authored_narration():
    js = _read("static", "js", "orwellOnboarding.js")
    line_decl = js[js.index("const PREMIERE_CONTINUE_LINE ="):]
    line_decl = line_decl[: line_decl.index(";") + 1]
    # It must read as a PRODUCTION CUE (parenthetical instruction), not in-fiction prose —
    # the belt only re-prompts, it never fakes narration content (CLAUDE.md mandate).
    assert "Production cue" in line_decl


def test_chat_js_refires_premiere_continue_only_when_recovery_latch_survived_to_finally():
    """CodeRabbit fix (2026-07-17): the refire now rides a DEDICATED
    `_orwellPremiereRecoveryArmed` latch, not the UI-only `_orwellFinalizingActive` flag — the
    latter arms at tool_start (before success is known) and clears on ANY delta including
    reasoning-only output, so reusing it for recovery could fire after a failed/refused creation
    or miss a genuine reasoning-then-nothing silent death."""
    js = _read("static", "js", "chat.js")
    anchor = js.index('safety net — never leave the "finalizing" indicator stuck')
    seg = js[anchor: anchor + 2200]
    assert "if (_orwellPremiereRecoveryArmed) {" in seg
    assert "_orwellPremiereContinueIfSilent" in seg
    # the refire call must be INSIDE the dedicated-latch-still-armed branch, not unconditional,
    # and NOT nested inside the UI-only _orwellFinalizingActive branch.
    guard_idx = seg.index("if (_orwellPremiereRecoveryArmed) {")
    refire_idx = seg.index("_orwellPremiereContinueIfSilent")
    close_idx = seg.index("\n      }", guard_idx)
    assert guard_idx < refire_idx < close_idx, (
        "the premiere-continue refire must be nested inside the still-armed recovery-latch "
        "branch, so it never fires on the happy path where a reply token already cleared it"
    )


def test_premiere_recovery_latch_is_dedicated_and_declared():
    """The recovery latch must be its own variable, separate from `_orwellFinalizingActive`."""
    js = _read("static", "js", "chat.js")
    assert "let _orwellPremiereRecoveryArmed = false;" in js


def test_premiere_recovery_latch_arms_only_on_confirmed_started_not_refused():
    """The latch must arm from the createCharacter tool RESULT (json.output), gated on
    `started && !createRefused` — never unconditionally at tool_start, and never on a
    failed/refused creation."""
    js = _read("static", "js", "chat.js")
    anchor = js.index("arm the DEDICATED recovery latch only once the engine result")
    seg = js[anchor: anchor + 400]
    assert "_cc.started && !_cc.createRefused" in seg
    assert "_orwellPremiereRecoveryArmed = true" in seg
    # It must NOT be armed at the tool_start (createCharacter begin) site, only at the
    # tool-result site — search the earlier createCharacter tool_start block for the absence.
    start_anchor = js.index("if (json.tool === 'createCharacter') {")
    start_seg = js[start_anchor: start_anchor + 300]
    assert "_orwellPremiereRecoveryArmed = true" not in start_seg, (
        "the recovery latch must not arm at tool_start, before success is known"
    )


def test_premiere_recovery_latch_clears_only_on_non_thinking_delta():
    """Reasoning-only deltas (json.thinking truthy) must NOT clear the recovery latch — only a
    real reply token may, so a reasoning-then-silent-death turn still triggers the finally-block
    auto-refire."""
    js = _read("static", "js", "chat.js")
    anchor = js.index("clear the premiere-recovery latch only on a real reply token")
    seg = js[anchor: anchor + 300]
    # ORW-59: "a real reply token" is now applyDelta's isReplyToken (= !json.thinking, pinned in test_orw59_stream_machine.py)
    assert "if (_ad.isReplyToken && _orwellPremiereRecoveryArmed) _orwellPremiereRecoveryArmed = false;" in seg
    assert "isReplyToken: !json.thinking" in _read("static", "js", "chatStreamMachine.js")


def test_premiere_recovery_is_suppressed_on_an_intentional_user_stop():
    """CodeRabbit follow-up (2026-07-17): the premiere-recovery latch surviving to the finally
    block is not by itself enough to auto-refire — an intentional user Stop (or a browser
    navigation abort) right after createCharacter succeeds but before any narration streamed must
    NOT enqueue a hidden continuation the player never asked for. A dedicated
    `_orwellUserStoppedThisTurn` flag, set ONLY in the catch block's genuine user-stop branch, must
    gate the refire — while the latch itself is still always cleared (no stale re-arm carrying
    into the next turn)."""
    js = _read("static", "js", "chat.js")
    assert "let _orwellUserStoppedThisTurn = false;" in js

    # Set ONLY inside the catch block's genuine "User-initiated stop" branch — never at the
    # timeout/offline/tab-recovery abort branches above it (those are system interruptions the
    # player did not ask for, so the silent-death recovery still legitimately applies to them).
    stop_anchor = js.index("// User-initiated stop (or browser navigation abort).")
    stop_seg = js[stop_anchor: stop_anchor + 500]
    assert "_orwellUserStoppedThisTurn = true;" in stop_seg

    # The other abort-reason branches (timeout / offline / recovery) must NOT set the flag — only
    # the plain user-stop fallthrough may.
    catch_anchor = js.index("} catch (err) {")
    pre_stop_seg = js[catch_anchor:stop_anchor]
    assert "_orwellUserStoppedThisTurn = true;" not in pre_stop_seg, (
        "the user-stopped flag must be set ONLY on a genuine user-initiated stop, never on a "
        "timeout/offline/tab-recovery abort"
    )

    # The finally block's refire must be gated on the flag, nested inside the still-armed latch
    # check (so the latch is unconditionally cleared either way — no stale re-arm survives).
    anchor = js.index('safety net — never leave the "finalizing" indicator stuck')
    seg = js[anchor: anchor + 2000]
    guard_idx = seg.index("if (_orwellPremiereRecoveryArmed) {")
    clear_idx = seg.index("_orwellPremiereRecoveryArmed = false;", guard_idx)
    stop_guard_idx = seg.index("if (!_orwellUserStoppedThisTurn) {", clear_idx)
    refire_idx = seg.index("_orwellPremiereContinueIfSilent", stop_guard_idx)
    close_idx = seg.index("\n      }", guard_idx)
    assert guard_idx < clear_idx < stop_guard_idx < refire_idx < close_idx, (
        "the refire must be nested inside BOTH the still-armed latch check AND the "
        "not-user-stopped guard, with the latch itself cleared unconditionally"
    )


def test_restart_reset_rearms_the_premiere_continue_latch():
    """A season-2+ restart must be able to refire this belt too (mirrors _openSent/_resumeSent)."""
    js = _read("static", "js", "orwellOnboarding.js")
    mark_restart = js[js.index("window._orwellMarkRestart = () => {"):]
    mark_restart = mark_restart[: mark_restart.index("\n  };") + 5]
    assert "_premiereContinueSent = false" in mark_restart


# ── fix 5: producer-speaks-first hole (source pin) ────────────────────────────────────────────

def test_open_fresh_interview_session_waits_for_pending_chat_before_returning():
    js = _read("static", "js", "orwellOnboarding.js")
    fn_start = js.index("async function openFreshInterviewSession()")
    fn = js[fn_start: js.index("\n  }", fn_start) + 4]
    assert "hasPendingChat" in fn, (
        "openFreshInterviewSession must wait for the async 'New Chat' click handler to actually "
        "arm the pending session (sessionModule.hasPendingChat) before returning — otherwise the "
        "cue backoff's first attempt can fire before there is anything to materialize into"
    )
    # Bounded polling (never an unbounded/hanging wait) — matches the repo's established idiom
    # for this class of best-effort readiness poll (e.g. the M1-7 rename poll).
    assert re.search(r"for \(let i = 0; i < \d+; i\+\+\)", fn)
    assert "setTimeout" in fn


def test_open_fresh_interview_session_poll_is_fail_open():
    js = _read("static", "js", "orwellOnboarding.js")
    # The poll loop is a single try/catch bracketing exactly the bounded for-loop — a hiccup
    # anywhere inside (a missing sessionModule, a thrown promise) can never hang or throw
    # onboarding off the rails.
    assert re.search(
        r"try \{\s*\n\s*for \(let i = 0; i < 15; i\+\+\) \{\s*\n"
        r"\s*if \(window\.sessionModule && window\.sessionModule\.hasPendingChat "
        r"&& window\.sessionModule\.hasPendingChat\(\)\) break;\s*\n"
        r"\s*await new Promise\(\(r\) => setTimeout\(r, 100\)\);\s*\n"
        r"\s*\}\s*\n\s*\} catch \(_\) \{\}",
        js,
    ), "the pending-chat poll must be a single bounded try/catch-wrapped for-loop (fail-open)"
