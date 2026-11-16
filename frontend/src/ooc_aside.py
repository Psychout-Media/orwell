"""One shared detector for out-of-character ((aside)) replies (ORW-207 / ORW-222).

The narrator answers out-of-character questions in `(( ))` asides (momentPrompts.ts: "text wrapped in ((double parentheses)) or prefixed 'ooc:' is out of character without
exception"). A turn that is ONLY such asides is not a scene. The check is SPAN-BASED, not a greedy whole-string match: `((a)) real scene ((b))` is a scene with two asides in it,
and an unbalanced `((` is not an aside at all, so both still count as real play.
"""
from __future__ import annotations

import re
from typing import Optional

_ASIDE_SPAN_RE = re.compile(r"\(\(.*?\)\)", re.DOTALL)
_OOC_PREFIX_RE = re.compile(r"^\s*ooc\s*:", re.IGNORECASE)
# Nested parens inside an aside (`((day 12 (HOH: X)))`) leave the non-greedy span one `)` short; tolerate stray closing parens and whitespace in the remainder.
_REMAINDER_TRIM = ") \t\r\n"


def _aside_spans(t: str) -> list:
    """The `(start, end)` of every `(( ))` aside in `t`. The end BALANCES parentheses, so a nested group inside an aside (`((day 12 (HOH: X)) a private note))`) never
    ends the aside early and leaks the rest (review of #2854); closing parens right after it are part of it. An aside whose parens never balance falls back to the first
    `))` after its opening (the older rule, so an unclosed nested group still ends somewhere), and the longer of the two is taken: an aside is private, so strip more."""
    spans = []
    i = 0
    while True:
        s = t.find("((", i)
        if s < 0:
            return spans
        depth, end = 0, None
        for j in range(s, len(t)):
            if t[j] == "(":
                depth += 1
            elif t[j] == ")":
                depth -= 1
                if depth == 0:
                    end = j + 1
                    break
        m = _ASIDE_SPAN_RE.match(t, s)
        if end is None and m is None:
            return spans          # no `))` anywhere after this `((`: not an aside, and no later one can close either
        end = max(end or 0, m.end() if m else 0)
        while end < len(t) and t[end] == ")":
            end += 1
        spans.append((s, end))
        i = end


def _without_asides(t: str, sep: str) -> str:
    out, i = [], 0
    for s, e in _aside_spans(t):
        out.append(t[i:s])
        out.append(sep)
        i = e
    out.append(t[i:])
    return "".join(out)


def is_aside_only(text: Optional[str]) -> bool:
    """True iff the WHOLE text is one or more `(( ))` aside blocks (nested parens tolerated) or an `ooc:`-prefixed line."""
    t = (text or "").strip()
    if not t:
        return False
    if _OOC_PREFIX_RE.match(t):
        return True
    if not _aside_spans(t):
        return False
    return not _without_asides(t, "").strip(_REMAINDER_TRIM)


def strip_asides(text: Optional[str]) -> str:
    """The text with every `(( ))` aside span removed (an `ooc:`-prefixed text is all aside, so nothing is left). What remains is the
    in-character part a recorder may match names in and save as content: a private note inside an aside never becomes a witnessed
    event (review of #2247). Whitespace left behind is collapsed."""
    t = (text or "").strip()
    if not t or _OOC_PREFIX_RE.match(t):
        return ""
    return " ".join(_without_asides(t, " ").split())
