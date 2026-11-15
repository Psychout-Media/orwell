"""ORW-402 layer 3 - deterministic transcript recall for condensed-out days.

The prompt view (``orwell_day_condense.apply_prompt_view``) replaces closed days with a ``[Story so far]`` summary in
the SENT list only. When the player's newest message asks about a detail from one of those days, this step searches the
STORED rows the view dropped and injects up to ``MAX_EXCERPTS`` short verbatim exchanges (player line + narration reply)
as ONE system message ``[From earlier days - verbatim]`` right after the ``[Story so far]`` block.

No tool call (the production narrator model rejects forced tools), no model call, no new dependency, no rng. Lexical
scoring: overlapping content words and names, recency tie-break. Only player-visible user/assistant ``content`` strings
are eligible (never tool results or metadata), so it is Vault-free by construction. Nothing scores above the threshold
=> nothing is injected and the message list is returned unchanged. Any error => the list unchanged.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Optional

logger = logging.getLogger(__name__)

RECALL_HEADER = "[From earlier days - verbatim]"
MAX_EXCERPTS = 3
EXCERPT_CHARS = 600
TOTAL_CHARS = 2000
MIN_SCORE = 3.0          # e.g. three shared content words, or a shared name plus one word
_WORD = re.compile(r"[a-z0-9']+")
_STOP = frozenset("""a about above after again all also am an and any are as at be because been before being below between
both but by can could did do does doing down during each few for from further had has have having he her here hers him his
how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should
so some such than that the their them then there these they this those through to too under until up very was we were what
when where which while who whom why will with would you your yours yeah yes okay ok oh well really got get go going went
said say says tell told think know want like one""".split())


def enabled() -> bool:
    """ORWELL_TRANSCRIPT_RECALL, ON by default; ``=0|false|no|off`` or the diagnostic ``ORWELL_FLAGS_OFF=1`` turns it off."""
    if str(os.environ.get("ORWELL_FLAGS_OFF", "")).strip().lower() in ("1", "true", "yes", "on"):
        return False
    return str(os.environ.get("ORWELL_TRANSCRIPT_RECALL", "")).strip().lower() not in ("0", "false", "no", "off")


def _words(text: str) -> set:
    return {w.strip("'") for w in _WORD.findall((text or "").lower())
            if len(w.strip("'")) > 2 and w.strip("'") not in _STOP}


def _name_tokens(names) -> set:
    out: set = set()
    for n in names or []:
        if isinstance(n, str):
            out |= {t for t in _WORD.findall(n.lower()) if len(t) > 2}
    return out


def _last_user_text(messages: list) -> str:
    for m in reversed(messages):
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            return m["content"]
    return ""


def _clip(text: str, n: int) -> str:
    t = " ".join((text or "").split())
    return t if len(t) <= n else t[: n - 3].rstrip() + "..."


_NON_VISIBLE_MD = ("reasoning", "thinking", "tool", "tool_call", "tool_calls", "tool_result", "event")


def _eligible(m) -> bool:
    """Player-visible chat text only: a user/assistant row with a plain string ``content``, no tool calls, not a casting-
    phase row, and no reasoning / tool / event marker in its metadata."""
    if m.get("role") not in ("user", "assistant") or not isinstance(m.get("content"), str) or not m["content"].strip():
        return False
    if m.get("tool_calls") or m.get("tool_call_id") or m.get("reasoning_content"):
        return False
    md = m.get("metadata")
    if isinstance(md, dict):
        if md.get("phase") == "casting" or any(md.get(k) for k in _NON_VISIBLE_MD):
            return False
        if str(md.get("kind", "")).lower() in ("reasoning", "thinking", "tool", "tool_result", "event"):
            return False
    return True


def _exchanges(dropped: list) -> list:
    """Pair each dropped player row with the next dropped narration row (player-visible text only). ``dropped`` is the
    ordered list of dropped message dicts; returns [(order, player_text, narration_text)]."""
    out: list = []
    pending: Optional[str] = None
    for m in dropped:
        if not _eligible(m):
            continue
        role, content = m["role"], m["content"]
        if role == "user":
            if pending is not None:
                out.append((len(out), pending, ""))
            pending = content
        else:
            out.append((len(out), pending or "", content))
            pending = None
    if pending is not None:
        out.append((len(out), pending, ""))
    return out


def build_recall(original: list, view: list, query: str, names=()) -> str:
    """The recall block text for ``query`` from rows in ``original`` that ``view`` dropped; "" when nothing scores."""
    q = _words(query)
    if not q:
        return ""
    kept = {id(m) for m in view}
    dropped = [m for m in original if isinstance(m, dict) and id(m) not in kept]
    if not dropped:
        return ""
    nm = _name_tokens(names)
    qnames = nm & {t for t in _WORD.findall(query.lower())}
    scored: list = []
    for order, player, narr in _exchanges(dropped):
        ex_words = _words(player) | _words(narr)
        score = float(len(q & ex_words)) + 1.5 * len(qnames & ex_words)
        if score >= MIN_SCORE:
            scored.append((score, order, player, narr))
    if not scored:
        return ""
    scored.sort(key=lambda s: (-s[0], -s[1]))          # best first; newer wins a tie
    top = sorted(scored[:MAX_EXCERPTS], key=lambda s: s[1])  # show in story order
    lines = [RECALL_HEADER]
    total = len(RECALL_HEADER)
    for _score, _order, player, narr in top:
        body = ""
        if player:
            body += "Player: " + _clip(player, 280)
        if narr:
            body += ("\n" if body else "") + "Narration: " + _clip(narr, EXCERPT_CHARS - len(body) - 12 if body else EXCERPT_CHARS)
        body = body[:EXCERPT_CHARS]
        if total + len(body) + 1 > TOTAL_CHARS:
            break
        lines.append(body)
        total += len(body) + 1
    return "\n".join(lines) if len(lines) > 1 else ""


def apply_recall(original: list, view: list, names=()) -> list:
    """Return ``view`` with one recall system message inserted right after the ``[Story so far]`` block, or ``view``
    itself when disabled / nothing matches. Pure; never mutates; any error => ``view``."""
    try:
        if not enabled() or not isinstance(view, list) or not isinstance(original, list) or view is original:
            return view
        story_idx = next((i for i, m in enumerate(view) if isinstance(m, dict) and m.get("role") == "system"
                          and isinstance(m.get("content"), str) and m["content"].startswith("[Story so far]")), None)
        if story_idx is None:
            return view
        text = build_recall(original, view, _last_user_text(view), names)
        if not text:
            return view
        return view[: story_idx + 1] + [{"role": "system", "content": text}] + view[story_idx + 1:]
    except Exception as e:
        logger.warning("[transcript-recall] skipped: %s", e)
        try:
            from src import log_rings
            log_rings.record_soft_failure("transcript-recall:failed", e, corrected="the prompt view is sent without excerpts")
        except Exception:  # failsoft-ok: recorder-self
            pass
        return view
