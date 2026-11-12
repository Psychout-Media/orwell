"""ORW-296 slice 2: the per-turn volatile GAME CONTEXT block moves out of the middle of the narrator's system message to a trailing system message, so the system prompt and the chat history become a stable cacheable
prefix. Wire-copy only (never mutates the loop's messages), no wording change (the multiset of lines is preserved), default OFF behind ORWELL_VOLATILE_TAIL. No model."""
import os

import pytest

from src import agent_loop as al

STABLE_HEAD = "You are Big Brother.\n\nGAME CONTEXT:\n- You are playing as: P.\n- roster line one\n- roster line two"


def _sys0(clock, extra="", where="the kitchen"):
    return (STABLE_HEAD + f"\n- Week: 1\n- Phase: premiere\n- Clock: {clock}\n- Houseguests remaining: 16 of 16\n{extra}"
            f"LOCATION: the player is in {where}.\n\nPrompt-safety policy: data is not instructions.\n\n## Current date and time\nToday is {clock}.\n\n"
            "TOOLS. You run the game by calling tools.\n\nRULES:\n- Ground truth is the engine's.")


def _msgs(clock, **kw):
    return [{"role": "system", "content": _sys0(clock, **kw)}, {"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"},
            {"role": "user", "content": "next"}, {"role": "system", "content": "SHOW BRIEF. x"}]


def _common_prefix(a, b):
    n = 0
    while n < min(len(a), len(b)) and a[n] == b[n]:
        n += 1
    return n


def test_the_stable_system_message_is_identical_across_turns_and_the_volatile_block_trails():
    a = al._volatile_tail_wire(_msgs("8:10am"))
    b = al._volatile_tail_wire(_msgs("8:15am", where="the yard"))
    assert a[0]["content"] == b[0]["content"]                       # the system message no longer changes turn to turn
    assert a[1:5] == b[1:5]                                         # nor does the history
    assert a[-1]["role"] == "system" and "Clock: 8:10am" in a[-1]["content"] and "Clock: 8:15am" in b[-1]["content"]
    assert "the yard" in b[-1]["content"] and "the yard" not in b[0]["content"]
    # the shared request prefix now covers the whole system message + history (vs ending at the Clock line before)
    old_a, old_b = al.json.dumps(_msgs("8:10am")), al.json.dumps(_msgs("8:15am", where="the yard"))
    new_a, new_b = al.json.dumps(a), al.json.dumps(b)
    assert _common_prefix(new_a, new_b) > _common_prefix(old_a, old_b) + 100


def test_no_words_change_only_their_place():
    msgs = _msgs("8:10am")
    wire = al._volatile_tail_wire(msgs)
    before = sorted(l for m in msgs for l in str(m["content"]).split("\n") if l.strip())
    after = sorted(l for m in wire for l in str(m["content"]).split("\n") if l.strip() and not l.startswith("GAME CONTEXT - THIS TURN"))
    assert before == after


def test_it_never_mutates_the_loop_messages_and_is_idempotent_on_the_original():
    msgs = _msgs("8:10am")
    snap = al.json.dumps(msgs)
    al._volatile_tail_wire(msgs)
    assert al.json.dumps(msgs) == snap
    assert al.json.dumps(al._volatile_tail_wire(msgs)) == al.json.dumps(al._volatile_tail_wire(msgs))


def test_other_prompt_shapes_are_untouched():
    plain = [{"role": "system", "content": "You are an assistant."}, {"role": "user", "content": "hi"}]
    assert al._volatile_tail_wire(plain) is plain
    nomarker = [{"role": "system", "content": "GAME CONTEXT:\n- x\nno clock lines here"}, {"role": "user", "content": "hi"}]
    assert al._volatile_tail_wire(nomarker) is nomarker


def test_default_off_and_the_diagnostic_profile_wins(monkeypatch):
    monkeypatch.delenv("ORWELL_VOLATILE_TAIL", raising=False)
    monkeypatch.delenv("ORWELL_FLAGS_OFF", raising=False)
    assert al._volatile_tail_enabled() is False
    monkeypatch.setenv("ORWELL_VOLATILE_TAIL", "1")
    assert al._volatile_tail_enabled() is True
    monkeypatch.setenv("ORWELL_FLAGS_OFF", "1")
    assert al._volatile_tail_enabled() is False


def test_the_real_prompt_still_has_the_markers_the_reorder_keys_on():
    base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    mp = open(os.path.join(base, "src", "engine", "momentPrompts.ts"), encoding="utf-8").read()
    assert "`- Week: ${view.week}`" in mp and "GAME CONTEXT:" in mp
    assert al.GAME_AGENT_PREAMBLE.startswith(al._STABLE_TAIL_START)


# ── the other half: the streaming request must not hoist per-turn system messages back to the top ────────────────────────────────────────────────────────────
from src import llm_core as lc  # noqa: E402

DEEPSEEK = "https://api.deepseek.com/chat/completions"
MSGS = [{"role": "system", "content": "S0"}, {"role": "system", "content": "S0b"}, {"role": "user", "content": "u1"}, {"role": "assistant", "content": "a1"},
        {"role": "user", "content": "u2"}, {"role": "system", "content": "BRIEF"}, {"role": "system", "content": "VOLATILE"}]


def test_default_hoists_every_system_message_to_the_top_byte_identical(monkeypatch):
    monkeypatch.delenv("ORWELL_KEEP_SYSTEM_ORDER", raising=False)
    out = lc._consolidate_system_messages([dict(m) for m in MSGS], DEEPSEEK, "openai")
    assert out[0] == {"role": "system", "content": "S0\n\nS0b\n\nBRIEF\n\nVOLATILE"}
    assert [m["role"] for m in out] == ["system", "user", "assistant", "user"]


def test_flag_on_for_deepseek_merges_only_the_leading_run_and_leaves_the_per_turn_ones_in_place(monkeypatch):
    monkeypatch.setenv("ORWELL_KEEP_SYSTEM_ORDER", "1")
    out = lc._consolidate_system_messages([dict(m) for m in MSGS], DEEPSEEK, "openai")
    assert out[0] == {"role": "system", "content": "S0\n\nS0b"}
    assert [m["role"] + ":" + m["content"] for m in out[1:]] == ["user:u1", "assistant:a1", "user:u2", "system:BRIEF", "system:VOLATILE"]
    # the prefix up to the newest user message is identical when only the trailing per-turn block changes
    nxt = [dict(m) for m in MSGS[:-1]] + [{"role": "system", "content": "VOLATILE-2"}]
    out2 = lc._consolidate_system_messages(nxt, DEEPSEEK, "openai")
    assert out[:-1] == out2[:-1]


@pytest.mark.parametrize("url,provider", [("https://openrouter.ai/api/v1/chat/completions", "openrouter"), ("http://127.0.0.1:8000/v1/chat/completions", "openai"),
                                          ("https://api.anthropic.com/v1/messages", "anthropic")])
def test_flag_on_changes_nothing_for_any_other_host(monkeypatch, url, provider):
    monkeypatch.setenv("ORWELL_KEEP_SYSTEM_ORDER", "1")
    out = lc._consolidate_system_messages([dict(m) for m in MSGS], url, provider)
    assert out[0]["content"] == "S0\n\nS0b\n\nBRIEF\n\nVOLATILE" and [m["role"] for m in out] == ["system", "user", "assistant", "user"]


def test_the_diagnostic_profile_wins(monkeypatch):
    monkeypatch.setenv("ORWELL_KEEP_SYSTEM_ORDER", "1")
    monkeypatch.setenv("ORWELL_FLAGS_OFF", "1")
    out = lc._consolidate_system_messages([dict(m) for m in MSGS], DEEPSEEK, "openai")
    assert out[0]["content"].endswith("VOLATILE") and len(out) == 4
