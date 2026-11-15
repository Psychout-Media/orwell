"""ORW-271 slice 2 - the day-ledger prompt view + the author task. Roles only."""
import asyncio
import copy
import json

from src import orwell_day_condense as dc


def _row(role, text, day=None):
    m = {"role": role, "content": text}
    if day is not None:
        m["metadata"] = {"game_day": day}
    return m


def _day_entry(d, text=None, merged=False):
    e = {"day": d, "tier": "day", "events": [f"event {d}a", f"event {d}b"], "themes": ["deal"]}
    if text:
        e["text"] = text
    if merged:
        e["merged"] = True
    return e


def _history():
    rows = [_row("system", "base prompt")]
    for d in (1, 2, 3):
        for i in range(10):
            rows.append(_row("user", f"u{d}.{i}"))          # unstamped user row takes the next assistant day
            rows.append(_row("assistant", f"a{d}.{i}", d))
    return rows


def test_replaces_only_closed_day_rows_and_keeps_today_and_tail():
    rows = _history()
    ledger = [_day_entry(1, "day one text"), _day_entry(2, "day two text")]   # day 3 is today
    before = copy.deepcopy(rows)
    out = dc.apply_prompt_view(rows, ledger)
    assert rows == before                                   # stored history untouched
    texts = [m["content"] for m in out]
    assert any(t.startswith("[Story so far]") for t in texts)
    assert not any(t.startswith(("u1.", "a1.")) for t in texts)   # closed day gone
    assert all(f"a3.{i}" in texts for i in range(10))       # today raw
    assert "a2.9" in texts and "u2.9" in texts              # previous day's tail kept
    assert "a2.3" not in texts                              # previous day's early rows condensed
    assert texts[0] == "base prompt"
    story = next(t for t in texts if t.startswith("[Story so far]"))
    assert "day one text" in story and "day two text" in story


def test_falls_back_to_floor_when_text_absent():
    out = dc.apply_prompt_view(_history(), [_day_entry(1), _day_entry(2)])
    story = next(m["content"] for m in out if m["content"].startswith("[Story so far]"))
    assert "event 1a" in story and "deal" in story


def test_week_entries_first_and_merged_days_skipped():
    ledger = [_day_entry(1, "x", merged=True), _day_entry(2, "two"),
              {"day": 2, "tier": "week", "coversDays": [1, 1], "text": "week one", "events": [], "themes": []}]
    out = dc.apply_prompt_view(_history(), ledger)
    story = next(m["content"] for m in out if m["content"].startswith("[Story so far]"))
    assert story.index("week one") < story.index("two")
    assert "Day 1:" not in story


def test_unstamped_rows_left_alone_and_failsoft():
    rows = [_row("user", "casting chat"), _row("assistant", "casting reply")] + _history()
    out = dc.apply_prompt_view(rows, [_day_entry(1, "t"), _day_entry(2, "t")])
    assert out[0]["content"] == "casting chat"
    assert dc.apply_prompt_view(rows, []) is rows
    assert dc.apply_prompt_view("not a list", [_day_entry(1)]) == "not a list"


def test_flag_off_sends_as_today(monkeypatch):
    monkeypatch.setenv("ORWELL_DAY_CONDENSE", "0")
    rows = _history()
    assert dc.apply_prompt_view(rows, [_day_entry(1, "t"), _day_entry(2, "t")]) is rows


def test_prefix_is_append_only_as_days_close():
    l1 = [_day_entry(1, "one"), _day_entry(2, "two")]
    s1 = dc.build_story_so_far(l1, 2)
    s2 = dc.build_story_so_far(l1 + [_day_entry(3, "three")], 3)
    assert s2.startswith(s1)


def test_author_input_excludes_tool_rows_and_reasoning():
    SENTINEL = "SEALED-SENTINEL-XYZ"
    hist = [_row("user", "hello", 1),
            _row("assistant", "visible narration", 1),
            {"role": "tool", "content": f"engine result {SENTINEL}", "metadata": {"game_day": 1}},
            {"role": "assistant", "content": "second", "metadata": {"game_day": 1, "thinking": f"reasoning {SENTINEL}"}}]
    text = dc.visible_day_text(hist, 1)
    assert "visible narration" in text and SENTINEL not in text


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_author_task_idempotent_and_failsoft():
    ledger = [_day_entry(1)]
    writes = []

    async def ledger_fn():
        return copy.deepcopy(ledger)

    async def write_fn(day, text, tier="day", covers_days=None):
        writes.append((day, text, tier))
        for e in ledger:
            if e["day"] == day and tier == "day" and "text" not in e:
                e["text"] = text
        return {"accepted": True}

    async def llm(messages):
        return "word " * 300

    hist = [_row("user", "hi", 1), _row("assistant", "there", 1)]
    r = _run(dc.condense_day("u", 1, llm_fn=llm, history=hist, ledger_fn=ledger_fn, write_fn=write_fn))
    assert r["accepted"] and len(writes) == 1 and len(writes[0][1].split()) <= dc.DAY_WORDS
    _run(dc.condense_day("u", 1, llm_fn=llm, history=hist, ledger_fn=ledger_fn, write_fn=write_fn))
    assert len(writes) == 1                                   # idempotent: day already has text

    async def boom(messages):
        raise RuntimeError("provider down")
    ledger.append(_day_entry(2))
    hist2 = [_row("user", "hi", 2), _row("assistant", "there", 2)]
    assert _run(dc.condense_day("u", 2, llm_fn=boom, history=hist2, ledger_fn=ledger_fn, write_fn=write_fn))["reason"] == "error"
    assert _run(dc.condense_day("u", 2, llm_fn=None, history=hist2, ledger_fn=ledger_fn, write_fn=write_fn))["reason"] == "no-model"


def test_week_tier_when_due():
    ledger = [_day_entry(d, f"t{d}") for d in range(1, 16)]
    writes = []

    async def ledger_fn():
        return copy.deepcopy(ledger)

    async def write_fn(day, text, tier="day", covers_days=None):
        writes.append((day, tier, covers_days))
        return {"accepted": True}

    async def llm(messages):
        return "a week"

    _run(dc.condense_day("u", 15, llm_fn=llm, history=[], ledger_fn=ledger_fn, write_fn=write_fn))
    assert (7, "week", [1, 7]) in writes


def test_closed_day_from_turn_in_and_kickoff_noop_without_recap():
    assert dc.closed_day_from_turn_in({"output": json.dumps({"dailyRecap": {"day": 3}})}) == 3
    assert dc.closed_day_from_turn_in({"output": json.dumps({})}) is None
    dc.kickoff_after_turn_in("u", {"output": "{}"})           # no raise, no task


def test_save_stamps_game_day_only_when_given():
    from routes import chat_helpers as ch

    class S:
        model = "m"

        def __init__(self):
            self.history = []

        def add_message(self, m):
            self.history.append(m)

    s = S()
    ch.save_assistant_response(s, None, "sid", "reply", None, incognito=True, game_day=4)
    ch.save_assistant_response(s, None, "sid", "reply2", None, incognito=True)
    assert s.history[0].metadata["game_day"] == 4
    assert "game_day" not in s.history[1].metadata


# ── ORW-387: a provider error must never become the narrator's memory of a day ──────────────────────────

_ERR = ('event: error data: {"status": 400, "text": "DeepSeek returned HTTP 400: Prompt must contain the word '
        "'json' in some form to use 'response_format' of type 'json_object'.\"}")


def test_orw387_error_frame_is_never_visible_text():
    from src import orwell_cast_authoring as ca
    frame = 'event: error\ndata: {"status": 400, "text": "provider said no"}\n\n'
    assert ca._delta_text(frame) == ""
    assert ca._delta_text('data: {"delta": "hello"}') == "hello"      # the control: content still reads


def test_orw387_prose_callers_send_no_response_format(monkeypatch):
    """The day summary is plain prose: forcing json_object makes a strict provider answer 400."""
    from src import orwell_cast_authoring as ca, endpoint_resolver, llm_core
    seen = []

    async def fake_stream(candidates, messages, **kw):
        seen.append(kw.get("response_format"))
        yield 'data: {"delta": "a quiet day"}'

    monkeypatch.setattr(endpoint_resolver, "resolve_endpoint", lambda *a, **k: ("http://x/v1", "m", {}))
    monkeypatch.setattr(endpoint_resolver, "resolve_utility_fallback_candidates", lambda **k: [])
    monkeypatch.setattr(llm_core, "stream_llm_with_fallback", fake_stream)
    msgs = [{"role": "user", "content": "x"}]
    prose = _run(ca._resolve_llm_fn("u", json_mode=False))
    assert _run(prose(msgs)) == "a quiet day"
    structured = _run(ca._resolve_llm_fn("u"))
    _run(structured(msgs))
    assert seen == [None, {"type": "json_object"}]                    # the default stays structured


def test_orw387_condense_resolves_a_prose_fn(monkeypatch):
    from src import orwell_cast_authoring as ca
    asked = {}

    async def fake_resolve(owner, **kw):
        asked.update(kw)
        return None

    monkeypatch.setattr(ca, "_resolve_llm_fn", fake_resolve)
    _run(dc.run_condense("u", 1))
    assert asked.get("json_mode") is False


def test_orw387_error_text_is_not_written_and_not_shown():
    ledger = [_day_entry(1)]
    writes = []

    async def ledger_fn():
        return ledger

    async def write_fn(day, text, tier="day", covers_days=None):
        writes.append((day, text))
        return {"accepted": True}

    async def bad(messages):
        return _ERR

    hist = [_row("user", "hi", 1), _row("assistant", "there", 1)]
    r = _run(dc.condense_day("u", 1, llm_fn=bad, history=hist, ledger_fn=ledger_fn, write_fn=write_fn))
    assert not r["accepted"] and writes == []
    poisoned = [_day_entry(1, _ERR)]
    story = dc.build_story_so_far(poisoned, 1)
    assert "HTTP 400" not in story and "event 1a" in story            # falls back to the engine's own lines


def test_orw387_poisoned_and_missing_days_are_reauthored():
    ledger = [_day_entry(1, _ERR), _day_entry(2), _day_entry(3)]
    writes = []

    async def ledger_fn():
        return ledger

    async def write_fn(day, text, tier="day", covers_days=None):
        writes.append((day, text))
        for e in ledger:
            if e["day"] == day:
                e["text"] = text
        return {"accepted": True}

    async def llm(messages):
        return "a real summary"

    hist = [_row("user", "hi", d) for d in (1, 2, 3)] + [_row("assistant", "there", d) for d in (1, 2, 3)]
    _run(dc.condense_day("u", 3, llm_fn=llm, history=hist, ledger_fn=ledger_fn, write_fn=write_fn))
    assert sorted(d for d, _ in writes) == [1, 2, 3]
    assert dc.days_needing_summary(ledger) == []
    assert dc.days_needing_summary([_day_entry(1, _ERR), _day_entry(2, "fine")]) == [1]
