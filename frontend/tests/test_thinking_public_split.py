"""Thinking / public split (P1, owner ruling 2026-06-20).

The model's output was MIXING its private reasoning (drafts, self-correction, "let me
rewind that") with its public, in-character narration in the SAME chat bubble. They must
be CLEANLY SEPARATED in the UI:

  - Public, in-character narration -> the normal chat bubble (clean; no reasoning/drafts).
  - Thinking / reasoning            -> a condensed "Thinking" accordion, DEFAULT-COLLAPSED,
                                       streaming while generating, expandable for debug.

This is a FE rendering/stream-separation change only (no engine changes, no new server
path). The reasoning arrives EITHER as a separate provider channel (DeepSeek/vLLM
`reasoning_content` / `reasoning` / `thinking` deltas, which llm_core.py already emits as
`{delta, thinking:true}` SSE chunks, wrapped by chat.js into <think>…</think>) OR inlined
as <think>…</think> in the content. Both are split: reasoning -> accordion, reply -> bubble.

Vault Wall: the accordion shows ONLY the model's own reasoning over Vault-free context — no
new engine secret/Vault path is introduced. The reply text is still scrubbed of any reasoning
preamble so nothing reasoning-shaped reaches the public bubble.

Source-level assertions (the render/stream files are vanilla JS with no JS test runner here)
plus a Node round-trip through the pure scrub helper proving the public reply carries no
reasoning, and the CSS contract proving the accordion defaults collapsed.
"""

import os
import re
import shutil
import subprocess

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


# ── routing: reasoning -> accordion, reply -> clean bubble ─────────────────────── #

def test_markdown_routes_reasoning_to_accordion_and_scrubs_the_reply():
    md = _read("static", "js", "markdown.js")
    # both gates exist: one decides whether to SCRUB the reply, one whether to SHOW the
    # accordion (so an operator can hide the accordion without un-scrubbing the bubble).
    assert "export function gameBuildSuppressesThinking()" in md
    assert "export function gameBuildShowsThinkingAccordion()" in md

    pwt = md[md.index("export function processWithThinking"):]
    gated = pwt[pwt.index("if (gameBuildSuppressesThinking())"):]
    gated = gated[:gated.index("let html = ''")]
    # the public reply is scrubbed clean of reasoning before it renders into the bubble
    assert "scrubReasoningPreamble(" in gated
    # the reasoning is rendered in its OWN accordion, gated on the show-accordion helper
    assert "gameBuildShowsThinkingAccordion()" in gated
    assert "createThinkingSection(" in gated
    # the accordion is built from the EXTRACTED thinking blocks, never from reply content
    assert "thinkingBlocks.forEach" in gated


def test_show_accordion_helper_defaults_on_and_honors_operator_hide():
    md = _read("static", "js", "markdown.js")
    fn = md[md.index("export function gameBuildShowsThinkingAccordion()"):]
    fn = fn[:fn.index("export function processWithThinking")]
    # only inside the game build, default ON, with an operator opt-out (hide-thinking).
    assert "_inGameBuild()" in fn
    assert "hide-thinking" in fn
    assert "data-hide-thinking" in fn
    # fail-closed to HIDING the accordion if a check throws (never render reasoning on error)
    assert "catch" in fn and "return false;" in fn


def test_accordion_is_collapsed_by_default():
    # createThinkingSection builds the accordion. The CONTENT region must default collapsed:
    # `.thinking-content` carries NO `expanded` class at build time (CSS keeps max-height:0).
    md = _read("static", "js", "markdown.js")
    fn = md[md.index("function createThinkingSection("):]
    fn = fn[:fn.index("\n}")]
    assert 'class="thinking-content"' in fn
    # the build-time markup never pre-expands the section
    assert "thinking-content expanded" not in fn
    assert "thinking-toggle expanded" not in fn
    # CSS: collapsed is the default (max-height:0); only `.expanded` opens it.
    css = _read("static", "style.css")
    block = css[css.index(".thinking-content {"):]
    block = block[:block.index("}")]
    assert "max-height: 0" in block
    assert ".thinking-content.expanded" in css


# ── live stream: the box streams collapsed; bubble stays clean ─────────────────── #

def test_live_stream_builds_the_collapsed_thinking_box_not_a_suppression_hold():
    chat = _read("static", "js", "chat.js")
    # the OLD wholesale game-build suppression of the live-think box is GONE.
    assert "if (isGameBuild() && (hasUnclosedThink || isThinking)) {" not in chat
    # the only remaining game-build hold is gated on the operator hide-thinking opt-out.
    assert "isGameBuild() && document.body.classList.contains('hide-thinking')" in chat
    # the shared live-think box (the collapsed accordion that streams) is built.
    assert "Create a live thinking box" in chat
    # its content region is `.thinking-content` WITHOUT `expanded` at creation (collapsed).
    box = chat[chat.index("Create a live thinking box"):]
    box = box[:box.index("_liveThinkSection = thinkContent.querySelector")]
    assert 'class="thinking-content" id=' in box
    assert "thinking-content expanded" not in box


def test_live_reply_render_is_scrubbed_in_the_game_build():
    # The final-render live-reply path must scrub the reply in the game build so no reasoning
    # preamble that bled into the reply reaches the public bubble (route via processWithThinking).
    chat = _read("static", "js", "chat.js")
    seg = chat[chat.index("if (_liveReplyEl && _finalReply) {"):]
    seg = seg[:seg.index("_liveReplyEl.classList.remove")]
    assert "isGameBuild()" in seg
    assert "markdownModule.processWithThinking(" in seg


# ── reload path: reconstruct the collapsed accordion ───────────────────────────── #

def test_reload_path_reconstructs_thinking_in_every_build():
    renderer = _read("static", "js", "chatRenderer.js")
    # the old game-build skip is gone — reconstruct in every build, let processWithThinking
    # decide (collapsed accordion in the game build, or dropped under hide-thinking).
    assert "metadata?.thinking && !isGameBuild()" not in renderer
    assert "role === 'assistant' && metadata?.thinking" in renderer
    # A59: the <think>-wrapped source is now built by the ONE shared helper (markdown.js composeThinkSource) that the live path calls too
    assert "markdownModule.composeThinkSource(metadata.thinking, text, thinkTime, true)" in renderer
    assert "'<think' + (timeMs ? ` time=\"${timeMs}\"` : '') + '>' + r + '</think>" in _read("static", "js", "markdown.js")


# ── the public bubble carries NO reasoning (Node round-trip through the scrub) ──── #

_NODE = shutil.which("node")


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_scrub_strips_reasoning_and_rewind_from_the_public_reply():
    # scrubReasoningPreamble is a pure function (no DOM) — drive it in Node. The public reply
    # must drop a leading reasoning/draft/"rewind" preamble (operator openers, raw npc:<id>
    # ids) while keeping the in-character narration intact (trailing terminator preserved).
    md_path = os.path.join(FRONTEND, "static", "js", "markdown.js")
    program = r"""
    const fs = require('fs');
    const src = fs.readFileSync(process.argv[1], 'utf8');
    const reLine = src.match(/const _REASONING_LINE_RE = [^\n]+/)[0];
    const reNpc  = src.match(/const _RAW_NPC_ID_RE = [^\n]+/)[0];
    const fn = src.slice(src.indexOf('export function scrubReasoningPreamble'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2).replace('export function', 'function');
    const cases = [
      // [raw model content, the clean narration that must survive in the bubble]
      ['Let me rewind that.\nThe lights dim over the living room. Who do you trust?',
       'The lights dim over the living room. Who do you trust?'],
      ['Looking at the roster: npc:3 wants the player out.\nWelcome back, houseguests.',
       'Welcome back, houseguests.'],
      ['I need to stay in character here.\nThe backyard goes quiet.',
       'The backyard goes quiet.'],
      // a clean reply must pass through untouched
      ['Are you ready to play?', 'Are you ready to play?'],
    ];
    const run = new Function('cases', reLine + '\n' + reNpc + '\n' + body + '\n' +
      "let ok = true;" +
      "for (const [inp, exp] of cases) { const got = scrubReasoningPreamble(inp);" +
      "  if (got.trim() !== exp) { ok = false; console.error('MISMATCH', JSON.stringify(inp), '=>', JSON.stringify(got)); }" +
      // belt: the public reply must never contain a raw engine id or a 'rewind' draft marker
      "  if (/npc:\\d/.test(got) || /rewind/i.test(got)) { ok = false; console.error('LEAK', JSON.stringify(got)); } }" +
      "return ok;");
    console.log(run(cases) ? 'OK' : 'FAIL');
    """
    res = subprocess.run([_NODE, "-e", program, "--", md_path], capture_output=True, text=True)
    assert "OK" in res.stdout, f"stdout={res.stdout!r} stderr={res.stderr!r}"


# ── the reasoning-channel split is wired on both arrival shapes ────────────────── #

def test_reasoning_channel_deltas_are_wrapped_into_think_tags():
    # A separate provider reasoning channel (DeepSeek/vLLM): the server emits {delta, thinking:true}
    # and chat.js wraps consecutive reasoning deltas into <think>…</think> so the SAME accordion
    # path handles channel-reasoning and inline <think> identically.
    chat = _read("static", "js", "chat.js")
    seg = chat[chat.index("VLLM reasoning tokens: wrap in <think> tags"):]
    seg = seg[:seg.index("const wasEmpty = !accumulated;")]
    assert "if (json.thinking) {" in seg
    assert "'<think>' + _delta" in seg
    assert "'</think>' + _delta" in seg


def test_server_passes_reasoning_through_to_the_client_unscrubbed():
    # No engine/server change: llm_core already emits reasoning as {delta, thinking:true}, and the
    # live-game scrub in agent_loop passes thinking deltas straight through (only NON-thinking
    # content is game-scrubbed). The accordion is fed the model's own Vault-free reasoning.
    llm = _read("src", "llm_core.py")
    assert 'yield _stream_delta_event(reasoning, thinking=True)' in llm
    loop = _read("src", "agent_loop.py")
    seg = loop[loop.index('if data.get("thinking"):'):]
    seg = seg[:seg.index("elif _scrub_active:")]
    assert "yield chunk" in seg  # reasoning passes through; it is filtered/rendered client-side


# ── F8: realtime reasoning body-flash hardening (client-side, structural) ──────────── #
#
# The PRIMARY chat stream used to merge thinking:true reasoning into the merged roundText (with
# synthesized <think> tags) and re-extract the reply with fragile regex/heuristics — so reasoning
# ("The player keeps asking…", `npc:N` analysis) FLASHED in the public bubble for seconds before
# the final render scrubbed it. The structural fix keeps two per-round buffers: roundReplyText
# (deltas with json.thinking falsy) feeds EVERY body render path; roundReasoningText (truthy)
# feeds the live "Thinking" accordion. Reasoning is excluded from the body BY CONSTRUCTION, so it
# can never paint in the public bubble (belt-and-suspenders WITH processWithThinking's L6b scrub).

def test_primary_stream_has_a_reply_only_body_buffer():
    # F8 structural fix: the primary stream splits deltas by channel so the BODY can never paint
    # reasoning. Reply-only buffer feeds every body render; reasoning buffer feeds the accordion.
    chat = _read("static", "js", "chat.js")
    # both per-round buffers are declared next to the merged roundText
    assert "let roundReplyText" in chat and "let roundReasoningText" in chat
    # the split keys off json.thinking using the RAW delta (before <think>-wrapping)
    assert "if (json.thinking) roundReasoningText += json.delta;" in chat
    assert "else               roundReplyText += json.delta;" in chat
    # all three body render paths source the reply-only buffer
    # (_renderStream + final-render finalize + tool_start intermediate finalize)
    assert chat.count("stripToolBlocks(roundReplyText)") >= 2
    # the accordion sources the reasoning buffer
    assert "roundReasoningText.trim()" in chat
    # the buffers reset in LOCKSTEP with roundText (both reset sites: agent_step + teacher_takeover)
    assert chat.count("roundReplyText = '';") >= 2 and chat.count("roundReasoningText = '';") >= 2


def test_body_render_sources_reply_only_buffer_not_merged_roundtext():
    # F8 structural fix superseded the old unclosed-<think> strip: the body now renders a
    # reply-only buffer, so reasoning is excluded by construction (no strip/extraction needed).
    chat = _read("static", "js", "chat.js")
    # _renderStream sources roundReplyText, NOT the merged roundText
    assert "const dt = stripToolBlocks(roundReplyText);" in chat
    # the final render finalizes the body from the reply-only buffer too
    assert "const finalDisplay = stripToolBlocks(roundReplyText);" in chat
    # the old per-delta unclosed-<think> body strip is gone (no longer needed)
    assert "hasUnclosedThinkTag(dt)" not in chat
    # the fragile reply-extraction machinery is gone from the live body path
    assert "garbled <think>" not in chat
