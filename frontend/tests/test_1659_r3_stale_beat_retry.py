"""#1659 R3 / audit A-S3 — the STALE-BEAT RETRY PROTOCOL for model-driven progression.

Owner ruling 2026-07-16 (issue #1659, failure seam 3): "StaleBeatError is a dead end."
`advanceGame → StaleBeatError` was never retried — the model free-ran on a beat that never
committed — and a `recordInteraction` stale-drop was ledger-invisible with no re-fold (the
`docs/REFACTOR-ROADMAP.md` A-S3 latent, live). R3: on a 409 `stale-beat`, refresh beatSeq → retry
ONCE → if still stale, reconcile through the desync path; every rejection ledger-visible.

The FE-issued pre-resolve advance already ran this protocol (S1a/RC1, `_pre_resolve_npc_ceremony`);
the residual seam was the MODEL-driven progression tools (`do_advance_game` / `do_submit_decision` /
`do_turn_in`), which reconciled and RETURNED THE CURRENT BOARD without re-firing. This gate pins the
new shared `retry_progression_after_stale` helper + its wiring into all three tools:

  (a) a 409 stale-beat triggers exactly ONE refresh+retry that then succeeds (the progression LANDS);
  (b) a persistent stale (still 409 after retry) reconciles via the desync path AND is recorded
      RED-with-disposition in the ledger (never a silent dead-end);
  (c) the stale rejection is ledger-visible (counted) in both cases;
  (d) no double-apply on retry — the SAME at-most-once idempotency key rides both attempts, so an
      engine that already committed the first (a socket race) dedups the retry.

Roles only; the engine client is faked so we capture the exact tokens/keys the FE passes.
"""
import asyncio
import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
log_rings = importlib.import_module("src.log_rings")
ti = importlib.import_module("src.tool_implementations")


def _run(coro):
    # xdist hygiene: reuse the thread's existing event loop — never asyncio.run(), which nulls the
    # thread's loop and poisons sibling tests that call get_event_loop().
    return asyncio.get_event_loop().run_until_complete(coro)


def _stale_409(now: int) -> "orwell_engine.EngineToolError":
    return orwell_engine.EngineToolError(
        f"stale write refused — expected beatSeq is behind the current board (now {now}); re-ground",
        status=409)


@pytest.fixture(autouse=True)
def _clean_state():
    chat_helpers._LAST_BEAT_SEQ.clear()
    chat_helpers._LAST_BEAT_SIG.clear()
    chat_helpers._DESYNC_REGROUND.clear()
    chat_helpers.reset_stale_beat_rejections()
    for ring in (log_rings.OVERSEER, log_rings.LLMIO, log_rings.IO, log_rings.LIVE):
        ring.buf.clear()
    yield
    chat_helpers._LAST_BEAT_SEQ.clear()
    chat_helpers._LAST_BEAT_SIG.clear()
    chat_helpers._DESYNC_REGROUND.clear()
    chat_helpers.reset_stale_beat_rejections()


def _patch_reconcile_reads(monkeypatch, now: int):
    """`_handle_stale_beat` re-reads the board (gameStatus + getGameState) to reconcile precisely — fake
    both to the reconciled `beatSeq` so the retry attaches the fresh token."""
    async def fake_status(user=None):
        return {"week": 4, "phase": "eviction", "pending": None, "veto": {}, "beatSeq": now}

    async def fake_state(user=None, **kw):
        return {"week": 4, "phase": "eviction", "finished": False, "house": [], "beatSeq": now}

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)


def _silence_advance_kickoffs(monkeypatch):
    """The advance happy-path fires two best-effort background enrichers; no-op them so the test drives
    only the sync-spine seam deterministically (they are fire-and-forget, guarded by their own try)."""
    import src.orwell_offscreen_texture as _oot
    import src.orwell_gen_competitions as _ogc
    monkeypatch.setattr(_oot, "kickoff_enrich", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(_ogc, "kickoff_fiction", lambda *a, **k: None, raising=False)


def _overseer_events(kind_prefix: str):
    _, lines = log_rings.OVERSEER.since(0, limit=100000)
    return [e for e in lines
            if str(e.get("kind") or "").startswith(kind_prefix) and e.get("ok") is False]


# ── (a) a stale-beat triggers exactly ONE refresh+retry that then SUCCEEDS ───────────────────────

def test_advance_stale_refreshes_and_retries_once_then_succeeds(monkeypatch):
    """advanceGame races a 409 stale-beat; the FE refreshes beatSeq and RE-FIRES ONCE against the
    reconciled token — the advance LANDS (the model delivers the real next beat, no free-run)."""
    _patch_reconcile_reads(monkeypatch, now=9)
    _silence_advance_kickoffs(monkeypatch)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 4  # stale token
    calls = {"keys": [], "beats": []}

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        calls["keys"].append(idempotency_key)
        calls["beats"].append(expected_beat_seq)
        if expected_beat_seq != 9:
            raise _stale_409(9)                          # refused BEFORE any mutation (fail-closed)
        return {"beatSeq": 10, "phase": "eviction"}      # the reconciled retry LANDS

    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)

    out = _run(ti.do_advance_game("{}", owner="owner"))
    assert out["exit_code"] == 0
    assert '"beatSeq": 10' in out["output"], "the LANDED advance result is delivered, not the stale board"
    assert calls["beats"] == [4, 9], "one stale attempt (4), then exactly ONE retry against the fresh beat (9)"
    assert chat_helpers.stale_beat_rejections() == 1, "the initial stale is counted → ledger-visible"
    assert chat_helpers.last_beat_seq("owner") == 10, "last-seen refreshed from the landed retry"
    # A successful reconcile+apply clears the spurious re-ground (the model must not be told 'nothing changed').
    assert chat_helpers._DESYNC_REGROUND.get(chat_helpers._desync_key("owner")) is None


# ── (d) NO DOUBLE-APPLY — the retry reuses the SAME at-most-once idempotency key ──────────────────

def test_advance_retry_reuses_the_same_idempotency_key(monkeypatch):
    """The bounded retry must carry the SAME key as the initial call so the engine's at-most-once dedups
    a genuine double-apply (a socket race where the first attempt actually committed) — never a
    double-advance."""
    _patch_reconcile_reads(monkeypatch, now=9)
    _silence_advance_kickoffs(monkeypatch)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 4
    keys = []

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        keys.append(idempotency_key)
        if expected_beat_seq != 9:
            raise _stale_409(9)
        return {"beatSeq": 10}

    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    _run(ti.do_advance_game("{}", owner="owner"))
    assert len(keys) == 2, "the initial call + exactly one retry"
    assert keys[0] is not None and keys[0] == keys[1], "the retry reuses the SAME at-most-once key"


def test_advance_retry_is_idempotent_under_double_commit(monkeypatch):
    """The nastier race: the FIRST attempt actually COMMITTED server-side (recorded its idempotency key)
    but the FE observed a stale-409 anyway. The retry re-drives with the SAME key — the engine dedups and
    does NOT advance a second time. Net: exactly one advance."""
    _patch_reconcile_reads(monkeypatch, now=9)
    _silence_advance_kickoffs(monkeypatch)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 4
    committed = {}          # idempotency_key -> prior result (the engine's at-most-once ledger)
    advances = {"n": 0}

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        if idempotency_key in committed:
            return committed[idempotency_key]            # DEDUP — the re-drive does NOT advance again
        committed[idempotency_key] = {"beatSeq": 10}
        advances["n"] += 1                               # the advance DID commit on the first attempt
        raise _stale_409(9)                              # ...but the FE's ack raced a concurrent bump

    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    out = _run(ti.do_advance_game("{}", owner="owner"))
    assert out["exit_code"] == 0
    assert advances["n"] == 1, "the advance applied EXACTLY once despite the reconcile retry"
    assert '"beatSeq": 10' in out["output"], "the deduped original result is delivered"


# ── (b)+(c) a PERSISTENT stale reconciles via the desync path AND is RED-with-disposition ─────────

def test_advance_persistent_stale_reconciles_and_records_red_with_disposition(monkeypatch):
    """The board keeps moving under both attempts. The progression can't land, so the FE reconciles to
    the LIVE board (the desync path) — and the persistent stale is recorded RED-with-disposition in the
    failure ledger, never a silent dead-end. Both stales are counted (ledger-visible)."""
    _patch_reconcile_reads(monkeypatch, now=9)
    _silence_advance_kickoffs(monkeypatch)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 4

    async def always_stale(expected_beat_seq=None, idempotency_key=None, user=None):
        raise _stale_409(9)                              # the board keeps moving under every attempt

    monkeypatch.setattr(orwell_engine, "advance_game", always_stale)

    out = _run(ti.do_advance_game("{}", owner="owner"))
    assert out["exit_code"] == 0                          # no exception escaped
    assert '"phase": "eviction"' in out["output"], "reconciled to the LIVE board (the desync path)"
    assert chat_helpers.stale_beat_rejections() == 2, "BOTH the initial and post-retry stale are counted"
    # RED-with-disposition: a real recorder call, not a silent swallow / log-only line (#1599).
    events = _overseer_events("progression:advanceGame-double-stale")
    assert events, "a persistent progression stale must be RED-with-disposition (record_soft_failure)"
    assert "desync-reground" in str(events[-1].get("diagnosis") or ""), "annotated with its disposition"
    # The desync re-ground is stashed so the NEXT turn re-grounds to the moved board.
    assert chat_helpers._DESYNC_REGROUND.get(chat_helpers._desync_key("owner")) is not None


# ── the helper is exercised directly (unit) + the sibling tools are wired the same way ───────────

def test_helper_returns_none_on_persistent_stale_and_reraises_non_stale(monkeypatch):
    _patch_reconcile_reads(monkeypatch, now=9)
    chat_helpers._LAST_BEAT_SEQ["u"] = 4

    async def retry_stale(_fresh):
        raise _stale_409(9)

    res = _run(chat_helpers.retry_progression_after_stale("u", _stale_409(9), retry_stale, action="turnIn"))
    assert res is None, "a persistent stale returns None (caller falls back to the live board)"
    assert chat_helpers.stale_beat_rejections() == 2

    chat_helpers.reset_stale_beat_rejections()

    async def retry_boom(_fresh):
        raise RuntimeError("engine down")                # a NON-stale error must PROPAGATE unchanged

    with pytest.raises(RuntimeError):
        _run(chat_helpers.retry_progression_after_stale("u", _stale_409(9), retry_boom, action="turnIn"))


# ── concurrency guard (CodeRabbit on #1694): a same-owner flow interleaving the retry await ──────

def test_landed_retry_does_not_regress_beatseq_or_drop_a_newer_reground(monkeypatch):
    """While the retry await is in flight, a DIFFERENT same-owner flow (a two-window peer / the
    background pre-resolve — ship-gate F4) advances `_LAST_BEAT_SEQ` to a HIGHER value AND re-stashes a
    NEWER `_DESYNC_REGROUND` directive. On completion the helper must (a) NOT regress last-seen below the
    concurrently-advanced value (a lower token self-inflicts a future 409), and (b) NOT drop the newer
    directive (compare-and-clear only OUR own reconcile's re-ground). Without the guard this test fails:
    the plain `_refresh_beat_seq` would last-write-wins `res` (12) over 20, and the unconditional pop
    would drop the newer directive."""
    _patch_reconcile_reads(monkeypatch, now=9)
    chat_helpers._LAST_BEAT_SEQ["u"] = 4  # stale token
    dk = chat_helpers._desync_key("u")
    newer = "NEWER DIRECTIVE — a concurrent same-owner flow set this during the await"

    async def retry_fn_with_concurrent_advance(_fresh):
        # A peer advanced the board PAST our retry's beat and set its own re-ground while we were awaiting.
        chat_helpers._LAST_BEAT_SEQ[chat_helpers._beat_seq_key("u")] = 20
        chat_helpers._DESYNC_REGROUND[dk] = newer
        return {"beatSeq": 12, "phase": "eviction"}   # our retry's own committed beat — now BEHIND the peer

    res = _run(chat_helpers.retry_progression_after_stale(
        "u", _stale_409(9), retry_fn_with_concurrent_advance, action="advanceGame"))
    assert res == {"beatSeq": 12, "phase": "eviction"}          # the retry still LANDED (returned as-is)
    assert chat_helpers.last_beat_seq("u") == 20, "(a) last-seen must NOT regress below the concurrent 20"
    assert chat_helpers._DESYNC_REGROUND.get(dk) == newer, "(b) the newer concurrent re-ground is preserved"


def test_landed_retry_no_interleave_clears_our_reground_and_refreshes(monkeypatch):
    """The normal (no concurrent flow) case is unchanged: a landed retry refreshes last-seen from `res`
    (monotonic ⇒ still applies a forward move) and clears OUR own reconcile's re-ground (we reconciled AND
    applied, so it is moot)."""
    _patch_reconcile_reads(monkeypatch, now=9)
    chat_helpers._LAST_BEAT_SEQ["u"] = 4
    dk = chat_helpers._desync_key("u")

    async def retry_fn(_fresh):
        return {"beatSeq": 12, "phase": "eviction"}

    res = _run(chat_helpers.retry_progression_after_stale("u", _stale_409(9), retry_fn, action="advanceGame"))
    assert res == {"beatSeq": 12, "phase": "eviction"}
    assert chat_helpers.last_beat_seq("u") == 12, "a forward move still refreshes last-seen"
    assert chat_helpers._DESYNC_REGROUND.get(dk) is None, "our own reconcile's re-ground is cleared"


def test_submit_decision_stale_retries_once_then_succeeds(monkeypatch):
    _patch_reconcile_reads(monkeypatch, now=9)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 4
    keys = []

    async def fake_submit(decision, expected_beat_seq=None, idempotency_key=None, user=None):
        keys.append(idempotency_key)
        if expected_beat_seq != 9:
            raise _stale_409(9)
        return {"beatSeq": 10}

    monkeypatch.setattr(orwell_engine, "submit_decision", fake_submit)
    out = _run(ti.do_submit_decision('{"kind":"deal-offer","vote":"accept"}', owner="owner"))
    assert out["exit_code"] == 0 and '"beatSeq": 10' in out["output"]
    assert len(keys) == 2 and keys[0] == keys[1], "the decision retry reuses the SAME (kind-keyed) key"
    assert chat_helpers.stale_beat_rejections() == 1


def test_turn_in_stale_retries_once_then_succeeds(monkeypatch):
    _patch_reconcile_reads(monkeypatch, now=9)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 4
    keys = []

    async def fake_turn_in(expected_beat_seq=None, idempotency_key=None, user=None):
        keys.append(idempotency_key)
        if expected_beat_seq != 9:
            raise _stale_409(9)
        return {"beatSeq": 10}

    monkeypatch.setattr(orwell_engine, "turn_in", fake_turn_in)
    out = _run(ti.do_turn_in("", owner="owner"))
    assert out["exit_code"] == 0 and '"beatSeq": 10' in out["output"]
    assert len(keys) == 2 and keys[0] == keys[1], "the turnIn retry reuses the SAME key (never re-ends the night)"
    assert chat_helpers.stale_beat_rejections() == 1


# ── a NON-stale EngineToolError is untouched (byte-identical to today's generic handler) ──────────

def test_non_stale_engine_error_is_not_retried(monkeypatch):
    """Back-compat: a non-stale engine error (a different 409, a 400) is NOT the retry path — it falls to
    the generic error handler exactly as before, with no reconcile and no stale count."""
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 4

    async def refuse(expected_beat_seq=None, idempotency_key=None, user=None):
        raise orwell_engine.EngineToolError("turn refused: integrity checkpoint failed", status=409)

    monkeypatch.setattr(orwell_engine, "advance_game", refuse)
    out = _run(ti.do_advance_game("{}", owner="owner"))
    assert out["exit_code"] == 1 and "engine error" in out["error"]
    assert chat_helpers.stale_beat_rejections() == 0, "a non-stale 409 is never reconciled/counted"


# ── source-pin: all three model-driven progression tools route stale-beats through the shared helper ─

def test_all_progression_tools_wired_through_the_shared_retry_helper():
    import os
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(base, "src", "tool_implementations.py"), encoding="utf-8") as fh:
        src = fh.read()
    # Pin EACH tool's OWN body (not a whole-file scan, which could false-pass if the action string
    # appeared elsewhere — e.g. a comment): slice from `def <func>(` to the next top-level `\ndef ` (or
    # EOF) and assert that body BOTH routes through the R3 helper AND carries its OWN matching action.
    for func_name, action in (("do_advance_game", "advanceGame"),
                              ("do_submit_decision", "submitDecision"),
                              ("do_turn_in", "turnIn")):
        start = src.index(f"def {func_name}(")
        # The next TOP-LEVEL function boundary — these impls are `async def`, so match BOTH a plain
        # `\ndef ` and an `\nasync def ` (column 0) and take whichever comes first (nested closures like
        # `async def _retry_advance` are INDENTED, so they never match). Slice to that boundary or EOF.
        cands = [i for i in (src.find("\ndef ", start + 1), src.find("\nasync def ", start + 1)) if i != -1]
        nxt = min(cands) if cands else -1
        body = src[start:] if nxt == -1 else src[start:nxt]
        assert "retry_progression_after_stale(owner, _e, " in body, (
            f"{func_name} must route its stale-beat through retry_progression_after_stale")
        assert f'action="{action}"' in body, (
            f"{func_name} must route its stale-beat through retry_progression_after_stale "
            f"with action={action}")
