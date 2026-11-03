"""#617 (SYNC-STALE) — background FE-driven write-backs publish a server-side "game-updated" push.

Cast authoring / off-screen texture / zeitgeist mutate engine state in the background but historically
never pushed (feature 0064 server-push), so open pages stayed stale until the next poll. These gates
pin (a) the shared publish helper, and (b) that each live-mutation driver routes a successful write
through it. Best-effort/fail-soft is preserved.
"""

import asyncio
import importlib


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_publish_game_updated_helper_pushes_on_bound_session(monkeypatch):
    gs = importlib.import_module("src.orwell_game_session")
    se = importlib.import_module("src.session_events")

    monkeypatch.setattr(gs, "get_game_session", lambda user: "sess-1")
    pushed = []
    monkeypatch.setattr(se, "publish", lambda sid, ev, data=None: pushed.append((sid, ev)))

    gs.publish_game_updated("u")
    assert pushed == [("sess-1", "game-updated")]


def test_publish_game_updated_noop_without_binding(monkeypatch):
    gs = importlib.import_module("src.orwell_game_session")
    se = importlib.import_module("src.session_events")
    monkeypatch.setattr(gs, "get_game_session", lambda user: None)
    pushed = []
    monkeypatch.setattr(se, "publish", lambda sid, ev, data=None: pushed.append((sid, ev)))
    gs.publish_game_updated("u")  # no binding ⇒ no push, no raise
    assert pushed == []


def test_publish_game_updated_is_fail_soft(monkeypatch):
    gs = importlib.import_module("src.orwell_game_session")
    se = importlib.import_module("src.session_events")
    monkeypatch.setattr(gs, "get_game_session", lambda user: "sess-1")

    def boom(*a, **k):
        raise RuntimeError("event bus down")

    monkeypatch.setattr(se, "publish", boom)
    gs.publish_game_updated("u")  # must NOT raise


def test_offscreen_texture_run_pushes_on_voiced(monkeypatch):
    tex = importlib.import_module("src.orwell_offscreen_texture")
    monkeypatch.setattr(tex, "enrichment_enabled", lambda: True)  # #1936: exercise the ENABLED path
    cast = importlib.import_module("src.orwell_cast_authoring")
    gs = importlib.import_module("src.orwell_game_session")

    # A resolvable utility LLM (any callable) so run_enrich proceeds to enrich_tick.
    async def fake_resolver(owner):
        async def _fn(messages):
            return "x"
        return _fn

    monkeypatch.setattr(cast, "_resolve_llm_fn", fake_resolver)

    # Stub the engine skeleton fetch + write so no real engine is needed.
    eng = importlib.import_module("src.orwell_engine")

    async def fake_skeletons(user=None):
        return [{"eventId": "e1"}]

    async def fake_write(event_id, content, user=None):
        return {"accepted": True}

    monkeypatch.setattr(eng, "get_offscreen_scene_skeletons", fake_skeletons)
    monkeypatch.setattr(eng, "record_offscreen_scene_texture", fake_write)

    # Force enrich_tick to report a voiced scene without invoking the real voicing logic.
    async def fake_enrich(get_skeletons, llm_fn, write_back, get_zeitgeist_fn=None):
        return {"voiced": 1, "total": 1}

    monkeypatch.setattr(tex, "enrich_tick", fake_enrich)

    pushed = []
    monkeypatch.setattr(gs, "publish_game_updated", lambda user: pushed.append(user))

    result = _run(tex.run_enrich("u"))
    assert result.get("voiced") == 1
    assert pushed == ["u"]  # a live mutation pushed a game-updated


def test_offscreen_texture_does_not_push_when_nothing_voiced(monkeypatch):
    tex = importlib.import_module("src.orwell_offscreen_texture")
    monkeypatch.setattr(tex, "enrichment_enabled", lambda: True)  # #1936: exercise the ENABLED path
    cast = importlib.import_module("src.orwell_cast_authoring")
    gs = importlib.import_module("src.orwell_game_session")

    async def fake_resolver(owner):
        async def _fn(messages):
            return "x"
        return _fn

    monkeypatch.setattr(cast, "_resolve_llm_fn", fake_resolver)
    eng = importlib.import_module("src.orwell_engine")
    monkeypatch.setattr(eng, "get_offscreen_scene_skeletons",
                        lambda user=None: _coro([]))
    monkeypatch.setattr(eng, "record_offscreen_scene_texture",
                        lambda *a, **k: _coro({"accepted": False}))

    async def fake_enrich(get_skeletons, llm_fn, write_back, get_zeitgeist_fn=None):
        return {"voiced": 0, "total": 0}

    monkeypatch.setattr(tex, "enrich_tick", fake_enrich)
    pushed = []
    monkeypatch.setattr(gs, "publish_game_updated", lambda user: pushed.append(user))

    _run(tex.run_enrich("u"))
    assert pushed == []  # nothing landed ⇒ no spurious push


async def _coro(val):
    return val
