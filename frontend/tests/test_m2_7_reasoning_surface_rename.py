"""M2-7 — the reasoning-surface diegetic rename.

The beat-chip half shipped earlier ("Production notes" in orwellToolBeats.js). This closes the
reconcile gap: the live/reload reasoning ACCORDION label and the Settings toggle copy still read
the debug wording ("View thinking process" / "Show <think> collapsible bars"). In the GAME BUILD
they now read as the show's "Production notes" family — matching the beat-chip register. The full
inherited workspace (ORWELL_GAME_BUILD=0 → the operator/dev surface) KEEPS the technical wording.

This is a display-string rename only: the P1 owner ruling stays intact — reasoning is
collapsed-by-default, debug-viewable, and the public reply is scrubbed of reasoning (the
roundReplyText vs roundReasoningText channel split is UNTOUCHED). Those invariants are pinned here
too so the rename can never quietly regress them.
"""
from __future__ import annotations

import os
import re

FE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel: str) -> str:
    with open(os.path.join(FE, rel), encoding="utf-8") as fh:
        return fh.read()


# ── The accordion label (markdown.js — the persisted/reload render chokepoint) ──

def test_markdown_accordion_label_is_game_build_gated():
    """createThinkingSection reads 'Production notes' in the game build, the technical
    'View thinking process' only as the non-game (operator) fallback."""
    md = _read("static/js/markdown.js")
    # The game-build-aware label expression, exactly as wired.
    assert "_inGameBuild() ? 'Production notes' : 'View thinking process'" in md, \
        "markdown.js: the accordion label is not game-build gated to 'Production notes'"
    # The label must render the computed variable, never a hardcoded debug span.
    assert "<span>${label}</span>" in md, \
        "markdown.js: the accordion header must render the gated label variable"
    assert "<span>View thinking process</span>" not in md, \
        "markdown.js: a hardcoded debug label span still renders (retired copy)"


# ── The live/resume accordion label (chat.js) ──

def test_chat_live_accordion_label_is_game_build_gated():
    """Every settled live/resume 'View thinking process' header is now game-build gated;
    no bare debug label renders in the game build."""
    chat = _read("static/js/chat.js")
    # The settled live-header assignment (3 sites) is gated.
    assert "isGameBuild() ? 'Production notes' : 'View thinking process'" in chat, \
        "chat.js: the live reasoning-accordion label is not game-build gated"
    # The resume/background accordion HTML builds the gated label var, not a hardcoded span.
    assert "isGameBuild() ? 'Production notes' : 'View thinking process'" in chat
    assert ">View thinking process<" not in chat, \
        "chat.js: a hardcoded debug label span still renders in an accordion header"
    # No un-gated `.textContent = 'View thinking process'` may survive.
    assert not re.search(r"\.textContent\s*=\s*'View thinking process'", chat), \
        "chat.js: an un-gated debug-label assignment survives (retired copy renders in game build)"


# ── The Settings toggle copy (game-build swap in chat.js init) ──

def test_settings_toggle_copy_reads_production_notes_in_game_build():
    """The kept-in-game 'Thinking Process' toggle reads the diegetic 'Production Notes' family
    in the game build. The swap is game-build gated so the workspace keeps operator wording."""
    chat = _read("static/js/chat.js")
    assert "data-ui-key=\"show-thinking\"" in chat, \
        "chat.js: the settings-label game-build swap must target the show-thinking row"
    assert "'Production Notes '" in chat, \
        "chat.js: the game-build settings label is not renamed to 'Production Notes'"
    assert "Show the show’s production notes" in chat, \
        "chat.js: the game-build settings hint is not the diegetic 'production notes' copy"
    # The swap must be inside an isGameBuild() guard (operator/workspace keeps technical wording).
    guarded = re.search(
        r"if \(isGameBuild\(\)\)\s*\{[^}]*show-thinking", chat, re.DOTALL)
    assert guarded, "chat.js: the settings-label swap is not gated on isGameBuild()"


def test_workspace_settings_template_keeps_the_technical_wording():
    """The static template (served to BOTH builds; the JS swap only rewrites the game build)
    keeps the operator/technical wording so ORWELL_GAME_BUILD=0 is unchanged."""
    html = _read("static/index.html")
    assert "Thinking Process" in html and "Show &lt;think&gt; collapsible bars" in html, \
        "index.html: the workspace settings toggle must keep its technical wording"


# ── P1 invariant pins (must never regress under a label rename) ──

def test_reasoning_channel_split_is_intact():
    """The public reply is scrubbed of reasoning by CONSTRUCTION: the body renders roundReplyText
    (json.thinking falsy) and the accordion renders roundReasoningText (json.thinking truthy).
    A display-string rename must not touch this split."""
    chat = _read("static/js/chat.js")
    assert "let roundReplyText = '';" in chat
    assert "let roundReasoningText = '';" in chat
    # The routing line: reasoning → the reasoning buffer, everything else → the public reply.
    # ORW-59: the routing now lives in the pure applyDelta (chatStreamMachine.js); chat.js routes every delta through it.
    machine = _read("static/js/chatStreamMachine.js")
    assert "if (json.thinking) roundReasoningText += json.delta;" in machine
    assert "else roundReplyText += json.delta;" in machine
    assert "roundReplyText = _ad.roundReplyText;" in chat


def test_reasoning_stays_collapsed_by_default():
    """The game build shows the reasoning accordion collapsed by default (never auto-expanded),
    and scrubs reasoning out of the public reply — the P1 owner ruling."""
    md = _read("static/js/markdown.js")
    assert "export function gameBuildShowsThinkingAccordion" in md
    assert "export function gameBuildSuppressesThinking" in md
    # createThinkingSection never adds an `expanded` class at render time.
    section = md[md.index("function createThinkingSection"):]
    section = section[:section.index("\n}")]
    assert '"expanded"' not in section, \
        "markdown.js: the reasoning accordion must render collapsed (no 'expanded' class at render)"
