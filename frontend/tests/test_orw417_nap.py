"""ORW-417 / 0148 - the player's NAP: the FE wiring + the under-call belt.

The engine owns the nap (the clock, the house life, the deficit ease); the FE only (1) exposes the `nap` lever through the five-place tool wiring and (2) error-corrects the OMISSION: when the player CLEARLY says THEY nap and the
model recorded no nap, the FE runs the lever itself with the length taken from the player's words. Telemetry is success-gated (a count means an APPLIED nap, never an engine refusal or an error).

Stubbed LLM, no network, no engine. Roles only.
"""
import asyncio
import json

import pytest

pytestmark = [pytest.mark.usefixtures("non_game_text_routing"), pytest.mark.usefixtures("zero_clocks_off")]

OR_URL = "https://openrouter.ai/api/v1/chat/completions"
DEEPSEEK = "deepseek/deepseek-v4-pro"
GLM = "z-ai/glm-4.7"
_DAY = {"timeOfDay": "morning", "pending": None, "started": True}

POSITIVES = [
    "I take a nap.",
    "I'll take a quick nap in my room.",
    "I'm going to take a nap for an hour.",
    "I lie down for a nap.",
    "I'll lie down for an hour.",
    "I grab a short nap.",
    "I nap for two hours.",
    "I'm gonna nap until the comp.",
]
NEGATIVES = [
    "I can't take a nap.",
    "Do you want to take a nap?",
    "She takes a nap every day.",
    "I'm not going to nap.",
    "Maybe I'll take a nap later.",
    "If I take a nap I will miss it.",
    "He is taking a nap.",
    "I wish I could nap.",
    "I watch her take a nap.",
    "Nice nap.",
    "Goodnight everyone.",
    "I go to bed.",
    "",
]


@pytest.mark.parametrize("text", POSITIVES)
def test_clear_nap_declarations_are_detected(text):
    from src.agent_loop import _player_means_nap
    assert _player_means_nap(text) is True, text


@pytest.mark.parametrize("text", NEGATIVES)
def test_talk_about_naps_is_not_a_nap(text):
    from src.agent_loop import _player_means_nap
    assert _player_means_nap(text) is False, text


def test_ooc_aside_is_ignored():
    from src.agent_loop import _player_means_nap
    assert _player_means_nap("((I take a nap now)) What is everyone doing?") is False


@pytest.mark.parametrize("text,hours", [
    ("I take a nap for an hour.", 1.0), ("I take a nap for two hours.", 2.0), ("I take a 3 hour nap.", 3.0), ("I nap for half an hour.", 0.5), ("I'll nap for 45 minutes.", 0.75),
    ("I take a nap for an hour and a half.", 1.5), ("I take a nap.", None), ("I take a nap for a couple of hours.", 2.0),
])
def test_length_comes_from_the_players_words(text, hours):
    from src.agent_loop import _nap_hours_from_text
    assert _nap_hours_from_text(text) == hours


def test_nap_applied_only_when_the_engine_slept_the_player():
    from src.agent_loop import _nap_applied
    ok = {"output": json.dumps({"ok": True, "slept": 2}), "exit_code": 0}
    assert _nap_applied(ok) is True
    assert _nap_applied({"output": json.dumps({"ok": False, "reason": "evening", "why": "late", "slept": 0}), "exit_code": 0}) is False
    assert _nap_applied({"output": json.dumps({"ok": True, "slept": 0}), "exit_code": 0}) is False
    assert _nap_applied({"error": "engine error", "exit_code": 1}) is False
    assert _nap_applied({"output": "not json"}) is False
    assert _nap_applied(None) is False


# -- the loop, driven for real with a stubbed model ------------------------------------------------------------------------------------
_LAST_CHUNKS: list = []


def _drive(monkeypatch, *, text, model=GLM, status=None, scripts=None, owner="orw417", nap_result=None,
           force_setting=True, max_rounds=3, capture_blocks=None):
    """Run stream_agent_loop with a scripted model. `scripts` = list of per-round dicts
    {"deltas": [...], "calls": [{"name","arguments"}]}. Returns (captures, belts, forced_outcomes, executed)."""
    from src import agent_loop as al
    from src import orwell_engine as oe
    from routes import chat_helpers as ch
    import src.tool_index as ti

    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    real = al.get_setting
    monkeypatch.setattr(al, "get_setting",
                        lambda k, d=None: force_setting if k == "force_tool_choice_at_beats" else real(k, d))
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)
    ch._LAST_FRAMED_BEAT_KEY.pop(owner, None)
    ch._LAST_FRAMED_REQUIRED_LEVER.pop(owner, None)

    async def fake_status(user=None):
        return dict(status if status is not None else _DAY)

    monkeypatch.setattr(oe, "game_status", fake_status)
    # The loop's OTHER engine reads (whereabouts, ...) have no engine behind them here: without this each one retried against a closed port with 0.5 s+ backoffs (~7 s per drive).
    monkeypatch.setattr(oe, "_RETRY_ATTEMPTS", 0)

    rounds: list = []
    scripts = list(scripts if scripts is not None else [{"deltas": ["ok"]}])

    async def fake_stream(candidates, messages, **kwargs):
        rounds.append({"tool_choice": kwargs.get("tool_choice"),
                       "tools": [t["function"]["name"] for t in (kwargs.get("tools") or [])],
                       "n_system": sum(1 for m in messages if m.get("role") == "system")})
        sc = scripts.pop(0) if scripts else {"deltas": ["done"]}
        for d in sc.get("deltas", []):
            yield f'data: {json.dumps({"delta": d})}\n\n'
        if sc.get("calls"):
            yield f'data: {json.dumps({"type": "tool_calls", "calls": sc["calls"]})}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    async def _no_side_llm(*a, **k):  # the overseer / judge / extraction side calls would hit the unreachable test URL and wait out their timeouts (~7 s per drive)
        return ""

    import src.llm_core as _lc
    monkeypatch.setattr(_lc, "llm_call_async", _no_side_llm)

    executed: list = []

    async def fake_exec(block, **kw):
        executed.append(block.tool_type)
        if capture_blocks is not None:
            capture_blocks.append(block)
        return block.tool_type, (nap_result if nap_result is not None else {"output": "{}", "exit_code": 0})

    monkeypatch.setattr(al, "execute_tool_block", fake_exec)

    belts: dict = {}
    forced: list = []
    monkeypatch.setattr(al, "_note_belt", lambda o, b, n=1: belts.__setitem__(b, belts.get(b, 0) + n))
    monkeypatch.setattr(al, "_note_forced_choice", lambda o, t, honored: forced.append((t, honored)))

    async def go():
        out = []
        async for chunk in al.stream_agent_loop(
            OR_URL, model,
            [{"role": "system", "content": "narrator"}, {"role": "user", "content": text}],
            max_rounds=max_rounds, game_mode="game", owner=owner,
            pinned_tools={"nap", "turnIn", "advanceGame"},
        ):
            out.append(chunk)
        _LAST_CHUNKS[:] = out
        return out

    try:
        asyncio.get_event_loop().run_until_complete(go())
    finally:
        ch._LAST_FRAMED_BEAT_KEY.pop(owner, None)
    return rounds, belts, forced, executed




_NAP_OK = {"output": json.dumps({"ok": True, "slept": 1, "timeOfDay": "afternoon"}), "exit_code": 0}
_NAP_REFUSED = {"output": json.dumps({"ok": False, "reason": "evening", "why": "It is too late for a nap.", "slept": 0}), "exit_code": 0}


def test_loop_runs_the_nap_itself_when_the_player_clearly_naps_and_counts_an_applied_nap(monkeypatch):
    rounds, belts, _, executed = _drive(monkeypatch, text="I take a nap for two hours.", model=DEEPSEEK, nap_result=_NAP_OK)
    assert executed == ["nap"]                          # exactly once, via the dispatcher
    assert rounds[0]["n_system"] == 2                   # the original system prompt + the production note that voices the result
    assert belts.get("nap-direct") == 1


def test_a_refused_nap_is_run_once_but_counts_nothing(monkeypatch):
    rounds, belts, _, executed = _drive(monkeypatch, text="I take a nap.", model=DEEPSEEK, nap_result=_NAP_REFUSED)
    assert executed == ["nap"]
    assert "nap-direct" not in belts                    # success-gated: an engine refusal is never a belt fire


def test_the_belt_passes_the_players_length_to_the_lever(monkeypatch):
    seen = []
    import src.agent_loop as al
    real_drive = _drive
    rounds, belts, _, executed = real_drive(monkeypatch, text="I'll take a nap for 2 hours.", model=DEEPSEEK, nap_result=_NAP_OK, capture_blocks=seen)
    assert executed == ["nap"]
    assert json.loads(seen[0].content) == {"hours": 2.0}


def test_no_length_in_the_words_means_no_hours_arg(monkeypatch):
    seen = []
    _drive(monkeypatch, text="I take a nap.", model=DEEPSEEK, nap_result=_NAP_OK, capture_blocks=seen)
    assert json.loads(seen[0].content) == {}


def test_the_model_cannot_nap_the_player_twice_in_one_turn(monkeypatch):
    rounds, belts, _, executed = _drive(monkeypatch, text="I take a nap.", model=DEEPSEEK, nap_result=_NAP_OK,
                                        scripts=[{"deltas": ["You wake."]}])
    assert executed == ["nap"]
    assert all("nap" not in r["tools"] for r in rounds)   # the lever is off the wire once the FE has run (or the engine has refused) the turn's nap


@pytest.mark.parametrize("text", ["I can't take a nap.", "Do you want to take a nap?", "She takes a nap.", "I'm not going to nap.", "Goodnight everyone."])
def test_the_belt_never_runs_a_nap_for_talk_about_naps(monkeypatch, text):
    rounds, belts, _, executed = _drive(monkeypatch, text=text, model=DEEPSEEK, nap_result=_NAP_OK)
    assert "nap" not in executed and "nap-direct" not in belts


# -- the five-place wiring + the diegetic beat + g15 -------------------------------------------------------------------------------------
def test_nap_is_wired_in_all_five_places():
    import importlib
    tool_impl = importlib.import_module("src.tool_implementations")
    agent_tools = importlib.import_module("src.agent_tools")
    tool_schemas = importlib.import_module("src.tool_schemas")
    schemas = {t["function"]["name"] for t in tool_schemas.FUNCTION_TOOL_SCHEMAS if isinstance(t, dict) and t.get("type") == "function"}
    assert "nap" in schemas and "nap" in tool_schemas.ORWELL_GAME_TOOLS                       # 1. schema + ORWELL_GAME_TOOLS
    assert "nap" in agent_tools.TOOL_TAGS and "nap" in agent_tools.GAME_TOOL_KEEP             # 2. tags + keep set
    from src import orwell_engine
    assert callable(orwell_engine.nap)                                                          # 3. the engine wrapper
    import inspect
    from src import tool_execution
    assert 'tool == "nap"' in inspect.getsource(tool_execution)                                 # 4. the dispatch branch
    assert callable(tool_impl.do_nap)                                                           # 5. the impl


def test_the_beat_label_and_g15_gamechanged_cover_nap():
    import os
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    beats = open(os.path.join(root, "static", "js", "orwellToolBeats.js"), encoding="utf-8").read()
    assert "'nap':" in beats
    platform = open(os.path.join(root, "static", "js", "platform.js"), encoding="utf-8").read()
    assert "'nap'" in platform                                                                  # the g15 mutation set (orwellGameChanged follows a nap)


def test_do_nap_passes_the_players_hours_and_the_sync_spine(monkeypatch):
    from src import orwell_engine
    from src import tool_implementations as ti
    got = {}

    async def fake_nap(hours=None, expected_beat_seq=None, idempotency_key=None, user=None):
        got.update(hours=hours, ebs=expected_beat_seq, ik=idempotency_key)
        return {"ok": True, "slept": hours or 1}

    monkeypatch.setattr(orwell_engine, "nap", fake_nap)
    out = asyncio.get_event_loop().run_until_complete(ti.do_nap(json.dumps({"hours": 2}), owner="orw417-do"))
    assert json.loads(out["output"])["slept"] == 2 and got["hours"] == 2
    out = asyncio.get_event_loop().run_until_complete(ti.do_nap("{}", owner="orw417-do"))
    assert got["hours"] is None and out["exit_code"] == 0


def test_engine_wrapper_calls_the_nap_tool_with_the_right_args(monkeypatch):
    from src import orwell_engine
    sent = {}

    async def fake_call(tool, args, user=None):
        sent.update(tool=tool, args=args)
        return {"ok": True}

    monkeypatch.setattr(orwell_engine, "_call", fake_call)
    asyncio.get_event_loop().run_until_complete(orwell_engine.nap(hours=1.5, expected_beat_seq=4, idempotency_key="k", user="u"))
    assert sent == {"tool": "nap", "args": {"hours": 1.5, "expectedBeatSeq": 4, "idempotencyKey": "k"}}
    asyncio.get_event_loop().run_until_complete(orwell_engine.nap(user="u"))
    assert sent["args"] == {}
