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


def is_aside_only(text: Optional[str]) -> bool:
    """True iff the WHOLE text is one or more `(( ))` aside blocks (nested parens tolerated) or an `ooc:`-prefixed line."""
    t = (text or "").strip()
    if not t:
        return False
    if _OOC_PREFIX_RE.match(t):
        return True
    if not _ASIDE_SPAN_RE.search(t):
        return False
    return not _ASIDE_SPAN_RE.sub("", t).strip(_REMAINDER_TRIM)
