"""Instant cross-window HUD parity — feature 0064 §B/D / ship-gate F5 (the status/gadget half).

The 0064 server-push (`game-updated`) fired from only THREE `orwell_routes.py` endpoints (decision +
the two self-eviction routes) — NEVER from the chat-turn path. So a chat turn whose agent-loop tools
mutate engine state (`markHouseguestMet`, `advanceGame`, `recordInteraction`, …) refreshed only the
SENDER's own HUD (client-side, via the g15 dispatcher); peer windows got no push and stayed stale
until their 20–30s poll (observed live: window A "1 of 15 met", window B "0 of 15").

These gates pin the fix at the source level:
  (a) `publish_game_updated_after_turn` pushes IFF the turn committed a mutation (a game-engine write
      tool ran, or the user's beatSeq advanced) and NO-OPS on a pure OOC/no-op turn (no noise);
  (b) it routes through the shared, Vault-free `orwell_game_session.publish_game_updated` helper
      (a session id + the bare change-type only — no state body);
  (c) the chat-turn DONE seam in `chat_routes.py` calls it on a game turn (source-pin), and chains a
      second push onto the E22/0055 `recordInteraction` fallback task.

No names; role-only. Mirrors `test_617_background_writeback_push.py`.
"""

import importlib
import re
from pathlib import Path


def _ch():
    return importlib.import_module("routes.chat_helpers")


# ── (a)+(b): the helper pushes only on an actual mutation, through the shared push ──────────────

def test_push_on_game_engine_write_tool(monkeypatch):
    ch = _ch()
    gs = importlib.import_module("src.orwell_game_session")
    pushed = []
    monkeypatch.setattr(gs, "publish_game_updated", lambda user: pushed.append(user))

    # A game-engine write tool ran this turn ⇒ mutation ⇒ push (even if beatSeq is unknown).
    out = ch.publish_game_updated_after_turn("u", None, ["advanceGame"])
    assert out is True
    assert pushed == ["u"]


def test_push_on_beat_seq_advance(monkeypatch):
    """The FE error-correction belts (markHouseguestMet auto-belt, forced advanceGame) mutate WITHOUT
    the model naming a write tool — caught by the beatSeq advancing over the turn."""
    ch = _ch()
    gs = importlib.import_module("src.orwell_game_session")
    pushed = []
    monkeypatch.setattr(gs, "publish_game_updated", lambda user: pushed.append(user))

    ch._LAST_BEAT_SEQ["u"] = 5  # current beatSeq AFTER the turn
    try:
        out = ch.publish_game_updated_after_turn("u", 4, [])  # before=4, after=5, no named write tool
    finally:
        ch._LAST_BEAT_SEQ.pop("u", None)
    assert out is True
    assert pushed == ["u"]


def test_no_push_on_no_op_turn(monkeypatch):
    """A pure OOC / no-op turn: no write tool, beatSeq unchanged ⇒ no spurious peer push."""
    ch = _ch()
    gs = importlib.import_module("src.orwell_game_session")
    pushed = []
    monkeypatch.setattr(gs, "publish_game_updated", lambda user: pushed.append(user))

    ch._LAST_BEAT_SEQ["u"] = 4
    try:
        out = ch.publish_game_updated_after_turn("u", 4, ["getVisibleStateFor"])  # read-only, no advance
    finally:
        ch._LAST_BEAT_SEQ.pop("u", None)
    assert out is False
    assert pushed == []


def test_no_push_when_beat_seq_unknown_and_no_write_tool(monkeypatch):
    ch = _ch()
    gs = importlib.import_module("src.orwell_game_session")
    pushed = []
    monkeypatch.setattr(gs, "publish_game_updated", lambda user: pushed.append(user))
    ch._LAST_BEAT_SEQ.pop("u", None)  # unknown before AND after
    out = ch.publish_game_updated_after_turn("u", None, [])
    assert out is False
    assert pushed == []


def test_helper_is_fail_soft(monkeypatch):
    ch = _ch()
    gs = importlib.import_module("src.orwell_game_session")

    def boom(*a, **k):
        raise RuntimeError("event bus down")

    monkeypatch.setattr(gs, "publish_game_updated", boom)
    # A mutation occurred, but the push raises — must be swallowed (polling is the correctness floor).
    out = ch.publish_game_updated_after_turn("u", None, ["recordInteraction"])
    assert out is False  # swallowed → reported as "did not push", never raised


# ── (c): source-pin — the chat-turn DONE seam wires the push on a game turn ──────────────────────

_CHAT_ROUTES = Path(__file__).resolve().parents[1] / "routes" / "chat_routes.py"


def test_chat_routes_publishes_game_updated_on_game_turn():
    """The chat-turn path MUST fire the 0064 peer push when a game turn settles (the gap this closes).
    Pinned at source so a refactor that drops the call trips this gate (the live mirror has no key-free
    unit harness for the full streaming DONE branch)."""
    src = _CHAT_ROUTES.read_text(encoding="utf-8")
    assert "publish_game_updated_after_turn" in src, \
        "chat_routes.py must call publish_game_updated_after_turn so a game turn pushes game-updated to peers"
    # It must be wired inside the game-active DONE branch (alongside the E22 fallback), not stranded.
    assert re.search(r"ensure_turn_recorded", src), "the E22 fallback seam should still exist"
    # The fallback's own (async) mutation also pushes — chained off its task.
    assert "add_done_callback" in src and "publish_game_updated" in src, \
        "the E22/0055 recordInteraction fallback must also push game-updated when it records"


def test_chat_routes_imports_the_push_helper():
    src = _CHAT_ROUTES.read_text(encoding="utf-8")
    assert "publish_game_updated_after_turn" in src and "last_beat_seq" in src, \
        "chat_routes.py must import the push helper + last_beat_seq (the turn-start beatSeq snapshot)"


def test_chat_routes_pushes_game_updated_mid_turn_on_a_committed_write():
    """A game-engine write that COMMITS mid-turn (its `tool_output`) pushes `game-updated` to peers
    immediately — a multi-round turn (e.g. a forced advance, then more narration) must not leave peer
    windows stale until the whole turn ends (the mirror-hud gate measured ~9s over its 2s budget)."""
    src = _CHAT_ROUTES.read_text(encoding="utf-8")
    m = re.search(
        r'data\.get\("type"\) == "tool_output" and ctx\.game_active\s*'
        r'and data\.get\("exit_code"\) == 0\s*'
        r'and str\(data\.get\("tool"\) or ""\) in GAME_ENGINE_WRITE_TOOLS\):(.{0,1200}?)yield chunk',
        src, re.S)
    assert m, "the tool_output branch must gate on GAME_ENGINE_WRITE_TOOLS during a game turn"
    assert "publish_game_updated(ctx.user)" in m.group(1), "and must push game-updated to peers"
