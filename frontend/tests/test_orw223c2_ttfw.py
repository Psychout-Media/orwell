"""ORW-223 part C, slice C2 - time-to-first-word (TTFW) logging.

Stubbed LLM, no network, no engine. Roles only (planted tokens stand in for names). 
"""
import asyncio
import copy
import json

import pytest

pytestmark = pytest.mark.usefixtures("non_game_text_routing")

OR_URL = "https://openrouter.ai/api/v1/chat/completions"
GLM = "z-ai/glm-4.7"
NAME_A, NAME_B, NARR = "ZqRoleAlpha", "ZqRoleBeta", "ZqNarrationToken"

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
    from src import orwell_ttfw as sps
    monkeypatch.setenv("ORWELL_TTFW_FILE", str(tmp_path / "ttfw.jsonl"))
    sps.clear_ring()
    yield tmp_path / "ttfw.jsonl"
    sps.clear_ring()


def _lines(path):
    return [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []


# ── the loop, driven for real with a scripted narrator and a stubbed utility model ───────────────
def _drive(monkeypatch, *, text="So, what do you think about the week?", state=None, narr=None):
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
    async def fake_llm(*a, **k):
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
    return out, seen_msgs


# ── TTFW logging ─────────────────────────────────────────────────────────────────────────────────
def test_ttfw_line_is_written_with_no_flag_set(monkeypatch, _env):
    _drive(monkeypatch)
    ls = _lines(_env)
    assert len(ls) == 1
    L = ls[0]
    assert set(L) == {"ts", "sid", "ttfw_ms"}
    assert isinstance(L["ttfw_ms"], int) and L["ttfw_ms"] >= 0
    assert isinstance(L["sid"], str) and len(L["sid"]) == 10


def test_jsonl_holds_no_names_or_text(monkeypatch, _env):
    _drive(monkeypatch, text=f"Hey {NAME_A}, {NAME_B}, what about the week?")
    raw = _env.read_text()
    for tok in (NAME_A, NAME_B, NARR, "sess-1", "orw223c2", "kitchen"):
        assert tok not in raw, tok


def test_narrator_chunks_are_byte_identical_across_runs(monkeypatch):
    out1, msgs1 = _drive(monkeypatch)
    out2, msgs2 = _drive(monkeypatch)
    assert out1 == out2 and msgs1 == msgs2
    assert any(NARR in c for c in out1)


def test_a_failing_write_never_changes_the_turn(monkeypatch, _env):
    out_ok, _ = _drive(monkeypatch)
    monkeypatch.setenv("ORWELL_TTFW_FILE", str(_env.parent / "a-file" / "x" / "ttfw.jsonl"))
    (_env.parent / "a-file").write_text("not a directory")
    out_bad, _ = _drive(monkeypatch)
    assert out_bad == out_ok


def test_end_turn_never_raises_even_when_the_path_cannot_resolve(monkeypatch):
    from src import orwell_ttfw as t
    monkeypatch.setattr(t, "jsonl_path", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    rec = t.TurnRecord("s")
    rec.first_word()
    assert t.end_turn(rec) is not None


def test_ttfw_is_measured_from_the_injected_clock():
    from src import orwell_ttfw as sps
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


def test_a_turn_with_no_narration_writes_nothing(_env):
    from src import orwell_ttfw as sps
    rec, tok = sps.begin_turn("s")
    sps.end_turn(rec, tok)
    assert _lines(_env) == []


def test_ring_is_bounded_and_records_the_line(monkeypatch, _env):
    from src import orwell_ttfw as sps
    _drive(monkeypatch)
    assert len(sps.ring()) == 1 and sps.ring()[0]["ttfw_ms"] is not None
    assert sps.RING_MAX == 200
