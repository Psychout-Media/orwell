"""
context_compactor.py

Auto-compacts conversation history when approaching context window limits.
Summarizes older messages via the same LLM, preserving key context.
"""

import asyncio
import json
import logging
import os
from typing import Any, Callable, Dict, List, Optional

from src.model_context import get_context_length_async, estimate_tokens
from src.llm_core import llm_call_async
from src.endpoint_resolver import resolve_endpoint
from core.models import ChatMessage

logger = logging.getLogger(__name__)


def _content_as_text(content: Any) -> str:
    """Flatten a message's content to plain text.

    Handles the three shapes that flow through history: a plain string, a
    multimodal list of content blocks (vision/image attachments), and None
    (assistant turns that carried only native tool_calls persist content as
    None). Returns "" for anything without text so callers can safely slice
    the result.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("text")
        )
    return ""


GAME_COMPACTION_REFUSAL = "Compaction is off for game sessions; the narrator's memory is handled automatically"
_GAME_PHASES = ("game", "casting")


def is_game_or_casting_session(session) -> bool:
    """ORW-224: True when this session is (or ever was) a game or casting chat: any stored row stamped
    ``phase`` game/casting, or the session is the owner's bound canonical game session. Compaction rewrites
    stored rows, so it is refused for these regardless of how the caller reached it."""
    for m in (getattr(session, "history", None) or []):
        md = (m.get("metadata") if isinstance(m, dict) else getattr(m, "metadata", None)) or {}
        if md.get("phase") in _GAME_PHASES:
            return True
    try:
        from src.orwell_game_session import get_game_session
        sid = getattr(session, "id", None)
        return bool(sid) and get_game_session(getattr(session, "owner", None)) == sid
    except Exception:  # noqa: BLE001 - the binding store is optional; the phase check above already ran
        return False


COMPACT_THRESHOLD = 0.85  # Trigger compaction at 85% of context window
# ORW-219: the destructive trim runs at the effective INPUT budget, which is far below 85% of the raw
# window (48K of a 1M window before; 600K now). Compaction must run FIRST, so when the caller knows the
# budget it triggers at this fraction of it: old turns are summarized before anything is dropped.
COMPACT_BUDGET_FRACTION = 0.75
SUMMARY_MAX_TOKENS = 1024
SMALL_CONTEXT_LIMIT = 8192  # Models with context <= this get aggressive trimming

# Cursor-style self-summarization prompt — produces structured, dense summaries
SELF_SUMMARY_SYSTEM_PROMPT = """You are summarizing a conversation to preserve context after compaction. Produce a structured summary that lets the conversation continue seamlessly.

Use this format:

## Conversation Summary
**Turns summarized:** {count}  |  **Compactions so far:** {n}

### User Goal
One sentence describing what the user is trying to accomplish.

### What Was Done
- Bullet points of completed actions, decisions made, and key outputs
- Include specific file paths, function names, variable names, URLs, and config values
- Note any errors encountered and how they were resolved

### Current State
What is the system/code/task state right now? What was the last thing discussed?

### Pending / Next Steps
- What remains to be done
- Any open questions or blockers

### Key Context
- Important constraints, preferences, or decisions that must not be forgotten
- Specific values: model names, ports, paths, credentials references, versions

Keep the summary under 1000 tokens. Be dense — every token should carry information. Do not include pleasantries or meta-commentary."""


def _sanitize_tool_messages(msgs: List[Dict]) -> List[Dict]:
    """Drop orphaned `tool` messages and dangling assistant `tool_calls`.

    OpenAI's API requires every `role:"tool"` message to immediately
    follow an assistant message that carries `tool_calls` (or another
    tool message in the same batch). Front-trimming the history can cut
    the assistant `tool_calls` parent while keeping its tool responses,
    which triggers: "messages with role 'tool' must be a response to a
    preceding message with 'tool_calls'". This pass repairs that:
      - drops `tool` messages with no valid preceding tool_calls
      - drops assistant `tool_calls` messages whose tool responses were
        all trimmed away (some providers reject unanswered tool_calls)
    """
    # Pass 1: drop orphan tool messages.
    cleaned: List[Dict] = []
    in_batch = False  # are we right after an assistant tool_calls (or mid-batch)?
    for m in msgs:
        role = m.get("role")
        if role == "tool":
            if in_batch:
                cleaned.append(m)
            # else: orphan — drop
            continue
        if role == "assistant" and m.get("tool_calls"):
            in_batch = True
        else:
            in_batch = False
        cleaned.append(m)

    # Pass 2: drop assistant tool_calls messages that have NO following
    # tool response (dangling) — walk backwards so we know what follows.
    out: List[Dict] = []
    for i, m in enumerate(cleaned):
        if m.get("role") == "assistant" and m.get("tool_calls"):
            nxt = cleaned[i + 1] if i + 1 < len(cleaned) else None
            if not (nxt and nxt.get("role") == "tool"):
                # Dangling tool_calls — keep the message but strip the
                # tool_calls so it's a plain assistant turn (preserves any
                # text content the model produced alongside the calls).
                m = {k: v for k, v in m.items() if k != "tool_calls"}
                if not (m.get("content") or "").strip():
                    continue  # nothing left worth keeping
        out.append(m)
    return out


def _message_text_token_estimate(text: str) -> int:
    if not isinstance(text, str):
        return 4
    return int(len(text) * 0.3) + 4


def _truncate_text_to_token_budget(text: str, token_budget: int) -> str:
    """Trim a too-large current user message instead of dropping it entirely."""
    if token_budget <= 32:
        return "[Current user message omitted: it exceeded the model context window.]"

    if not isinstance(text, str):
        # This helper is typed/used as text downstream, so return an empty
        # string rather than the raw non-string (which would move the crash
        # into the caller that concatenates/measures the result).
        return ""
    # Match src.model_context.estimate_tokens' rough chars * 0.3 estimate.
    max_chars = max(200, int((token_budget - 16) / 0.3))
    if len(text) <= max_chars:
        return text

    notice = (
        "\n\n[Notice: the pasted message was too large for this model's context "
        "window, so Orwell kept the beginning and end.]"
    )
    keep_chars = max(200, max_chars - len(notice))
    head_len = max(100, int(keep_chars * 0.7))
    tail_len = max(80, keep_chars - head_len)
    return text[:head_len].rstrip() + notice + "\n\n" + text[-tail_len:].lstrip()


def _truncate_tool_call_args(msg: Dict[str, Any], token_budget: int) -> Dict[str, Any]:
    """Shrink oversized assistant ``tool_calls`` arguments to fit ``token_budget``.

    A tool-only turn persists ``content=None`` with its whole payload in
    ``tool_calls[].function.arguments`` (e.g. a large create_document body), which
    the text-content truncation can't reach — so the message could stay over
    budget and the upstream call would 400. Replace each argument string that
    overflows its share of the budget with a small valid-JSON placeholder,
    preserving ``id``/``type``/``function.name`` so tool/result pairing and
    provider validation are unaffected. Returns msg unchanged when there is
    nothing oversized.
    """
    tool_calls = msg.get("tool_calls")
    if not isinstance(tool_calls, list) or not tool_calls:
        return msg
    # Budget left after whatever content survived (estimate_tokens counts tool
    # arguments too, so measure content alone here).
    content_tokens = estimate_tokens([{"role": msg.get("role", "assistant"), "content": msg.get("content")}])
    per_call = max(16, (max(0, token_budget - content_tokens)) // len(tool_calls))
    new_calls = []
    changed = False
    for tc in tool_calls:
        fn = tc.get("function") if isinstance(tc, dict) else None
        args = fn.get("arguments") if isinstance(fn, dict) else None
        if isinstance(args, str) and int(len(args) * 0.3) > per_call:
            new_fn = dict(fn)
            new_fn["arguments"] = json.dumps({"_truncated_for_context": len(args)})
            new_tc = dict(tc)
            new_tc["function"] = new_fn
            new_calls.append(new_tc)
            changed = True
        else:
            new_calls.append(tc)
    if not changed:
        return msg
    out = dict(msg)
    out["tool_calls"] = new_calls
    return out


def _truncate_message_to_token_budget(msg: Dict[str, Any], token_budget: int) -> Dict[str, Any]:
    """Return a copy of msg whose text content (and tool-call args) fit token_budget."""
    out = dict(msg)
    content = out.get("content", "")
    if isinstance(content, str):
        out["content"] = _truncate_text_to_token_budget(content, token_budget)
    elif isinstance(content, list):
        remaining = token_budget
        new_content = []
        for item in content:
            if not isinstance(item, dict) or item.get("type") != "text":
                new_content.append(item)
                continue
            text = item.get("text", "")
            truncated = _truncate_text_to_token_budget(text, remaining)
            cloned = dict(item)
            cloned["text"] = truncated
            new_content.append(cloned)
            remaining -= _message_text_token_estimate(truncated)
        out["content"] = new_content
    # A tool-only turn (content=None) carries its payload in tool_calls args,
    # which the branches above can't shrink — handle it so the message can fit.
    return _truncate_tool_call_args(out, token_budget)


def _is_summary_msg(msg: Dict) -> bool:
    """A compaction summary message (system role, written by maybe_compact)."""
    c = msg.get("content")
    return msg.get("role") == "system" and isinstance(c, str) and c.startswith("[Conversation summary")


def _per_message_tokens(msg: Dict) -> int:
    return estimate_tokens([msg])


def _trim_preserving_system(messages: List[Dict], budget: int, used: int) -> List[Dict]:
    """ORW-219: game-turn trim. EVERY system message (the GM prompt, the per-turn grounding/steer
    messages, the terminal HARD CONSTRAINTS block) is kept intact and in place; only conversation
    turns are dropped, oldest first. The newest turn is never dropped (it is shrunk if it alone
    is too big). If the system messages alone cannot fit, log a WARNING with the numbers and
    return what we have rather than silently degrading the prompt."""
    keep_idx = [i for i, m in enumerate(messages)
                if m.get("_protected") or (m.get("role") == "system" and not _is_summary_msg(m))]
    keep_set = set(keep_idx)
    convo_idx = [i for i in range(len(messages)) if i not in keep_set]
    dropped_idx = set()
    dropped = 0
    total = used
    # Oldest raw turn first; a compaction summary ("[Conversation summary]") is the densest
    # context per token, so it goes last. Never the newest conversation message.
    droppable = convo_idx[:-1]
    droppable = [i for i in droppable if not _is_summary_msg(messages[i])] + \
                [i for i in droppable if _is_summary_msg(messages[i])]
    for i in droppable:
        if total <= budget:
            break
        total -= _per_message_tokens(messages[i])
        dropped_idx.add(i)
        dropped += 1
    kept = [m for i, m in enumerate(messages) if i not in dropped_idx]
    if total > budget and convo_idx:
        last = messages[convo_idx[-1]]
        system_tokens = estimate_tokens([m for m in kept if m is not last])
        available = max(64, budget - system_tokens)
        if system_tokens < budget:
            shrunk = _truncate_message_to_token_budget(last, available)
            kept = [shrunk if m is last else m for m in kept]
    result = _sanitize_tool_messages(kept)
    final = estimate_tokens(result)
    if final > budget:
        logger.warning(
            "[context] game-turn prompt exceeds the input budget even after dropping %d old turn(s): "
            "%d tokens > %d budget (system messages=%d tokens). System prompt NOT truncated; "
            "raise agent_input_token_hard_max or use a larger-window model.",
            dropped, final, budget, estimate_tokens([m for m in result if m.get("role") == "system"]),
        )
    else:
        logger.info("[context] game-turn trim dropped %d oldest turn(s): %d -> %d tokens (system prompt intact)",
                    dropped, used, final)
    return result


def trim_for_context(messages: List[Dict], context_length: int, reserve_tokens: int = 512,
                     *, preserve_system: bool = False) -> List[Dict]:
    """Trim messages to fit within context_length.

    ``preserve_system=True`` (every live-game / casting turn, ORW-219): no system message is ever
    dropped or truncated; only the oldest conversation turns go. Otherwise (non-game chat) the
    order is unchanged: extra system messages (RAG/memory) are dropped first, then old conversation
    turns, and only after that is the first system prompt truncated to 2,000 characters (this
    truncation used to run BEFORE old turns were dropped; it is now a last resort and logs a WARNING).
    Reserves space for the response.
    """
    budget = context_length - reserve_tokens
    used = estimate_tokens(messages)
    if used <= budget:
        return messages

    logger.info(f"Trimming messages: {used} tokens > {budget} budget (ctx={context_length})")
    if preserve_system:
        return _trim_preserving_system(messages, budget, used)

    # Separate system messages from conversation.
    # Messages marked _protected (e.g. active document) are never trimmed.
    system_msgs = []
    protected_msgs = []
    convo_msgs = []
    for msg in messages:
        if msg.get("_protected"):
            protected_msgs.append(msg)
        elif msg.get("role") == "system":
            system_msgs.append(msg)
        else:
            convo_msgs.append(msg)

    # Protected messages count toward budget but are never dropped
    protected_tokens = estimate_tokens(protected_msgs)
    budget -= protected_tokens

    # Priority: keep first system msg (preset prompt), drop others (memory, RAG, memo)
    essential_system = system_msgs[:1] if system_msgs else []
    extra_system = system_msgs[1:]

    # Try dropping extra system messages one by one (from the end)
    trimmed = essential_system + convo_msgs
    if estimate_tokens(trimmed) <= budget:
        # Dropping extras was enough — try adding back some
        result = list(essential_system)
        for msg in extra_system:
            candidate = result + [msg] + convo_msgs
            if estimate_tokens(candidate) <= budget:
                result.append(msg)
            else:
                break
        return _sanitize_tool_messages(result + protected_msgs + convo_msgs)

    # Still too big — drop older conversation turns BUT always keep the current
    # user turn. If a pasted message alone exceeds the model context, truncate
    # that message with a visible notice instead of dropping it; otherwise the
    # model appears to "ignore" large pastes because it never receives them.
    # Hermes-style: recent context matters more than old context.
    PROTECT_RECENT = 10
    current_msg = convo_msgs[-1:] if convo_msgs else []
    prior_convo = convo_msgs[:-1] if convo_msgs else []
    if len(prior_convo) >= PROTECT_RECENT:
        old_msgs = prior_convo[:-(PROTECT_RECENT - 1)]
        recent_msgs = prior_convo[-(PROTECT_RECENT - 1):] + current_msg
        while old_msgs and estimate_tokens(essential_system + old_msgs + recent_msgs) > budget:
            old_msgs.pop(0)
        convo_msgs = old_msgs + recent_msgs
    else:
        convo_msgs = prior_convo + current_msg
        while prior_convo and estimate_tokens(essential_system + prior_convo + current_msg) > budget:
            prior_convo.pop(0)
        convo_msgs = prior_convo + current_msg

    # Last resort (non-game chat only): truncate the first system message. Never silent.
    if essential_system and estimate_tokens(essential_system + protected_msgs + convo_msgs) > budget:
        sys_text = essential_system[0].get("content", "")
        if isinstance(sys_text, str) and len(sys_text) > 2000:
            logger.warning(
                "[context] truncating the system prompt as a last resort: %d chars -> 2000 "
                "(%d tokens > %d budget after dropping old turns)",
                len(sys_text), estimate_tokens(essential_system + protected_msgs + convo_msgs), budget,
            )
            essential_system[0] = {"role": "system", "content": sys_text[:2000] + "\n[System prompt truncated for context limits]"}

    # If the current message itself is too large, shrink only that message.
    if current_msg and estimate_tokens(essential_system + protected_msgs + convo_msgs) > budget:
        prefix = essential_system + protected_msgs + convo_msgs[:-1]
        available_for_current = max(64, budget - estimate_tokens(prefix))
        convo_msgs[-1] = _truncate_message_to_token_budget(convo_msgs[-1], available_for_current)

    result = _sanitize_tool_messages(essential_system + protected_msgs + convo_msgs)
    logger.info(f"Trimmed to {estimate_tokens(result)} tokens ({len(result)} messages)")
    return result


def _safe_int_env(name: str, default: int) -> int:
    """Read an int env var, fail-soft: blank/unset/malformed ⇒ `default` (clamped to ≥1)."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return max(1, int(raw.strip()))
    except (TypeError, ValueError):
        logger.warning("Invalid %s=%r — using default %s", name, raw, default)
        return default


# F-PY-2: background-compaction bookkeeping. `_compaction_in_flight` keeps at most ONE background
# summarization per session (a second over-threshold turn while the first is still summarizing just
# rides trim_for_context, then benefits when the first lands). `_background_tasks` holds strong refs
# so the fire-and-forget tasks are not garbage-collected before they complete.
_compaction_in_flight: set = set()
_background_tasks: set = set()
# Global ceiling on concurrent BACKGROUND compactions across ALL sessions, so a burst of
# over-threshold turns can't spawn unbounded summarization tasks. Env-tunable; default 4.
_MAX_CONCURRENT_BG_COMPACTIONS = _safe_int_env("ORWELL_MAX_BG_COMPACTIONS", 4)
# Created lazily inside the running loop (and rebound if the loop changes — e.g. across isolated
# test loops) so a module-level asyncio primitive never binds to the wrong event loop.
_global_compaction_sem: "Optional[asyncio.Semaphore]" = None
_global_compaction_sem_loop = None


def _get_global_compaction_sem() -> "asyncio.Semaphore":
    global _global_compaction_sem, _global_compaction_sem_loop
    loop = asyncio.get_running_loop()
    if _global_compaction_sem is None or _global_compaction_sem_loop is not loop:
        _global_compaction_sem = asyncio.Semaphore(_MAX_CONCURRENT_BG_COMPACTIONS)
        _global_compaction_sem_loop = loop
    return _global_compaction_sem


def _stable_repr(v) -> str:
    """A value-stable string for any message field (str / None / multimodal list / tool_calls)."""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    try:
        return json.dumps(v, sort_keys=True, default=str)
    except Exception:  # noqa: BLE001 — a weird shape still needs SOME stable key
        return repr(v)


def _message_content_key(m) -> tuple:
    """A (role, content, tool_calls) CONTENT fingerprint of one history message — dict OR ChatMessage.
    Compared by VALUE, so an in-place edit (edit_message mutates the SAME object's `content`) is
    detected; object-identity comparison would miss it."""
    if isinstance(m, dict):
        role, content, tool_calls = m.get("role"), m.get("content"), m.get("tool_calls")
    else:
        role = getattr(m, "role", None)
        content = getattr(m, "content", None)
        tool_calls = getattr(m, "tool_calls", None)
    return (role, _stable_repr(content), _stable_repr(tool_calls))


def _prefix_content_digest(messages) -> tuple:
    """A value-comparable digest of a message range: a tuple of per-message content keys. A length
    change, a reorder/replace, OR an in-place content edit all change it."""
    return tuple(_message_content_key(m) for m in messages)


def _schedule_background_compaction(session, split_point: int, system_msg_count: int,
                                    summarize_fn: Callable, older_msgs: Optional[List[Dict]] = None) -> None:
    """Fire the summary LLM call + history rewrite as a fail-soft background task (F-PY-2).

    The current turn has already returned its (uncompacted, trim-guaranteed-to-fit) messages; this
    persists a compacted `session.history` for FUTURE turns without blocking the first token. One in
    flight per session, bounded globally by a semaphore; any error is swallowed (compaction is an
    optimization, never load-bearing — trim_for_context is the correctness floor)."""
    sid = getattr(session, "id", None)
    if sid is not None and sid in _compaction_in_flight:
        return  # already summarizing this session — don't stack a second call
    # DATA-INTEGRITY (mandate #4 non-degradation): snapshot a CONTENT digest of the message range this
    # compaction will SUMMARIZE + REPLACE (`session.history[:effective_split]`). Serializing
    # compactions (the in-flight set) does NOT protect against OTHER writers (delete-messages /
    # truncate_session / replace_messages / edit_message) mutating history while the summary is in
    # flight — that leaves split_point/system_msg_count pointing at the wrong range and
    # `_update_session_history` would OVERWRITE the newer edit (lost data). We digest by VALUE, not
    # object identity, because `history_routes.edit_message` mutates a message's `content` IN PLACE
    # (same object) — an identity check would miss it. `_run` re-derives the digest just before
    # applying; if it differs, it ABANDONS fail-soft (the next over-threshold turn re-compacts).
    effective_split = system_msg_count + split_point
    if older_msgs:
        # ORW-219: align to the real history rows (the context was built with the casting/slash rows and the
        # preface filtered out, so `split_point` does NOT index session.history).
        _span = _locate_history_rows(getattr(session, "history", None) or [], older_msgs)
        if _span is None:
            # Cannot align. A history carrying casting/game/slash rows is NOT safe to index positionally
            # (that is exactly the misalignment): skip, trim is the correctness floor. A plain chat history
            # keeps the legacy positional path.
            if any(((getattr(m, "metadata", None) or {}).get("phase") or (getattr(m, "metadata", None) or {}).get("source"))
                   for m in (getattr(session, "history", None) or []) if not isinstance(m, dict)):
                return
            older_msgs = None
        else:
            effective_split = _span + 1
    try:
        prefix_digest = _prefix_content_digest((getattr(session, "history", None) or [])[:effective_split])
    except Exception:  # noqa: BLE001 — an odd history shape ⇒ can't validate ⇒ skip safely
        return
    if sid is not None:
        _compaction_in_flight.add(sid)

    async def _run() -> None:
        try:
            async with _get_global_compaction_sem():
                summary = await summarize_fn()
                if not summary:
                    return
                # Re-validate the summarized prefix is UNCHANGED since capture. A normal tail append
                # (this turn's own assistant message) leaves the prefix digest identical → apply; any
                # edit to the summarized range (delete/truncate/replace/in-place content edit) makes the
                # digest differ → abandon, don't clobber. Length + reorder + content are all covered.
                cur = getattr(session, "history", None) or []
                if _prefix_content_digest(cur[:effective_split]) != prefix_digest:
                    logger.debug(
                        "Background compaction abandoned for session %s — history changed under it", sid)
                    return
                _update_session_history(session, split_point, summary,
                                        system_msg_count=system_msg_count, older_msgs=older_msgs)
                logger.info("Background compaction persisted for session %s", sid)
        except Exception as e:  # noqa: BLE001 — a background optimization must never surface
            logger.warning("Background compaction failed for session %s: %s", sid, e)
        finally:
            if sid is not None:
                _compaction_in_flight.discard(sid)

    try:
        task = asyncio.create_task(_run())
    except RuntimeError:
        # No running loop (maybe_compact is async, so this should not happen) — release the guard
        # and skip; trim_for_context already kept THIS turn safe.
        if sid is not None:
            _compaction_in_flight.discard(sid)
        return
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def maybe_compact(
    session,
    endpoint_url: str,
    model: str,
    messages: List[Dict],
    headers: Optional[Dict] = None,
    owner: Optional[str] = None,
    input_budget_fn: Optional[Callable[[int], int]] = None,
    persist_history: bool = True,
) -> tuple:
    """Check context usage and compact if above threshold.

    ``input_budget_fn(context_length) -> effective input-token budget`` (ORW-219): when given, the
    threshold is ``min(85% of window, COMPACT_BUDGET_FRACTION x budget)`` so summarizing always
    happens before ``trim_for_context`` has to drop anything.

    ``persist_history=False`` (ORW-224, every game/casting session): never summarize. Compaction ends in
    ``replace_messages``, which deletes and re-inserts every stored row; a game transcript must never be
    rewritten (non-degradation, mandate #4). The caller's ``trim_for_context`` shortens the prompt only.

    Returns (messages, context_length, was_compacted).
    """
    # F-PY-3 (perf audit): resolve the context window off the event loop (short-TTL memoized) so a
    # slow /models or /slots probe on this endpoint can't stall every concurrent user's turn.
    context_length = await get_context_length_async(endpoint_url, model)
    used = estimate_tokens(messages)
    pct = (used / context_length) * 100 if context_length else 0

    threshold_tokens = COMPACT_THRESHOLD * context_length if context_length else float("inf")
    if input_budget_fn is not None and context_length:
        try:
            budget = int(input_budget_fn(context_length) or 0)
        except Exception:  # noqa: BLE001 — a budget lookup failure falls back to the window threshold
            budget = 0
        if budget > 0:
            threshold_tokens = min(threshold_tokens, COMPACT_BUDGET_FRACTION * budget)
    if used < threshold_tokens:
        return messages, context_length, False

    if not persist_history or is_game_or_casting_session(session):
        logger.info("Context at %.1f%% — compaction skipped (game/casting session: stored history is never rewritten)", pct)
        return messages, context_length, False

    logger.info(
        f"Context at {pct:.1f}% ({used}/{context_length} tokens) — compacting"
    )

    # Split into system preface and conversation
    system_msgs = []
    convo_msgs = []
    for msg in messages:
        if msg.get("role") == "system":
            system_msgs.append(msg)
        else:
            convo_msgs.append(msg)

    if len(convo_msgs) < 4:
        return messages, context_length, False

    # Split conversation: summarize older half, keep recent half
    split_point = len(convo_msgs) // 2
    older = convo_msgs[:split_point]
    recent = convo_msgs[split_point:]

    # Build the text to summarize
    convo_text = "\n".join(
        f"{msg.get('role', 'user').upper()}: {_content_as_text(msg.get('content'))[:2000]}"
        for msg in older
    )

    # Count prior compactions from existing summary messages
    compaction_count = sum(
        1 for m in system_msgs
        if "[Conversation summary" in m.get("content", "")
    )

    # Use utility model if configured, otherwise fall back to session model
    util_url, util_model, util_headers = resolve_endpoint("utility", owner=owner)
    compact_url = util_url or endpoint_url
    compact_model = util_model or model
    compact_headers = util_headers if util_url else headers

    prompt = SELF_SUMMARY_SYSTEM_PROMPT.replace(
        "{count}", str(len(older))
    ).replace(
        "{n}", str(compaction_count + 1)
    )
    summary_messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": convo_text},
    ]

    async def _summarize() -> Optional[str]:
        try:
            return await llm_call_async(
                compact_url,
                compact_model,
                summary_messages,
                temperature=0.2,
                max_tokens=SUMMARY_MAX_TOKENS,
                headers=compact_headers,
                timeout=30,
            )
        except Exception as e:  # noqa: BLE001 — degrade gracefully; a summary failure is never fatal
            logger.error(f"Compaction summary failed: {e}")
            # Keep the conversation intact rather than silently dropping the older half. None signals
            # the caller nothing was summarized; trim_for_context handles length either way.
            return None

    # F-PY-2 (perf audit): DO NOT block the first token on the summary LLM call. The old path
    # awaited a 30s-ceiling summarization BEFORE narration ("hang, then it streams"). `trim_for_context`
    # (the caller runs it immediately after) ALREADY hard-guarantees the returned messages fit the
    # window, so skipping the summary for THIS turn is safe — the older half is trimmed (not
    # summarized) just this once. We kick the summarization in the BACKGROUND so it persists a
    # compacted history that shortens EVERY later turn; `was_compacted=False` is correct (nothing was
    # summarized into THIS turn's messages, so the caller emits no "compacted" cue for it).
    #
    # Non-degradation / race-safety (single asyncio event loop): `_update_session_history` and the
    # turn's own user/assistant appends are each synchronous (no internal await → they never
    # partially interleave), and the background pass preserves the recent tail
    # (`session.history[split:]`) — so whichever order they land in, the just-appended turns are
    # retained; nothing is lost.
    _schedule_background_compaction(session, split_point, len(system_msgs), _summarize, older_msgs=older)
    return messages, context_length, False


def _row_key(m) -> tuple:
    """(db id, role, content) identity of a history row or a context dict built from one."""
    if isinstance(m, dict):
        md, role, content = m.get("metadata") or {}, m.get("role"), m.get("content")
    else:
        md, role, content = getattr(m, "metadata", None) or {}, getattr(m, "role", None), getattr(m, "content", None)
    return (md.get("_db_id"), role, _stable_repr(content))


def _locate_history_rows(history: list, older_msgs: List[Dict]) -> Optional[int]:
    """Index in ``history`` of the row matching the LAST of ``older_msgs`` (an ordered subsequence of it),
    or None if they cannot all be found in order."""
    p, last = 0, None
    for i, row in enumerate(history):
        if p < len(older_msgs) and _row_key(row) == _row_key(older_msgs[p]):
            last = i
            p += 1
    return last if p == len(older_msgs) else None


def _update_session_history(session, split_point: int, summary: str,
                            system_msg_count: int = 0, older_msgs: Optional[List[Dict]] = None):
    """Update the in-memory session history after compaction.

    `split_point` is the index in `convo_msgs` (system-stripped). The
    in-memory `session.history` includes leading system messages, so the
    actual recent-history slice starts at `system_msg_count + split_point`.
    Prepending `session.history[:system_msg_count]` to the new history
    preserves persona, preset, and RAG system messages that would
    otherwise be dropped.
    """
    if not session or not hasattr(session, "history"):
        return

    if older_msgs:
        # ORW-219: replace ONLY the summarized rows (the context-visible older half) with the summary, in
        # place. Casting/slash rows and the recent tail stay exactly where they are; the summary is stamped
        # with the phase of what it summarizes so the casting wall and the pre-game cut treat it correctly.
        keys = {_row_key(m) for m in older_msgs}
        if _locate_history_rows(session.history, older_msgs) is None:
            return
        _phases = [((getattr(m, "metadata", None) or {}).get("phase")) for m in session.history if _row_key(m) in keys]
        _phase = "game" if "game" in _phases else next((p for p in _phases if p), None)
        _md = {"compacted": True, "summarized_count": len(older_msgs)}
        if _phase:
            _md["phase"] = _phase
        summary_msg = ChatMessage(role="system", content=f"[Conversation summary]\n{summary}", metadata=_md)
        new_history, placed = [], False
        for m in session.history:
            if _row_key(m) in keys:
                if not placed:
                    new_history.append(summary_msg)
                    placed = True
                continue
            new_history.append(m)
        _persist_history(session, new_history)
        return

    effective_split = system_msg_count + split_point
    if effective_split >= len(session.history):
        return

    # Keep the recent messages, prepend summary AND the leading system
    # messages so the system prompt survives compaction.
    system_prefix = list(session.history[:system_msg_count])
    recent_history = session.history[effective_split:]
    summary_msg = ChatMessage(
        role="system",
        content=f"[Conversation summary]\n{summary}",
        metadata={"compacted": True, "summarized_count": split_point},
    )
    new_history = system_prefix + [summary_msg] + recent_history
    _persist_history(session, new_history)


def _persist_history(session, new_history: list) -> None:
    """Persist (DB, so a restart keeps the summary) and swap the in-memory history."""
    try:
        from core import models as _core_models
        manager = getattr(_core_models, "_session_manager", None)
    except Exception:
        manager = None
    if manager and getattr(session, "id", None):
        if manager.replace_messages(session.id, new_history):
            return
    session.history = new_history
