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

def _drive(monkeypatch, *, rounds_scripts, redo="", state=STATE, tool_calls=None, flag=None, owner="orw408", extra=None, status=None):
    """Returns (emitted_text, continuation_calls, stored_round_texts, n_rounds). `extra` (a dict) is filled with: runs (tool blocks executed), chunks (every raw SSE chunk), cont_kwargs,
    and may carry `redo_delay_s` (the stubbed continuation takes that long)."""
    extra = extra if extra is not None else {}
    extra.setdefault("runs", [])
    extra.setdefault("chunks", [])
    extra.setdefault("cont_kwargs", [])
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
    monkeypatch.setattr(erc, "peek", lambda name, user, max_age_s=30.0, fields=None: state)
    monkeypatch.setattr(oe, "_RETRY_ATTEMPTS", 0)

    async def fake_status(user=None):
        return dict(status) if status is not None else {"timeOfDay": "morning", "pending": None, "started": True}
    monkeypatch.setattr(oe, "game_status", fake_status)

    scripts = list(rounds_scripts)
    stream_calls = []

    async def fake_stream(candidates, messages, **kwargs):
        stream_calls.append(1)
        sc = scripts.pop(0) if scripts else {"deltas": ["done."]}
        for d in sc.get("deltas", []):
            yield f'data: {json.dumps({"delta": d})}\n\n'
        if sc.get("stall_s"):
            await asyncio.sleep(sc["stall_s"])
        if sc.get("calls"):
            yield f'data: {json.dumps({"type": "tool_calls", "calls": sc["calls"]})}\n\n'
        yield "data: [DONE]\n\n"
    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    cont_calls = []

    async def fake_llm(*a, **k):
        msgs = k.get("messages") or (a[2] if len(a) > 2 else [])
        if any("CONTINUITY CORRECTION" in str(m.get("content")) for m in msgs):
            cont_calls.append(msgs)
            extra["cont_kwargs"].append(k)
            if extra.get("redo_delay_s"):
                await asyncio.sleep(extra["redo_delay_s"])
            return redo
        return ""
    monkeypatch.setattr(lc, "llm_call_async", fake_llm)

    async def fake_exec(block, **kw):
        extra["runs"].append(block.tool_type)
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
    extra["chunks"] = chunks
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
    sysmsg = cont[0][-1]["content"]
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


TOOL = '<tool_call><invoke name="bash"><parameter name="command">echo hi</parameter></invoke></tool_call>'
TRUE3 = "The kitchen is quiet. Rain taps the glass. A cup is set down. "


def test_round_with_tool_markup_in_the_stream_makes_no_continuation_call(monkeypatch):
    # the tool-call opener is already in the round when the conflicting sentence is judged: no withhold and no continuation call is made (its own test: the old combined test was a non-enforcing xfail)
    _emitted, cont, _stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A + BAD + TOOL]}], redo=REDO)
    assert cont == []


def test_round_with_tool_markup_stores_exactly_what_was_shown(monkeypatch):
    """review of #2751 / ORW-453 ("save only what was shown"): the conflicting sentence is neither shown nor stored when a tool-call opener follows it in the same chunk."""
    emitted, _cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A + BAD + TOOL]}, {"deltas": ["The morning moves on."]}], redo=REDO)
    assert "Sleeper Role says" not in emitted and "Sleeper Role says" not in stored[0]
    assert stored[0] == emitted.split("The morning moves on.")[0].strip(), (stored, emitted)


@pytest.mark.parametrize("deltas,shown", [
    # an unfinished sentence held from an EARLIER chunk, then the opener (ORW-453 input 1)
    ([TRUE3 + "The kettle clicks off, and steam rises", TOOL], "The kitchen is quiet. Rain taps the glass. A cup is set down."),
    # the held space between sentences must survive the halt (ORW-453 input 2: it used to be lost)
    ([TRUE3, "The kettle clicks off. " + TOOL], "The kitchen is quiet. Rain taps the glass. A cup is set down. The kettle clicks off."),
    # the unfinished sentence and the opener arrive in ONE chunk
    ([TRUE3 + "The kettle clicks off, and steam rises" + TOOL], "The kitchen is quiet. Rain taps the glass. A cup is set down."),
])
def test_orw453_a_tool_call_opener_halts_the_stream_shown_equals_stored(monkeypatch, deltas, shown):
    extra = {}
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": deltas}, {"deltas": ["The morning moves on."]}], redo="X", extra=extra)
    assert emitted.startswith(shown), (emitted, shown)
    assert "steam rises" not in emitted
    assert stored[0] == shown == emitted[:len(shown)] and stored[0] == emitted.split("The morning moves on.")[0].strip(), (stored, emitted)
    assert cont == [] and extra["runs"] == ["bash"], "the tool call after the cut still ran exactly once"


def test_orw453_the_dotted_time_hold_followed_by_a_tool_call_stores_what_was_shown(monkeypatch):
    """the #2778 "3 a." hold, then a tool call: the held fragment is not shown and must not be stored (zero clocks ON)."""
    import src.settings as st
    real = st.get_setting
    monkeypatch.setattr(st, "get_setting", lambda k, d=None: True if k == "zero_clocks" else real(k, d))
    emitted, _cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [TRUE3 + "He woke at 3 a.", TOOL]}, {"deltas": ["The morning moves on."]}], redo="X")
    assert "3 a" not in emitted and "3 a" not in stored[0]
    assert stored[0] == "The kitchen is quiet. Rain taps the glass. A cup is set down."
    assert emitted.startswith(stored[0])


def test_native_tool_call_after_a_withheld_sentence_runs_and_no_continuation_is_made(monkeypatch):
    calls = [{"name": "advanceGame", "arguments": "{}"}]
    extra = {}
    emitted, cont, stored, n_rounds = _drive(
        monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, BAD, TAIL], "calls": calls}, {"deltas": ["The morning moves on."]}], redo=REDO.strip(), extra=extra)
    assert cont == [], "a round with a tool call is never continued: the call would be dropped or the scene narrated twice"
    assert "Sleeper Role says" not in emitted and TAIL.strip() not in emitted
    assert emitted.startswith(CLEAN_A.strip()) and REDO.strip() not in emitted
    assert n_rounds >= 2 and extra["runs"] == ["advanceGame"], "the round's native tool call ran exactly once and the loop went on to the next round"
    assert stored[0] == CLEAN_A.strip()


def test_text_protocol_tool_call_in_the_discarded_tail_still_runs_once(monkeypatch):
    extra = {}
    call = '<tool_call><invoke name="bash"><parameter name="command">echo hi</parameter></invoke></tool_call>'
    emitted, cont, stored, n_rounds = _drive(
        monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, BAD, TAIL, call]}, {"deltas": ["The morning moves on."]}], redo=REDO.strip(), extra=extra)
    assert cont == [], "the discarded tail opened a tool call: no continuation"
    assert extra["runs"] == ["bash"], "the call after the withheld sentence ran exactly once, not dropped"
    assert "Sleeper Role says" not in emitted and TAIL.strip() not in emitted and "tool_call" not in emitted
    assert stored[0] == CLEAN_A.strip() and n_rounds >= 2


def test_prose_after_a_tool_call_in_the_discarded_tail_is_not_stored(monkeypatch):
    """review of #2784: the call opened in the withheld tail; words after it were never shown, so they are not stored either."""
    extra = {}
    call = '<tool_call><invoke name="bash"><parameter name="command">echo hi</parameter></invoke></tool_call>'
    emitted, cont, stored, _ = _drive(
        monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, BAD, TAIL, call + " Trailing words the player never saw."]}, {"deltas": ["The morning moves on."]}],
        redo=REDO.strip(), extra=extra)
    assert extra["runs"] == ["bash"] and "Trailing" not in emitted
    assert stored[0] == CLEAN_A.strip(), stored


def test_multi_sentence_quoted_line_is_not_read_as_narration(monkeypatch):
    # the schedule fact: the second sentence of one quoted line arrives as its own chunk, with no opening quote
    quoted = ['Someone whispers, "Nobody\'s safe. ', 'The nominations are tonight, I\'m telling you." ', "The kettle clicks off. "]
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": quoted}], redo="X")
    assert cont == [] and emitted == "".join(quoted) and stored[0] == emitted.strip()


def test_dialogue_about_a_sleeper_across_chunks_is_not_a_conflict(monkeypatch):
    quoted = ['Other says, "I heard it too. ', 'Sleeper Role walks in late every single night, did you notice?" ', "Nobody answers. "]
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": quoted}], redo="X")
    assert cont == [] and emitted == "".join(quoted)


def test_a_conflict_after_the_quote_closes_is_still_withheld(monkeypatch):
    deltas = ['Other says, "Nobody\'s safe. ', 'Not tonight, anyway." ', "Sleeper Role walks in. ", TAIL]
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": deltas}], redo=REDO.strip())
    assert len(cont) == 1 and "Sleeper Role walks" not in emitted and emitted.strip().endswith(REDO.strip())


def test_the_wait_after_a_withhold_is_bounded_and_the_reply_ends_at_the_last_whole_sentence(monkeypatch):
    from src import agent_loop as al
    monkeypatch.setattr(al, "_PD_DRAIN_WAIT_S", 0.4)
    monkeypatch.setattr(al, "_PD_BEAT_S", 0.1)
    extra = {}
    emitted, cont, stored, _ = _drive(
        monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, BAD, TAIL], "stall_s": 30}], redo=REDO.strip(), extra=extra)
    assert cont == [], "the stream never finished, so a tool call can not be ruled out: no continuation"
    assert emitted.strip() == CLEAN_A.strip() and stored[0] == emitted.strip()
    assert any(c.startswith(": keepalive") for c in extra["chunks"]), "the player's connection is kept alive while the stream is drained"


def test_the_continuation_is_capped_and_keeps_the_connection_alive(monkeypatch):
    from src import agent_loop as al
    monkeypatch.setattr(al, "_PD_BEAT_S", 0.1)
    extra = {"redo_delay_s": 0.45}
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, BAD, TAIL]}], redo=REDO.strip(), extra=extra)
    k = extra["cont_kwargs"][0]
    assert k["timeout"] <= 20 and k["max_tokens"] <= 700
    assert sum(1 for c in extra["chunks"] if c.startswith(": keepalive")) >= 2
    assert emitted.strip() == (CLEAN_A + REDO).strip()


def test_a_redo_that_restarts_the_scene_does_not_repeat_what_was_shown(monkeypatch):
    redo = CLEAN_A + REDO
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, BAD, TAIL]}], redo=redo.strip())
    assert emitted.count(CLEAN_A.strip()) == 1
    assert emitted.strip() == (CLEAN_A + REDO).strip() and stored[0] == emitted.strip()


def test_stored_text_is_cut_to_the_emitted_text_even_when_a_guard_rewrote_the_sentence(monkeypatch):
    # a guard rewrites the sentence in the live stream but its change never reaches the raw round buffer: the withheld sentence can not be found there
    from src import agent_loop as al
    real_scrub = al._scrub_game_leak
    monkeypatch.setattr(al, "_scrub_game_leak", lambda t, *a, **k: real_scrub(t, *a, **k).replace(" says,", " said,"))
    monkeypatch.setattr(al, "_mirror_wall_drop", lambda rr, before, after, **k: rr)
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, BAD, TAIL]}], redo=REDO.strip())
    assert len(cont) == 1 and "Sleeper" not in emitted
    assert stored[0] == emitted.strip() and "Sleeper" not in stored[0]


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
    monkeypatch.setattr(erc, "peek", lambda name, user, max_age_s=30.0, fields=None: STATE)
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
    monkeypatch.setattr(erc, "peek", lambda name, user, max_age_s=30.0, fields=None: None)
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


# ── pure helpers: the review findings ────────────────────────────────────────────────────────────
def test_quote_state_carries_across_chunks():
    from src import predisplay_check as pc
    assert pc.quote_open_after('He says, "Nobody\'s safe. ') is True
    assert pc.quote_open_after("The nominations are tonight.\" ", True) is False
    assert pc.quote_open_after("\u201cOne. Two. ") is True and pc.quote_open_after("Three.\u201d", True) is False
    sched = {"next": "nominations", "tomorrow": True}
    assert pc.schedule_conflict("The nominations are tonight, I'm telling you.", sched) is not None
    assert pc.schedule_conflict("The nominations are tonight, I'm telling you.\"", sched, in_quote=True) is None
    assert pc.asleep_conflicts("Sleeper Role walks in late.", ["Sleeper Role"], in_quote=True) == []
    assert pc.asleep_conflicts("Sleeper Role walks in late.", ["Sleeper Role"]) == ["Sleeper Role"]


def test_the_check_and_the_rewrite_both_honour_a_carried_quote(monkeypatch):
    from src import predisplay_check as pc
    from src import engine_read_cache as erc
    monkeypatch.setattr(erc, "peek", lambda name, user, max_age_s=30.0, fields=None: STATE)
    monkeypatch.setenv("ORWELL_PREDISPLAY_REWRITE", "1")
    pc.PREDISPLAY_COUNTS.clear()
    text = "The nominations are tonight, I'm telling you.\" "
    assert asyncio.get_event_loop().run_until_complete(pc.check_and_count(text, "u", in_quote=True)) == []
    assert pc.split_at_first_conflict(text, "u", in_quote=True) is None
    assert pc.drop_conflicting_sentences(text, "u", in_quote=True) == (text, [])
    assert pc.split_at_first_conflict(text, "u") is not None


def test_asleep_names_match_case_sensitively_and_as_whole_words():
    from src import predisplay_check as pc
    for name in ("Will", "Mark", "Grace", "Joy"):
        assert pc.asleep_conflicts(f"She {name.lower()} come back later.", [name]) == []
        assert pc.asleep_conflicts("She will come back, and mark my words, she grins.", [name]) == []
        assert pc.asleep_conflicts(f"{name} walks into the kitchen.", [name]) == [name]
    assert pc.asleep_conflicts("Willow walks into the kitchen.", ["Will"]) == []


def test_schedule_check_wants_the_event_itself_placed_today():
    from src import predisplay_check as pc
    def sc(ev):
        return {"next": ev, "tomorrow": True}
    # generic strategy talk is not the event
    assert pc.schedule_conflict("They talk strategy about the veto this afternoon.", sc("veto-competition")) is None
    assert pc.schedule_conflict("They wonder how they'll vote tonight.", sc("eviction")) is None
    assert pc.schedule_conflict("Other hopes to win comp this afternoon.", sc("hoh-competition")) is None
    assert pc.schedule_conflict("They plan the nominations tomorrow, then relax tonight.", sc("nominations")) is None
    # the event itself, placed today
    assert pc.schedule_conflict("The veto competition is this afternoon.", sc("veto-competition"))
    assert pc.schedule_conflict("The eviction happens tonight.", sc("eviction"))
    assert pc.schedule_conflict("The HOH competition starts this morning.", sc("hoh-competition"))
    assert pc.schedule_conflict("Tonight is the veto ceremony.", sc("veto-ceremony"))
    assert pc.schedule_conflict("The nominations are tonight.", sc("nominations"))


def test_continuation_ends_with_the_exact_tail_and_is_robust_to_tool_history():
    from src import predisplay_check as pc
    shown = "A" * 300 + " The kitchen is quiet. "
    hist = [{"role": "system", "content": "narrator"}, {"role": "user", "content": "I wait."},
            {"role": "assistant", "content": None, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "advanceGame", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": "{\"ok\": true}"},
            {"role": "assistant", "content": "Ok.", "tool_calls": [{"id": "c2"}]}]
    msgs = pc.continuation_messages(hist, shown, [pc.Conflict(pc.FACT_ASLEEP, "Sleeper Role")])
    assert msgs[-1]["role"] == "user" and msgs[-2] == {"role": "assistant", "content": shown}
    tail = shown.rstrip()[-200:]
    assert tail in msgs[-1]["content"] and ("A" * 250) not in msgs[-1]["content"]
    assert "Do NOT restart" in msgs[-1]["content"] and "repeat" in msgs[-1]["content"]
    assert not any(m.get("tool_calls") or m.get("role") == "tool" for m in msgs)
    assert any(m["role"] == "user" and "[Tool execution results]" in m["content"] and "ok" in m["content"] for m in msgs)
    assert hist[2].get("tool_calls") and hist[3]["role"] == "tool", "the caller's history is not mutated"


def test_leading_sentences_that_repeat_the_shown_tail_are_dropped():
    from src import predisplay_check as pc
    shown = "Someone laughs. The kitchen is quiet. "
    assert pc.drop_repeated_prefix("The kitchen is quiet. Everyone keeps low.", shown) == "Everyone keeps low."
    assert pc.drop_repeated_prefix("Someone laughs.  \u201cThe kitchen is  quiet.\u201d A door closes.", shown) == "A door closes."
    assert pc.drop_repeated_prefix("A door closes. The kitchen is quiet.", shown) == "A door closes. The kitchen is quiet.", "only LEADING repeats are dropped"
    assert pc.drop_repeated_prefix("The kitchen is quiet.", shown) == ""
    assert pc.drop_repeated_prefix("New line.", "") == "New line."


def test_orw437_an_unterminated_final_sentence_that_conflicts_is_dropped_at_the_flush(monkeypatch):
    """review of #2723: `_split_complete_sentences` leaves a final sentence with no terminator in the buffer; the end-of-stream flush used to emit it unchecked."""
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, "Sleeper Role walks into the kitchen"]}], redo="X")
    assert "Sleeper Role" not in emitted, emitted
    assert emitted.strip() == CLEAN_A.strip() and stored[0] == emitted.strip()


def test_orw437_the_final_buffered_sentence_is_counted_and_a_wall_dropped_sentence_is_not(monkeypatch):
    """review of #2682: the counter sees what the player is shown, including the last (unterminated) sentence."""
    from src import predisplay_check as pc
    pc.PREDISPLAY_COUNTS.clear()
    emitted, _cont, _stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, "Sleeper Role walks into the kitchen"]}], redo="X", flag="0", owner="orw437-count")
    assert "Sleeper Role walks" in emitted, "rewrite off: shown as today"
    assert pc.PREDISPLAY_COUNTS.get(pc.FACT_ASLEEP) == 1, pc.PREDISPLAY_COUNTS


def test_orw437_a_wall_dropped_final_sentence_is_not_counted(monkeypatch):
    """review of #2751: the counter reads what the player is SHOWN. Two sleepers each 'walk into the kitchen' (the second as the unterminated final sentence); with no wall both are counted, and when the presence wall removes the
    second one only the shown first is counted."""
    from src import predisplay_check as pc
    from src import agent_loop as al
    state = {"asleep": [{"name": "Sleeper Role"}, {"name": "Walled Role"}], "daySchedule": {"next": "nominations", "tomorrow": True}}
    deltas = [CLEAN_A, "Sleeper Role walks into the kitchen. ", "Walled Role walks into the kitchen"]
    pc.PREDISPLAY_COUNTS.clear()
    _drive(monkeypatch, rounds_scripts=[{"deltas": list(deltas)}], redo="X", flag="0", state=state, owner="orw437-wall-control")
    assert pc.PREDISPLAY_COUNTS.get(pc.FACT_ASLEEP) == 2, pc.PREDISPLAY_COUNTS

    real = al._presence_wall_guard

    async def wall(text, owner, alt_state=None, carry=None):  # ORW-917: the guard takes the round's carry
        return " ".join(p for p in text.split(". ") if "Walled Role" not in p) if "Walled Role" in text else await real(text, owner, alt_state=alt_state, carry=carry)

    monkeypatch.setattr(al, "_presence_wall_guard", wall)
    pc.PREDISPLAY_COUNTS.clear()
    emitted, _c, _s, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": list(deltas)}], redo="X", flag="0", state=state, owner="orw437-wall-dropped")
    assert "Walled Role" not in emitted and "Sleeper Role walks" in emitted
    assert pc.PREDISPLAY_COUNTS.get(pc.FACT_ASLEEP) == 1, pc.PREDISPLAY_COUNTS


def test_orw437_a_later_round_still_drops_a_conflicting_unterminated_final_sentence_after_a_rewrite(monkeypatch):
    """review of #2751: `_pd_rewrite_used` is turn-scoped, so once round 1 had withheld a sentence the flush drop pass was off for every later round. Round 2's unterminated conflicting
    sentence must still be dropped, from the shown text and the stored text, while its three true sentences stay."""
    calls = [{"name": "advanceGame", "arguments": "{}"}]
    r2 = ["The morning moves on. ", "Rain taps the glass. ", "A cup is set down. ", "Sleeper Role walks into the kitchen"]
    emitted, cont, stored, n_rounds = _drive(
        monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, BAD, TAIL], "calls": calls}, {"deltas": r2}], redo=REDO.strip())
    assert n_rounds >= 2 and cont == []
    assert "Sleeper Role walks" not in emitted and "Sleeper Role walks" not in stored[1]
    for kept in ("The morning moves on.", "Rain taps the glass.", "A cup is set down."):
        assert kept in emitted and kept in stored[1]


# ORW-454 (Kevin: "allow it if the engine says she's awake"), driven through the real stream loop. Before the 8am wake-up call a greeting by a NAMED houseguest the engine lists as awake is kept;
# the same greeting by a sleeper, and a claim that the whole house is up, are still dropped. The status is the one the screen already reads (`game_status`).
EARLY_STATUS = {"timeOfDay": "late-night", "earlyMorning": True, "clockLabel": "5:30am, Day 3", "asleep": ["Napper Role"], "awake": ["Riser Role"], "started": True, "pending": None}


@pytest.mark.parametrize("line,kept", [
    ("'Good morning,' Riser Role whispers, already dressed. ", True),
    ("“Good morning,” Riser Role whispers, already dressed. ", True),
    ("'Good morning,' Napper Role whispers, already dressed. ", False),
    ("Everyone's up. ", False),
    ("The house is awake. ", False),
    ("'Good morning,' someone whispers. ", False),
    ("'Good morning, Riser Role,' someone whispers. ", False),                     # ORW-493: the awake houseguest is only the addressee
    ("\u201cGood morning, Riser,\u201d someone whispers. ", False),
    ("Someone whispers, 'Good morning, Riser Role.' ", False),
    ("Riser Role whispers, 'Good morning, Napper.' ", False),
    ("Riser Role whispers, 'Good morning, everyone.' ", True),                     # the awake speaker BEFORE the quote
    ("'Good morning, all,' Riser whispers. ", True),
    ("'Good morning,' Riser Role whispers to Napper Role. ", False),
])
def test_orw454_a_greeting_by_a_named_awake_houseguest_is_kept_and_the_house_up_claim_is_dropped(monkeypatch, line, kept):
    emitted, _cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [TRUE3, line, "The kettle ticks. "]}], redo="X", flag="0", status=EARLY_STATUS)
    for true in ("The kitchen is quiet.", "Rain taps the glass.", "A cup is set down.", "The kettle ticks."):
        assert true in emitted and true in stored[0]
    assert (line.strip() in emitted) is kept, (line, emitted)
    assert stored[0] == emitted.strip(), (stored, emitted)


@pytest.mark.parametrize("line,kept", [
    ("'Good morning,' Riser whispers, already dressed. ", True),                 # first name only, unique in the roster
    ("'Good morning,' Napper whispers, already dressed. ", False),                # a sleeper, first name only
    ("'Good morning, Napper,' Riser Role whispers. ", False),                        # an awake speaker greeting a sleeper by first name
    ("'Good morning, Napper,' Riser whispers. ", False),
])
def test_orw454_first_names_are_recognised(monkeypatch, line, kept):
    emitted, _cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [TRUE3, line, "The kettle ticks. "]}], redo="X", flag="0", status=EARLY_STATUS)
    for true in ("The kitchen is quiet.", "Rain taps the glass.", "A cup is set down.", "The kettle ticks."):
        assert true in emitted and true in stored[0]
    assert (line.strip() in emitted) is kept, (line, emitted)
    assert stored[0] == emitted.strip(), (stored, emitted)


def test_orw454_a_first_name_shared_by_two_houseguests_stays_dropped(monkeypatch):
    status = dict(EARLY_STATUS, awake=["Riser Role"], asleep=["Riser Other"])
    line = "'Good morning,' Riser whispers, already dressed. "
    emitted, _c, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [TRUE3, line, "The kettle ticks. "]}], redo="X", flag="0", status=status)
    assert line.strip() not in emitted and "The kitchen is quiet." in emitted and "The kettle ticks." in emitted
    assert stored[0] == emitted.strip()


@pytest.mark.parametrize("split", ["<", "<tool", "<tool_ca", "<tool_call>"])
def test_orw453_an_opener_split_across_chunks_stores_what_was_shown(monkeypatch, split):
    """the opener's first characters arrive in the chunk that also carries the unfinished sentence; the cut must still leave stored == shown."""
    rest = TOOL[len(split):] if TOOL.startswith(split) else TOOL
    extra = {}
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [TRUE3 + "The kettle clicks off, and steam rises" + split, rest]}, {"deltas": ["The morning moves on."]}], redo="X", extra=extra)
    first = emitted.split("The morning moves on.")[0].strip()
    assert "steam rises" not in emitted and "<" not in first
    assert first == "The kitchen is quiet. Rain taps the glass. A cup is set down." == stored[0], (first, stored)
    assert cont == [] and extra["runs"] == ["bash"]


def test_orw453_prose_after_the_tool_call_is_not_stored_and_does_not_weld(monkeypatch):
    """text AFTER the call in the same round was never shown: not stored either, and the join before the call stays clean."""
    extra = {}
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [TRUE3, TOOL + " Trailing words the player never saw."]}, {"deltas": ["The morning moves on."]}], redo="X", extra=extra)
    assert "Trailing" not in emitted and "Trailing" not in stored[0]
    assert stored[0] == "The kitchen is quiet. Rain taps the glass. A cup is set down." == emitted.split("The morning moves on.")[0].strip()
    assert cont == [] and extra["runs"] == ["bash"]
