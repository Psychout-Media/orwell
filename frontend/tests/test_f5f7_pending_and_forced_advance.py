"""F5 + F7 — two FE sync guards.

F5: the per-user pending-decision cache in src/orwell_engine.py must distinguish
    present-truthy (update) / present-null (clear) / absent (keep), so the status
    route's omit-fallback survives an old engine while a real "no pending" clears a
    stale card on reload; plus a clear-on-submit safety in the decision route.

F7: the last-resort FORCED advanceGame in src/agent_loop.py must RE-READ the live
    beat right before forcing and SKIP if the beat moved (a double-advance race),
    failing open to NOT forcing.
"""
import importlib
import re
from pathlib import Path

FE = Path(__file__).resolve().parents[1]
ENGINE_SRC = (FE / "src" / "orwell_engine.py").read_text(encoding="utf-8")
AGENT_SRC = (FE / "src" / "agent_loop.py").read_text(encoding="utf-8")
ROUTES_SRC = (FE / "routes" / "orwell_routes.py").read_text(encoding="utf-8")


# ── F5: remember_pending / last_pending / clear_pending semantics ─────────────

def _fresh_engine():
    oe = importlib.import_module("src.orwell_engine")
    oe._LAST_PENDING.clear()
    return oe


def test_f5_present_truthy_updates_cache():
    oe = _fresh_engine()
    oe.remember_pending({"pending": {"kind": "nominations", "options": []}}, user="u")
    assert oe.last_pending(user="u") == {"kind": "nominations", "options": []}


def test_f5_present_null_clears_cache():
    oe = _fresh_engine()
    oe.remember_pending({"pending": {"kind": "veto-decision"}}, user="u")
    assert oe.last_pending(user="u") is not None
    # An explicit `pending: null` is the engine saying "no pending" — it MUST clear.
    oe.remember_pending({"pending": None}, user="u")
    assert oe.last_pending(user="u") is None


def test_f5_absent_key_keeps_cache():
    oe = _fresh_engine()
    oe.remember_pending({"pending": {"kind": "eviction-vote"}}, user="u")
    # A view that OMITS `pending` entirely (an old engine) must KEEP the prior card so
    # the status route's omit-fallback still re-arms it.
    oe.remember_pending({"week": 3, "phase": "eviction"}, user="u")
    assert oe.last_pending(user="u") == {"kind": "eviction-vote"}


def test_f5_lifecycle_view_clears_even_when_pending_absent():
    """A restart-door result (a casting card / refused-restart GameStateView) carries no
    `pending` field but is passed to wipe the prior season's stale card — its lifecycle
    markers make an absent `pending` mean CLEAR, not keep."""
    oe = _fresh_engine()
    # createCharacter-style casting card.
    oe.remember_pending({"pending": {"kind": "juror-vote"}}, user="u")
    oe.remember_pending({"playerName": "P", "characterType": "x", "portraitPrompts": []}, user="u")
    assert oe.last_pending(user="u") is None
    # manageSandbox / GameStateView-style (has `started`).
    oe.remember_pending({"pending": {"kind": "nominations"}}, user="u")
    oe.remember_pending({"started": True, "player": None, "house": []}, user="u")
    assert oe.last_pending(user="u") is None


def test_f5_absent_vs_null_are_distinct():
    oe = _fresh_engine()
    oe.remember_pending({"pending": {"kind": "replacement"}}, user="u")
    oe.remember_pending({}, user="u")  # absent → keep
    assert oe.last_pending(user="u") is not None
    oe.remember_pending({"pending": None}, user="u")  # null → clear
    assert oe.last_pending(user="u") is None


def test_f5_per_user_isolation():
    oe = _fresh_engine()
    oe.remember_pending({"pending": {"kind": "nominations"}}, user="a")
    oe.remember_pending({"pending": {"kind": "juror-vote"}}, user="b")
    assert oe.last_pending(user="a")["kind"] == "nominations"
    assert oe.last_pending(user="b")["kind"] == "juror-vote"
    oe.remember_pending({"pending": None}, user="a")
    assert oe.last_pending(user="a") is None
    assert oe.last_pending(user="b")["kind"] == "juror-vote"  # b untouched


def test_f5_clear_pending_is_unconditional():
    oe = _fresh_engine()
    oe.remember_pending({"pending": {"kind": "nominations"}}, user="u")
    oe.clear_pending(user="u")
    assert oe.last_pending(user="u") is None
    # Idempotent — clearing an empty cache never raises.
    oe.clear_pending(user="u")
    oe.clear_pending(user="missing")


def test_f5_non_dict_view_is_ignored():
    oe = _fresh_engine()
    oe.remember_pending({"pending": {"kind": "nominations"}}, user="u")
    oe.remember_pending(None, user="u")  # not a dict → no-op (keeps)
    assert oe.last_pending(user="u") is not None


def test_f5_decision_route_clears_on_submit_omitting_pending(monkeypatch):
    """A successful submit whose result OMITS `pending` must CLEAR the stale card
    (the new keep-on-absent semantics would otherwise re-arm it on reload)."""
    oe = _fresh_engine()
    orwell_routes = importlib.import_module("routes.orwell_routes")
    oe.remember_pending({"pending": {"kind": "nominations"}}, user=None)

    async def fake_submit(decision, user=None, **_kw):
        return {"ok": True}  # NO `pending` key — the just-resolved card is gone
    monkeypatch.setattr(oe, "submit_decision", fake_submit)
    monkeypatch.setattr(orwell_routes, "_publish_game_updated", lambda *a, **k: None)

    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    client = TestClient(app)
    r = client.post("/api/orwell/decision", json={"kind": "nominations", "choice": ["npc:1", "npc:2"]})
    assert r.status_code == 200
    assert oe.last_pending(user=None) is None, "the resolved card must not survive the submit"


def test_f5_decision_route_rearms_next_pending(monkeypatch):
    """A submit that returns the NEXT pending re-arms the cache (normal advance)."""
    oe = _fresh_engine()
    orwell_routes = importlib.import_module("routes.orwell_routes")

    async def fake_submit(decision, user=None, **_kw):
        return {"pending": {"kind": "eviction-vote", "options": [{"id": "npc:3"}]}}
    monkeypatch.setattr(oe, "submit_decision", fake_submit)
    monkeypatch.setattr(orwell_routes, "_publish_game_updated", lambda *a, **k: None)

    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    client = TestClient(app)
    r = client.post("/api/orwell/decision", json={"kind": "nominations", "choice": ["npc:1", "npc:2"]})
    assert r.status_code == 200
    assert oe.last_pending(user=None)["kind"] == "eviction-vote"


# ── F7: the forced-advance re-read guard (source-level assertions) ────────────

def test_f7_captures_beat_key_at_read():
    assert "_beat_key_at_read" in AGENT_SRC, "the observed-beat identity must be captured at the state read"


def test_f7_rereads_before_forced_advance():
    """Right before the FORCED advanceGame, the loop must RE-READ game state and compare
    against the beat it observed stalled — only forcing if the beat hasn't moved."""
    # Isolate the forced-advance block (the L39(b) safety net past the last text rung).
    idx = AGENT_SRC.find("_ADVANCE_FORCE_LEVEL")
    # The block of interest is the one that calls _commit_advance_silently("forced stall ...").
    forced_idx = AGENT_SRC.find('_commit_advance_silently(f"forced stall L')
    assert forced_idx != -1, "the forced-advance call must exist"
    window = AGENT_SRC[max(0, forced_idx - 1200):forced_idx + 200]
    assert "get_game_state" in window, "a re-read must precede the forced advance"
    assert "_beat_key_at_read" in window, "the re-read must compare against the observed beat"
    # The force must be GATED behind the re-read result (a guard flag), not unconditional.
    assert re.search(r"_force_ok\s+and\s+await\s+_commit_advance_silently", AGENT_SRC), \
        "the forced advance must be gated behind the re-read guard"


def test_f7_fails_open_to_not_forcing():
    """If the re-read fails (exception) the guard must default to NOT forcing (avoid a
    double-advance), and a moved beat must skip the force."""
    forced_idx = AGENT_SRC.find('_commit_advance_silently(f"forced stall L')
    window = AGENT_SRC[max(0, forced_idx - 1200):forced_idx + 200]
    # Both the moved-beat path and the exception path set the guard False.
    assert window.count("_force_ok = False") >= 2, \
        "both a moved beat and a failed re-read must default to NOT forcing"
    assert "_beat_now != _beat_key_at_read" in window, "a changed beat must skip the force"


def test_f7_still_bounded_one_force_per_turn():
    # The per-turn advance-nudge cap is unchanged — the guard adds a skip, never a retry loop. Since ORW-228 the cap lives in the
    # pure gates (agent_gates.want_advance / want_drain_eviction); the loop passes them the per-turn counter and the cap.
    gates = (FE / "src" / "agent_gates.py").read_text(encoding="utf-8")
    assert AGENT_SRC.count("max_advance_nudges=_MAX_ADVANCE_NUDGES_PER_TURN") >= 2
    assert "turn_advance_nudges < max_advance_nudges" in gates
