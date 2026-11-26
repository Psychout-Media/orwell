"""ORW-717 (bare-refusal half): a refusal-only line must never reach the player as narration.

A real model sometimes opens a round with a one-line refusal ("I'm sorry, but I can't continue in this
direction.") next to a native tool call, then writes the real scene in the next round. This is a TEXT
CLASSIFIER (a detector, never a pick, never player-facing text): a handful of narrow compiled patterns, fail-open
(anything uncertain is NOT a refusal). It only decides what is HELD BACK from the stream; nothing it matches is
ever re-authored. Vault-free: it sees the model's visible text only and keeps a bare counter.

Off by ORWELL_REFUSAL_GUARD=0 (default on).
"""
import os
import re

_MAX_LEN = 160  # a refusal line is short; a longer sentence is narration

# a leading apology (optional) then first-person inability ...
_START = re.compile(
    r"^\W*(?:(?:i['’]?m|i\s+am)\s+(?:so\s+|very\s+|really\s+|truly\s+)?sorry|sorry|i\s+apologi[sz]e|unfortunately)?"
    r"\W*(?:but\s+)?\W*i\s+(?:can['’]?t|cannot|can\s+not|won['’]?t|will\s+not|["
    r"'’]?m\s+unable|am\s+unable|['’]?m\s+not\s+able|am\s+not\s+able)\b",
    re.IGNORECASE)
# ... aimed at continuing / assisting / this request (not "can't help but smile")
_OBJECT = re.compile(
    r"\b(?:continu\w*|assist\w*|help\s+(?:you|with|out)|proceed\w*|direction|request|comply|go\s+(?:on|further))\b",
    re.IGNORECASE)
_QUOTES = ('"', "“", "”")

_withheld = 0


def enabled() -> bool:
    return os.environ.get("ORWELL_REFUSAL_GUARD", "1").strip().lower() not in ("0", "false", "off", "no")


def withheld_count() -> int:
    return _withheld


def is_refusal_sentence(sentence: str) -> bool:
    s = (sentence or "").strip()
    if not s or len(s) > _MAX_LEN or any(q in s for q in _QUOTES) or "*" in s:
        return False
    return bool(_START.match(s) and _OBJECT.search(s))


def strip_leading_refusal(text: str) -> "tuple[str, int]":
    """Drop the leading refusal sentence(s) of `text` (a round's first emitted chunk). Returns (kept, chars_dropped).
    Only LEADING whole sentences are dropped; fail-open on any error."""
    try:
        parts = re.split(r"(?<=[.!?\n])", text or "")
        i = 0
        while i < len(parts) and (not parts[i].strip() or is_refusal_sentence(parts[i])):
            i += 1
        dropped = "".join(parts[:i])
        if not dropped.strip():
            return text, 0
        return "".join(parts[i:]), len(dropped)
    except Exception:  # failsoft-ok: a detector error never withholds text
        return text, 0


def strip_refusals(text: str) -> "tuple[str, int]":
    """ORW-1055: drop EVERY refusal sentence of `text`, not only the leading ones (a refusal can open a later chunk or sit mid-reply). Whole sentences only; fail-open."""
    try:
        parts = re.split(r"(?<=[.!?\n])", text or "")
        kept = [x for x in parts if not is_refusal_sentence(x)]
        dropped = len(text or "") - sum(len(x) for x in kept)
        if dropped <= 0:
            return text, 0
        return "".join(kept), dropped
    except Exception:  # failsoft-ok: a detector error never withholds text
        return text, 0


def note_withheld() -> None:
    global _withheld
    _withheld += 1
