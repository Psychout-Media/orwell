"""Feature 0050 — the casting interview (producer-led character creation).

Front-end half: (1) pre-game, under the game build, the chat turn is framed with the
engine's casting-interview moment prompt (the conversation IS character creation —
ADR 0003); (2) the createCharacter tool surface carries the interview deepeners through
to the engine; (3) the FE schema's canonical casting sheet cannot drift from the
engine's ARCHETYPES table (the bug class C13 closed, applied to creation).
"""

import asyncio
import importlib
import json
import os
import re

orwell_engine = importlib.import_module("src.orwell_engine")
# tool_implementations first: it pulls the agent_tools/tool_schemas chain in a
# cycle-safe order (tool_schemas imports agent_tools at module level) — see test_c13.
tool_impl = importlib.import_module("src.tool_implementations")
agent_tools = importlib.import_module("src.agent_tools")
tool_schemas = importlib.import_module("src.tool_schemas")
chat_helpers = importlib.import_module("routes.chat_helpers")

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(FRONTEND)


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# --- 1. pre-game framing: the chat is the interview ----------------------------------

def _pre_game(monkeypatch):
    chat_helpers._GAME_WAS_ACTIVE.clear()

    async def fake_state(user=None):
        return {"started": False, "moment": "character-creation"}

    async def fake_mp(moment=None, user=None, **_kw):
        return {"systemPrompt": "CASTING-INTERVIEW-PROMPT"}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_mp)


def test_pre_game_turn_is_framed_as_the_interview_under_the_game_build(monkeypatch):
    _pre_game(monkeypatch)
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)  # game build defaults ON
    preface = [{"role": "system", "content": "base"}]
    ea, ga, fd = _run(chat_helpers.apply_game_framing(preface, "p"))
    assert (ea, ga, fd) == (True, False, False)
    assert preface[0]["content"].startswith("CASTING-INTERVIEW-PROMPT")


def test_pre_game_falls_back_to_the_static_steer_when_the_moment_fetch_fails(monkeypatch):
    _pre_game(monkeypatch)
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)

    async def broken_mp(moment=None, user=None, **_kw):
        raise RuntimeError("hiccup")

    monkeypatch.setattr(orwell_engine, "get_moment_prompt", broken_mp)
    preface = [{"role": "system", "content": "base"}]
    ea, ga, fd = _run(chat_helpers.apply_game_framing(preface, "p"))
    assert (ea, ga, fd) == (True, False, False)
    # Never a generic assistant: the static producer steer frames the turn instead (#1034 appends
    # the casting-register reinforcement after it).
    assert preface[0]["content"].startswith(chat_helpers.PRE_GAME_PROMPT)
    assert chat_helpers.CASTING_REGISTER_NOTE in preface[0]["content"]
    assert "updateCasting" in chat_helpers.PRE_GAME_PROMPT


def test_pre_game_turn_stays_plain_when_the_game_build_is_off(monkeypatch):
    _pre_game(monkeypatch)
    monkeypatch.setenv("ORWELL_GAME_BUILD", "0")  # full debug workspace: normal chat
    preface = [{"role": "system", "content": "base"}]
    ea, ga, fd = _run(chat_helpers.apply_game_framing(preface, "p"))
    assert (ea, ga, fd) == (True, False, False)
    assert preface == [{"role": "system", "content": "base"}]


def test_started_game_framing_is_unchanged(monkeypatch):
    chat_helpers._GAME_WAS_ACTIVE.clear()

    async def fake_state(user=None):
        return {"started": True, "moment": "social"}

    async def fake_mp(moment=None, user=None, **_kw):
        return {"systemPrompt": "GM-PROMPT"}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_mp)
    preface = [{"role": "system", "content": "base"}]
    ea, ga, fd = _run(chat_helpers.apply_game_framing(preface, "p"))
    assert (ea, ga, fd) == (True, True, False)
    assert preface[0]["content"].startswith("GM-PROMPT")


# --- 2. the deepeners flow through the tool surface -----------------------------------

DEEPENERS = {
    "personaArchetype": "the quiet one who sees everything",
    "personaStrategyStyle": "smile first, strike later",
    "backstory": "a small-town story",
    "motivation": "to be underestimated all the way to the end",
    "privateStrategy": "let the loud ones take each other out",
    "interviewNotes": ["reads rooms", "hates losing at cards"],
}


def test_create_character_client_sends_the_interview_deepeners(monkeypatch):
    sent = {}

    async def fake_call(tool, args, user=None):
        sent.update(args)
        return {}

    monkeypatch.setattr(orwell_engine, "_call", fake_call)
    _run(orwell_engine.create_character(
        "P", archetype="mastermind", strategy_style="strategic",
        persona_archetype=DEEPENERS["personaArchetype"],
        persona_strategy_style=DEEPENERS["personaStrategyStyle"],
        backstory=DEEPENERS["backstory"], motivation=DEEPENERS["motivation"],
        private_strategy=DEEPENERS["privateStrategy"],
        interview_notes=DEEPENERS["interviewNotes"], user="u",
    ))
    for key, value in DEEPENERS.items():
        assert sent[key] == value, key


def test_do_create_character_forwards_the_deepeners(monkeypatch):
    received = {}

    async def fake_create(player_name, **kwargs):
        received["playerName"] = player_name
        received.update(kwargs)
        return {"started": True}

    monkeypatch.setattr(orwell_engine, "create_character", fake_create)
    import json
    res = _run(tool_impl.do_create_character(json.dumps({
        "playerName": "P", "archetype": "mastermind", **DEEPENERS,
    }), owner="u"))
    assert res["exit_code"] == 0
    assert received["persona_archetype"] == DEEPENERS["personaArchetype"]
    assert received["backstory"] == DEEPENERS["backstory"]
    assert received["motivation"] == DEEPENERS["motivation"]
    assert received["private_strategy"] == DEEPENERS["privateStrategy"]
    assert received["interview_notes"] == DEEPENERS["interviewNotes"]


def test_do_create_character_forwards_confirm_restart(monkeypatch):
    # Play-through bug (2026-06-18, season-1 finale → season 2): the engine's ONE sanctioned
    # restart door (D1/R1) is a confirmed createCharacter, but the relay never forwarded the
    # confirm flag — so over a finished season the call no-op'd (B36 guard) and the player could
    # never start season 2 from chat. The relay must pass confirmRestart through, and default it
    # OFF so a normal first-time casting never wipes anything.
    received = {}

    async def fake_create(player_name, **kwargs):
        received.update(kwargs)
        return {"started": True}

    monkeypatch.setattr(orwell_engine, "create_character", fake_create)
    import json
    _run(tool_impl.do_create_character(json.dumps({"playerName": "P", "confirmRestart": True}), owner="u"))
    assert received["confirm_restart"] is True
    received.clear()
    _run(tool_impl.do_create_character(json.dumps({"playerName": "P"}), owner="u"))
    assert received["confirm_restart"] is False  # absent ⇒ never a surprise restart


def test_createcharacter_schema_exposes_confirm_restart():
    props = _tool_schema("createCharacter")["parameters"]["properties"]
    assert "confirmRestart" in props
    assert props["confirmRestart"]["type"] == "boolean"
    # the description itself names the restart use (the model under-uses a param-only hint)
    assert "confirmRestart=true" in _tool_schema("createCharacter")["description"]


def test_restart_backstop_auto_confirms_over_a_finished_season(monkeypatch):
    # Live bug (S2→S3): asked to "play again" post-finale, the model called createCharacter SIX times
    # without confirmRestart — every call no-op'd and it gave up. The FE error-corrects (like the
    # stall-nudge): when the season is OVER (moment == "post-season"), a createCharacter IS the restart.
    received = {}

    async def fake_state(user=None):
        return {"started": True, "moment": "post-season", "player": {"name": "Old", "status": "evicted"}}

    async def fake_create(player_name, **kwargs):
        received.update(kwargs)
        return {"started": True, "week": 1}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "create_character", fake_create)
    _run(tool_impl.do_create_character(json.dumps({"playerName": "New"}), owner="u"))
    assert received["confirm_restart"] is True, "a post-season createCharacter must auto-confirm the restart"


def test_chat_restart_advances_the_season_counter(monkeypatch):
    # 0057 parity (merge reconciliation): a chat "run it back" is a NEXT season exactly like the
    # menu's New-season button, so it must advance the per-user season counter too — otherwise the
    # two restart paths disagree on how many levels were cleared.
    import importlib
    orwell_seasons = importlib.import_module("src.orwell_seasons")

    async def fake_state(user=None):
        return {"started": True, "moment": "post-season", "player": {"name": "Old", "status": "jury"}}

    async def fake_create(player_name, **kwargs):
        return {"started": True, "week": 1}  # a fresh season

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "create_character", fake_create)
    before = orwell_seasons.get_season("season-counter-test-user")
    _run(tool_impl.do_create_character(json.dumps({"playerName": "New"}), owner="season-counter-test-user"))
    assert orwell_seasons.get_season("season-counter-test-user") == before + 1


def test_chat_restart_forwards_keep_character(monkeypatch):
    # 0056 via chat: the model may carry the same houseguest forward (keepCharacter) on a chat restart.
    received = {}

    async def fake_state(user=None):
        return {"started": True, "moment": "post-season", "player": {"name": "Keep Me", "status": "jury"}}

    async def fake_create(player_name, **kwargs):
        received.update(kwargs)
        return {"started": True}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "create_character", fake_create)
    _run(tool_impl.do_create_character(json.dumps({"keepCharacter": True}), owner="u"))
    assert received["keep_character"] is True and received["confirm_restart"] is True


def test_restart_backstop_never_fires_mid_season(monkeypatch):
    # The backstop must NEVER wipe a LIVE season out from under the player — only a finished one.
    received = {}

    async def fake_state(user=None):
        return {"started": True, "moment": "nominations", "player": {"name": "Live", "status": "active"}}

    async def fake_create(player_name, **kwargs):
        received.update(kwargs)
        return {"started": True}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "create_character", fake_create)
    _run(tool_impl.do_create_character(json.dumps({"playerName": "X"}), owner="u"))
    assert received["confirm_restart"] is False, "an ongoing season is never silently wiped"


def test_do_create_character_allows_a_missing_name(monkeypatch):
    # 0050: the name may already be on file from the interview — the ENGINE validates.
    received = {}

    async def fake_create(player_name, **kwargs):
        received["playerName"] = player_name
        return {"started": True}

    monkeypatch.setattr(orwell_engine, "create_character", fake_create)
    import json
    res = _run(tool_impl.do_create_character(json.dumps({}), owner="u"))
    assert res["exit_code"] == 0
    assert received["playerName"] is None


def test_update_casting_client_filters_and_normalizes(monkeypatch):
    sent = {}

    async def fake_call(tool, args, user=None):
        sent["tool"] = tool
        sent["args"] = args
        return {"known": {}, "missing": [], "next": None, "ready": False}

    monkeypatch.setattr(orwell_engine, "_call", fake_call)
    _run(orwell_engine.update_casting({
        "playerName": "P", "interviewNotes": "a lone note",  # bare string → one note
        "unknownField": "dropped", "backstory": "  ", "motivation": None,
    }, user="u"))
    assert sent["tool"] == "updateCasting"
    assert sent["args"] == {"playerName": "P", "interviewNotes": ["a lone note"]}


def test_do_update_casting_returns_the_engine_status(monkeypatch):
    async def fake_update(fields, user=None):
        return {"known": {"playerName": "P"}, "missing": ["backstory"],
                "next": "their life outside the house, in their words", "ready": True}

    monkeypatch.setattr(orwell_engine, "update_casting", fake_update)
    import json
    res = _run(tool_impl.do_update_casting(json.dumps({"playerName": "P"}), owner="u"))
    assert res["exit_code"] == 0
    out = json.loads(res["output"])
    assert out["ready"] is True and out["missing"] == ["backstory"]


# --- 3. the casting sheet cannot drift -------------------------------------------------

def _engine_casting_sheet() -> tuple[set, set]:
    """Parse the canonical archetypes + styles from the engine's single source of truth."""
    with open(os.path.join(REPO, "src", "engine", "characterFactory.ts"), encoding="utf-8") as f:
        ts = f.read()
    start = ts.index("export const ARCHETYPES")
    end = ts.index("];", start)
    block = ts[start:end]
    archetypes = set(re.findall(r'archetype:\s*"([a-z-]+)"', block))
    styles = set()
    for styles_m in re.finditer(r"styles:\s*\[([^\]]*)\]", block):
        styles.update(re.findall(r'"([a-z-]+)"', styles_m.group(1)))
    return archetypes, styles


def _tool_schema(name: str) -> dict:
    for t in tool_schemas.FUNCTION_TOOL_SCHEMAS:
        if isinstance(t, dict) and t.get("function", {}).get("name") == name:
            return t["function"]
    raise AssertionError(f"{name} schema missing")


def test_schema_archetype_enums_match_the_engine():
    archetypes, _ = _engine_casting_sheet()
    assert archetypes, "failed to parse the engine's ARCHETYPES — parser or table changed shape"
    for tool in ("createCharacter", "updateCasting"):
        enum = set(_tool_schema(tool)["parameters"]["properties"]["archetype"]["enum"])
        assert enum == archetypes, tool


def test_schema_strategy_style_enums_match_the_engine():
    _, styles = _engine_casting_sheet()
    assert styles, "failed to parse the engine's strategy styles"
    for tool in ("createCharacter", "updateCasting"):
        enum = set(_tool_schema(tool)["parameters"]["properties"]["strategyStyle"]["enum"])
        assert enum == styles, tool


def test_schemas_carry_every_interview_deepener():
    for tool in ("createCharacter", "updateCasting"):
        props = _tool_schema(tool)["parameters"]["properties"]
        for field in ("playerName", "personaArchetype", "personaStrategyStyle", "backstory",
                      "motivation", "privateStrategy", "interviewNotes"):
            assert field in props, f"{tool}.{field}"


def test_create_character_no_longer_hard_requires_a_name():
    # 0050: finalization may rely on the interview's recorded name; the ENGINE gates it.
    assert _tool_schema("createCharacter")["parameters"]["required"] == []


def test_update_casting_is_pinned_and_agent_callable():
    assert "updateCasting" in tool_schemas.ORWELL_GAME_TOOLS
    assert "updateCasting" in agent_tools.GAME_TOOL_KEEP


# --- 4. the cast-photo casting step (first, optional step of the interview) -------------

def test_update_casting_carries_cast_photo_through(monkeypatch):
    """castPhoto is a plain string scalar — the client must forward it untouched."""
    sent = {}

    async def fake_call(tool, args, user=None):
        sent["tool"] = tool
        sent["args"] = args
        return {"known": {}, "missing": [], "next": None, "ready": False}

    monkeypatch.setattr(orwell_engine, "_call", fake_call)
    _run(orwell_engine.update_casting({"castPhoto": "uploaded"}, user="u"))
    assert sent["tool"] == "updateCasting"
    assert sent["args"] == {"castPhoto": "uploaded"}


class TestCastingPhotoRoute:
    """POST /api/orwell/casting/photo — record the cast-photo step into the engine."""

    def _client(self):
        import importlib
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        orwell_routes = importlib.import_module("routes.orwell_routes")
        app = FastAPI()
        app.include_router(orwell_routes.setup_orwell_routes())
        return TestClient(app)

    def test_uploaded_records_and_returns_casting_status(self, monkeypatch):
        seen = {}

        async def fake_update(fields, user=None):
            seen.update(fields)
            return {"known": {"castPhoto": "uploaded"}, "missing": ["playerName"],
                    "next": "their name", "ready": False}

        monkeypatch.setattr(orwell_engine, "update_casting", fake_update)
        r = self._client().post("/api/orwell/casting/photo", json={"status": "uploaded"})
        assert r.status_code == 200
        assert seen == {"castPhoto": "uploaded"}
        assert r.json()["known"]["castPhoto"] == "uploaded"

    def test_skipped_records_and_returns_casting_status(self, monkeypatch):
        seen = {}

        async def fake_update(fields, user=None):
            seen.update(fields)
            return {"known": {"castPhoto": "skipped"}, "missing": ["playerName"],
                    "next": "their name", "ready": False}

        monkeypatch.setattr(orwell_engine, "update_casting", fake_update)
        r = self._client().post("/api/orwell/casting/photo", json={"status": "skipped"})
        assert r.status_code == 200
        assert seen == {"castPhoto": "skipped"}

    def test_bad_status_is_rejected_without_touching_the_engine(self, monkeypatch):
        called = []

        async def fake_update(fields, user=None):
            called.append(fields)
            return {}

        monkeypatch.setattr(orwell_engine, "update_casting", fake_update)
        r = self._client().post("/api/orwell/casting/photo", json={"status": "deleted"})
        assert r.status_code == 400
        assert not called

    def test_no_active_game_is_a_benign_409(self, monkeypatch):
        async def refuse(fields, user=None):
            raise orwell_engine.EngineToolError("no active game for this user")

        monkeypatch.setattr(orwell_engine, "update_casting", refuse)
        r = self._client().post("/api/orwell/casting/photo", json={"status": "skipped"})
        assert r.status_code == 409
        assert r.json()["started"] is False
