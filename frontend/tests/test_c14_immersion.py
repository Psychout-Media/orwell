"""Queue C14 — game turns always act; the immersion bleed is closed.

Three guards:
  1. PREAMBLE SUBSTITUTION (audit N3/N5/N7): a game-framed turn gets the minimal game
     tool contract INSTEAD of the generic assistant preamble + rulebook — "You are an AI
     assistant" never co-occurs with the game-master prompt, and the rules that actively
     fought the game (improvise-after-failure, don't-search-what-you-know) are gone.
  2. TOOL-LESS PATHS REFUSE TO GAME-MASTER (audit F3): the sync /api/chat endpoint 409s
     on a game turn; a can_use_agent=False user keeps the agent path with the tool set
     collapsed to the game keep-set.
  3. DIEGETIC TOOL NODES (audit F6): engine tools render as production beats — label +
     status, never raw camelCase names or JSON payloads in the transcript.
"""

import importlib
import os

agent_loop = importlib.import_module("src.agent_loop")

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


GM_PROMPT = "You are Big Brother: the host. [GM-PROMPT-MARKER]"


def _system_text(game_mode) -> str:
    messages, _schemas = agent_loop._build_system_prompt(
        [{"role": "system", "content": GM_PROMPT},
         {"role": "user", "content": "hi"}],
        model="m", active_document=None, mcp_mgr=None,
        disabled_tools=set(), game_mode=game_mode,
    )
    return "\n\n".join(m["content"] for m in messages if m.get("role") == "system")


# --- 1. preamble substitution ---------------------------------------------------------

def test_game_turn_substitutes_the_preamble():
    text = _system_text(game_mode=True)
    assert "[GM-PROMPT-MARKER]" in text                       # the GM prompt leads
    assert "You are an AI assistant" not in text              # F6's contradiction gone
    assert "A failed tool is not a stopping condition" not in text   # N5's improvise rule gone
    assert "Don't search for things you already know" not in text    # N7's contradiction gone
    # the game tool contract is present
    assert "IF AN OUTCOME TOOL FAILS" in text
    assert "never state week, phase, HOH, nominees, or veto from recollection" in text
    assert "ONLY through submitDecision" in text
    assert "ask_user" in text                                  # F4: pending options as buttons


def test_non_game_turn_keeps_the_generic_preamble():
    text = _system_text(game_mode=False)
    assert "You are an AI assistant" in text
    assert "IF AN OUTCOME TOOL FAILS" not in text


def test_casting_turn_substitutes_the_casting_contract():
    # P3: a FRAMED pre-game (casting interview) turn substitutes too — the producer persona
    # must never stack on the generic assistant preamble + rulebook.
    text = _system_text(game_mode="casting")
    assert "[GM-PROMPT-MARKER]" in text                       # the interview prompt leads
    assert "You are an AI assistant" not in text
    assert "A failed tool is not a stopping condition" not in text
    assert "Don't search for things you already know" not in text
    # the casting tool contract is present (and the live-game rules are not)
    assert "updateCasting" in text
    assert "createCharacter" in text
    assert "casting interview" in text
    assert "IF AN OUTCOME TOOL FAILS" not in text


def test_outcome_error_rule_forbids_invented_results():
    p = agent_loop.GAME_AGENT_PREAMBLE
    assert "do NOT narrate any result" in p
    assert "improvise a winner" in p
    assert "live feed glitched" in p


def test_outcome_error_rule_forbids_blind_retry_of_committing_tools():
    # E23: a timed-out advanceGame may have already committed engine-side — the contract
    # demands a gameStatus re-read before any re-issue, never an unconditional retry.
    p = agent_loop.GAME_AGENT_PREAMBLE
    assert "NEVER" in p and "blindly retry advanceGame or submitDecision" in p
    assert "double-advance" in p
    assert "re-read gameStatus" in p
    assert "may already be resolved" in p
    assert "try the call once more" not in p  # the old blind-retry instruction is gone


# --- 2. tool-less paths ----------------------------------------------------------------

def test_sync_chat_declines_to_game_master():
    src = _read("routes", "chat_routes.py")
    assert "game turns must use the streaming chat" in src
    # the guard fires on ctx.game_active in the SYNC route (409), before any LLM call
    assert src.index("game turns must use the streaming chat") < src.index("Research injection")


def test_privilege_flip_keeps_the_agent_for_game_turns():
    src = _read("routes", "chat_routes.py")
    block = src[src.index('if not _privs.get("can_use_agent", True)'):]
    block = block[:600]
    assert "ctx.game_active" in block
    assert "game_build_disabled_additions" in block


def test_agent_loop_receives_game_mode():
    # P3: substitution keys on FRAMED, not game_active — a live game gets the game contract,
    # a framed pre-game turn gets the casting contract, an unframed turn keeps the generic
    # preamble (and feed-down turns never masquerade as casting).
    src = _read("routes", "chat_routes.py")
    block = src[src.index("game_mode=("):]
    block = block[:400]
    assert '"game" if ctx.game_active' in block
    assert '"casting" if (ctx.framed and not ctx.feed_down)' in block


# --- 3. diegetic tool nodes -------------------------------------------------------------

def test_game_tools_have_production_beat_labels():
    # Single source of truth (./orwellToolBeats.js), shared by the live + reload paths so
    # they cannot drift — a tool labelled live but not on reload was leaking raw names + JSON.
    beats = _read("static", "js", "orwellToolBeats.js")
    assert "export const ORWELL_TOOL_BEATS" in beats
    for tool in ("advanceGame", "submitDecision", "runCompetition", "diaryRoom",
                 "makeDeal", "socialInitiatives", "recordInteraction", "finaleView",
                 "updateCasting", "getGameState"):
        assert f"'{tool}':" in beats, f"{tool} missing a diegetic beat label"
    # both render paths consume the shared map, neither redefines it
    chat = _read("static", "js", "chat.js")
    renderer = _read("static", "js", "chatRenderer.js")
    assert "from './orwellToolBeats.js'" in chat
    assert "from './orwellToolBeats.js'" in renderer
    assert "const _orwellToolBeats = {" not in chat   # the inline copy is gone


def test_game_tool_nodes_suppress_raw_payloads():
    js = _read("static", "js", "chat.js")
    # tool start: args suppressed; tool output: args + raw JSON output suppressed
    assert "if (_beat) cmd = ''" in js
    assert "if (_beatOut) { cmd = ''; outHtml = ''; }" in js
    # the rendered label is the beat, not the raw tool name
    assert "_beatOut || json.tool" in js


def test_chatjs_imports_every_helper_it_calls():
    # REGRESSION GUARD (critical): #314 added isGameBuild() CALLS to chat.js but never imported
    # it, so handleChatSubmit threw `ReferenceError: isGameBuild is not defined` in the send path
    # — the player could not send ANY message in the game build (the chat POST never fired). The
    # source-string immersion tests asserted the CALLS but not the IMPORT, and the browser smoke
    # only checks page errors at LOAD time, never after a send. Every isGameBuild() user must
    # import it. (See test_send_path_has_no_undefined_refs in the browser smoke for the runtime guard.)
    chat = _read("static", "js", "chat.js")
    if "isGameBuild(" in chat:
        assert "isGameBuild" in chat[:chat.index("isGameBuild(")] and "from './orwellToolBeats.js'" in chat
        # specifically: isGameBuild rides the existing orwellToolBeats import
        import re
        imp = re.search(r"import\s*\{[^}]*\bisGameBuild\b[^}]*\}\s*from\s*'\./orwellToolBeats\.js'", chat)
        assert imp, "chat.js calls isGameBuild() but does not import it from orwellToolBeats.js"


# --- 4. reasoning is SEPARATED from the public bubble (default-collapsed accordion) ------
# Owner ruling 2026-06-20: the public bubble must carry ONLY the in-character narration; the
# model's reasoning/drafts/"rewind" must NOT mix into it — instead it streams into a condensed,
# default-COLLAPSED "Thinking" accordion (debug-viewable, expandable). See the thinking/public
# split tests in test_thinking_public_split.py for the routing + default-collapsed assertions.


def test_markdown_separates_reasoning_from_the_public_bubble_in_the_game_build():
    # markdown.js is the chokepoint every reload + final-render path funnels through. In the
    # game build the reply text is always SCRUBBED clean of reasoning, and the reasoning is
    # routed to its own (default-collapsed) accordion via gameBuildShowsThinkingAccordion().
    md = _read("static", "js", "markdown.js")
    assert "export function gameBuildSuppressesThinking()" in md
    assert "export function gameBuildShowsThinkingAccordion()" in md
    # the game-build markers + the admin/operator gates
    assert "data-game-build" in md
    assert "data-show-thinking" in md  # admin-only: legacy inline render off the game path
    assert "hide-thinking" in md       # operator opt-out fully hides the accordion
    # fail direction: a thrown suppress check still SCRUBS the reply (return true in the catch)
    cap = md[md.index("export function gameBuildSuppressesThinking()"):]
    cap = cap[:cap.index("export function gameBuildShowsThinkingAccordion")]
    assert "catch" in cap and "return true;" in cap
    # processWithThinking gates on the helpers: scrub the reply, render the accordion collapsed
    pwt = md[md.index("export function processWithThinking"):]
    assert "if (gameBuildSuppressesThinking())" in pwt
    gated = pwt[pwt.index("if (gameBuildSuppressesThinking())"):]
    gated = gated[:gated.index("let html = ''")]
    # the reply is still scrubbed (no reasoning preamble bleeds into the public bubble) ...
    assert "scrubReasoningPreamble(" in gated
    # ... and the reasoning now renders in its own accordion (gated on the show-accordion helper)
    assert "gameBuildShowsThinkingAccordion()" in gated
    assert "createThinkingSection(" in gated


def test_live_streaming_thinking_box_is_a_collapsed_accordion_in_the_game_build():
    # The LIVE stream path (chat.js): reasoning streams into the shared live-think box (a
    # collapsed accordion). The game build no longer suppresses it wholesale — only an operator
    # `body.hide-thinking` holds the bubble empty. The reply still renders scrubbed on close.
    chat = _read("static", "js", "chat.js")
    # the wholesale game-build suppression (`isGameBuild() && (hasUnclosedThink || isThinking)`)
    # is gone — the only game-build hold is gated on the operator hide-thinking opt-out.
    assert "if (isGameBuild() && (hasUnclosedThink || isThinking)) {" not in chat
    assert "isGameBuild() && document.body.classList.contains('hide-thinking')" in chat
    # the shared live-think box is built (the same collapsed accordion for game + non-game)
    assert "Create a live thinking box" in chat
    assert "live-think" in chat


def test_reload_path_reconstructs_collapsed_accordion_in_the_game_build():
    # The history-RELOAD path (chatRenderer.js) reconstructs thinking from metadata.thinking.
    # The game build now reconstructs too (no `!isGameBuild()` guard) and lets processWithThinking
    # render the default-collapsed accordion (or drop it under an operator hide-thinking opt-out).
    renderer = _read("static", "js", "chatRenderer.js")
    assert "metadata?.thinking && !isGameBuild()" not in renderer  # the old game-build skip is gone
    assert "role === 'assistant' && metadata?.thinking" in renderer
    assert "markdownModule.composeThinkSource(metadata.thinking, text, thinkTime, true)" in renderer  # A59: the shared helper builds the <think> source


def test_non_game_build_still_renders_the_collapsible_thinking():
    # NON-game build is UNCHANGED: processWithThinking still builds the collapsible thinking
    # section, and the reload path still reconstructs from metadata.thinking.
    md = _read("static", "js", "markdown.js")
    # the normal (non-game) branch still calls createThinkingSection
    assert "thinkingBlocks.forEach((block, index) => {" in md
    assert "html += createThinkingSection(block, index, thinkingTime);" in md
    # the reload reconstruction preserves its full <think>-reconstruction form
    renderer = _read("static", "js", "chatRenderer.js")
    assert "markdownModule.processWithThinking(" in renderer
    assert "markdownModule.composeThinkSource(metadata.thinking, text, thinkTime, true)" in renderer  # A59: the shared helper builds the <think> source


def test_streaming_tts_flag_is_function_scoped():
    # REGRESSION GUARD: streamingTTS was a `const` inside the stream-read block but READ in the
    # error/abort cleanup branch — a `ReferenceError` on any early submit error that masked the real
    # failure. It must be declared at the handleChatSubmit function scope (a hoisted `let`).
    chat = _read("static", "js", "chat.js")
    assert "let streamingTTS = false;" in chat
    assert "const streamingTTS =" not in chat  # never re-shadow it in an inner block


def test_game_build_never_labels_messages_with_the_model_name():
    # Immersion (visual audit): every AI message was labelled with the raw LLM model name
    # ("deepseek-v4-pro → …") — the narrator is the show, not a model. The game build uses a
    # diegetic sender on BOTH the live and reload paths.
    chat = _read("static", "js", "chat.js")
    # M2-5 + #1626: the diegetic sender is the DYNAMIC gameNarrator() byline (the season's producer,
    # "Production" until resolved), sourced from orwellToolBeats.js — never a per-site string literal.
    assert "data-game-build" in chat and "label = gameNarrator()" in chat
    renderer = _read("static", "js", "chatRenderer.js")
    assert renderer.count("isGameBuild() ? gameNarrator()") >= 2   # main reply + image bubble
    assert "(isGameBuild() && role === 'assistant') ? gameNarrator()" in renderer  # the _roleText path


def test_game_build_suppresses_the_model_name_tooltip():
    # OBS-RENDER-1: the visible sender said "Big Brother", but the role header still carried a
    # hover TOOLTIP with the raw "alias -> dated-version" model string ("deepseek-v4-pro ->
    # deepseek-v4-pro-20260423"). The model machinery must be INVISIBLE in the game build —
    # including the tooltip — on BOTH the live stream and the history-reload path.
    chat = _read("static", "js", "chat.js")
    renderer = _read("static", "js", "chatRenderer.js")
    # live path: the central _setRoleModelLabel helper strips the tooltip in the game build
    assert "if (isGameBuild()) {\n      roleEl.removeAttribute('title');" in chat
    # reload path: both the continuation-round and the main-reply title sites gate on the build
    assert "if (!isGameBuild() && pair.requestedModel" in renderer   # reload continuation round
    assert "if (!isGameBuild() && !isSlash && !isCompacted" in renderer  # reload main reply


def test_game_build_uses_diegetic_sender_on_placeholder_and_continuation():
    # The model name also flashed as the SENDER on the initial placeholder bubble, on stream
    # resume/reconnect, and on continuation rounds — before the resolved-model label landed.
    # A single source (_senderLabel) keeps every placeholder diegetic in the game build.
    chat = _read("static", "js", "chat.js")
    assert "function _senderLabel(" in chat
    assert "isGameBuild() ? gameNarrator()" in chat
    # the placeholder/resume/reconnect sites route their model label through _senderLabel
    assert chat.count("_senderLabel(") >= 4
    # (#829 turn-coalescing: a turn is now ONE bubble — there is no separate per-round
    # CONTINUATION bubble with its own byline. The one bubble's sender is set once via
    # _senderLabel (pinned above), so it stays diegetic across every round of the turn.)
    # a provider fallback stays diegetic too (no raw "(fallback)" model name reaches the player)
    assert "if (!isGameBuild()) {\n                        _rEl.textContent = _ansM + ' (fallback) ';" in chat


def test_game_build_suppresses_model_name_in_session_list():
    # OBS-RENDER-1 (sidebar follow-up): the session list appended "· deepseek-v4-pro" to every
    # chat's label AND its hover title — the same raw model machinery the chat header now hides.
    # In the game build the sidebar must stay diegetic too: title/label carry the chat name only.
    js = _read("static", "js", "sessions.js")
    assert "data-game-build" in js  # the list builder detects the build
    # the `· model` suffix on BOTH the visible label and the hover title is build-gated
    assert "if (s.model && !_gameBuild) label += ' · ' + s.model.split('/').pop();" in js
    assert "(s.model && !_gameBuild ? s.model.split('/').pop() + ' · ' : '')" in js


def test_reload_path_applies_production_beats():
    # The history-reload render (chatRenderer.js) was NOT applying the diegetic treatment
    # the live stream did — so re-opening a session leaked raw camelCase tool names and raw
    # engine JSON output on every reload (a Vault-Wall / refresh-persistence break).
    js = _read("static", "js", "chatRenderer.js")
    # L42: the import now also pulls orwellBeatOutcome (the Vault-free public-outcome deriver).
    # (Robust to the import list growing — ADR 0011 added orwellBeatIsSilent / ORWELL_MAX_VISIBLE_BEATS.)
    assert "from './orwellToolBeats.js'" in js
    for _name in ("ORWELL_TOOL_BEATS", "orwellBeatOutcome", "isGameBuild"):
        assert _name in js, _name
    assert "const _gbBeat = isGameBuild();" in js
    assert "const _beat = _gbBeat ? ORWELL_TOOL_BEATS[ev.tool] : null;" in js
    # a production beat suppresses output, screenshot, diff, and raw args, and relabels the pill
    assert "if (!_beat && ev.output && ev.output.trim())" in js
    assert "_beat ? null : safeToolScreenshotSrc(ev.screenshot)" in js
    assert "if (!_beat && ev.diff && ev.diff.text)" in js
    assert "!_beat && ev.command" in js
    # L42: the beat row renders the PUBLIC OUTCOME when present (else the plain beat label).
    assert "orwellBeatOutcome(ev.tool, ev.output)" in js
    assert "_evOutcome || _beat || ev.tool" in js
    assert "esc(_evToolText)" in js
