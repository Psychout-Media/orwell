"""
tool_schemas.py

OpenAI-compatible function tool schemas and the converter that turns
native function calls back into ToolBlocks for the execution pipeline.

Extracted from agent_tools.py to keep schema definitions separate from
tool parsing / execution logic.
"""

import json
import logging
from typing import Optional

from src.agent_tools import ToolBlock, TOOL_TAGS
from src.tool_parsing import _TOOL_NAME_MAP
from src.constants import known_theme_names_ordered
from src.orwell_engine import DECISION_KINDS as _DECISION_KINDS

logger = logging.getLogger(__name__)

# SET-4/SET-5 (2026-07-03 audit): the set_theme preset list advertised in the
# native tool description, read from the same single source of truth
# (static/js/theme.js) that do_ui_control's set_theme validation uses — this
# previously hardcoded six fictional names ("nord", "monokai", "gruvbox",
# "dracula", "vaporwave", "coffee") that don't exist anywhere and always 400'd,
# while separately omitting `glass` + the 5 house themes (feature 0052).
_SET_THEME_PRESETS_STR = ", ".join(known_theme_names_ordered())

# ---------------------------------------------------------------------------
# OpenAI-compatible function tool schemas
# ---------------------------------------------------------------------------
FUNCTION_TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Run a shell command (full access)",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "The shell command to execute"}
                },
                "required": ["command"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "python",
            "description": "Execute Python code to compute a result or test something",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "Python code to execute"}
                },
                "required": ["code"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Quick single web lookup for a fact or current event mid-task. NOT for 'research X' / 'do research on X' — those are deep-research jobs; use trigger_research instead.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "time_filter": {"type": "string", "enum": ["day", "week", "month", "year"], "description": "Optional freshness filter for news/latest/today queries"}
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": "Fetch and read the text content of a specific URL the user names (e.g. 'check example.com', 'what's on this page <url>'). Use when you already have a concrete URL/domain. NOT for open-ended searches (use web_search) or 'research X' jobs (use trigger_research).",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The URL or domain to fetch (http/https; a bare domain like example.com is fine)"}
                },
                "required": ["url"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file from disk. Optionally read a line range with offset/limit for large files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path to read"},
                    "offset": {"type": "integer", "description": "1-based line to start reading from (optional)"},
                    "limit": {"type": "integer", "description": "Max number of lines to read from offset (optional)"}
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "grep",
            "description": "Search file contents for a regular expression across a directory tree (uses ripgrep when available, respecting .gitignore). Returns file:line:match. PREFER this over `bash grep/rg` for code search — confined to the allowed roots, structured output.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regular expression to search for"},
                    "path": {"type": "string", "description": "Directory or file to search (optional; defaults to the project root)"},
                    "glob": {"type": "string", "description": "Only search files matching this glob, e.g. '*.py' (optional)"},
                    "ignore_case": {"type": "boolean", "description": "Case-insensitive match (optional)"},
                    "max_results": {"type": "integer", "description": "Max matches to return (optional)"}
                },
                "required": ["pattern"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "glob",
            "description": "Find files by glob pattern (recursive), newest first. e.g. '**/*.py'. PREFER this over `bash find/ls` for locating files — confined to the allowed roots.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern, e.g. '**/*.ts' or 'src/**/test_*.py'"},
                    "path": {"type": "string", "description": "Base directory (optional; defaults to the project root)"}
                },
                "required": ["pattern"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "ls",
            "description": "List the entries of a directory (folders first, then files with sizes). PREFER this over `bash ls` — confined to the allowed roots.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory to list (optional; defaults to the project root)"}
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write/save a file to disk",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path to write to"},
                    "content": {"type": "string", "description": "File content to write"}
                },
                "required": ["path", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Edit a file ON DISK by exact string replacement (home folder, project files, any real path like ~/sweden.txt or /path/to/file). This is the right tool for files on disk — NOT edit_document (that's for editor-panel documents). PREFER this over bash (sed/echo) — it shows a diff. old_string must match the file exactly and be unique (or set replace_all). Use write_file to create a new file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path to edit"},
                    "old_string": {"type": "string", "description": "Exact text to replace (must match the file, including indentation)"},
                    "new_string": {"type": "string", "description": "Replacement text"},
                    "replace_all": {"type": "boolean", "description": "Replace all occurrences instead of requiring a unique match"}
                },
                "required": ["path", "old_string", "new_string"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "create_document",
            "description": "Create a new document in the editor panel. Use this when the user asks to write, create, build, or generate code, scripts, programs, games, apps, or any substantial content (>15 lines) AND there is no already-open document/email draft that the request refers to. If an email compose draft is open, edit that draft instead of creating another document. NEVER put large code blocks directly in chat — use this tool instead.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Document title"},
                    "language": {"type": "string", "description": "Programming language or format (e.g. python, javascript, markdown, text)"},
                    "content": {"type": "string", "description": "The document content"}
                },
                "required": ["title", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "edit_document",
            "description": "Edit a document OPEN IN THE EDITOR PANEL (created via create_document) — NOT a file on disk. For files on disk (home folder, project files, anything with a path like ~/x.txt or /path/to/file) use edit_file instead. Targeted find-and-replace with multiple FIND/REPLACE pairs per call; use for any edit smaller than a full rewrite. Do NOT send the whole file back via update_document for small edits.",
            "parameters": {
                "type": "object",
                "properties": {
                    "edits": {
                        "type": "array",
                        "description": "List of find/replace edits (first match only per edit)",
                        "items": {
                            "type": "object",
                            "properties": {
                                "find": {"type": "string", "description": "Exact text to find in the document"},
                                "replace": {"type": "string", "description": "Text to replace it with"}
                            },
                            "required": ["find", "replace"]
                        }
                    }
                },
                "required": ["edits"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "suggest_document",
            "description": "Suggest improvements to the active document WITHOUT editing it. Creates inline comment bubbles the user can accept or reject. Use when the user asks for suggestions, review, improvements, or feedback.",
            "parameters": {
                "type": "object",
                "properties": {
                    "suggestions": {
                        "type": "array",
                        "description": "List of suggested changes with reasons",
                        "items": {
                            "type": "object",
                            "properties": {
                                "find": {"type": "string", "description": "Exact text in the document to suggest changing"},
                                "replace": {"type": "string", "description": "Suggested replacement text"},
                                "reason": {"type": "string", "description": "Brief explanation of why this change helps"}
                            },
                            "required": ["find", "replace", "reason"]
                        }
                    }
                },
                "required": ["suggestions"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "update_document",
            "description": "Replace the ENTIRE active document. ONLY use for genuine full rewrites (>50% of lines changed). For any smaller change, use edit_document — echoing back the whole file for small edits is wasteful.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "Complete new document content"}
                },
                "required": ["content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_chats",
            "description": "Search the user's past session transcripts by keyword. Use when the user asks about previous chats, past conversations, or when direct transcript evidence is better than persistent memory. Returns matching sessions with clickable links and nearby context.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search keyword(s) to find in past conversations"}
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "chat_with_model",
            "description": "Send a message to another AI model and get its response. Use for getting a second opinion, delegating subtasks, or AI-to-AI communication.",
            "parameters": {
                "type": "object",
                "properties": {
                    "model": {"type": "string", "description": "Model name (e.g. 'qwen3-32b') or model@endpoint_name"},
                    "message": {"type": "string", "description": "The message to send to the model"}
                },
                "required": ["model", "message"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "create_session",
            "description": "Create a new chat for ongoing conversations with a specific model. (The UI calls these 'chats'; 'session' is the internal term.)",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Name for the new chat"},
                    "model": {"type": "string", "description": "Model name or model@endpoint_name"}
                },
                "required": ["name", "model"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_sessions",
            "description": "List the user's chats (the UI calls them 'chats') as clickable markdown links. Use this to enumerate chats before opening, renaming, archiving, or deleting them. When replying to the user, preserve the returned [title](#session-id) links; do not strip them into plain text. Optionally filter by keyword.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filter": {"type": "string", "description": "Optional keyword to filter chats by name"}
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "send_to_session",
            "description": "Send a message to an existing chat and get the model's response. The chat keeps its conversation history.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "The id of the chat to send the message to"},
                    "message": {"type": "string", "description": "The message to send"}
                },
                "required": ["session_id", "message"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "pipeline",
            "description": "Run a multi-step AI pipeline where each model's output feeds the next. Example: Draft -> Critique -> Revise.",
            "parameters": {
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "description": "Pipeline steps in order",
                        "items": {
                            "type": "object",
                            "properties": {
                                "model": {"type": "string", "description": "Model name for this step"},
                                "instruction": {"type": "string", "description": "What this step should do"}
                            },
                            "required": ["model", "instruction"]
                        }
                    }
                },
                "required": ["steps"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_session",
            "description": "Manage a chat: rename, archive, unarchive, delete, mark important, truncate history, or fork it. (The UI calls these 'chats'; 'session' is the internal term.) For destructive actions like delete, call list_sessions first and pass the exact id returned there; never invent ids.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["rename", "archive", "unarchive", "delete", "important", "unimportant", "truncate", "fork"],
                               "description": "The action to perform"},
                    "session_id": {"type": "string", "description": "Exact target chat id from list_sessions, or 'current' for the active chat where supported"},
                    "value": {"type": "string", "description": "Action parameter: new name (rename), keep_count (truncate/fork)"}
                },
                "required": ["action", "session_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_memory",
            "description": "Manage the user's memory system: list, add, edit, delete, or search memories. Memories persist across sessions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "add", "edit", "delete", "search"],
                               "description": "The action to perform"},
                    "text": {"type": "string", "description": "Memory text (for add/edit) or search query (for search)"},
                    "memory_id": {"type": "string", "description": "Memory ID (for edit/delete)"},
                    "category": {"type": "string", "enum": ["fact", "event", "contact", "preference"],
                                 "description": "Memory category (for add/list filter)"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_models",
            "description": "List all available AI models across configured endpoints. Optionally filter by keyword.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filter": {"type": "string", "description": "Optional keyword to filter models"}
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "ui_control",
            "description": f"Control the user interface. Actions: toggle (turn tools on/off), open_panel (open a modal: documents/library, gallery, email, sessions, notes, memories/brain, skills, settings, cookbook), open_email_reply (open an email reply draft document; does NOT send), set_mode, switch_model, set_theme (presets: {_SET_THEME_PRESETS_STR}), create_theme (CREATE any custom theme with a name + colors object — pick distinctive, evocative hex colors that match the requested aesthetic, NOT generic defaults. The theme auto-applies after creation). When a user asks for ANY theme not in the preset list, ALWAYS use create_theme.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["toggle", "open_panel", "open_email_reply", "set_mode", "switch_model", "set_theme", "create_theme", "get_toggles"],
                               "description": "The UI action. Use set_theme for presets, create_theme to build a custom theme with any hex colors"},
                    "name": {"type": "string", "description": "For toggle: web, bash, research, incognito, document_editor (aliases: shell, search, deepresearch, documents). For open_panel: documents, gallery, email, sessions, notes, brain/memories, skills, settings, cookbook. For open_email_reply: email UID. For set_theme: a preset theme name. For create_theme: the custom theme name."},
                    "value": {"type": "string", "description": "Value: on/off for toggle, agent/chat for set_mode, model name for switch_model, theme name for set_theme, or folder for open_email_reply"},
                    "uid": {"type": "string", "description": "Email UID for open_email_reply"},
                    "folder": {"type": "string", "description": "Email folder for open_email_reply (default INBOX)"},
                    "mode": {"type": "string", "description": "Reply draft mode for open_email_reply: reply, reply-all, or ai-reply"},
                    "colors": {"type": "object", "description": "For create_theme: the theme colors",
                               "properties": {
                                   "bg": {"type": "string", "description": "Background color (hex, e.g. #1a1a2e)"},
                                   "fg": {"type": "string", "description": "Foreground/text color (hex)"},
                                   "panel": {"type": "string", "description": "Panel/sidebar background color (hex)"},
                                   "border": {"type": "string", "description": "Border/divider color (hex)"},
                                   "accent": {"type": "string", "description": "Accent color for buttons, brand, highlights (hex)"},
                                   "userBubbleBg": {"type": "string", "description": "User chat bubble background (hex, optional)"},
                                   "aiBubbleBg": {"type": "string", "description": "AI chat bubble background (hex, optional)"},
                                   "bubbleBorder": {"type": "string", "description": "Chat bubble border color (hex, optional)"},
                                   "sidebarBg": {"type": "string", "description": "Sidebar background override (hex, optional)"},
                                   "sectionAccent": {"type": "string", "description": "Section header accent color (hex, optional)"},
                                   "brandColor": {"type": "string", "description": "Brand/logo color (hex, optional)"},
                                   "inputBg": {"type": "string", "description": "Chat input background (hex, optional)"},
                                   "inputBorder": {"type": "string", "description": "Chat input border (hex, optional)"},
                                   "sendBtnBg": {"type": "string", "description": "Send button background (hex, optional)"},
                                   "sendBtnHover": {"type": "string", "description": "Send button hover color (hex, optional)"},
                                   "codeBg": {"type": "string", "description": "Code block background (hex, optional)"},
                                   "codeFg": {"type": "string", "description": "Code block text color (hex, optional)"},
                                   "toggleBg": {"type": "string", "description": "Toggle switch off background (hex, optional)"},
                                   "toggleActive": {"type": "string", "description": "Toggle switch on color (hex, optional)"},
                                   "accentPrimary": {"type": "string", "description": "Primary accent override (hex, optional)"},
                                   "accentError": {"type": "string", "description": "Error/danger color (hex, optional)"}
                               },
                               "required": ["bg", "fg", "panel", "border", "accent"]}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "ask_user",
            "description": "Ask the user a multiple-choice question to get a decision or clarification when the task is genuinely ambiguous and the answer changes what you do next (e.g. pick between approaches, confirm an assumption, choose a target). The user sees clickable option buttons; calling this ENDS your turn and their selection arrives as your next message. Prefer sensible defaults over asking — only ask when you truly cannot proceed well without the user's input. Do NOT use it to confirm irreversible/destructive actions that have a dedicated confirmation flow. In the Big Brother game, game levers are silent production machinery: NEVER use ask_user to ask permission to call a game tool, and NEVER use it to present the engine's pending BINDING decision options (nominations, votes, veto and finale choices) — the player's own decision card already presents those as buttons; re-asking with ask_user double-asks the same choice two ways. Reserve ask_user for a genuine non-binding clarification only.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {"type": "string", "description": "The question to ask. Be specific and self-contained."},
                    "options": {
                        "type": "array",
                        "description": "2-6 mutually exclusive choices. Each is an object with a short `label` and an optional `description` explaining the trade-off.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string", "description": "Concise choice text the user clicks (1-5 words)."},
                                "description": {"type": "string", "description": "Optional one-line explanation of this choice."}
                            },
                            "required": ["label"]
                        }
                    },
                    "multi": {"type": "boolean", "description": "Set true to let the user select multiple options instead of one. Default false."}
                },
                "required": ["question", "options"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "update_plan",
            "description": "Write back to the ACTIVE PLAN: mark steps done or revise them. Use this while executing an approved plan — after you finish a step, call update_plan with the full checklist and that step marked `- [x]`; when the user asks to change the plan, call it with the revised checklist. The user's docked plan window updates live. Pass the COMPLETE checklist every time (not a diff). No effect if there is no active plan.",
            "parameters": {
                "type": "object",
                "properties": {
                    "plan": {"type": "string", "description": "The full updated plan as a GitHub-style markdown checklist — one step per line, `- [ ]` for pending and `- [x]` for done. Always send the whole list."}
                },
                "required": ["plan"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_tasks",
            "description": "Manage scheduled/automated tasks: list, create, edit, delete, pause, resume, or run tasks. Use this for ANY recurring/scheduled request ('every morning…', 'each day at 7:30', 'daily summarize…') — create a task rather than doing it once. Task types: llm (AI runs a prompt), research (runs the deep-research pipeline on a question), or action (built-in automation). Triggers can be time-based or event-based.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "create", "edit", "delete", "pause", "resume", "run"],
                               "description": "The action to perform"},
                    "task_id": {"type": "string", "description": "Task ID (for edit/delete/pause/resume/run)"},
                    "name": {"type": "string", "description": "Task name"},
                    "prompt": {"type": "string", "description": "The instruction (for task_type=llm) or the research question (for task_type=research). Required for both."},
                    "task_type": {"type": "string", "enum": ["llm", "research", "action"],
                                  "description": "llm = AI runs your prompt; research = runs the deep-research pipeline on the prompt as a question; action = direct built-in function"},
                    "action_name": {"type": "string", "enum": [
                        "tidy_sessions", "tidy_documents", "consolidate_memory", "tidy_research",
                        "summarize_emails", "draft_email_replies", "extract_email_events",
                        "classify_events", "learn_sender_signatures",
                        "test_skills", "audit_skills", "check_email_urgency"
                    ],
                                    "description": "Built-in action (for task_type=action)"},
                    "trigger_type": {"type": "string", "enum": ["schedule", "event"],
                                     "description": "schedule = time-based, event = count-based"},
                    "schedule": {"type": "string", "enum": ["once", "daily", "weekly", "monthly"],
                                 "description": "Schedule frequency (for trigger_type=schedule)"},
                    "scheduled_time": {"type": "string", "description": "HH:MM in UTC (for schedule triggers). Convert the user's stated local time using the UTC offset given in the 'Current date and time' context."},
                    "scheduled_day": {"type": "integer", "description": "Day of week 0=Mon (weekly) or day of month (monthly)"},
                    "trigger_event": {"type": "string", "enum": ["session_created", "message_sent", "document_created", "memory_added", "research_completed", "email_received", "skill_added"],
                                      "description": "Event name (for trigger_type=event)"},
                    "trigger_count": {"type": "integer", "description": "Fire every N events (for trigger_type=event)"},
                    "output_target": {"type": "string", "description": "Where results go. Defaults to 'session' (results land in a dedicated chat session the user reads) — this is the right choice for 'summarize for me' / 'send to me'. Do NOT go hunting for the user's email address; only use an email MCP tool name here if the user explicitly asked to be emailed AND an address is already known."}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_calendar",
            "description": "Manage calendar events: list events in a date range, create, update, delete. Each event can carry a tag/category (event_type) and importance level. Resolve relative dates like today/tomorrow against the 'Current date and time' system context, then pass ISO 8601 datetimes in the user's local wall time; for all-day events set all_day=true and pass YYYY-MM-DD. For event reminders/alarms, pass reminder_minutes; the tool creates the Orwell note reminder, so do not also call manage_notes for the same reminder.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string",
                               "enum": ["list_events", "create_event", "update_event", "delete_event", "list_calendars"],
                               "description": "Action to perform"},
                    "summary": {"type": "string", "description": "Event title (for create/update)"},
                    "dtstart": {"type": "string", "description": "Start ISO datetime, or YYYY-MM-DD if all_day"},
                    "dtend": {"type": "string", "description": "End ISO datetime; defaults to +1h (or +1 day for all_day)"},
                    "all_day": {"type": "boolean", "description": "Whether this is an all-day event"},
                    "description": {"type": "string", "description": "Event description / notes"},
                    "location": {"type": "string", "description": "Event location"},
                    "uid": {"type": "string", "description": "Event UID (for update/delete)"},
                    "calendar_href": {"type": "string", "description": "Specific calendar URL (optional; defaults to first calendar)"},
                    "calendar": {"type": "string", "description": "Filter list_events by calendar name or href"},
                    "start": {"type": "string", "description": "list_events range start (ISO datetime); defaults to today. Prefer start; backend also accepts start_date, range_start, from, dtstart, since."},
                    "end": {"type": "string", "description": "list_events range end (ISO datetime); defaults to +14 days. Prefer end; backend also accepts end_date, range_end, to, dtend, until."},
                    "event_type": {"type": "string", "description": "Tag / category for the event. Common values: work, personal, health, travel, meal, social, admin, other. Aliases accepted: tag, category, type."},
                    "importance": {"type": "string", "enum": ["low", "normal", "high", "critical"], "description": "Priority level (defaults to 'normal')"},
                    "reminder_minutes": {"type": "integer", "description": "For create_event: create an Orwell reminder this many minutes before the event, e.g. 5 for 'reminder 5 min before'."},
                    "rrule": {"type": "string", "description": "Recurrence rule in iCalendar RRULE format, e.g. 'FREQ=WEEKLY;BYDAY=MO' for weekly on Monday. Use with create_event or update_event."}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_notes",
            "description": "Manage notes and checklists (Google Keep-style): list, add, update, delete, toggle_item. IMPORTANT: For to-do lists / checklists, set note_type='checklist' and pass the items as the `checklist_items` array — do NOT serialize them into `content` as plain text. For freeform notes, use note_type='note' and put the body in `content`. `due_date` accepts natural language like 'tomorrow at 9am' (parsed in the user's timezone) and fires a notification — do not also create a calendar event for the same reminder.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string",
                               "enum": ["list", "add", "update", "delete", "toggle_item"],
                               "description": "The action to perform"},
                    "id": {"type": "string", "description": "Note id (for update/delete/toggle_item); 8-char prefix is fine"},
                    "title": {"type": "string", "description": "Note title (for add/update)"},
                    "content": {"type": "string", "description": "Freeform body text. Use this for note_type='note'. Do NOT use this for checklists — pass `checklist_items` instead."},
                    "note_type": {"type": "string", "enum": ["note", "checklist"],
                                  "description": "'note' = freeform text in `content`. 'checklist' = structured to-do items in `checklist_items`. Defaults to 'checklist' if checklist_items is supplied, else 'note'."},
                    "checklist_items": {"type": "array",
                                        "items": {"type": "object",
                                                  "properties": {
                                                      "text": {"type": "string", "description": "The to-do item text"},
                                                      "done": {"type": "boolean", "description": "Whether the item is checked off"}
                                                  },
                                                  "required": ["text"]},
                                        "description": "Checklist items for note_type='checklist'. Each item is {text, done}. REQUIRED for checklists — leaving this empty produces a blank note."},
                    "color": {"type": "string", "description": "Optional color label (e.g. 'yellow', 'blue', 'green')"},
                    "label": {"type": "string", "description": "Optional category label (also used as a list filter)"},
                    "pinned": {"type": "boolean", "description": "Pin the note to the top"},
                    "archived": {"type": "boolean", "description": "For update: archive/unarchive. For list: show archived notes when true."},
                    "due_date": {"type": "string", "description": "Reminder time. Accepts natural language ('tomorrow at 9am', '11pm today') or ISO 8601. Fires a notification at that time."},
                    "index": {"type": "integer", "description": "Checklist item index (for toggle_item, 0-based)"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "api_call",
            "description": "Call a registered API integration (RSS reader, git forge, bookmark manager, smart home, etc.). Check the system context for available integrations and their endpoints.",
            "parameters": {
                "type": "object",
                "properties": {
                    "integration": {"type": "string", "description": "Integration name or ID (e.g. 'Miniflux', 'Gitea')"},
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"], "description": "HTTP method"},
                    "path": {"type": "string", "description": "API endpoint path (e.g. '/v1/entries?status=unread&limit=20')"},
                    "body": {"type": "object", "description": "JSON request body (for POST/PUT/PATCH)"}
                },
                "required": ["integration", "method", "path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "ask_teacher",
            "description": "Ask a more capable AI model for help when stuck on a difficult problem. The teacher provides guidance that can be saved as a learned skill.",
            "parameters": {
                "type": "object",
                "properties": {
                    "model": {"type": "string", "description": "Teacher model name (e.g. 'claude-sonnet-4') or 'auto' for configured default"},
                    "problem": {"type": "string", "description": "Describe the problem or question you need help with"}
                },
                "required": ["problem"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_skills",
            "description": (
                "Read or modify the user's skill library. Skills are SKILL.md files "
                "(YAML frontmatter + structured body: When to Use / Procedure / "
                "Pitfalls / Verification) and follow a draft → published lifecycle. "
                "Use progressive disclosure: 'list' to see what exists, 'view' to "
                "load full content for a single skill, 'view_ref' for sub-files. "
                "Use 'patch' for surgical text edits and 'edit' for full rewrites. "
                "'publish' once you've verified the procedure works. For add, "
                "always provide an explicit name slug and only tell the user the "
                "exact name returned by the tool."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "view", "view_ref", "add", "edit", "patch", "publish", "delete", "search"], "description": "list = name+description summary; view = full SKILL.md; view_ref = sub-file under the skill dir; add = create; edit = full rewrite (content); patch = old_string→new_string; publish = flip status; delete; search = relevance match on published skills."},
                    "name": {"type": "string", "description": "Slug/name of the skill. Required for add/view/view_ref/edit/patch/publish/delete. For add, choose the exact kebab-case name the user should see and report only the returned name."},
                    "path": {"type": "string", "description": "Sub-path under the skill directory for view_ref (e.g. 'references/example.md')."},
                    "description": {"type": "string", "description": "One-line summary surfaced in the skills index (for add)."},
                    "category": {"type": "string", "description": "Organizational grouping like 'dev', 'email', 'system' (for add)."},
                    "when_to_use": {"type": "string", "description": "Trigger conditions in plain English (for add)."},
                    "procedure": {"type": "array", "items": {"type": "string"}, "description": "Numbered steps (for add)."},
                    "pitfalls": {"type": "array", "items": {"type": "string"}, "description": "Known failure modes + recovery (for add)."},
                    "verification": {"type": "array", "items": {"type": "string"}, "description": "How to confirm the procedure succeeded (for add)."},
                    "tags": {"type": "array", "items": {"type": "string"}, "description": "Keyword tags (for add)."},
                    "platforms": {"type": "array", "items": {"type": "string"}, "description": "Restrict to OSes (for add)."},
                    "requires_toolsets": {"type": "array", "items": {"type": "string"}, "description": "Hide unless these toolsets are active (for add)."},
                    "fallback_for_toolsets": {"type": "array", "items": {"type": "string"}, "description": "Hide when these toolsets are active (for add)."},
                    "status": {"type": "string", "enum": ["draft", "published"], "description": "Defaults to 'draft' on add."},
                    "version": {"type": "string", "description": "Semver-ish, e.g. '1.0.0' (for add)."},
                    "confidence": {"type": "number", "description": "0-1 (for add/publish)."},
                    "content": {"type": "string", "description": "Full SKILL.md text (for edit)."},
                    "old_string": {"type": "string", "description": "Exact substring to replace (for patch). Must appear exactly once."},
                    "new_string": {"type": "string", "description": "Replacement text (for patch)."},
                    "query": {"type": "string", "description": "Search query (for search)."}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_endpoints",
            "description": "Manage model API endpoints: list configured endpoints, add new ones, delete, enable or disable them.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "add", "delete", "enable", "disable"]},
                    "endpoint_id": {"type": "string", "description": "Endpoint ID (for delete/enable/disable)"},
                    "name": {"type": "string", "description": "Display name (for add)"},
                    "base_url": {"type": "string", "description": "API base URL e.g. https://api.openai.com/v1 (for add)"},
                    "api_key": {"type": "string", "description": "API key (for add)"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_mcp",
            "description": "Manage MCP (Model Context Protocol) tool servers: list servers and their tools, add new servers, delete, enable/disable, reconnect, or list all available tools.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "add", "delete", "enable", "disable", "reconnect", "list_tools"]},
                    "server_id": {"type": "string", "description": "Server ID (for delete/enable/disable/reconnect)"},
                    "name": {"type": "string", "description": "Server name (for add)"},
                    "command": {"type": "string", "description": "Command to run e.g. npx (for add)"},
                    "args": {"type": "array", "items": {"type": "string"}, "description": "Command arguments (for add)"},
                    "env": {"type": "object", "description": "Environment variables (for add)"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_webhooks",
            "description": "Manage webhooks: list, add, delete, enable or disable webhook endpoints.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "add", "delete", "enable", "disable"]},
                    "webhook_id": {"type": "string", "description": "Webhook ID (for delete/enable/disable)"},
                    "name": {"type": "string", "description": "Webhook name (for add)"},
                    "url": {"type": "string", "description": "Webhook URL (for add)"},
                    "events": {"type": "string", "description": "Comma-separated event names (for add)"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_tokens",
            "description": "Manage API access tokens: list existing tokens, create new ones, or delete them.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "create", "delete"]},
                    "token_id": {"type": "string", "description": "Token ID (for delete)"},
                    "name": {"type": "string", "description": "Token name (for create)"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_documents",
            "description": "Manage documents: list all documents (with optional search/language filter), delete documents, or run tidy cleanup.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "delete", "tidy"]},
                    "document_id": {"type": "string", "description": "Document ID (for delete)"},
                    "search": {"type": "string", "description": "Search query (for list)"},
                    "language": {"type": "string", "description": "Filter by language (for list)"},
                    "limit": {"type": "integer", "description": "Max results (for list, default 50)"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_settings",
            "description": "Manage user preferences and settings. Use `disable_tool`/`enable_tool`/`list_tools` to turn individual tools on or off globally (e.g. shell, search, browser, documents, memory, skills, images, tasks, notes, calendar, email). Use list/get/set/delete for free-form preferences.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "get", "set", "delete", "disable_tool", "enable_tool", "list_tools"]},
                    "key": {"type": "string", "description": "Setting key (for get/set/delete)"},
                    "value": {"description": "Setting value (for set) — can be string, number, boolean, or object"},
                    "tool": {"type": "string", "description": "Tool name to disable/enable (for disable_tool/enable_tool). Accepts aliases: shell, search, browser, documents, memory, skills, images, tasks, notes, calendar, email — or a raw tool name like 'bash' or 'web_search'."}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "download_model",
            "description": "Download a HuggingFace model to a server. If `host` is omitted, defaults to the cookbook's currently-selected server (NOT localhost) — call list_cookbook_servers first if you're unsure where it should go.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo_id": {"type": "string", "description": "HuggingFace repo (e.g. 'Qwen/Qwen3-8B')"},
                    "host": {"type": "string", "description": "Target server — use the friendly NAME from list_cookbook_servers (e.g. 'gpu-box', 'workstation') or a raw user@host. Omit to use the cookbook's selected default server."},
                    "local": {"type": "boolean", "description": "Force download to THIS machine (localhost) instead of the default remote server."},
                    "include": {"type": "string", "description": "Glob filter for specific files (e.g. '*Q4_K_M*')"},
                },
                "required": ["repo_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "serve_model",
            "description": "Start serving a model with vLLM, SGLang, llama.cpp, Ollama, or Diffusers. If `host` is omitted, defaults to the cookbook's selected server (not localhost). For image/inpainting/diffusion models use the built-in command `python3 scripts/diffusion_server.py --model <repo> --port 8100` rather than inventing a custom diffusers API server. After launching, call list_served_models to check readiness/errors; if it reports a diagnosis with retry suggestions, retry via serve_model using the suggested adjusted cmd.",
            "parameters": {
                "type": "object",
                "properties": {
                    "repo_id": {"type": "string", "description": "Model repo (e.g. 'Qwen/Qwen3-8B')"},
                    "cmd": {"type": "string", "description": "Full serve command (e.g. 'vllm serve Qwen/Qwen3-8B --port 8000 --tp 2', 'python3 -m sglang.launch_server --model-path Qwen/Qwen3-8B --port 30000', or for inpainting/image models: 'python3 scripts/diffusion_server.py --model diffusers/stable-diffusion-xl-1.0-inpainting-0.1 --port 8100')"},
                    "host": {"type": "string", "description": "Target server — friendly NAME from list_cookbook_servers (e.g. 'gpu-box', 'workstation') or raw user@host. Omit to use the cookbook's selected default."},
                    "local": {"type": "boolean", "description": "Force serve on THIS machine instead of the default remote server."},
                },
                "required": ["repo_id", "cmd"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_served_models",
            "description": "List currently running model servers with status, model name, port, throughput, and structured Cookbook diagnoses. If a serve failed, this includes recent logs plus retry suggestions/adjusted commands the agent can use with serve_model.",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "stop_served_model",
            "description": "Stop a running model server.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "Tmux session ID of the server to stop"},
                },
                "required": ["session_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "tail_serve_output",
            "description": "Read the last N lines of a cookbook serve/download task's tmux pane. Use ONLY in this exact sequence: (1) the user asked to serve a model, (2) you launched it via serve_model, (3) list_served_models reports the NEW task as crashed/error, (4) call tail_serve_output on the new sessionId to find the root cause, (5) call serve_model again with adjusted flags. DO NOT call this on old stopped/completed download tasks — they are historical and won't tell you anything about the current attempt. DO NOT investigate past failures before launching; the environment may have changed since.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "Tmux session id from list_served_models (e.g. 'serve-abc12345', 'cookbook-a1b2c3d4')."},
                    "tail": {"type": "integer", "description": "How many lines of pane scrollback to fetch (default 300, max 4000). Bump this if the error in the visible tail references an earlier line ('see root cause above')."},
                },
                "required": ["session_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_downloads",
            "description": "List in-progress model downloads in the Cookbook. Shows each download's model name, phase, percent (if available), session ID, and remote host.",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "cancel_download",
            "description": "Cancel an in-progress model download by killing its tmux session. Use list_downloads first to get the session_id.",
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "Tmux session ID from list_downloads (e.g. 'cookbook-a1b2c3d4')"},
                },
                "required": ["session_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_hf_models",
            "description": "Search HuggingFace for models matching a query. Returns a ranked list of repo IDs, sizes (when available), and download counts. Use this when the user wants to find a model to download.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search terms (e.g. 'Qwen 8B', 'flux', 'llama-3 instruct')"},
                    "limit": {"type": "integer", "description": "Max results (default 10)"},
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_cookbook_servers",
            "description": "List the cookbook's configured servers (remote GPU boxes + local) and the current default host. Call this before download_model/serve_model when the user didn't specify a host, so models go to the right machine (where the GPUs and model cache are) instead of localhost. If multiple servers and intent is ambiguous, show them and ask the user which.",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_serve_presets",
            "description": "List saved Cookbook serve presets. Each preset is a launch template (name, model, host, port, tmux cmd) the user previously saved from the UI. Call this BEFORE serve_model when the user asks to launch a model by name — there's almost always a working preset for it.",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "adopt_served_model",
            "description": "Register an existing tmux model server (started manually or outside the cookbook flow) into Cookbook tracking, AND add it as a chat endpoint. Use when the user (or you) launched something via ssh+tmux and now want it visible in the UI / stoppable via stop_served_model / usable in the model picker. Verifies the tmux session + port respond before adding.",
            "parameters": {
                "type": "object",
                "properties": {
                    "host": {"type": "string", "description": "Remote host in user@host form (e.g. 'user@192.0.2.10'). Omit for localhost."},
                    "tmux_session": {"type": "string", "description": "Existing tmux session name (e.g. 'minimax-m27')"},
                    "model": {"type": "string", "description": "Model repo_id or display name (e.g. 'cyankiwi/MiniMax-M2.7-AWQ-4bit')"},
                    "port": {"type": "integer", "description": "Port the server is listening on (default 8000)"},
                    "name": {"type": "string", "description": "Optional display name (defaults to model basename)"},
                    "add_endpoint": {"type": "boolean", "description": "Also register as a chat endpoint (default true)"}
                },
                "required": ["tmux_session", "model"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "serve_preset",
            "description": "Launch a saved Cookbook serve preset by name. Reuses the exact tmux command + host the user saved before. This is the preferred way to start a known model (SD3.5, vLLM presets, etc.) — don't fabricate launch commands when a preset exists.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Preset name (exact or case-insensitive substring of one returned by list_serve_presets)"},
                },
                "required": ["name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_cached_models",
            "description": "List models already cached on disk locally or on a remote server. `host` accepts friendly Cookbook server names from list_cookbook_servers (for example ajax) or raw user@host. Also reports completed Cookbook download tasks when the filesystem cache scan cannot locate the HF cache path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "host": {"type": "string", "description": "Friendly Cookbook server name (e.g. 'ajax', 'gpu-box') or raw remote host (e.g. 'user@gpu-box'). Omit for local."},
                    "model_dir": {"type": "string", "description": "Comma-separated additional model directories to scan beyond ~/.cache/huggingface/hub"},
                    "ssh_port": {"type": "string", "description": "SSH port for remote host (default 22)"},
                    "platform": {"type": "string", "enum": ["linux", "windows"], "description": "Remote platform"}
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "app_api",
            "description": "Generic loopback to allowed internal Orwell endpoints. Use this when there's no named tool for what the user wants. Hits the same routes the UI buttons hit (cookbook, gallery, library/documents, memory, notes, calendar, tasks, settings, themes, research, compare, etc.). action='endpoints' returns the OpenAPI surface (use `filter` to narrow). action='call' (default) takes method+path+body. Sensitive auth/user/admin/shell paths and host-control Cookbook mutation routes are blocked for safety. Do not use for shell commands; use named command tooling instead. Do not use for package installs, engine rebuilds, PID signalling, or email account discovery; use list_email_accounts for email accounts because /api/email/accounts is owner-filtered in tool context.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["call", "endpoints"], "description": "'call' to hit an endpoint, 'endpoints' to list what's available"},
                    "path": {"type": "string", "description": "Endpoint path starting with /api/ (e.g. '/api/cookbook/gpus', '/api/gallery/list', '/api/calendar/events')"},
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"], "description": "HTTP method (default GET)"},
                    "body": {"type": "object", "description": "JSON request body for POST/PUT/PATCH"},
                    "query": {"type": "object", "description": "Querystring params as a key-value object"},
                    "filter": {"type": "string", "description": "For action=endpoints: substring to filter paths/summaries (e.g. 'cookbook', 'gallery')"}
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "edit_image",
            "description": "Edit a gallery image: upscale, remove background, inpaint, or harmonize.",
            "parameters": {
                "type": "object",
                "properties": {
                    "image_id": {"type": "string", "description": "Gallery image ID"},
                    "action": {"type": "string", "enum": ["upscale", "rembg", "inpaint", "harmonize"], "description": "Edit action"},
                    "prompt": {"type": "string", "description": "For inpaint: what to fill the masked area with"},
                    "scale": {"type": "number", "description": "For upscale: scale factor (default 2)"},
                },
                "required": ["image_id", "action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "trigger_research",
            "description": "Start a deep research task on a topic. Returns a task ID for tracking.",
            "parameters": {
                "type": "object",
                "properties": {
                    "topic": {"type": "string", "description": "Research question or topic"},
                },
                "required": ["topic"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "resolve_contact",
            "description": "Look up a contact's email address by name. Searches CardDAV address book and sent email history. Use when the user says 'message [name]' or 'email [name]' without an email address.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Person's name to search for"},
                },
                "required": ["name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "manage_contact",
            "description": "Create, update, delete, or list the user's CardDAV contacts. Use to save a new contact ('save Jonathan's email jon@x.com'), update an existing one ('change Maria's number'), or remove one. For update/delete you need the contact's uid — call action='list' first to find it. Writes go through the same dedupe + validation as the Contacts UI.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["list", "add", "update", "delete"],
                               "description": "list = show all contacts (with uids); add = create; update = edit by uid; delete = remove by uid."},
                    "uid": {"type": "string", "description": "Contact UID (required for update/delete; get it from action=list)."},
                    "name": {"type": "string", "description": "Contact's display name (for add/update)."},
                    "email": {"type": "string", "description": "Single email address (convenience for add, or the primary email for update)."},
                    "emails": {"type": "array", "items": {"type": "string"}, "description": "Full list of email addresses (for update; first is primary)."},
                    "phones": {"type": "array", "items": {"type": "string"}, "description": "Full list of phone numbers (for update)."},
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_email_accounts",
            "description": "List configured email accounts. Use this before checking mail when the user names a mailbox/account such as Gmail, work, or a custom domain, then pass the returned account name/email/id to the other email tools.",
            "parameters": {
                "type": "object",
                "properties": {},
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "send_email",
            "description": "Send a new email. Use resolve_contact first if you only have a name and need to find the email address. If multiple accounts exist, pass account from list_email_accounts.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {"type": "string", "description": "Recipient email address"},
                    "subject": {"type": "string", "description": "Email subject line"},
                    "body": {"type": "string", "description": "Email body text"},
                    "account": {"type": "string", "description": "Optional account name/email/id from list_email_accounts, e.g. Gmail or user@example.com"},
                },
                "required": ["to", "subject", "body"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_emails",
            "description": "List emails from an account/folder, newest first. Returns subject, sender, date, UID, and account for each email. Use list_email_accounts first when the user mentions Gmail/work/a custom mailbox. For last/latest/newest email requests, use max_results=1 and unread_only=false.",
            "parameters": {
                "type": "object",
                "properties": {
                    "folder": {"type": "string", "description": "IMAP folder (default: INBOX)"},
                    "max_results": {"type": "integer", "description": "Max emails to return (default: 20)"},
                    "limit": {"type": "integer", "description": "Backward-compatible alias for max_results"},
                    "unread_only": {"type": "boolean", "description": "Only show unread emails. Default false; set true only when the user asks for unread emails."},
                    "unresponded_only": {"type": "boolean", "description": "Only show unanswered emails. Default false."},
                    "account": {"type": "string", "description": "Optional account name/email/id from list_email_accounts, e.g. Gmail or user@example.com"},
                },
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_email",
            "description": "Read the full content of a specific email by UID.",
            "parameters": {
                "type": "object",
                "properties": {
                    "uid": {"type": "string", "description": "Email UID to read"},
                    "folder": {"type": "string", "description": "IMAP folder (default: INBOX)"},
                    "account": {"type": "string", "description": "Optional account name/email/id from list_email_accounts, especially when the UID came from a non-default mailbox"},
                },
                "required": ["uid"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "reply_to_email",
            "description": "SEND a reply email immediately by UID. Do not use this when the user asks to open/start a reply window or draft; use ui_control action=open_email_reply instead. For follow-up 'reply ...' requests where the user clearly wants to send now, use the exact UID from the latest read_email/list_emails result; never invent UID 1. Automatically threads with In-Reply-To/References headers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "uid": {"type": "string", "description": "Exact UID of the email to reply to from list_emails/read_email; never invent UID 1"},
                    "body": {"type": "string", "description": "Reply body text"},
                    "folder": {"type": "string", "description": "IMAP folder (default: INBOX)"},
                    "account": {"type": "string", "description": "Optional account name/email/id from list_email_accounts, especially when the UID came from a non-default mailbox"},
                },
                "required": ["uid", "body"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "bulk_email",
            "description": "Perform one action on many emails at once. Use this for 'delete all those', 'archive these', 'mark all read', or any bulk operation after list_emails. Always pass account when the listed emails came from a named account such as Gmail.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["mark_read", "mark_unread", "archive", "delete", "junk"], "description": "Bulk action to perform"},
                    "uids": {"type": "array", "items": {"type": "string"}, "description": "UIDs from the latest list_emails result"},
                    "all_unread": {"type": "boolean", "description": "Operate on all unread messages in folder instead of explicit UIDs"},
                    "folder": {"type": "string", "description": "IMAP folder (default: INBOX)"},
                    "permanent": {"type": "boolean", "description": "For delete: hard-delete instead of moving to Trash"},
                    "account": {"type": "string", "description": "Account name/email/id from list_email_accounts, e.g. Gmail or user@example.com"},
                },
                "required": ["action"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "delete_email",
            "description": "Delete one email by UID. For multiple messages, use bulk_email instead. Always pass account when the email came from a named account such as Gmail.",
            "parameters": {
                "type": "object",
                "properties": {
                    "uid": {"type": "string", "description": "Email UID from list_emails/read_email"},
                    "folder": {"type": "string", "description": "IMAP folder (default: INBOX)"},
                    "permanent": {"type": "boolean", "description": "Hard-delete instead of moving to Trash"},
                    "account": {"type": "string", "description": "Account name/email/id from list_email_accounts"},
                },
                "required": ["uid"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "archive_email",
            "description": "Archive one email by UID. For multiple messages, use bulk_email instead. Always pass account when the email came from a named account such as Gmail.",
            "parameters": {
                "type": "object",
                "properties": {
                    "uid": {"type": "string", "description": "Email UID from list_emails/read_email"},
                    "folder": {"type": "string", "description": "IMAP folder (default: INBOX)"},
                    "account": {"type": "string", "description": "Account name/email/id from list_email_accounts"},
                },
                "required": ["uid"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "mark_email_read",
            "description": "Mark one email as read or unread by UID. For multiple messages, use bulk_email instead. Always pass account when the email came from a named account such as Gmail.",
            "parameters": {
                "type": "object",
                "properties": {
                    "uid": {"type": "string", "description": "Email UID from list_emails/read_email"},
                    "folder": {"type": "string", "description": "IMAP folder (default: INBOX)"},
                    "read": {"type": "boolean", "description": "True marks read; false marks unread"},
                    "account": {"type": "string", "description": "Account name/email/id from list_email_accounts"},
                },
                "required": ["uid"]
            }
        }
    },
    # --- Big Brother game engine (Vault-free; only available meaningfully when a game is running) ---
    {
        "type": "function",
        "function": {
            "name": "getGameState",
            "description": "Get the current Big Brother game state (week, phase, the player's card, and the house roster by name). Vault-free: no stats, souls, or hidden attributes.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "runCompetition",
            "description": "PREVIEW the current competition beat's ALREADY-DECIDED winner: the engine has picked from its own hidden stats, and advanceGame crowns the SAME winner when the beat resolves — this tool resolves nothing and is never a second decider. You do not supply or see stats/scores, only the winner's name. Use it to dress the comp scene, then resolve via advanceGame.",
            "parameters": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["endurance", "physical", "puzzle", "quiz", "memory", "mental", "social"], "description": "Competition type (default endurance)."},
                    "participantIds": {"type": "array", "items": {"type": "string"}, "description": "Optional subset of houseguest ids; defaults to the whole house."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "recordInteraction",
            "description": "Record a scene the PLAYER is present for as a game event (becomes the player's knowledge). Use after a meaningful in-character exchange so the engine remembers it. Set `kind` for the simple case — one coarse direction for the whole scene. Use `consequence.edges` when one scene affects specific houseguests DIFFERENTLY (e.g. it warms one and threatens another), or `consequence.aboutEdges` for a THIRD-PARTY pitch — 'I told Lorenzo that Maeve is the real threat' floats holder=Lorenzo's opinion of about=Maeve, honored only if holder actually witnessed the scene. You propose the shape per houseguest; the engine still owns the magnitude and whether a pitch lands, softens, or backfires (you never see the numbers).",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "description": "A concise description of what happened in the scene."},
                    "withIds": {"type": "array", "items": {"type": "string"}, "description": "Optional ids of houseguests present besides the player."},
                    "kind": {
                        "type": "string",
                        "enum": ["bonding", "betrayal", "conflict", "strategy", "alliance", "gossip", "showmance"],
                        "description": "The nature of the interaction. Set this when the scene should move a relationship — the engine folds the hidden trust/affinity/threat impact (you propose the kind, the engine owns the magnitude). This is the floor/default.",
                    },
                    "consequence": {
                        "type": "object",
                        "description": "Optional richer consequence shape for when a single scene moves specific houseguests in DIFFERENT directions. You propose which houseguests' feelings move, which way, and the RELATIVE emphasis; the engine owns the magnitude.",
                        "properties": {
                            "edges": {
                                "type": "array",
                                "description": "Per-houseguest directed shifts this scene should cause.",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "toward": {"type": "string", "description": "The houseguest id whose feelings move (same id space as withIds, e.g. 'npc:3')."},
                                        "direction": {
                                            "type": "string",
                                            "enum": ["warmer", "cooler", "more-trust", "less-trust", "more-threatened", "less-threatened", "more-aligned", "less-aligned"],
                                            "description": "Which way that houseguest's feeling moves.",
                                        },
                                        "emphasis": {
                                            "type": "string",
                                            "enum": ["slight", "notable", "strong"],
                                            "description": "Optional RELATIVE weight only — never an absolute amount; the engine sets the magnitude.",
                                        },
                                    },
                                    "required": ["toward", "direction"],
                                },
                            },
                            "aboutEdges": {
                                "type": "array",
                                "description": "THIRD-PARTY pitches: a houseguest's opinion of a DIFFERENT houseguest moves (never the initiator's own standing — use `edges` for that). Only honored when `holder` actually witnessed this scene.",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "holder": {"type": "string", "description": "The houseguest you were actually talking to (must be present in this scene)."},
                                        "about": {"type": "string", "description": "The THIRD houseguest whose standing with holder is being pitched — must differ from holder and from the player."},
                                        "direction": {
                                            "type": "string",
                                            "enum": ["warmer", "cooler", "more-trust", "less-trust", "more-threatened", "less-threatened", "more-aligned", "less-aligned"],
                                            "description": "Which way holder's feeling about about moves.",
                                        },
                                        "emphasis": {
                                            "type": "string",
                                            "enum": ["slight", "notable", "strong"],
                                            "description": "Optional RELATIVE weight only — never an absolute amount; the engine sets the magnitude and may make the pitch fail or backfire.",
                                        },
                                    },
                                    "required": ["holder", "about", "direction"],
                                },
                            },
                            "rationale": {"type": "string", "description": "Optional free text — why these shifts, grounded in the scene."},
                        },
                    },
                    "feltMinutes": {
                        "type": "integer",
                        "description": "About how long this scene FELT, in in-game minutes — a quick word ~15–30, a real conversation ~60, a long strategy summit ~120–180. A note only: the in-game clock runs by message count (about 5 minutes each) and never by this. Optional.",
                    },
                    "assurance": {
                        "type": "object",
                        "description": "Optional. Set ONLY when someone made a cheap, explicit promise in the scene: 'you're safe with me' (safe), 'you have my vote' (vote), 'I'm with you' (loyal). `by` is 'player' (default) when the player promised, else the id of the houseguest in the scene who promised the player. Never for hints or friendliness. No numbers: the engine decides whether it is kept.",
                        "properties": {
                            "kind": {"type": "string", "enum": ["safe", "vote", "loyal"]},
                            "by": {"type": "string", "description": "'player', or the houseguest id (in withIds) who made the promise."},
                        },
                        "required": ["kind"],
                    },
                    "heardAboutMe": {
                        "type": "object",
                        "description": "Optional. Set ONLY when a houseguest in the scene TOLD the other houseguests present something about the player: that the player is gunning for them (targeting) or has betrayed someone (betrayal). `by` is the teller's id (in withIds, never the player). The engine decides how far each listener believes it.",
                        "properties": {
                            "nature": {"type": "string", "enum": ["targeting", "betrayal"]},
                            "by": {"type": "string", "description": "The houseguest id (in withIds) who told the others."},
                        },
                        "required": ["nature", "by"],
                    },
                },
                "required": ["content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "surfaceInformationTo",
            "description": "Surface a fact into the PLAYER's knowledge through a named in-game pathway (e.g. 'overheard', 'told-by:npc:2'). Use when the player legitimately learns something in-fiction.",
            "parameters": {
                "type": "object",
                "properties": {
                    "information": {"type": "string", "description": "The fact the player learns."},
                    "pathway": {"type": "string", "description": "How they learned it, e.g. 'overheard' or 'told-by:npc:3'."},
                },
                "required": ["information", "pathway"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "getVisibleStateFor",
            "description": "Get the PLAYER's own visible projection: the moments they've witnessed and the things they know for certain. Vault-free — never includes hidden/off-screen content. Use to ground what the player actually knows before narrating.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gameStatus",
            "description": "Get the public ceremony status (week, phase, current HOH, nominees, veto holder/used). Vault-free, ceremony-level facts only — use to ground narration in the live game state.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "socialRead",
            "description": "Get an honest, Vault-free read of the room — or one houseguest — as the player could plausibly perceive it. May HINT at tension; never reveals off-screen events or hidden stats. Use to gauge the social temperature before narrating.",
            "parameters": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "description": "Optional houseguest id to read; omit to read the whole room."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "askProducers",
            "description": "Player-level (out-of-character) interrogation of the producers. Answers come from the player's visible knowledge only and NEVER confirm or deny hidden/Vault content. Use for the Diary Room and direct strategy questions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {"type": "string", "description": "The player's question."},
                },
                "required": ["question"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "renderScene",
            "description": "Ask the engine to narrate the current moment from the VISIBLE projection only. Use 'dialogue' for in-character NPC speech, otherwise scene narration. Vault-free grounding for what to say next.",
            "parameters": {
                "type": "object",
                "properties": {
                    "mode": {"type": "string", "enum": ["scene", "dialogue"], "description": "Narration mode (default scene)."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "endOfSessionSummary",
            "description": "Wrap up the play session: confirms only that an updated save exists for the player (no Vault content). Use when the player stops for now.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "advanceGame",
            "description": "Advance the Big Brother game by one beat: HOH competition → nominations → veto competition → veto ceremony → eviction → finale. NPC beats resolve automatically (the engine decides). When it's the PLAYER's turn, the result's `pending` describes the decision they must make. Call this to move the week forward, then narrate the returned beat. Returns the beat event, any pending decision (with named options), and the public status.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "submitDecision",
            "description": "Resolve the player's pending game decision and continue — ONLY for the competition approach (comp-intent / comp-round) and the in-chat deal-offer answer, using the `kind` from the pending decision. Every other binding choice (nominations, vetoes, votes, goodbye messages, finale picks, self-evict…) is committed ONLY by the player's own confirm on its decision card: present it and WAIT; submitting it here is refused. The engine validates legality server-side.",
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        # ONE source of truth with the REST/WS relays (orwell_engine.DECISION_KINDS);
                        # the hand-copied enum drifted (exit-interview / deal-offer / secret-veto missing).
                        "enum": sorted(_DECISION_KINDS - {"ceremony-step"}),  # a watch step is answered by advanceGame; the engine always refuses it here, so never offer it to the model (ORW-281 4a)
                        "description": "Only comp-intent / comp-round (send `intent`) and deal-offer (send `vote`: accept | decline) "
                                       "are submittable here. deal-offer answers a houseguest's STANDING offer in the "
                                       "chat — it is not a pending decision card. Every other kind is committed ONLY by "
                                       "the player's own confirm on its decision card and is refused by this tool.",
                    },
                    "confirmed": {"type": "boolean", "description": "Not usable here: self-evict binds ONLY on the player's own confirm on its card (this tool refuses it)."},
                    "choice": {"type": "array", "items": {"type": "string"}, "description": "Card-only kinds (nominations, houseguests-choice, tie-break, final-eviction): committed on the player's card; refused here."},
                    "use": {"type": "boolean", "description": "Card-only kinds (veto-decision, secret-veto): committed on the player's card; refused here."},
                    "save": {"type": "string", "description": "Card-only (veto-decision): committed on the player's card; refused here."},
                    "replacement": {"type": "string", "description": "Card-only (replacement): committed on the player's card; refused here."},
                    "vote": {"type": "string", "description": "deal-offer: accept | decline. Every other vote kind (eviction-vote, juror-vote, goodbye-message, exit-interview…) is card-only and refused here."},
                    "statement": {"type": "string", "description": "Card-only (finale-statement, juror-question, goodbye-message text): committed on the player's card; refused here."},
                    "appeal": {"type": "string", "enum": ["own-game", "mend", "connect", "discredit-rival"], "description": "Card-only (finale-answer): committed on the player's card; refused here."},
                    "intent": {"type": "string", "enum": ["compete", "throw", "play-safe"], "description": "comp-intent / comp-round: the player's declared approach for the competition, asked ONCE up front (round 1) — committed before the competition resolves and locked. The elimination rounds then play out as drama; the player is NOT re-asked each round (the up-front approach is the binding one)."},
                },
                "required": ["kind"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "requestSelfEviction",
            "description": "Raise a SELF-EVICTION confirmation (0061). Call this ONLY when the player clearly, out of character, says they want to LEAVE / quit / walk out of the GAME (not in-fiction venting). It changes NOTHING and the house never hears it — it surfaces a confirm/cancel card naming the irreversible stakes (this ends and forfeits their season). NEVER call submitDecision with a confirmed self-evict off the player's line; only their own explicit confirmation binds it.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "socialInitiatives",
            "description": "Which houseguests want to approach the player RIGHT NOW (name + a public pretext only). Call at quiet moments so scenes start from EITHER side — allies scheme, rivals probe — not only when the player reaches out.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "seasonRecap",
            "description": "The season's public arc straight from the recorded events (0048): HOH reigns, ceremonies, evictions, deals. Use for any recap or reunion beat — it is the record, never memory.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playerReceipts",
            "description": "The Diary-Room screening room (#1800): candidate contradictions drawn ONLY from the player's OWN record — deals they made, votes they cast, Diary-Room and public statements. Their words, never engine truth or hidden state; deterministic, never invented. Use it when the player is about to contradict themselves and the producer holds up the mirror.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "playerDossier",
            "description": "The player's own Diary-Room reads, grouped per houseguest (#1793). Returns ONLY what the PLAYER said in the diary room — their words, never engine truth or hidden state. Optionally pass subjectId to focus one houseguest. Use it to recall the player's own past reads.",
            "parameters": {
                "type": "object",
                "properties": {
                    "subjectId": {"type": "string", "description": "Optional houseguest id (e.g. npc:3) to narrow to one houseguest."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "dailyRecap",
            "description": "The most recently CLOSED in-game day's 'day in review' digest (0102): witnessed highlights + gossip already surfaced, plus an optional non-committal forward tease. Usually delivered inline on turnIn's result — call this only to re-fetch the same day's digest. Vault-free, reproducible; returns nothing before any day has closed.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "turnIn",
            "description": "The player's bedtime lever (ADR 0006): the player CHOOSES to turn in for the night. Call it whenever the player says they are heading to bed / turning in / calling it a night — the player is NEVER auto-slept, so only this ends their night for real. It ends their night where it stands (an early night ⇒ rested for tomorrow's comp; outlasting the house into late-night ⇒ running on empty — a hidden, bounded rest effect the ENGINE folds, never a number) and rolls the house to the next morning. The result may carry a Vault-free dailyRecap (0102) — the day that just closed, plus an optional non-committal forward tease: voice it as a short in-fiction 'day in review' beat when present, and invent nothing when absent. Never narrate the player waking to a new morning without calling this. A no-op when the in-game clock isn't running.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "worldSnapshotView",
            "description": "The move-in zeitgeist snapshot (0062): public flavor from the real world on the approximate move-in date — what's trending in screen/music/sports/news/internet, plus a mood. Vault-free flavor only, never a game input. Returns {screen: [str], music: [str], sports: [str], news: [str], internet: [str], mood: str, offscreenPrompt: str} or {}. Call to enrich the off-screen texture when writing social-scene prose so the zeitgeist flavor colors the narration.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "seasonRetrospective",
            "description": "POST-SEASON ONLY (0048): opens the Producer's Vault for the FINISHED season — off-screen scheming, confessionals, the twist that never fired. Returns nothing while a season is live; after the winner it is the payoff.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "npcVoice",
            "description": "BEFORE voicing a houseguest in a scene (B65): their bounded person — persona, room + who is with them, what THEY actually know and suspect, and their organic stances. Speak them ONLY from this; they cannot reference what they never witnessed or were told.",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "The houseguest id to voice (e.g. npc:3)."},
                },
                "required": ["id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "whereabouts",
            "description": "Where the player stands in the house (0049): their room, who is in it, and who is in each room within SIGHTLINE (eyeshot — the open great room/yard or a hallway mouth; 0077 Phase 2) — names only. Call when the player lingers, mills around, or asks who's nearby; presence is engine ground truth, never invented.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "moveTo",
            "description": "Move the PLAYER to a room they named (L21/L24): the player is a person and chooses where to go; the engine never relocates them on its own. Call whenever the player heads somewhere (\"I go to the kitchen\"), then voice the new room from what it returns. Until you call this, they are still in their current whereabouts room.",
            "parameters": {
                "type": "object",
                "properties": {
                    "room": {"type": "string", "description": "The room the player walks to (e.g. kitchen, living-room, backyard, bedroom, storage-room, hoh-room)."},
                },
                "required": ["room"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "premiereIntros",
            "description": "PREMIERE ONLY (#380): the meet-everyone progress — who the player has met and who is STILL to introduce (the stragglers are met in motion), each with their OBSERVABLE public persona (archetype/strategy/background/age/presentation/demeanor — never the soul, a number, or how the player feels). This is a READ, never a checklist — with the entrances OFF the champagne circle already met the whole house (0111); with the staged entrances ON, `complete` is false and `remaining` lists anonymous placeholders only until the last arrival. NEVER run a meet-everyone roll-call from it; use it to pick who deserves a DEEPER scene. First power is REACHABLE once a couple of hot reads form and nobody is invisible, WITHOUT every formal introduction first; returns null outside the premiere.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "markHouseguestMet",
            "description": "PREMIERE ONLY (#380): mark a houseguest as INTRODUCED/met the instant they have introduced their public self. Idempotent; the engine tracks who's met. First power becomes REACHABLE once a couple of genuine hot reads form and nobody is left invisible (0111) — you do NOT need every one of the 15 formally introduced first; the stragglers get met in motion. Returns the updated meet-everyone progress (null outside the premiere).",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "The houseguest id just introduced (from the roster)."},
                },
                "required": ["id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "diaryRoom",
            "description": "Record the player's private, out-of-character Diary Room confessional. Nothing here ever reaches any houseguest — it is the player's own space, never an in-game pathway. Use whenever the player speaks in the Diary Room.",
            "parameters": {
                "type": "object",
                "properties": {
                    "entry": {"type": "string", "description": "The player's confessional, verbatim or lightly condensed."},
                },
                "required": ["entry"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "makeDeal",
            "description": "Propose a deal to a houseguest. The ENGINE decides whether THEY agree (from their own trust, wariness and memory of the player) - never assume yes. It returns the recorded deal, or a refusal {refused, reason, narratable}: then NO deal exists, so voice the houseguest declining in character and do not narrate a handshake. An agreed deal is a first-class promise adjudicated against later binding actions: keeping it builds trust, breaking it deals a betrayal blow the house and jury remember. Features 0093/0099 — for a STANDING deal sweetened by a secret, add 'leverage' (a secret about the PARTNER, pressed as pressure) or 'tradedSecret' (a secret about a third party, handed over as a chip). Both are optional; the ENGINE owns whether the pressure lands or the recipient bites.",
            "parameters": {
                "type": "object",
                "properties": {
                    "with": {"type": "string", "description": "The houseguest id the deal is made with (from the roster)."},
                    "kind": {"type": "string", "enum": ["safety", "vote", "final-two", "target-other"], "description": "The deal's nature."},
                    "terms": {"type": "string", "description": "The terms as spoken in the scene, briefly."},
                    "term": {
                        "type": "object",
                        "description": "Feature 0109 — OPTIONAL negotiated term, only when the scene actually named one. {weeks} = how many weeks the promise runs counting THIS week ('this week only' = 1, 'for two weeks' = 2); {vague: true} = the term was deliberately left unspoken. The ENGINE bounds it and decides how hard a later break hurts. Omit for an ordinary deal.",
                        "properties": {
                            "weeks": {"type": "integer", "description": "Weeks the promise runs, counting the current week (>= 1)."},
                            "vague": {"type": "boolean", "description": "True when the parties left the term unspoken."},
                        },
                    },
                    "leverage": {
                        "type": "object",
                        "description": "Feature 0093 — OPTIONAL: a secret the player holds ABOUT the deal partner ('with'), pressed to make them more likely to enter/honor the deal ('keep me safe or this gets out'). Provide factId (a secret the player has actually LEARNED about the partner), or {bluff: true, subject} to press a secret the player does NOT actually hold. Omit entirely for an ordinary deal — the ENGINE decides whether the pressure lands, and a wary partner can refuse and resent it.",
                        "properties": {
                            "factId": {"type": "string", "description": "The id of a secret the player has actually LEARNED about the deal partner. Omit only for a bluff."},
                            "bluff": {"type": "boolean", "description": "Set true to press a secret the player does NOT hold (a gamble); then 'subject' is required."},
                            "subject": {"type": "string", "description": "For a bluff: the houseguest id the invented secret is about (usually the deal partner)."},
                        },
                    },
                    "tradedSecret": {
                        "type": "object",
                        "description": "Feature 0099 — OPTIONAL: a secret the player holds about a THIRD party, handed to the deal partner ('with') as consideration sweetening the deal. Provide factId (a secret the player has actually LEARNED about a third party), or {bluff: true, subject} to offer a secret the player does NOT hold. Omit entirely for an ordinary deal — valued to the PARTNER, and the partner learns it via a recorded pathway.",
                        "properties": {
                            "factId": {"type": "string", "description": "The id of a secret the player has actually LEARNED about a THIRD party. Omit only for a bluff."},
                            "bluff": {"type": "boolean", "description": "Set true to offer a secret the player does NOT hold; then 'subject' is required."},
                            "subject": {"type": "string", "description": "For a bluff: the houseguest id the invented secret is about."},
                        },
                    },
                },
                "required": ["with", "kind", "terms"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "askJuror",
            "description": "Feature 0129 — ONLY while the player sits on the JURY: when they ask a fellow juror what they know, call askJuror({jurorId}). The ENGINE decides whether that juror tells and WHICH one thing (only something they legitimately witnessed or were told). Returns {told, bearing, content}: voice the content as that juror; if told is false, play the deflection. Never invent what a juror knows; never state the bearing as a verdict or number.",
            "parameters": {
                "type": "object",
                "properties": {
                    "jurorId": {"type": "string", "description": "The fellow juror's houseguest id (from the jury-house roster)."},
                },
                "required": ["jurorId"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "confide",
            "description": "Feature 0075 — when the player presses an ALLY they're already in a 1:1 scene with to open up ('what's really going on with you?', 'you can tell me'), call confide({npcId}). The ENGINE decides whether they actually open up, how much of their secret they share, and whether it's the truth or a lie — never invent a confession. Returns {disclosed, tier, content}: voice the returned content as that houseguest confiding; if disclosed is false, play the deflection (they're not ready / change the subject). Never state a tier or whether it's true — judging that is the player's alone.",
            "parameters": {
                "type": "object",
                "properties": {
                    "npcId": {"type": "string", "description": "The houseguest id the player is pressing to open up (from the roster)."},
                },
                "required": ["npcId"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "formAlliance",
            "description": "Feature 0107 — the MOMENT the player and a group NAME an alliance in the scene (\"let's call ourselves…\", \"you, me and them, locked in\"), call formAlliance({name, members}) so the alliance is REAL and the engine tracks it. The engine is bond-gated: members not close enough decline, and it returns who actually joined — voice the result, never assert everyone's in.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "The alliance's name as spoken in the scene."},
                    "members": {"type": "array", "items": {"type": "string"}, "description": "The houseguest ids the player names into the alliance (from the roster)."},
                },
                "required": ["name", "members"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "joinAlliance",
            "description": "Feature 0107 — when an NPC has PITCHED the player into a named alliance and the player accepts in the scene, call joinAlliance({allianceId}) so they're enrolled. Only a live pitch the player is close enough to the founder for takes; a cold 'add me' is refused — voice the refusal. Pitches and their allianceId surface on gameStatus.alliancePitches.",
            "parameters": {
                "type": "object",
                "properties": {
                    "allianceId": {"type": "string", "description": "The id of the alliance the player was pitched (from gameStatus.alliancePitches)."},
                },
                "required": ["allianceId"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "exposeSecret",
            "description": "Feature 0093 — when the player OUTS a secret they LEARNED about a houseguest to the house ('they deserve to know what you're hiding'), call exposeSecret({factId}) with the learned fact's id. The ENGINE decides the standing fold + backlash and whether it lands — voice the result, never assert the fallout. To BLUFF (out a secret the player does NOT actually hold), pass {bluff: true, subject} with the target houseguest id instead.",
            "parameters": {
                "type": "object",
                "properties": {
                    "factId": {"type": "string", "description": "The id of a secret the player has actually LEARNED (from their known facts). Omit only for a bluff."},
                    "bluff": {"type": "boolean", "description": "Set true to out a secret the player does NOT hold (a gamble); then 'subject' is required."},
                    "subject": {"type": "string", "description": "For a bluff: the houseguest id the invented secret is about."},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "confront",
            "description": "Feature 0094 — when the player CONFRONTS a houseguest over something they LEARNED (a scheme, a betrayal-in-progress) that involves that houseguest, call confront({npcId, factId}) with the learned fact's id. The ENGINE decides whether the outcome matches the player's belief or diverges from it — you never invent the outcome. On {landed: true} play the confrontation as the player expects; on {landed: false} it misfired — play the confronted houseguest's genuine, hurt/defensive reaction (NEVER say the player's information was wrong or state any reason). No number, no tell either way.",
            "parameters": {
                "type": "object",
                "properties": {
                    "npcId": {"type": "string", "description": "The confronted houseguest's id (from the roster)."},
                    "factId": {"type": "string", "description": "The id of the learned fact the player is confronting them over (from their known facts)."},
                },
                "required": ["npcId", "factId"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "accuseTie",
            "description": "Feature 0095 — when the player presses a suspicion that two houseguests knew each other BEFORE the show ('you two knew each other before this, didn't you?'), call accuseTie({aId, bId}). The ENGINE checks whether a real pre-show connection exists — you never invent or confirm one yourself. On {landed: true} voice the pair's reaction and the house's shift (never state WHY it's true, never a number); on {landed: false} it's an ordinary wrong guess — a normal social beat with NO tell distinguishing a miss from a hit beyond the fiction. Rare — most pairs have no such tie.",
            "parameters": {
                "type": "object",
                "properties": {
                    "aId": {"type": "string", "description": "The first accused houseguest's id (from the roster)."},
                    "bId": {"type": "string", "description": "The second accused houseguest's id (from the roster)."},
                },
                "required": ["aId", "bId"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "tradeSecret",
            "description": "Feature 0099 — when the player TRADES a secret they LEARNED about a THIRD party to a houseguest for a one-off favor (a comp throw, a name for a name), call tradeSecret({factId, toNpcId}). The ENGINE decides whether the recipient takes it and what the favor is — voice the result, never assert acceptance. To BLUFF (offer a secret the player does NOT hold), pass {bluff: true, subject, toNpcId}.",
            "parameters": {
                "type": "object",
                "properties": {
                    "toNpcId": {"type": "string", "description": "The recipient houseguest id the secret is traded to (from the roster)."},
                    "factId": {"type": "string", "description": "The id of a secret the player has actually LEARNED about a THIRD party. Omit only for a bluff."},
                    "bluff": {"type": "boolean", "description": "Set true to offer a secret the player does NOT hold; then 'subject' is required."},
                    "subject": {"type": "string", "description": "For a bluff: the houseguest id the invented secret is about."},
                    "askKind": {"type": "string", "description": "A short label for what the player asked for in return, as spoken in the scene (e.g. 'safety this week', 'a comp throw'). Never an outcome lever — the engine still decides whether the recipient bites."},
                },
                "required": ["toNpcId"],
            },
        },
    },
    # --- God Mode / admin (0016) — ADMIN-ONLY; still Vault-free (walled even for admin) ---
    {
        "type": "function",
        "function": {
            "name": "inspectNonVaultState",
            "description": "GOD MODE (admin only): inspect the non-Vault game state of the current sandbox. Never returns Vault/secret content — the hidden layer stays walled even from the admin (spoilers ruin the game).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sandboxHealth",
            "description": "GOD MODE (admin only): Vault-free health of the current sandbox (B58) — week/phase, last advance time, integrity status, recent faults, and circuit-breaker state. Metadata only; never returns game content or Vault data.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "overrideMechanic",
            "description": "GOD MODE (admin only): override a non-Vault game mechanic in the sandbox. Returns the updated non-Vault state.",
            "parameters": {
                "type": "object",
                "properties": {
                    "mechanic": {"type": "string", "description": "The mechanic to override."},
                    "value": {"description": "The new value (any JSON type)."},
                },
                "required": ["mechanic", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "configureGame",
            "description": "GOD MODE (admin only): set non-Vault tunables for the sandbox — temperature/relationship config and the reserve-twist COUNT. Never sets twist CONTENT (Vault-sealed).",
            "parameters": {
                "type": "object",
                "properties": {
                    "settings": {"type": "object", "description": "Key/value tunables to apply (non-Vault only)."},
                },
                "required": ["settings"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "manageSandbox",
            "description": "GOD MODE (admin only): sandbox lifecycle for THIS user's game only — create, reset, save, or load.",
            "parameters": {
                "type": "object",
                "properties": {
                    "op": {"type": "string", "enum": ["create", "reset", "save", "load"], "description": "The lifecycle operation."},
                },
                "required": ["op"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "createCharacter",
            "description": (
                "Finalize the casting interview and start the Big Brother season (0050). Call this "
                "ONCE, when the casting status shows ready and the interview has given you the "
                "picture: the engine starts from EVERYTHING updateCasting recorded (arguments here "
                "fill last gaps or override). It derives balanced hidden stats from the canonical "
                "archetype and returns the Vault-free game state with the player's casting card "
                "(character type, strategy, qualitative strengths) — reveal the card in the "
                "producer's voice, never any number. A recorded name is required (the engine "
                "rejects creation without one). This is ALSO the restart door: to start a NEW season "
                "after one has ENDED (a winner crowned) or that the player wants to abandon, call it "
                "again with confirmRestart=true and the new player's details — that flag is REQUIRED "
                "to play again; without it the call is REFUSED with a reason (createRefused) on any started season."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "playerName": {"type": "string", "description": "The houseguest's display name."},
                    "archetype": {
                        "type": "string",
                        # Keep in sync with the engine's canonical casting sheet
                        # (ARCHETYPES in src/engine/characterFactory.ts) — drift-tested.
                        "enum": [
                            "comp-beast", "mastermind", "social-butterfly", "floater",
                            "villain", "underdog", "flirt", "loyalist", "wildcard",
                            "analyst", "hothead", "peacemaker",
                        ],
                        "description": "Your canonical mapping of the player onto the casting sheet (drives balanced hidden stats).",
                    },
                    "strategyStyle": {
                        "type": "string",
                        "enum": ["aggressive", "social", "strategic", "under-the-radar", "emotional", "loyal"],
                        "description": "Your canonical mapping of how they plan to play.",
                    },
                    "personaArchetype": {"type": "string", "description": "The player's OWN words for who they are / how they'll come across."},
                    "personaStrategyStyle": {"type": "string", "description": "The player's OWN words for how they'll play."},
                    "backstory": {"type": "string", "description": "Their life outside the house, as they told it."},
                    "motivation": {"type": "string", "description": "Why they came to play (player-only; no houseguest ever learns it)."},
                    "privateStrategy": {"type": "string", "description": "How they ACTUALLY plan to play (private — stays between the player and production)."},
                    "interviewNotes": {
                        "type": "array", "items": {"type": "string"},
                        "description": "3-8 short notes of the best get-to-know material from the interview.",
                    },
                    "genderPresentation": {
                        "type": "string",
                        "enum": ["man", "woman", "nonbinary"],
                        "description": (
                            "OPTIONAL — the player's own pronouns/presentation, if they mentioned it "
                            "(never required, never inferred from their name)."
                        ),
                    },
                    "seed": {"type": "integer", "description": "Optional RNG seed for reproducibility."},
                    "confirmRestart": {
                        "type": "boolean",
                        "description": (
                            "Set true ONLY to start the NEXT season once the current one has ENDED (a "
                            "winner was crowned — the post-season reunion) and the player asks to run it "
                            "back in chat. This ends the finished season and starts a fresh one; the front "
                            "end advances their season counter. Omit it during a normal first-time casting "
                            "(it no-ops/refuses on a started game). Never use it to reset a LIVE season — "
                            "a mid-season restart is a settings 'red zone' action, never a chat one."
                        ),
                    },
                    "keepCharacter": {
                        "type": "boolean",
                        "description": (
                            "With confirmRestart, carry the SAME houseguest (their name + authored "
                            "character) into the next season instead of casting a new one (0056). Use it "
                            "when the player wants to keep playing as who they are; omit to recreate fresh."
                        ),
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "updateCasting",
            "description": (
                "Record casting-interview answers AS THEY LAND (0050) — any subset of fields, any "
                "number of times pre-game; interviewNotes accumulate. Returns the engine's casting "
                "status: what's on file (known), what's missing, the engine-picked next step, and "
                "whether casting is ready to finalize (a name is on file). Follow the status, not "
                "your own memory — a resumed interview must never re-ask what's already captured. "
                "After the season starts this records nothing and reports done."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "playerName": {"type": "string", "description": "Their name — the one REQUIRED field before the season can start."},
                    "backstory": {"type": "string", "description": "Their life outside the house, as they told it."},
                    "motivation": {"type": "string", "description": "Why they came to play (player-only; no houseguest ever learns it)."},
                    "personaArchetype": {"type": "string", "description": "The player's OWN words for who they are / how they'll come across."},
                    "personaStrategyStyle": {"type": "string", "description": "The player's OWN words for how they'll play."},
                    "privateStrategy": {"type": "string", "description": "How they ACTUALLY plan to play (private — stays with production)."},
                    "interviewNotes": {
                        "type": "array", "items": {"type": "string"},
                        "description": "Short get-to-know notes worth remembering — appended, never replaced.",
                    },
                    "archetype": {
                        "type": "string",
                        # Keep in sync with the engine's canonical casting sheet
                        # (ARCHETYPES in src/engine/characterFactory.ts) — drift-tested.
                        "enum": [
                            "comp-beast", "mastermind", "social-butterfly", "floater",
                            "villain", "underdog", "flirt", "loyalist", "wildcard",
                            "analyst", "hothead", "peacemaker",
                        ],
                        "description": "Your canonical mapping of the player onto the casting sheet (drives balanced hidden stats).",
                    },
                    "strategyStyle": {
                        "type": "string",
                        "enum": ["aggressive", "social", "strategic", "under-the-radar", "emotional", "loyal"],
                        "description": "Your canonical mapping of how they plan to play.",
                    },
                    "genderPresentation": {
                        "type": "string",
                        "enum": ["man", "woman", "nonbinary"],
                        "description": (
                            "OPTIONAL — if they mention their pronouns or how they present, map it to the "
                            "closest of these three (never required, never re-asked if they'd rather skip it). "
                            "Never inferred from their name — only record this from what they actually said."
                        ),
                    },
                },
                "required": [],
            },
        },
    },
]


# ---------------------------------------------------------------------------
# W1/W5 (2026-06-10 audit): the game-only ui_control schema.
# Under the game build the native function-calling manifest must advertise the
# same curated safe subset do_ui_control enforces — no open_panel into dropped
# verticals, no mode/model/toggle levers. Pure transform + applied at import
# (the game build is a process-stable env switch, like the rest of the build).
# ---------------------------------------------------------------------------

def game_ui_control_schema(schema: dict) -> dict:
    """Return the game-build variant of the ui_control function schema: camera
    direction (highlight/clear_highlight) + house theming (set_theme/create_theme)
    only. Pure — does not mutate its input."""
    from src.settings import GAME_UI_CONTROL_SAFE_ACTIONS

    import copy
    out = copy.deepcopy(schema)
    fn = out["function"]
    fn["description"] = (
        "Camera direction: visually direct the player's screen. Actions: highlight "
        "(call out an on-screen element by CSS selector, optional label), clear_highlight, "
        "set_theme (apply a preset theme), create_theme (CREATE a custom theme with a name "
        "+ colors object — pick distinctive, evocative hex colors that match the requested "
        "aesthetic, NOT generic defaults. The theme auto-applies after creation). When the "
        "player asks for ANY theme not in the preset list, ALWAYS use create_theme. "
        "No other UI control exists."
    )
    props = fn["parameters"]["properties"]
    props["action"] = {
        "type": "string",
        # Stable order for the manifest; membership == the enforced safe subset.
        "enum": [a for a in ("highlight", "clear_highlight", "set_theme", "create_theme")
                 if a in GAME_UI_CONTROL_SAFE_ACTIONS],
        "description": "The UI action. Use set_theme for presets, create_theme for custom colors",
    }
    props["name"] = {
        "type": "string",
        "description": "For highlight: the CSS selector to call out. For set_theme: a preset "
                       "theme name. For create_theme: the custom theme name.",
    }
    props["value"] = {
        "type": "string",
        "description": "For highlight: an optional short label shown beside the highlight. "
                       "For set_theme: the theme name (alias of name).",
    }
    # Email-reply plumbing has no game-build meaning.
    for dead in ("uid", "folder", "mode"):
        props.pop(dead, None)
    return out


def _apply_game_build_schemas() -> None:
    from src.settings import game_build_enabled

    if not game_build_enabled():
        return
    for i, schema in enumerate(FUNCTION_TOOL_SCHEMAS):
        if isinstance(schema, dict) and schema.get("function", {}).get("name") == "ui_control":
            FUNCTION_TOOL_SCHEMAS[i] = game_ui_control_schema(schema)
            break


_apply_game_build_schemas()


# 0121 R2 — deal kinds. The four DEFENSIVE kinds are always extractable; the two ACTIVE-obligation kinds
# (0121) are added ONLY when the engine's deal-depth layer is on. The base `makeDeal` schema (above) keeps
# just the defensive four so the import-frozen manifest is unchanged (the 0108 golden fixture that also rode this was decommissioned 2026-07-21);
# `with_deal_depth_kinds` swaps in the extended enum at SEND time when the flag is on (a deep copy, never
# mutating the shared base). Off (the default) ⇒ the same list ⇒ byte-identical.
BASE_DEAL_KINDS = ["safety", "vote", "final-two", "target-other"]
ACTIVE_DEAL_KINDS = ["comp-throw", "veto-save"]
_ACTIVE_DEAL_KIND_DESC = "comp-throw = throw a competition for them; veto-save = use the veto to save them"


def current_deal_kinds() -> list:
    """The deal kinds the player may currently strike — the defensive four, plus the two active-obligation
    kinds when the engine's deal-depth layer is on (0121 R2). Read off the cached /health flag."""
    from src.orwell_engine import engine_flag
    return BASE_DEAL_KINDS + (ACTIVE_DEAL_KINDS if engine_flag("dealDepth") else [])


def with_deal_depth_kinds(schemas: list) -> list:
    """Send-time flag-gate (0121 R2): when the engine's deal-depth layer is ON, return a copy of `schemas`
    with makeDeal's `kind` enum extended by the two active-obligation kinds. OFF (default) ⇒ the SAME list
    object, so every flag-off request is byte-identical."""
    from src.orwell_engine import engine_flag
    if not engine_flag("dealDepth"):
        return schemas
    import copy
    out = []
    for s in schemas:
        if isinstance(s, dict) and s.get("function", {}).get("name") == "makeDeal":
            s = copy.deepcopy(s)
            props = s.get("function", {}).get("parameters", {}).get("properties", {})
            kind = props.get("kind")
            if isinstance(kind, dict) and isinstance(kind.get("enum"), list):
                kind["enum"] = BASE_DEAL_KINDS + ACTIVE_DEAL_KINDS
                kind["description"] = f"The deal's nature. {_ACTIVE_DEAL_KIND_DESC}."
            props["direction"] = {"type": "string", "enum": ["offer", "ask"], "description": "comp-throw / veto-save only: 'offer' (default) = the player promises to do it for them; 'ask' = the player asks THEM to throw / save for the player."}
        out.append(s)
    return out


# The Diary-Room reads are flag-gated engine tools (ORWELL_PLAYER_DOSSIER → `playerDossier`, ORWELL_BOOTH_RECEIPTS →
# `boothReceipts`): with the flag OFF the engine returns an empty result — a DEAD tool — so the model is not sent a
# schema for it. Only an EXPLICIT False (a probed flag) drops the tool: unprobed / unknown / ON keep today's list.
_FLAG_GATED_DIARY_TOOLS = {"playerDossier": "playerDossier", "playerReceipts": "boothReceipts"}


def without_flagged_off_diary_tools(schemas: list) -> list:
    """Send-time flag-gate: drop `playerDossier` / `playerReceipts` when the engine reports their flag OFF. Returns the
    SAME list object when nothing is dropped (flag-on / unprobed ⇒ byte-identical); never mutates the shared base."""
    from src.orwell_engine import _ENGINE_FLAGS
    off = {tool for tool, flag in _FLAG_GATED_DIARY_TOOLS.items() if _ENGINE_FLAGS.get(flag) is False}
    if not off:
        return schemas
    return [s for s in schemas if not (isinstance(s, dict) and s.get("function", {}).get("name") in off)]


# The Big Brother game tools (Vault-free). These are PINNED whenever the engine is
# reachable so RAG/keyword selection can never drop them — the model must always be
# able to call createCharacter (OOBE), getGameState (state check), and the full
# weekly-loop surface (advanceGame/submitDecision). Keep in sync with the engine's
# player-channel registry (src/surfaces/tools/registry.ts).
ORWELL_GAME_TOOLS = frozenset({
    "createCharacter", "updateCasting",
    "getGameState", "gameStatus", "getVisibleStateFor", "runCompetition",
    "recordInteraction", "surfaceInformationTo", "socialRead", "askProducers",
    "renderScene", "endOfSessionSummary", "advanceGame", "submitDecision",
    # 0061: raise the self-eviction confirmation on a clear OOC intent to leave.
    "requestSelfEviction",
    # C13: the prompt-advertised levers that were missing from the FE surface.
    "socialInitiatives", "diaryRoom", "makeDeal",
    # 0075: the trust-gated confide lever (the engine decides the disclosure; the model voices it).
    "confide",
    # 0129 slice 3: the juror-player asks a fellow juror what they know.
    "askJuror",
    # 0107: named alliances (Phase A formAlliance + Phase B joinAlliance).
    "formAlliance", "joinAlliance",
    # 0093/0099: expose a learned secret to the house / trade it to a houseguest for a favor.
    "exposeSecret", "tradeSecret",
    # 0094/0095: confront a houseguest over a learned fact / accuse a pre-show tie (engine-decided).
    "confront", "accuseTie",
    # B64/0049: the Vault-free presence read (who's here, who's one room over).
    "whereabouts",
    # L21/L24: the player directs their own movement (the engine never auto-relocates a person).
    "moveTo",
    # PREMIERE meet-everyone (#380): the premiere-only meet-everyone tracker — the read + the mark.
    "premiereIntros", "markHouseguestMet",
    # B56/0048: the reunion reads — the public recap + the post-season Vault unsealing.
    "seasonRecap", "seasonRetrospective",
    # #1800 / #1793: the player's OWN Diary-Room record — the receipts mirror + the per-houseguest dossier.
    "playerReceipts", "playerDossier",
    # 0102: the daily "day in review" digest re-fetch (usually delivered inline on turnIn).
    "dailyRecap",
    # 0062: the move-in zeitgeist snapshot — public flavor + offscreenPrompt.
    "worldSnapshotView",
    # ADR 0006 (#1385): the player's bedtime lever — ends their night, rolls the house to morning,
    # folds the hidden rest penalty in the ENGINE, and delivers the dailyRecap (0102) inline on its result.
    "turnIn",
    # B65: the knowledge-bounded per-NPC voicing projection.
    "npcVoice",
})


# ---------------------------------------------------------------------------
# Converter: native function call -> ToolBlock
# ---------------------------------------------------------------------------

# Lowercase → registered spelling, for the parsers that lowercase tool names (see below).
_TOOL_TAGS_BY_LOWER = {t.lower(): t for t in TOOL_TAGS}


def function_call_to_tool_block(name: str, arguments: str) -> Optional[ToolBlock]:
    """Convert a native function call into a ToolBlock for the existing execution pipeline."""
    try:
        if not arguments or (isinstance(arguments, str) and not arguments.strip()):
            args = {}
        else:
            args = json.loads(arguments) if isinstance(arguments, str) else arguments
    except (json.JSONDecodeError, TypeError):
        logger.error(f"Failed to parse function call arguments for {name}: {arguments}")
        return None

    # Some models emit valid JSON that isn't an object (e.g. a bare array
    # ["ls -la"], string, or number) as the function arguments. Every branch
    # below assumes a dict and calls args.get(...), so a non-dict would raise
    # AttributeError and abort the whole agent stream. Coerce to {} instead.
    if not isinstance(args, dict):
        logger.warning(f"Non-object function call arguments for {name}: {args!r}; treating as empty")
        args = {}

    tool_type = _TOOL_NAME_MAP.get(name, name)

    # Allow MCP tools through (namespaced as mcp__serverid__toolname)
    if tool_type.startswith("mcp__"):
        content = json.dumps(args) if args else "{}"
        return ToolBlock(tool_type, content)
    # Email tools are implemented as MCP — route them to email
    _BUILTIN_EMAIL_TOOLS = {"list_email_accounts", "send_email", "list_emails", "read_email", "reply_to_email",
                            "archive_email", "delete_email", "mark_email_read", "bulk_email", "download_attachment"}
    if name in _BUILTIN_EMAIL_TOOLS:
        return ToolBlock(f"mcp__email__{name}", json.dumps(args) if args else "{}")
    if tool_type not in TOOL_TAGS:
        # The XML/DSML and <tool_code> parsers LOWERCASE the invoke name (models capitalize
        # `Bash`), which made every camelCase game tool (`seasonRecap`, `advanceGame`, …) miss
        # TOOL_TAGS and vanish silently. Recover the registered spelling case-insensitively.
        tool_type = _TOOL_TAGS_BY_LOWER.get(str(tool_type).lower(), tool_type)
    if tool_type not in TOOL_TAGS:
        logger.warning(f"Unknown function call: {name}")
        return None

    # Convert structured args back to the text format each tool expects
    if tool_type == "bash":
        content = args.get("command", "")
    elif tool_type == "python":
        content = args.get("code", "")
    elif tool_type == "web_search":
        queries = args.get("queries")
        if isinstance(queries, list) and queries:
            content = str(queries[0])
        elif queries:
            content = str(queries)
        else:
            content = args.get("query", "")
        # Preserve the model-requested freshness filter — the web_search schema
        # advertises time_filter and the executor parses {"query","time_filter"},
        # but a bare query string dropped it. Mirrors the read_file JSON idiom.
        tf = args.get("time_filter")
        if content and isinstance(tf, str) and tf in ("day", "week", "month", "year"):
            content = json.dumps({"query": content, "time_filter": tf})
    elif tool_type == "read_file":
        # Plain path (back-compat) unless a line range is requested → JSON.
        if args.get("offset") or args.get("limit"):
            content = json.dumps(args)
        else:
            content = args.get("path", "")
    elif tool_type in ("grep", "glob", "ls"):
        content = json.dumps(args) if args else "{}"
    elif tool_type == "write_file":
        content = args.get("path", "") + "\n" + args.get("content", "")
    elif tool_type == "edit_file":
        content = json.dumps(args)
    elif tool_type == "create_document":
        parts = [args.get("title", "Untitled")]
        if args.get("language"):
            parts.append(args["language"])
        parts.append(args.get("content", ""))
        content = "\n".join(parts)
    elif tool_type == "edit_document":
        blocks = []
        for edit in args.get("edits", []):
            blocks.append(
                f'<<<FIND>>>\n{edit.get("find", "")}\n<<<REPLACE>>>\n{edit.get("replace", "")}\n<<<END>>>'
            )
        content = "\n".join(blocks)
    elif tool_type == "suggest_document":
        blocks = []
        for s in args.get("suggestions", []):
            blocks.append(
                f'<<<FIND>>>\n{s.get("find", "")}\n<<<SUGGEST>>>\n{s.get("replace", "")}\n<<<REASON>>>\n{s.get("reason", "")}\n<<<END>>>'
            )
        content = "\n".join(blocks)
    elif tool_type == "update_document":
        content = args.get("content", "")
    elif tool_type == "search_chats":
        content = args.get("query", "")
    elif tool_type == "chat_with_model":
        content = args.get("model", "") + "\n" + args.get("message", "")
    elif tool_type == "create_session":
        content = args.get("name", "Untitled") + "\n" + args.get("model", "")
    elif tool_type == "list_sessions":
        content = args.get("filter", "")
    elif tool_type == "send_to_session":
        content = args.get("session_id", "") + "\n" + args.get("message", "")
    elif tool_type == "pipeline":
        # Pass as JSON for the pipeline parser
        content = json.dumps({"steps": args.get("steps", [])})
    elif tool_type == "manage_session":
        action = args.get("action", "")
        value = args.get("value", "")
        # `list` is the only action that takes an OPTIONAL keyword
        # filter — never a session_id. Don't leak the "current" default
        # into the filter slot (was producing "No sessions found
        # matching 'current'" when the agent omitted session_id).
        if action == "list":
            keyword = args.get("session_id", "") or args.get("keyword", "") or value
            content = "list" + (("\n" + keyword) if keyword and keyword.lower() != "current" else "")
        else:
            sid = args.get("session_id", "current")
            content = action + "\n" + sid
            if value:
                content += "\n" + value
    elif tool_type == "manage_memory":
        action = args.get("action", "")
        if action == "add":
            content = "add\n" + args.get("text", "")
            if args.get("category"):
                content += "\n" + args["category"]
        elif action == "edit":
            content = "edit\n" + args.get("memory_id", "") + "\n" + args.get("text", "")
        elif action == "delete":
            content = "delete\n" + args.get("memory_id", "")
        elif action == "search":
            content = "search\n" + args.get("text", "")
        elif action == "list":
            content = "list"
            if args.get("category"):
                content += "\n" + args["category"]
        else:
            content = action
    elif tool_type == "list_models":
        content = args.get("filter", "")
    elif tool_type == "ui_control":
        action = args.get("action", "")
        name = args.get("name", "")
        value = args.get("value", "")
        if action == "toggle":
            content = f"toggle {name} {value}"
        elif action == "open_panel":
            content = f"open_panel {name or value}"
        elif action == "open_email_reply":
            uid = args.get("uid") or name
            folder = args.get("folder") or value or "INBOX"
            mode = args.get("mode") or "reply"
            content = f"open_email_reply {uid} {folder} {mode}"
        elif action == "highlight":
            # name = CSS selector, value = optional label (the game-build manifest's
            # primary action; previously fell into the bare-action fallback and lost
            # its selector).
            content = f"highlight {name or value} {value if name else ''}".strip()
        elif action == "set_mode":
            content = f"set_mode {value or name}"
        elif action == "switch_model":
            content = f"switch_model {value or name}"
        elif action == "set_theme":
            content = f"set_theme {value or name}"
        elif action == "create_theme":
            colors = args.get("colors", {})
            theme_name = name or value or "custom"
            bg = colors.get("bg", "#282c34")
            fg = colors.get("fg", "#9cdef2")
            panel = colors.get("panel", "#111111")
            border = colors.get("border", "#355a66")
            accent = colors.get("accent", "#e06c75")
            content = f"create_theme {theme_name} {bg} {fg} {panel} {border} {accent}"
            # Append advanced overrides as key=value
            adv_keys = [
                "userBubbleBg", "aiBubbleBg", "bubbleBorder", "sidebarBg",
                "sectionAccent", "brandColor", "inputBg", "inputBorder",
                "sendBtnBg", "sendBtnHover", "codeBg", "codeFg",
                "toggleBg", "toggleActive", "accentPrimary", "accentError",
            ]
            for ak in adv_keys:
                if colors.get(ak):
                    content += f" {ak}={colors[ak]}"
        else:
            content = action
    elif tool_type in ("manage_tasks", "manage_skills", "api_call",
                        "manage_endpoints", "manage_mcp", "manage_webhooks",
                        "manage_tokens", "manage_documents", "manage_settings"):
        content = json.dumps(args)
    elif tool_type == "ask_teacher":
        content = args.get("model", "auto") + "\n" + args.get("problem", "")
    else:
        content = json.dumps(args)

    return ToolBlock(tool_type, content)
