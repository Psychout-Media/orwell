"""#891 finding F1 (P0) — universal idempotencyKey + expectedBeatSeq on the MODEL-DRIVEN progression path.

Context: the engine has the 0065 sync spine (idempotency cache + `beatSeq`/`expectedBeatSeq`/
`idempotencyKey` compare-and-swap), but for a long time the FE attached those tokens ONLY on its own
belts (`agent_loop.py`) — never on the path the LLM itself drives (`do_advance_game`/`do_submit_decision`
in `tool_implementations.py`), which is the COMMON case. A retried POST on a flaky socket could then
double-advance / double-submit (skip a staged eviction ballot, double-crown a finale beat), because
at-most-once was unused exactly where progression fires most.

The fix (`_model_progression_cas` + `_refresh_after_model_progression`) attaches a retry-stable
idempotency key and the FE's last-seen `expectedBeatSeq` on EVERY model-dispatched progression call and
refreshes last-seen from the response. These tests are the issue-#891-traceable regression guard for
that contract on the model path specifically — a refactor that drops the CAS wiring from the do_* impls
must go red here. (The broader CON-1..5 two-window cluster is pinned in `test_two_window_sync_fix.py`;
this file is the focused, named F1 pin.)

The invariant these lock:
  • the model-driven advanceGame/submitDecision/turnIn path is NEVER a bare unguarded engine call —
    with a known last-seen beatSeq, BOTH tokens reach the engine;
  • the idempotency key is RETRY-STABLE (lost-response retry ⇒ same key ⇒ engine replays) but FRESH on a
    genuine next advance (last-seen moved ⇒ new key);
  • expectedBeatSeq is sourced from the SHARED FE beatSeq store (`chat_helpers._LAST_BEAT_SEQ`), not a
    parallel mechanism;
  • a stale-beat 409 refreshes beatSeq and RE-FIRES the call ONCE against the reconciled token (R3 /
    #1659), reusing the SAME idempotency key so the engine dedups — never a second, unintended advance;
    a persistent stale then reconciles to the CURRENT board.
"""
import asyncio
import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _clean():
    chat_helpers._LAST_BEAT_SEQ.clear()
    chat_helpers._LAST_BEAT_SIG.clear()
    chat_helpers._DESYNC_REGROUND.clear()
    yield
    chat_helpers._LAST_BEAT_SEQ.clear()
    chat_helpers._LAST_BEAT_SIG.clear()
    chat_helpers._DESYNC_REGROUND.clear()


# ── F1 core — the model-driven path is never a bare, unguarded progression call ──────────────── #

def test_f1_model_advance_is_never_a_bare_call_when_a_beat_seq_is_known(monkeypatch):
    """The regression this issue exists for: with a known last-seen beatSeq, the LLM-dispatched
    advanceGame MUST carry BOTH sync-spine tokens (not None) — otherwise a retried POST double-advances."""
    from src import tool_implementations as ti
    from src import orwell_engine
    seen = {}

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        seen["expected_beat_seq"] = expected_beat_seq
        seen["idempotency_key"] = idempotency_key
        return {"beatSeq": 100}

    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 99

    out = _run(ti.do_advance_game("{}", owner="owner"))
    assert out["exit_code"] == 0
    # the F1 assertion: NEITHER token is the old unguarded None
    assert seen["expected_beat_seq"] == 99
    assert isinstance(seen["idempotency_key"], str) and seen["idempotency_key"]


def test_f1_expected_beat_seq_comes_from_the_shared_fe_beat_seq_store(monkeypatch):
    """expectedBeatSeq must be sourced from the SAME FE last-seen store the belts use
    (`chat_helpers._LAST_BEAT_SEQ` via `last_beat_seq`), not a parallel counter — so mutating that store
    is what changes the token the model path sends."""
    from src import tool_implementations as ti
    from src import orwell_engine
    tokens = []

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        tokens.append(expected_beat_seq)
        # the engine's response is what the FE tracks next — but DON'T bump here; the test drives the store
        return {}

    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)

    chat_helpers._LAST_BEAT_SEQ[chat_helpers._beat_seq_key("owner")] = 3
    _run(ti.do_advance_game("{}", owner="owner"))
    chat_helpers._LAST_BEAT_SEQ[chat_helpers._beat_seq_key("owner")] = 4
    _run(ti.do_advance_game("{}", owner="owner"))
    assert tokens == [3, 4]  # the model path reads the shared store, verbatim


def test_f1_advance_refreshes_last_seen_from_the_response(monkeypatch):
    """After the MODEL advances the engine, the FE's last-seen must track the new beatSeq so a later
    FE-issued CAS call the same turn never self-409s (CON-3)."""
    from src import tool_implementations as ti
    from src import orwell_engine

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        return {"beatSeq": 77}

    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 76
    _run(ti.do_advance_game("{}", owner="owner"))
    assert chat_helpers.last_beat_seq("owner") == 77


# ── F1 retry-stability — a lost-response retry reuses the key; a genuine advance mints a fresh one ─ #

def test_f1_advance_key_is_retry_stable_but_fresh_on_a_genuine_next_advance(monkeypatch):
    """The at-most-once contract: the key is derived from the FE's last-seen beat, so EVERY attempt to
    'advance from beat N' — including the retry that finally commits — shares ONE key (the engine
    replays instead of double-advancing). Only AFTER a commit moves last-seen to N+1 does the next
    logical advance ('advance from beat N+1') mint a FRESH key. That is 'at-most-once per intended
    action', not 'once ever'."""
    from src import tool_implementations as ti
    from src import orwell_engine
    keys = []
    outcome = {"raise": True, "next": 43}

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        keys.append(idempotency_key)
        if outcome["raise"]:
            raise RuntimeError("socket timeout")  # response lost — last-seen stays put, no refresh
        return {"beatSeq": outcome["next"]}       # a commit — do_advance_game refreshes last-seen

    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 42

    _run(ti.do_advance_game("{}", owner="owner"))        # attempt 1: lost (key derived from beat 42)
    _run(ti.do_advance_game("{}", owner="owner"))        # retry: last-seen still 42 ⇒ SAME key
    assert keys[0] == keys[1]

    outcome["raise"] = False                              # the retry finally commits (still 'from 42')
    _run(ti.do_advance_game("{}", owner="owner"))         # last-seen still 42 here ⇒ SAME key, then →43
    assert keys[2] == keys[0]                             # the committing retry shares the at-most-once key
    assert chat_helpers.last_beat_seq("owner") == 43      # commit refreshed last-seen

    _run(ti.do_advance_game("{}", owner="owner"))         # genuine NEXT advance ('from 43') ⇒ FRESH key
    assert keys[3] != keys[2]


# ── F1 submitDecision — same contract, decision-kind-scoped key ──────────────────────────────── #

def test_f1_model_submit_decision_attaches_both_tokens_and_scopes_key_by_kind(monkeypatch):
    """The other model-driven progression lever: submitDecision carries both tokens, the key embeds the
    DECISION KIND (so sequential same-beat decisions of different kinds — comp-round vs a vote — never
    collide into one at-most-once slot), and last-seen refreshes from the response."""
    from src import tool_implementations as ti
    from src import orwell_engine
    captured = {}

    async def fake_submit(decision, expected_beat_seq=None, idempotency_key=None, user=None):
        captured["expected_beat_seq"] = expected_beat_seq
        captured["idempotency_key"] = idempotency_key
        return {"beatSeq": 13}

    monkeypatch.setattr(orwell_engine, "submit_decision", fake_submit)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 12

    out = _run(ti.do_submit_decision('{"kind":"deal-offer","vote":"accept"}', owner="owner"))
    assert out["exit_code"] == 0
    assert captured["expected_beat_seq"] == 12
    assert isinstance(captured["idempotency_key"], str) and "deal-offer" in captured["idempotency_key"]
    assert chat_helpers.last_beat_seq("owner") == 13


# ── F1 concurrency — a stale-beat 409 reconciles to the current board, never a second advance ── #

def test_f1_stale_beat_409_reconciles_to_current_board_not_a_second_advance(monkeypatch):
    """The no-double-APPLY guard on the MODEL path under R3 (#1659): if a concurrent peer already moved
    the board, the engine refuses the model's advance with 409 `stale-beat`. R3 (owner ruling 2026-07-16
    — "StaleBeatError is a dead end") now refreshes beatSeq and RE-FIRES the advance ONCE against the
    reconciled token rather than dead-ending, but reuses the SAME idempotency key so the engine's at-most-
    once dedups a genuine double-apply — never a second UNINTENDED advance. When the board keeps moving
    (this test forces a persistent stale), the FE reconciles to the CURRENT state via the desync spine."""
    from src import tool_implementations as ti
    from src import orwell_engine
    advance_calls = []
    state_reads = []

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        advance_calls.append(idempotency_key)
        raise orwell_engine.EngineToolError(
            "stale write refused (now 30)", status=409, code="stale-beat", beat_seq=30)

    async def fake_get_state(user=None):
        state_reads.append(user)
        return {"beatSeq": 30, "phase": "eviction"}

    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_get_state)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 20

    out = _run(ti.do_advance_game("{}", owner="owner"))
    assert out["exit_code"] == 0                       # reconciled, not an error surfaced to the player
    # R3: ONE bounded refresh+retry (the initial attempt + exactly one re-fire) — never a loop.
    assert len(advance_calls) == 2
    assert advance_calls[0] == advance_calls[1]        # SAME idempotency key ⇒ the engine can never double-apply
    assert state_reads == ["owner"]                    # a persistent stale reconciles to the CURRENT board
    assert chat_helpers.last_beat_seq("owner") == 30   # last-seen reconciled to the peer-moved beat
