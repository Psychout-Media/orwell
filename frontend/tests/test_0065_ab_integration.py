"""Feature 0065 (Parts A + B) — the per-turn INTEGRATION of the sync spine into the hot FE files.

The thin engine-client surface (``test_0065_engine_client.py``) proves the optional
``expected_beat_seq`` / ``idempotency_key`` params plumb through. This lane proves the FE actually
USES them on the progression calls IT issues:

  * a per-canonical-session ``_LAST_BEAT_SEQ`` map (mirroring ``_LAST_BEAT_SIG``) is refreshed from
    EVERY engine response that carries ``beatSeq`` — status/state reads AND every mutation's
    response — so within one turn (multiple engine calls, each bumping ``beatSeq``) the last-seen
    value tracks the engine and the FE never inflicts a self-409;
  * the FE-issued PROGRESSION calls (``_pre_resolve_npc_ceremony``'s advance, ``agent_loop``'s
    ``_commit_advance_silently``) carry the CURRENT last-seen ``beatSeq`` as the compare-and-swap
    token plus a freshly-minted ``idempotency_key``;
  * a stale 409 ``stale-beat`` is handled gracefully — last-seen refreshed, a re-ground stashed via
    the EXISTING desync mechanism, no exception escapes, the turn continues;
  * with the sync fields disabled/absent, behaviour is unchanged (the desync-spine regression).

Roles only; the engine client is faked so we capture the exact kwargs the FE passes.
"""
import asyncio
import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _clean_state():
    """Each test starts from a clean per-user sync state."""
    chat_helpers._LAST_BEAT_SEQ.clear()
    chat_helpers._LAST_BEAT_SIG.clear()
    chat_helpers._DESYNC_REGROUND.clear()
    chat_helpers.reset_stale_beat_rejections()
    yield
    chat_helpers._LAST_BEAT_SEQ.clear()
    chat_helpers._LAST_BEAT_SIG.clear()
    chat_helpers._DESYNC_REGROUND.clear()
    chat_helpers.reset_stale_beat_rejections()


# ── last-seen beatSeq tracking ─────────────────────────────────────────────── #

def test_refresh_beat_seq_updates_from_a_response_with_beatseq():
    chat_helpers._refresh_beat_seq("u", {"beatSeq": 12, "phase": "eviction"})
    assert chat_helpers.last_beat_seq("u") == 12


def test_refresh_beat_seq_ignores_a_response_without_beatseq():
    chat_helpers._refresh_beat_seq("u", {"phase": "social"})
    assert chat_helpers.last_beat_seq("u") is None


def test_refresh_beat_seq_keeps_zero_a_legitimate_token():
    # beatSeq 0 is a brand-new sandbox — must be tracked, not treated as falsy/absent.
    chat_helpers._refresh_beat_seq("u", {"beatSeq": 0})
    assert chat_helpers.last_beat_seq("u") == 0


def test_refresh_beat_seq_takes_the_last_carrying_response():
    # Within a turn the FE makes several engine calls; the LAST one to carry beatSeq wins.
    chat_helpers._refresh_beat_seq("u", {"beatSeq": 3}, {"phase": "x"}, {"beatSeq": 5})
    assert chat_helpers.last_beat_seq("u") == 5


def test_refresh_beat_seq_is_fail_safe_on_non_dicts():
    chat_helpers._refresh_beat_seq("u", None, "x", 7, {"beatSeq": 9})
    assert chat_helpers.last_beat_seq("u") == 9


def test_capture_beat_signature_refreshes_last_seen(monkeypatch):
    """A status/state READ (every framing turn) carries beatSeq → last-seen tracks it, so the next
    progression call attaches the FRESH token."""
    async def fake_status(user=None):
        return {"week": 2, "phase": "hoh-competition", "veto": {}, "pending": None, "beatSeq": 8}

    async def fake_state(user=None):
        return {"week": 2, "phase": "hoh-competition", "finished": False, "house": [], "beatSeq": 8}

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    _run(chat_helpers._capture_beat_signature("u"))
    assert chat_helpers.last_beat_seq("u") == 8


# ── progression calls attach the CAS token + a minted idempotency key ───────── #

def test_pre_resolve_attaches_current_beat_seq_and_idempotency_key(monkeypatch):
    """The FE-issued advance in _pre_resolve_npc_ceremony carries the current last-seen beatSeq and a
    minted idempotency key, and refreshes last-seen from the advance response."""
    chat_helpers._LAST_BEAT_SEQ["u"] = 4
    captured = {}
    seq = {"v": 4}  # the engine's current beatSeq; the advance bumps it to 5

    async def fake_status(user=None):
        return {"phase": "nominations", "pending": None, "veto": {}, "beatSeq": seq["v"]}

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        captured["expected_beat_seq"] = expected_beat_seq
        captured["idempotency_key"] = idempotency_key
        seq["v"] = 5  # the beat committed — every subsequent read now reports 5
        return {"event": {"content": "nominations"}, "beatSeq": 5}

    async def fake_state(user=None, **kw):
        # the post-advance state refetch (chat_helpers._fetch_game_state path)
        return {"phase": "veto-competition", "week": 1, "beatSeq": seq["v"]}

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    # No social runway armed → the pre-resolve drives the beat for real.
    chat_helpers.clear_social_runway("u")

    _run(chat_helpers._pre_resolve_npc_ceremony("u", {"phase": "nominations", "week": 1},
                                                retry=False, player_msg="let's see the noms"))
    assert captured["expected_beat_seq"] == 4              # the current last-seen token
    assert isinstance(captured["idempotency_key"], str) and captured["idempotency_key"]
    # last-seen refreshed FROM the advance response (5), not stuck at the pre-advance 4 → no self-409.
    assert chat_helpers.last_beat_seq("u") == 5


def test_normal_multicall_turn_never_self_409s(monkeypatch):
    """A normal sequential turn (read → record → advance) issues progression with the CURRENT beatSeq
    and never trips a stale rejection — because last-seen refreshes from every response."""
    seq = {"v": 10}

    async def fake_status(user=None):
        return {"phase": "nominations", "pending": None, "veto": {}, "beatSeq": seq["v"]}

    async def fake_state(user=None, **kw):
        return {"phase": "nominations", "week": 1, "finished": False, "house": [], "beatSeq": seq["v"]}

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        # The engine only 409s when the token is behind; a fresh token must match.
        if expected_beat_seq is not None and expected_beat_seq != seq["v"]:
            raise orwell_engine.EngineToolError(
                f"stale write refused — expected beatSeq is behind the current board (now {seq['v']})",
                status=409)
        seq["v"] += 1
        return {"event": {"content": "noms"}, "beatSeq": seq["v"]}

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    chat_helpers.clear_social_runway("u")

    # A read first (framing) seeds last-seen, then the advance uses the fresh token.
    _run(chat_helpers._capture_beat_signature("u"))
    _run(chat_helpers._pre_resolve_npc_ceremony("u", {"phase": "nominations", "week": 1},
                                                retry=False, player_msg="let's go"))
    assert chat_helpers.stale_beat_rejections() == 0


# ── the 409 stale-beat path reconciles gracefully ──────────────────────────── #

def test_is_stale_beat_error_detects_the_409():
    e = orwell_engine.EngineToolError(
        "stale write refused — expected beatSeq is behind the current board (now 42); re-ground and retry",
        status=409)
    assert chat_helpers._is_stale_beat_error(e) is True


def test_is_stale_beat_error_ignores_other_409s_and_errors():
    assert chat_helpers._is_stale_beat_error(
        orwell_engine.EngineToolError("turn refused", status=409)) is False
    assert chat_helpers._is_stale_beat_error(
        orwell_engine.EngineToolError("bad args", status=400)) is False
    assert chat_helpers._is_stale_beat_error(RuntimeError("boom")) is False


def test_handle_stale_beat_refreshes_seq_from_message_and_stashes_reground(monkeypatch):
    """A stale 409 refreshes last-seen from the (now N) in the message, re-grounds via the existing
    desync mechanism, counts the rejection, and never raises."""
    # the board re-read on reconcile
    async def fake_status(user=None):
        return {"week": 6, "phase": "eviction", "pending": None, "veto": {}, "beatSeq": 42}

    async def fake_state(user=None, **kw):
        return {"week": 6, "phase": "eviction", "finished": False, "house": [], "beatSeq": 42}

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)

    exc = orwell_engine.EngineToolError(
        "stale write refused — expected beatSeq is behind the current board (now 42); re-ground and retry",
        status=409)
    _run(chat_helpers._handle_stale_beat("u", exc))

    assert chat_helpers.last_beat_seq("u") == 42                 # parsed from the message
    assert "u" in chat_helpers._DESYNC_REGROUND                  # re-ground stashed for next turn
    assert "RE-GROUND" in chat_helpers._DESYNC_REGROUND["u"]
    assert chat_helpers.stale_beat_rejections() == 1             # counted for the ledger hook


def test_pre_resolve_reattempts_then_swallows_a_persistent_stale_409(monkeypatch):
    """LANE A S1a (at-least-once) updated the old reconcile-and-SWALLOW contract: the pre-resolve advance
    hitting a stale 409 now RE-FIRES once against the reconciled beatSeq (fresh CAS token, SAME idempotency
    key). A PERSISTENT 409 is reconciled BOTH times (2 rejections), arms the S1b forced-advance escalation,
    and STILL never lets the exception escape — the turn continues, framed against the moved board."""
    chat_helpers._ADVANCE_ESCALATION.clear()
    chat_helpers._LAST_BEAT_SEQ["u"] = 4  # stale token
    idem_keys = []

    async def fake_status(user=None):
        return {"phase": "nominations", "pending": None, "veto": {}, "beatSeq": 9}

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        idem_keys.append(idempotency_key)
        raise orwell_engine.EngineToolError(
            "stale write refused — expected beatSeq is behind the current board (now 9); re-ground and retry",
            status=409)

    # Finding 8: the reconciled LIVE state is DISTINCT from the stale input snapshot the caller passed —
    # after the double stale-409 the function must return THIS live board, not the input.
    async def fake_state(user=None, **kw):
        return {"phase": "veto", "week": 2, "finished": False, "house": [], "beatSeq": 11}

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    chat_helpers.clear_social_runway("u")

    out = _run(chat_helpers._pre_resolve_npc_ceremony("u", {"phase": "nominations", "week": 1},
                                                      retry=False, player_msg="let's go"))
    # No exception escaped; the RECONCILED LIVE state is returned (never the stale input), so the turn
    # continues framed against where the board actually is (finding 8).
    assert isinstance(out, dict)
    assert out.get("phase") == "veto" and out.get("week") == 2   # the live board, not the input snapshot
    assert len(idem_keys) == 2 and idem_keys[0] == idem_keys[1]  # re-fired once, SAME idempotency key
    assert chat_helpers.stale_beat_rejections() == 2            # both 409s reconciled/counted
    assert chat_helpers.last_beat_seq("u") == 11                 # refreshed off the reconciled live read
    assert "u" in chat_helpers._DESYNC_REGROUND                  # next turn reconciles
    assert chat_helpers.advance_escalation_armed("u")            # S1b escalation armed after the double


# ── idempotency-key minting ────────────────────────────────────────────────── #

def test_minted_keys_are_distinct_per_logical_action():
    a = chat_helpers._mint_idempotency_key()
    b = chat_helpers._mint_idempotency_key()
    assert a and b and a != b


# ── regression: the desync spine is unchanged when sync fields are absent ───── #

def test_agent_loop_progression_carries_sync_fields_source_pin():
    """The agent-loop FE-issued advance (_commit_advance_silently) threads the CAS token + a minted
    idempotency key, and reconciles a stale 409 via chat_helpers (source-pin, like the existing spine
    tests)."""
    import os
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(base, "src", "agent_loop.py"), encoding="utf-8") as fh:
        src = fh.read()
    assert "expected_beat_seq=" in src
    assert "idempotency_key=" in src
    assert "_mint_idempotency_key" in src
    # the stale-beat reconcile is routed through the existing chat_helpers spine
    assert "_handle_stale_beat" in src or "_is_stale_beat_error" in src


def test_clear_social_runway_forgets_a_paused_competition():
    from routes import chat_helpers
    key = chat_helpers._runway_key("u-pause")
    chat_helpers._COMP_PAUSED[key] = "1:veto-competition"
    chat_helpers._COMP_CONT[key] = True
    chat_helpers._COMP_STEER_BASE[key] = "x"
    chat_helpers.clear_social_runway("u-pause")
    assert key not in chat_helpers._COMP_PAUSED and key not in chat_helpers._COMP_CONT and key not in chat_helpers._COMP_STEER_BASE
