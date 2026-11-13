"""ORW-223 part C, slice C2 - the shadow PLAN call + the time-to-first-word measurement.

Stubbed LLM, no network, no engine. Roles only (planted tokens stand in for names). The plan is LOGGED ONLY: the narrator turn is
byte-identical with the flag on or off.
"""
import asyncio
import copy
import json

import pytest

pytestmark = pytest.mark.usefixtures("non_game_text_routing")

OR_URL = "https://openrouter.ai/api/v1/chat/completions"
GLM = "z-ai/glm-4.7"
NAME_A, NAME_B, NARR = "ZqRoleAlpha", "ZqRoleBeta", "ZqNarrationToken"

PLAN = {"participants": ["npc:1"], "act": "talk",
        "effects": [{"type": "record", "withIds": ["npc:1"], "kind": "bonding"}]}


def _state(**over):
    st = {"started": True, "finished": False, "moment": "social", "phase": "hoh", "timeOfDay": "afternoon",
          "clockLabel": "3:00pm, Day 2", "pending": None, "beatSeq": 7, "player": {"id": "player"},
          "house": [{"id": "npc:1", "name": NAME_A, "status": "active"}, {"id": "npc:2", "name": NAME_B, "status": "active"}],
          "whereabouts": {"room": "kitchen", "present": [{"id": "npc:1", "name": NAME_A}]},
          "asleep": [], "ceremony": {"hoh": None, "nominees": [], "veto": {}}}
    st.update(over)
    return st


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    from src import orwell_scene_plan_shadow as sps
    monkeypatch.setenv("ORWELL_SCENE_PLAN_SHADOW_FILE", str(tmp_path / "scene_plan_shadow.jsonl"))
    monkeypatch.delenv("ORWELL_SCENE_PLAN_SHADOW", raising=False)
    monkeypatch.delenv("ORWELL_FLAGS_OFF", raising=False)
    sps.clear_ring()
    yield tmp_path / "scene_plan_shadow.jsonl"
    sps.clear_ring()


def _lines(path):
    return [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []


# ── the loop, driven for real with a scripted narrator and a stubbed utility model ───────────────
def _drive(monkeypatch, *, text="So, what do you think about the week?", state=None, plan_reply=None, plan_exc=None, narr=None):
    from src import agent_loop as al
    from src import orwell_engine as oe
    import src.tool_index as ti
    import src.llm_core as lc

    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)
    monkeypatch.setattr(oe, "_RETRY_ATTEMPTS", 0)
    st = state if state is not None else _state()

    async def fake_status(user=None):
        return {"timeOfDay": st.get("timeOfDay"), "pending": None, "started": True}

    async def fake_state(user=None, timeout=None):
        return copy.deepcopy(st)

    monkeypatch.setattr(oe, "game_status", fake_status)
    monkeypatch.setattr(oe, "get_game_state", fake_state)

    seen_msgs: list = []

    async def fake_stream(candidates, messages, **kwargs):
        seen_msgs.append(copy.deepcopy(messages))
        for d in (narr or [f"Hello {NARR}.", " More."]):
            yield f'data: {json.dumps({"delta": d})}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)
    calls: list = []

    async def fake_llm(*a, **k):
        calls.append(k.get("call_class"))
        if k.get("call_class") == "scene-plan":
            if plan_exc is not None:
                raise plan_exc
            return plan_reply if plan_reply is not None else json.dumps(PLAN)
        return ""

    monkeypatch.setattr(lc, "llm_call_async", fake_llm)

    async def go():
        out = []
        async for chunk in al.stream_agent_loop(
                OR_URL, GLM, [{"role": "system", "content": "narrator"}, {"role": "user", "content": text}],
                max_rounds=2, game_mode="game", owner="orw223c2", session_id="sess-1", pinned_tools={"advanceGame"}):
            out.append(chunk)
        return out

    out = asyncio.get_event_loop().run_until_complete(go())
    # wall-clock timing telemetry differs run to run by construction; everything else must match byte for byte
    out = [c for c in out if '"agent_prep"' not in c and '"metrics"' not in c]
    return out, seen_msgs, calls


# ── flag handling ────────────────────────────────────────────────────────────────────────────────
def test_off_by_default_no_plan_call_but_ttfw_line_still_written(monkeypatch, _env):
    out, _, calls = _drive(monkeypatch)
    assert "scene-plan" not in calls
    ls = _lines(_env)
    assert len(ls) == 1
    L = ls[0]
    assert L["flag"] == "off" and L["plan_ms"] is None and L["plan_ok"] is None and L["agree"] is None
    assert isinstance(L["ttfw_ms"], int) and L["ttfw_ms"] >= 0
    assert L["rejections"] == [] and L["effects"] == [] and L["participants_n"] is None


def test_flags_off_profile_forces_the_shadow_off(monkeypatch, _env):
    monkeypatch.setenv("ORWELL_SCENE_PLAN_SHADOW", "1")
    monkeypatch.setenv("ORWELL_FLAGS_OFF", "1")
    _, _, calls = _drive(monkeypatch)
    assert "scene-plan" not in calls
    L = _lines(_env)[0]
    assert L["flag"] == "off" and L["plan_ok"] is None and L["ttfw_ms"] is not None


def test_on_runs_one_plan_call_and_logs_codes_only(monkeypatch, _env):
    monkeypatch.setenv("ORWELL_SCENE_PLAN_SHADOW", "1")
    _, _, calls = _drive(monkeypatch)
    assert calls.count("scene-plan") == 1
    L = _lines(_env)[0]
    assert L["flag"] == "on" and L["gate"] == "engaged" and L["plan_ok"] is True
    assert L["effects"] == ["record"] and L["participants_n"] == 1 and L["rejections"] == []
    assert isinstance(L["plan_ms"], int) and isinstance(L["ttfw_ms"], int)
    assert L["ttfw_ms"] >= 0 and L["beat"] == 7
    assert set(L) == {"ts", "sid", "beat", "flag", "gate", "ttfw_ms", "plan_ms", "plan_ok", "plan_err", "rejections",
                      "participants_n", "effects", "agree"}


def test_jsonl_holds_no_names_or_text(monkeypatch, _env):
    monkeypatch.setenv("ORWELL_SCENE_PLAN_SHADOW", "1")
    plan = {**PLAN, "note": f"{NAME_A} said {NARR}"}
    _drive(monkeypatch, plan_reply=json.dumps(plan), text=f"Hey {NAME_A}, {NAME_B}, what about the week?")
    raw = _env.read_text()
    for tok in (NAME_A, NAME_B, NARR, "sess-1", "orw223c2", "kitchen"):
        assert tok not in raw, tok


# ── the narrator is untouched ────────────────────────────────────────────────────────────────────
def test_narrator_turn_is_byte_identical_flag_on_vs_off(monkeypatch):
    out_off, msgs_off, _ = _drive(monkeypatch)
    monkeypatch.setenv("ORWELL_SCENE_PLAN_SHADOW", "1")
    out_on, msgs_on, calls = _drive(monkeypatch)
    assert calls.count("scene-plan") == 1
    assert out_on == out_off
    assert msgs_on == msgs_off


@pytest.mark.parametrize("kind", ["raise", "garbage", "empty"])
def test_failing_or_garbage_llm_never_changes_the_turn(monkeypatch, _env, kind):
    out_off, msgs_off, _ = _drive(monkeypatch)
    monkeypatch.setenv("ORWELL_SCENE_PLAN_SHADOW", "1")
    kw = {"plan_exc": RuntimeError("boom")} if kind == "raise" else {"plan_reply": "not json at all" if kind == "garbage" else ""}
    out_on, msgs_on, calls = _drive(monkeypatch, **kw)
    assert calls.count("scene-plan") == 1
    assert out_on == out_off and msgs_on == msgs_off
    L = [x for x in _lines(_env) if x["flag"] == "on"][0]
    assert L["plan_ok"] is False and L["plan_err"] and L["ttfw_ms"] is not None
    assert NARR not in _env.read_text()


# ── the engaged-scene gate ───────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("text,state,reason", [
    ("next", None, "progress-only"),
    ("((quick question, what day is it?))", None, "ooc"),
    ("I sleep.", None, "go-to-bed"),
    ("", None, "empty"),
    ("So what do you think?", {"casting": {"step": "name"}}, "casting"),
    ("So what do you think?", {"moment": "casting"}, "casting"),
    ("So what do you think?", {"pending": {"kind": "veto-use"}}, "pending"),
    ("So what do you think?", {"started": False}, "not-started"),
    ("So what do you think?", {"finished": True}, "finished"),
    ("So what do you think?", {"asleep": [{"id": "npc:1", "name": NAME_A}]}, "nobody-awake"),
    ("So what do you think?", {"whereabouts": {"room": "kitchen", "present": []}}, "nobody-awake"),
    ("So what do you think?", {"whereabouts": None}, "nobody-awake"),
])
def test_gate_stands_down(text, state, reason):
    from src import orwell_scene_plan_shadow as sps
    ok, why = sps.engaged_scene_gate(text, _state(**(state or {})))
    assert (ok, why) == (False, reason)


def test_gate_engages_on_a_real_scene_turn():
    from src import orwell_scene_plan_shadow as sps
    assert sps.engaged_scene_gate("So what do you think about the week?", _state()) == (True, "engaged")


@pytest.mark.parametrize("text,state", [
    ("next", None), ("I sleep.", None), ("((ooc aside))", None),
    ("hello there friend", {"pending": {"kind": "comp-round"}}),
    ("hello there friend", {"asleep": [{"id": "npc:1", "name": NAME_A}]}),
])
def test_loop_makes_no_plan_call_when_the_gate_stands_down(monkeypatch, _env, text, state):
    monkeypatch.setenv("ORWELL_SCENE_PLAN_SHADOW", "1")
    _, _, calls = _drive(monkeypatch, text=text, state=_state(**(state or {})))
    assert "scene-plan" not in calls
    L = _lines(_env)[0]
    assert L["plan_ok"] is None and L["plan_ms"] is None and L["ttfw_ms"] is not None and L["gate"] != "engaged"


# ── the plan flows through parse / check ─────────────────────────────────────────────────────────
_UNSET = object()


def _run(llm, state=_UNSET, text="So what do you think about the week?", **kw):
    from src import orwell_scene_plan_shadow as sps
    rec = sps.TurnRecord("s")
    asyncio.get_event_loop().run_until_complete(sps.run_shadow_plan(rec, text, _state() if state is _UNSET else state, llm, **kw))
    return rec


def test_checker_rejections_are_logged_as_codes_and_the_plan_is_trimmed():
    async def llm(msgs, mt, temp, tmo):
        return json.dumps({"participants": ["npc:1", "npc:2", "npc:99"], "act": "talk", "effects": [
            {"type": "record", "withIds": ["npc:1"], "kind": "bonding"}]})
    rec = _run(llm)
    assert rec.plan_ok is True
    assert "unknown-id" in rec.rejections and "participant-absent" in rec.rejections
    assert rec.plan_participants == ["npc:1"]
    assert all(isinstance(c, str) and " " not in c for c in rec.rejections)


def test_prompt_is_vault_free_and_carries_schema_and_present_ids():
    seen = {}

    async def llm(msgs, mt, temp, tmo):
        seen.update(msgs=msgs, mt=mt, temp=temp, tmo=tmo)
        return json.dumps(PLAN)
    _run(llm)
    blob = json.dumps(seen["msgs"])
    assert "npc:1" in blob and "participants" in blob and "additionalProperties" in blob or "properties" in blob
    assert (seen["mt"], seen["temp"], seen["tmo"]) == (400, 0.2, 12.0)
    assert "ASLEEP" in blob


def test_slow_llm_times_out_softly():
    from src import orwell_scene_plan_shadow as sps

    async def slow(msgs, mt, temp, tmo):
        await asyncio.sleep(5)
        return "{}"
    rec = _run(slow, timeout_s=0.05)
    assert rec.plan_ok is False and rec.plan_err == "timeout" and isinstance(rec.plan_ms, int)


def test_state_with_garbage_never_raises():
    async def llm(msgs, mt, temp, tmo):
        return json.dumps(PLAN)
    for bad in (None, [], "x", {"whereabouts": 5, "house": "x", "asleep": 3}):
        rec = _run(llm, state=bad)
        assert rec.plan_ok is None


# ── agreement and TTFW ───────────────────────────────────────────────────────────────────────────
def test_agree_measures_against_the_existing_extraction():
    from src.orwell_scene_plan_shadow import compute_agree
    assert compute_agree(["npc:1", "npc:2"], ["bonding"], {"ids": ["npc:1"], "kind": "bonding"}) == \
        {"participants_match": 0.5, "record_kind_match": True}
    assert compute_agree(["npc:1"], ["conflict"], {"ids": ["npc:1"], "kind": "bonding"})["record_kind_match"] is False
    assert compute_agree(["npc:1"], [], {"ids": ["npc:1"], "kind": "bonding"})["record_kind_match"] is None
    assert compute_agree(["npc:1"], ["bonding"], None) is None
    assert compute_agree(["npc:1"], ["bonding"], {"ids": [], "kind": None}) is None


def test_line_carries_agree_when_the_extraction_ran():
    from src import orwell_scene_plan_shadow as sps

    async def llm(msgs, mt, temp, tmo):
        return json.dumps(PLAN)

    async def go():
        rec, tok = sps.begin_turn("s")
        await sps.run_shadow_plan(rec, "So what do you think about the week?", _state(), llm)
        sps.note_extraction(["npc:1"], "bonding")
        return sps.end_turn(rec, tok)

    # no first word and plan ran => still written
    line = asyncio.get_event_loop().run_until_complete(go())
    assert line["agree"] == {"participants_match": 1.0, "record_kind_match": True}


def test_ttfw_is_measured_from_the_injected_clock():
    from src import orwell_scene_plan_shadow as sps
    t = [100.0]
    rec = sps.TurnRecord("s", clock=lambda: t[0])
    sps.note_stream_event(rec, 'data: {"delta": "   "}\n\n')              # blank: not a word
    sps.note_stream_event(rec, 'data: {"delta": "hmm", "thinking": true}\n\n')  # reasoning: not what the player sees
    sps.note_stream_event(rec, 'data: {"type": "tool_start", "tool": "x"}\n\n')
    assert rec.ttfw_ms is None
    t[0] = 101.234
    sps.note_stream_event(rec, 'data: {"delta": "Hello"}\n\n')
    t[0] = 150.0
    sps.note_stream_event(rec, 'data: {"delta": "later"}\n\n')           # only the first counts
    assert rec.ttfw_ms == 1234


def test_ring_is_bounded_and_records_the_line(monkeypatch, _env):
    from src import orwell_scene_plan_shadow as sps
    _drive(monkeypatch)
    assert len(sps.ring()) == 1 and sps.ring()[0]["ttfw_ms"] is not None
    assert sps.RING_MAX == 200
