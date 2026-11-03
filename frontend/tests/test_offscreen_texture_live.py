"""Feature 0070 (FE lane) — the LIVE wiring: an advance must actually fire the off-screen
texture enrichment, and the enrichment must actually reach the engine write-back.

The engine seam (recordOffscreenSceneTexture / getOffscreenSceneSkeletons) is proven by the TS
boundary test (tests/unit/offscreenTextureBoundary.test.ts). What that test CANNOT see is whether
the FE ever CALLS it — exactly the silent-no-op failure mode CLAUDE.md warns about for FE-driven
write-backs. These tests pin the FE half: the driver resolves its deps the same proven way the
other write-backs do, the write-back fires with voiced prose, it is content-only and fail-soft,
and `do_advance_game` kicks it off.

Roles only — no names (CLAUDE.md testing rule). Flavor only — nothing here touches a game outcome.
"""
import asyncio

import pytest

from src import orwell_offscreen_texture as T


@pytest.fixture(autouse=True)
def _enrichment_on(monkeypatch):
    """#1936: the enrichment is OFF by default; these tests exercise the ENABLED path (the gate itself is
    pinned in test_1936_offscreen_texture_off_by_default.py)."""
    monkeypatch.setattr(T, "enrichment_enabled", lambda: True)


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ── run_enrich: the write-back actually fires with voiced prose ───────────────────────────────

def test_run_enrich_voices_each_skeleton_and_writes_it_back(monkeypatch):
    """With a utility model resolved and a recorded off-screen scene, the driver voices the scene
    and CALLS recordOffscreenSceneTexture with the voiced prose — the path that was dead on main."""
    async def fake_llm(messages):
        # The model returns vivid prose; the driver sanitizes + writes it back.
        return "The two houseguests traded a wary, low-voiced exchange by the kitchen counter."

    async def fake_resolve(owner):
        return fake_llm

    skeleton = {
        "eventId": "offscreen:42",
        "nature": "gossip",
        "participants": ["npc:3", "npc:7"],
        "templateContent": "two houseguests talked off-screen",
    }

    async def fake_get_skeletons(user=None):
        return [skeleton]

    writes: list[tuple[str, str]] = []

    async def fake_write(event_id, content, user=None):
        writes.append((event_id, content))
        return {"ok": True}

    monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", fake_resolve)
    monkeypatch.setattr("src.orwell_engine.get_offscreen_scene_skeletons", fake_get_skeletons)
    monkeypatch.setattr("src.orwell_engine.record_offscreen_scene_texture", fake_write)

    result = _run(T.run_enrich(owner="player-1"))

    assert result == {"voiced": 1, "total": 1}
    assert len(writes) == 1, "the write-back must actually be called — not a silent no-op"
    event_id, content = writes[0]
    assert event_id == "offscreen:42"
    assert "houseguests" in content and content.strip() != ""


def test_run_enrich_is_content_only_passes_no_forbidden_fields(monkeypatch):
    """The driver's write-back is (eventId, content) ONLY — it never threads a witness set, a
    hidden flag, or any relationship number toward the closed-set boundary."""
    async def fake_resolve(owner):
        async def llm(messages):
            return "A quiet, ambiguous moment between two houseguests."
        return llm

    async def fake_get_skeletons(user=None):
        return [{"eventId": "offscreen:1", "nature": "bonding",
                 "participants": ["npc:1", "npc:2"], "templateContent": "t"}]

    captured: dict = {}

    async def fake_write(event_id, content, user=None):
        captured["args"] = {"event_id": event_id, "content": content, "user": user}
        return {"ok": True}

    monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", fake_resolve)
    monkeypatch.setattr("src.orwell_engine.get_offscreen_scene_skeletons", fake_get_skeletons)
    monkeypatch.setattr("src.orwell_engine.record_offscreen_scene_texture", fake_write)

    _run(T.run_enrich(owner="player-1"))

    # Exactly the content-only triple — nothing that could pierce the closed set.
    assert set(captured["args"].keys()) == {"event_id", "content", "user"}


# ── fail-soft: no model ⇒ the deterministic template stands, no write fires ──────────────────────

def test_run_enrich_no_model_writes_nothing(monkeypatch):
    async def fake_resolve(owner):
        return None  # no utility model resolves

    wrote = {"called": False}

    async def fake_write(event_id, content, user=None):
        wrote["called"] = True
        return {"ok": True}

    monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", fake_resolve)
    monkeypatch.setattr("src.orwell_engine.record_offscreen_scene_texture", fake_write)

    result = _run(T.run_enrich(owner="player-1"))

    assert result.get("reason") == "no-model"
    assert wrote["called"] is False, "no model ⇒ the engine's template stands; nothing is written"


def test_run_enrich_no_scenes_writes_nothing(monkeypatch):
    async def fake_resolve(owner):
        async def llm(messages):
            return "prose"
        return llm

    async def fake_get_skeletons(user=None):
        return []  # nothing recorded this tick

    wrote = {"called": False}

    async def fake_write(event_id, content, user=None):
        wrote["called"] = True
        return {"ok": True}

    monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", fake_resolve)
    monkeypatch.setattr("src.orwell_engine.get_offscreen_scene_skeletons", fake_get_skeletons)
    monkeypatch.setattr("src.orwell_engine.record_offscreen_scene_texture", fake_write)

    result = _run(T.run_enrich(owner="player-1"))

    assert result == {"voiced": 0, "total": 0}
    assert wrote["called"] is False


def test_run_enrich_empty_model_output_does_not_write(monkeypatch):
    """A model that returns nothing usable ⇒ the template stands (fail-soft per-scene)."""
    async def fake_resolve(owner):
        async def llm(messages):
            return "   "  # whitespace only → sanitized to empty
        return llm

    async def fake_get_skeletons(user=None):
        return [{"eventId": "offscreen:9", "nature": "conflict",
                 "participants": ["npc:4", "npc:5"], "templateContent": "t"}]

    wrote = {"called": False}

    async def fake_write(event_id, content, user=None):
        wrote["called"] = True
        return {"ok": True}

    monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", fake_resolve)
    monkeypatch.setattr("src.orwell_engine.get_offscreen_scene_skeletons", fake_get_skeletons)
    monkeypatch.setattr("src.orwell_engine.record_offscreen_scene_texture", fake_write)

    result = _run(T.run_enrich(owner="player-1"))

    assert result == {"voiced": 0, "total": 1}
    assert wrote["called"] is False


# ── do_advance_game kicks off the enrichment (the wiring that was missing) ───────────────────────

def test_do_advance_game_kicks_off_enrichment(monkeypatch):
    from src import tool_implementations as TI

    async def fake_advance(user=None, **_kw):
        return {"phase": "nominations", "beatSeq": 5}

    monkeypatch.setattr("src.orwell_engine.advance_game", fake_advance)
    monkeypatch.setattr("src.orwell_engine.remember_pending", lambda res, user=None: None)

    kicked: list = []
    monkeypatch.setattr(
        "src.orwell_offscreen_texture.kickoff_enrich",
        lambda owner=None: kicked.append(owner),
    )

    out = _run(TI.do_advance_game("", owner="player-1"))

    assert out["exit_code"] == 0
    assert kicked == ["player-1"], "advance must fire the off-screen texture enrichment"


def test_do_advance_game_advance_failure_does_not_kick_off(monkeypatch):
    """If the advance itself errors, there is no new tick to enrich — and enrichment must not run."""
    from src import tool_implementations as TI

    async def boom(user=None, **_kw):
        raise RuntimeError("engine down")

    monkeypatch.setattr("src.orwell_engine.advance_game", boom)

    kicked: list = []
    monkeypatch.setattr(
        "src.orwell_offscreen_texture.kickoff_enrich",
        lambda owner=None: kicked.append(owner),
    )

    out = _run(TI.do_advance_game("", owner="player-1"))

    assert out["exit_code"] == 1
    assert kicked == [], "a failed advance must not trigger enrichment"


def test_kickoff_enrich_schedules_background_task_and_never_raises(monkeypatch):
    """The kickoff is fire-and-forget on the running loop (the production path): it schedules the
    enrichment as a background task, never blocks/raises into the caller, and the in-flight guard
    clears after the run so the next tick runs normally.

    Driven through the suite's sync `_run` helper: the scenario runs ON the loop, so kickoff_enrich
    takes the `loop.create_task` branch, and the scheduled task drains before `_run` returns."""
    runs = {"count": 0}

    async def fake_resolve(owner):
        runs["count"] += 1
        return None  # no model ⇒ run_enrich returns fast, no engine calls

    monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", fake_resolve)

    async def scenario():
        T._IN_FLIGHT.discard("player-1")
        T.kickoff_enrich("player-1")  # running loop present → loop.create_task branch (production path)
        assert "player-1" in T._IN_FLIGHT, "guard is held while the background task is in flight"
        for _ in range(5):            # let the scheduled background task run to completion
            await asyncio.sleep(0)

    _run(scenario())
    assert "player-1" not in T._IN_FLIGHT, "the in-flight guard clears after the run"
    assert runs["count"] == 1


# ── G5 close-out (BE-103): the 0062 zeitgeist actually reaches the voicing prompt ─────────────────

def test_run_enrich_fetches_zeitgeist_and_colors_the_voicing_prompt(monkeypatch):
    """docs/features/0062-world-snapshot-zeitgeist.md §5 requires off-screen society/gossip prompts to
    receive the frozen move-in zeitgeist. Before the G5 fix, `worldSnapshotView` had zero FE callers —
    this pins that `run_enrich` now calls it and the returned `offscreenPrompt` block reaches the
    voicing LLM's prompt."""
    seen_messages: list = []

    async def fake_llm(messages):
        seen_messages.append(messages)
        return "The two houseguests traded a wary, low-voiced exchange by the kitchen counter."

    async def fake_resolve(owner):
        return fake_llm

    skeleton = {
        "eventId": "offscreen:42",
        "nature": "gossip",
        "participants": ["npc:3", "npc:7"],
        "templateContent": "two houseguests talked off-screen",
    }

    async def fake_get_skeletons(user=None):
        return [skeleton]

    async def fake_write(event_id, content, user=None):
        return {"ok": True}

    view_calls: list = []

    async def fake_world_snapshot_view(user=None):
        view_calls.append(user)
        return {
            "capturedFor": "2026-07-01",
            "source": "web_search",
            "slices": {},
            "offscreenPrompt": "the house moved in with a heat wave dominating the news",
        }

    monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", fake_resolve)
    monkeypatch.setattr("src.orwell_engine.get_offscreen_scene_skeletons", fake_get_skeletons)
    monkeypatch.setattr("src.orwell_engine.record_offscreen_scene_texture", fake_write)
    monkeypatch.setattr("src.orwell_engine.world_snapshot_view", fake_world_snapshot_view)

    result = _run(T.run_enrich(owner="player-1"))

    assert result == {"voiced": 1, "total": 1}
    assert view_calls == ["player-1"], "worldSnapshotView must actually be called — not a dead endpoint"
    assert len(seen_messages) == 1
    user_msg = seen_messages[0][1]["content"]
    assert "heat wave dominating the news" in user_msg, \
        "the zeitgeist block must reach the voicing prompt, not just be fetched and dropped"


def test_run_enrich_zeitgeist_fetch_failure_is_fail_soft(monkeypatch):
    """A worldSnapshotView read failure must never block voicing (0062 §6 — flavor only)."""
    async def fake_llm(messages):
        return "A quiet, ambiguous moment between two houseguests."

    async def fake_resolve(owner):
        return fake_llm

    async def fake_get_skeletons(user=None):
        return [{"eventId": "offscreen:1", "nature": "bonding",
                 "participants": ["npc:1", "npc:2"], "templateContent": "t"}]

    writes: list = []

    async def fake_write(event_id, content, user=None):
        writes.append((event_id, content))
        return {"ok": True}

    async def boom_world_snapshot_view(user=None):
        raise RuntimeError("engine unreachable")

    monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", fake_resolve)
    monkeypatch.setattr("src.orwell_engine.get_offscreen_scene_skeletons", fake_get_skeletons)
    monkeypatch.setattr("src.orwell_engine.record_offscreen_scene_texture", fake_write)
    monkeypatch.setattr("src.orwell_engine.world_snapshot_view", boom_world_snapshot_view)

    result = _run(T.run_enrich(owner="player-1"))

    assert result == {"voiced": 1, "total": 1}
    assert len(writes) == 1, "a zeitgeist-fetch fault must not block the scene from being voiced"


def test_voicing_messages_omits_zeitgeist_section_when_absent():
    """No snapshot captured ⇒ the prompt is byte-identical to the pre-0062-wiring shape (no
    zeitgeist section at all), not an empty/awkward block."""
    msgs = T._voicing_messages("gossip", ["npc:1", "npc:2"], "template text")
    user = msgs[1]["content"]
    assert "world they moved in with" not in user


def test_voicing_messages_includes_zeitgeist_section_when_present():
    msgs = T._voicing_messages("gossip", ["npc:1", "npc:2"], "template text",
                                zeitgeist="a heat wave dominates the news")
    user = msgs[1]["content"]
    assert "world they moved in with" in user
    assert "a heat wave dominates the news" in user


def test_kickoff_enrich_dedupes_overlapping_runs(monkeypatch):
    """A second kickoff while one is still in flight for the same user is dropped."""
    started = {"count": 0}

    async def scenario():
        gate = asyncio.Event()

        async def fake_resolve(owner):
            started["count"] += 1
            await gate.wait()  # hold the first run open so the second overlaps it
            return None

        monkeypatch.setattr("src.orwell_cast_authoring._resolve_llm_fn", fake_resolve)

        T._IN_FLIGHT.discard("player-2")
        T.kickoff_enrich("player-2")     # starts, then blocks on the gate
        await asyncio.sleep(0)
        T.kickoff_enrich("player-2")     # in flight → dropped
        await asyncio.sleep(0)
        assert started["count"] == 1, "the overlapping second kickoff is dropped by the in-flight guard"

        gate.set()                       # release the first run
        for _ in range(5):
            await asyncio.sleep(0)

    _run(scenario())
    assert "player-2" not in T._IN_FLIGHT
