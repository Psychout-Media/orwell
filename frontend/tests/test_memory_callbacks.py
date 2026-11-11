"""Feature #1394 — narrator memory callbacks (FE side).

Two surfaces:
  • the THIN `orwell_engine.recall_scene_memories` client — forwards {withIds, cue} into the
    `recallSceneMemories` tool call and returns the engine's result verbatim;
  • the ADDITIVE framing — `apply_game_framing` appends a "MEMORY — real earlier moments…" block
    ALONGSIDE the full GAME CONTEXT, but ONLY when ORWELL_MEMORY_CALLBACKS is on AND there is a
    present houseguest + a player message + relevant history. The whole feature is default OFF: with
    the flag unset the recall is NEVER fetched and the framing is byte-identical (the floor contract).

Roles only — throwaway ids/labels carry no test intent. httpx is faked so the client's outgoing JSON
body is captured exactly.
"""
import asyncio
import importlib

import httpx
import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")

_USER = "u-mem"


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ── the thin recall_scene_memories client ──────────────────────────────────────────────────────


class _CapturingClient:
    last_json = None
    result = {"moments": ["you told me at the veto you'd never write my name"]}

    def __init__(self, *_a, **_k):
        pass

    async def post(self, *_a, **kwargs):
        type(self).last_json = kwargs.get("json")
        req = httpx.Request("POST", orwell_engine.ENGINE_URL.rstrip("/") + "/player/call")
        return httpx.Response(200, json={"result": type(self).result}, request=req)

    async def get(self, *_a, **_k):  # pragma: no cover - unused
        req = httpx.Request("GET", orwell_engine.ENGINE_URL.rstrip("/") + "/health")
        return httpx.Response(200, json={"ok": True}, request=req)

    async def aclose(self):  # pragma: no cover
        pass


@pytest.fixture
def _patch_client(monkeypatch):
    _CapturingClient.last_json = None
    monkeypatch.setattr(orwell_engine.httpx, "AsyncClient", lambda *a, **k: _CapturingClient())
    orwell_engine._clear_error()
    yield _CapturingClient
    orwell_engine._clear_error()


def test_recall_client_forwards_ids_and_cue(_patch_client):
    res = _run(orwell_engine.recall_scene_memories(["npc:2", "npc:3"], cue="are you writing my name", user="u"))
    assert _patch_client.last_json == {
        "name": "recallSceneMemories",
        "args": {"withIds": ["npc:2", "npc:3"], "cue": "are you writing my name"},
    }
    assert res == _CapturingClient.result  # returned verbatim


def test_recall_client_omits_empty_args(_patch_client):
    _run(orwell_engine.recall_scene_memories(None, cue=None, user="u"))
    assert _patch_client.last_json == {"name": "recallSceneMemories", "args": {}}


# ── the flag (default OFF) ──────────────────────────────────────────────────────────────────────


def test_flag_default_off(monkeypatch):
    monkeypatch.delenv("ORWELL_MEMORY_CALLBACKS", raising=False)
    assert chat_helpers._memory_callbacks_enabled() is False


@pytest.mark.parametrize("val,expected", [
    ("1", True), ("true", True), ("on", True), ("YES", True),
    ("0", False), ("", False), ("off", False), ("nope", False),
])
def test_flag_reads_env(monkeypatch, val, expected):
    monkeypatch.setenv("ORWELL_MEMORY_CALLBACKS", val)
    assert chat_helpers._memory_callbacks_enabled() is expected


# ── the present-NPC (presence) seam ─────────────────────────────────────────────────────────────


def test_scene_npc_ids_extracts_present_ids():
    wa = {"room": "kitchen", "present": [{"id": "npc:2", "name": "The Ally"}, {"id": "npc:5", "name": "The Rival"}]}
    assert chat_helpers._scene_npc_ids(wa) == ["npc:2", "npc:5"]


@pytest.mark.parametrize("wa", [None, {}, {"present": []}, {"present": [{"name": "no id"}]}, "nonsense", {"present": None}])
def test_scene_npc_ids_empty_on_odd_shapes(wa):
    assert chat_helpers._scene_npc_ids(wa) == []


# ── the render helper ───────────────────────────────────────────────────────────────────────────


def test_render_none_when_empty():
    assert chat_helpers._render_memory_callbacks(None) is None
    assert chat_helpers._render_memory_callbacks([]) is None
    assert chat_helpers._render_memory_callbacks(["", "   "]) is None
    assert chat_helpers._render_memory_callbacks("not a list") is None


def test_render_block_lists_moments_capped():
    block = chat_helpers._render_memory_callbacks([
        "you swore you'd never write my name", "you gave me your word about the veto", "a third moment",
    ])
    assert block is not None
    assert block.startswith("MEMORY —")
    assert "you swore you'd never write my name" in block
    assert "you gave me your word about the veto" in block
    # Capped at MEMORY_CALLBACK_MAX (2): the third moment is dropped.
    assert "a third moment" not in block
    assert block.count("  • ") == chat_helpers._MEMORY_CALLBACK_MAX


def test_render_filters_non_strings():
    block = chat_helpers._render_memory_callbacks(["a real recalled moment", 42, None, {"x": 1}])
    assert block is not None
    assert "a real recalled moment" in block
    assert block.count("  • ") == 1


# ── apply_game_framing: the floor + the enabled behavior ────────────────────────────────────────


def _framing_fakes(monkeypatch, *, moments, recall_calls=None, recall_boom=False):
    """Stub every engine read apply_game_framing makes so the game-active branch builds a frame,
    including a present houseguest in the player's room (the presence seam)."""
    async def fake_state(user=None, retry=None, timeout=None, **kw):
        return {"started": True, "moment": "social", "phase": "veto-competition", "week": 3,
                "house": [{"id": "player", "status": "active"}], "beatSeq": 6,
                "whereabouts": {"room": "kitchen", "present": [{"id": "npc:2", "name": "The Ally"}]}}
    async def fake_moment(moment=None, user=None, timeout=None, **_kw):
        return {"systemPrompt": "GAME CONTEXT: the full authoritative board for grounding."}
    async def fake_status(user=None):
        return {"week": 3, "phase": "veto-competition", "hoh": None, "nominees": [],
                "veto": {"holder": None, "used": False, "players": []}, "pending": None, "beatSeq": 6}
    async def fake_advance(*a, **k):
        return {"beatSeq": 6}

    async def fake_recall(with_ids=None, cue=None, user=None, timeout=None):
        if recall_calls is not None:
            recall_calls.append({"with_ids": with_ids, "cue": cue})
        if recall_boom:
            raise RuntimeError("recall blip")
        return {"moments": moments}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_moment)
    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "recall_scene_memories", fake_recall)


@pytest.fixture(autouse=True)
def _clean_framing_state(monkeypatch):
    monkeypatch.delenv("ORWELL_MEMORY_CALLBACKS", raising=False)
    for d in (chat_helpers._LAST_BEAT_SEQ, chat_helpers._LAST_BEAT_SIG, chat_helpers._DESYNC_REGROUND,
              chat_helpers._SESSION_GAME_FRAMED):
        try:
            d.discard(_USER) if isinstance(d, set) else d.pop(_USER, None)
        except Exception:
            pass
    chat_helpers._SESSION_GAME_FRAMED.discard("sess-mem")
    chat_helpers.clear_social_runway(_USER)
    yield
    chat_helpers.clear_social_runway(_USER)


def _frame(monkeypatch, **kw):
    _framing_fakes(monkeypatch, **kw)
    chat_helpers._SESSION_GAME_FRAMED.add("sess-mem")
    preface = []
    _run(chat_helpers.apply_game_framing(
        preface, _USER, session_id="sess-mem", player_msg="are you going to write my name"))
    return preface[0]["content"]


def test_floor_flag_off_never_calls_recall_and_no_block(monkeypatch):
    # THE FLOOR: flag unset ⇒ recall is never fetched and no MEMORY block is added (byte-identical).
    monkeypatch.delenv("ORWELL_MEMORY_CALLBACKS", raising=False)
    calls = []
    gm = _frame(monkeypatch, moments=["you told me you'd never write my name"], recall_calls=calls)
    assert "GAME CONTEXT" in gm       # the full framing still builds
    assert calls == []                 # recall was NEVER called
    assert "MEMORY —" not in gm        # and no block was added


def test_enabled_appends_block_when_relevant_history(monkeypatch):
    monkeypatch.setenv("ORWELL_MEMORY_CALLBACKS", "1")
    calls = []
    gm = _frame(monkeypatch, moments=["you swore you'd never write my name"], recall_calls=calls)
    assert "GAME CONTEXT" in gm                                   # additive, never replaces
    assert calls and calls[0]["with_ids"] == ["npc:2"]           # the present NPC drove the recall
    assert calls[0]["cue"] == "are you going to write my name"    # the player's message is the cue
    assert "MEMORY —" in gm and "you swore you'd never write my name" in gm


def test_enabled_no_block_when_no_relevant_history(monkeypatch):
    monkeypatch.setenv("ORWELL_MEMORY_CALLBACKS", "1")
    gm = _frame(monkeypatch, moments=[])   # engine found nothing relevant
    assert "GAME CONTEXT" in gm
    assert "MEMORY —" not in gm            # recall absence is not a failure → no block


def test_enabled_no_block_when_no_present_npc(monkeypatch):
    monkeypatch.setenv("ORWELL_MEMORY_CALLBACKS", "1")
    calls = []
    # An empty room ⇒ no scene NPC ⇒ recall not called ⇒ no block.
    async def fake_state(user=None, retry=None, timeout=None, **kw):
        return {"started": True, "moment": "social", "phase": "veto-competition", "week": 3,
                "house": [{"id": "player", "status": "active"}], "beatSeq": 6,
                "whereabouts": {"room": "kitchen", "present": []}}
    _framing_fakes(monkeypatch, moments=["unused"], recall_calls=calls)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    chat_helpers._SESSION_GAME_FRAMED.add("sess-mem")
    preface = []
    _run(chat_helpers.apply_game_framing(
        preface, _USER, session_id="sess-mem", player_msg="hello everyone"))
    gm = preface[0]["content"]
    assert "MEMORY —" not in gm
    assert calls == []


def test_enabled_no_block_when_no_player_message(monkeypatch):
    monkeypatch.setenv("ORWELL_MEMORY_CALLBACKS", "1")
    calls = []
    _framing_fakes(monkeypatch, moments=["unused"], recall_calls=calls)
    chat_helpers._SESSION_GAME_FRAMED.add("sess-mem")
    preface = []
    _run(chat_helpers.apply_game_framing(preface, _USER, session_id="sess-mem", player_msg="   "))
    gm = preface[0]["content"]
    assert "MEMORY —" not in gm
    assert calls == []


def test_enabled_recall_exception_is_fail_open(monkeypatch):
    monkeypatch.setenv("ORWELL_MEMORY_CALLBACKS", "1")
    gm = _frame(monkeypatch, moments=["unused"], recall_boom=True)
    # No raise; the full context is framed exactly as today, minus the (failed) block.
    assert "GAME CONTEXT" in gm
    assert "MEMORY —" not in gm
