"""Two-window sync fix — regression gates for the #1 ship-blocker cluster (CON-1..5).

These lock in the specific roots the audit found: the 0065 beatSeq CAS spine was fully INERT under
auth-off (CON-1), the model-driven + decision-card progression paths carried no idempotency/CAS
tokens and never refreshed last-seen (CON-2/CON-3/CON-4), and the post-turn desync check could stash
a spurious re-ground when a concurrent peer advanced the board (CON-5).
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


# ── CON-1 — the beatSeq spine tracks under auth-off (user=None) ─────────────────────────────── #

def test_con1_beat_seq_tracks_under_auth_off_with_a_bound_canonical_session(monkeypatch):
    """Under AUTH_ENABLED=false the FE user is None; before the fix `last_beat_seq(None)` was always
    None so every progression call sent expected_beat_seq=None (no CAS). With a canonical session bound
    it must now track under that session key."""
    from src import orwell_game_session
    monkeypatch.setattr(orwell_game_session, "get_game_session", lambda user=None: "sess-xyz")
    chat_helpers._refresh_beat_seq(None, {"beatSeq": 11, "phase": "veto-competition"})
    assert chat_helpers.last_beat_seq(None) == 11  # was None before CON-1
    # a later response wins (read-your-own-writes across a multi-call turn)
    chat_helpers._refresh_beat_seq(None, {"beatSeq": 12})
    assert chat_helpers.last_beat_seq(None) == 12


def test_con1_real_user_still_keys_on_its_own_identity(monkeypatch):
    """Cross-user isolation is unweakened: a truthy user keys on itself, NEVER the session fallback."""
    from src import orwell_game_session
    monkeypatch.setattr(orwell_game_session, "get_game_session", lambda user=None: "sess-shared")
    chat_helpers._refresh_beat_seq("alice", {"beatSeq": 5})
    chat_helpers._refresh_beat_seq("bob", {"beatSeq": 9})
    assert chat_helpers.last_beat_seq("alice") == 5
    assert chat_helpers.last_beat_seq("bob") == 9
    assert chat_helpers._beat_seq_key("alice") == "alice"


# ── CON-2 / CON-3 — the model-driven progression tools carry the sync-spine tokens + refresh ─── #

def test_con2_do_advance_game_attaches_idempotency_key_and_expected_beat_seq_and_refreshes(monkeypatch):
    from src import tool_implementations as ti
    from src import orwell_engine
    captured = {}

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        captured["expected_beat_seq"] = expected_beat_seq
        captured["idempotency_key"] = idempotency_key
        return {"beatSeq": 43, "phase": "eviction"}

    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 42

    out = _run(ti.do_advance_game("{}", owner="owner"))
    assert out["exit_code"] == 0
    assert captured["expected_beat_seq"] == 42                 # the current last-seen token (CON-2)
    assert isinstance(captured["idempotency_key"], str) and captured["idempotency_key"]  # a key is attached
    assert chat_helpers.last_beat_seq("owner") == 43           # refreshed from the response (CON-3)


def test_con2_advance_key_is_stable_across_a_lost_response_retry(monkeypatch):
    """The retry case: when the engine committed but the FE never saw the response (last-seen unchanged),
    a re-invocation mints the SAME key so the engine dedups instead of double-advancing."""
    from src import tool_implementations as ti
    from src import orwell_engine
    seen = []

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        seen.append(idempotency_key)
        raise RuntimeError("socket timeout")  # response lost — do_advance_game must NOT refresh

    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 42
    _run(ti.do_advance_game("{}", owner="owner"))  # first attempt (lost)
    _run(ti.do_advance_game("{}", owner="owner"))  # the retry (last-seen still 42)
    assert seen[0] == seen[1]                       # SAME key ⇒ the engine replays, never double-advances


def test_con2_do_turn_in_attaches_idempotency_key_and_expected_beat_seq_and_refreshes(monkeypatch):
    # #1385 / ADR 0006: turnIn is a mutating PROGRESSION, so — like advanceGame/submitDecision — it must
    # attach the CAS token + an at-most-once key and refresh last-seen, or a retried/duplicate model call
    # re-ends the night and re-stamps the rest penalty.
    from src import tool_implementations as ti
    from src import orwell_engine
    captured = {}

    async def fake_turn_in(expected_beat_seq=None, idempotency_key=None, user=None):
        captured["expected_beat_seq"] = expected_beat_seq
        captured["idempotency_key"] = idempotency_key
        return {"beatSeq": 51, "phase": "hoh-competition"}

    monkeypatch.setattr(orwell_engine, "turn_in", fake_turn_in)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 50

    out = _run(ti.do_turn_in("", owner="owner"))
    assert out["exit_code"] == 0
    assert captured["expected_beat_seq"] == 50                 # the current last-seen token (CON-2)
    assert isinstance(captured["idempotency_key"], str) and captured["idempotency_key"]  # a key is attached
    assert chat_helpers.last_beat_seq("owner") == 51           # refreshed from the response (CON-3)


def test_con2_turn_in_key_is_stable_across_a_lost_response_retry(monkeypatch):
    """The exact erased-rest-penalty guard: when the engine committed the night-end but the FE never saw
    the response (last-seen unchanged), a re-invocation mints the SAME key, so the engine REPLAYS the first
    result instead of re-ending the night (which would re-stamp lastSleepDepth from the reset wake hour)."""
    from src import tool_implementations as ti
    from src import orwell_engine
    seen = []

    async def fake_turn_in(expected_beat_seq=None, idempotency_key=None, user=None):
        seen.append(idempotency_key)
        raise RuntimeError("socket timeout")  # response lost — do_turn_in must NOT refresh

    monkeypatch.setattr(orwell_engine, "turn_in", fake_turn_in)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 50
    _run(ti.do_turn_in("", owner="owner"))  # first attempt (lost)
    _run(ti.do_turn_in("", owner="owner"))  # the retry (last-seen still 50)
    assert seen[0] == seen[1]                # SAME key ⇒ the engine replays, never re-ends the night twice


def test_con2_do_submit_decision_attaches_tokens_and_refreshes(monkeypatch):
    from src import tool_implementations as ti
    from src import orwell_engine
    captured = {}

    async def fake_submit(decision, expected_beat_seq=None, idempotency_key=None, user=None):
        captured["decision"] = decision
        captured["expected_beat_seq"] = expected_beat_seq
        captured["idempotency_key"] = idempotency_key
        return {"beatSeq": 8}

    monkeypatch.setattr(orwell_engine, "submit_decision", fake_submit)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 7

    out = _run(ti.do_submit_decision('{"kind":"deal-offer","vote":"accept"}', owner="owner"))
    assert out["exit_code"] == 0
    assert captured["expected_beat_seq"] == 7
    assert isinstance(captured["idempotency_key"], str) and "deal-offer" in captured["idempotency_key"]
    assert chat_helpers.last_beat_seq("owner") == 8


def test_con2_submit_key_differs_per_kind_at_the_same_beat(monkeypatch):
    """Sequential same-beat decisions of different kinds must NOT collide (comp-round vs a vote)."""
    from src import tool_implementations as ti
    from src import orwell_engine
    keys = []

    async def fake_submit(decision, expected_beat_seq=None, idempotency_key=None, user=None):
        keys.append(idempotency_key)
        return {"beatSeq": 7}

    monkeypatch.setattr(orwell_engine, "submit_decision", fake_submit)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 7
    _run(ti.do_submit_decision('{"kind":"comp-intent","intent":"compete"}', owner="owner"))
    _run(ti.do_submit_decision('{"kind":"deal-offer","vote":"accept"}', owner="owner"))
    assert keys[0] != keys[1]


# ── CON-4 — the decision-card route is wired into the sync spine ────────────────────────────── #

def test_con4_decision_route_forwards_expected_beat_seq_and_idempotency_key():
    """Source gate mirroring the CLAUDE.md write-back template: the /decision route must thread both
    sync-spine fields (and refresh last-seen) rather than posting engine-direct with neither."""
    import inspect
    from routes import orwell_routes
    src = inspect.getsource(orwell_routes)
    assert "expected_beat_seq=_dec_ebs" in src
    assert "idempotency_key=_dec_ik" in src
    assert "idempotency_key" in src and 'decision.pop("idempotency_key"' in src  # not passed as a decision field
    assert "_refresh_beat_seq(user" in src


# ── CON-5 — the post-turn desync check skips a peer-advanced board ──────────────────────────── #

def test_con5_desync_check_skips_when_a_peer_advanced_the_board(monkeypatch):
    """This turn progressed NOTHING, yet the board moved (a concurrent peer window advanced it) — the
    per-turn baseline is contaminated, so no spurious re-ground is stashed."""
    user = None
    chat_helpers._LAST_BEAT_SIG[chat_helpers._desync_key(user)] = {
        "week": 1, "phase": "veto-competition", "evicted": 3, "finished": False}

    async def fake_capture(u):
        return {"week": 1, "phase": "eviction", "evicted": 3, "finished": False}  # phase MOVED (peer)

    monkeypatch.setattr(chat_helpers, "_capture_beat_signature", fake_capture)
    # A narration that WOULD normally trip the outcome guard, but this turn made no progression call.
    _run(chat_helpers.record_post_turn_desync_check(user, "Someone has been evicted from the house.",
                                                    this_turn_progressed=False))
    assert chat_helpers._DESYNC_REGROUND.get(chat_helpers._desync_key(user)) is None  # skipped


def test_con5_desync_check_still_runs_when_this_turn_progressed(monkeypatch):
    """The guard NEVER disables the true positive: a turn that itself progressed still gets checked."""
    user = None
    chat_helpers._LAST_BEAT_SIG[chat_helpers._desync_key(user)] = {
        "week": 1, "phase": "veto-competition", "evicted": 3, "finished": False}

    async def fake_capture(u):
        # board UNCHANGED but the narration claims an eviction ⇒ the classic desync must still fire
        return {"week": 1, "phase": "veto-competition", "evicted": 3, "finished": False,
                "evictedNames": []}

    monkeypatch.setattr(chat_helpers, "_capture_beat_signature", fake_capture)
    _run(chat_helpers.record_post_turn_desync_check(
        user, "Wade has been evicted from the Big Brother house by a vote of 5 to 2.",
        this_turn_progressed=True))
    # a real narrated-but-uncommitted eviction still stashes a re-ground (unchanged behavior)
    assert chat_helpers._DESYNC_REGROUND.get(chat_helpers._desync_key(user)) is not None
