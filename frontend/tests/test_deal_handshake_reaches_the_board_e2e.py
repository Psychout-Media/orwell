"""Deal-on-the-board, END TO END at turn grain (no LLM spend): the real `stream_agent_loop` + the real
`_auto_record_deal` belt. The A-12 probe found the narrator often gathers (npcVoice / recordInteraction) and never
calls makeDeal. This proves the safety net: a turn where the player completes a handshake and the narrator calls
ONLY npcVoice + recordInteraction ends with the deal made (once, with the right partner), and that no deal is
fabricated when no handshake happened (loose talk / no deal language) or when the model made the deal itself.
Only the LLM (stream + extraction) and the engine calls are stubbed. Roles only."""
import asyncio
import json
import os

import pytest

ROSTER = [{"id": "npc:1", "name": "Contestant Alpha", "status": "active"},
          {"id": "npc:2", "name": "Contestant Beta", "status": "active"}]
HANDSHAKE = ("Contestant Alpha looks you dead in the eye and takes your hand. \"You have my word,\" they say. "
             "\"We have a deal — neither of us puts the other up.\" The handshake holds a beat too long.")
LOOSE = "Contestant Alpha shrugs and says they will think about it, maybe, sometime later in the week."


@pytest.fixture(autouse=True)
def _reset():
    from src import agent_loop as al
    for name in ("_SILENT_FORCE_ADVANCE_STREAK", "_ADVANCE_STALL_LEVEL", "_ADVANCE_STALL_FLAGS",
                 "_TURNS_SINCE_PROGRESS", "_ANTI_STALE_CAP_HOLDS", "_LOOP_STREAK"):
        d = getattr(al, name, None)
        if isinstance(d, dict):
            d.clear()
    yield


def _tool_calls(*names):
    calls = []
    for i, n in enumerate(names):
        args = {"npcVoice": {"npcId": "npc:1"},
                "recordInteraction": {"content": "talked", "withIds": ["npc:1"]},
                "makeDeal": {"with": "npc:1", "kind": "safety", "terms": "neither nominates the other"}}[n]
        calls.append({"id": f"c{i}", "name": n, "arguments": json.dumps(args)})
    return 'data: ' + json.dumps({"type": "tool_calls", "calls": calls}) + '\n\n'


def _turn(monkeypatch, *, round1_tools, narration, extraction, user_msg):
    from src import agent_loop as al
    import src.orwell_engine as oe
    import src.llm_core as llm_core
    import src.tool_index as ti

    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)
    monkeypatch.setattr(al, "_loop_break_streak_update", lambda *a, **k: False)

    async def fake_state(owner=None, **_k):
        return {"phase": "free-time", "moment": "social", "week": 2, "beatSeq": 5, "pending": None,
                "house": ROSTER, "started": True}

    monkeypatch.setattr(oe, "get_game_state", fake_state)
    deals = []

    async def fake_make_deal(with_id, kind, terms, *a, **k):
        deals.append({"with": with_id, "kind": kind, "terms": terms})
        return {"id": f"deal:{len(deals)}"}

    monkeypatch.setattr(oe, "make_deal", fake_make_deal)

    async def fake_llm(*a, **k):  # the belt's constrained extraction
        return extraction

    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)

    async def fake_record(*a, **k):  # the generic scene belt is out of scope here
        return False

    monkeypatch.setattr(al, "_auto_record_scene", fake_record)

    async def fake_exec(block, **k):  # the narrator's own tool calls (gathering / scene log), never a deal
        if block.tool_type == "makeDeal":
            await oe.make_deal("npc:1", "safety", "model-made")
        return block.tool_type, {"output": "{}", "exit_code": 0}

    monkeypatch.setattr(al, "execute_tool_block", fake_exec)
    monkeypatch.setattr(al, "_note_belt", lambda *a, **k: None)

    rounds = {"n": 0}

    async def fake_stream(candidates, messages, **kwargs):
        rounds["n"] += 1
        if rounds["n"] == 1 and round1_tools:
            yield _tool_calls(*round1_tools)
            yield 'data: ' + json.dumps({"type": "finish", "reason": "tool_calls"}) + '\n\n'
        else:
            yield 'data: ' + json.dumps({"delta": narration}) + '\n\n'
            yield 'data: ' + json.dumps({"type": "finish", "reason": "stop"}) + '\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    async def drive():
        gen = al.stream_agent_loop(
            "https://api.deepseek.com/chat/completions", "deepseek-flash",
            [{"role": "system", "content": "You are the narrator."}, {"role": "user", "content": user_msg}],
            max_rounds=4, game_mode="game", owner="u")
        async for _ in gen:
            pass

    asyncio.new_event_loop().run_until_complete(drive())
    return deals


STRUCK = '{"struck":true,"withId":"npc:1","kind":"safety","terms":"neither nominates the other"}'
SHAKE_MSG = "Contestant Alpha, I won't put you up and you won't put me up. Shake on it."


def test_handshake_with_only_gathering_tools_still_puts_the_deal_on_the_board(monkeypatch):
    deals = _turn(monkeypatch, round1_tools=("npcVoice", "recordInteraction"), narration=HANDSHAKE,
                  extraction=STRUCK, user_msg=SHAKE_MSG)
    assert len(deals) == 1, f"the back-fill must make exactly one deal, got {deals}"
    assert deals[0]["with"] == "npc:1" and deals[0]["kind"] == "safety"


def test_no_deal_language_in_the_scene_creates_no_deal(monkeypatch):
    deals = _turn(monkeypatch, round1_tools=("npcVoice",), narration=LOOSE,
                  extraction=STRUCK, user_msg="Contestant Alpha, want to work together sometime?")
    assert deals == [], "a scene with no handshake language must never reach the extractor, let alone bind a deal"


def test_loose_talk_with_deal_words_is_refused_by_the_extractor(monkeypatch):
    deals = _turn(monkeypatch, round1_tools=("npcVoice",), narration=HANDSHAKE,
                  extraction='{"struck":false,"withId":"npc:1","kind":"safety","terms":"maybe someday"}',
                  user_msg="Contestant Alpha, maybe we could have a deal someday?")
    assert deals == [], "struck=false (a one-sided pitch / maybe) must never create a deal"


def test_a_model_made_deal_is_not_doubled_by_the_belt(monkeypatch):
    deals = _turn(monkeypatch, round1_tools=("makeDeal",), narration=HANDSHAKE,
                  extraction=STRUCK, user_msg=SHAKE_MSG)
    assert len(deals) == 1, f"model-driven makeDeal wins; the belt must not add a second one, got {deals}"
