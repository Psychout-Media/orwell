"""ORW-408 (rewrite slice): the quiet sentence-level rewrite in the live game stream. A sentence that contradicts an engine hard fact is never emitted; ONE continuation call
re-voices from the text already shown; a still-conflicting redo sentence is dropped whole; stored text equals what was streamed. Stubbed model, no network, roles only."""
import asyncio
import json

import pytest

pytestmark = [pytest.mark.usefixtures("non_game_text_routing"), pytest.mark.usefixtures("zero_clocks_off")]

OR_URL = "https://openrouter.ai/api/v1/chat/completions"
STATE = {"asleep": [{"name": "Sleeper Role"}], "daySchedule": {"next": "nominations", "tomorrow": True}}
CLEAN_A = "The kitchen is quiet. "
BAD = 'Sleeper Role says, "Morning, everyone." '
TAIL = "The kettle clicks off. "
REDO = "Everyone else keeps their voices low. "



@pytest.fixture(autouse=True)
def _rewrite_on(monkeypatch):
    """The rewrite ships OFF by default; these tests exercise it, so turn it on (a test that needs it off sets the flag itself)."""
    monkeypatch.setenv("ORWELL_PREDISPLAY_REWRITE", "1")

def _drive(monkeypatch, *, rounds_scripts, redo="", state=STATE, tool_calls=None, flag=None, owner="orw408"):
    """Returns (emitted_text, continuation_calls, stored_round_texts, n_rounds)."""
    from src import agent_loop as al
    from src import orwell_engine as oe
    from src import engine_read_cache as erc
    from routes import chat_helpers as ch
    import src.tool_index as ti
    import src.llm_core as lc

    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    if flag is not None:
        monkeypatch.setenv("ORWELL_PREDISPLAY_REWRITE", flag)
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)
    monkeypatch.setattr(erc, "peek", lambda name, user, max_age_s=30.0: state)
    monkeypatch.setattr(oe, "_RETRY_ATTEMPTS", 0)

    async def fake_status(user=None):
        return {"timeOfDay": "morning", "pending": None, "started": True}
    monkeypatch.setattr(oe, "game_status", fake_status)

    scripts = list(rounds_scripts)
    stream_calls = []

    async def fake_stream(candidates, messages, **kwargs):
        stream_calls.append(1)
        sc = scripts.pop(0) if scripts else {"deltas": ["done."]}
        for d in sc.get("deltas", []):
            yield f'data: {json.dumps({"delta": d})}\n\n'
        if sc.get("calls"):
            yield f'data: {json.dumps({"type": "tool_calls", "calls": sc["calls"]})}\n\n'
        yield "data: [DONE]\n\n"
    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    cont_calls = []

    async def fake_llm(*a, **k):
        msgs = k.get("messages") or (a[2] if len(a) > 2 else [])
        if any(m.get("role") == "system" and "CONTINUITY CORRECTION" in str(m.get("content")) for m in msgs):
            cont_calls.append(msgs)
            return redo
        return ""
    monkeypatch.setattr(lc, "llm_call_async", fake_llm)

    async def fake_exec(block, **kw):
        return block.tool_type, {"output": "{}", "exit_code": 0}
    monkeypatch.setattr(al, "execute_tool_block", fake_exec)

    stored = []
    real_persist = getattr(al._persisted_round_text, "_orig", al._persisted_round_text)

    def spy(cleaned, **kw):
        stored.append(cleaned)
        return real_persist(cleaned, **kw)
    spy._orig = real_persist
    monkeypatch.setattr(al, "_persisted_round_text", spy)

    async def go():
        out = []
        async for chunk in al.stream_agent_loop(
            OR_URL, "z-ai/glm-4.7",
            [{"role": "system", "content": "narrator"}, {"role": "user", "content": "I wait."}],
            max_rounds=3, game_mode="game", owner=owner, pinned_tools={"advanceGame"},
        ):
            out.append(chunk)
        return out
    try:
        chunks = asyncio.get_event_loop().run_until_complete(go())
    finally:
        ch._LAST_FRAMED_BEAT_KEY.pop(owner, None)
    emitted = ""
    for c in chunks:
        if c.startswith("data: ") and "[DONE]" not in c:
            try:
                emitted += json.loads(c[6:]).get("delta", "") or ""
            except Exception:
                pass
    return emitted, cont_calls, stored, len(stream_calls)


def test_conflicting_sentence_is_never_emitted_and_one_continuation_is_made(monkeypatch):
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, BAD, TAIL]}], redo=REDO.strip())
    assert "Sleeper Role says" not in emitted and "Morning, everyone" not in emitted
    assert TAIL.strip() not in emitted, "the rest of the original stream is never shown"
    assert emitted.strip() == (CLEAN_A + REDO).strip()
    assert len(cont) == 1
    sysmsg = [m for m in cont[0] if m["role"] == "system"][-1]["content"]
    assert "Sleeper Role is asleep and cannot speak or act" in sysmsg
    assert {"role": "assistant", "content": CLEAN_A.strip()} in [{**m, "content": m["content"].strip()} for m in cont[0] if m["role"] == "assistant"]


def test_emitted_text_equals_stored_round_text(monkeypatch):
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, BAD, TAIL]}], redo=REDO.strip())
    assert stored and stored[0] == emitted.strip()
    assert "Sleeper" not in stored[0] and TAIL.strip() not in stored[0]


def test_conflict_in_first_sentence_still_equal_live_and_stored(monkeypatch):
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [BAD, TAIL]}], redo=REDO.strip())
    assert len(cont) == 1 and emitted.strip() == REDO.strip() and stored[0] == emitted.strip()
    assert not any(m["role"] == "assistant" for m in cont[0])  # nothing shown yet: no partial reply


def test_clean_reply_makes_no_extra_call_and_is_byte_identical_to_flag_off(monkeypatch):
    script = [{"deltas": [CLEAN_A, TAIL, "Someone laughs."]}]
    on, cont_on, stored_on, rounds_on = _drive(monkeypatch, rounds_scripts=script, redo="X", owner="orw408-on")
    off, cont_off, stored_off, rounds_off = _drive(monkeypatch, rounds_scripts=script, redo="X", flag="0", owner="orw408-off")
    assert cont_on == [] and cont_off == []
    assert on == off == CLEAN_A + TAIL + "Someone laughs." and stored_on == stored_off and rounds_on == rounds_off


def test_flag_off_emits_conflict_as_today(monkeypatch):
    emitted, cont, _, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, BAD, TAIL]}], redo=REDO, flag="0")
    assert cont == [] and "Sleeper Role says" in emitted


def test_redo_sentence_that_still_conflicts_is_dropped_whole(monkeypatch):
    redo = REDO + 'Sleeper Role says, "Still here." ' + "A door closes softly."
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, BAD, TAIL]}], redo=redo)
    assert len(cont) == 1, "at most one rewrite per turn"
    assert "Sleeper" not in emitted and "Still here" not in emitted
    assert emitted.strip() == (CLEAN_A + REDO + "A door closes softly.").strip()
    assert stored[0] == emitted.strip() and "  " not in stored[0]


def test_round_with_tool_markup_in_the_stream_is_skipped_safely(monkeypatch):
    # the tool-call opener is already in the round when the conflicting sentence is judged: no withhold, no continuation (today's behaviour)
    emitted, cont, stored, _ = _drive(
        monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A + BAD + '<tool_call>{"name": "advanceGame", "arguments": {}}</tool_call>']}], redo=REDO)
    assert cont == []


def test_native_tool_call_after_a_withheld_sentence_is_still_made(monkeypatch):
    calls = [{"name": "advanceGame", "arguments": "{}"}]
    emitted, cont, stored, n_rounds = _drive(
        monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, BAD, TAIL], "calls": calls}, {"deltas": ["The morning moves on."]}], redo=REDO.strip())
    assert len(cont) == 1 and "Sleeper Role says" not in emitted
    assert n_rounds >= 2, "the round's native tool call still ran and the loop went on to the next round"


def test_no_fresh_engine_state_skips(monkeypatch):
    emitted, cont, _, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, BAD, TAIL]}], redo=REDO, state=None)
    assert cont == [] and "Sleeper Role says" in emitted


def test_failed_continuation_ends_at_the_last_whole_sentence(monkeypatch):
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, BAD, TAIL]}], redo="")
    assert len(cont) == 1 and emitted.strip() == CLEAN_A.strip()
    assert stored[0] == emitted.strip()


# ── pure helpers ─────────────────────────────────────────────────────────────────────────────────
def test_split_names_the_fact_and_keeps_whole_sentences(monkeypatch):
    from src import predisplay_check as pc
    from src import engine_read_cache as erc
    monkeypatch.setattr(erc, "peek", lambda name, user, max_age_s=30.0: STATE)
    monkeypatch.setattr("src.zero_clocks.zero_clocks_on", lambda: True)
    sp = pc.split_at_first_conflict(CLEAN_A + "The nominations are tonight. " + TAIL, "u")
    assert sp.keep == CLEAN_A and sp.withheld.startswith("The nominations are tonight.")
    assert sp.conflicts[0].fact == pc.FACT_SCHEDULE
    msgs = pc.continuation_messages([{"role": "user", "content": "hi"}], sp.keep, sp.conflicts)
    assert "tomorrow, not today" in msgs[-1]["content"] and msgs[-2]["role"] == "assistant"
    sp2 = pc.split_at_first_conflict("It is 8:15 now. Fine.", "u")
    assert sp2.conflicts[0].fact == pc.FACT_CLOCK and "clock times" in pc.continuation_messages([], "", sp2.conflicts)[-1]["content"]


def test_split_is_none_without_fresh_state_and_never_raises(monkeypatch):
    from src import predisplay_check as pc
    from src import engine_read_cache as erc
    monkeypatch.setattr(erc, "peek", lambda name, user, max_age_s=30.0: None)
    assert pc.split_at_first_conflict(BAD, "u") is None
    monkeypatch.setattr(erc, "peek", lambda *a, **k: 1 / 0)
    assert pc.split_at_first_conflict(BAD, "u") is None



def test_the_rewrite_is_off_unless_asked_for(monkeypatch):
    """ORW-408: default OFF until the review findings are fixed (quoted speech across chunks, tool calls after a withhold, the silent wait)."""
    from src import predisplay_check as pc
    monkeypatch.delenv("ORWELL_PREDISPLAY_REWRITE", raising=False)
    monkeypatch.delenv("ORWELL_PREDISPLAY_CHECK", raising=False)
    assert pc.predisplay_rewrite_enabled() is False
    monkeypatch.setenv("ORWELL_PREDISPLAY_REWRITE", "1")
    assert pc.predisplay_rewrite_enabled() is True
