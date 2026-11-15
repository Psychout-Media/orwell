# src/constants.py
"""Application-wide constants and configuration values."""
import os

APP_VERSION = "1.0.0"

# Base paths
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + "/"
STATIC_DIR = os.path.join(BASE_DIR, "static")
# ORW-414: opt-in per-process data directory. Unset in every deployment (DATA_DIR stays <frontend>/data); the browser tests set it so each test
# stack gets its own sessions/settings/game-session/layout files instead of all sharing one checkout directory (which forced them to run one at a time).
DATA_DIR = os.environ.get("ORWELL_DATA_DIR_FE") or os.path.join(BASE_DIR, "data")
if os.environ.get("ORWELL_DATA_DIR_FE"):
    os.makedirs(DATA_DIR, exist_ok=True)

# Data file paths
SESSIONS_FILE = os.path.join(DATA_DIR, "sessions.json")
MEMORY_FILE = os.path.join(DATA_DIR, "memory.json")
MEMORY_DOC = os.path.join(DATA_DIR, "memory_doc.md")
PERSONAL_DIR = os.path.join(DATA_DIR, "personal_docs")
RUNBOOK_DIR = os.path.join(PERSONAL_DIR, "runbook")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
FEATURES_FILE = os.path.join(DATA_DIR, "features.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")

# Agent tool output limits (single source of truth — imported by tool_execution.py,
# tool_implementations.py, agent_tools.py, and any other module that needs them)
MAX_OUTPUT_CHARS = 10_000       # cap for bash/python/web_search/web_fetch output
MAX_READ_CHARS = 20_000         # cap for read_file / document preview
MAX_DIFF_LINES = 400            # cap for edit_file unified-diff display

# API Configuration
MAX_CONTEXT_MESSAGES = 90
REQUEST_TIMEOUT = 20
OPENAI_COMPAT_PATH = "/v1/chat/completions"

# Environment variables with defaults
DEFAULT_HOST = os.getenv("LLM_HOST", "localhost")
LLM_HOSTS = [h.strip() for h in os.getenv("LLM_HOSTS", "").split(",") if h.strip()]
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
SEARXNG_INSTANCE = os.getenv("SEARXNG_INSTANCE", "http://localhost:8080")


# Cleanup configuration
CLEANUP_ENABLED = os.getenv("CLEANUP_ENABLED", "True").lower() == "true"
CLEANUP_INTERVAL_HOURS = int(os.getenv("CLEANUP_INTERVAL_HOURS", "24"))

# Default parameters
DEFAULT_TEMPERATURE = 1.0
DEFAULT_MAX_TOKENS = 0


# ---------------------------------------------------------------------------
# Theme catalog (SET-4/SET-5, 2026-07-03 audit): a single source of truth for
# the built-in theme *names*, read straight out of static/js/theme.js's THEMES
# map instead of being hand-copied into N places. Before this, three separate
# hardcoded lists (the set_theme validation whitelist, the debug-build tool
# schema description, and the game-build prompt section) had each drifted from
# theme.js and from each other: the validation list was missing `glass` + the
# 5 house themes (feature 0052's flagship identity themes — the model's
# `set_theme` lever could never select them), while the OTHER two lists
# separately advertised six names (`nord`, `monokai`, `dracula`, `gruvbox`,
# `vaporwave`, `coffee`) that don't exist anywhere and always 400. Any consumer
# that needs "the valid theme names" should call `known_theme_names()` rather
# than re-hardcoding a list.
_THEME_JS_PATH = os.path.join(STATIC_DIR, "js", "theme.js")

# Fallback used only if theme.js is ever unreadable (should not happen in a
# normal checkout) — kept in sync manually as a last resort, not the source of
# truth. Order mirrors theme.js: glass leads, then the 5 house themes, then
# the classic set.
_THEME_NAMES_FALLBACK: tuple = (
    "glass",
    "the-feed", "telescreen", "room-101", "memory-wall", "sequester",
    "dark", "light", "midnight", "paper",
    "cyberpunk", "retrowave", "forest", "ocean", "ume", "copper",
    "terminal", "organs", "lavender", "gpt", "claude", "cute",
)

_theme_names_ordered_cache: "tuple | None" = None


def known_theme_names_ordered() -> tuple:
    """Return the built-in theme names in theme.js declaration order (glass,
    then the 5 house themes, then the classic set), parsed live from
    static/js/theme.js's `THEMES` map. Cached for the process lifetime —
    theme.js is a static asset, not something that changes at runtime."""
    global _theme_names_ordered_cache
    if _theme_names_ordered_cache is not None:
        return _theme_names_ordered_cache

    names = _THEME_NAMES_FALLBACK
    try:
        import re
        text = open(_THEME_JS_PATH, encoding="utf-8").read()
        m = re.search(r"export const THEMES = \{(.*?)\n\};", text, re.S)
        if m:
            # Top-level THEMES entries are indented exactly 2 spaces; nested
            # per-theme objects (e.g. gpt's `advanced: {...}` color overrides)
            # sit deeper and must NOT be picked up as theme names.
            found = re.findall(r"^  '?([a-z0-9-]+)'?:\s*\{", m.group(1), re.M)
            if found:
                names = tuple(dict.fromkeys(found))  # de-dup, preserve order
    except OSError:
        pass

    _theme_names_ordered_cache = names
    return names


def known_theme_names() -> "frozenset[str]":
    """Return the built-in theme names as a set (membership checks — e.g. the
    set_theme validation whitelist). See `known_theme_names_ordered()` for the
    display-ordered variant used in prose/prompt text."""
    return frozenset(known_theme_names_ordered())
