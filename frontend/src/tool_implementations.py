"""
tool_implementations.py

Extracted tool implementation functions (do_* and helpers) from agent_tools.py.
These handle the actual execution logic for each tool type.
"""

import asyncio
import json
import logging
import os
import re
from typing import Any, Awaitable, Callable, Dict, List, Optional

from src.constants import MAX_OUTPUT_CHARS, MAX_READ_CHARS
from src.orwell_sync_ledger import note_belt as _sync_ledger_note_belt  # gap #3 telemetry (never raises)
from core.constants import internal_api_base


def get_mcp_manager():
    from src import agent_tools
    return agent_tools.get_mcp_manager()


def _truncate(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    if len(text) > limit:
        return text[:limit] + f"\n... (truncated, {len(text)} chars total)"
    return text

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def _parse_tool_args(content):
    """Parse a tool-call argument blob.

    Accepts either a JSON string or an already-decoded dict. Unwraps the
    common `{"body": {...}}` envelope that smaller models emit when they
    read tool descriptions like "Body is JSON: {...}" literally — they
    pass `body` as a field name rather than treating it as a noun.

    Returns a dict on success, raises ValueError on bad JSON.
    """
    if isinstance(content, str):
        try:
            args = json.loads(content) if content.strip() else {}
        except (json.JSONDecodeError, TypeError) as e:
            raise ValueError(str(e))
    elif isinstance(content, dict):
        args = content
    else:
        args = {}
    # Unwrap {"body": {...}} envelope — but only if `body` is the sole key
    # and points at a dict. We don't want to clobber a legitimate `body`
    # field on tools where it's a real arg (e.g. send_email body text).
    if (
        isinstance(args, dict)
        and len(args) == 1
        and "body" in args
        and isinstance(args["body"], dict)
        and "action" in args["body"]  # extra safety: only unwrap if the inner dict looks like a tool call
    ):
        args = args["body"]
    return args


# ---------------------------------------------------------------------------
# Active document state
# ---------------------------------------------------------------------------

_active_document_id: Optional[str] = None
_active_model: Optional[str] = None


def set_active_document(doc_id: Optional[str]):
    """Set the active document ID for document tool execution."""
    global _active_document_id
    _active_document_id = doc_id


def set_active_model(model: Optional[str]):
    """Set the current model name for version summaries."""
    global _active_model
    _active_model = model


def get_active_document():
    return _active_document_id


def clear_active_document(doc_id: Optional[str] = None) -> bool:
    """Clear the in-memory active-document pointer.

    With ``doc_id`` given, only clears when it matches the current pointer, so a
    different active document is left untouched. Returns True if it was cleared.

    Called when a document is detached from its session or deleted (its tab is
    closed): without this, the stale pointer makes the last-resort doc-injection
    path re-surface a closed document in a later, unrelated chat — even one whose
    session no longer matches — because an unlinked doc has session_id NULL (#1160).
    """
    global _active_document_id
    if doc_id is None or _active_document_id == doc_id:
        _active_document_id = None
        return True
    return False


def _owned_document_query(query, Document, owner: Optional[str]):
    if owner is None:
        # A bare Python `False` is not a valid SQL expression — SQLAlchemy 1.4
        # deprecates it and 2.0 raises ArgumentError. Use the SQL `false()`
        # literal to return zero rows for an unscoped (owner-less) query.
        from sqlalchemy import false
        return query.filter(false())
    return query.filter(Document.owner == owner)


def _get_owned_document(db, Document, doc_id: str, owner: Optional[str], active_only: bool = False):
    q = db.query(Document).filter(Document.id == doc_id)
    if active_only:
        q = q.filter(Document.is_active == True)
    q = _owned_document_query(q, Document, owner)
    return q.first()


def _most_recent_owned_document(db, Document, owner: Optional[str], active_only: bool = False):
    q = db.query(Document)
    if active_only:
        q = q.filter(Document.is_active == True)
    q = _owned_document_query(q, Document, owner)
    return q.order_by(Document.updated_at.desc()).first()


# ---------------------------------------------------------------------------
# Document tools — create/update/edit/suggest living documents
# ---------------------------------------------------------------------------

def _sniff_doc_language(text: str) -> str:
    """Best-effort detect a document's language from its content when the model
    didn't specify one. Defaults to 'markdown' (prose). Recognizes the common
    markup/code types the editor supports so e.g. an SVG isn't saved as markdown."""
    import json as _json, re as _re2
    s = (text or "").strip()
    if not s:
        return "markdown"
    head = s[:600]
    hl = head.lower()
    if _looks_like_email_document(s):
        return "email"
    # Markup (unambiguous)
    if "<svg" in hl:
        return "svg"
    if hl.startswith("<?xml"):
        return "xml"
    if (hl.startswith("<!doctype html") or hl.startswith("<html")
            or _re2.search(r"<(div|body|head|p|span|table|button|h[1-6]|ul|ol|li|img)\b", hl)):
        return "html"
    # JSON
    if s[0] in "{[":
        try:
            _json.loads(s)
            return "json"
        except Exception:
            pass
    # Shebang
    first = s.split("\n", 1)[0].strip().lower()
    if first.startswith("#!"):
        return "python" if "python" in first else "bash"
    # Code by strong leading signals (line-anchored so prose with stray words won't match)
    if _re2.search(r"(?m)^\s*(def \w|class \w|import \w|from \w[\w.]* import )", s):
        return "python"
    if _re2.search(r"(?m)^\s*(function \w|const \w|let \w|export |import .* from )", s):
        return "javascript"
    if _re2.search(r"(?mi)^\s*(select .* from |create table |insert into |update \w)", s):
        return "sql"
    if _re2.search(r"(?m)^[.#]?[\w-]+\s*\{[^{}]*:[^{}]*;", s):
        return "css"
    return "markdown"


def _looks_like_email_document(text: str = "", title: str = "") -> bool:
    import re as _re
    title_l = (title or "").strip().lower()
    if title_l in {"new email", "new mail", "new message"}:
        return True
    s = (text or "").lstrip()
    if "\n---\n" in s and _re.search(r"(?im)^To:\s*", s) and _re.search(r"(?im)^Subject:\s*", s):
        return True
    return bool(_re.search(r"(?im)^To:\s*", s) and _re.search(r"(?im)^Subject:\s*", s))


def _coerce_email_document_content(existing: str, incoming: str) -> str:
    """Keep email docs in the To/Subject/---/body shape even if a model writes
    only the body or dumps header labels without the separator."""
    import re as _re
    old = existing or ""
    new = (incoming or "").strip()
    if "\n---\n" in new:
        return new
    header = old.split("\n---\n", 1)[0] if "\n---\n" in old else "To: \nSubject: "
    if _looks_like_email_document(new):
        lines = new.splitlines()
        last_header_idx = -1
        header_re = _re.compile(r"^(To|Cc|Bcc|Subject|In-Reply-To|References|X-Source-UID|X-Source-Folder|X-Attachments):", _re.I)
        for i, line in enumerate(lines):
            if header_re.match(line.strip()):
                last_header_idx = i
        body_lines = lines[last_header_idx + 1:] if last_header_idx >= 0 else lines
        while body_lines and not body_lines[0].strip():
            body_lines.pop(0)
        body = "\n".join(body_lines).strip()
    else:
        body = new
    return header.rstrip() + "\n---\n" + body


async def do_create_document(content_block: str, session_id: Optional[str] = None, owner: Optional[str] = None) -> Dict:
    """Create a new document. Supports two formats:
      1) Line-based: line 1 = title, line 2 (optional) = language, rest = content
      2) XML-like tags: <title>...</title><language>...</language><content>...</content>
    Some models mix them — strip any XML-style tags and fall back to line parsing."""
    import uuid, re as _re
    from src.database import SessionLocal, Document, DocumentVersion, Session as DbSession

    raw = content_block or ""

    # Known languages the editor understands (match the <select> in HTML)
    _KNOWN_LANGS = {
        "python", "javascript", "typescript", "html", "css", "markdown", "json",
        "yaml", "bash", "sql", "rust", "go", "java", "c", "cpp", "xml", "toml",
        "ini", "ruby", "php", "csv", "email", "text", "plain", "svg",
    }

    # Try XML tag extraction first
    title = None
    language = None
    content = None
    mt = _re.search(r"<title>\s*(.*?)\s*</title>", raw, _re.DOTALL | _re.IGNORECASE)
    ml = _re.search(r"<language>\s*(.*?)\s*</language>", raw, _re.DOTALL | _re.IGNORECASE)
    mc = _re.search(r"<content>\s*(.*?)\s*</content>", raw, _re.DOTALL | _re.IGNORECASE)
    if mt or mc:
        title = mt.group(1).strip() if mt else None
        language = ml.group(1).strip().lower() if ml else None
        content = mc.group(1) if mc else None

    # Fall back to line-based parsing. First strip any stray XML-ish tags.
    if title is None or content is None:
        cleaned = _re.sub(r"</?(?:title|language|content)>", "", raw)
        lines = cleaned.strip().split("\n")
        if title is None:
            title = lines[0].strip() if lines else "Untitled"
            lines = lines[1:]
        # Only consume second line as language if it looks like a valid short lang token
        if language is None and lines:
            candidate = lines[0].strip().lower()
            if candidate and len(candidate) < 20 and " " not in candidate and candidate in _KNOWN_LANGS:
                language = candidate
                lines = lines[1:]
        if content is None:
            content = "\n".join(lines)

    # Validate language: must be in known set, else default based on content
    if language and language not in _KNOWN_LANGS:
        language = None
    if not language:
        # No explicit language — sniff it from the content so an SVG / HTML / JSON
        # / code document isn't silently saved as markdown. Prose → markdown.
        language = _sniff_doc_language(content)
    if _looks_like_email_document(content, title):
        language = "email"

    if not title:
        title = "Untitled"

    if not session_id:
        return {"error": "No session context for document creation"}

    db = SessionLocal()
    try:
        doc_id = str(uuid.uuid4())
        ver_id = str(uuid.uuid4())

        # Inherit ownership from the chat session so the doc survives that
        # session later being deleted (session_id → NULL).
        _sess = db.query(DbSession).filter(DbSession.id == session_id).first()
        if owner is not None and (not _sess or _sess.owner != owner):
            return {"error": "Cannot create document in another user's session"}
        _owner = _sess.owner if _sess else None

        doc = Document(
            id=doc_id,
            session_id=session_id,
            title=title,
            language=language,
            current_content=content,
            version_count=1,
            is_active=True,
            owner=_owner,
        )
        ver = DocumentVersion(
            id=ver_id,
            document_id=doc_id,
            version_number=1,
            content=content,
            summary=f"Created by {_active_model or 'AI'}",
            source="ai",
        )
        db.add(doc)
        db.add(ver)
        db.commit()

        set_active_document(doc_id)
        try:
            from src.event_bus import fire_event
            fire_event("document_created", _owner)
        except Exception:
            logger.debug("document_created event dispatch failed", exc_info=True)

        return {
            "action": "create",
            "doc_id": doc_id,
            "title": title,
            "language": language,
            "content": content,
            "version": 1,
        }
    except Exception as e:
        db.rollback()
        return {"error": f"Failed to create document: {e}"}
    finally:
        db.close()


async def do_update_document(content: str, doc_id: Optional[str] = None, owner: Optional[str] = None) -> Dict:
    """Update an existing document. Content = full new document text."""
    import uuid
    from src.database import SessionLocal, Document, DocumentVersion

    target_id = doc_id or _active_document_id

    db = SessionLocal()
    try:
        doc = None
        if target_id:
            doc = _get_owned_document(db, Document, target_id, owner)
        if not doc:
            doc = _most_recent_owned_document(db, Document, owner)
            if doc:
                target_id = doc.id
                set_active_document(target_id)
                logger.info(f"update_document: fell back to most recent doc id={target_id}")
        if not doc:
            return {"error": "No documents exist to update"}

        is_email_doc = doc.language == "email" or _looks_like_email_document(doc.current_content or "", doc.title or "")
        new_content = _coerce_email_document_content(doc.current_content or "", content) if is_email_doc else content.strip()
        if is_email_doc:
            doc.language = "email"

        new_ver = doc.version_count + 1
        ver = DocumentVersion(
            id=str(uuid.uuid4()),
            document_id=target_id,
            version_number=new_ver,
            content=new_content,
            summary=f"Updated by {_active_model or 'AI'}",
            source="ai",
        )
        doc.current_content = new_content
        doc.version_count = new_ver
        db.add(ver)
        db.commit()

        return {
            "action": "update",
            "doc_id": target_id,
            "title": doc.title,
            "language": doc.language,
            "content": new_content,
            "version": new_ver,
        }
    except Exception as e:
        db.rollback()
        return {"error": f"Failed to update document: {e}"}
    finally:
        db.close()


def parse_edit_blocks(content: str) -> list:
    """Parse <<<FIND>>>...<<<REPLACE>>>...<<<END>>> blocks."""
    edits = []
    pattern = r'<<<FIND>>>\n(.*?)\n<<<REPLACE>>>\n(.*?)\n<<<END>>>'
    for m in re.finditer(pattern, content, re.DOTALL):
        edits.append({"find": m.group(1), "replace": m.group(2)})
    return edits


async def do_edit_document(content: str, doc_id: Optional[str] = None, owner: Optional[str] = None) -> Dict:
    """Apply targeted FIND/REPLACE edits to an existing document."""
    import uuid
    from src.database import SessionLocal, Document, DocumentVersion

    target_id = doc_id or _active_document_id

    edits = parse_edit_blocks(content)
    if not edits:
        return {"error": "No valid <<<FIND>>>...<<<REPLACE>>>...<<<END>>> blocks found"}

    db = SessionLocal()
    try:
        doc = None
        if target_id:
            doc = _get_owned_document(db, Document, target_id, owner)
        if not doc:
            # Fallback: most recently updated document. Avoids "no active doc" errors
            # after server restart or when the agent loses track of which doc to edit.
            doc = _most_recent_owned_document(db, Document, owner)
            if doc:
                target_id = doc.id
                set_active_document(target_id)
                logger.info(f"edit_document: fell back to most recent doc id={target_id} title={doc.title!r}")
        if not doc:
            return {"error": "No documents exist to edit"}

        updated_content = doc.current_content
        applied = 0
        skipped = 0
        for edit in edits:
            _find = edit["find"]
            if _find in updated_content:
                updated_content = updated_content.replace(_find, edit["replace"], 1)
                applied += 1
            else:
                # Defensive: the active-doc context shows a "N\t" line-number
                # gutter for reference. Weaker models sometimes copy that prefix
                # into FIND. If the exact match failed, retry with a leading
                # "<digits><tab>" stripped from each FIND line — but only use it
                # when that stripped form actually matches, so we never corrupt a
                # legitimately tab-prefixed document.
                _stripped = "\n".join(re.sub(r"^\d+\t", "", _l) for _l in _find.split("\n"))
                if _stripped != _find and _stripped in updated_content:
                    updated_content = updated_content.replace(_stripped, edit["replace"], 1)
                    applied += 1
                    logger.info("edit_document: matched after stripping line-number gutter from FIND")
                else:
                    logger.warning(f"edit_document: FIND text not found, skipping: {_find[:80]!r}")
                    skipped += 1

        if applied == 0:
            return {"error": f"No edits applied — none of the FIND blocks matched the document content (skipped {skipped})"}

        new_ver = doc.version_count + 1
        ver = DocumentVersion(
            id=str(uuid.uuid4()),
            document_id=target_id,
            version_number=new_ver,
            content=updated_content,
            summary=f"Edited by {_active_model or 'AI'} ({applied} edit(s))",
            source="ai",
        )
        doc.current_content = updated_content
        doc.version_count = new_ver
        db.add(ver)
        db.commit()

        return {
            "action": "edit",
            "doc_id": target_id,
            "title": doc.title,
            "language": doc.language,
            "content": updated_content,
            "version": new_ver,
            "applied": applied,
            "skipped": skipped,
        }
    except Exception as e:
        db.rollback()
        return {"error": f"Failed to edit document: {e}"}
    finally:
        db.close()


def parse_suggest_blocks(content: str) -> list:
    """Parse <<<FIND>>>...<<<SUGGEST>>>...<<<REASON>>>...<<<END>>> blocks."""
    suggestions = []
    _skip_phrases = ["no change", "clear", "fine as", "looks good", "no improvement", "keep as"]
    pattern = r'<<<FIND>>>\n(.*?)\n<<<SUGGEST>>>\n(.*?)\n<<<REASON>>>\n(.*?)\n<<<END>>>'
    for m in re.finditer(pattern, content, re.DOTALL):
        find_text = m.group(1)
        replace_text = m.group(2)
        reason = m.group(3).strip()
        # Skip no-op suggestions where find == replace or reason says no change
        if find_text.strip() == replace_text.strip():
            continue
        if any(phrase in reason.lower() for phrase in _skip_phrases):
            continue
        suggestions.append({
            "id": f"sugg-{len(suggestions)+1}",
            "find": find_text,
            "replace": replace_text,
            "reason": reason,
        })
    return suggestions


async def do_suggest_document(content: str, doc_id: str = None, owner: Optional[str] = None) -> Dict:
    """Create inline suggestions for the active document WITHOUT modifying it."""
    from src.database import SessionLocal, Document

    target_id = doc_id or _active_document_id
    if not target_id:
        return {"error": "No active document to suggest on"}

    suggestions = parse_suggest_blocks(content)
    if not suggestions:
        return {"error": "No valid <<<FIND>>>...<<<SUGGEST>>>...<<<REASON>>>...<<<END>>> blocks found"}

    db = SessionLocal()
    try:
        doc = _get_owned_document(db, Document, target_id, owner)
        if not doc:
            return {"error": f"Document {target_id} not found"}

        # Validate that FIND text exists in document
        valid = []
        for s in suggestions:
            if s["find"] in doc.current_content:
                valid.append(s)
            else:
                logger.warning(f"suggest_document: FIND text not found, skipping: {s['find'][:80]!r}")

        if not valid:
            return {"error": "No suggestions matched the document content"}

        return {
            "action": "suggest",
            "doc_id": target_id,
            "suggestions": valid,
            "count": len(valid),
        }
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Search chats
# ---------------------------------------------------------------------------

async def do_search_chats(query: str, limit: int = 20, owner: str | None = None) -> Dict:
    """Search past session transcripts for the calling user's sessions only.

    Without an owner filter this used to leak EVERY user's chat history
    into the agent's `search_chats` results (v2 review HIGH-11). The
    caller in `tool_execution.execute_tool_block` now plumbs the owner
    through; legacy callers without owner pass through as before but
    will only see legacy/null-owner rows.
    """
    try:
        from src.session_search import search_session_messages

        results = search_session_messages(query, limit=limit, owner=owner)
        if not results:
            return {"results": f"No chats found matching \"{query}\"."}

        # Group by session to avoid duplicate links
        seen_sessions = {}
        for result in results:
            if result.session_id not in seen_sessions:
                seen_sessions[result.session_id] = result

        lines = [f"Found {len(seen_sessions)} session(s) matching \"{query}\":\n"]
        for sid, result in seen_sessions.items():
            lines.append(f"- **{result.session_name}** (#{sid})")
            lines.append(f"  Link: [Open chat](#{sid})")
            lines.append(f"  Match ({result.role}): {result.content_snippet}")
            if result.context_before:
                before = result.context_before[-1]
                lines.append(f"  Before ({before['role']}): {before['content'][:180]}")
            if result.context_after:
                after = result.context_after[0]
                lines.append(f"  After ({after['role']}): {after['content'][:180]}")
            lines.append("")

        return {"results": "\n".join(lines)}
    except Exception as e:
        logger.error(f"search_chats failed: {e}")
        return {"error": str(e), "exit_code": 1}


# ---------------------------------------------------------------------------
# Skills management tool
# ---------------------------------------------------------------------------

async def do_manage_skills(content: str, owner: Optional[str] = None) -> Dict:
    """Handle manage_skills tool calls.

    SKILL.md-backed CRUD with progressive disclosure (Hermes-style). Actions:

      list / index               — Level 0: name + description summary.
      view {name}                — Level 1: full SKILL.md.
      view_ref {name, path}      — Level 2: a sub-file under the skill dir.
      add  {name, description, when_to_use, procedure[], pitfalls[],
            verification[], tags[], category, status}
                                 — Create a new skill (draft by default).
      patch {name, old_string, new_string}
                                 — Token-efficient surgical edit on the
                                   raw SKILL.md text. Fails on ambiguous
                                   `old_string` (multiple matches).
      edit  {name, content}      — Replace the entire SKILL.md.
      publish {name}             — Flip status: draft -> published.
      delete {name}              — Remove the skill directory.
      search {query}             — Relevance match on published skills.
    """
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    action = (args.get("action") or "").lower()
    from services.memory.skills import SkillsManager
    from services.memory.skill_format import Skill, slugify
    from src.constants import DATA_DIR
    sm = SkillsManager(DATA_DIR)

    # Accept legacy `skill_id` as an alias for `name`.
    name = (args.get("name") or args.get("skill_id") or "").strip()

    if action in ("list", "index", ""):
        all_skills = sm.load(owner=owner)
        if not all_skills:
            return {"results": "No skills yet. Create one with action='add'."}
        published = [s for s in all_skills if s.get("status") == "published"]
        drafts = [s for s in all_skills if s.get("status") == "draft"]
        lines = []
        if published:
            lines.append("## Published")
            for s in sorted(published, key=lambda x: x["name"]):
                lines.append(f"- **{s['name']}** ({s.get('category','general')}): {s.get('description','')}")
        if drafts:
            lines.append("\n## Drafts")
            for s in sorted(drafts, key=lambda x: x["name"]):
                lines.append(f"- **{s['name']}** [draft]: {s.get('description','')}")
        return {"results": "\n".join(lines) if lines else "No skills yet."}

    if action == "view":
        if not name:
            return {"error": "name is required for view", "exit_code": 1}
        md = sm.read_skill_md(name, owner=owner)
        if md is None:
            return {"error": f"Skill {name!r} not found", "exit_code": 1}
        return {"results": md}

    if action == "view_ref":
        if not name:
            return {"error": "name is required for view_ref", "exit_code": 1}
        ref = (args.get("path") or "").strip()
        if not ref:
            return {"error": "path is required for view_ref", "exit_code": 1}
        text = sm.read_skill_reference(name, ref, owner=owner)
        if text is None:
            return {"error": f"Reference {ref!r} not found under {name!r}", "exit_code": 1}
        return {"results": text}

    if action == "add":
        if not name:
            return {
                "error": "name is required for add. Provide the exact slug the user should see, then report the returned name.",
                "exit_code": 1,
            }
        proc = args.get("procedure")
        if proc is None:
            proc = args.get("steps") or []
        if not proc and not args.get("body_extra") and not args.get("solution"):
            return {"error": "procedure (or solution body) is required", "exit_code": 1}
        entry = sm.add_skill(
            name=args.get("name"),
            description=(args.get("description") or args.get("title") or "").strip(),
            category=args.get("category") or "general",
            tags=args.get("tags") or [],
            platforms=args.get("platforms") or [],
            requires_toolsets=args.get("requires_toolsets") or [],
            fallback_for_toolsets=args.get("fallback_for_toolsets") or [],
            when_to_use=(args.get("when_to_use") if args.get("when_to_use") is not None
                         else args.get("problem", "")),
            procedure=proc,
            pitfalls=args.get("pitfalls") or [],
            verification=args.get("verification") or [],
            status=args.get("status") or "draft",
            version=args.get("version") or "1.0.0",
            confidence=args.get("confidence", 0.8),
            source=args.get("source", "learned"),
            teacher_model=args.get("teacher_model"),
            owner=owner,
            title=args.get("title", ""),
            problem=args.get("problem", ""),
            solution=args.get("solution", ""),
            steps=args.get("steps") or [],
        )
        if entry.get("_deduped"):
            return {"results": (
                f"A near-identical skill already exists: `{entry['name']}` — not creating "
                f"a duplicate. View or edit it with action='view', name='{entry['name']}'."
            )}
        try:
            from src.event_bus import fire_event
            fire_event("skill_added", owner)
        except Exception:
            logger.debug("skill_added event dispatch failed", exc_info=True)
        verify_hint = ""
        if entry.get("status") == "draft":
            verify_hint = (
                "\n\nThis skill is a DRAFT. Run through the procedure once to verify, "
                f"then publish with action='publish', name='{entry['name']}'."
            )
        return {"results": f"Created skill `{entry['name']}` — {entry.get('description','')}{verify_hint}"}

    if action == "edit":
        if not name:
            return {"error": "name is required for edit", "exit_code": 1}
        new_content = args.get("content")
        if not isinstance(new_content, str) or not new_content.strip():
            return {"error": "content (full SKILL.md) is required for edit", "exit_code": 1}
        try:
            sk_new = Skill.from_markdown(new_content)
        except Exception as e:
            return {"error": f"Could not parse content as SKILL.md: {e}", "exit_code": 1}
        sk_new.name = slugify(sk_new.name or name)
        existing = sm.load(owner=owner)
        match = next((s for s in existing if s.get("name") == name), None)
        if not match:
            return {"error": f"Skill {name!r} not found", "exit_code": 1}
        if not sk_new.owner:
            sk_new.owner = match.get("owner") or owner
        ok = sm.update_skill(name, _skill_dump(sk_new), owner=owner)
        return {"results": f"Edited skill `{sk_new.name}`."} if ok else {"error": "Update failed", "exit_code": 1}

    if action == "patch":
        if not name:
            return {"error": "name is required for patch", "exit_code": 1}
        old = args.get("old_string")
        new_str = args.get("new_string", "")
        if not isinstance(old, str) or not old:
            return {"error": "old_string is required and must be non-empty", "exit_code": 1}
        md = sm.read_skill_md(name, owner=owner)
        if md is None:
            return {"error": f"Skill {name!r} not found", "exit_code": 1}
        count = md.count(old)
        if count == 0:
            return {"error": "old_string not found in SKILL.md", "exit_code": 1}
        if count > 1:
            return {"error": f"old_string is ambiguous (appears {count} times). Make it more specific.", "exit_code": 1}
        new_md = md.replace(old, new_str, 1)
        try:
            sk_new = Skill.from_markdown(new_md)
        except Exception as e:
            return {"error": f"Patched content is not valid SKILL.md: {e}", "exit_code": 1}
        sk_new.name = slugify(sk_new.name or name)
        ok = sm.update_skill(name, _skill_dump(sk_new), owner=owner)
        return {"results": f"Patched skill `{sk_new.name}`."} if ok else {"error": "Patch update failed", "exit_code": 1}

    if action == "publish":
        if not name:
            return {"error": "name is required for publish", "exit_code": 1}
        all_skills = sm.load(owner=owner)
        match = next((s for s in all_skills if s.get("name") == name), None)
        if not match:
            return {"error": f"Skill {name!r} not found", "exit_code": 1}
        updates = {"status": "published"}
        if args.get("confidence") is not None:
            updates["confidence"] = max(0.0, min(1.0, float(args["confidence"])))
        sm.update_skill(name, updates, owner=owner)
        return {"results": f"✅ Published `{name}`. It now appears in the skills index for future turns."}

    if action == "delete":
        if not name:
            return {"error": "name is required for delete", "exit_code": 1}
        ok = sm.delete_skill(name, owner=owner)
        return {"results": f"Deleted skill `{name}`."} if ok else {"error": f"Skill {name!r} not found", "exit_code": 1}

    if action == "search":
        query = (args.get("query") or "").strip()
        if not query:
            return {"error": "query is required for search", "exit_code": 1}
        results = sm.get_relevant_skills(query, sm.load(owner=owner), max_items=5)
        if not results:
            return {"results": "No matching skills found."}
        lines = []
        for sk in results:
            proc = sk.get("procedure") or sk.get("steps") or []
            steps_str = " → ".join(proc[:5])
            lines.append(f"**{sk['name']}**: {sk.get('description','')}\n  When: {sk.get('when_to_use','')}\n  Steps: {steps_str}")
        return {"results": "\n\n".join(lines)}

    return {
        "error": (
            f"Unknown action: {action!r}. "
            "Use one of: list, view, view_ref, add, edit, patch, publish, delete, search."
        ),
        "exit_code": 1,
    }


def _skill_dump(sk) -> Dict:
    """Translate a parsed Skill back into the kwargs `update_skill` expects."""
    return {
        "name": sk.name,
        "description": sk.description,
        "version": sk.version,
        "category": sk.category,
        "tags": sk.tags,
        "platforms": sk.platforms,
        "requires_toolsets": sk.requires_toolsets,
        "fallback_for_toolsets": sk.fallback_for_toolsets,
        "status": sk.status,
        "confidence": sk.confidence,
        "source": sk.source,
        "teacher_model": sk.teacher_model,
        "owner": sk.owner,
        "when_to_use": sk.when_to_use,
        "procedure": sk.procedure,
        "pitfalls": sk.pitfalls,
        "verification": sk.verification,
        "body_extra": sk.body_extra,
    }


# ---------------------------------------------------------------------------
# Task management tool
# ---------------------------------------------------------------------------

async def do_manage_tasks(content: str, owner: Optional[str] = None) -> Dict:
    """Handle manage_tasks tool calls: CRUD on scheduled tasks."""
    import uuid as _uuid
    from core.database import SessionLocal, ScheduledTask
    from src.task_scheduler import compute_next_run

    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    action = args.get("action", "list")
    db = SessionLocal()
    try:
        if action == "list":
            q = db.query(ScheduledTask)
            if owner:
                q = q.filter(ScheduledTask.owner == owner)
            tasks = q.order_by(ScheduledTask.created_at.desc()).all()
            task_list = []
            for t in tasks:
                task_list.append({
                    "id": t.id, "name": t.name, "status": t.status,
                    "task_type": t.task_type or "llm",
                    "action": t.action,
                    "trigger_type": t.trigger_type or "schedule",
                    "schedule": t.schedule,
                    "trigger_event": t.trigger_event,
                    "trigger_count": t.trigger_count,
                    "next_run": t.next_run.isoformat() + "Z" if t.next_run else None,
                    "last_run": t.last_run.isoformat() + "Z" if t.last_run else None,
                    "run_count": t.run_count or 0,
                })
            return {"response": f"Found {len(task_list)} tasks", "tasks": task_list, "exit_code": 0}

        elif action == "create":
            task_type = args.get("task_type", "llm")
            trigger_type = args.get("trigger_type", "schedule")

            if task_type in ("llm", "research") and not args.get("prompt"):
                return {"error": "Prompt is required for llm/research tasks", "exit_code": 1}
            if task_type == "action" and not args.get("action_name"):
                return {"error": "action_name is required for action tasks", "exit_code": 1}

            # Compute next_run for schedule triggers
            next_run = None
            if trigger_type == "schedule":
                schedule = args.get("schedule", "daily")
                next_run = compute_next_run(
                    schedule, args.get("scheduled_time", "09:00"),
                    args.get("scheduled_day"),
                )

            task_id = str(_uuid.uuid4())
            # Guard each fallback with `or`: args.get("prompt", default) returns
            # None when the key is present but null, and None[:50] raises.
            name = args.get("name") or (args.get("prompt") or args.get("action_name") or "Task")[:50]

            task = ScheduledTask(
                id=task_id,
                owner=owner,
                name=name,
                prompt=args.get("prompt"),
                task_type=task_type,
                action=args.get("action_name"),
                schedule=args.get("schedule") if trigger_type == "schedule" else None,
                scheduled_time=args.get("scheduled_time", "09:00") if trigger_type == "schedule" else None,
                scheduled_day=args.get("scheduled_day"),
                trigger_type=trigger_type,
                trigger_event=args.get("trigger_event"),
                trigger_count=args.get("trigger_count"),
                trigger_counter=0,
                next_run=next_run,
                status="active",
                output_target=args.get("output_target", "session"),
            )
            db.add(task)
            db.commit()
            return {"response": f"Created task '{name}' (id: {task_id})", "task_id": task_id, "exit_code": 0}

        elif action == "edit":
            task_id = args.get("task_id")
            if not task_id:
                return {"error": "task_id is required for edit", "exit_code": 1}
            task = db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
            if not task:
                return {"error": f"Task {task_id} not found", "exit_code": 1}
            if owner and task.owner and task.owner != owner:
                return {"error": "Access denied", "exit_code": 1}

            changed = []
            for field in ("name", "prompt", "output_target"):
                if args.get(field) is not None:
                    setattr(task, field, args[field])
                    changed.append(field)
            if args.get("task_type") is not None:
                task.task_type = args["task_type"]
                changed.append("task_type")
            if args.get("action_name") is not None:
                task.action = args["action_name"]
                changed.append("action")
            if args.get("trigger_type") is not None:
                task.trigger_type = args["trigger_type"]
                changed.append("trigger_type")
            if args.get("trigger_event") is not None:
                task.trigger_event = args["trigger_event"]
                changed.append("trigger_event")
            if args.get("trigger_count") is not None:
                task.trigger_count = args["trigger_count"]
                changed.append("trigger_count")

            schedule_changed = False
            for field in ("schedule", "scheduled_time", "scheduled_day"):
                if args.get(field) is not None:
                    setattr(task, field, args[field])
                    changed.append(field)
                    schedule_changed = True

            if schedule_changed and (task.trigger_type or "schedule") == "schedule":
                task.next_run = compute_next_run(
                    task.schedule, task.scheduled_time, task.scheduled_day,
                )

            db.commit()
            return {"response": f"Updated task '{task.name}': {', '.join(changed)}", "exit_code": 0}

        elif action == "delete":
            task_id = args.get("task_id")
            if not task_id:
                return {"error": "task_id is required for delete", "exit_code": 1}
            task = db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
            if not task:
                return {"error": f"Task {task_id} not found", "exit_code": 1}
            if owner and task.owner and task.owner != owner:
                return {"error": "Access denied", "exit_code": 1}
            name = task.name
            db.delete(task)
            db.commit()
            return {"response": f"Deleted task '{name}'", "exit_code": 0}

        elif action in ("pause", "resume"):
            task_id = args.get("task_id")
            if not task_id:
                return {"error": f"task_id is required for {action}", "exit_code": 1}
            task = db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
            if not task:
                return {"error": f"Task {task_id} not found", "exit_code": 1}
            if owner and task.owner and task.owner != owner:
                return {"error": "Access denied", "exit_code": 1}

            if action == "pause":
                task.status = "paused"
            else:
                task.status = "active"
                if (task.trigger_type or "schedule") == "schedule":
                    task.next_run = compute_next_run(
                        task.schedule, task.scheduled_time, task.scheduled_day,
                    )
            db.commit()
            return {"response": f"Task '{task.name}' {action}d", "exit_code": 0}

        elif action == "run":
            task_id = args.get("task_id")
            if not task_id:
                return {"error": "task_id is required for run", "exit_code": 1}
            task = db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
            if not task:
                return {"error": f"Task {task_id} not found", "exit_code": 1}
            if owner and task.owner and task.owner != owner:
                return {"error": "Access denied", "exit_code": 1}

            from src.event_bus import get_task_scheduler
            scheduler = get_task_scheduler()
            if scheduler:
                started = await scheduler.run_task_now(task_id)
                if started:
                    return {"response": f"Task '{task.name}' triggered", "exit_code": 0}
                else:
                    return {"error": "Task is already running", "exit_code": 1}
            return {"error": "Task scheduler not available", "exit_code": 1}

        else:
            return {"error": f"Unknown action: {action}", "exit_code": 1}

    except Exception as e:
        logger.error(f"manage_tasks error: {e}")
        return {"error": str(e), "exit_code": 1}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Endpoint management tool
# ---------------------------------------------------------------------------

async def do_manage_endpoints(content: str, owner: Optional[str] = None) -> Dict:
    """Manage model endpoints: list, add, delete, enable, disable."""
    from core.database import SessionLocal, ModelEndpoint
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    action = args.get("action", "list")
    db = SessionLocal()
    try:
        if action == "list":
            eps = db.query(ModelEndpoint).all()
            items = [{"id": e.id, "name": e.name, "base_url": e.base_url,
                       "is_enabled": e.is_enabled} for e in eps]
            return {"response": f"{len(items)} endpoints", "endpoints": items, "exit_code": 0}

        elif action == "add":
            import uuid as _uuid
            name = args.get("name", "")
            base_url = args.get("base_url", "")
            api_key = args.get("api_key", "")
            if not base_url:
                return {"error": "base_url is required", "exit_code": 1}
            eid = str(_uuid.uuid4())[:8]
            from datetime import datetime
            ep = ModelEndpoint(id=eid, name=name or base_url, base_url=base_url,
                               api_key=api_key, is_enabled=True,
                               created_at=datetime.utcnow(), updated_at=datetime.utcnow())
            db.add(ep)
            db.commit()
            return {"response": f"Added endpoint '{name or base_url}' (id: {eid})", "exit_code": 0}

        elif action == "delete":
            eid = args.get("endpoint_id", "")
            ep = db.query(ModelEndpoint).filter(ModelEndpoint.id == eid).first()
            if not ep:
                return {"error": f"Endpoint {eid} not found", "exit_code": 1}
            name = ep.name
            db.delete(ep)
            db.commit()
            return {"response": f"Deleted endpoint '{name}'", "exit_code": 0}

        elif action in ("enable", "disable"):
            eid = args.get("endpoint_id", "")
            ep = db.query(ModelEndpoint).filter(ModelEndpoint.id == eid).first()
            if not ep:
                return {"error": f"Endpoint {eid} not found", "exit_code": 1}
            ep.is_enabled = (action == "enable")
            db.commit()
            return {"response": f"Endpoint '{ep.name}' {action}d", "exit_code": 0}

        else:
            return {"error": f"Unknown action: {action}", "exit_code": 1}
    except Exception as e:
        logger.error(f"manage_endpoints error: {e}")
        return {"error": str(e), "exit_code": 1}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# MCP server management tool
# ---------------------------------------------------------------------------

async def do_manage_mcp(content: str, owner: Optional[str] = None) -> Dict:
    """Manage MCP servers: list, add, delete, enable, disable, reconnect."""
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    action = args.get("action", "list")

    if action == "list":
        mcp = get_mcp_manager()
        if not mcp:
            return {"response": "No MCP manager available", "servers": [], "exit_code": 0}
        from core.database import SessionLocal, McpServer
        db = SessionLocal()
        try:
            servers = db.query(McpServer).all()
            items = []
            for s in servers:
                st = mcp.get_server_status(s.id)
                status = st.get("status", "disconnected")
                tool_count = st.get("tool_count", 0)
                items.append({"id": s.id, "name": s.name, "transport": s.transport,
                              "is_enabled": s.is_enabled, "status": status,
                              "tool_count": tool_count})
            return {"response": f"{len(items)} MCP servers", "servers": items, "exit_code": 0}
        finally:
            db.close()

    elif action == "add":
        from core.database import SessionLocal, McpServer
        import uuid as _uuid
        from datetime import datetime
        name = args.get("name", "")
        command = args.get("command", "")
        cmd_args = args.get("args", [])
        env = args.get("env", {})
        if not name or not command:
            return {"error": "name and command are required", "exit_code": 1}
        sid = str(_uuid.uuid4())[:8]
        db = SessionLocal()
        try:
            srv = McpServer(id=sid, name=name, transport="stdio", command=command,
                            args=json.dumps(cmd_args) if isinstance(cmd_args, list) else cmd_args,
                            env=json.dumps(env) if isinstance(env, dict) else env,
                            is_enabled=True, created_at=datetime.utcnow(), updated_at=datetime.utcnow())
            db.add(srv)
            db.commit()
        finally:
            db.close()
        # Try to connect
        mcp = get_mcp_manager()
        tool_count = 0
        if mcp:
            try:
                await mcp.connect_server(
                    sid, name, "stdio", command=command,
                    args=cmd_args if isinstance(cmd_args, list) else json.loads(cmd_args),
                    env=env if isinstance(env, dict) else json.loads(env),
                )
                st = mcp.get_server_status(sid)
                tool_count = st.get("tool_count", 0)
            except Exception as e:
                logger.warning(f"MCP connect failed for {name}: {e}")
        return {"response": f"Added MCP server '{name}' ({tool_count} tools)", "exit_code": 0}

    elif action == "delete":
        sid = args.get("server_id", "")
        from core.database import SessionLocal, McpServer
        db = SessionLocal()
        try:
            srv = db.query(McpServer).filter(McpServer.id == sid).first()
            if not srv:
                return {"error": f"Server {sid} not found", "exit_code": 1}
            name = srv.name
            mcp = get_mcp_manager()
            if mcp:
                try:
                    await mcp.disconnect_server(sid)
                except Exception:
                    pass
            db.delete(srv)
            db.commit()
            return {"response": f"Deleted MCP server '{name}'", "exit_code": 0}
        finally:
            db.close()

    elif action == "reconnect":
        sid = args.get("server_id", "")
        mcp = get_mcp_manager()
        if not mcp:
            return {"error": "MCP manager not available", "exit_code": 1}
        try:
            await mcp.disconnect_server(sid)
            from core.database import SessionLocal, McpServer
            db2 = SessionLocal()
            try:
                srv = db2.query(McpServer).filter(McpServer.id == sid).first()
                if srv:
                    _args = json.loads(srv.args) if srv.args else []
                    _env = json.loads(srv.env) if srv.env else {}
                    await mcp.connect_server(
                        server_id=sid,
                        name=srv.name,
                        transport=srv.transport,
                        command=srv.command,
                        args=_args,
                        env=_env,
                        url=srv.url,
                    )
                    st = mcp.get_server_status(sid)
                    return {"response": f"Reconnected '{srv.name}' ({st.get('tool_count', 0)} tools)", "exit_code": 0}
                return {"error": f"Server {sid} not found", "exit_code": 1}
            finally:
                db2.close()
        except Exception as e:
            return {"error": str(e), "exit_code": 1}

    elif action in ("enable", "disable"):
        sid = args.get("server_id", "")
        from core.database import SessionLocal, McpServer
        db = SessionLocal()
        try:
            srv = db.query(McpServer).filter(McpServer.id == sid).first()
            if not srv:
                return {"error": f"Server {sid} not found", "exit_code": 1}
            srv.is_enabled = (action == "enable")
            db.commit()
            return {"response": f"MCP server '{srv.name}' {action}d", "exit_code": 0}
        finally:
            db.close()

    elif action == "list_tools":
        mcp = get_mcp_manager()
        if not mcp:
            return {"response": "No MCP manager", "tools": [], "exit_code": 0}
        tools = mcp.get_all_tools()
        items = [{"name": t["name"], "server": t["server_name"],
                  "description": t.get("description", "")[:100]} for t in tools]
        return {"response": f"{len(items)} MCP tools available", "tools": items, "exit_code": 0}

    else:
        return {"error": f"Unknown action: {action}", "exit_code": 1}


# ---------------------------------------------------------------------------
# Webhook management tool
# ---------------------------------------------------------------------------

async def do_manage_webhooks(content: str, owner: Optional[str] = None) -> Dict:
    """Manage webhooks: list, add, delete, enable, disable, test."""
    from core.database import SessionLocal
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    action = args.get("action", "list")
    db = SessionLocal()
    try:
        from core.database import Webhook
        if action == "list":
            hooks = db.query(Webhook).all()
            items = [{"id": h.id, "name": h.name, "url": h.url,
                       "events": h.events, "is_active": h.is_active} for h in hooks]
            return {"response": f"{len(items)} webhooks", "webhooks": items, "exit_code": 0}

        elif action == "add":
            import uuid as _uuid
            from datetime import datetime
            from src.webhook_manager import validate_events, validate_webhook_url
            name = args.get("name", "")
            url = args.get("url", "")
            events = args.get("events", "chat.completed")
            if not url:
                return {"error": "url is required", "exit_code": 1}
            try:
                url = validate_webhook_url(url)
                events = validate_events(events)
            except ValueError as e:
                return {"error": str(e), "exit_code": 1}
            wid = str(_uuid.uuid4())[:8]
            hook = Webhook(id=wid, name=name or url, url=url,
                           events=events, is_active=True,
                           created_at=datetime.utcnow(), updated_at=datetime.utcnow())
            db.add(hook)
            db.commit()
            return {"response": f"Added webhook '{name or url}'", "exit_code": 0}

        elif action == "delete":
            wid = args.get("webhook_id", "")
            hook = db.query(Webhook).filter(Webhook.id == wid).first()
            if not hook:
                return {"error": f"Webhook {wid} not found", "exit_code": 1}
            name = hook.name
            db.delete(hook)
            db.commit()
            return {"response": f"Deleted webhook '{name}'", "exit_code": 0}

        elif action in ("enable", "disable"):
            wid = args.get("webhook_id", "")
            hook = db.query(Webhook).filter(Webhook.id == wid).first()
            if not hook:
                return {"error": f"Webhook {wid} not found", "exit_code": 1}
            hook.is_active = (action == "enable")
            db.commit()
            return {"response": f"Webhook '{hook.name}' {action}d", "exit_code": 0}

        else:
            return {"error": f"Unknown action: {action}", "exit_code": 1}
    except Exception as e:
        logger.error(f"manage_webhooks error: {e}")
        return {"error": str(e), "exit_code": 1}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# API token management tool
# ---------------------------------------------------------------------------

async def do_manage_tokens(content: str, owner: Optional[str] = None) -> Dict:
    """Manage API tokens: list, create, delete."""
    from core.database import SessionLocal, ApiToken
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    action = args.get("action", "list")
    db = SessionLocal()
    try:
        if action == "list":
            tokens = db.query(ApiToken).all()
            items = [{"id": t.id, "name": t.name, "token_prefix": t.token_prefix + "...",
                       "is_active": t.is_active} for t in tokens]
            return {"response": f"{len(items)} API tokens", "tokens": items, "exit_code": 0}

        elif action == "create":
            import uuid as _uuid, secrets, bcrypt
            from datetime import datetime
            name = args.get("name", "API Token")
            raw_token = secrets.token_urlsafe(32)
            token_hash = bcrypt.hashpw(raw_token.encode(), bcrypt.gensalt()).decode()
            tid = str(_uuid.uuid4())[:8]
            t = ApiToken(id=tid, name=name, token_hash=token_hash,
                         token_prefix=raw_token[:8], is_active=True,
                         created_at=datetime.utcnow(), updated_at=datetime.utcnow())
            db.add(t)
            db.commit()
            return {"response": f"Created token '{name}'", "token": raw_token, "exit_code": 0}

        elif action == "delete":
            tid = args.get("token_id", "")
            t = db.query(ApiToken).filter(ApiToken.id == tid).first()
            if not t:
                return {"error": f"Token {tid} not found", "exit_code": 1}
            name = t.name
            db.delete(t)
            db.commit()
            return {"response": f"Deleted token '{name}'", "exit_code": 0}

        else:
            return {"error": f"Unknown action: {action}", "exit_code": 1}
    except Exception as e:
        logger.error(f"manage_tokens error: {e}")
        return {"error": str(e), "exit_code": 1}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Document management tool (delete, list, organize)
# ---------------------------------------------------------------------------

async def do_manage_documents(content: str, owner: Optional[str] = None) -> Dict:
    """Manage documents: list, read/view/open, delete, tidy.

    Output format mirrors `manage_session`: list rows include a
    clickable `[Title](#document-<id>)` anchor + relative timestamps
    so the user can click straight from chat to open the editor.
    """
    from core.database import SessionLocal, Document
    from datetime import datetime, timezone

    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    action = args.get("action", "list")
    db = SessionLocal()

    def _rel(ts):
        if not ts:
            return 'never'
        try:
            now = datetime.now(timezone.utc) if ts.tzinfo is not None else datetime.utcnow()
            diff = (now - ts).total_seconds()
        except Exception:
            return 'unknown'
        if diff < 60: return 'just now'
        if diff < 3600: return f'{int(diff / 60)}m ago'
        if diff < 86400: return f'{int(diff / 3600)}h ago'
        if diff < 86400 * 7: return f'{int(diff / 86400)}d ago'
        return ts.strftime('%Y-%m-%d')

    try:
        if action == "list":
            q = db.query(Document).filter(Document.is_active == True)
            q = _owned_document_query(q, Document, owner)
            if args.get("search"):
                q = q.filter(Document.title.ilike(f"%{args['search']}%"))
            if args.get("language"):
                q = q.filter(Document.language == args["language"])
            docs = q.order_by(Document.updated_at.desc()).limit(args.get("limit", 50)).all()
            if not docs:
                msg = "No documents found" + (f" matching '{args['search']}'" if args.get("search") else "") + "."
                return {"response": msg, "documents": [], "exit_code": 0}
            lines = []
            items = []
            for i, d in enumerate(docs):
                size = len(d.current_content or "")
                lang = d.language or "text"
                ts = getattr(d, 'updated_at', None) or getattr(d, 'created_at', None)
                marker = " ← most recent" if i == 0 else ""
                lines.append(
                    f"- [{d.title}](#document-{d.id}) — {lang}, {size} chars, updated {_rel(ts)}{marker}"
                )
                items.append({"id": d.id, "title": d.title, "language": lang, "size": size})
            header = f"Found {len(docs)} document(s), sorted most-recent first. Click a title to open:"
            return {
                "response": header + "\n" + "\n".join(lines),
                "documents": items,
                "exit_code": 0,
            }

        elif action in ("read", "view", "open", "get"):
            doc_id = args.get("document_id") or args.get("id") or args.get("uid")
            if not doc_id:
                return {"error": "Need document_id (use action=list to find one)", "exit_code": 1}
            doc = _get_owned_document(db, Document, doc_id, owner, active_only=True)
            if not doc:
                return {"error": f"Document '{doc_id}' not found", "exit_code": 1}
            body = doc.current_content or ""
            preview_limit = int(args.get("limit", MAX_READ_CHARS))
            truncated = len(body) > preview_limit
            preview = body[:preview_limit] + (f"\n... (truncated, {len(body)} chars total)" if truncated else "")
            anchor = f"[{doc.title}](#document-{doc.id})"
            return {
                "response": f"{anchor} — click to open in editor.\n\n```{doc.language or ''}\n{preview}\n```",
                "document": {
                    "id": doc.id,
                    "title": doc.title,
                    "language": doc.language,
                    "size": len(body),
                    "content": preview,
                    "truncated": truncated,
                },
                "exit_code": 0,
            }

        elif action == "delete":
            doc_id = args.get("document_id") or args.get("id") or args.get("uid") or _active_document_id
            doc = None
            if doc_id:
                doc = _get_owned_document(db, Document, doc_id, owner)
            if not doc:
                # Fallback: most recently updated doc (likely what the user means)
                doc = _most_recent_owned_document(db, Document, owner, active_only=True)
            if not doc:
                return {"error": "No document to delete", "exit_code": 1}
            title = doc.title
            doc.is_active = False
            db.commit()
            if _active_document_id == doc.id:
                set_active_document(None)
            return {"response": f"Deleted document '{title}'", "exit_code": 0}

        elif action == "tidy":
            from src.document_actions import run_document_tidy
            result = await run_document_tidy(owner or "")
            return {"response": result, "exit_code": 0}

        else:
            return {"error": f"Unknown action: {action}", "exit_code": 1}
    except Exception as e:
        logger.error(f"manage_documents error: {e}")
        return {"error": str(e), "exit_code": 1}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Settings/preferences management tool
# ---------------------------------------------------------------------------

async def do_manage_settings(content: str, owner: Optional[str] = None) -> Dict:
    """Manage user settings and preferences."""
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    action = args.get("action", "list")

    from core.database import SessionLocal
    db = SessionLocal()
    try:
        # set/get/list/delete operate on the REAL app settings (the same store
        # the Settings panel writes), so changing a model / voice / search
        # engine / reminder channel from chat actually takes effect.
        from src.settings import load_settings, save_settings, DEFAULT_SETTINGS

        # Secrets/credentials the agent must NOT write — kept read-only (masked)
        # so API keys never flow through chat. User sets these in the panel.
        _SECRET_KEYS = {
            "brave_api_key", "google_pse_key", "google_pse_cx",
            "tavily_api_key", "serper_api_key", "app_public_url",
        }
        def _is_secret(k):
            # `token` must be a suffix, not a substring: otherwise the int
            # setting `agent_input_token_budget` (which even has a "token budget"
            # alias to set it from chat) is wrongly classified as a credential.
            return (
                k in _SECRET_KEYS
                or k.endswith("token")
                or any(t in k for t in ("api_key", "_key", "secret", "password"))
            )

        # Friendly aliases → real keys, so natural phrasing resolves.
        _ALIASES_SET = {
            "voice": "tts_voice", "tts voice": "tts_voice", "tts": "tts_enabled",
            "text to speech": "tts_enabled", "tts provider": "tts_provider",
            "speech speed": "tts_speed", "voice speed": "tts_speed",
            "stt": "stt_enabled", "speech to text": "stt_enabled", "transcription": "stt_enabled",
            "search engine": "search_provider", "search provider": "search_provider",
            "search results": "search_result_count", "result count": "search_result_count",
            "default model": "default_model", "chat model": "default_model",
            "default endpoint": "default_endpoint_id",
            "task model": "task_model", "background model": "task_model",
            "teacher model": "teacher_model", "teacher": "teacher_enabled",
            "utility model": "utility_model", "research model": "research_model",
            "research max tokens": "research_max_tokens",
            "vision model": "vision_model", "vision": "vision_enabled",
            "image model": "image_model", "image quality": "image_quality",
            "image gen": "image_gen_enabled", "image generation": "image_gen_enabled",
            "reminder channel": "reminder_channel", "reminders": "reminder_channel",
            "ntfy topic": "reminder_ntfy_topic",
            "webhook integration": "reminder_webhook_integration_id",
            "webhook template": "reminder_webhook_payload_template", "webhook payload": "reminder_webhook_payload_template",
            "agent tool calls": "agent_max_tool_calls", "max tool calls": "agent_max_tool_calls",
            "agent timeout": "agent_stream_timeout_seconds", "stream timeout": "agent_stream_timeout_seconds",
            "token budget": "agent_input_token_budget", "input budget": "agent_input_token_budget",
            "hard max": "agent_input_token_hard_max",
            "token budget cap": "agent_input_token_hard_max",
            "input budget cap": "agent_input_token_hard_max",
        }
        def _resolve(k):
            k2 = (k or "").strip().lower()
            if k2 in DEFAULT_SETTINGS:
                return k2
            return _ALIASES_SET.get(k2, (k or "").strip())

        _ENUMS = {
            "image_quality": ["low", "medium", "high"],
            "reminder_channel": ["browser", "email", "ntfy", "webhook"],
        }
        def _coerce(value, default):
            if isinstance(default, bool):
                return value if isinstance(value, bool) else str(value).strip().lower() in ("true", "on", "yes", "1", "enable", "enabled")
            if isinstance(default, int):
                return int(value)
            return value

        def _model_slug(value: str) -> str:
            import re as _re
            return _re.sub(r"[^a-z0-9]+", "", (value or "").lower())

        def _endpoint_model_from_cache(model_query: str):
            """Resolve friendly model text to an enabled endpoint + real model id.

            The Settings UI stores both `<prefix>_endpoint_id` and
            `<prefix>_model`; writing only the model leaves the runtime on the
            old endpoint. Prefer cached model lists so this stays fast/offline.
            """
            import json as _json
            import re as _re
            from core.database import ModelEndpoint

            wanted = (model_query or "").strip()
            wanted_slug = _model_slug(wanted)
            wanted_tokens = [_model_slug(t) for t in _re.findall(r"[A-Za-z0-9]+", wanted)]
            wanted_tokens = [t for t in wanted_tokens if t]
            if not wanted_slug:
                return None
            best = None
            for ep in db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True).all():
                raw_models = []
                try:
                    raw_models = _json.loads(ep.cached_models or "[]") or []
                except Exception:
                    raw_models = []
                # If cache is empty, still allow matching against endpoint name
                # for callers using model@endpoint elsewhere later.
                for mid in raw_models:
                    mid = str(mid)
                    mid_slug = _model_slug(mid)
                    if not mid_slug:
                        continue
                    exact = mid.lower() == wanted.lower()
                    compact_match = wanted_slug in mid_slug or mid_slug in wanted_slug
                    token_match = bool(wanted_tokens) and all(tok in mid_slug for tok in wanted_tokens)
                    if exact or compact_match or token_match:
                        score = 3 if exact else (2 if compact_match else 1)
                        if not best or score > best[0]:
                            best = (score, ep.id, mid)
            if best:
                return {"endpoint_id": best[1], "model": best[2]}
            return None

        def _mask(k, v):
            return "••••• (set in panel)" if _is_secret(k) and v else v

        if action == "list":
            s = load_settings()
            shown = {k: _mask(k, v) for k, v in s.items() if k in DEFAULT_SETTINGS and not isinstance(v, dict)}
            return {"response": f"{len(shown)} settings (use get/set with a key)", "settings": shown, "exit_code": 0}

        elif action == "get":
            key = _resolve(args.get("key", ""))
            if not key:
                return {"error": "key is required", "exit_code": 1}
            if key not in DEFAULT_SETTINGS:
                return {"error": f"Unknown setting '{args.get('key')}'. Use action='list' to see them.", "exit_code": 1}
            val = load_settings().get(key, DEFAULT_SETTINGS.get(key))
            return {"response": f"{key} = {_mask(key, val)}", "value": _mask(key, val), "exit_code": 0}

        elif action == "set":
            raw = args.get("key", "")
            value = args.get("value")
            if not raw:
                return {"error": "key is required", "exit_code": 1}
            key = _resolve(raw)
            if key not in DEFAULT_SETTINGS:
                return {"error": f"Unknown setting '{raw}'. Use action='list' to see available settings.", "exit_code": 1}
            if _is_secret(key):
                return {"response": f"'{key}' is a credential/secret — for security I can't set it from chat. Open Settings and set it there.", "exit_code": 0}
            # Structured settings (dicts/lists like keybinds, default_model_fallbacks)
            # have no safe scalar coercion — _coerce would pass a bare string
            # straight through and clobber the structure. Refuse them here; they're
            # edited in their dedicated panels. (reset/delete still restore the
            # default structure, which is safe.)
            if isinstance(DEFAULT_SETTINGS[key], (dict, list)):
                return {"response": f"'{key}' is a structured setting — edit it in its panel, not from chat. (You can reset it to default here.)", "exit_code": 0}
            try:
                value = _coerce(value, DEFAULT_SETTINGS[key])
            except (ValueError, TypeError):
                return {"error": f"'{value}' isn't a valid value for {key} (expected {type(DEFAULT_SETTINGS[key]).__name__}).", "exit_code": 1}
            if key in _ENUMS and str(value).lower() not in _ENUMS[key]:
                return {"error": f"{key} must be one of: {', '.join(_ENUMS[key])}.", "exit_code": 1}
            s = load_settings()
            s[key] = value
            if key in {"default_model", "research_model", "utility_model", "task_model", "vision_model", "image_model"}:
                resolved = _endpoint_model_from_cache(str(value))
                if resolved:
                    prefix = key[:-6]
                    s[f"{prefix}_endpoint_id"] = resolved["endpoint_id"]
                    s[key] = resolved["model"]
                    value = resolved["model"]
            save_settings(s)
            if key.endswith("_model") and s.get(f"{key[:-6]}_endpoint_id"):
                return {"response": f"Set {key} = {value} (endpoint {s.get(f'{key[:-6]}_endpoint_id')}).", "exit_code": 0}
            return {"response": f"Set {key} = {value}.", "exit_code": 0}

        elif action == "delete" or action == "reset":
            key = _resolve(args.get("key", ""))
            if key not in DEFAULT_SETTINGS:
                return {"error": f"Unknown setting '{args.get('key')}'.", "exit_code": 1}
            if _is_secret(key):
                return {"response": f"'{key}' is a credential — reset it in the panel.", "exit_code": 0}
            s = load_settings()
            s[key] = DEFAULT_SETTINGS[key]
            save_settings(s)
            return {"response": f"Reset {key} to default ({DEFAULT_SETTINGS[key]}).", "exit_code": 0}

        elif action in ("disable_tool", "enable_tool", "list_tools"):
            # Tool-toggle actions. These edit settings.json:disabled_tools
            # (the global list read on every chat request) rather than
            # prefs.json. Friendly aliases accepted: "shell" -> "bash",
            # "search" -> "web_search", "browser" -> "builtin_browser",
            # "documents" -> the document tool set, "memory" ->
            # manage_memory, etc.
            from src.settings import get_setting, save_settings, load_settings
            _ALIASES = {
                "shell": ["bash"],
                "terminal": ["bash"],
                "search": ["web_search"],
                "web": ["web_search"],
                "browser": ["builtin_browser"],
                "documents": ["create_document", "edit_document", "update_document", "suggest_document"],
                "doc": ["create_document", "edit_document", "update_document", "suggest_document"],
                "memory": ["manage_memory"],
                "skills": ["manage_skills"],
                "images": ["generate_image"],
                "image": ["generate_image"],
                "tasks": ["manage_tasks"],
                "notes": ["manage_notes"],
                "calendar": ["manage_calendar"],
                "email": ["mcp__email__list_emails", "mcp__email__read_email", "mcp__email__send_email"],
                "research": ["web_search"],  # research is a per-request flag, not a tool — closest analog
            }

            if action == "list_tools":
                current = get_setting("disabled_tools", []) or []
                return {
                    "response": (
                        f"Currently disabled: {', '.join(current) if current else '(none)'}.\n"
                        "Common toggles: shell (bash), search (web_search), browser, documents, "
                        "memory, skills, images, tasks, notes, calendar, email."
                    ),
                    "disabled": list(current),
                    "exit_code": 0,
                }

            tool_name = (args.get("tool") or args.get("name") or "").strip().lower()
            if not tool_name:
                return {"error": "tool name required (e.g. 'shell', 'search', 'bash')", "exit_code": 1}
            targets = _ALIASES.get(tool_name, [tool_name])

            settings = load_settings()
            current = list(settings.get("disabled_tools") or [])
            before = set(current)
            if action == "disable_tool":
                for t in targets:
                    if t not in current:
                        current.append(t)
            else:  # enable_tool
                current = [t for t in current if t not in targets]
            after = set(current)
            settings["disabled_tools"] = current
            save_settings(settings)

            verb = "Disabled" if action == "disable_tool" else "Enabled"
            changed = sorted(after.symmetric_difference(before))
            return {
                "response": (
                    f"{verb} {tool_name} ({', '.join(targets)}). "
                    f"Now disabled: {', '.join(current) if current else '(none)'}."
                ),
                "changed": changed,
                "disabled": list(current),
                "exit_code": 0,
            }

        else:
            return {"error": f"Unknown action: {action}", "exit_code": 1}
    except Exception as e:
        logger.error(f"manage_settings error: {e}")
        return {"error": str(e), "exit_code": 1}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# API call tool
# ---------------------------------------------------------------------------

async def do_api_call(content: str) -> Dict:
    """Execute an API call to a registered integration."""
    from src.integrations import execute_api_call, load_integrations
    try:
        args = json.loads(content)
    except json.JSONDecodeError:
        # Try line-based format: integration\nmethod path\nbody
        lines = content.strip().split("\n")
        args = {"integration": lines[0].strip() if lines else ""}
        if len(lines) > 1:
            parts = lines[1].strip().split(" ", 1)
            args["method"] = parts[0] if parts else "GET"
            args["path"] = parts[1] if len(parts) > 1 else "/"
        if len(lines) > 2:
            try:
                args["body"] = json.loads("\n".join(lines[2:]))
            except json.JSONDecodeError:
                pass

    integration_name = args.get("integration", "")
    integrations = load_integrations()
    intg = next((i for i in integrations if i["id"] == integration_name
                 or i["name"].lower() == integration_name.lower()), None)
    if not intg:
        available = ", ".join(i["name"] for i in integrations if i.get("enabled", True))
        return {"error": f"No integration matching '{integration_name}'. Available: {available or 'none configured'}", "exit_code": 1}

    return await execute_api_call(
        intg["id"],
        args.get("method", "GET"),
        args.get("path", "/"),
        params=args.get("params"),
        body=args.get("body"),
        extra_headers=args.get("headers"),
    )


# ---------------------------------------------------------------------------
# Notes / checklists management tool
# ---------------------------------------------------------------------------

async def do_manage_notes(content: str, owner: Optional[str] = None) -> Dict:
    """Handle manage_notes tool calls: CRUD on notes and checklists."""
    import uuid as _uuid
    from core.database import SessionLocal, Note
    from sqlalchemy.orm.attributes import flag_modified

    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    # Action aliases — match what models actually emit. `create` is the most
    # common alternative to `add`. Hyphenated forms also accepted.
    action = (args.get("action") or "").replace("-", "_").strip().lower()
    _NOTE_ACTION_ALIASES = {
        "create": "add",
        "new": "add",
        "save": "add",
        "remind": "add",
        "remove": "delete",
        "remove_item": "toggle_item",
    }
    action = _NOTE_ACTION_ALIASES.get(action, action)
    db = SessionLocal()

    def _norm_note_title(value: str) -> str:
        text = (value or "").strip().lower()
        text = re.sub(r"^\s*reminder\s*:\s*", "", text)
        return re.sub(r"\s+", " ", text)

    def _note_visible_to_owner(note, owner_value: Optional[str]) -> bool:
        # Empty owner_value is single-user / auth-disabled mode. A real
        # authenticated owner must match exactly; null/empty legacy rows are not
        # shared between accounts.
        if not owner_value:
            return True
        return getattr(note, "owner", None) == owner_value

    def _note_by_prefix(note_id: str):
        if not note_id:
            return None
        q = db.query(Note).filter(Note.id.startswith(note_id))
        if owner:
            q = q.filter(Note.owner == owner)
        return q.first()

    try:
        if action == "list":
            q = db.query(Note)
            if owner is not None:
                q = q.filter(Note.owner == owner)
            if args.get("label"):
                q = q.filter(Note.label == args["label"])
            show_archived = args.get("archived", False)
            q = q.filter(Note.archived == show_archived)
            notes = q.order_by(Note.pinned.desc(), Note.updated_at.desc()).all()
            if not notes:
                return {"response": "No notes found.", "exit_code": 0}
            lines = []
            for n in notes:
                pin = " [PINNED]" if n.pinned else ""
                typ = " [checklist]" if n.note_type == "checklist" else ""
                lbl = f" #{n.label}" if n.label else ""
                title = n.title or "(untitled)"
                lines.append(f"- [{n.id[:8]}] **{title}**{pin}{typ}{lbl}")
                if n.note_type == "checklist" and n.items:
                    try:
                        items = json.loads(n.items)
                        for i, item in enumerate(items):
                            mark = "x" if item.get("done") else " "
                            lines.append(f"  [{mark}] {i}: {item.get('text', '')}")
                    except (json.JSONDecodeError, TypeError):
                        pass
                elif n.content:
                    snippet = n.content[:80].replace("\n", " ")
                    lines.append(f"  {snippet}")
            return {"results": "\n".join(lines)}

        elif action == "add":
            # Accept the various field names models emit: `text` is the most
            # common stand-in for "title or body content" when the model
            # treats the note as a single string. If text was supplied and
            # neither title nor content, use it as the title.
            title = (args.get("title") or "").strip()
            content_raw = args.get("content")
            text_raw = args.get("text") or args.get("body")
            if not title and not content_raw and text_raw:
                title = text_raw.strip()
            elif not content_raw and text_raw:
                content_raw = text_raw
            # Accept both `items` (legacy/internal field) and `checklist_items`
            # (the schema-exposed name used by native function calls). Models
            # following the schema emit `checklist_items`; older code paths
            # and direct API callers still use `items`.
            items_raw = args.get("checklist_items")
            if items_raw is None:
                items_raw = args.get("items")
            items_json = json.dumps(items_raw) if items_raw is not None else None
            note_type = args.get("note_type", "checklist" if items_raw else "note")
            # Accept natural-language due_date ("tomorrow at 1pm") in
            # addition to ISO. Use the user-tz-aware parser so the LLM's
            # naive times ("today at 9pm") are anchored to the USER's clock,
            # not the server's. Returns ISO with explicit offset so frontend
            # `new Date()` resolves the right absolute moment regardless of
            # where the user is.
            due_raw = args.get("due_date")
            due_iso = None
            if due_raw:
                try:
                    from routes.calendar_routes import parse_due_for_user as _pdt_user
                    due_iso = _pdt_user(due_raw)
                except Exception:
                    due_iso = due_raw  # fall through; trust the model
            if due_iso and title:
                # Calendar event reminders are represented as Notes. If the
                # model creates a calendar event with reminder_minutes and then
                # also creates a separate note reminder for the same title/time,
                # keep the existing note so the user gets only one dispatch.
                existing_q = db.query(Note).filter(
                    Note.archived == False,  # noqa: E712
                    Note.due_date == due_iso,
                )
                if owner is not None:
                    existing_q = existing_q.filter(Note.owner == owner)
                target_title = _norm_note_title(title)
                for existing in existing_q.limit(25).all():
                    if _norm_note_title(existing.title or "") == target_title:
                        return {
                            "response": f"Reminder already exists: \"{existing.title or title}\" (id: {existing.id[:8]})",
                            "note_id": existing.id,
                            "duplicate": True,
                            "exit_code": 0,
                        }
            note = Note(
                id=str(_uuid.uuid4()),
                owner=owner,
                title=title,
                content=content_raw,
                items=items_json,
                note_type=note_type,
                color=args.get("color"),
                label=args.get("label"),
                pinned=args.get("pinned", False),
                due_date=due_iso,
                source="agent",
                session_id=args.get("session_id"),
            )
            db.add(note)
            db.commit()
            # Return note_id so the chat-side renderer can build a real
            # "View note" button that opens the notes modal at this id.
            # Previously the create response only included a prose
            # confirmation; the model would type "View note" as a markdown
            # link with no target, leaving the user with a click that
            # did nothing and uncertainty about whether the note was made.
            return {
                "response": f"Note created: \"{title or '(untitled)'}\" (id: {note.id[:8]})",
                "note_id": note.id,
                "note_title": title or "",
                "open_url": f"/#open=notes&note={note.id}",
                "exit_code": 0,
            }

        elif action == "update":
            note_id = args.get("id", "")
            note = _note_by_prefix(note_id)
            if not note:
                return {"error": f"Note '{note_id}' not found", "exit_code": 1}
            if not _note_visible_to_owner(note, owner):
                return {"error": "Note not found", "exit_code": 1}
            for field in ("title", "content", "note_type", "color", "label"):
                if field in args and args[field] is not None:
                    setattr(note, field, args[field])
            # Parse due_date the same way the `add` action does. The schema
            # advertises natural language ("tomorrow at 9am"), and naive ISO
            # strings need the user's tz offset attached so the frontend's
            # `new Date()` resolves the right absolute moment. Storing the raw
            # value here left updated reminders as unparseable literals that
            # never fired.
            if args.get("due_date") is not None:
                due_raw = args["due_date"]
                try:
                    from routes.calendar_routes import parse_due_for_user as _pdt_user
                    note.due_date = _pdt_user(due_raw)
                except Exception:
                    note.due_date = due_raw  # fall through; trust the model
            new_items = args.get("checklist_items")
            if new_items is None:
                new_items = args.get("items")
            if new_items is not None:
                note.items = json.dumps(new_items)
                flag_modified(note, "items")
            if "pinned" in args:
                note.pinned = args["pinned"]
            if "archived" in args:
                note.archived = args["archived"]
            db.commit()
            return {"response": f"Note updated: \"{note.title or '(untitled)'}\"", "exit_code": 0}

        elif action == "delete":
            note_id = args.get("id", "")
            note = _note_by_prefix(note_id)
            if not note:
                return {"error": f"Note '{note_id}' not found", "exit_code": 1}
            if not _note_visible_to_owner(note, owner):
                return {"error": "Note not found", "exit_code": 1}
            title = note.title
            db.delete(note)
            db.commit()
            return {"response": f"Deleted note: \"{title or '(untitled)'}\"", "exit_code": 0}

        elif action == "toggle_item":
            note_id = args.get("id", "")
            index = args.get("index", 0)
            note = _note_by_prefix(note_id)
            if not note:
                return {"error": f"Note '{note_id}' not found", "exit_code": 1}
            if not _note_visible_to_owner(note, owner):
                return {"error": "Note not found", "exit_code": 1}
            if not note.items:
                return {"error": "Note has no checklist items", "exit_code": 1}
            items = json.loads(note.items)
            if index < 0 or index >= len(items):
                return {"error": f"Item index {index} out of range (0-{len(items)-1})", "exit_code": 1}
            items[index]["done"] = not items[index].get("done", False)
            note.items = json.dumps(items)
            flag_modified(note, "items")
            db.commit()
            mark = "done" if items[index]["done"] else "undone"
            return {"response": f"Item '{items[index].get('text', '')}' marked {mark}", "exit_code": 0}

        else:
            return {"error": f"Unknown action: {action}. Use list/add/update/delete/toggle_item", "exit_code": 1}
    except Exception as e:
        logger.error(f"manage_notes error: {e}")
        return {"error": str(e), "exit_code": 1}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Calendar tool — CalDAV-backed event CRUD
# ---------------------------------------------------------------------------

async def do_manage_calendar(content: str, owner: Optional[str] = None) -> Dict:
    """Handle manage_calendar tool calls: list/create/update/delete calendar events (local SQLite)."""
    from datetime import datetime, timedelta
    from core.database import SessionLocal, CalendarCal, CalendarEvent, Note
    from routes.calendar_routes import _ensure_default_calendar, _parse_dt, _parse_dt_pair, parse_due_for_user, _resolve_base_uid
    import uuid as _uuid

    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    # Normalize action — some models emit hyphens ("list-calendars") instead
    # of underscores. Treat them as equivalent so we don't bounce a
    # cosmetic typo back to the model and waste a round-trip. Also accept
    # short forms (`create`, `update`, `delete`) as aliases for the
    # full `<verb>_event` names — models keep emitting the short forms.
    action = (args.get("action") or "list_events").replace("-", "_").strip().lower()
    _ACTION_ALIASES = {
        "create": "create_event",
        "update": "update_event",
        "delete": "delete_event",
        "list": "list_events",
    }
    action = _ACTION_ALIASES.get(action, action)
    db = SessionLocal()

    def _calendar_query():
        q = db.query(CalendarCal)
        if owner is not None:
            q = q.filter(CalendarCal.owner == owner)
        return q

    def _event_query():
        q = db.query(CalendarEvent).join(CalendarCal)
        if owner is not None:
            q = q.filter(CalendarCal.owner == owner)
        return q

    def _reminder_minutes(raw_args) -> Optional[int]:
        raw = (
            raw_args.get("reminder_minutes")
            or raw_args.get("remind_before_minutes")
            or raw_args.get("alarm_minutes")
            or raw_args.get("reminder")
            or raw_args.get("alarm")
        )
        if raw in (None, ""):
            desc = str(raw_args.get("description") or "")
            if re.search(r"\b(remind|reminder|alarm)\b", desc, re.I):
                raw = desc
        if raw in (None, "", False):
            return None
        if raw is True:
            return 10
        if isinstance(raw, (int, float)):
            return max(0, int(raw))
        text = str(raw).strip().lower()
        if text in {"none", "no", "off", "false"}:
            return None
        m = re.search(r"(\d+)\s*(?:m|min|minute|minutes)\b", text)
        if m:
            return max(0, int(m.group(1)))
        m = re.search(r"(\d+)\s*(?:h|hr|hour|hours)\b", text)
        if m:
            return max(0, int(m.group(1)) * 60)
        if text.isdigit():
            return max(0, int(text))
        return None

    def _event_description(raw_args, minutes_before: Optional[int]) -> str:
        desc = str(raw_args.get("description", "") or "")
        if minutes_before is None:
            return desc
        reminder_only = re.compile(
            r"^\s*(?:remind(?:er)?|alarm)\s*:?\s*\d+\s*"
            r"(?:m|min|minute|minutes|h|hr|hour|hours)\b.*$",
            re.I,
        )
        return "" if reminder_only.match(desc) else desc

    def _parse_event_dt(raw: str) -> tuple[datetime, bool]:
        """Parse agent event datetimes in the user's timezone when available."""
        return _parse_dt_pair(parse_due_for_user(raw))

    def _first_nonempty_arg(*names: str):
        for name in names:
            value = args.get(name)
            if value not in (None, ""):
                return value
        return None

    def _create_calendar_reminder(summary: str, location: str, dtstart: datetime,
                                  all_day: bool, minutes_before: int,
                                  is_utc: bool = False) -> tuple[Optional[str], Optional[str]]:
        remind_at = dtstart - timedelta(minutes=minutes_before)
        now = datetime.utcnow() if is_utc else datetime.now()
        if dtstart <= now:
            return None, "event already passed"
        if remind_at <= now:
            # If the requested "before" time already passed but the event is
            # still upcoming, create an immediate Note reminder instead of
            # silently dropping it.
            remind_at = now
        start_fmt = dtstart.strftime("%a %b %d") if all_day else dtstart.strftime("%a %b %d %H:%M")
        loc = f" @ {location}" if location else ""
        text = f"{summary}{loc} — {start_fmt}"
        due_date = remind_at.isoformat() + ("Z" if is_utc else "")
        expected_title = f"Reminder: {summary}"
        existing_q = db.query(Note).filter(
            Note.archived == False,  # noqa: E712
            Note.due_date == due_date,
        )
        if owner is not None:
            existing_q = existing_q.filter(Note.owner == owner)
        target_title = re.sub(r"^\s*reminder\s*:\s*", "", expected_title.strip().lower())
        for existing in existing_q.limit(25).all():
            existing_title = re.sub(r"^\s*reminder\s*:\s*", "", (existing.title or "").strip().lower())
            if existing_title == target_title:
                return existing.id, "duplicate reminder already exists"
        note = Note(
            id=str(_uuid.uuid4()),
            owner=owner,
            title=expected_title,
            items=json.dumps([{"text": text, "done": False, "checked": False}]),
            note_type="todo",
            label="calendar",
            due_date=due_date,
            source="calendar",
        )
        db.add(note)
        return note.id, None

    try:
        if action == "list_calendars":
            _ensure_default_calendar(db, owner)
            cals = _calendar_query().all()
            result = [{"name": c.name, "href": c.id} for c in cals]
            if result:
                lines = [f"Found {len(result)} calendar(s):"]
                for c in result:
                    lines.append(f"- {c['name']} ({c['href'][:8]})")
                response_text = "\n".join(lines)
            else:
                response_text = "No calendars found."
            return {"response": response_text, "calendars": result, "exit_code": 0}

        elif action == "list_events":
            try:
                start_raw = _first_nonempty_arg(
                    "start", "start_date", "range_start", "from", "dtstart", "since"
                )
                end_raw = _first_nonempty_arg(
                    "end", "end_date", "range_end", "to", "dtend", "until"
                )
                if start_raw:
                    start_dt = _parse_dt(start_raw)
                else:
                    start_dt = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
                if end_raw:
                    end_dt = _parse_dt(end_raw)
                else:
                    end_dt = start_dt + timedelta(days=14)
            except ValueError as e:
                return {"error": f"Invalid date format: {e}", "exit_code": 1}

            q = _event_query().filter(
                CalendarEvent.dtstart < end_dt,
                CalendarEvent.dtend > start_dt,
                CalendarEvent.status != "cancelled",
            )
            calendar_filter = args.get("calendar")
            if calendar_filter:
                q = q.filter(
                    (CalendarEvent.calendar_id == calendar_filter) |
                    (CalendarCal.name == calendar_filter)
                )
            rows = q.order_by(CalendarEvent.dtstart).all()
            events = []
            for ev in rows:
                if ev.all_day:
                    s, e = ev.dtstart.strftime("%Y-%m-%d"), ev.dtend.strftime("%Y-%m-%d")
                else:
                    suffix = "Z" if getattr(ev, "is_utc", False) else ""
                    s, e = ev.dtstart.isoformat() + suffix, ev.dtend.isoformat() + suffix
                events.append({
                    "uid": ev.uid, "summary": ev.summary or "", "dtstart": s, "dtend": e,
                    "all_day": ev.all_day, "description": ev.description or "",
                    "location": ev.location or "",
                    "calendar": ev.calendar.name if ev.calendar else "",
                    "calendar_href": ev.calendar_id,
                    "event_type": ev.event_type or "",
                    "importance": ev.importance or "normal",
                })
            if not events:
                response_text = f"No events between {start_dt.date().isoformat()} and {end_dt.date().isoformat()}."
            else:
                lines = [f"Found {len(events)} event(s) between {start_dt.date().isoformat()} and {end_dt.date().isoformat()}:"]
                for ev in events:
                    when = ev["dtstart"]
                    when_str = f"{when} (all day)" if ev.get("all_day") else f"{when} -> {ev.get('dtend', '')}"
                    # Clickable anchor — opens the calendar on the event's day.
                    line = f"- {when_str}: [{ev['summary']}](#event-{ev['uid']})"
                    if ev.get("event_type"):
                        line += f" #{ev['event_type']}"
                    if ev.get("importance") and ev["importance"] != "normal":
                        line += f" !{ev['importance']}"
                    if ev.get("location"):
                        line += f" @ {ev['location']}"
                    if ev.get("calendar"):
                        line += f" ({ev['calendar']})"
                    if ev.get("description"):
                        desc = ev["description"].strip().replace("\n", " ")
                        if len(desc) > 120:
                            desc = desc[:117] + "..."
                        line += f"\n    {desc}"
                    lines.append(line)
                response_text = "\n".join(lines)
            return {"response": response_text, "events": events, "exit_code": 0}

        elif action == "create_event":
            summary = args.get("summary")
            # Accept the various names models like to use for the start
            # field: dtstart (canonical), start, start_time, when.
            dtstart_str = (args.get("dtstart") or args.get("start")
                           or args.get("start_time") or args.get("when"))
            if not summary or not dtstart_str:
                return {"error": "summary and dtstart are required", "exit_code": 1}

            # Accept either an href OR a calendar name/short-id like "Main"
            # or "62e545d8" — saves the model from having to memorize hrefs
            # after a `list_calendars` call returned short prefixes.
            cal_href = args.get("calendar_href") or args.get("calendar")
            cal = None
            if cal_href:
                cal = (_calendar_query()
                       .filter(CalendarCal.id == cal_href)
                       .first())
                if not cal:
                    # Try by name (case-insensitive) or by short-id prefix
                    cal = (_calendar_query()
                           .filter(CalendarCal.name.ilike(cal_href))
                           .first())
                if not cal:
                    cal = (_calendar_query()
                           .filter(CalendarCal.id.like(f"{cal_href}%"))
                           .first())
            if not cal:
                cal = _ensure_default_calendar(db, owner)

            all_day = bool(args.get("all_day", False))
            try:
                dtstart, dtstart_is_utc = _parse_event_dt(dtstart_str)
            except ValueError as e:
                return {"error": f"Could not parse dtstart {dtstart_str!r}: {e}", "exit_code": 1}
            dtend_raw = args.get("dtend") or args.get("end") or args.get("end_time")
            if dtend_raw:
                try:
                    dtend, dtend_is_utc = _parse_event_dt(dtend_raw)
                    dtstart_is_utc = dtstart_is_utc or dtend_is_utc
                except ValueError as e:
                    return {"error": f"Could not parse dtend {dtend_raw!r}: {e}", "exit_code": 1}
            else:
                # Support duration: "1h", "30m", "90min", "1hr30m"
                dur = (args.get("duration") or "").strip().lower()
                delta = None
                if dur:
                    import re as _re_d
                    h = _re_d.search(r'(\d+)\s*(?:h|hr|hours?)', dur)
                    m = _re_d.search(r'(\d+)\s*(?:m|min|minutes?)', dur)
                    secs = (int(h.group(1)) * 3600 if h else 0) + (int(m.group(1)) * 60 if m else 0)
                    if secs > 0:
                        delta = timedelta(seconds=secs)
                if delta is not None:
                    dtend = dtstart + delta
                elif all_day:
                    dtend = dtstart + timedelta(days=1)
                else:
                    dtend = dtstart + timedelta(hours=1)

            # Dedup: if a non-cancelled event with the same title + start time already
            # exists, return its UID instead of creating a fresh copy. Prevents the
            # email triage from multiplying events when several emails reference the
            # same meeting. Compare case-insensitively since LLM-extracted titles
            # can vary in capitalisation.
            from sqlalchemy import func as _func
            existing = (
                _event_query()
                .filter(
                    CalendarEvent.dtstart == dtstart,
                    CalendarEvent.status != "cancelled",
                    _func.lower(CalendarEvent.summary) == summary.lower(),
                )
                .first()
            )
            if existing is not None:
                reminder_note_id = None
                reminder_skipped_reason = None
                minutes_before = _reminder_minutes(args)
                if minutes_before is not None:
                    reminder_note_id, reminder_skipped_reason = _create_calendar_reminder(
                        existing.summary or summary,
                        existing.location or "",
                        existing.dtstart,
                        existing.all_day,
                        minutes_before,
                        bool(existing.is_utc),
                    )
                    if reminder_note_id:
                        db.commit()
                reminder_text = ""
                if minutes_before is not None:
                    reminder_text = (
                        f"; reminder set {minutes_before} min before"
                        if reminder_note_id
                        else f"; reminder not set ({reminder_skipped_reason or 'reminder time already passed'})"
                    )
                return {
                    "response": (
                        f"Event already exists: '{summary}' on {dtstart_str}"
                        + reminder_text
                    ),
                    "uid": existing.uid,
                    "reminder_note_id": reminder_note_id,
                    "reminder_skipped_reason": reminder_skipped_reason,
                    "duplicate": True,
                    "exit_code": 0,
                }

            # Optional tag/category and importance — friendly aliases.
            event_type = (args.get("event_type") or args.get("tag")
                          or args.get("category") or args.get("type") or "") or None
            importance = args.get("importance") or "normal"
            minutes_before = _reminder_minutes(args)

            uid = str(_uuid.uuid4())
            ev = CalendarEvent(
                uid=uid, calendar_id=cal.id, summary=summary,
                description=_event_description(args, minutes_before),
                location=args.get("location", "") or "",
                dtstart=dtstart, dtend=dtend, all_day=all_day,
                is_utc=dtstart_is_utc and not all_day,
                rrule=args.get("rrule", "") or "",
                event_type=event_type,
                importance=importance,
            )
            db.add(ev)
            reminder_note_id = None
            reminder_skipped_reason = None
            if minutes_before is not None:
                reminder_note_id, reminder_skipped_reason = _create_calendar_reminder(
                    summary,
                    args.get("location", "") or "",
                    dtstart,
                    all_day,
                    minutes_before,
                    dtstart_is_utc and not all_day,
                )
            db.commit()
            tag_blurb = f" [{event_type}]" if event_type else ""
            if minutes_before is None:
                reminder_blurb = ""
            elif reminder_note_id:
                reminder_blurb = f" with reminder {minutes_before} min before"
            else:
                reminder_blurb = f" without reminder ({reminder_skipped_reason or 'reminder time already passed'})"
            # Return a clickable anchor so the agent can surface a link
            # that opens the calendar on that day. See the markdown
            # anchor convention ([Name](#event-<uid>)).
            return {
                "response": f"Created event [{summary}](#event-{uid}){tag_blurb} on {dtstart_str}{reminder_blurb}",
                "uid": uid,
                "anchor": f"[{summary}](#event-{uid})",
                "reminder_note_id": reminder_note_id,
                "reminder_skipped_reason": reminder_skipped_reason,
                "exit_code": 0,
            }

        elif action == "update_event":
            uid = args.get("uid")
            if not uid:
                return {"error": "uid is required", "exit_code": 1}
            try:
                base_uid = _resolve_base_uid(uid)
            except ValueError as e:
                return {"error": str(e), "exit_code": 1}
            ev = _event_query().filter(CalendarEvent.uid == base_uid).first()
            if not ev:
                return {"error": f"Event {uid} not found", "exit_code": 1}
            if args.get("summary") is not None:
                ev.summary = args["summary"]
            if args.get("description") is not None:
                ev.description = args["description"]
            if args.get("location") is not None:
                ev.location = args["location"]
            if args.get("dtstart") is not None:
                # Anchor naive/natural-language input to the USER's timezone and
                # refresh is_utc, exactly like create_event. Parsing with the
                # raw server-local _parse_dt here (and never touching is_utc)
                # silently shifted an updated event by the user's UTC offset.
                _eff_all_day = (
                    args["all_day"] if args.get("all_day") is not None else ev.all_day
                )
                ev.dtstart, _su = _parse_event_dt(args["dtstart"])
                ev.is_utc = bool(_su and not _eff_all_day)
            if args.get("dtend") is not None:
                ev.dtend, _eu = _parse_event_dt(args["dtend"])
            if args.get("all_day") is not None:
                ev.all_day = args["all_day"]
            # Tag/category + importance updates (any of these aliases).
            _tag = (args.get("event_type") or args.get("tag")
                    or args.get("category") or args.get("type"))
            if _tag is not None:
                ev.event_type = _tag or None
            if args.get("importance") is not None:
                ev.importance = args["importance"]
            db.commit()
            return {"response": f"Updated event {uid}", "exit_code": 0}

        elif action == "delete_event":
            uid = args.get("uid")
            if not uid:
                return {"error": "uid is required", "exit_code": 1}
            try:
                base_uid = _resolve_base_uid(uid)
            except ValueError as e:
                return {"error": str(e), "exit_code": 1}
            ev = _event_query().filter(CalendarEvent.uid == base_uid).first()
            if not ev:
                return {"error": f"Event {uid} not found", "exit_code": 1}
            db.delete(ev)
            db.commit()
            return {"response": f"Deleted event {uid}", "exit_code": 0}

        else:
            return {
                "error": f"Unknown action: {action}. Use list_events, create_event, update_event, delete_event, list_calendars",
                "exit_code": 1,
            }

    except Exception as e:
        db.rollback()
        logger.error(f"manage_calendar error: {e}")
        return {"error": str(e), "exit_code": 1}
    finally:
        db.close()


# ── Cookbook tools ──

# In-process loopback base for agent tools that call Orwell's own API
# (cookbook state, model serve, gallery, email, calendar). We ride the
# per-process internal token so require_admin lets us through. See
# core/middleware.py. Resolution (override / APP_PORT / 7000) lives in
# core.constants.internal_api_base().
_INTERNAL_BASE = internal_api_base()


def _internal_headers(owner: Optional[str] = None) -> Dict[str, str]:
    from core.middleware import INTERNAL_TOOL_HEADER, INTERNAL_TOOL_TOKEN
    headers = {INTERNAL_TOOL_HEADER: INTERNAL_TOOL_TOKEN}
    if owner:
        headers["X-Orwell-Owner"] = owner
    return headers


async def _cookbook_servers() -> Dict[str, Any]:
    """Return the cookbook's configured servers + the currently-selected
    default host. Shape: {default_host, hosts: [{host, platform, env, envPath}]}.
    The agent uses this to route downloads/serves to the right machine
    instead of silently defaulting to localhost."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{_INTERNAL_BASE}/api/cookbook/state", headers=_internal_headers())
            state = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    except Exception:
        return {"default_host": "", "hosts": []}
    env = (state or {}).get("env") or {}
    if not isinstance(env, dict):
        return {"default_host": "", "hosts": []}
    hosts = []
    for s in (env.get("servers") or []):
        if isinstance(s, dict):
            hosts.append({
                "name": s.get("name") or "",
                "host": s.get("host") or "",   # "" = Local
                "platform": s.get("platform") or "",
                "env": s.get("env") or "",
                "envPath": s.get("envPath") or "",
                "port": s.get("port") or "",
            })
    return {"default_host": env.get("remoteHost") or "", "hosts": hosts}


async def _resolve_cookbook_host(name_or_host: str) -> str:
    """Map a friendly server NAME ('gpu-box', 'workstation') to its ssh host
    string ('user@192.0.2.10'). If the input already looks like an
    ssh host (contains '@' or matches a known host), or matches nothing,
    it's returned unchanged. 'local'/'localhost' → '' (this machine)."""
    if not name_or_host:
        return ""
    val = name_or_host.strip()
    low = val.lower()
    if low in ("local", "localhost", "this machine", "here"):
        return ""
    servers = await _cookbook_servers()
    # Exact host match → already an ssh host
    for h in servers.get("hosts") or []:
        if h.get("host") and h["host"] == val:
            return val
    # Name match (case-insensitive)
    for h in servers.get("hosts") or []:
        if (h.get("name") or "").lower() == low:
            return h.get("host") or ""   # "" for the Local entry
    # Substring name match as a fallback
    for h in servers.get("hosts") or []:
        if low and low in (h.get("name") or "").lower():
            return h.get("host") or ""
    # No match — assume the caller passed a raw host/alias; return as-is
    # (ssh can resolve aliases from ~/.ssh/config).
    return val


async def _cookbook_env_for_host(host: str) -> Dict[str, Any]:
    """Resolve env_prefix / gpus / platform / hf_token / ssh_port for a
    given host by looking it up in cookbook_state.env. The user
    configures these per-host in the Cookbook UI; without them, raw
    `vllm serve …` fails with 'command not found' because vLLM lives
    inside a venv that has to be sourced first.

    Returns a dict with keys ready to drop into the /api/model/serve
    payload: env_prefix, gpus, platform, hf_token, ssh_port.
    Falls back to the top-level env settings if no per-host entry exists.
    """
    import httpx
    headers = _internal_headers()
    state: Dict[str, Any] = {}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{_INTERNAL_BASE}/api/cookbook/state", headers=headers)
            state = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    except Exception as e:
        logger.debug(f"cookbook env lookup failed for host={host!r}: {e}")
        return {}
    if not isinstance(state, dict):
        return {}
    env_root = state.get("env") or {}
    if not isinstance(env_root, dict):
        return {}

    # Per-host entry takes precedence over top-level.
    per_host: Dict[str, Any] = {}
    for s in (env_root.get("servers") or []):
        if isinstance(s, dict) and (s.get("host") or "") == (host or ""):
            per_host = s
            break

    env_kind = per_host.get("env") or env_root.get("env") or "none"
    env_path = per_host.get("envPath") or env_root.get("envPath") or ""
    platform = per_host.get("platform") or env_root.get("platform") or "linux"
    ssh_port = per_host.get("sshPort") or env_root.get("sshPort") or ""

    env_prefix = ""
    if env_kind == "venv" and env_path:
        if platform == "windows":
            activate = env_path if env_path.endswith("\\Scripts\\Activate.ps1") else env_path.rstrip("\\") + "\\Scripts\\Activate.ps1"
            env_prefix = f"& {activate}"
        else:
            activate = env_path if env_path.endswith("/bin/activate") else env_path.rstrip("/") + "/bin/activate"
            env_prefix = f"source {activate}"
    elif env_kind == "conda" and env_path:
        if platform == "windows":
            env_prefix = f"conda activate {env_path}"
        else:
            env_prefix = f'eval "$(conda shell.bash hook)" && conda activate {env_path}'

    return {
        "env_prefix": env_prefix,
        "env_type": env_kind,
        "env_path": env_path,
        "gpus": env_root.get("gpus") or "",
        "platform": platform,
        "hf_token": env_root.get("hfToken") or "",
        "ssh_port": ssh_port,
    }


async def _cookbook_register_task(session_id: str, model: str, host: str,
                                  cmd: str, task_type: str = "serve") -> bool:
    """Append a task entry to cookbook_state.json after the agent
    launches via /api/model/serve or /api/model/download. The route
    spawns tmux but leaves state-writing to the UI; the agent needs to
    do that here so the task shows up in the Cookbook tab.
    Returns True on success, False if the write failed (best-effort)."""
    import httpx
    import time as _time
    headers = _internal_headers()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{_INTERNAL_BASE}/api/cookbook/state", headers=headers)
            state = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    except Exception as e:
        logger.debug(f"cookbook state read failed: {e}")
        return False
    if not isinstance(state, dict):
        state = {}
    tasks = state.get("tasks") if isinstance(state.get("tasks"), list) else []
    # Skip duplicate (same session_id) entries
    if any(isinstance(t, dict) and t.get("sessionId") == session_id for t in tasks):
        return True
    display_name = model.split("/")[-1] if "/" in model else model
    # Placeholder output — the cookbook UI's CSS hides empty <pre>
    # via `.cookbook-output-pre:empty { display: none }`, so an
    # empty-string output makes the expansion appear broken until the
    # frontend's reconnect-polling loop captures tmux output. A short
    # placeholder gives the user something to see immediately; it gets
    # replaced by real tmux output within a few seconds.
    target = f"{host}:" if host else "local:"
    placeholder = (
        f"Launched via agent — waiting for tmux output…\n"
        f"  session: {session_id}\n"
        f"  target:  {target}{(cmd.split() or [''])[0] if cmd else ''}\n"
        f"  cmd:     {cmd[:200]}{'…' if len(cmd) > 200 else ''}"
    )
    tasks.append({
        "id": session_id,
        "sessionId": session_id,
        "name": display_name,
        "modelId": model,
        "type": task_type,
        "status": "running",
        "output": placeholder,
        "ts": int(_time.time() * 1000),
        "payload": {"repo_id": model, "remote_host": host or "", "_cmd": cmd},
        "remoteHost": host or "",
        "sshPort": "",
        "platform": "linux",
        "_serveReady": False,
        "_endpointAdded": False,
    })
    state["tasks"] = tasks
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(f"{_INTERNAL_BASE}/api/cookbook/state",
                                  json=state, headers=headers)
        return r.status_code < 400
    except Exception as e:
        logger.debug(f"cookbook state write failed: {e}")
        return False


# Paths the generic `app_api` tool will refuse to call. Auth/token/user
# administration and host shell execution are too risky to route through an
# agent surface even when the agent is admin-context; accidental account or
# command mistakes have permanent blast radius.
_APP_API_BLOCKLIST_PREFIXES = (
    "/api/auth",           # login/logout/password
    "/api/users",          # user CRUD (bare /api/users list+create+delete must also block)
    "/api/tokens",         # api token mgmt (bare /api/tokens list+create must also block)
    "/api/admin",          # admin one-shots (wipe etc.)
    "/api/shell",          # host shell execution must stay behind named command tooling
    "/api/backup/restore", # destructive restore
)

# (method, prefix) pairs to refuse specifically. Used for endpoints
# where GET is fine but writes are destructive or host-control shaped.
# Saw the agent wipe cookbook_state.json (presets + tasks) by POSTing
# {"tasks": []} to /api/cookbook/state, which overwrote the whole file.
# Use dedicated tools or UI flows instead.
_APP_API_BLOCKLIST_METHOD_PATH = (
    ("GET",    "/api/email/accounts"),  # owner-filtered in tool context; use list_email_accounts MCP tool
    ("POST",   "/api/cookbook/state"),   # whole-file overwrite — agent must use serve_preset/serve_model instead
    ("DELETE", "/api/cookbook/state"),
    # Host-control routes: package install, engine rebuild, and process
    # signalling should not be reachable through the generic API bridge.
    ("POST",   "/api/cookbook/packages/install"),
    ("POST",   "/api/cookbook/rebuild-engine"),
    ("POST",   "/api/cookbook/kill-pid"),
    # Use the named tools (download_model / serve_model) — they handle
    # host-name resolution, per-host env_prefix, AND register the task
    # in cookbook state so it shows in the UI + list_downloads. Hitting
    # the raw endpoint via app_api skips all of that → orphan task.
    ("POST",   "/api/model/download"),
    ("POST",   "/api/model/serve"),
    # Use trigger_research — it returns a UI hint so the Deep Research
    # sidebar surfaces the session. Raw start works but the agent
    # fumbles the payload + the session doesn't reliably show up.
    ("POST",   "/api/research/start"),
    # Use the named tools — they handle owner attribution, natural-
    # language due_date parsing, timezone, dedup, and tag/category
    # normalization. Hitting the raw endpoint via app_api saves a
    # note/event with the wrong fields, no reminder, or the wrong tz.
    ("POST",   "/api/notes"),
    ("PUT",    "/api/notes"),
    ("DELETE", "/api/notes"),
    ("POST",   "/api/calendar/events"),
    ("PUT",    "/api/calendar/events"),
    ("DELETE", "/api/calendar/events"),
)


async def do_app_api(content: str, owner: Optional[str] = None) -> Dict:
    """Generic loopback to allowed internal Orwell API endpoints. Lets the
    agent reach the full UI-button surface (cookbook, email, notes,
    calendar, skills, sessions, gallery, research, etc.) without us
    landing a named tool wrapper for every one.

    Args (JSON):
      action: "call" (default) | "endpoints"
      path:   "/api/cookbook/gpus"     # required for call
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" (default GET)
      body:   <object>                 # JSON body for POST/PUT/PATCH
      query:  <object>                 # querystring params

    The `endpoints` action returns the OpenAPI surface (method + path +
    summary) so the agent can discover what's reachable. A blocklist
    refuses sensitive auth/user/admin/shell paths and method-specific
    host-control routes to keep blast radius bounded.
    """
    import httpx
    try:
        args = _parse_tool_args(content) if content.strip() else {}
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    action = (args.get("action") or "call").lower()
    base = _INTERNAL_BASE

    if action == "endpoints":
        # Fetch FastAPI's OpenAPI schema so the agent can discover any
        # endpoint without us pre-listing them. Filter by an optional
        # `filter` keyword (substring match on path or summary).
        kw = (args.get("filter") or "").lower()
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(f"{base}/openapi.json",
                                        headers=_internal_headers())
                data = resp.json()
        except Exception as e:
            return {"error": f"OpenAPI fetch failed: {e}", "exit_code": 1}
        rows: List[Dict[str, Any]] = []
        for path, methods in (data.get("paths") or {}).items():
            if not isinstance(methods, dict):
                continue
            if any(path.startswith(p) for p in _APP_API_BLOCKLIST_PREFIXES):
                continue
            for method, op in methods.items():
                if method.lower() not in ("get", "post", "put", "patch", "delete"):
                    continue
                if any(method.upper() == m and path.startswith(p) for m, p in _APP_API_BLOCKLIST_METHOD_PATH):
                    continue
                summary = (op or {}).get("summary") or (op or {}).get("description") or ""
                if isinstance(summary, str):
                    summary = summary.strip().split("\n")[0][:140]
                if kw and kw not in path.lower() and kw not in (summary or "").lower():
                    continue
                rows.append({"method": method.upper(), "path": path, "summary": summary})
        rows.sort(key=lambda r: (r["path"], r["method"]))
        if not rows:
            return {"output": f"No endpoints match filter {kw!r}." if kw else "No endpoints found.", "exit_code": 0}
        lines = [f"{len(rows)} endpoint(s)" + (f" matching {kw!r}" if kw else "") + ":"]
        for r in rows[:200]:
            line = f"  {r['method']:6s} {r['path']}"
            if r["summary"]:
                line += f"  — {r['summary']}"
            lines.append(line)
        if len(rows) > 200:
            lines.append(f"  ...({len(rows) - 200} more — filter to narrow)")
        return {"output": "\n".join(lines), "endpoints": rows, "exit_code": 0}

    # action == "call"
    path = args.get("path") or ""
    if not path:
        return {"error": "path is required (e.g. '/api/cookbook/gpus')", "exit_code": 1}
    if not path.startswith("/"):
        path = "/" + path
    if any(path.startswith(p) for p in _APP_API_BLOCKLIST_PREFIXES):
        return {"error": f"Path blocked for safety: {path}. Sensitive endpoints are off-limits via app_api.", "exit_code": 1}

    method = (args.get("method") or "GET").upper()
    if method not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
        return {"error": f"Unsupported method: {method}", "exit_code": 1}
    if any(method == m and path.startswith(p) for m, p in _APP_API_BLOCKLIST_METHOD_PATH):
        if "/api/email/accounts" in path:
            return {"error": "Don't use /api/email/accounts via app_api — it is owner-filtered in tool context and may return empty. Use the `list_email_accounts` email tool, then pass `account` to list_emails/read_email.", "exit_code": 1}
        if "/api/cookbook/packages/install" in path:
            return {"error": "Don't POST /api/cookbook/packages/install via app_api — package installation is host code execution. Use the dedicated Cookbook dependency UI/flow instead.", "exit_code": 1}
        if "/api/cookbook/rebuild-engine" in path:
            return {"error": "Don't POST /api/cookbook/rebuild-engine via app_api — engine rebuild mutates local or remote host state. Use the dedicated Cookbook UI/flow instead.", "exit_code": 1}
        if "/api/cookbook/kill-pid" in path:
            return {"error": "Don't POST /api/cookbook/kill-pid via app_api — process signalling is host control. Use the dedicated Cookbook stop/diagnostic flow instead.", "exit_code": 1}
        if "/api/model/download" in path:
            return {"error": "Don't POST /api/model/download directly — use the `download_model` tool (it resolves the server name, sets the venv env_prefix, and registers the task so it shows in the UI).", "exit_code": 1}
        if "/api/model/serve" in path:
            return {"error": "Don't POST /api/model/serve directly — use the `serve_model` or `serve_preset` tool (handles host resolution, env_prefix, and cookbook tracking).", "exit_code": 1}
        if "/api/research/start" in path:
            return {"error": "Don't POST /api/research/start directly — use the `trigger_research` tool (it surfaces the session in the Deep Research sidebar).", "exit_code": 1}
        if "/api/notes" in path:
            return {"error": "Don't hit /api/notes via app_api — use the `manage_notes` tool. It accepts natural-language due_date ('11pm today', 'tomorrow at 9am'), fires reminders from the due_date itself (no separate calendar event), and uses the caller's timezone. The raw endpoint requires ISO-UTC + a separate calendar event, both of which the agent tends to get wrong.", "exit_code": 1}
        if "/api/calendar/events" in path:
            return {"error": "Don't hit /api/calendar/events via app_api — use the `manage_calendar` tool. It handles tz-aware natural-language datetimes and reminder_minutes correctly. If the user wants a note + reminder, prefer `manage_notes` with due_date — it bundles both.", "exit_code": 1}
        return {"error": f"{method} {path} is blocked — it overwrites the whole cookbook state file. Use list_serve_presets / serve_preset / serve_model instead.", "exit_code": 1}

    body = args.get("body")
    query = args.get("query") or None
    # Pass owner so the backend impersonates the user — without this,
    # POSTs (notes, calendar, todos, ...) get owner="internal-tool"
    # and the user that asked for them can't see the result.
    headers = {**_internal_headers(owner=owner), "Content-Type": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.request(
                method, f"{base}{path}",
                json=body if body is not None and method in ("POST", "PUT", "PATCH") else None,
                params=query,
                headers=headers,
            )
        # Try to parse JSON; fall back to raw text.
        try:
            payload = resp.json()
            preview = json.dumps(payload, indent=2, default=str)
            if len(preview) > 4000:
                preview = preview[:4000] + "\n... (truncated)"
        except Exception:
            payload = None
            preview = (resp.text or "")[:4000]
        if resp.status_code >= 400:
            return {
                "error": f"{method} {path} -> HTTP {resp.status_code}",
                "status_code": resp.status_code,
                "body": preview,
                "exit_code": 1,
            }
        return {
            "output": f"{method} {path} -> {resp.status_code}\n{preview}",
            "status_code": resp.status_code,
            "json": payload,
            "exit_code": 0,
        }
    except Exception as e:
        return {"error": f"{method} {path} failed: {e}", "exit_code": 1}


# Patterns for detecting running LLM/diffusion model servers outside
# the cookbook's task tracker. Each entry: (label, substring-list).
# Match is case-insensitive against the FULL cmdline. First-match wins.
_MODEL_PROCESS_PATTERNS = [
    ("vLLM",            ["vllm.entrypoints", "vllm serve", "/vllm/", "vllm-openai"]),
    ("SGLang",          ["sglang.launch_server", "sglang/launch_server"]),
    ("llama.cpp",       ["llama-server", "llama_cpp_server", "llamacppserver"]),
    ("Ollama",          ["ollama serve", "ollama runner", "/ollama "]),
    ("ComfyUI",         ["comfyui/main.py", "/ComfyUI/main.py", "ComfyUI"]),
    ("A1111 WebUI",     ["stable-diffusion-webui/webui", "stable-diffusion-webui/launch", "webui.sh"]),
    ("Fooocus",         ["Fooocus/entry_with_update", "Fooocus/launch"]),
    ("InvokeAI",        ["invokeai-web", "invokeai.app", "invokeai/api_app"]),
    ("Forge WebUI",     ["stable-diffusion-webui-forge", "forge/webui"]),
    ("SD.Next",         ["automatic/webui", "sd.next"]),
    ("TGI",             ["text-generation-launcher", "text_generation_launcher"]),
    ("Aphrodite",       ["aphrodite.endpoints", "aphrodite-engine"]),
    ("Triton",          ["tritonserver", "triton/main"]),
    ("Diffusers",       ["diffusers.pipelines", "StableDiffusionInpaintPipeline", "DiffusionPipeline"]),
]


def _cookbook_apply_retry_suggestion(cmd: str, suggestion: Dict[str, Any]) -> str:
    """Apply a structured Cookbook diagnosis suggestion to a serve command."""
    if not cmd or not suggestion:
        return cmd
    op = suggestion.get("op")
    if op == "append":
        arg = (suggestion.get("arg") or "").strip()
        if not arg or arg in cmd:
            return cmd
        return f"{cmd.rstrip()} {arg}"
    if op == "remove":
        flag = (suggestion.get("flag") or "").strip()
        if not flag:
            return cmd
        return re.sub(rf"\s*{re.escape(flag)}(?:\s+\S+)?", "", cmd).strip()
    if op == "replace":
        flag = (suggestion.get("flag") or "").strip()
        value = str(suggestion.get("value") or "").strip()
        if not flag or not value:
            return cmd
        repl = f"{flag} {value}"
        if re.search(rf"(^|\s){re.escape(flag)}(\s+\S+)?", cmd):
            return re.sub(rf"(^|\s){re.escape(flag)}(?:\s+\S+)?", lambda m: (m.group(1) or " ") + repl, cmd).strip()
        return f"{cmd.rstrip()} {repl}"
    return cmd


def _scan_running_model_processes() -> List[Dict[str, Any]]:
    """Scan /proc for running model server processes. Linux-only; returns
    [] on other platforms or if /proc isn't accessible. Each match returns
    a dict shaped like a cookbook task so the caller can merge cleanly.
    """
    import os
    if not os.path.isdir("/proc"):
        return []
    out: List[Dict[str, Any]] = []
    seen_keys = set()
    try:
        for pid_dir in os.listdir("/proc"):
            if not pid_dir.isdigit():
                continue
            try:
                with open(f"/proc/{pid_dir}/cmdline", "rb") as f:
                    raw = f.read()
            except (OSError, PermissionError):
                continue
            if not raw:
                continue
            # cmdline is NUL-separated; join with spaces for matching/display
            cmdline = raw.replace(b"\x00", b" ").decode("utf-8", errors="replace").strip()
            if not cmdline:
                continue
            lower = cmdline.lower()
            for label, needles in _MODEL_PROCESS_PATTERNS:
                if any(n.lower() in lower for n in needles):
                    # Dedupe by (label, first-arg) — multi-worker servers
                    # spawn N processes; only show one row per server.
                    key = (label, cmdline.split(" ")[0])
                    if key in seen_keys:
                        break
                    seen_keys.add(key)
                    # Try to pluck a model name out of the cmdline.
                    model = ""
                    for tok in cmdline.split():
                        if "/" in tok and any(s in tok.lower() for s in (
                            "model", "checkpoint", ".safetensors", ".gguf", ".bin", "huggingface"
                        )):
                            model = tok
                            break
                    out.append({
                        "session_id": f"pid-{pid_dir}",
                        "model": model or label,
                        "phase": "running (external)",
                        "type": "serve",
                        "remote": "local",
                        "pid": int(pid_dir),
                        "label": label,
                        "cmdline_preview": cmdline[:140] + ("…" if len(cmdline) > 140 else ""),
                        "external": True,
                    })
                    break
    except Exception as e:
        logger.debug(f"_scan_running_model_processes failed: {e}")
    return out


async def do_download_model(content: str, owner: Optional[str] = None) -> Dict:
    """Download a HuggingFace model via the cookbook API."""
    import httpx
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    repo_id = args.get("repo_id", "")
    if not repo_id:
        return {"error": "repo_id is required", "exit_code": 1}
    host = (args.get("host") or "").strip()
    # Resolve a friendly server NAME ("gpu-box") to its ssh host string.
    if host:
        host = await _resolve_cookbook_host(host)
    # No host specified → default to the cookbook's currently-selected
    # server rather than silently downloading to localhost (which is
    # usually NOT where the GPUs / model cache live).
    _host_defaulted = False
    if not host and not args.get("local"):
        _servers = await _cookbook_servers()
        if _servers.get("default_host"):
            host = _servers["default_host"]
            _host_defaulted = True
    payload = {"repo_id": repo_id}
    if host:
        payload["remote_host"] = host
    if args.get("include"):
        payload["include"] = args["include"]
    # Per-host env_prefix + hf_token from cookbook_state (same as serve).
    env_cfg = await _cookbook_env_for_host(host)
    if env_cfg.get("env_prefix"): payload["env_prefix"] = env_cfg["env_prefix"]
    if env_cfg.get("hf_token"):   payload["hf_token"]   = env_cfg["hf_token"]
    if env_cfg.get("platform"):   payload["platform"]   = env_cfg["platform"]
    if env_cfg.get("ssh_port"):   payload["ssh_port"]   = env_cfg["ssh_port"]
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f"{_INTERNAL_BASE}/api/model/download",
                                     json=payload, headers=_internal_headers())
            data = resp.json()
        if data.get("ok"):
            sid = data.get("session_id", "?")
            registered = await _cookbook_register_task(
                session_id=sid, model=repo_id, host=host,
                cmd=f"hf download {repo_id}", task_type="download",
            )
            note = "" if registered else " (state-write failed — download may not show in UI)"
            where = host or "local"
            default_note = " (defaulted to the cookbook's selected server — pass host= or local=true to override)" if _host_defaulted else ""
            return {"output": f"Download started: {repo_id} on {where} (session: {sid}){note}{default_note}", "session_id": sid, "host": host, "exit_code": 0}
        return {"error": data.get("error", "Download failed"), "exit_code": 1}
    except Exception as e:
        return {"error": str(e), "exit_code": 1}


async def do_serve_model(content: str, owner: Optional[str] = None) -> Dict:
    """Start serving a model via the cookbook API."""
    import httpx
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    repo_id = args.get("repo_id", "")
    cmd = args.get("cmd", "")
    if not repo_id or not cmd:
        return {"error": "repo_id and cmd are required", "exit_code": 1}
    host = (args.get("host") or "").strip()
    if host:
        host = await _resolve_cookbook_host(host)
    if not host and not args.get("local"):
        _servers = await _cookbook_servers()
        if _servers.get("default_host"):
            host = _servers["default_host"]
    payload = {"repo_id": repo_id, "cmd": cmd}
    if host:
        payload["remote_host"] = host
    # Resolve per-host env settings (venv/conda activate, gpus,
    # hf_token, platform, ssh_port) from cookbook_state — same path
    # the UI uses. Without env_prefix, `vllm serve …` lands in a shell
    # without the user's venv and fails 'command not found'.
    env_cfg = await _cookbook_env_for_host(host)
    # Rewrite bare `vllm` / `python3` leading tokens to the venv's absolute
    # binary path when the target host has a venv configured. SSH non-
    # interactive shells often leave ~/.local/bin ahead of the venv bin on
    # PATH even with the venv activated, so `vllm serve` finds the wrong
    # binary and crashes early (e.g. compute_89 torch ABI errors on an old
    # user-site torch). This mirrors what static/js/cookbook.js does in
    # _buildServeCmd for the UI launch path.
    env_path = (env_cfg.get("env_path") or "").rstrip("/")
    env_type = (env_cfg.get("env_type") or env_cfg.get("env") or "").lower()
    if env_type == "venv" and env_path:
        venv_bin = f"{env_path}/bin"
        # Match the FIRST shell-token: skip leading KEY=VAL env-var prefixes
        # (CUDA_VISIBLE_DEVICES=… VLLM_USE_FLASHINFER_SAMPLER=…) before the binary.
        import re as _re3
        tokens = cmd.split()
        idx = 0
        env_re = _re3.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
        while idx < len(tokens) and env_re.match(tokens[idx]):
            idx += 1
        if idx < len(tokens):
            head = tokens[idx]
            if head in ("vllm", "python3", "python"):
                tokens[idx] = f"{venv_bin}/{head}"
                cmd = " ".join(tokens)
                payload["cmd"] = cmd
    if env_cfg.get("env_prefix"): payload["env_prefix"] = env_cfg["env_prefix"]
    if env_cfg.get("gpus"):       payload["gpus"]       = env_cfg["gpus"]
    if env_cfg.get("hf_token"):   payload["hf_token"]   = env_cfg["hf_token"]
    if env_cfg.get("platform"):   payload["platform"]   = env_cfg["platform"]
    if env_cfg.get("ssh_port"):   payload["ssh_port"]   = env_cfg["ssh_port"]
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f"{_INTERNAL_BASE}/api/model/serve",
                                     json=payload, headers=_internal_headers())
            data = resp.json()
        if data.get("ok"):
            sid = data.get("session_id", "?")
            registered = await _cookbook_register_task(
                session_id=sid, model=repo_id,
                host=host, cmd=cmd, task_type="serve",
            )
            note = "" if registered else " (state-write failed — task may not show in UI)"
            return {"output": f"Serving {repo_id} (session: {sid}){note}", "session_id": sid, "exit_code": 0}
        # FastAPI HTTPException puts the message under `detail`, not `error`.
        # Surface BOTH so the agent sees "Invalid characters in cmd" (from
        # _validate_serve_cmd rejecting `&&`/`source`/`cd`) instead of
        # the generic "Serve failed", which leaves it with nothing to act on.
        err_msg = data.get("error") or data.get("detail") or "Serve failed"
        hint = ""
        if isinstance(err_msg, str) and "cmd" in err_msg.lower():
            hint = (" — the cmd must START with an allowlisted binary "
                    "(vllm, python3, llama-server, ollama, sglang, lmdeploy, node, npx). "
                    "Do NOT prefix with `cd …`, `source …`, or chain with `&&`. "
                    "env_prefix (e.g. `source ~/qwen35-env/bin/activate`) is added "
                    "automatically from the host's saved venv settings.")
        return {"error": f"{err_msg}{hint}", "exit_code": 1}
    except Exception as e:
        return {"error": str(e), "exit_code": 1}


async def do_list_served_models(content: str, owner: Optional[str] = None) -> Dict:
    """List running model servers — merges cookbook-tracked tasks with
    a /proc scan for externally-launched LLM/diffusion processes
    (vLLM, sglang, llama.cpp, Ollama, ComfyUI, A1111, Fooocus, etc.)."""
    import asyncio
    import httpx

    # Cookbook-tracked tasks (best-effort; don't fail the whole call if
    # this is unreachable).
    cookbook_tasks: List[Dict[str, Any]] = []
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"{_INTERNAL_BASE}/api/cookbook/tasks/status",
                                    headers=_internal_headers())
            cookbook_tasks = (resp.json() or {}).get("tasks") or []
    except Exception as e:
        logger.debug(f"cookbook tasks/status fetch failed: {e}")

    # Local process scan — runs in a worker thread so it doesn't block.
    external = await asyncio.to_thread(_scan_running_model_processes)

    merged: List[Dict[str, Any]] = []
    merged.extend(cookbook_tasks)
    # Dedupe: if a process's PID is already mentioned by a cookbook task
    # (cookbook may track the PID via session_id), skip it.
    cookbook_pids = set()
    for t in cookbook_tasks:
        if isinstance(t, dict) and t.get("pid"):
            cookbook_pids.add(t["pid"])
    for p in external:
        if p.get("pid") not in cookbook_pids:
            merged.append(p)

    if not merged:
        return {
            "output": "No model servers currently running (cookbook task tracker empty; /proc scan found no vLLM / sglang / llama.cpp / Ollama / ComfyUI / A1111 / Fooocus / InvokeAI / TGI / Aphrodite / Triton / Diffusers processes).",
            "exit_code": 0,
        }

    # Sort so the agent sees what's actually LIVE first. Stopped/error/
    # completed tasks are mostly historical noise — they shouldn't lead
    # the list when something is genuinely serving.
    _ORDER = {
        "ready": 0, "running": 1, "loading": 1, "warming": 1,
        "queued": 2, "starting": 2,
        "error": 5, "crashed": 5, "failed": 5,
        "stopped": 6, "killed": 6, "cancelled": 6, "canceled": 6,
        "done": 7, "completed": 7, "finished": 7,
    }
    def _rank(t: Dict[str, Any]) -> int:
        phase = (t.get("phase") or t.get("status") or "unknown").lower()
        return _ORDER.get(phase, 3)
    merged.sort(key=_rank)

    cb_n = len(cookbook_tasks)
    ext_n = len(external)
    live_n = sum(1 for t in merged if _rank(t) <= 2)
    header = []
    if cb_n:
        header.append(f"{cb_n} cookbook-tracked")
    if ext_n:
        header.append(f"{ext_n} external")
    if live_n:
        header.insert(0, f"{live_n} LIVE")
    lines = [f"Running: {', '.join(header)}."]
    for t in merged:
        phase = t.get("phase") or t.get("status", "unknown")
        model = t.get("model", "?")
        remote = t.get("remote", "local")
        sid = t.get("session_id", "?")
        tag = " [external]" if t.get("external") else ""
        lines.append(f"- {model}: {phase} ({remote}, session: {sid}){tag}")
        diag = t.get("diagnosis") if isinstance(t.get("diagnosis"), dict) else None
        if diag:
            lines.append(f"    diagnosis: {diag.get('message')}")
            cmd = t.get("cmd") or ""
            suggestions = diag.get("suggestions") or []
            actionable = []
            for s in suggestions[:3]:
                label = s.get("label") or "retry"
                retry_cmd = _cookbook_apply_retry_suggestion(cmd, s)
                if retry_cmd and retry_cmd != cmd and s.get("op") in {"append", "replace", "remove"}:
                    actionable.append(f"{label}: `{retry_cmd}`")
                else:
                    actionable.append(label)
            if actionable:
                lines.append("    suggestions: " + " | ".join(actionable))
        if t.get("status") == "error" and t.get("output_tail"):
            tail = str(t.get("output_tail") or "").strip()
            if tail:
                # Prefer a window around a Python traceback if one exists,
                # falling back to the last 30 lines. The previous 6-line
                # tail showed only the post-crash bash prompt / neofetch
                # banner ("Locale: C / Ubuntu_Orwell ❯") — useless for
                # diagnosis. The traceback we want is usually 50-200 lines
                # earlier in the buffer.
                _tail_lines = tail.splitlines()
                _shown = _tail_lines[-30:]
                for _i, _ln in enumerate(_tail_lines):
                    if "Traceback (most recent call last)" in _ln or "ERROR" in _ln or "Error:" in _ln:
                        _shown = _tail_lines[_i:_i + 40]
                        break
                lines.append("    recent log:")
                for line in _shown:
                    lines.append(f"      {line[:220]}")
        if t.get("external") and t.get("cmdline_preview"):
            lines.append(f"    cmd: {t['cmdline_preview']}")
    return {"output": "\n".join(lines), "tasks": merged, "exit_code": 0}


async def _cookbook_kill_session(session_id: str, *, remote_host: str = "",
                                 ssh_port: str = "", verb: str = "Stopped") -> Dict:
    """Kill a cookbook tmux session — remote-aware — AND mark the task
    stopped in cookbook_state.json. Shared by stop_served_model and
    cancel_download so both behave identically.

    Resolves the task's remote host from state when not passed in. A
    local-only `tmux kill-session` silently no-ops for remote tasks —
    that's the bug where "stop the download" appeared to work but the
    download kept running on the remote host.
    """
    import httpx
    import shlex
    headers = _internal_headers()
    remote = remote_host or ""
    sport = ssh_port or ""

    # Look up the task's host + confirm it exists in state.
    state: Dict[str, Any] = {}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{_INTERNAL_BASE}/api/cookbook/state", headers=headers)
            state = resp.json() or {}
    except Exception as e:
        logger.debug(f"cookbook state lookup failed for {session_id}: {e}")
    if not isinstance(state, dict):
        state = {}
    matched = None
    for t in (state.get("tasks") or []):
        if isinstance(t, dict) and (t.get("sessionId") == session_id or t.get("id") == session_id):
            matched = t
            if not remote:
                remote = t.get("remoteHost") or ""
            if not sport:
                sport = t.get("sshPort") or ""
            break

    if remote:
        _pf = f"-p {shlex.quote(str(sport))} " if sport and str(sport) != "22" else ""
        cmd = (
            f"ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "
            f"{_pf}{shlex.quote(remote)} 'tmux kill-session -t {shlex.quote(session_id)}'"
        )
        target_label = f"{session_id} on {remote}"
    else:
        cmd = f"tmux kill-session -t {shlex.quote(session_id)}"
        target_label = session_id

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(f"{_INTERNAL_BASE}/api/shell/exec",
                                     json={"command": cmd}, headers=headers)
        if resp.status_code >= 400:
            return {"error": f"shell/exec returned HTTP {resp.status_code}: {resp.text[:200]}", "exit_code": 1}
        try:
            data = resp.json()
        except Exception:
            data = {}
        kill_failed = isinstance(data, dict) and data.get("exit_code") not in (None, 0)
        kill_err = ((data.get("stderr") or data.get("error") or "").strip() if isinstance(data, dict) else "")
        # "no server running" / "can't find session" means it was already
        # gone — treat as success (the goal is "not running").
        already_gone = any(s in kill_err.lower() for s in ("no server running", "can't find session", "session not found"))
        if kill_failed and not already_gone:
            return {"error": f"Failed to {verb.lower()} {target_label}: {kill_err or 'kill-session returned non-zero'}", "exit_code": 1}

        # Update state: mark stopped (so the UI + list reflect reality).
        if matched is not None:
            try:
                matched["status"] = "stopped"
                async with httpx.AsyncClient(timeout=10) as client:
                    await client.post(f"{_INTERNAL_BASE}/api/cookbook/state",
                                      json=state, headers=headers)
            except Exception as e:
                logger.debug(f"failed to mark {session_id} stopped in state: {e}")

        suffix = " (was already gone)" if already_gone else ""
        return {"output": f"{verb} {target_label}{suffix}", "exit_code": 0}
    except Exception as e:
        return {"error": str(e), "exit_code": 1}


async def do_stop_served_model(content: str, owner: Optional[str] = None) -> Dict:
    """Stop a running model server by killing its tmux session (remote-aware)."""
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    session_id = args.get("session_id", "")
    if not session_id:
        return {"error": "session_id is required", "exit_code": 1}
    return await _cookbook_kill_session(
        session_id,
        remote_host=args.get("remote_host") or args.get("host") or "",
        ssh_port=args.get("ssh_port") or "",
        verb="Stopped server",
    )


async def do_tail_serve_output(content: str, owner: Optional[str] = None) -> Dict:
    """Capture the last N lines of a cookbook task's tmux pane — remote-aware.

    Used by the agent to debug a failed/stuck serve: list_served_models tells
    you the task is `crashed`, this tool returns the actual stderr/traceback
    so the agent can match it against a known fix (compute_89 nvcc mismatch,
    flashinfer version mismatch, OOM, missing kernels, etc.) and decide
    whether to relaunch via serve_model with new flags.
    """
    import httpx
    import shlex
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    session_id = (args.get("session_id") or "").strip()
    if not session_id:
        return {"error": "session_id is required (from list_served_models)", "exit_code": 1}
    import re as _re
    if not _re.fullmatch(r"[a-zA-Z0-9_-]+", session_id):
        return {"error": "Invalid session_id format", "exit_code": 1}
    try:
        tail = int(args.get("tail") or 400)
    except (TypeError, ValueError):
        tail = 400
    tail = max(20, min(tail, 4000))
    headers = _internal_headers()
    remote = (args.get("remote_host") or args.get("host") or "").strip()
    sport = (args.get("ssh_port") or "").strip()
    # Resolve host from cookbook state if caller didn't pass one — same
    # lookup _cookbook_kill_session uses.
    if not remote:
        state: Dict[str, Any] = {}
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"{_INTERNAL_BASE}/api/cookbook/state", headers=headers)
                state = resp.json() or {}
        except Exception as e:
            logger.debug(f"cookbook state lookup failed for {session_id}: {e}")
        if isinstance(state, dict):
            for t in (state.get("tasks") or []):
                if isinstance(t, dict) and (t.get("sessionId") == session_id or t.get("id") == session_id):
                    remote = t.get("remoteHost") or ""
                    if not sport:
                        sport = t.get("sshPort") or ""
                    break
    # Prefer the persisted /tmp/orwell-tmux/SESSION.log file over the
    # live tmux pane. The pane is what the user would see scrolling on
    # their screen — including the post-crash neofetch banner and the
    # idle bash prompt that overwrites the actual traceback the moment
    # vllm exits. The log file is the raw stdout/stderr of the wrapped
    # process and survives the crash unchanged. We only fall back to
    # the pane when the log file doesn't exist (older sessions launched
    # before the tmux+tee wrapper was added).
    log_path = f"/tmp/orwell-tmux/{session_id}.log"
    pane_inner = f"tmux capture-pane -t {shlex.quote(session_id)} -p -S -{tail} 2>/dev/null"
    file_inner = f"tail -n {tail} {shlex.quote(log_path)} 2>/dev/null"
    inner = (
        f"if [ -s {shlex.quote(log_path)} ]; then {file_inner}; "
        f"else {pane_inner}; fi"
    )
    if remote:
        _pf = f"-p {shlex.quote(str(sport))} " if sport and str(sport) != "22" else ""
        cmd = (
            f"ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no "
            f"{_pf}{shlex.quote(remote)} {shlex.quote(inner)}"
        )
        host_label = remote
    else:
        cmd = inner
        host_label = "local"
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(f"{_INTERNAL_BASE}/api/shell/exec",
                                     json={"command": cmd}, headers=headers)
        if resp.status_code >= 400:
            return {"error": f"shell/exec returned HTTP {resp.status_code}: {resp.text[:200]}", "exit_code": 1}
        data = resp.json() if resp.content else {}
        output_text = (data.get("stdout") or "").strip()
        stderr_text = (data.get("stderr") or "").strip()
        rc = data.get("exit_code")
        if rc not in (None, 0) and not output_text:
            already_gone = any(s in (stderr_text or "").lower() for s in ("no server running", "can't find session", "session not found"))
            if already_gone:
                return {"output": f"Tmux session {session_id} on {host_label} is gone (task already exited).", "exit_code": 0, "session_id": session_id, "host": host_label}
            return {"error": f"capture-pane failed on {host_label}: {stderr_text or f'exit {rc}'}", "exit_code": 1}
        # Dedupe download-progress noise. A 100-shard HF download produces
        # tens of thousands of `model-NN-of-MM.safetensors: 91%|...` lines
        # that all look the same to the agent and drown the actual error.
        # Keep only one sample per (file, decile-percent) bucket.
        import re as _re2
        lines = output_text.splitlines()
        dedup_lines = []
        seen_progress = set()
        progress_re = _re2.compile(r"^([\w./\-]+):\s+(\d+)%")
        for ln in lines:
            m = progress_re.match(ln.strip())
            if m:
                key = (m.group(1), int(m.group(2)) // 10)  # bucket by 10%
                if key in seen_progress:
                    continue
                seen_progress.add(key)
            dedup_lines.append(ln)
        output_text = "\n".join(dedup_lines)
        # Hard cap so the agent doesn't blow its token budget.
        MAX_CHARS = 8000
        if len(output_text) > MAX_CHARS:
            output_text = "…(earlier output truncated)…\n" + output_text[-MAX_CHARS:]
        return {
            "output": output_text or "(empty pane)",
            "session_id": session_id,
            "host": host_label,
            "tail_lines": tail,
            "exit_code": 0,
        }
    except Exception as e:
        return {"error": str(e), "exit_code": 1}


async def do_list_downloads(content: str, owner: Optional[str] = None) -> Dict:
    """List in-flight model downloads (filters /api/cookbook/tasks/status to type=download)."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"{_INTERNAL_BASE}/api/cookbook/tasks/status",
                                    headers=_internal_headers())
            data = resp.json()
        tasks = [t for t in data.get("tasks", []) if (t.get("type") or "").lower() == "download"]
        if not tasks:
            return {"output": "No downloads in progress.", "exit_code": 0}
        lines = [f"{len(tasks)} download(s) in progress:"]
        for t in tasks:
            phase = t.get("phase") or t.get("status", "unknown")
            model = t.get("model", "?")
            pct = t.get("progress_percent") or t.get("percent")
            pct_str = f" {pct}%" if pct is not None else ""
            lines.append(f"- {model}: {phase}{pct_str} ({t.get('remote', 'local')}, session: {t.get('session_id', '?')})")
        return {"output": "\n".join(lines), "downloads": tasks, "exit_code": 0}
    except Exception as e:
        return {"error": str(e), "exit_code": 1}


async def do_cancel_download(content: str, owner: Optional[str] = None) -> Dict:
    """Cancel a model download by killing its tmux session (remote-aware)."""
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    session_id = args.get("session_id", "")
    if not session_id:
        return {"error": "session_id is required (from list_downloads)", "exit_code": 1}
    return await _cookbook_kill_session(
        session_id,
        remote_host=args.get("remote_host") or args.get("host") or "",
        ssh_port=args.get("ssh_port") or "",
        verb="Cancelled download",
    )


async def do_search_hf_models(content: str, owner: Optional[str] = None) -> Dict:
    """Search HuggingFace via the cookbook /api/cookbook/hf-latest endpoint."""
    import httpx
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    query = args.get("query", "") or args.get("search", "")
    limit = args.get("limit", 10)
    params: Dict[str, str] = {}
    if query:
        params["search"] = query
    if limit:
        params["limit"] = str(limit)
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(f"{_INTERNAL_BASE}/api/cookbook/hf-latest",
                                    params=params, headers=_internal_headers())
            data = resp.json()
        models = data.get("models") if isinstance(data, dict) else data
        if not models:
            return {"output": f"No models found for query: {query!r}", "exit_code": 0}
        lines = [f"Found {len(models)} model(s) for {query!r}:" if query else f"{len(models)} model(s):"]
        for m in models[:limit if isinstance(limit, int) else 10]:
            if isinstance(m, dict):
                name = m.get("repo_id") or m.get("modelId") or m.get("id") or "?"
                dl = m.get("downloads")
                size = m.get("size_gb") or m.get("needed_vram_gb")
                bits = []
                if size:
                    bits.append(f"~{size}GB")
                if dl:
                    bits.append(f"{dl} downloads")
                tail = f" ({', '.join(bits)})" if bits else ""
                lines.append(f"- {name}{tail}")
            else:
                lines.append(f"- {m}")
        return {"output": "\n".join(lines), "models": models, "exit_code": 0}
    except Exception as e:
        return {"error": str(e), "exit_code": 1}


async def do_adopt_served_model(content: str, owner: Optional[str] = None) -> Dict:
    """Register an externally-launched model server (bash + tmux + ssh, or
    anything else) into the Cookbook so it appears in list_served_models,
    can be stopped via stop_served_model, and is added to the user's
    endpoint list for chat. Use this when a model was started outside
    the cookbook's serve flow but you want first-class tracking.

    Args (JSON):
      host:          "user@192.0.2.10" (or omit for localhost)
      tmux_session:  "minimax-m27"  (existing tmux session name)
      model:         "cyankiwi/MiniMax-M2.7-AWQ-4bit" (HF repo or display name)
      port:          8000
      name:          optional display name (defaults to model basename)
      add_endpoint:  bool (default true) — also register as a chat endpoint
    """
    import httpx
    import shlex
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}

    host = (args.get("host") or args.get("remote_host") or "").strip()
    sess = (args.get("tmux_session") or args.get("session_id") or "").strip()
    model = (args.get("model") or args.get("repo_id") or "").strip()
    port = args.get("port") or 8000
    display_name = (args.get("name") or "").strip() or (model.split("/")[-1] if "/" in model else model)
    add_endpoint = args.get("add_endpoint", True)

    if not sess or not model:
        return {"error": "tmux_session and model are required", "exit_code": 1}

    # Verify tmux session exists on the target host
    headers = _internal_headers()
    if host:
        check = f"ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no {shlex.quote(host)} 'tmux has-session -t {shlex.quote(sess)} 2>&1'"
    else:
        check = f"tmux has-session -t {shlex.quote(sess)} 2>&1"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(f"{_INTERNAL_BASE}/api/shell/exec",
                                  json={"command": check}, headers=headers)
            data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        if r.status_code >= 400 or (data.get("exit_code") not in (None, 0)):
            err = (data.get("stderr") or data.get("error") or r.text[:200]).strip()
            return {"error": f"tmux session {sess!r} not found on {host or 'local'}: {err}", "exit_code": 1}
    except Exception as e:
        return {"error": f"verify failed: {e}", "exit_code": 1}

    # Best-effort health check — does port respond to /v1/models?
    if host:
        health_cmd = f"ssh -o ConnectTimeout=5 {shlex.quote(host)} 'curl -s -m 3 http://localhost:{int(port)}/v1/models'"
    else:
        health_cmd = f"curl -s -m 3 http://localhost:{int(port)}/v1/models"
    server_up = False
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(f"{_INTERNAL_BASE}/api/shell/exec",
                                  json={"command": health_cmd}, headers=headers)
            body = (r.json() or {}).get("stdout", "") if r.headers.get("content-type", "").startswith("application/json") else ""
            server_up = '"data"' in body or '"object"' in body
    except Exception:
        pass

    # Read+modify+write cookbook state. APPEND a task entry; do NOT
    # overwrite the whole file (that'd nuke presets).
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{_INTERNAL_BASE}/api/cookbook/state", headers=headers)
            state = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    except Exception as e:
        return {"error": f"could not read cookbook state: {e}", "exit_code": 1}
    if not isinstance(state, dict):
        state = {}
    tasks = state.get("tasks") if isinstance(state.get("tasks"), list) else []
    # Skip duplicate adopt of the same session
    if any(isinstance(t, dict) and t.get("sessionId") == sess for t in tasks):
        adopted_already = True
    else:
        adopted_already = False
        import time as _time
        new_task = {
            "id": sess,
            "sessionId": sess,
            "name": display_name,
            "type": "serve",
            "status": "running",
            "output": (
                f"Adopted externally-launched session {sess!r} on {host or 'local'}.\n"
                "Reconnect polling will start streaming tmux output shortly."
            ),
            "ts": int(_time.time() * 1000),
            "payload": {"repo_id": model, "remote_host": host or "", "_cmd": "(adopted — launched outside cookbook)"},
            "remoteHost": host or "",
            "sshPort": "",
            "platform": "linux",
            "_serveReady": bool(server_up),
            "_endpointAdded": False,
            "_adoptedExternally": True,
        }
        tasks.append(new_task)
        state["tasks"] = tasks
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(f"{_INTERNAL_BASE}/api/cookbook/state",
                                  json=state, headers=headers)
        except Exception as e:
            return {"error": f"could not save cookbook state: {e}", "exit_code": 1}

    # Optionally register as a chat endpoint
    endpoint_msg = ""
    if add_endpoint:
        # Resolve host to a URL. SSH form `user@host` → just take host.
        host_only = host.split("@", 1)[-1] if host else "localhost"
        endpoint_url = f"http://{host_only}:{int(port)}/v1"
        try:
            from src.tool_implementations import do_manage_endpoints  # avoid forward ref issues
        except Exception:
            do_manage_endpoints = None
        if do_manage_endpoints is not None:
            try:
                ep_result = await do_manage_endpoints(json.dumps({
                    "action": "add",
                    "name": display_name,
                    "endpoint_url": endpoint_url,
                    "is_local": False,
                }), owner=owner)
                if isinstance(ep_result, dict) and not ep_result.get("error"):
                    endpoint_msg = f" Endpoint {endpoint_url} added as {display_name!r}."
                else:
                    endpoint_msg = f" Endpoint registration skipped: {(ep_result or {}).get('error', 'unknown')}"
            except Exception as e:
                endpoint_msg = f" Endpoint registration failed: {e}"

    return {
        "output": (
            f"Adopted session {sess!r} ({model}) on {host or 'local'}:{port}. "
            + ("Already tracked — skipped state write. " if adopted_already else "Added to cookbook state. ")
            + ("Server responding. " if server_up else "Server not responding yet (still loading?). ")
            + endpoint_msg
        ).strip(),
        "session_id": sess,
        "host": host,
        "port": int(port),
        "server_up": server_up,
        "exit_code": 0,
    }


async def do_list_cookbook_servers(content: str, owner: Optional[str] = None) -> Dict:
    """List the cookbook's configured servers and which one is the
    current default. Use this to decide where to download/serve a
    model, or to show the user options when the target host is
    ambiguous."""
    servers = await _cookbook_servers()
    hosts = servers.get("hosts") or []
    default = servers.get("default_host") or ""
    if not hosts:
        return {"output": "No cookbook servers configured. Downloads/serves default to localhost.", "servers": [], "default_host": "", "exit_code": 0}
    # Resolve which server is the default by its friendly name too.
    default_name = next((h.get("name") for h in hosts if h.get("host") == default and h.get("name")), default or "local")
    lines = [f"{len(hosts)} configured server(s) (default: {default_name}):"]
    for h in hosts:
        name = h.get("name") or "(unnamed)"
        host = h.get("host") or "local"
        mark = " ← default" if h.get("host") == default else ""
        env_bit = f" [{h.get('env')}: {h.get('envPath')}]" if h.get("env") and h.get("env") != "none" else ""
        plat = f" ({h.get('platform')})" if h.get("platform") else ""
        lines.append(f"- {name} → {host}{plat}{env_bit}{mark}")
    lines.append("\nRefer to servers by their name (e.g. download_model with host=\"gpu-box\").")
    return {"output": "\n".join(lines), "servers": hosts, "default_host": default, "exit_code": 0}


async def do_list_serve_presets(content: str, owner: Optional[str] = None) -> Dict:
    """List saved serve presets from cookbook_state.json. Each preset
    is a launch template: name, model, host, port, cmd. Use this to
    discover what the user has previously configured so you can
    launch by preset instead of fabricating tmux commands."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{_INTERNAL_BASE}/api/cookbook/state",
                                    headers=_internal_headers())
            state = resp.json() or {}
    except Exception as e:
        return {"error": f"Failed to fetch cookbook state: {e}", "exit_code": 1}

    presets = state.get("presets") or []
    if not presets:
        return {
            "output": "No serve presets saved. Tell the user to save one from the Cookbook UI first, or use serve_model with explicit repo_id + cmd + host.",
            "presets": [],
            "exit_code": 0,
        }
    lines = [f"{len(presets)} saved serve preset(s):"]
    for p in presets:
        if not isinstance(p, dict):
            continue
        name = p.get("name", "?")
        model = p.get("model") or p.get("modelId") or "?"
        host = p.get("host") or p.get("remoteHost") or "local"
        port = p.get("port", "")
        cmd = (p.get("cmd") or "").strip()
        bits = [f"- {name}: {model}", f"host={host}"]
        if port:
            bits.append(f"port={port}")
        lines.append("  ".join(bits))
        if cmd:
            cmd_preview = cmd if len(cmd) < 140 else cmd[:140] + "…"
            lines.append(f"    cmd: {cmd_preview}")
    return {"output": "\n".join(lines), "presets": presets, "exit_code": 0}


async def do_serve_preset(content: str, owner: Optional[str] = None) -> Dict:
    """Launch a saved serve preset by name. Resolves the preset's
    cmd + host + model from cookbook_state.json, then calls the
    standard model/serve endpoint. Saves the agent from having to
    reinvent tmux launch commands the user already saved."""
    import httpx
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    name = (args.get("name") or args.get("preset") or "").strip()
    if not name:
        return {"error": "name (preset name) is required. Call list_serve_presets to see what's available.", "exit_code": 1}

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{_INTERNAL_BASE}/api/cookbook/state",
                                    headers=_internal_headers())
            state = resp.json() or {}
    except Exception as e:
        return {"error": f"Failed to fetch cookbook state: {e}", "exit_code": 1}

    presets = state.get("presets") or []
    # Match by exact name first, then case-insensitive substring.
    chosen = None
    lname = name.lower()
    for p in presets:
        if isinstance(p, dict) and (p.get("name") or "").lower() == lname:
            chosen = p
            break
    if chosen is None:
        for p in presets:
            if isinstance(p, dict) and lname in (p.get("name") or "").lower():
                chosen = p
                break
    if chosen is None:
        sample = ", ".join((p.get("name") or "?") for p in presets[:8] if isinstance(p, dict))
        return {"error": f"No preset matching {name!r}. Available: {sample or '(none)'}", "exit_code": 1}

    repo_id = chosen.get("model") or chosen.get("modelId") or ""
    cmd = (chosen.get("cmd") or "").strip()
    host = chosen.get("host") or chosen.get("remoteHost") or ""
    if not repo_id or not cmd:
        return {"error": f"Preset {chosen.get('name')!r} is missing model or cmd — can't launch.", "exit_code": 1}

    payload: Dict[str, Any] = {"repo_id": repo_id, "cmd": cmd}
    if host:
        payload["remote_host"] = host
    # Resolve per-host env settings the same way the UI does — pulls
    # env_prefix (source ~/vllm-env/bin/activate), gpus, hf_token,
    # etc. from cookbook_state.env so launches actually find vllm.
    env_cfg = await _cookbook_env_for_host(host)
    if env_cfg.get("env_prefix"): payload["env_prefix"] = env_cfg["env_prefix"]
    if env_cfg.get("gpus"):       payload["gpus"]       = env_cfg["gpus"]
    if env_cfg.get("hf_token"):   payload["hf_token"]   = env_cfg["hf_token"]
    if env_cfg.get("platform"):   payload["platform"]   = env_cfg["platform"]
    if env_cfg.get("ssh_port"):   payload["ssh_port"]   = env_cfg["ssh_port"]

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f"{_INTERNAL_BASE}/api/model/serve",
                                     json=payload, headers=_internal_headers())
            data = resp.json()
        if data.get("ok"):
            sid = data.get("session_id", "?")
            registered = await _cookbook_register_task(
                session_id=sid, model=repo_id, host=host,
                cmd=cmd, task_type="serve",
            )
            note = "" if registered else " (state-write failed — task may not show in UI)"
            return {"output": f"Launched preset {chosen.get('name')!r}: {repo_id} on {host or 'local'} (session: {sid}){note}", "session_id": sid, "exit_code": 0}
        return {"error": data.get("error", "Serve failed"), "exit_code": 1}
    except Exception as e:
        return {"error": str(e), "exit_code": 1}


async def do_list_cached_models(content: str, owner: Optional[str] = None) -> Dict:
    """List models already cached locally and/or on remote hosts.

    With no `host` arg, scans EVERY configured Cookbook server (and local)
    and aggregates — so the agent sees the full inventory in one call
    instead of having to query each server individually.
    """
    import httpx
    try:
        args = _parse_tool_args(content) if content.strip() else {}
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    raw_host = (args.get("host") or "").strip()
    headers = _internal_headers()

    async def _scan_one(host_label: str, host_val: str, ssh_port: str = "",
                        platform: str = "", model_dir: str = "") -> list:
        """Hit /api/model/cached for one host; tag each returned model with its source."""
        p: Dict[str, str] = {}
        if host_val:
            p["host"] = host_val
        # Caller-provided override beats per-server config beats nothing.
        if args.get("model_dir"):
            p["model_dir"] = args["model_dir"]
        elif model_dir:
            p["model_dir"] = model_dir
        if ssh_port:
            p["ssh_port"] = ssh_port
        elif args.get("ssh_port"):
            p["ssh_port"] = str(args["ssh_port"])
        if platform:
            p["platform"] = platform
        elif args.get("platform"):
            p["platform"] = args["platform"]
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.get(f"{_INTERNAL_BASE}/api/model/cached",
                                        params=p, headers=headers)
                data = resp.json()
            ms = data.get("models", []) if isinstance(data, dict) else (data or [])
            for m in ms:
                m["host"] = host_label or "local"
            return ms or []
        except Exception as e:
            logger.debug(f"list_cached_models scan({host_label}) failed: {e}")
            return []

    # When the caller specifies a host explicitly, scan only that one (old behaviour).
    # Otherwise iterate every configured server + local so the agent doesn't
    # have to repeat the call per server.
    try:
        # Pull configured servers from cookbook state (used for resolving
        # modelDirs both when caller specifies a host and when we scan all).
        servers: list = []
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                st = await client.get(f"{_INTERNAL_BASE}/api/cookbook/state", headers=headers)
                st_data = st.json() if st.headers.get("content-type", "").startswith("application/json") else {}
            servers = (st_data.get("env", {}) or {}).get("servers") or []
        except Exception as e:
            logger.debug(f"server list fetch failed: {e}")
            st_data = {}

        def _dirs_for(server_record: Dict[str, Any]) -> str:
            """Comma-joined modelDirs from a saved server record (Settings).

            Filters out the HF cache (~/.cache/huggingface/hub) — the backend
            scan script always scans it by default, so re-passing it as an
            extra model_dir is redundant AND confuses some path-handling
            edge cases where the extra dir suppresses the deeper scan.
            We only need to forward the NON-default dirs (e.g. /mnt/HADES/models).
            """
            mds = server_record.get("modelDirs") if isinstance(server_record, dict) else None
            HF_DEFAULTS = {"~/.cache/huggingface/hub", "~/.cache/huggingface"}
            if isinstance(mds, list):
                extras = [d for d in mds if isinstance(d, str) and d.strip() and d.strip() not in HF_DEFAULTS]
                return ",".join(extras)
            if isinstance(mds, str) and mds.strip() not in HF_DEFAULTS:
                return mds
            return ""

        if raw_host:
            host = await _resolve_cookbook_host(raw_host)
            # Find this host's saved record so its modelDirs apply too.
            srv = next(
                (s for s in servers if isinstance(s, dict)
                 and (s.get("name") == raw_host or s.get("host") == host or s.get("host") == raw_host)),
                {},
            )
            models = await _scan_one(raw_host, host, model_dir=_dirs_for(srv))
        else:
            # Always include local. Local's saved record is the one with no host.
            local_srv = next((s for s in servers if isinstance(s, dict) and not (s.get("host") or "").strip()), {})
            scans: list = [_scan_one("local", "", model_dir=_dirs_for(local_srv))]
            for s in servers:
                if not isinstance(s, dict):
                    continue
                name = s.get("name") or s.get("host")
                host_val = s.get("host") or ""
                if not host_val:
                    continue
                scans.append(_scan_one(
                    name,
                    host_val,
                    ssh_port=str(s.get("port") or ""),
                    platform=s.get("platform") or "",
                    model_dir=_dirs_for(s),
                ))
            results = await asyncio.gather(*scans, return_exceptions=False)
            # Dedupe by (host, repo_id) — same model could appear in both HF cache + Ollama list.
            seen = set()
            models: list = []
            for batch in results:
                for m in batch:
                    key = (m.get("host", ""), m.get("repo_id", ""))
                    if key in seen:
                        continue
                    seen.add(key)
                    models.append(m)
        if not models:
            # Cache scans can miss models downloaded into the HF default cache
            # when the server has no explicit model_dir configured. Surface
            # completed Cookbook download tasks so the agent doesn't conclude
            # a model is absent and re-download it.
            downloaded = []
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    st = await client.get(f"{_INTERNAL_BASE}/api/cookbook/state", headers=headers)
                    state = st.json() if st.headers.get("content-type", "").startswith("application/json") else {}
                for t in (state.get("tasks") or []):
                    if not isinstance(t, dict) or t.get("type") != "download":
                        continue
                    if (t.get("status") or "").lower() not in {"done", "completed"}:
                        continue
                    task_host = t.get("remoteHost") or (t.get("payload") or {}).get("remote_host") or ""
                    if raw_host and task_host != raw_host:
                        continue
                    repo = t.get("modelId") or t.get("repoId") or (t.get("payload") or {}).get("repo_id") or t.get("name")
                    if repo and repo not in downloaded:
                        downloaded.append(repo)
            except Exception:
                downloaded = []
            host_str = f" on {raw_host}" if raw_host else ""
            if downloaded:
                lines = [f"No cache paths were detected{host_str}, but Cookbook has completed download task(s):"]
                lines.extend(f"- {repo} — downloaded via Cookbook task" for repo in downloaded)
                return {"output": "\n".join(lines), "models": [{"repo_id": repo, "source": "cookbook_task"} for repo in downloaded], "exit_code": 0}
            return {"output": f"No cached models found{host_str}.", "exit_code": 0}
        # Multi-host scan: group by host so the agent sees inventory per server.
        # Single-host scan: flat list (matches old output shape).
        if raw_host:
            lines = [f"{len(models)} cached model(s) on {raw_host}:"]
            for m in models:
                name = m.get("repo_id", "?")
                sz = m.get("size") or (f"{m.get('size_bytes', 0) / (1024**3):.1f}GB" if m.get("size_bytes") else "")
                inc = " (incomplete)" if m.get("has_incomplete") else ""
                kind = " [diffusion]" if m.get("is_diffusion") else ""
                lines.append(f"- {name}{kind} — {sz}{inc}")
        else:
            from collections import defaultdict as _dd
            by_host = _dd(list)
            for m in models:
                by_host[m.get("host", "local")].append(m)
            lines = [f"{len(models)} cached model(s) across {len(by_host)} server(s):"]
            for host_name in sorted(by_host.keys()):
                lines.append(f"\n[{host_name}]")
                for m in by_host[host_name]:
                    name = m.get("repo_id", "?")
                    sz = m.get("size") or (f"{m.get('size_bytes', 0) / (1024**3):.1f}GB" if m.get("size_bytes") else "")
                    inc = " (incomplete)" if m.get("has_incomplete") else ""
                    kind = " [diffusion]" if m.get("is_diffusion") else ""
                    backend = f" ({m.get('backend')})" if m.get("backend") else ""
                    lines.append(f"- {name}{kind}{backend} — {sz}{inc}")
        return {"output": "\n".join(lines), "models": models, "exit_code": 0}
    except Exception as e:
        return {"error": str(e), "exit_code": 1}


# ── Gallery tools ──

async def do_edit_image(content: str, owner: Optional[str] = None) -> Dict:
    """Edit a gallery image (upscale, rembg, inpaint, harmonize)."""
    import httpx
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    image_id = args.get("image_id", "")
    action = args.get("action", "")
    if not image_id or not action:
        return {"error": "image_id and action are required", "exit_code": 1}
    payload = {"image_id": image_id}
    if args.get("prompt"):
        payload["prompt"] = args["prompt"]
    if args.get("scale"):
        payload["scale"] = args["scale"]
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(f"{_INTERNAL_BASE}/api/gallery/{action}", json=payload)
            data = resp.json()
        if data.get("success") or data.get("id"):
            return {"output": f"Image edited ({action}). New image ID: {data.get('id', '?')}", "exit_code": 0}
        return {"error": data.get("error", f"{action} failed"), "exit_code": 1}
    except Exception as e:
        return {"error": str(e), "exit_code": 1}


# ── Research tools ──

async def do_manage_research(content: str, owner: Optional[str] = None) -> Dict:
    """List, read/open, or delete saved deep-research results from the Library.
    Args (JSON): {"action": "list|read|delete", "id": "<id>", "search": "..."}.
    Research is stored as data/deep_research/<id>.json (query, summary, sources)."""
    import json as _json
    from pathlib import Path as _Path
    try:
        args = _parse_tool_args(content) if content.strip().startswith("{") else {}
    except ValueError:
        args = {}
    if not isinstance(args, dict):
        args = {}
    action = (args.get("action") or "list").lower()
    rid = (args.get("id") or args.get("session_id") or args.get("research_id") or "").strip()
    data_dir = _Path("data/deep_research")

    # SECURITY: the research id is interpolated straight into a filesystem
    # path (data/deep_research/<rid>.json) for read AND delete. Without this
    # gate an agent-supplied id like "../settings" or "../../etc/passwd"
    # escapes the research dir — reading exfiltrates arbitrary *.json into
    # chat, deleting unlinks arbitrary *.json on disk. Allow only a bare
    # token (research session ids are hex/uuid/slug — no separators).
    if rid and not re.fullmatch(r"[A-Za-z0-9_-]+", rid):
        return {"error": "Invalid research id."}

    def _load(p):
        try:
            return _json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None

    if action in ("read", "open", "view", "get"):
        if not rid:
            return {"error": "Provide the research id (from action='list')."}
        p = data_dir / f"{rid}.json"
        if not p.exists():
            return {"error": f"Research '{rid}' not found."}
        d = _load(p) or {}
        summary = d.get("result") or d.get("raw_report") or d.get("summary") or d.get("report") or "(no report body)"
        srcs = d.get("sources", []) or []
        out = f"# {d.get('query', '(untitled)')}\n\n{summary}"
        if srcs:
            out += "\n\nSources:\n" + "\n".join(
                f"- {s.get('title') or s.get('url', '')}: {s.get('url', '')}" for s in srcs[:30]
            )
        return {"output": out[:16000], "exit_code": 0}

    if action == "delete":
        if not rid:
            return {"error": "Provide the research id to delete (from action='list')."}
        p = data_dir / f"{rid}.json"
        if p.exists():
            try:
                p.unlink()
            except Exception as e:
                return {"error": f"Failed to delete: {e}"}
            return {"output": f"Deleted research '{rid}'.", "exit_code": 0}
        return {"error": f"Research '{rid}' not found."}

    # default: list — clickable [query](#research-<id>) rows, most-recent first
    search = (args.get("search") or "").lower()
    items = []
    if data_dir.exists():
        for p in data_dir.glob("*.json"):
            d = _load(p)
            if not d:
                continue
            q = d.get("query", "")
            if search and search not in q.lower():
                continue
            items.append((d.get("completed_at", 0) or 0, p.stem, q, len(d.get("sources", []) or [])))
    items.sort(reverse=True)
    if not items:
        return {"output": "No research found in the library." + (f" (search: {search})" if search else ""), "exit_code": 0}
    rows = "\n".join(f"- [{q or '(untitled)'}](#research-{sid}) — {n} sources" for _, sid, q, n in items[:50])
    return {"output": f"Research library ({len(items)} item{'s' if len(items) != 1 else ''}):\n{rows}", "exit_code": 0}


async def do_trigger_research(content: str, owner: Optional[str] = None) -> Dict:
    """Start a live deep-research job that appears in the Deep Research
    sidebar. Hits /api/research/start (the same path the sidebar's
    'Research' button uses) so the session is discoverable + streamable
    there, rather than creating a scheduled task that never surfaces."""
    import httpx
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    topic = args.get("topic", "") or args.get("query", "")
    if not topic:
        return {"error": "topic (or query) is required", "exit_code": 1}
    payload: Dict[str, Any] = {"query": topic}
    # Optional knobs the research panel supports.
    if args.get("max_rounds") is not None:
        try: payload["max_rounds"] = int(args["max_rounds"])
        except (ValueError, TypeError): pass
    if args.get("max_time") is not None:
        try: payload["max_time"] = int(args["max_time"])
        except (ValueError, TypeError): pass
    if args.get("category"):
        payload["category"] = args["category"]
    if args.get("search_provider"):
        payload["search_provider"] = args["search_provider"]
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f"{_INTERNAL_BASE}/api/research/start",
                                     json=payload, headers=_internal_headers(owner))
        if resp.status_code >= 400:
            return {"error": f"research/start returned HTTP {resp.status_code}: {resp.text[:200]}", "exit_code": 1}
        data = resp.json()
        sid = data.get("session_id", "?")
        return {
            "output": (
                f"Deep research started: [{topic}](#research-{sid}). "
                "Click to open the Deep Research sidebar and watch progress / read the report."
            ),
            "session_id": sid,
            "anchor": f"[{topic}](#research-{sid})",
            # UI hint so the frontend can open/refresh the research panel.
            "ui_event": "research_started",
            "research_session_id": sid,
            "exit_code": 0,
        }
    except Exception as e:
        return {"error": str(e), "exit_code": 1}


# ── Contact tools ──

async def do_resolve_contact(content: str, owner: Optional[str] = None) -> Dict:
    """Look up a contact by name. Searches: CardDAV -> email history -> memory."""
    import httpx
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    name = args.get("name", "")
    if not name:
        return {"error": "name is required", "exit_code": 1}

    contacts = {}  # email -> {name, source}

    # 1. CardDAV (Radicale) — structured contacts. Call in-process: a
    # server-side httpx GET to /api/contacts/search carries no session
    # cookie and would 401 under require_user.
    try:
        import asyncio
        from routes import contacts_routes as cc
        all_contacts = await asyncio.to_thread(cc._fetch_contacts)
        q = name.lower()
        for c in (all_contacts or []):
            hay_name = (c.get("name") or "").lower()
            match = q in hay_name or any(q in (e or "").lower() for e in c.get("emails", []))
            if not match:
                continue
            for email in (c.get("emails") or []):
                email = (email or "").strip().lower()
                if email and "@" in email:
                    contacts[email] = {"name": c.get("name") or email, "source": "contacts"}
    except Exception:
        pass

    async with httpx.AsyncClient(timeout=30) as client:
        # 2. Email history (sent/received)
        try:
            resp = await client.get(f"{_INTERNAL_BASE}/api/email/resolve-contact", params={"name": name})
            if resp.status_code == 200:
                for c in (resp.json().get("contacts") or []):
                    email = (c.get("email") or "").strip().lower()
                    if email and email not in contacts:
                        contacts[email] = {"name": c.get("name") or email, "source": "email history"}
        except Exception:
            pass

    if not contacts:
        return {"output": f"No contacts found matching '{name}'.", "exit_code": 0}

    lines = [f"Contacts matching '{name}':"]
    for email, info in contacts.items():
        lines.append(f"- {info['name']} <{email}> ({info['source']})")
    return {"output": "\n".join(lines), "exit_code": 0}


async def do_manage_contact(content: str, owner: Optional[str] = None) -> Dict:
    """Add / update / delete / list CardDAV contacts. Calls the contacts
    helpers IN-PROCESS rather than over HTTP — a server-side httpx call to
    /api/contacts/* carries no session cookie and would be rejected by
    require_user (401), so the tool would see zero contacts even though
    the browser-side UI works fine."""
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    action = (args.get("action") or "").strip().lower()
    try:
        from routes import contacts_routes as cc
    except Exception as e:
        return {"error": f"Contacts module unavailable: {e}", "exit_code": 1}
    # The contacts helpers are sync (httpx blocking calls to CardDAV) — run
    # them in a thread so we don't block the event loop.
    import asyncio
    try:
        if action == "list":
            rows = await asyncio.to_thread(cc._fetch_contacts, True)
            if not rows:
                return {"output": "No contacts.", "exit_code": 0}
            lines = [f"{len(rows)} contacts:"]
            for c in rows:
                em = ", ".join(c.get("emails") or [])
                lines.append(f"- {c.get('name') or '(no name)'} <{em}>  [uid={c.get('uid','')}]")
            return {"output": "\n".join(lines), "exit_code": 0}

        if action == "add":
            email = (args.get("email") or "").strip()
            if not email:
                return {"error": "email is required for add", "exit_code": 1}
            name = (args.get("name") or "").strip() or email.split("@")[0]
            # Dedupe by email (same as the /add route).
            existing = await asyncio.to_thread(cc._fetch_contacts)
            for c in existing:
                if email.lower() in [e.lower() for e in c.get("emails", [])]:
                    return {"output": f"{email} is already a contact ({c.get('name','')}).", "exit_code": 0}
            ok = await asyncio.to_thread(cc._create_contact, name, email)
            return {"output": f"{'Added' if ok else 'Failed to add'} {name} <{email}>.", "exit_code": 0 if ok else 1}

        if action in ("update", "edit"):
            uid = (args.get("uid") or "").strip()
            if not uid:
                return {"error": "uid is required for update (use action=list to find it)", "exit_code": 1}
            name = (args.get("name") or "").strip()
            emails = args.get("emails")
            if emails is None and args.get("email"):
                emails = [args["email"]]
            emails = [e.strip() for e in (emails or []) if e and e.strip()]
            phones = [p.strip() for p in (args.get("phones") or []) if p and p.strip()]
            if not name and not emails:
                return {"error": "Provide a name or emails to update", "exit_code": 1}
            if not name and emails:
                name = emails[0].split("@")[0]
            ok = await asyncio.to_thread(cc._update_contact, uid, name, emails, phones)
            return {"output": "Contact updated." if ok else "Update failed.", "exit_code": 0 if ok else 1}

        if action == "delete":
            uid = (args.get("uid") or "").strip()
            if not uid:
                return {"error": "uid is required for delete (use action=list to find it)", "exit_code": 1}
            ok = await asyncio.to_thread(cc._delete_contact, uid)
            return {"output": "Contact deleted." if ok else "Delete failed.", "exit_code": 0 if ok else 1}

        return {"error": f"Unknown action '{action}'. Use list, add, update, or delete.", "exit_code": 1}
    except Exception as e:
        return {"error": f"Contact operation failed: {e}", "exit_code": 1}


# ── Vaultwarden / Bitwarden CLI tools ──

def _load_vault_config() -> Dict:
    """Load Vaultwarden config from data/vault.json."""
    from pathlib import Path
    p = Path("data/vault.json")
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


async def _run_bw(args: list, session: Optional[str] = None, input_text: Optional[str] = None) -> tuple:
    """Run a bw CLI command with optional session + stdin. Returns (stdout, stderr, returncode)."""
    import asyncio
    env = {}
    import os as _os
    env.update(_os.environ)
    if session:
        env["BW_SESSION"] = session

    proc = await asyncio.create_subprocess_exec(
        "bw", *args,
        stdin=asyncio.subprocess.PIPE if input_text else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    stdout, stderr = await proc.communicate(input=input_text.encode() if input_text else None)
    return stdout.decode(errors="replace").strip(), stderr.decode(errors="replace").strip(), proc.returncode


async def do_vault_search(content: str, owner: Optional[str] = None) -> Dict:
    """Search the vault by keyword. Returns matching item names + URLs, NO passwords."""
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    query = args.get("query", "").strip()
    if not query:
        return {"error": "query is required", "exit_code": 1}

    cfg = _load_vault_config()
    session = cfg.get("session")
    if not session:
        return {"error": "Vault is locked. Run vault_unlock or provide session key in settings.", "exit_code": 1}

    stdout, stderr, rc = await _run_bw(["list", "items", "--search", query], session=session)
    if rc != 0:
        return {"error": f"bw failed: {stderr[:300]}", "exit_code": 1}

    try:
        items = json.loads(stdout)
    except json.JSONDecodeError:
        return {"error": "Failed to parse bw output", "exit_code": 1}

    if not items:
        return {"output": f"No vault items match '{query}'.", "exit_code": 0}

    lines = [f"Found {len(items)} item(s) matching '{query}':"]
    for it in items[:20]:
        item_id = it.get("id", "?")
        name = it.get("name", "?")
        login = it.get("login") or {}
        username = login.get("username", "")
        uris = login.get("uris") or []
        url = uris[0].get("uri", "") if uris else ""
        parts = [f"[{item_id[:8]}] {name}"]
        if username:
            parts.append(f"user: {username}")
        if url:
            parts.append(f"url: {url}")
        lines.append("- " + " · ".join(parts))
    lines.append("\nUse vault_get(item_id, reason) to retrieve the password.")
    return {"output": "\n".join(lines), "exit_code": 0}


async def do_vault_get(content: str, owner: Optional[str] = None) -> Dict:
    """Retrieve a full vault entry (including password) by item ID. Logs access to assistant chat."""
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    item_id = args.get("item_id", "").strip()
    reason = args.get("reason", "").strip()
    if not item_id:
        return {"error": "item_id is required", "exit_code": 1}
    if not reason:
        return {"error": "reason is required — explain WHY you need this password", "exit_code": 1}

    cfg = _load_vault_config()
    session = cfg.get("session")
    if not session:
        return {"error": "Vault is locked. Unlock first.", "exit_code": 1}

    stdout, stderr, rc = await _run_bw(["get", "item", item_id], session=session)
    if rc != 0:
        return {"error": f"bw failed: {stderr[:300]}", "exit_code": 1}

    try:
        item = json.loads(stdout)
    except json.JSONDecodeError:
        return {"error": "Failed to parse bw output", "exit_code": 1}

    login = item.get("login") or {}
    name = item.get("name", "?")

    # Audit log to assistant chat
    try:
        from src.assistant_log import log_to_assistant
        if owner:
            log_to_assistant(
                owner,
                f"Retrieved password for **{name}** — reason: {reason}",
                category="Vault",
            )
    except Exception:
        pass

    output = [
        f"Vault item: {name}",
        f"Username: {login.get('username', '(none)')}",
        f"Password: {login.get('password', '(none)')}",
    ]
    if login.get("totp"):
        output.append(f"TOTP secret: {login['totp']}")
    uris = login.get("uris") or []
    if uris:
        output.append("URLs: " + ", ".join(u.get("uri", "") for u in uris))
    if item.get("notes"):
        output.append(f"Notes: {item['notes']}")

    return {"output": "\n".join(output), "exit_code": 0}


async def do_vault_unlock(content: str, owner: Optional[str] = None) -> Dict:
    """Unlock the vault using a master password. Stores the resulting session key."""
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    master_password = args.get("master_password", "")
    if not master_password:
        return {"error": "master_password is required", "exit_code": 1}

    # Do not pass the master password as an argv element. Local process lists
    # can expose argv to other users; stdin keeps the secret out of `ps`.
    stdout, stderr, rc = await _run_bw(["unlock", "--raw"], input_text=master_password + "\n")
    if rc != 0:
        return {"error": f"Unlock failed: {stderr[:300]}", "exit_code": 1}

    session = stdout.strip()
    if not session:
        return {"error": "bw returned empty session", "exit_code": 1}

    # Save session to vault.json
    from pathlib import Path
    p = Path("data/vault.json")
    cfg = {}
    if p.exists():
        try:
            cfg = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            pass
    cfg["session"] = session
    from datetime import datetime as _dt
    cfg["unlocked_at"] = _dt.utcnow().isoformat()
    p.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    try:
        import os as _os
        _os.chmod(str(p), 0o600)
    except Exception:
        pass

    return {"output": "Vault unlocked. Session saved.", "exit_code": 0}


# --- Big Brother game engine tools ------------------------------------------
# Thin wrappers over the Vault-free engine MCP client (src/orwell_engine.py). The
# engine decides outcomes and enforces the Vault Wall; we only relay Vault-free
# results back to the model so it can narrate as the game master.

async def do_get_game_state(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        st = await orwell_engine.get_game_state(user=owner)
        return {"output": json.dumps(st, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine unreachable: {e}", "exit_code": 1}


async def do_run_competition(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        args = _parse_tool_args(content) if content and content.strip() else {}
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    # ORW-220: PRODUCTION OWNS THE SCHEDULE on this lever too. The engine's runCompetition PREVIEWS the current competition (type, name, winner); while the pre-resolve is
    # holding a not-yet-due scheduled event the narrator must not learn it early (live 11-06 07:29:58 it got the first HOH comp's name and winner in the same batch where advanceGame
    # returned held). Same `held` shape as do_advance_game; the engine is not called and no outcome is returned.
    try:
        from routes import chat_helpers as _ch_gate
        if _ch_gate.scheduled_event_is_held(owner):
            return {"output": json.dumps({"held": True, "note": "Production hasn't called the house in yet - the competition is set for later today and has not been "
                                          "drawn for the house. There is no result to report. Stay in the scene and keep the houseguests talking; do NOT narrate the "
                                          "competition or name a winner, and do not call runCompetition again until the production calls the house in."}),
                    "exit_code": 0}
    except Exception:
        pass
    try:
        res = await orwell_engine.run_competition(args.get("type"), args.get("participantIds"), user=owner)
        if not res.get("started"):
            return {"error": "No game in progress — create a character first.", "exit_code": 1}
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_record_interaction(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    text = (args.get("content") or args.get("text") or "").strip()
    if not text:
        return {"error": "content is required (what happened in the scene)", "exit_code": 1}
    # ADR 0005: an OPTIONAL Vault-free consequence descriptor (which edges move, which way, with what
    # relative emphasis) rides alongside `kind`. Forward it ONLY when it is actually a dict — a
    # malformed shape is ignored silently (the engine also guards, but we never forward junk).
    _consequence = args.get("consequence")
    if not isinstance(_consequence, dict):
        _consequence = None
    # Phase 2 (duration-based clock): the LLM's proposal for how long the scene FELT, in in-game minutes.
    # Forward only a positive number; the engine clamps it and advances the day clock (pacing-only).
    _felt = args.get("feltMinutes")
    _felt = _felt if isinstance(_felt, (int, float)) and _felt > 0 else None
    # ORW-104: the model-driven path carries the same closed-set casual assurance / heard-about-me descriptors as the belt (validated against the scene's own withIds; no number crosses).
    from src.agent_loop import _validate_assurance, _validate_heard_about_me
    _with = [w for w in (args.get("withIds") or []) if isinstance(w, str)] if isinstance(args.get("withIds"), list) else []
    _assure_raw = args.get("assurance")
    if isinstance(_assure_raw, dict) and "by" not in _assure_raw and isinstance(_assure_raw.get("from"), str):
        _assure_raw = {**_assure_raw, "by": _assure_raw["from"]}
    _hear_raw = args.get("heardAboutMe")
    if isinstance(_hear_raw, dict) and "by" not in _hear_raw and isinstance(_hear_raw.get("from"), str):
        _hear_raw = {**_hear_raw, "by": _hear_raw["from"]}
    _assurance = _validate_assurance(_assure_raw, _with)
    _heard = _validate_heard_about_me(_hear_raw, _with)
    try:
        res = await orwell_engine.record_interaction(
            text, with_ids=args.get("withIds"), kind=args.get("kind"),
            consequence=_consequence, felt_minutes=_felt, user=owner,
            **({"assurance": _assurance} if _assurance else {}),
            **({"heard_about_me": _heard} if _heard else {}),
        )
        # ORW-188: a recorded scene commits (bumps beatSeq) and the engine echoes the post-commit token. Adopt it (the belt path already does) so a later mutating
        # call this turn (advanceGame) does not carry a stale token and 409.
        await _refresh_after_model_progression(owner, res)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_surface_information(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    info = (args.get("information") or "").strip()
    pathway = (args.get("pathway") or "").strip()
    if not info or not pathway:
        return {"error": "information and pathway are both required", "exit_code": 1}
    try:
        res = await orwell_engine.surface_information(info, pathway, user=owner)
        await _refresh_after_model_progression(owner, res)  # adopt the post-commit beatSeq the engine echoes (no stale-beat 409 on the next call this turn)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_game_status(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        res = await orwell_engine.game_status(user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine unreachable: {e}", "exit_code": 1}


async def do_get_visible_state(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        res = await orwell_engine.get_visible_state(user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine unreachable: {e}", "exit_code": 1}


async def do_social_read(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        args = _parse_tool_args(content) if content and content.strip() else {}
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    try:
        res = await orwell_engine.social_read(args.get("target"), user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_ask_producers(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    question = (args.get("question") or args.get("content") or "").strip()
    if not question:
        return {"error": "question is required", "exit_code": 1}
    try:
        res = await orwell_engine.ask_producers(question, user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_render_scene(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        args = _parse_tool_args(content) if content and content.strip() else {}
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    try:
        res = await orwell_engine.render_scene(args.get("mode"), user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_end_of_session_summary(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        res = await orwell_engine.end_of_session_summary(user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine unreachable: {e}", "exit_code": 1}


# #1713 — the top-level WALL-CLOCK BACKSTOP on the inline pre-finalize genesis kick below. Each
# per-NPC authoring stream is now individually bounded (`orwell_cast_authoring._bounded_stream`), but
# genesis runs up to 15 of those in bounded-concurrency waves with its own bounded re-roll — this is a
# second, structural belt so the createCharacter→premiere turn can NEVER hang anywhere near the
# multi-minute range even in a worst-case multi-retry pileup under contention (the diagnosed root
# cause of issue #1713: the FE was observed idle-waiting on this exact inline call, well before the
# engine's own createCharacter was ever invoked). `run_genesis` shields its inner task from the
# awaiter's cancellation, so a timeout here releases THIS turn onto the deterministic floor (byte-
# identical to any other genesis failure) while the grind keeps running in the background — idempotent,
# and a later kick simply awaits it or finds it already committed.
_GENESIS_WALL_CLOCK_BACKSTOP_S = 90.0


async def do_create_character(
    content: str, owner: Optional[str] = None,
    progress_cb: Optional[Callable[[Dict], Awaitable[None]]] = None,
) -> Dict:
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    # 0050: the name may already be on file from the interview (updateCasting) — the engine
    # finalizes from its intake and rejects with a clear message if no name exists anywhere.
    player_name = (args.get("playerName") or "").strip() or None
    confirm_restart = bool(args.get("confirmRestart"))
    keep_character = bool(args.get("keepCharacter"))  # 0056: carry the same houseguest into the next season
    # Restart-door backstop — error-correct the model the way the stall-nudge / auto-record do.
    # The model reliably FAILS to pass confirmRestart when the player asks to "play again" after a
    # season ends: it calls createCharacter repeatedly and every call no-ops (B36 guard), stranding
    # the player on the finished season (observed live — 6 no-op calls, then it gave up). When the
    # season is OVER (a winner was crowned — the moment is "post-season", so there is nothing left to
    # lose), a createCharacter IS the restart: confirm it. NEVER auto-confirm over a LIVE/unfinished
    # season — that would wipe an ongoing game out from under the player; there the flag stays explicit
    # (a mid-season "reset progress" is red-zone-only, never from chat). A chat "run it back" is a
    # NEXT season exactly like the menu's button — so when it fires we advance the per-user season
    # counter too (0057 parity), keeping the two paths consistent.
    restarting_post_season = False
    try:
        state = await orwell_engine.get_game_state(user=owner)
        if isinstance(state, dict) and state.get("started") and state.get("moment") == "post-season":
            restarting_post_season = True  # a chat "run it back" = a next season → advance the counter
            confirm_restart = True          # post-season createCharacter IS the restart
    except Exception:
        pass  # state probe is best-effort; never block a legitimate first-time creation
    # #1313 — is the HOUSE-ENTRY authoring gate active for this start? ON iff a real utility
    # model resolves (cast authoring CAN run) and the operator hasn't set
    # ORWELL_ALLOW_FLOOR_START=1. Computed BEFORE the create (#1336 residual 1): the gate
    # decision only resolves the utility model — independent of the create result — and hoisting
    # it lets the hold marker be stamped SYNCHRONOUSLY with the committed create result below
    # (no await in between), so a concurrent /status or /state poll can never land in the gap
    # between the engine flipping started=True and the overlay latch engaging.
    _gate_on = False
    try:
        from src import orwell_cast_authoring as _authoring_gate
        _gate_on = await _authoring_gate.house_entry_gate_active(owner)
    except Exception:
        _gate_on = False
    _floor_shoot_ok = not _gate_on
    # STRICT enrichment policy (owner directive 2026-07-11): game creation is REFUSED loudly when an
    # enrichment call class has no model wired — a clear, player-visible error naming the unwired
    # class(es), surfaced the way every other creation error surfaces (the tool error path), plus an
    # admin-log/ledger entry per class. NEVER a silent deterministic-floor season. Under `soft` (the
    # test lanes, the golden driver, the smokes — all env-pinned) this block is inert, byte-identical
    # to the legacy fail-soft start. The check itself is fail-open: a policy-machinery hiccup must
    # never block a legitimate creation (strict is a guardrail, not a new failure mode).
    try:
        from src import enrichment_policy as _enrichment
        if _enrichment.is_strict():
            _unwired = await _enrichment.preflight_unwired(owner)
            if _unwired:
                for _cls in _unwired:
                    _enrichment.record_failure(
                        owner, _cls, "game creation refused — no model wired for this class at creation time")
                # 2026-07-12: the refusal carries a STRUCTURED marker + the unwired classes so
                # the agent loop can surface an operator-actionable production note (the player
                # must never just see in-fiction stalling) — see _creation_no_model_steer in
                # agent_loop.py. The error text itself already names the one-step fix.
                return {"error": _enrichment.creation_refusal_message(_unwired), "exit_code": 1,
                        "refusalKind": "no-model-wired", "unwiredClasses": list(_unwired)}
    except Exception as e:
        logger.warning("[enrichment] strict creation preflight failed open for %s: %s", owner, e)
    # 0116 — model-author the whole cast SKELETON BEFORE finalize (skeleton-first). recordCastGenesis is
    # a PRE-GAME operation (refused once the season runs), so genesis must land on the pre-warm BEFORE
    # create_character. Kicked HERE so it runs in EVERY finalize path (the browser interview-open pre-warm
    # `prewarm_cast` also fires it early to overlap the interview — run_genesis is idempotent per (user,
    # seed), so this is a no-op when the pre-warm already committed it, and the REAL work when the pre-warm
    # route was never hit, e.g. the HTTP/golden flow). Ensure the cast is warmed first (idempotent). Best-
    # effort + fail-soft: no model ⇒ the deterministic floor stands byte-identically; under strict a failure
    # latches the loud gate below. Never blocks start on a hiccup (the outer try/except owns that).
    #
    # 2026-07-16 audit item 4 (production-hold beat) — this inline genesis fallback (15 sequential
    # LLM calls when the interview-open pre-warm never ran, e.g. the HTTP/golden flow) can block
    # ~70s with NOTHING but a spinner on the "🎬 Casting" tool-beat chip — a live playthrough reads
    # that as the app having died, not "production is working". `progress_cb` is the SAME seam
    # `execute_tool_block` already threads to bash/python for its `tool_progress` SSE events (see
    # `tool_execution.py`); reuse it here for ONE short, diegetic, producer-register status line
    # BEFORE the blocking await — never narration content, just a status beat riding the existing
    # tool-beat chip machinery (chat.js renders `tail` under the running beat). Best-effort: a
    # progress push failing must never affect creation.
    if progress_cb:
        try:
            await progress_cb({
                "tail": "The house is being prepped for your arrival — hold tight, we're rolling cameras.",
            })
        except Exception:
            pass
    # T0-6: hoisted so the FALLBACK deep-authoring kick further down (the prewarm-missed path) can
    # thread the SAME season seed into `kickoff_authoring` — the FacetLedger mint needs it to align
    # with whatever genesis just dealt off this exact seed. `None` when the try below never lands
    # (genesis kick failed open) ⇒ authoring simply runs without ledger steering (byte-identical).
    _cast_seed = None
    try:
        from src import orwell_cast_genesis as _genesis_kick
        _warm = await orwell_engine.pre_seed_cast(seed=args.get("seed"), user=owner)
        if isinstance(_warm, dict) and _warm.get("warmed") and _warm.get("house"):
            _cast_seed = _warm.get("seed")
            # #1713: bounded by _GENESIS_WALL_CLOCK_BACKSTOP_S (see comment above) — never let this
            # inline grind hold the player's turn anywhere near the old multi-minute worst case.
            await asyncio.wait_for(
                _genesis_kick.run_genesis(_warm.get("house") or [], _cast_seed, owner),
                timeout=_GENESIS_WALL_CLOCK_BACKSTOP_S,
            )
    except Exception as e:
        logger.warning("[cast-genesis] pre-finalize genesis kick failed open for %s: %s", owner, e)
    # 0116 — the model-authored cast-genesis LOUD PRE-FINALIZE GATE (§4 / #1313 precedent). Genesis
    # model-authored the whole cast SKELETON just above (or during the interview on the pre-warm), so its
    # outcome is known BEFORE finalize. Under the strict policy, if that genesis run FAILED (ended on the
    # deterministic floor after the bounded re-rolls), REFUSE casting finalize here — never start on a
    # generic floor skeleton, and never discover the failure only AFTER the player commits their character.
    # Fail-open: a gate hiccup must never strand a legitimate creation.
    try:
        from src import enrichment_policy as _enrichment_g
        from src import orwell_cast_genesis as _genesis_gate
        if _enrichment_g.is_strict() and _genesis_gate.strict_failed(owner):
            _enrichment_g.record_failure(
                owner, "cast-genesis",
                "casting finalize refused — the cast skeleton could not be model-authored (genesis failed)")
            return {"error": _genesis_gate.refusal_message(), "exit_code": 1}
    except Exception as e:
        logger.warning("[enrichment] strict genesis pre-finalize gate failed open for %s: %s", owner, e)
    try:
        res = await orwell_engine.create_character(
            player_name,
            archetype=args.get("archetype"),
            strategy_style=args.get("strategyStyle"),
            # Casting-interview deepeners (0050): the producer's distillation of the
            # player's own answers — they seed the engine's Character/Soul datastore.
            persona_archetype=args.get("personaArchetype"),
            persona_strategy_style=args.get("personaStrategyStyle"),
            backstory=args.get("backstory"),
            motivation=args.get("motivation"),
            private_strategy=args.get("privateStrategy"),
            interview_notes=args.get("interviewNotes"),
            gender_presentation=args.get("genderPresentation"),
            seed=args.get("seed"),
            # The ONE sanctioned player-channel restart door (D1/R1): a confirmed play-again over a
            # finished/abandoned season delegates through the engine's registry.resetUser hinge.
            # Without this flag createCharacter no-ops on a started game (B36 guard), which left the
            # player unable to start season 2 from chat — the relay used to drop the confirm.
            confirm_restart=confirm_restart,
            keep_character=keep_character,  # 0056: carry the same houseguest forward when asked
            user=owner,
        )
        # #1336 residual (1) — the STATUS-POLL race latch. The engine season is live the instant
        # the create above commits, but the gate hold used to be marked only inside the gate block
        # further down — AFTER the portrait section's awaits — so a concurrent /status or /state
        # poll could land in that gap and claim a started game the player was told is still being
        # cast. Stamp the hold HERE, synchronously with receiving the committed result (zero awaits
        # in between), so the routes' _house_entry_overlay engages from the first possible poll.
        # The gate block below re-stamps it before the readiness wait (idempotent) and owns the
        # clear/refuse; the exception handler there also clears a stuck marker.
        if _gate_on and isinstance(res, dict) and res.get("started") and not res.get("createRefused"):
            try:
                _authoring_gate.begin_house_entry_hold(owner)
            except Exception:
                pass
        # D3/E66 + restart-door hygiene: a NEW season must not inherit the finished season's
        # decision card. The casting card carries no `pending`, so this clears _LAST_PENDING for
        # the user — without it, the restart door (createCharacter → registry.resetUser) leaves a
        # phantom card (e.g. last season's juror-vote, even under the old player's name) armed on
        # GET /api/orwell/status until the first advanceGame of season 2 overwrites it.
        orwell_engine.remember_pending(res, user=owner)
        # #1561 — createCharacter FINALIZE advances the engine beatSeq (season start + the premiere
        # fan-out), exactly like advanceGame/submitDecision/turnIn — but, unlike those, it never flowed
        # its committed result through `_refresh_beat_seq`. So the FE's last-seen token stayed at the
        # PRE-create value while the engine head moved (e.g. 58 -> 64), and the very first narration turn
        # attached a stale `expectedBeatSeq` → a stale-beat 409 + desync on turn 1 (the belts recovered it
        # after the fact; this removes it at the seam). Refresh last-seen from the committed result NOW —
        # between this settle and the first narration turn — so that first turn attaches the CURRENT beat.
        # Mirrors _refresh_after_model_progression for the other progression tools.
        if isinstance(res, dict) and res.get("started") and not res.get("createRefused"):
            try:
                # Call the RAISING refresh directly — NOT _refresh_after_model_progression, which is
                # fail-open (`except Exception: pass`) and would swallow a genuine failure so the #1599
                # WARNING below could never fire (a phantom guard). Bypassing the swallowing wrapper lets
                # a real failure propagate into this `except` and actually log. Mirrors _refresh_beat_seq
                # for the other progression tools.
                from routes import chat_helpers as _ch
                _ch._refresh_beat_seq(owner, res)
            except Exception as _beat_exc:
                # #1599 — the beatSeq refresh is the guard that PREVENTS a turn-1 desync; if it cannot
                # run, log at WARNING with disposition (the stale-beat auto-retry belt still recovers,
                # so it is corrected, not fatal) rather than swallowing it silently. A42: it also raises the
                # RED-eligible health event on /admin/status (an auto-corrected fault is still RED - #1599).
                logger.warning(
                    "[#1561] post-createCharacter beatSeq refresh failed for %s (turn-1 desync guard "
                    "degraded; the stale-beat retry belt still recovers): %s", owner, _beat_exc)
                try:
                    from src import log_rings as _lr
                    _lr.record_soft_failure("sync:post-create-beatseq", _beat_exc, corrected="stale-beat retry belt", user=owner)
                except Exception:
                    pass
        # 0057 parity: a chat "run it back" cleared the level exactly like the menu's New-season
        # button, so advance the per-user season counter too (the engine reset does NOT track it —
        # it lives in the FE store and survives the sandbox rotation). Mid-season resets never reach
        # here (they are red-zone-only), so this only ever counts a genuine next-season.
        if restarting_post_season and isinstance(res, dict) and res.get("started") and not res.get("createRefused"):
            try:
                from src import orwell_seasons
                orwell_seasons.increment_season(owner)
            except Exception:
                pass  # the counter is best-effort meta-progression; never fail the restart over it
        # 2026-07-16 audit item 1 — the FIRST-SEASON session-rename edge (see
        # chat_helpers.rename_canonical_session_for_season_start's docstring). Placed AFTER the
        # restart-path season increment just above so a season-2+ restart reads the FRESH number,
        # matching what the client-side M1-7 rename would compute. Best-effort/idempotent; a
        # hiccup here must never affect game start.
        if isinstance(res, dict) and res.get("started") and not res.get("createRefused"):
            try:
                from routes import chat_helpers as _ch_rename
                _ch_rename.rename_canonical_session_for_season_start(owner)
            except Exception:
                pass
        # L28b → 0051 pipeline. The cast is KNOWN the instant createCharacter returns — which,
        # in the chat-driven flow, is DURING the casting interview (the player still picks their
        # own headshot before house entry). So portraits must start generating in the BACKGROUND
        # right here, so the faces are ready BY MOVE-IN rather than trickling in after it.
        #
        # Timing fix: portraits used to be CHAINED behind full-cast authoring (`then=_portraits`).
        # Authoring is 15 sequential LLM calls; chaining behind it pushed the pictures to land
        # around/after house entry. We now (a) kick portrait generation off IMMEDIATELY from the
        # engine's seeded §3-depth facets (0058 Phase 1 — already concrete & distinctive, no LLM
        # needed), running in parallel with authoring; and (b) still run authoring in the
        # background and, once it lands its richer physical facets, refresh-generate any face not
        # yet on disk via the backfill (idempotent — a portrait already generated from the seeded
        # facet is never re-shot, so the immediate pass wins for the fast ones and the authored
        # facet only fills the slower ones). Both paths are best-effort: a missing model (chat OR
        # image) is a silent no-op and the game start NEVER blocks on either.
        # #1313 — the house-entry gate (`_gate_on`, computed above the create). When ON we (a) do
        # NOT immediately floor-shoot portraits from the seeded facets — that raced authoring and
        # won every time, so authored identities never reached the faces (ADR 0013 bypass); instead
        # each face follows its own per-NPC authoring gate; and (b) HOLD house entry below until the
        # cast is FULLY authored (15/15 — PO ruling 2026-07-10: the seeded floor is never a viable
        # cast identity in prod). When OFF (no model, or the escape hatch) authoring can never run,
        # so the deterministic floor IS the cast — floor-shoot immediately and start instantly,
        # byte-identical to before.
        try:
            prompts = res.get("portraitPrompts") if isinstance(res, dict) else None
            cast = res.get("house") if isinstance(res, dict) else None
            # #1842: engine-computed cast-identity auto-correction diagnostic → wire to health rollup
            cast_coherence = res.get("castCoherence") if isinstance(res, dict) else None
            if cast_coherence and isinstance(cast_coherence, dict):
                repaired = cast_coherence.get("repaired", 0)
                houseguests = cast_coherence.get("houseguests", [])
                if repaired and repaired > 0:
                    from src import enrichment_policy
                    ids = [h.get("id", "?") for h in houseguests if h.get("action") == "repaired"]
                    enrichment_policy.record_runtime_failure(
                        owner, "cast-coherence",
                        f"engine enforceCastCoherence repaired {repaired} houseguest(s) at game start — "
                        f"auto-corrected but RED-eligible per #1599",
                        detail=json.dumps({"repaired": repaired, "houseguests": ids})
                    )
            # (the player's name is intentionally NOT read here — cast authoring is player-independent)

            # 0065 — did author warm already run during the casting interview? If so, the engine just
            # ADOPTED the deeply-authored cast, and the gated portrait warm owns the faces (it shoots only
            # AFTER authoring fully finished). We must NOT shoot here from the seeded facets (that would
            # race authoring) NOR re-author (it's already done) — just ENSURE the gated portrait warm is
            # kicked (idempotent), so faces land even if the interview-open trigger was missed.
            prewarmed = False
            try:
                from src import orwell_prewarm
                prewarmed = orwell_prewarm.warm_state(owner).get("authorStarted", False)
            except Exception:
                prewarmed = False

            if prewarmed:
                # The gated portrait warm shoots only AFTER authoring fully finishes (ADR 0013), and it
                # DECLINES outright if author warm never actually started. #976: at unseal that left faces
                # deferred to the lazy cast-window backfill whenever the warm-gate no-op'd. So always TRY
                # the gated warm, then VERIFY it actually started portraits — if it declined / didn't
                # (portraitsStarted still false), fall through so generation begins at season start.
                # #1336 (the #976 fall-through's ADR-0013 carve-out, same class as the #1313 fallback
                # fix): the fall-through is SPLIT by the house-entry gate —
                #   • gate OFF (no utility model resolves / escape hatch): the deterministic floor IS
                #     the final cast, so the original unconditional seeded-facet kick fires (a floor
                #     face can never mismatch a later authored one) — byte-identical to before;
                #   • gate ON (a real utility model resolves): authoring CAN land richer identities,
                #     so NO floor face may be shot — each face follows the SAME per-NPC authoring gate
                #     (`on_authored`) the no-prewarm fallback uses. The decline means the prewarm's
                #     author warm never truly started, so nothing else owns authoring: (re-)kick it
                #     and shoot each face ONLY on its own authored write-back.
                # Idempotent (generate_and_store skips faces already on disk), budget-bounded (routes
                # through the standard pipeline), fail-soft (no image provider ⇒ silent no-op),
                # Vault-free (the same public-facet prompts).
                portraits_started = False
                try:
                    from src import orwell_prewarm
                    await orwell_prewarm.warm_portraits(owner)  # gated: never shoots before authoring done
                    portraits_started = bool(
                        orwell_prewarm.warm_state(owner).get("portraitsStarted", False))
                except Exception:
                    portraits_started = False
                if not portraits_started and prompts:
                    if _floor_shoot_ok:
                        try:
                            from src import orwell_portraits
                            orwell_portraits.kickoff_generation(prompts, owner)
                        except Exception:
                            pass  # immediate kick is best-effort — never let it affect game start
                    elif cast:
                        try:
                            from src import orwell_cast_authoring
                            from src import orwell_portraits

                            def _shoot_authored_prewarm(hid):
                                # ADR 0013: shoot THIS NPC's face the instant it is model-authored —
                                # refetch its (now authored) prompt via the backfill (idempotent).
                                try:
                                    orwell_portraits.kickoff_backfill([str(hid)], owner, force=True)
                                except Exception:
                                    pass
                            orwell_cast_authoring.kickoff_authoring(
                                cast, owner, then=None, on_authored=_shoot_authored_prewarm,
                                seed=_cast_seed)
                        except Exception:
                            pass  # best-effort — never let it affect game start
            else:
                # FALLBACK (no pre-warm — no model at casting open, or the trigger didn't fire): the
                # in-line pipeline. ADR 0013 (#1313): a face is shot ONLY from a MODEL-AUTHORED
                # identity. So the immediate seeded-floor kick fires ONLY when the gate is OFF (no
                # utility model / escape hatch ⇒ authoring can't run ⇒ the floor IS the final cast, so
                # a floor face can never mismatch a later authored one). When the gate is ON, authoring
                # WILL run, and each face follows its OWN per-NPC authoring gate (`on_authored`) — an
                # un-authored NPC gets NO photo (the lazy backfill shoots it once authoring lands).
                if prompts and _floor_shoot_ok:
                    from src import orwell_portraits
                    orwell_portraits.kickoff_generation(prompts, owner)
                if cast:
                    from src import orwell_cast_authoring
                    from src import orwell_cast_identity
                    from src import orwell_portraits

                    def _shoot_authored(hid):
                        # ADR 0013: shoot THIS NPC's face the instant it is model-authored — refetch its
                        # (now authored) prompt via the backfill (idempotent — skips a face on disk).
                        try:
                            orwell_portraits.kickoff_backfill([str(hid)], owner, force=True)
                        except Exception:
                            pass

                    def _refresh_authored_portraits():
                        # GATE-OFF top-up only: the seeded floor IS the final cast here, so fill any
                        # floor face not yet on disk after the immediate pass. (When the gate is ON this
                        # is NOT wired — floor-shooting an un-authored NPC would violate ADR 0013.)
                        try:
                            ids = []
                            for entry in (prompts or []):
                                if not isinstance(entry, dict):
                                    continue
                                hid = entry.get("houseguestId") or entry.get("id")
                                if hid and orwell_portraits.portrait_file(owner, hid) is None:
                                    ids.append(str(hid))
                            if ids:
                                orwell_portraits.kickoff_backfill(ids, owner, force=True)
                        except Exception:
                            pass

                    def _author_then_refresh():
                        # Deep authoring runs AFTER the AI identity seed has folded (so the authored look +
                        # secrets read the engine-validated heritage). Gate ON ⇒ per-NPC portrait gating
                        # (`on_authored`), NO floor top-up. Gate OFF ⇒ the floor top-up fills the faces
                        # (the original call shape, unchanged, so the seeded floor IS the final cast).
                        if _gate_on:
                            orwell_cast_authoring.kickoff_authoring(
                                cast, owner, then=None, on_authored=_shoot_authored, seed=_cast_seed)
                        else:
                            orwell_cast_authoring.kickoff_authoring(
                                cast, owner, then=_refresh_authored_portraits, seed=_cast_seed)

                    # #544 — AI-seed the cast's descriptive identity FIRST (engine validates/repairs/folds),
                    # THEN deep-author. Best-effort/fail-soft: no model ⇒ the engine's deterministic floor
                    # stands and `then` still chains authoring (which also degrades gracefully).
                    orwell_cast_identity.kickoff_identity(cast, owner, then=_author_then_refresh)
        except Exception:
            pass  # authoring + portraits are augmentation — never let them affect game start
        # #1313 — THE HOUSE-ENTRY GATE (P0): the game must NEVER start on the deterministic FLOOR cast.
        # When the gate is ON (a real utility model resolves + no escape hatch), HOLD the started
        # result until authoring lands the FULL cast (15/15 — no floor identity may enter the house).
        # 2026-07-13 (fast holding card): the turn waits only a SHORT inline grace — the happy path
        # (authoring already landed / just finishing) starts on this turn; otherwise the
        # "Production is finalizing your casting…" HOLDING card returns promptly (never minutes of a
        # silently spinning tool) with a health marker, and the background gate-clear watch owns the
        # rest — re-checking authoring, re-kicking stragglers, and opening the season the moment the
        # cast is ready. Only the watch's own expiry is the LOUD "house entry refused" failure.
        try:
            _started = isinstance(res, dict) and res.get("started") and not res.get("createRefused")
            if _started and _gate_on:
                from src import orwell_cast_authoring as _authoring_gate
                # The engine season is already LIVE the instant create_character commits — mark the
                # hold BEFORE waiting, so a concurrent /status or /state poll during the wait reports
                # the authoring/holding state (routes/_house_entry_overlay), never a started game.
                _authoring_gate.begin_house_entry_hold(owner)
                # 2026-07-13 (fast holding card — no dead air): the readiness wait used to run INLINE
                # for the FULL window (~180s) before ANY holding response reached the player — minutes
                # of a silently spinning tool. The PO design is card-promptly + background watch: wait
                # only a SHORT inline grace (the common "authoring just finishing" case still starts on
                # this turn), then return the holding card IMMEDIATELY and let the gate-clear watch own
                # the rest (it re-checks authoring, clears the marker, runs the deferred post-start
                # kicks exactly once, and pushes a game-updated so open pages reconcile the moment the
                # cast lands).
                ready = await _authoring_gate.await_house_ready(
                    owner, timeout=_authoring_gate.house_ready_inline_budget())
                if ready.get("ready"):
                    _authoring_gate.clear_house_entry_gate_block(owner)
                else:
                    # HOLDING is the normal path while authoring streams — the LOUD "house entry
                    # refused" failure (error log + strict enrichment ledger) now lives at the
                    # background watch's expiry, the point the wait has GENUINELY been exhausted.
                    logger.warning(
                        "[house-entry-gate] HOLDING house entry for %s — cast %s/%s authored; "
                        "returning the holding card and arming the background gate-clear watch "
                        "(set ORWELL_ALLOW_FLOOR_START=1 to override).",
                        owner, ready.get("authored"), ready.get("total"))
                    _authoring_gate.record_house_entry_gate_block(owner, ready)
                    # gap #3 belt-fire telemetry (docs/design/undercall-seam-structural.md §5;
                    # note_belt never raises)
                    _sync_ledger_note_belt(owner, "house-entry-gate-hold")
                    # The early holding return below SKIPS the post-start block (the 0062 zeitgeist
                    # capture). Arm the background gate-clear watch: it keeps polling authoring and,
                    # the moment the cast is ready, clears the holding overlay, runs the deferred
                    # zeitgeist kick EXACTLY ONCE (one watch per user; kickoff_capture is also
                    # once-per-season idempotent), and pushes a game-updated so open pages reconcile.
                    def _deferred_post_start():
                        # Two INDEPENDENT best-effort kicks — each guarded + logged on its own so a
                        # zeitgeist hiccup never silently skips the producer deepening, or vice-versa (#1599).
                        try:
                            from src import orwell_zeitgeist
                            orwell_zeitgeist.kickoff_capture(owner)
                        except Exception as e:  # noqa: BLE001 — best-effort; never block the gate-clear
                            logger.warning("[create] deferred zeitgeist kickoff failed: %s", e)
                        # #1626 (increment 3): deepen the off-camera producer persona in the
                        # background too — best-effort, no model ⇒ the seeded floor stands.
                        try:
                            from src import orwell_producer_authoring
                            orwell_producer_authoring.kickoff_producer_authoring(owner)
                        except Exception as e:  # noqa: BLE001 — persona flavor; never block anything
                            logger.warning("[create] deferred producer-authoring kickoff failed: %s", e)
                    _authoring_gate.kickoff_house_ready_watch(
                        owner, on_ready=_deferred_post_start)
                    holding = {
                        "started": False,
                        "castingHouse": {
                            "state": "authoring",
                            "authored": ready.get("authored"),
                            "total": ready.get("total"),
                            "missing": ready.get("missing"),
                        },
                        "message": (
                            "Production is still casting the house — your houseguests are being "
                            "written. Hang tight; the season opens the moment the cast is ready."),
                    }
                    try:
                        orwell_engine.remember_pending(holding, user=owner)
                    except Exception:
                        pass
                    return {"output": json.dumps(holding, indent=2), "exit_code": 0}
        except Exception as e:
            # The gate is a guardrail, not a new failure mode: a hiccup in the gate itself must never
            # strand a legitimately-started game. Log, drop any hold marker (a stuck overlay would
            # mask the genuinely-started season), and fall through to the normal started result.
            logger.warning("[house-entry-gate] gate check failed for %s: %s", owner, e)
            try:
                from src import orwell_cast_authoring as _authoring_gate
                _authoring_gate.clear_house_entry_gate_block(owner)
            except Exception:
                pass
        # 0062 — capture the REAL move-in zeitgeist (web_search) in the background, replacing the engine's
        # deterministic fallback ONCE per season. Best-effort: no model/search ⇒ the fallback stands. Gated
        # on a GENUINE start (never a no-op refusal of an already-running season), so it fires once per
        # season — including a confirmed restart (season 2 captures its own fresh, later snapshot).
        if isinstance(res, dict) and res.get("started") and not res.get("createRefused"):
            # 0062 zeitgeist + #1626-inc3 producer deepening: two INDEPENDENT best-effort background
            # kicks, each guarded + logged on its own so one failing never silently skips the other,
            # and a real failure surfaces at WARNING rather than being swallowed (#1599). Fires once per
            # GENUINE season start (never a no-op refusal of an already-running season).
            try:
                from src import orwell_zeitgeist
                orwell_zeitgeist.kickoff_capture(owner)
            except Exception as e:  # noqa: BLE001 — best-effort; never block game start
                logger.warning("[create] zeitgeist kickoff failed: %s", e)
            try:
                from src import orwell_producer_authoring
                orwell_producer_authoring.kickoff_producer_authoring(owner)
            except Exception as e:  # noqa: BLE001 — persona flavor; never block game start
                logger.warning("[create] producer-authoring kickoff failed: %s", e)
        # ORW-208: the engine substituted a strategy style the chosen archetype does not offer. Make it visible: a RED-eligible health note (an auto-corrected change is not a cloak)
        # and a plain line for the narrator so the casting card and the player are told the STORED style, never the one asked for.
        _out = json.dumps(res, indent=2)
        _adj = res.get("strategyStyleAdjusted") if isinstance(res, dict) else None
        if isinstance(_adj, dict) and _adj.get("applied"):
            try:
                from src import enrichment_policy as _ep_style
                _ep_style.record_runtime_failure(
                    owner, "casting-strategy-style",
                    f"engine stored strategy style '{_adj.get('applied')}' instead of the requested '{_adj.get('requested')}' "
                    f"(not offered by archetype '{_adj.get('archetype')}') - auto-corrected, RED-eligible per #1599",
                    detail=json.dumps(_adj))
            except Exception:
                pass
            _out += STRATEGY_STYLE_ADJUSTED_NOTE.format(applied=_adj.get("applied"), requested=_adj.get("requested"), archetype=_adj.get("archetype"))
        return {"output": _out, "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


STRATEGY_STYLE_ADJUSTED_NOTE = (
    "\n\nNOTE (engine truth): the stored strategy style is \"{applied}\" - the \"{archetype}\" archetype does not offer \"{requested}\", so the engine kept \"{applied}\". "
    "The casting card shows the stored style; tell the player plainly if they asked for \"{requested}\" and do not describe their strategy as \"{requested}\"."
)


async def do_update_casting(content: str, owner: Optional[str] = None) -> Dict:
    """0050: record casting-interview answers as they land; the engine returns the status."""
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    try:
        res = await orwell_engine.update_casting(args, user=owner)
        await _refresh_after_model_progression(owner, res)  # adopt a post-commit beatSeq if the engine echoes one (harmless otherwise)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


# CON-2/CON-3 — the model-driven progression tools (`advanceGame`/`submitDecision`) are the PRIMARY,
# sanctioned progression path (ADR 0003 — the model drives its own levers), yet they carried NO sync-
# spine tokens. Two consequences: (CON-2) a retried call after a socket timeout DOUBLE-ADVANCES the
# season (skips a staged eviction ballot, double-crowns a finale beat) — the "duplicate LLM response"
# symptom — because at-most-once (0065 Part B) was unused on the path that fires most; and (CON-3) the
# FE never refreshed its last-seen `beatSeq` after the MODEL advanced the engine, so any later FE-issued
# CAS call THE SAME TURN (the pre-resolve, `_auto_record_scene`) self-409'd against the moved board and
# stashed a SPURIOUS RE-GROUND directive even though nothing diverged.
#
# Fix: mint a STABLE idempotency key derived from the FE's own last-seen beat + the action kind, so the
# agent loop's retry of the SAME logical call (last-seen unchanged because its response was lost) reuses
# the key and the engine replays the original result instead of re-applying; attach the last-seen token
# as `expected_beat_seq`; and — critically — flow every response back through `_refresh_beat_seq`. A
# stale-beat 409 (a concurrent peer already moved the board) reconciles via the existing desync spine and
# returns the CURRENT board (never a second, unintended advance) — the two-window concurrency guard.
def _model_progression_cas(owner, action: str):
    """(expected_beat_seq, idempotency_key) for a model-driven progression call. The key is DETERMINISTIC
    in (game-key, action, last-seen beat) so a lost-response retry (last-seen still N) reuses it and the
    engine dedups; a genuine next advance (last-seen refreshed to N+1) mints a fresh key. Fail-open: any
    hiccup ⇒ (None, None) — byte-identical to the pre-fix unguarded call."""
    try:
        from routes import chat_helpers as _ch
        beat = _ch.last_beat_seq(owner)
        gkey = _ch._beat_seq_key(owner)
        key = f"m:{gkey}:{action}:{beat}"
        return beat, key
    except Exception:
        return None, None


async def _refresh_after_model_progression(owner, res) -> None:
    """CON-3 — track the new `beatSeq` the MODEL just advanced the engine to, so a later FE-issued CAS
    call the same turn never self-409s and never stashes a spurious RE-GROUND. Fail-open."""
    try:
        from routes import chat_helpers as _ch
        _ch._refresh_beat_seq(owner, res if isinstance(res, dict) else {})
    except Exception:
        pass


async def do_advance_game(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    # P4b — PRODUCTION OWNS THE SCHEDULE on the MODEL's own lever too: while this turn's pre-resolve is holding a not-yet-due scheduled event (the HOH comp on day-1 morning, a
    # ceremony before its hour), the model's advanceGame must not start it ("run the HOH competition", "let's go to nominations"). Nothing advances; the model gets an
    # in-fiction note. The pre-resolve's logged safety cap pops the hold, so a stuck clock can't freeze the game. The premiere count is NOT a hold here (the champagne-circle
    # close is the model's first advanceGame).
    try:
        from routes import chat_helpers as _ch_gate
        if _ch_gate.scheduled_event_is_held(owner):
            return {"output": json.dumps({"held": True, "note": "Production hasn't called the house in yet — the next scheduled event is set for later today. Stay in the scene "
                                          "and keep the houseguests talking; do NOT narrate it starting, and do not call advanceGame again until the production calls the house in."}),
                    "exit_code": 0}
    except Exception:
        pass
    # ORW-148 B: ONE staged-entrance arrival per player turn on the model's lever. Live 11-06 the narrator called advanceGame 3x in one reply
    # (each call releases another arrival), so the premiere fast-forwarded past what it voiced. Same `held` shape as above; the engine is not called.
    try:
        from routes import chat_helpers as _ch_ent
        if _ch_ent.premiere_release_already_this_turn(owner):
            return {"output": json.dumps({"held": True, "note": "One arrival per reply. An arrival was already released this turn — voice that arrival (who walked in, how the house "
                                          "reacts) FIRST, then wait for the player. Do not call advanceGame again this turn; the next arrival comes on the next beat."}),
                    "exit_code": 0}
    except Exception:
        pass
    try:
        _ebs, _ik = _model_progression_cas(owner, "advanceGame")
        try:
            res = await orwell_engine.advance_game(
                expected_beat_seq=_ebs, idempotency_key=_ik, user=owner)
        except orwell_engine.EngineToolError as _e:
            from routes import chat_helpers as _ch
            if not _ch._is_stale_beat_error(_e):
                raise  # any other engine error → the generic handler below
            # R3 / #1659 / audit A-S3: a stale-beat 409 is NOT a dead end. The old path reconciled and
            # RETURNED the current board without re-firing, so the model free-ran on a beat that never
            # committed. Refresh beatSeq + RE-FIRE ONCE against the reconciled token, reusing the SAME
            # idempotency key so the engine's at-most-once dedups a genuine double-apply (never a
            # double-advance). Mirrors the S1a/RC1 protocol the FE-issued pre-resolve advance already runs.
            async def _retry_advance(_fresh):
                return await orwell_engine.advance_game(
                    expected_beat_seq=_fresh, idempotency_key=_ik, user=owner)
            res = await _ch.retry_progression_after_stale(owner, _e, _retry_advance, action="advanceGame")
            if res is None:
                # The board moved AGAIN under the retry (already reconciled + RED-with-disposition +
                # ledger-visible): reconcile to the live board rather than force a second advance.
                _cur = await orwell_engine.get_game_state(user=owner)
                orwell_engine.remember_pending(_cur, user=owner)
                return {"output": json.dumps(_cur, indent=2), "exit_code": 0}
            # else: the retry LANDED — fall through to the shared post-advance handling below.
        if isinstance(res, dict) and res.get("held") and not res.get("event"):
            # ORW-116 (b), Ryne: the engine will not roll the NIGHT on its own. Nothing committed; tell the narrator in plain words instead of leaving a bare typed `held`.
            return {"output": json.dumps({"held": True, "note": "The night is the player's. The house is still up and nothing advances overnight: stay in the scene, keep the evening and night social, and let the player turn in (or the house wake at 8am) before the next day begins. Do not narrate a new day or any ceremony."}),
                    "exit_code": 0}
        await _refresh_after_model_progression(owner, res)  # CON-3
        try:
            from routes import chat_helpers as _ch_mark
            _ch_mark.mark_premiere_release(owner)  # ORW-148 B: this turn's one staged-entrance release is spent
        except Exception:
            pass
        orwell_engine.remember_pending(res, user=owner)  # D3/E66: the card survives a reload
        # 0070: an advance runs the bounded off-screen tick, which may record new HIDDEN NPC-to-NPC
        # scenes. Fire-and-forget their FE-driven prose enrichment — best-effort, never blocks the
        # advance, and a silent no-op when no utility model resolves (the deterministic template stands).
        try:
            from src import orwell_offscreen_texture
            orwell_offscreen_texture.kickoff_enrich(owner)
        except Exception:  # pragma: no cover - defensive: enrichment must never break an advance
            pass
        # #1400: an advance may resolve a staged competition (its roll commits up front). Fire-and-forget
        # the FE-driven competition-fiction author — best-effort, never blocks the advance, a silent no-op
        # when generation is off / no comp resolved / no utility model (the deterministic 0042 floor stands).
        try:
            from src import orwell_gen_competitions
            orwell_gen_competitions.kickoff_fiction(owner)
        except Exception:  # pragma: no cover - defensive: generation must never break an advance
            pass
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_submit_decision(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    kind = (args.get("kind") or "").strip()
    # Mirror the engine's SubmitDecisionReq kinds (src/ports/GameSession.ts) exactly — the engine
    # validates legality; the relay must never be the thing that makes a pending kind unplayable.
    _DECISION_KINDS = orwell_engine.DECISION_KINDS  # ONE source (orwell_engine.DECISION_KINDS)
    if kind not in _DECISION_KINDS:
        return {"error": f"kind must be one of: {', '.join(sorted(_DECISION_KINDS))}", "exit_code": 1}
    # PO ruling 2026-11-03: a big irreversible choice binds ONLY on the player's own confirm on its card — the
    # model may not commit it from prose. Refused BEFORE any engine call; nothing is submitted or changed.
    if kind in orwell_engine.CARD_ONLY_KINDS:
        return {"error": (f"Not submitted: '{kind}' is a binding choice that only the player's own confirm on its "
                          "decision card can commit. Present the choice (the pending decision's prompt and legal "
                          "options) in the scene and WAIT for the card — do not narrate past it."),
                "exit_code": 1}
    decision: dict = {"kind": kind}
    for k in ("choice", "use", "save", "replacement", "vote", "statement", "appeal", "intent", "confirmed"):
        if args.get(k) is not None:
            decision[k] = args[k]
    try:
        # CON-2/CON-3: attach the sync-spine tokens (stable idempotency key keyed on the DECISION KIND so
        # sequential same-kind decisions — comp-round drips, per-juror votes — never collide) and refresh
        # last-seen from the response. A stale-beat 409 reconciles and returns the current board.
        _ebs, _ik = _model_progression_cas(owner, "submitDecision:" + kind)
        try:
            res = await orwell_engine.submit_decision(
                decision, expected_beat_seq=_ebs, idempotency_key=_ik, user=owner)
        except orwell_engine.EngineToolError as _e:
            from routes import chat_helpers as _ch
            if not _ch._is_stale_beat_error(_e):
                raise
            # R3 / #1659 / audit A-S3: refresh beatSeq + RE-FIRE the decision ONCE against the reconciled
            # token, reusing the SAME (kind-keyed) idempotency key so the engine's at-most-once dedups a
            # double-apply. A persistent stale reconciles to the live board (RED-with-disposition, ledger-
            # visible) rather than leaving the decision un-applied and the model free-running.
            async def _retry_submit(_fresh):
                return await orwell_engine.submit_decision(
                    decision, expected_beat_seq=_fresh, idempotency_key=_ik, user=owner)
            res = await _ch.retry_progression_after_stale(owner, _e, _retry_submit, action="submitDecision")
            if res is None:
                _cur = await orwell_engine.get_game_state(user=owner)
                orwell_engine.remember_pending(_cur, user=owner)
                return {"output": json.dumps(_cur, indent=2), "exit_code": 0}
            # else: the retry LANDED — fall through to the shared post-decision handling below.
        await _refresh_after_model_progression(owner, res)  # CON-3
        orwell_engine.remember_pending(res, user=owner)  # D3/E66: bound ⇒ the cache clears
        # #1400: a comp-round approach RESOLVES the staged competition (its roll commits). Fire-and-forget
        # the competition-fiction author — best-effort, never blocks; a silent no-op unless generation is
        # on AND a comp resolved AND a utility model resolves (else the deterministic 0042 floor stands).
        try:
            from src import orwell_gen_competitions
            orwell_gen_competitions.kickoff_fiction(owner)
        except Exception:  # pragma: no cover - defensive: generation must never break a decision
            pass
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_request_self_eviction(content: str, owner: Optional[str] = None) -> Dict:
    # 0061 step 1: a clear OOC intent to leave raises the confirmation (no state change; the house
    # never hears it). The player's own explicit confirm (the card → submitDecision) is what binds.
    from src import orwell_engine
    try:
        res = await orwell_engine.request_self_eviction(user=owner)
        orwell_engine.remember_pending(res, user=owner)  # surface the confirm card on reload too
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_turn_in(content: str, owner: Optional[str] = None) -> Dict:
    # ADR 0006 (#1385): the player's bedtime lever. The ENGINE ends the night and folds the hidden,
    # bounded rest penalty (the FE never authors the sleep effect — the Vault Wall + the
    # never-a-number-crosses invariant hold); we only surface the call. The result is an AdvanceView
    # that MAY carry a Vault-free dailyRecap (0102) for the day that just closed — returned inline
    # (the whole view, verbatim) so the narrator voices it, mirroring how the ceremony/eviction beats
    # return their content on the advance result. A no-op AdvanceView when the in-game clock isn't running.
    from src import orwell_engine
    try:
        # CON-2/CON-3: turnIn is a mutating PROGRESSION, so it carries the SAME sync-spine guard as
        # advanceGame/submitDecision — attach the deterministic (game-key, action, last-seen beat)
        # idempotency key + last-seen beatSeq so a retried/duplicate model call is REPLAYED, not
        # re-executed (the engine never re-stamps the rest penalty on the second call).
        _ebs, _ik = _model_progression_cas(owner, "turnIn")
        try:
            res = await orwell_engine.turn_in(
                expected_beat_seq=_ebs, idempotency_key=_ik, user=owner)
        except orwell_engine.EngineToolError as _e:
            from routes import chat_helpers as _ch
            if not _ch._is_stale_beat_error(_e):
                raise  # any other engine error → the generic handler below
            # R3 / #1659 / audit A-S3: refresh beatSeq + RE-FIRE turnIn ONCE against the reconciled token,
            # reusing the SAME idempotency key so the engine's at-most-once never re-ends the night (never
            # re-stamps the rest penalty). A persistent stale reconciles to the live board (RED-with-
            # disposition, ledger-visible) rather than leaving the night un-ended and the model free-running.
            async def _retry_turn_in(_fresh):
                return await orwell_engine.turn_in(
                    expected_beat_seq=_fresh, idempotency_key=_ik, user=owner)
            res = await _ch.retry_progression_after_stale(owner, _e, _retry_turn_in, action="turnIn")
            if res is None:
                _cur = await orwell_engine.get_game_state(user=owner)
                orwell_engine.remember_pending(_cur, user=owner)
                return {"output": json.dumps(_cur, indent=2), "exit_code": 0}
            # else: the retry LANDED — fall through to the shared post-turnIn handling below.
        await _refresh_after_model_progression(owner, res)  # CON-3: keep last-seen beatSeq fresh (turnIn mutates)
        orwell_engine.remember_pending(res, user=owner)     # D3/E66: any pending survives a reload (no-op if none)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


# --- God Mode / admin (0016) — execution is gated to admins by _ADMIN_TOOLS in tool_execution ---

async def do_inspect_non_vault_state(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        res = await orwell_engine.inspect_non_vault_state(user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine unreachable: {e}", "exit_code": 1}


async def do_sandbox_health(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        res = await orwell_engine.sandbox_health(user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine unreachable: {e}", "exit_code": 1}


async def do_override_mechanic(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    mechanic = (args.get("mechanic") or "").strip()
    if not mechanic or "value" not in args:
        return {"error": "mechanic and value are both required", "exit_code": 1}
    try:
        res = await orwell_engine.override_mechanic(mechanic, args.get("value"), user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_configure_game(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    settings = args.get("settings")
    if not isinstance(settings, dict) or not settings:
        return {"error": "settings (a non-empty object of non-Vault tunables) is required", "exit_code": 1}
    try:
        res = await orwell_engine.configure_game(settings, user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_social_initiatives(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        res = await orwell_engine.social_initiatives(user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_season_recap(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        res = await orwell_engine.season_recap(user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_player_receipts(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        res = await orwell_engine.player_receipts(user=owner)
        if not res:
            return {"output": "No receipts — nothing in the player's own record contradicts itself yet.", "exit_code": 0}
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_player_dossier(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        args = _parse_tool_args(content) if content and content.strip() else {}
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    if not isinstance(args, dict):
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    subject_id = str(args.get("subjectId") or "").strip() or None
    try:
        res = await orwell_engine.player_dossier(subject_id, user=owner)
        if not res:
            return {"output": "No Diary-Room reads on file yet.", "exit_code": 0}
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_season_retrospective(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        res = await orwell_engine.season_retrospective(user=owner)
        if res is None:
            return {"output": "The Vault stays sealed: the season is still live. It opens only after a winner is crowned.", "exit_code": 0}
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_daily_recap(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        res = await orwell_engine.daily_recap(user=owner)
        if res is None:
            return {"output": "No day has closed yet — there is no recap to re-fetch.", "exit_code": 0}
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_world_snapshot_view(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        res = await orwell_engine.world_snapshot_view(user=owner)
        if res is None or (isinstance(res, dict) and not res):
            return {"output": json.dumps({}), "exit_code": 0}
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_npc_voice(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        args = _parse_tool_args(content) if content and content.strip() else {}
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    npc_id = (args.get("id") or "").strip()
    if not npc_id:
        return {"error": "id (the houseguest id to voice) is required", "exit_code": 1}
    try:
        res = await orwell_engine.npc_voice(npc_id, user=owner)
        if res is None:
            return {"output": "No such active houseguest — the departed are voiced from the public record only.", "exit_code": 0}
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_whereabouts(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        res = await orwell_engine.whereabouts(user=owner)
        if res is None:
            return {"output": "No game is running yet — the house is empty until a game starts.", "exit_code": 0}
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_move_to(content: str, owner: Optional[str] = None) -> Dict:
    """L21/L24: the player walks to a room they named. `content` is the tool args JSON ({room})."""
    from src import orwell_engine
    try:
        room = ""
        try:
            room = (json.loads(content) or {}).get("room", "") if content else ""
        except Exception:
            room = (content or "").strip()
        res = await orwell_engine.move_to(str(room), user=owner)
        if res is None:
            return {"output": "No game is running yet.", "exit_code": 0}
        await _refresh_after_model_progression(owner, res)  # adopt the post-commit beatSeq the engine echoes (no stale-beat 409 on the next call this turn)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


PREMIERE_INTROS_ENTRANCES_NOTE = (
    "\n\nNOTE: the houseguest entrances are STILL IN PROGRESS — arrivals are released one at a time, so this list does not mean everyone has arrived. "
    "The champagne toast has NOT happened yet; do not narrate or stage it until the engine reaches it."
)


async def do_premiere_intros(content: str, owner: Optional[str] = None) -> Dict:
    """PREMIERE ONLY (#380): the meet-everyone progress — who's met + who's STILL to introduce."""
    from src import orwell_engine
    try:
        res = await orwell_engine.premiere_intros(user=owner)
        if res is None:
            return {"output": "Not in the premiere — everyone has already been met.", "exit_code": 0}
        out = json.dumps(res, indent=2)
        # ORW-148 C: the engine reports complete/remaining:[] while arrivals are still being staged (GameSessionAdapter.ts), which made the
        # narrator jump to the champagne toast. While the entrance stage is live, say so plainly. (Engine-side fix is a follow-up.)
        try:
            from routes import chat_helpers as _ch_pi
            if _ch_pi.premiere_entrance_active(owner):
                out += PREMIERE_INTROS_ENTRANCES_NOTE
        except Exception:
            pass
        return {"output": out, "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_mark_houseguest_met(content: str, owner: Optional[str] = None) -> Dict:
    """PREMIERE ONLY (#380): mark a houseguest met. `content` is the tool args JSON ({id})."""
    from src import orwell_engine
    try:
        args = _parse_tool_args(content) if content and content.strip() else {}
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    hg_id = (args.get("id") or "").strip()
    if not hg_id:
        return {"error": "id is required", "exit_code": 1}
    try:
        res = await orwell_engine.mark_houseguest_met(hg_id, user=owner)
        await _refresh_after_model_progression(owner, res)  # A29: adopt the post-commit beatSeq the engine echoes
        if res is None:
            return {"output": "Not in the premiere — there is nobody left to meet.", "exit_code": 0}
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_diary_room(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        args = _parse_tool_args(content) if content and content.strip() else {}
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    entry = (args.get("entry") or content or "").strip()
    if not entry:
        return {"error": "entry is required", "exit_code": 1}
    try:
        res = await orwell_engine.diary_room(entry, user=owner)
        await _refresh_after_model_progression(owner, res)  # A29: adopt the post-commit beatSeq the engine echoes
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


def _parse_secret_lever(raw) -> Optional[Dict]:
    """Shape-only parse of a SecretLeverDescriptor ({factId?, bluff?, subject?} — the port's own
    shape, `src/ports/GameSession.ts`). The FE never INTERPRETS a secret lever — it only validates
    that the model handed over a well-formed object, then forwards it opaquely; the ENGINE is the
    single authority on whether a `factId` is actually held, whether a bluff lands, etc. Returns
    None when `raw` isn't a dict or carries none of the known fields (⇒ caller omits the field
    entirely, keeping the request byte-identical to a lever-free deal)."""
    if not isinstance(raw, dict):
        return None
    lever: Dict = {}
    fact_id = raw.get("factId") or raw.get("fact_id")
    if isinstance(fact_id, str) and fact_id.strip():
        lever["factId"] = fact_id.strip()
    if raw.get("bluff"):
        lever["bluff"] = True
    subject = raw.get("subject")
    if isinstance(subject, str) and subject.strip():
        lever["subject"] = subject.strip()
    return lever or None



# N-4 — the makeDeal PARTNER / TERM guard. The engine accepts any valid active houseguest id and any
# bounded term, so it cannot tell that the narrator named the WRONG partner or invented a duration. The
# FE (which holds the player's own words for the turn) checks both. Closed-set only: it fires on a
# POSITIVE mismatch (the player's words name a different houseguest and not the chosen one) and on a
# term the player never spoke; absent any signal it passes through unchanged.
import contextvars as _cv

PLAYER_TURN_TEXT: "_cv.ContextVar[str]" = _cv.ContextVar("orwell_player_turn_text", default="")

_DEAL_NUM = r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|another|the next|next)"
_DEAL_NUM_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
                   "nine": 9, "ten": 10, "a": 1, "another": 1, "the next": 1, "next": 1}
# A spoken NUMBER of weeks ("for two weeks", "3-week"). The number is parsed so it can be matched to the term.
_DEAL_WEEKS_RE = re.compile(
    r"\b(?:for\s+(?:the\s+)?(?:next\s+)?(" + _DEAL_NUM + r")(?:\s+more)?\s+weeks?"
    r"|(" + _DEAL_NUM + r")[- ]weeks?)\b", re.I)
# A spoken ENDPOINT (no week count to compare). Bare "until/through/thru/till/up to" do NOT count - they must be
# followed by an explicit endpoint, so "I'll go through with it" names no duration.
_DEAL_OPEN_RE = re.compile(
    r"\b(?:this\s+week|next\s+week|rest\s+of\s+the\s+(?:week|season|game)|week\s+\d+"
    r"|(?:until|till|through|thru|up\s+to)\s+(?:the\s+)?(?:end|finale|season|game|jury|eviction"
    r"|final\s+(?:two|2|three|3|four|4|five|5)|f[2-5]|week\s+\d+)"
    r"|to\s+the\s+end|end\s+of\s+the\s+(?:season|game)"
    r"|final\s+(?:two|2|three|3|four|4|five|5)|f[2-5]|forever)\b", re.I)


def _spoken_deal_weeks(text: str) -> set:
    """The distinct week counts the player actually said ("for two weeks" -> {2})."""
    out = set()
    for m in _DEAL_WEEKS_RE.finditer(text or ""):
        tok = (m.group(1) or m.group(2) or "").lower()
        n = int(tok) if tok.isdigit() else _DEAL_NUM_WORDS.get(tok)
        if n:
            out.add(n)
    return out


def _deal_term_named(text: str) -> bool:
    return bool(_spoken_deal_weeks(text)) or bool(_DEAL_OPEN_RE.search(text or ""))


def _reconcile_deal_term(term, text: str):
    """Match the SUBMITTED term to the SPOKEN duration. Nothing spoken -> None (engine default). A spoken week count
    forwards the term only if its weeks equal one of them (else None). Only an endpoint phrase ("rest of the
    season") -> the term passes as given."""
    if term is None:
        return None
    spoken = _spoken_deal_weeks(text)
    if spoken:
        return term if term.get("weeks") in spoken else None
    return term if _DEAL_OPEN_RE.search(text or "") else None


def _name_in_text(name: str, text: str) -> bool:
    """Whole-name OR a first/last token of `name` appears in `text` on word boundaries (case-insensitive)."""
    toks = [t for t in re.split(r"\s+", (name or "").strip()) if len(t) >= 2]
    cands = [" ".join(toks)] + toks if toks else []
    return any(re.search(r"(?<!\w)" + re.escape(c) + r"(?!\w)", text or "", re.I) for c in cands if c)


def _deal_partner_mismatch(with_id: str, roster: list, text: str):
    """Return (partner_name, other_name) when the player's words name a DIFFERENT roster houseguest and
    NOT the chosen partner; else None (no positive mismatch -> never guess)."""
    if not text or not roster:
        return None
    by_id = {h.get("id"): (h.get("name") or "") for h in roster if isinstance(h, dict)}
    partner = by_id.get(with_id, "")
    if partner and _name_in_text(partner, text):
        return None
    for h in roster:
        if isinstance(h, dict) and h.get("id") != with_id and h.get("name") and _name_in_text(h["name"], text):
            return (partner or with_id, h["name"])
    return None


def _deal_names_anyone(roster: list, text: str) -> bool:
    return any(isinstance(h, dict) and h.get("name") and _name_in_text(h["name"], text) for h in roster)


async def guard_make_deal(with_id: str, term, owner, player_text: str):
    """N-4 - the ONE guarded path for every makeDeal write (the model-driven `do_make_deal` AND the FE
    `_auto_record_deal` back-fill). Returns (error_or_None, term_to_forward). No player text => unchanged."""
    if not player_text:
        return None, term
    from src import orwell_engine
    _roster, _roster_ok = [], False
    try:
        _gs = await orwell_engine.get_game_state(user=owner)
        _house = (_gs or {}).get("house") if isinstance(_gs, dict) else None
        if isinstance(_house, list):
            _roster = [h for h in _house if isinstance(h, dict) and h.get("status", "active") == "active"]
            _roster_ok = True
    except Exception:
        pass
    _mm = _deal_partner_mismatch(with_id, _roster, player_text)
    if _mm:
        return (f"makeDeal refused: the player's handshake names {_mm[1]}, not {_mm[0]}. "
                "Re-issue makeDeal with the right partner or ask the player."), term
    if _roster_ok and not _deal_names_anyone(_roster, player_text):
        # The player named nobody ("deal? you keep me safe"): the partner must be co-present (engine truth).
        # A failed roster read or unreadable presence fails open.
        try:
            _wa = await orwell_engine.whereabouts(user=owner)
        except Exception:
            _wa = None
        _here = (_wa or {}).get("present") if isinstance(_wa, dict) else None
        if isinstance(_here, list):
            _ids = {p.get("id") for p in _here if isinstance(p, dict)}
            if with_id not in _ids:
                _pn = next((h.get("name") for h in _roster if h.get("id") == with_id), None) or with_id
                _hn = ", ".join(str(p.get("name") or p.get("id")) for p in _here if isinstance(p, dict)) or "nobody"
                return (f"makeDeal refused: {_pn} is not in the scene with the player (present: {_hn}). "
                        "Re-issue makeDeal with the right partner or ask the player."), term
    return None, _reconcile_deal_term(term, player_text)


def is_deal_refusal(res) -> bool:
    """True iff the engine's makeDeal result is a REFUSAL: the NPC declined and NO deal was recorded (anti-sycophancy).
    Strict: only a dict with `refused` exactly True counts, so an accepted deal (or None) is never mistaken for one."""
    return isinstance(res, dict) and res.get("refused") is True


def deal_refusal_for_narrator(res: dict) -> dict:
    """Shape an engine refusal as a narrator-visible tool result: the NPC declined, why (in fiction), and that no deal exists."""
    why = str(res.get("narratable") or res.get("reason") or "they are not willing").strip()
    return {"output": json.dumps({
        "declined": True,
        "reason": res.get("reason"),
        "message": (f"The NPC declined: this houseguest {why}. No deal was made. Voice their refusal in character; "
                    "do NOT narrate a handshake, an agreement, or a promise - the engine decided, not you."),
    }, indent=2), "exit_code": 0}


async def do_make_deal(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    with_id = (args.get("with") or args.get("with_id") or "").strip()
    kind = (args.get("kind") or "").strip()
    terms = (args.get("terms") or "").strip()
    # 0121 R2 — the accepted kinds track the engine's deal-depth flag: the defensive four always, plus the
    # two active-obligation kinds (comp-throw/veto-save) when the layer is on. Off ⇒ the original four, so
    # the validation is byte-identical (the engine also gates the active kinds, so this is defence-in-depth).
    from src.tool_schemas import current_deal_kinds
    _kinds = current_deal_kinds()
    if kind not in set(_kinds):
        return {"error": "kind must be one of: " + ", ".join(_kinds), "exit_code": 1}
    if not with_id or not terms:
        return {"error": "with (houseguest id) and terms are required", "exit_code": 1}
    # 0093/0099 — OPTIONAL leverage/tradedSecret: forwarded opaquely (shape-checked, never
    # interpreted). Absent ⇒ the call to the engine is unchanged from the pre-0093/0099 shape.
    leverage = _parse_secret_lever(args.get("leverage"))
    traded_secret = _parse_secret_lever(args.get("tradedSecret") or args.get("traded_secret"))
    # 0109 — OPTIONAL negotiated term {weeks?, vague?}: shape-filtered here, bounded by the ENGINE.
    term = None
    _raw_term = args.get("term")
    if isinstance(_raw_term, dict):
        term = {}
        if isinstance(_raw_term.get("weeks"), int) and not isinstance(_raw_term.get("weeks"), bool):
            term["weeks"] = _raw_term["weeks"]
        if _raw_term.get("vague") is True:
            term["vague"] = True
        term = term or None
    _err, term = await guard_make_deal(with_id, term, owner, PLAYER_TURN_TEXT.get())
    if _err:
        return {"error": _err, "exit_code": 1}
    try:
        _extra = {"term": term} if term is not None else {}  # absent ⇒ the call is byte-identical to pre-0109
        _dir = (args.get("direction") or "").strip().lower()
        if _dir in ("offer", "ask") and kind in ("comp-throw", "veto-save"):  # B55: only meaningful for the active kinds
            _extra["direction"] = _dir
        res = await orwell_engine.make_deal(with_id, kind, terms, leverage=leverage,
                                            traded_secret=traded_secret, user=owner, **_extra)
        if is_deal_refusal(res):  # the engine decided the NPC declines: surface it as a refusal, never as a recorded deal
            return deal_refusal_for_narrator(res)
        await _refresh_after_model_progression(owner, res)  # adopt the post-commit beatSeq the engine echoes (no stale-beat 409 on the next call this turn)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_confide(content: str, owner: Optional[str] = None) -> Dict:
    """Feature 0075 — the player presses an ALLY to open up. The ENGINE is the single authority: it
    decides whether they disclose, how much, and whether it's the truth or a lie, and records it as
    the player's knowledge. We only forward {npcId} and return what the engine discloses."""
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    npc_id = (args.get("npcId") or args.get("npc_id") or args.get("with") or "").strip()
    if not npc_id:
        return {"error": "npcId (the houseguest the player is pressing to open up) is required", "exit_code": 1}
    try:
        res = await orwell_engine.confide(npc_id, user=owner)
        await _refresh_after_model_progression(owner, res)  # adopt the post-commit beatSeq the engine echoes (no stale-beat 409 on the next call this turn)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_ask_juror(content: str, owner: Optional[str] = None) -> Dict:
    """Feature 0129 slice 3 — the juror-player asks a fellow juror what they know. The ENGINE is the single
    authority (gate on the juror's bearing, pick what they share, record via told-by); we forward {jurorId}."""
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    raw = args.get("jurorId") or args.get("juror_id") or args.get("npcId") if isinstance(args, dict) else None
    juror_id = raw.strip() if isinstance(raw, str) else ""
    if not juror_id:
        return {"error": "jurorId (the fellow juror being asked) is required", "exit_code": 1}
    try:
        res = await orwell_engine.ask_juror(juror_id, user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_form_alliance(content: str, owner: Optional[str] = None) -> Dict:
    """Feature 0107 Phase A — the player NAMES an alliance with a set of houseguests. The ENGINE is
    the single authority: membership is bond-gated (a proposed member joins only if their mutual bond
    with the player clears the floor), so it returns who ACTUALLY joined, never a fiat. We only
    forward {name, members}."""
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    name = (args.get("name") or "").strip()
    members = args.get("members")
    if not isinstance(members, list) or not members:
        return {"error": "members (a non-empty list of houseguest ids) is required", "exit_code": 1}
    if not name:
        return {"error": "name (the alliance's name as spoken in the scene) is required", "exit_code": 1}
    try:
        res = await orwell_engine.form_alliance(name, members, user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_join_alliance(content: str, owner: Optional[str] = None) -> Dict:
    """Feature 0107 Phase B — the player ACCEPTS an NPC's pitch and joins their named alliance. The
    ENGINE is the single authority: only a live pitch the player is close enough to the founder for
    takes. We only forward {allianceId}."""
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    alliance_id = (args.get("allianceId") or args.get("alliance_id") or "").strip()
    if not alliance_id:
        return {"error": "allianceId (from gameStatus.alliancePitches) is required", "exit_code": 1}
    try:
        res = await orwell_engine.join_alliance(alliance_id, user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_expose_secret(content: str, owner: Optional[str] = None) -> Dict:
    """Feature 0093 — the player OUTS a secret they LEARNED to the house. The ENGINE is the single
    authority: it validates the player actually holds `factId` (I3/Vault Wall — a non-learned fact is
    REJECTED, never fabricated here), resolves the bounded standing fold + exposer backlash, and
    records the exposure. We only forward {factId} or {bluff, subject} and return the engine's result."""
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    bluff = bool(args.get("bluff"))
    subject = (args.get("subject") or "").strip() or None
    fact_id = (args.get("factId") or args.get("fact_id") or "").strip() or None
    if bluff:
        if not subject:
            return {"error": "subject (the houseguest the invented secret is about) is required for a bluff", "exit_code": 1}
    elif not fact_id:
        return {"error": "factId (a secret the player has actually learned) is required, or set bluff:true with a subject", "exit_code": 1}
    try:
        res = await orwell_engine.expose_secret(fact_id=fact_id, bluff=bluff, subject=subject, user=owner)
        await _refresh_after_model_progression(owner, res)  # adopt the post-commit beatSeq the engine echoes (no stale-beat 409 on the next call this turn)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_trade_secret(content: str, owner: Optional[str] = None) -> Dict:
    """Feature 0099 — the player TRADES a secret they LEARNED about a THIRD party to a recipient for a
    one-off concession. The ENGINE is the single authority: it validates the player actually holds
    `factId` (I3/Vault Wall — a non-learned fact is REJECTED), values the secret TO THE RECIPIENT, and
    decides whether they bite. We only forward {toNpcId, factId|bluff+subject, askKind}."""
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    to_npc_id = (args.get("toNpcId") or args.get("to_npc_id") or "").strip()
    if not to_npc_id:
        return {"error": "toNpcId (the recipient houseguest) is required", "exit_code": 1}
    bluff = bool(args.get("bluff"))
    subject = (args.get("subject") or "").strip() or None
    fact_id = (args.get("factId") or args.get("fact_id") or "").strip() or None
    ask_kind = (args.get("askKind") or args.get("ask_kind") or "").strip() or None
    if bluff:
        if not subject:
            return {"error": "subject (the houseguest the invented secret is about) is required for a bluff", "exit_code": 1}
    elif not fact_id:
        return {"error": "factId (a secret the player has actually learned about a third party) is required, or set bluff:true with a subject", "exit_code": 1}
    try:
        res = await orwell_engine.trade_secret(to_npc_id, fact_id=fact_id, bluff=bluff, subject=subject,
                                               ask_kind=ask_kind, user=owner)
        await _refresh_after_model_progression(owner, res)  # adopt the post-commit beatSeq the engine echoes (no stale-beat 409 on the next call this turn)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_confront(content: str, owner: Optional[str] = None) -> Dict:
    """Feature 0094 — the player CONFRONTS a houseguest over a fact they LEARNED. The ENGINE is the
    single authority: it validates the player actually holds `factId` (I3/Vault Wall — a non-learned
    fact is REJECTED, never fabricated here) and resolves whether the confrontation lands. We only
    forward {npcId, factId} and return the engine's Vault-free {landed} result."""
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    npc_id = (args.get("npcId") or args.get("npc_id") or "").strip()
    fact_id = (args.get("factId") or args.get("fact_id") or "").strip()
    if not npc_id:
        return {"error": "npcId (the confronted houseguest) is required", "exit_code": 1}
    if not fact_id:
        return {"error": "factId (a fact the player has actually learned) is required", "exit_code": 1}
    try:
        res = await orwell_engine.confront(npc_id, fact_id, user=owner)
        await _refresh_after_model_progression(owner, res)  # adopt the post-commit beatSeq the engine echoes (no stale-beat 409 on the next call this turn)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_accuse_tie(content: str, owner: Optional[str] = None) -> Dict:
    """Feature 0095 — the player accuses two houseguests of a PRE-SHOW tie. The ENGINE checks whether
    a real connection exists — never invented or confirmed here — and a miss must stay
    indistinguishable from an ordinary wrong guess. We only forward {aId, bId} and return the
    engine's Vault-free {landed} result."""
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    a_id = (args.get("aId") or args.get("a_id") or "").strip()
    b_id = (args.get("bId") or args.get("b_id") or "").strip()
    if not a_id or not b_id:
        return {"error": "aId and bId (the two accused houseguests) are both required", "exit_code": 1}
    try:
        res = await orwell_engine.accuse_tie(a_id, b_id, user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}


async def do_manage_sandbox(content: str, owner: Optional[str] = None) -> Dict:
    from src import orwell_engine
    try:
        args = _parse_tool_args(content)
    except ValueError:
        return {"error": "Invalid JSON arguments", "exit_code": 1}
    op = (args.get("op") or "").strip()
    if op not in {"create", "reset", "save", "load"}:
        return {"error": "op must be one of: create, reset, save, load", "exit_code": 1}
    try:
        res = await orwell_engine.manage_sandbox(op, user=owner)
        return {"output": json.dumps(res, indent=2), "exit_code": 0}
    except Exception as e:
        return {"error": f"engine error: {e}", "exit_code": 1}
