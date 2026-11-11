"""
agent_tools.py — Facade module.

Re-exports tool parsing, schemas, execution, and implementations
for backward compatibility. All importers continue to work unchanged.

Sub-modules:
  - tool_parsing.py: regex patterns, parse/strip functions
  - tool_schemas.py: FUNCTION_TOOL_SCHEMAS, function_call_to_tool_block
  - tool_execution.py: execute_tool_block, format_tool_result, MCP helpers
  - tool_implementations.py: all do_* tool functions
"""

import logging
from collections import namedtuple

from src.constants import MAX_OUTPUT_CHARS, MAX_READ_CHARS

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants (re-exported for backward compatibility — single source of truth
# is src.constants; always prefer importing from there for new code)
# ---------------------------------------------------------------------------
MAX_AGENT_ROUNDS = 50
SHELL_TIMEOUT = 60
PYTHON_TIMEOUT = 30

# Tool types that trigger execution
TOOL_TAGS = {"bash", "python", "web_search", "web_fetch", "read_file", "write_file", "edit_file",
             "grep", "glob", "ls",
             "create_document", "update_document", "edit_document",
             "search_chats",
             "chat_with_model", "create_session", "list_sessions",
             "send_to_session",
             "pipeline",
             "manage_session", "manage_memory", "list_models",
             "ui_control", "generate_image", "ask_user", "update_plan",
             "manage_tasks", "api_call", "ask_teacher", "manage_skills",
             "suggest_document",
             "manage_endpoints", "manage_mcp", "manage_webhooks",
             "manage_tokens", "manage_documents", "manage_settings",
             "manage_notes", "manage_calendar",
             "resolve_contact", "manage_contact", "list_email_accounts", "send_email", "list_emails",
             "read_email", "reply_to_email", "bulk_email", "archive_email",
             "delete_email", "mark_email_read",
             # Cookbook tools (LLM serving + downloads). Without these
             # entries, native function calls to e.g. list_served_models
             # are rejected as "Unknown function call" before reaching
             # the dispatcher — silent failure for the whole cookbook
             # surface.
             "download_model", "serve_model",
             "list_served_models", "stop_served_model",
             "list_downloads", "cancel_download",
             "search_hf_models", "list_cached_models",
             "list_serve_presets", "serve_preset", "adopt_served_model",
             "list_cookbook_servers",
             # Other tools the agent reaches for that were also missing.
             "edit_image", "trigger_research", "manage_research",
             # Big Brother game engine (Vault-free): the model drives the game by
             # calling these, then narrates the engine-decided results.
             "getGameState", "runCompetition", "recordInteraction", "surfaceInformationTo",
             "socialInitiatives", "diaryRoom", "makeDeal", "confide", "askJuror", "whereabouts", "moveTo",
             # 0107: named alliances — the player names a pact / accepts an NPC's pitch.
             "formAlliance", "joinAlliance",
             # 0093/0099: out a learned secret to the house / trade it to a houseguest for a favor.
             "exposeSecret", "tradeSecret",
             # 0094/0095: confront over a learned fact / accuse a pre-show tie (engine-decided).
             "confront", "accuseTie",
             # 0142: call in a favor a houseguest owes the player (engine-decided).
             "callInFavor",
             "premiereIntros", "markHouseguestMet",
             "seasonRecap", "seasonRetrospective", "npcVoice",
             # #1800 / #1793: the player's OWN Diary-Room record (receipts mirror + per-houseguest dossier).
             "playerReceipts", "playerDossier",
             # 0102: the daily "day in review" digest re-fetch (usually delivered inline on turnIn).
             "dailyRecap",
             # 0062: the move-in zeitgeist snapshot — public flavor + offscreenPrompt.
             "worldSnapshotView",
             "gameStatus", "getVisibleStateFor", "socialRead", "askProducers",
             "renderScene", "endOfSessionSummary",
             # God Mode (0016): admin-gated non-Vault levers (gated by _ADMIN_TOOLS).
             "inspectNonVaultState", "overrideMechanic", "configureGame", "manageSandbox", "sandboxHealth",
             # Weekly loop (0011): advance beats and resolve player decisions.
             "createCharacter", "updateCasting", "advanceGame", "submitDecision",
             # 0061: raise the self-eviction confirmation on a clear OOC intent to leave (no state change).
             "requestSelfEviction",
             # ADR 0006 (#1385): the player's bedtime lever — the engine ends their night, folds the
             # hidden rest penalty, rolls the house to morning, and delivers the 0102 dailyRecap inline.
             "turnIn",
             # Generic loopback to any UI-button endpoint (cookbook,
             # gallery, email folders, etc.) — agent uses this when
             # there's no named tool wrapper for the action.
             "app_api"}

# ---------------------------------------------------------------------------
# Game-build tool tiers (feature 0032). Under the game build the agent's tool
# surface collapses to three tiers:
#   KEEP     — always available (the engine/game-master + God Mode levers and a
#              handful of core UI/account tools whose backends survive the build).
#   OPTIONAL — general "power" tools that still work but are OFF by default for
#              security; the user opts them in via Settings -> Tools
#              (persisted as the `game_tools_enabled` list).
#   DROP     — everything else in TOOL_TAGS (scrapped/dead verticals: cookbook,
#              deep-research, gallery-edit, email, dead workspace mutations).
#              Computed = TOOL_TAGS - KEEP - OPTIONAL so newly inherited tools
#              default to dropped (fail-closed) rather than leaking in.
# ---------------------------------------------------------------------------
GAME_TOOL_KEEP = frozenset({
    # Big Brother game engine (Vault-free).
    "getGameState", "runCompetition", "recordInteraction", "surfaceInformationTo",
    "gameStatus", "getVisibleStateFor", "socialRead", "askProducers",
    # C13: the three prompt-advertised levers that were missing from the FE surface —
    # NPC approaches, the player's recorded confessional, and first-class deals (0039).
    "socialInitiatives", "diaryRoom", "makeDeal",
    # 0075: the trust-gated confide lever (the engine decides the disclosure; the model voices it).
    "confide",
    # 0129 slice 3: the juror-player asks a fellow juror what they know (the engine decides + records).
    "askJuror",
    # 0107: named alliances (Phase A formAlliance + Phase B joinAlliance) — player-driven, Vault-free.
    "formAlliance", "joinAlliance",
    # 0093/0099: expose a learned secret to the house / trade it to a houseguest (player-driven, Vault-free).
    "exposeSecret", "tradeSecret",
    # 0094/0095: confront a houseguest over a learned fact / accuse a pre-show tie (engine-decided, Vault-free).
    "confront", "accuseTie",
    # 0142: call in a favor a houseguest owes the player.
    "callInFavor",
    # B64/0049: the Vault-free presence read (lingering play has engine ground truth).
    "whereabouts",
    # L21/L24: the player walks where they choose; the engine never auto-relocates a person.
    "moveTo",
    # PREMIERE meet-everyone (#380): the premiere-only meet-everyone tracker — the read + the mark
    # (the engine guarantees all 15 NPCs are met before the first HOH; the model drives it from here).
    "premiereIntros", "markHouseguestMet",
    # B56/0048: the reunion reads — the public recap + the post-season Vault unsealing.
    "seasonRecap", "seasonRetrospective",
    # #1800 / #1793: the player's OWN Diary-Room record (receipts mirror + per-houseguest dossier).
    "playerReceipts", "playerDossier",
    # 0102: the daily "day in review" digest re-fetch (usually delivered inline on turnIn).
    "dailyRecap",
    # 0062: the move-in zeitgeist snapshot — public flavor + offscreenPrompt.
    "worldSnapshotView",
    # B65: the knowledge-bounded per-NPC voicing projection.
    "npcVoice",
    "renderScene", "endOfSessionSummary",
    # Weekly loop (0011).
    "createCharacter", "updateCasting", "advanceGame", "submitDecision",
    # 0061: raise the self-eviction confirmation on a clear OOC intent to leave (no state change).
    "requestSelfEviction",
    # ADR 0006 (#1385): the player's bedtime lever (the engine folds the hidden rest penalty; delivers the 0102 recap).
    "turnIn",
    # God Mode (0016): admin-gated non-Vault levers.
    "inspectNonVaultState", "overrideMechanic", "configureGame", "manageSandbox", "sandboxHealth",
    # In-fiction real-world lookups (C32, amends 0032): the model quietly searches when the
    # player references something real and replies in the houseguest's voice. Flavor only —
    # never game truth (the engine tools above stay the sole authority on game facts).
    "web_search",
    # Core UI / account tools whose backends survive the game build.
    "ask_user", "update_plan", "ui_control", "generate_image",
    "manage_settings", "manage_endpoints", "manage_tokens", "manage_mcp", "list_models",
})

GAME_TOOL_OPTIONAL = frozenset({
    # General "power" tools — still functional, but off by default for security.
    "bash", "python", "read_file", "write_file", "edit_file",
    "grep", "glob", "ls",
    "chat_with_model", "create_session", "list_sessions", "send_to_session",
    "pipeline", "manage_session",
    "api_call", "app_api",
    # E17 (2026-06-10 audit): transcript search lets the GM "remember" prior seasons
    # and OOC chats — a parallel memory rivaling the engine's stores ("memory is the
    # store *recalled*, never the chat *remembered*"). Off by default; opt-in only.
    "search_chats",
})


# A5 (2026-07-03): backstage account / provider / machinery-management tools that survive the game build
# (their backends work, so they stay in KEEP for the admin settings assistant) but must NEVER be handed
# to — or be recitable by — the IN-FICTION narrator on a game/casting turn. The live red-team asked the
# GM to "list your tools" and got the FULL manifest back, including these meta tools. They have no
# gameplay role; the player changes settings/endpoints/models through the Settings UI, never by asking
# the host. Stripped from the narrator's tool schema on game turns (agent_loop), left available on
# non-game (workspace/admin) turns.
GAME_NARRATOR_TOOL_DROP = frozenset({
    "manage_settings", "manage_endpoints", "manage_tokens", "manage_mcp", "list_models", "update_plan",
    # ORW-180: the UI-control tool (open panels / resend / focus) has no in-fiction role; it survived the game-build wall
    # when the keyword fallback matched "message"/"resend" (live 11-06). Never hand it to the game narrator.
    "ui_control",
})


def game_build_disabled_additions(game_tools_enabled=None) -> set:
    """Tool ids to force-OFF under the game build: every TOOL_TAG that is not in
    the keep-set and is not an opted-in optional tool. KEEP tools are never added
    here (they stay on unless the user disables them via disabled_tools)."""
    enabled_opt = set(game_tools_enabled or [])
    off = set()
    for tag in TOOL_TAGS:
        if tag in GAME_TOOL_KEEP:
            continue
        if tag in GAME_TOOL_OPTIONAL and tag in enabled_opt:
            continue
        off.add(tag)
    return off


ToolBlock = namedtuple("ToolBlock", ["tool_type", "content"])

# ---------------------------------------------------------------------------
# MCP Manager (kept here — used by execution and agent_loop)
# ---------------------------------------------------------------------------
_mcp_manager = None

def set_mcp_manager(manager):
    """Set the global MCP manager instance."""
    global _mcp_manager
    _mcp_manager = manager

def get_mcp_manager():
    """Get the global MCP manager instance."""
    return _mcp_manager

# ---------------------------------------------------------------------------
# Helpers (kept here — used by sub-modules)
# ---------------------------------------------------------------------------
def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    # Callers treat the result as text, so always return a string: coerce a
    # non-string (None -> "", otherwise str(...)) instead of returning it raw,
    # which would just move the crash downstream.
    if not isinstance(text, str):
        text = "" if text is None else str(text)
    if len(text) > limit:
        return text[:limit] + f"\n... (truncated, {len(text)} chars total)"
    return text

# ---------------------------------------------------------------------------
# Re-exports from sub-modules
# ---------------------------------------------------------------------------

# Parsing
from src.tool_parsing import (  # noqa: E402, F401
    parse_tool_blocks,
    strip_tool_blocks,
    tool_call_opener_index,
    _TOOL_NAME_MAP,
    _TOOL_BLOCK_RE,
    _TOOL_CALL_RE,
    _XML_TOOL_CALL_RE,
    _XML_INVOKE_RE,
    _XML_PARAM_RE,
)

# Schemas
from src.tool_schemas import (  # noqa: E402, F401
    FUNCTION_TOOL_SCHEMAS,
    function_call_to_tool_block,
    with_deal_depth_kinds,
    without_flagged_off_diary_tools,
    current_deal_kinds,
)

# Execution
from src.tool_execution import (  # noqa: E402, F401
    execute_tool_block,
    format_tool_result,
)

# Implementations
from src.tool_implementations import (  # noqa: E402, F401
    set_active_document,
    set_active_model,
    get_active_document,
    do_create_document,
    do_update_document,
    do_edit_document,
    do_suggest_document,
    do_search_chats,
    do_manage_skills,
    do_manage_tasks,
    do_manage_endpoints,
    do_manage_mcp,
    do_manage_webhooks,
    do_manage_tokens,
    do_manage_documents,
    do_manage_settings,
    do_api_call,
)
