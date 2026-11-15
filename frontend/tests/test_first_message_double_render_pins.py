"""Source pins for the first-message double-render fix (#1087 SSE self-echo parity).

These run in the fast `fe-unit` lane (no browser) so a revert of any leg fails immediately — the
behavioral proof of the own-echo classification now lives in `test_orw44_s4c_sse_reader_invariants.py::test_double_render_*` (node unit test on chat.js; the browser stack was retired in ORW-44 S4c).

The bug: `session_events` is at-least-once, so a window received its OWN `run-started` echo while its
foreground POST was still rendering that run; sessionSync could not tell its own echo from a genuine
PEER run, deferred a peer-resume of its OWN run, and at stream end re-attached to the just-finished run
(evict grace) — painting a duplicate the reconcile then collapsed ("appears twice then dedupes"). The
fix gives the SSE `run-started` edge a run id (the WS edge already had it, #1087) so the sender can
recognize and skip its own run; a genuine peer run (different runId) still resumes/defers (GAP-1 kept).
"""
import inspect
import os

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(FRONTEND, "static", "js")


def _read(*parts):
    with open(os.path.join(FRONTEND, *parts), encoding="utf-8") as f:
        return f.read()


# ── server: the SSE run-started edge carries the run id ──────────────────────────────

def test_session_events_stamps_run_id_on_run_started():
    """`session_events.publish` must stamp the current run id onto a `run-started` edge (SSE #1087
    parity), so a self-echo/replayed edge carries a run identity the client can recognize."""
    import importlib
    se = importlib.import_module("src.session_events")
    src = inspect.getsource(se.publish)
    assert 'event == "run-started"' in src, "publish must special-case run-started"
    assert "run_id(session_id)" in src, "publish must look up the current run id for a run-started edge"
    assert '"runId"' in src, "the run id must be attached to the payload as `runId`"


def test_session_events_run_id_stamp_is_best_effort_and_scoped():
    """The stamp must be scoped to run-started (never message-added etc.) and fail-open (a lazy import
    guarded so a missing/gone run never breaks a publish — absent id ⇒ unchanged behavior)."""
    import importlib
    se = importlib.import_module("src.session_events")
    src = inspect.getsource(se.publish)
    # gated on the event type (not applied to every event)
    assert 'if event == "run-started" and "runId" not in data:' in src
    # fail-open lazy import
    assert "from src import agent_runs" in src
    assert "except Exception:" in src


# ── client: chat.js learns/classifies its own run id ─────────────────────────────────

def test_chatstate_holds_the_own_run_id_map():
    js = _read("static", "js", "chatState.js")
    assert "_ownRunIds:" in js, "chatState must hold the per-session own-run-id map"


def test_chat_js_note_run_started_learns_and_recognizes_own_run():
    js = _read("static", "js", "chat.js")
    assert "function noteRunStarted(sessionId, runId)" in js, "the classifier helper must exist"
    block = js[js.index("function noteRunStarted(sessionId, runId)"):]
    block = block[:block.index("\n  }") + 3]
    # learn ONLY the first run-started seen while OUR foreground POST is live for the session
    assert "chatState._streamSessionId === sessionId" in block, \
        "own-run learning must be gated on our own foreground POST being live for the session"
    assert "!chatState._ownRunIds[sessionId]" in block, \
        "only the FIRST run-started (ours, published first) is recorded — never overwritten by a later peer"
    assert "return chatState._ownRunIds[sessionId] === runId" in block, \
        "classification must compare the edge's runId to OUR recorded own run id"
    # fail-open: no runId ⇒ not our own (pre-#1087 behavior)
    assert "if (!sessionId || !runId) return false;" in block


def test_chat_js_resets_own_run_id_per_foreground_post():
    """A NEW foreground POST gets a NEW run id, so the map entry must reset per turn — else turn 2's own
    echo (a new id) would be mis-classified as a peer and resume-duplicated again."""
    js = _read("static", "js", "chat.js")
    assert "delete chatState._ownRunIds[streamSessionId];" in js, \
        "the foreground POST must clear last turn's own-run id so the new turn re-learns it"


def test_chat_module_exports_note_run_started():
    js = _read("static", "js", "chat.js")
    assert "noteRunStarted," in js, "noteRunStarted must be exported on chatModule for sessionSync"


# ── client: sessionSync never (defer-)resumes its own run ────────────────────────────

def test_session_sync_skips_peer_resume_of_own_run():
    js = _read("static", "js", "sessionSync.js")
    # classify the edge synchronously (before the async convergeView, while _streamSessionId is live)
    assert "cm.noteRunStarted && cm.noteRunStarted(id, data && data.runId)" in js, \
        "sessionSync must classify the run-started edge via chatModule.noteRunStarted"
    # the resume/defer is now gated on NOT being our own run
    assert "if (!_isOwnRun && isWatchedSession(id) && cm.resumeStream) {" in js, \
        "the (defer-)resume must be skipped for our OWN run (only a genuine peer run resumes)"
    # GAP-1 preserved: the deferred-peer-resume and idle-resume legs still exist for a genuine peer
    assert "if (cm.hasActiveStream && cm.hasActiveStream(id)) {" in js
    assert "if (cm.deferPeerResume) cm.deferPeerResume(id);" in js
    assert "cm.resumeStream(id);" in js
    # our own run is STILL reconciled (adopted) — softReloadHistory always runs
    assert "cm.softReloadHistory && cm.softReloadHistory(id)" in js
