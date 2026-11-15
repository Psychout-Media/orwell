"""ORW-402 layer 3 - deterministic verbatim recall of condensed-out days. Roles only, no character names."""
import copy

from src import orwell_day_condense as dc
from src import orwell_transcript_recall as tr

SECRET_DETAIL = "the lighthouse key is hidden under the blue flowerpot"


def _row(role, text, day=None, **md):
    m = {"role": role, "content": text}
    if day is not None or md:
        m["metadata"] = ({"game_day": day} if day is not None else {}) | md
    return m


def _history():
    rows = [_row("system", "base prompt")]
    rows.append(_row("user", "Who has the spare key?"))
    rows.append(_row("assistant", f"A houseguest whispers that {SECRET_DETAIL}, so keep it quiet.", 1))
    rows.append(_row("tool", "tool result: lighthouse key flowerpot vault secret", 1))
    rows.append(_row("assistant", "reasoning: lighthouse key flowerpot", 1, kind="reasoning"))
    rows.append({"role": "assistant", "content": "tool result: lighthouse key flowerpot", "tool_calls": [{"id": "x"}],
                 "metadata": {"game_day": 1}})
    rows.append(_row("assistant", "casting disclosure: lighthouse key flowerpot", 1, phase="casting"))
    for d in (1, 2, 3):
        for i in range(8):
            rows.append(_row("user", f"filler talk {d} {i} about dinner"))
            rows.append(_row("assistant", f"filler reply {d} {i} about dishes", d))
    return rows


LEDGER = [{"day": 1, "tier": "day", "text": "day one", "events": [], "themes": []},
          {"day": 2, "tier": "day", "text": "day two", "events": [], "themes": []}]


def _run(msg, names=()):
    rows = _history() + [_row("user", msg)]
    view = dc.apply_prompt_view(rows, LEDGER)
    return rows, view, tr.apply_recall(rows, view, names)


def _recall_msgs(out):
    return [m for m in out if m["role"] == "system" and m["content"].startswith(tr.RECALL_HEADER)]


def test_day_one_detail_injected_verbatim_on_day_three_right_after_story():
    _rows, view, out = _run("Where was that lighthouse key hidden again?")
    rec = _recall_msgs(out)
    assert len(rec) == 1 and SECRET_DETAIL in rec[0]["content"]
    i = next(k for k, m in enumerate(out) if m["content"].startswith("[Story so far]"))
    assert out[i + 1] is rec[0]
    assert len(out) == len(view) + 1


def test_unrelated_message_changes_nothing():
    _rows, view, out = _run("Let's play cards")
    assert out is view


def test_never_includes_tool_or_reasoning_rows_and_input_untouched():
    rows, _view, out = _run("lighthouse key flowerpot vault secret reasoning")
    before = copy.deepcopy(rows)
    text = _recall_msgs(out)[0]["content"]
    assert not any(x in text for x in ("tool result", "reasoning:", "casting disclosure"))
    assert rows == before


def test_total_size_bounded():
    rows = [_row("system", "base")]
    for i in range(20):
        rows.append(_row("user", "tell me about the harbour festival lanterns " * 20))
        rows.append(_row("assistant", "the harbour festival lanterns glowed brightly over the water " * 30, 1))
    for i in range(10):
        rows.append(_row("user", f"x{i}"))
        rows.append(_row("assistant", f"y{i}", 3))
    rows.append(_row("user", "harbour festival lanterns, remind me"))
    view = dc.apply_prompt_view(rows, LEDGER)
    out = tr.apply_recall(rows, view)
    text = _recall_msgs(out)[0]["content"]
    assert len(text) <= tr.TOTAL_CHARS and text.count("Player:") <= tr.MAX_EXCERPTS


def test_name_in_message_and_excerpt_counts():
    _rows, _view, out = _run("what did Zed say?", names=["Zed"])  # no content-word overlap, name absent in excerpt
    assert _recall_msgs(out) == []


def test_flag_off_and_no_story_block():
    rows = _history() + [_row("user", "Where was that lighthouse key hidden?")]
    view = dc.apply_prompt_view(rows, LEDGER)
    import os
    os.environ["ORWELL_TRANSCRIPT_RECALL"] = "0"
    try:
        assert tr.apply_recall(rows, view) is view
    finally:
        del os.environ["ORWELL_TRANSCRIPT_RECALL"]
    assert tr.apply_recall(rows, rows) is rows
