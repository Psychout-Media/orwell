"""Feature 0065 Part E2 — weave the engine DELTA into the moment context (FE side).

Two surfaces here:

  • the THIN `orwell_engine.state_delta` client — forwards `sinceBeatSeq` into the `stateDelta`
    tool call and returns the engine's result verbatim;
  • the ADDITIVE framing — `apply_game_framing` appends a tight "Since your last turn: …" line
    ALONGSIDE the full authoritative GAME CONTEXT block (never replacing it) when the delta carries
    changes. A `fullRefresh` / no last-seen / an empty delta ⇒ NO line; a delta-fetch exception ⇒
    the turn is framed exactly as today (fail-open).

Roles only — throwaway ids appear inside delta payloads to exercise the renderer realistically and
carry no test intent. httpx is faked so the client's outgoing JSON body is captured exactly.
"""
import asyncio
import importlib

import httpx
import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ── the thin state_delta client ──────────────────────────────────────────────────────────────


class _CapturingClient:
    last_json = None
    result = {"beatSeq": 9, "events": [], "fullRefresh": False}

    def __init__(self, *_a, **_k):
        pass

    async def post(self, *_a, **kwargs):
        type(self).last_json = kwargs.get("json")
        req = httpx.Request("POST", orwell_engine.ENGINE_URL.rstrip("/") + "/player/call")
        return httpx.Response(200, json={"result": type(self).result}, request=req)

    async def get(self, *_a, **_k):  # pragma: no cover - unused
        req = httpx.Request("GET", orwell_engine.ENGINE_URL.rstrip("/") + "/health")
        return httpx.Response(200, json={"ok": True}, request=req)


@pytest.fixture
def _patch_client(monkeypatch):
    _CapturingClient.last_json = None
    monkeypatch.setattr(orwell_engine.httpx, "AsyncClient", lambda *a, **k: _CapturingClient())
    orwell_engine._clear_error()
    yield _CapturingClient
    orwell_engine._clear_error()


def test_state_delta_forwards_since_beat_seq(_patch_client):
    res = _run(orwell_engine.state_delta(5, user="u"))
    assert _patch_client.last_json == {"name": "stateDelta", "args": {"sinceBeatSeq": 5}}
    # The tool result is returned verbatim.
    assert res == _CapturingClient.result


def test_state_delta_omits_arg_when_no_token(_patch_client):
    _run(orwell_engine.state_delta(None, user="u"))
    assert _patch_client.last_json == {"name": "stateDelta", "args": {}}


# ── the renderer: changes / finished / events / empty / fullRefresh ────────────────────────────


def test_render_delta_line_changes_and_events():
    line = chat_helpers._render_delta_line({
        "beatSeq": 9,
        "changes": {"hoh": {"from": None, "to": "npc:2"}, "phase": {"from": "noms", "to": "veto"}},
        "events": [{"id": "e1", "type": "scene", "content": "a tense kitchen standoff broke out"}],
        "fullRefresh": False,
    })
    assert line is not None
    assert line.startswith("Since your last turn:")
    assert "hoh" in line and "phase" in line
    assert "tense kitchen standoff" in line


def test_render_delta_line_finished_winner():
    line = chat_helpers._render_delta_line(
        {"beatSeq": 30, "changes": {}, "events": [], "finishedChanged": True, "winner": "the player"})
    assert line is not None and "FINISHED" in line and "the player" in line


def test_render_delta_line_full_refresh_is_none():
    assert chat_helpers._render_delta_line({"beatSeq": 9, "fullRefresh": True, "changes": {"x": {"to": 1}}}) is None


def test_render_delta_line_empty_is_none():
    assert chat_helpers._render_delta_line({"beatSeq": 9, "changes": {}, "events": [], "fullRefresh": False}) is None


def test_render_delta_line_bounded():
    big_changes = {f"f{i}": {"from": i, "to": i + 1} for i in range(20)}
    big_events = [{"id": f"e{i}", "content": "x" * 500} for i in range(20)]
    line = chat_helpers._render_delta_line(
        {"beatSeq": 9, "changes": big_changes, "events": big_events, "fullRefresh": False})
    # Bounded: at most the cap of each + the event content clipped.
    assert line.count("→") <= chat_helpers._DELTA_MAX_CHANGES
    assert "x" * (chat_helpers._DELTA_EVENT_CHARS + 1) not in line


# ── _maybe_delta_line: no last-seen / fail-open ────────────────────────────────────────────────


_USER = "u-delta"


def test_maybe_delta_line_none_without_last_seen():
    # No prior turn to diff against ⇒ leave today's full context untouched (return None, no fetch).
    assert _run(chat_helpers._maybe_delta_line(_USER, None)) is None


def test_maybe_delta_line_fail_open_on_exception(monkeypatch):
    async def boom(*_a, **_k):
        raise RuntimeError("engine blip")
    monkeypatch.setattr(orwell_engine, "state_delta", boom)
    # An exception ⇒ no line, the turn is framed exactly as today.
    assert _run(chat_helpers._maybe_delta_line(_USER, 4)) is None


def test_maybe_delta_line_renders_changes(monkeypatch):
    async def fake_delta(since, user=None):
        assert since == 4
        return {"beatSeq": 6, "changes": {"hoh": {"from": None, "to": "npc:9"}}, "events": [],
                "fullRefresh": False}
    monkeypatch.setattr(orwell_engine, "state_delta", fake_delta)
    line = _run(chat_helpers._maybe_delta_line(_USER, 4))
    assert line and line.startswith("Since your last turn:") and "hoh" in line


# ── apply_game_framing: the line is APPENDED alongside the full context ────────────────────────


def _game_framing_fakes(monkeypatch, *, delta):
    """Stub every engine read apply_game_framing makes so the game-active branch builds a frame."""
    async def fake_state(user=None, retry=None, timeout=None, **kw):
        return {"started": True, "moment": "social", "phase": "veto-competition",
                "week": 3, "house": [{"id": "player", "status": "active"}], "beatSeq": 6}
    async def fake_moment(moment=None, user=None, timeout=None, **_kw):
        return {"systemPrompt": "GAME CONTEXT: the full authoritative board for grounding."}
    async def fake_status(user=None):
        return {"week": 3, "phase": "veto-competition", "hoh": None, "nominees": [],
                "veto": {"holder": None, "used": False, "players": []}, "pending": None, "beatSeq": 6}
    async def fake_delta(since, user=None):
        return delta
    # No ceremony pre-resolve drift: keep the pre-resolve a no-op by leaving phase off the drive set
    # is not possible (veto-competition IS a drive phase) — so also stub advance_game defensively.
    async def fake_advance(*a, **k):
        return {"beatSeq": 6}
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_moment)
    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "state_delta", fake_delta)
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)


@pytest.fixture(autouse=True)
def _clean_framing_state():
    for d in (chat_helpers._LAST_BEAT_SEQ, chat_helpers._LAST_BEAT_SIG, chat_helpers._DESYNC_REGROUND,
              chat_helpers._SESSION_GAME_FRAMED):
        try:
            d.discard(_USER) if isinstance(d, set) else d.pop(_USER, None)
        except Exception:
            pass
    chat_helpers._SESSION_GAME_FRAMED.discard("sess-delta")
    chat_helpers.clear_social_runway(_USER)
    yield
    chat_helpers.clear_social_runway(_USER)


def test_framing_appends_delta_line_and_keeps_full_context(monkeypatch):
    # A prior turn left a last-seen beatSeq, so the delta is fetched against it.
    chat_helpers._LAST_BEAT_SEQ[_USER] = 4
    _game_framing_fakes(monkeypatch, delta={
        "beatSeq": 6, "changes": {"hoh": {"from": None, "to": "npc:9"}}, "events": [],
        "fullRefresh": False})
    # Mark the session already framed so the moment isn't swapped to re-entry (keeps the test focused).
    chat_helpers._SESSION_GAME_FRAMED.add("sess-delta")
    preface = []
    _run(chat_helpers.apply_game_framing(preface, _USER, session_id="sess-delta"))
    gm = preface[0]["content"]
    # The full authoritative GAME CONTEXT block is STILL present (additive, never replaced)…
    assert "GAME CONTEXT" in gm
    # …and the tight diff line was appended alongside it.
    assert "Since your last turn:" in gm and "hoh" in gm


def test_framing_full_refresh_adds_no_line(monkeypatch):
    chat_helpers._LAST_BEAT_SEQ[_USER] = 4
    _game_framing_fakes(monkeypatch, delta={"beatSeq": 6, "fullRefresh": True, "changes": {}})
    chat_helpers._SESSION_GAME_FRAMED.add("sess-delta")
    preface = []
    _run(chat_helpers.apply_game_framing(preface, _USER, session_id="sess-delta"))
    gm = preface[0]["content"]
    assert "GAME CONTEXT" in gm
    assert "Since your last turn:" not in gm


def test_framing_empty_delta_adds_no_line(monkeypatch):
    chat_helpers._LAST_BEAT_SEQ[_USER] = 4
    _game_framing_fakes(monkeypatch, delta={"beatSeq": 6, "changes": {}, "events": [], "fullRefresh": False})
    chat_helpers._SESSION_GAME_FRAMED.add("sess-delta")
    preface = []
    _run(chat_helpers.apply_game_framing(preface, _USER, session_id="sess-delta"))
    gm = preface[0]["content"]
    assert "GAME CONTEXT" in gm
    assert "Since your last turn:" not in gm


def test_framing_no_last_seen_adds_no_line(monkeypatch):
    # No prior last-seen beatSeq (fresh context) ⇒ no delta fetch, full context stands.
    _game_framing_fakes(monkeypatch, delta={"beatSeq": 6, "changes": {"hoh": {"to": "npc:9"}},
                                            "events": [], "fullRefresh": False})
    chat_helpers._SESSION_GAME_FRAMED.add("sess-delta")
    preface = []
    _run(chat_helpers.apply_game_framing(preface, _USER, session_id="sess-delta"))
    gm = preface[0]["content"]
    assert "GAME CONTEXT" in gm
    assert "Since your last turn:" not in gm


def test_framing_delta_exception_is_fail_open(monkeypatch):
    chat_helpers._LAST_BEAT_SEQ[_USER] = 4
    _game_framing_fakes(monkeypatch, delta={})  # replaced below
    async def boom(since, user=None):
        raise RuntimeError("delta blip")
    monkeypatch.setattr(orwell_engine, "state_delta", boom)
    chat_helpers._SESSION_GAME_FRAMED.add("sess-delta")
    preface = []
    # No raise; the full context is framed exactly as today.
    _run(chat_helpers.apply_game_framing(preface, _USER, session_id="sess-delta"))
    gm = preface[0]["content"]
    assert "GAME CONTEXT" in gm
    assert "Since your last turn:" not in gm
