"""Reasoning persistence + cross-session sync (reasoning-leak / desync fix).

Two side-by-side browser sessions were a "hot mess": the model's private reasoning leaked
raw into the public bubble and was only re-sorted into the collapsed "Thinking" accordion
client-side, in-memory — so the fix never survived a reload and never reached a second tab.

Root cause (two halves):

  C. PERSISTENCE — clean-channel reasoning (DeepSeek/vLLM `{delta, thinking:true}` deltas)
     was streamed to the client but DROPPED before persistence: chat_routes accumulated only
     non-thinking deltas into `full_response`, so `save_assistant_response` never saw the
     reasoning and `metadata.thinking` was never set. On reload / in a second tab the
     accordion vanished (or the reasoning was re-guessed differently). Fix: accumulate a
     parallel `full_reasoning` and thread it into the save so it lands in `metadata.thinking`.

  D. RENDER UNIFICATION — the cross-device re-attach path (`resumeStream`) ignored the
     `thinking:true` flag entirely and rendered every delta raw through `mdToHtml`, so an
     observer tab dumped reasoning straight into the bubble. Fix: split reasoning from reply
     and render through the SAME `processWithThinking` path the primary stream + history use,
     with reasoning wrapped in a CLOSED <think> block so it can only ever land in the accordion.

These are source-level assertions (the route/stream files boot the whole app or are vanilla JS
with no JS test runner) plus an import-guarded functional check of the pure persistence helper.
"""

import os
import re

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


# ── C: persistence — reasoning is accumulated and threaded into the save ─────────── #

def test_chat_routes_accumulates_reasoning_separately():
    src = _read("routes", "chat_routes.py")
    # a dedicated accumulator exists (parallel to full_response)
    assert 'full_reasoning = ""' in src
    # BOTH stream sites (direct-chat + agent) route thinking deltas into it instead of dropping
    assert src.count('full_reasoning += data["delta"]') == 2
    # the thinking branch now CAPTURES the reasoning rather than silently dropping it
    assert src.count('if data.get("thinking"):\n                                        full_reasoning += data["delta"]') == 2


def test_chat_routes_threads_reasoning_into_every_save():
    src = _read("routes", "chat_routes.py")
    # all four persistence sites pass the reasoning through: the two final saves
    # (direct-chat + agent) AND the two disconnect/partial saves (a stopped turn keeps reasoning).
    assert src.count("reasoning=full_reasoning") == 4


def test_save_helpers_accept_a_reasoning_channel():
    helpers = _read("routes", "chat_helpers.py")
    # the public save fn takes a reasoning kwarg ...
    assert re.search(r"def save_assistant_response\([\s\S]*?reasoning: str = \"\",", helpers)
    # ... and the bypass save fn too
    assert re.search(r"def clean_thinking_for_save\([\s\S]*?reasoning: str = \"\"", helpers)
    # the reasoning is persisted into metadata.thinking, but only when content carried no inline
    # <think> (so a model that inlines its reasoning isn't double-counted)
    assert helpers.count("if reasoning and reasoning.strip() and not md.get(\"thinking\"):") == 2


# ── D: the resume (cross-session) path is unified onto processWithThinking ────────── #

def test_resume_stream_splits_reasoning_and_uses_the_canonical_renderer():
    chat = _read("static", "js", "chat.js")
    resume = chat[chat.index("export async function resumeStream("):]
    resume = resume[:resume.index("export function checkBackgroundStream(")]

    # reasoning is given its own buffer, kept OUT of the reply buffer
    assert "let reasoningText = ''" in resume
    assert "let replyText = ''" in resume
    # the thinking:true flag is honored (the OLD code ignored it and folded everything raw)
    assert "if (json.thinking) reasoningText += json.delta;" in resume
    assert "else replyText += json.delta;" in resume
    # reasoning is wrapped in a CLOSED <think> block so it can only reach the accordion
    assert "markdownModule.composeThinkSource(reasoningText, reply)" in resume  # A59: the one shared helper builds the CLOSED <think> block
    # the bubble is rendered through the SAME splitter as the primary path + history — never
    # raw mdToHtml of the combined text (that was the leak)
    assert "markdownModule.processWithThinking(" in resume
    assert "markdownModule.mdToHtml(markdownModule.squashOutsideCode(dt))" not in resume
    # finalize hands the canonical <think>-wrapped source to addMessage (which re-splits it)
    assert "chatRenderer.addMessage('assistant', _combined()" in resume


# ── functional: the pure persistence helper actually stores the reasoning ─────────── #

def _load_clean_thinking_for_save():
    """Import the helper under the test env, skipping if the heavy app stack is unavailable
    (this minimal sandbox lacks httpx; CI's front-end job has the full lockfile installed)."""
    try:
        from routes.chat_helpers import clean_thinking_for_save  # noqa: WPS433
    except Exception as exc:  # pragma: no cover - env-dependent
        pytest.skip(f"chat_helpers not importable here: {exc}")
    return clean_thinking_for_save


def test_clean_channel_reasoning_persists_into_metadata():
    clean_thinking_for_save = _load_clean_thinking_for_save()
    # content carries NO inline <think> — the reasoning arrived on the separate channel.
    reply, md = clean_thinking_for_save(
        "Welcome back, houseguests.",
        {"model": "x"},
        reasoning="The player wants chaos. I should lean into the rivalry.",
    )
    assert reply == "Welcome back, houseguests."
    assert md.get("thinking") == "The player wants chaos. I should lean into the rivalry."


def test_inline_reasoning_wins_over_the_channel_so_it_is_not_double_counted():
    clean_thinking_for_save = _load_clean_thinking_for_save()
    reply, md = clean_thinking_for_save(
        "<think>inline ponder</think>Hello there.",
        {},
        reasoning="channel reasoning that should be ignored",
    )
    assert reply == "Hello there."
    assert md.get("thinking") == "inline ponder"


def test_no_reasoning_channel_is_a_no_op():
    clean_thinking_for_save = _load_clean_thinking_for_save()
    reply, md = clean_thinking_for_save("Just a reply.", {"model": "x"})
    assert reply == "Just a reply."
    assert "thinking" not in md
