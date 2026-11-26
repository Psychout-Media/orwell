"""ORW-1055: a houseguest or the narrator must never name the game as a scene, script or take (the fourth wall).

A real model sometimes has an evictee say it is not the scene being played and to restart it elsewhere, or breaks character in the narrator's own voice. This is a TEXT CLASSIFIER (a detector, never
a pick, never player-facing text): a few narrow compiled patterns, fail-open (anything uncertain is NOT a break). It drops WHOLE sentences, wherever they sit in the chunk and inside a quoted
speech too, and keeps any quote it was inside balanced. Vault-free: it sees the model's visible text only and keeps a bare counter.

Off by ORWELL_FOURTH_WALL_GUARD=0 (default on).
"""
import os
import re

_PATTERNS = tuple(re.compile(p, re.IGNORECASE) for p in (
    r"\b(?:not|isn['\u2019]?t|is\s+no\s+longer)\s+(?:the|a|this)\s+(?:same\s+)?scene\b",
    r"\b(?:restart|redo|replay|rewrite|reshoot)\s+(?:it|this|that|the)\s+(?:scene|take|script)?\s*(?:elsewhere|somewhere\s+else|from\s+the\s+top)\b",
    r"\b(?:restart|redo|replay|rewrite|reshoot)\s+(?:this|that|the)\s+(?:scene|take|script)\b",
    r"\bout\s+of\s+character\b|\bbreak(?:ing)?\s+character\b|\bstay(?:ing)?\s+in\s+character\b",
    r"\bas\s+an?\s+(?:AI|A\.I\.|language\s+model|assistant)\b",
    r"\b(?:the|this|your)\s+(?:narrator|game\s+master|simulation)\s+(?:cannot|can['\u2019]?t|won['\u2019]?t|is\s+unable)\b",
    r"\bthe\s+scene\s+(?:i['\u2019]?m|we['\u2019]?re|you['\u2019]?re)\s+(?:doing|playing|in)\b",
))
_SENTENCE = re.compile(r"[^.!?\n]*[.!?]+[\"\u201d\u2019)]*\s*|[^.!?\n]+$|\n")
_withheld = 0


def enabled() -> bool:
    return os.environ.get("ORWELL_FOURTH_WALL_GUARD", "1").strip().lower() not in ("0", "false", "off", "no")


def withheld_count() -> int:
    return _withheld


def is_fourth_wall_sentence(sentence: str) -> bool:
    s = (sentence or "").strip()
    return bool(s) and len(s) <= 400 and any(p.search(s) for p in _PATTERNS)


def _quote_open(text: str) -> bool:
    return text.count("\"") % 2 == 1 or text.count("\u201c") > text.count("\u201d")


def strip_fourth_wall(text: str) -> "tuple[str, int]":
    """Drop every sentence that breaks the fourth wall. Returns (kept, chars_dropped). A dropped sentence that closed a quote closes the quote on what is kept, so no unclosed quote is left."""
    try:
        out = ""
        dropped = 0
        for m in _SENTENCE.finditer(text or ""):
            part = m.group(0)
            if is_fourth_wall_sentence(part):
                dropped += len(part)
                if out.strip() and _quote_open(out) and (part.rstrip().endswith(("\"", "\u201d"))):
                    out = out.rstrip() + ("\u201d" if "\u201c" in out and out.count("\u201c") > out.count("\u201d") else "\"") + " "
                continue
            out += part
        if dropped == 0:
            return text, 0
        return out.lstrip(" ") if not (text or "").startswith(" ") else out, dropped
    except Exception:  # failsoft-ok: a detector error never withholds text
        return text, 0


def note_withheld() -> None:
    global _withheld
    _withheld += 1
