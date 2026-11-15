"""ORW-409: audit the final narrator briefing for blocks that contradict each other.

Pure and Vault-free: it only reads the text of the message list about to be sent and reports contradictions on three facts: part of day, whether the next event is
due now, and who is present with the player. It parses the blocks the front end itself generates (the engine's GAME CONTEXT lines, the production call / not-yet
steers, the hang-out steer, the movement cue). Report-only: it never edits the prompt.
"""
import re
from typing import Iterable

_PARTS = {"morning", "afternoon", "evening", "night", "late night", "early morning", "midday"}
_TOD_RE = re.compile(r"^\s*-\s*(?:(?:Time of day|Part of the day):|The night is over: it is now)\s*([A-Za-z -]+?)(?:\s*[(.]|$)", re.IGNORECASE | re.MULTILINE)
_DUE_NOW_RE = re.compile(r"production is calling everyone|production calls everyone|the scheduled event is on now|^\s*-\s*IT IS TIME:[^\n]*is starting NOW", re.IGNORECASE | re.MULTILINE)  # the last form is the GAME CONTEXT's own daySchedule line (momentPrompts.ts)
_NOT_DUE_RE = re.compile(r"production hasn'?t called|is not due until|^\s*-\s*COMING UP:", re.IGNORECASE | re.MULTILINE)
_WITH_RE = re.compile(r"^\s*With you:\s*(.+?)\.?\s*$", re.IGNORECASE | re.MULTILINE)
_LEFT_RE = re.compile(r"MOVEMENT IN THE ROOM[^\n]*?—\s*([^\n]*)")


def _text(messages: Iterable) -> str:
    out = []
    for m in messages or []:
        c = m.get("content") if isinstance(m, dict) else None
        if isinstance(c, str):
            out.append(c)
        elif isinstance(c, list):
            out.extend(p.get("text", "") for p in c if isinstance(p, dict) and isinstance(p.get("text"), str))
    return "\n\n".join(out)


def _names(s: str) -> set:
    return {n.strip() for n in re.split(r",|\band\b", re.sub(r"\([^)]*\)", "", s)) if n.strip()}


def audit_briefing(messages) -> list:
    """Return [{"fact": "part-of-day"|"event-due"|"presence", "detail": str}, ...]; empty when the blocks agree."""
    t = _text(messages)
    found = []
    parts = {v for v in (re.sub(r"[-\s]+", " ", x.lower()).strip() for x in _TOD_RE.findall(t)) if v in _PARTS}
    if len(parts) > 1:
        found.append({"fact": "part-of-day", "detail": "blocks name different parts of the day: " + ", ".join(sorted(parts))})
    if _DUE_NOW_RE.search(t) and _NOT_DUE_RE.search(t):
        found.append({"fact": "event-due", "detail": "one block says the event is on now, another says production has not called it"})
    w = _WITH_RE.search(t)
    mv = _LEFT_RE.search(t)
    if w and mv:
        here = _names(w.group(1)) if not w.group(1).lower().startswith("no one") else set()
        left, came = set(), set()
        for clause in mv.group(1).split(";"):
            who = _names(re.sub(r"\s+(?:has|have)\s+(?:left|come into)\b.*", "", clause))
            (left if re.search(r"\bleft\b", clause) else came).update(who)
        bad = sorted((left & here) | (came - here))
        if bad:
            found.append({"fact": "presence", "detail": "movement cue and 'With you' disagree about: " + ", ".join(bad)})
    return found
