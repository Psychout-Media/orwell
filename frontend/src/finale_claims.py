"""Phantom-FINALE screening for an EVICTED player (E-1 live rehearsal, 2026-11-04). Pure; no I/O.

In watch mode the narrator voiced "…and then it's finale night… the last two come down the stairs… the room waits on the jury to speak" while the engine was
at week 8's HOH competition. The finale, the final two, the jury's verdict and the winner are closed-set events the engine decides; the narrator may only voice
them once committed. This is the sibling of `role_claims` for the one family it has no cue for, and deliberately NARROW:

  - only assertive "it has ARRIVED" phrasing is a claim (finale night is here, the last two take the stage, the jury votes, X is crowned / wins Big Brother);
  - a unit carrying hypothetical / future / conditional / back-reference wording is never touched, and houseguest strategy talk about the final two is not an
    arrival claim (it has none of the arrival templates);
  - it only screens an EVICTED player's narration before the finale is committed (an active player's phantoms are the other guards' job);
  - fail-open: no board / any doubt passes.
"""
from __future__ import annotations

import re
from typing import Optional

_ARRIVAL_RES = [
    re.compile(r"\b(?:it['’]s|it\s+is|now\s+it['’]s|then\s+it['’]s|and\s+then\s+it['’]s|tonight\s+is|tonight['’]s)\s+(?:the\s+)?finale\b", re.IGNORECASE),
    re.compile(r"\bfinale\s+(?:night|day)\s+(?:arrives?|is\s+here|has\s+(?:come|arrived)|begins?|dawns?|is\s+upon\s+(?:us|you|them))\b", re.IGNORECASE),
    re.compile(r"\bthe\s+(?:last|final)\s+two\s+(?:come|comes|walk|walks|descend|descends|take|takes|stand|stands|step|steps|enter|enters|sit|sits|face|faces)\b", re.IGNORECASE),
    re.compile(r"\bthe\s+finalists\s+(?:stand|stands|walk|walks|take|takes|face|faces|sit|sits|step|steps|come|comes|enter|enters|wait|waits)\b", re.IGNORECASE),
    re.compile(r"\bthe\s+jury\s+(?:speaks|casts?|votes?|announces?|delivers?|has\s+(?:voted|spoken)|is\s+seated|takes\s+(?:its|their)\s+seats?|files?\s+in)\b", re.IGNORECASE),
    re.compile(r"\b(?:waits?|waiting)\s+on\s+the\s+jury\b", re.IGNORECASE),
    re.compile(r"\bfinale\s+(?:stage|set|lights?|floor|show|is\s+(?:lit|live|over))\b|\bthe\s+finale\s+(?:goes|dissolves|fades|ends)\b", re.IGNORECASE),
    re.compile(r"\b(?:final|last)\s+(?:two|three)\b", re.IGNORECASE),
    re.compile(r"\bjury(?:['’]s)?\s+(?:has\s+)?(?:made|decided|reached|verdict|decision)\b|\b(?:read|reading|count|counting)\s+the\s+(?:jury\s+)?votes\b|\bjury\s+votes\s+(?:are|were)\b", re.IGNORECASE),
    re.compile(r"\bjurors?[.,!]?\s+it['’]s\s+time\b|\bthe\s+votes\s+come\s+in\b|[\"“]jurors?[.,!]", re.IGNORECASE),
    re.compile(r"\bseason['’]?s?\s+(?:is\s+)?(?:already\s+)?crowned\b|\b[A-Z]\w+(?:\s+[A-Z]\w+)?,\s+crowned\b|\bconfetti\b|\bthat['’]s\s+the\s+season\b|\bthe\s+season\s+is\s+(?:done|over|complete)\b", re.IGNORECASE),
    re.compile(r"\bis\s+crowned\s+(?:the\s+)?(?:winner|champion|(?:big\s+brother\s+)?(?:season\s+)?\w+\s+winner)\b|\bwins\s+big\s+brother\b|\bthe\s+winner\s+is\b", re.IGNORECASE),
]
_CUE_RE = re.compile(r"finale|last\s+two|final\s+two|final\s+three|last\s+three|finalists|jury|jurors?|crowned|winner|confetti|the\s+season|wins\s+big\s+brother", re.IGNORECASE)
# future / hypothetical / conditional / back-reference wording: the unit talks ABOUT the finale, it does not claim it arrived
_NON_ASSERTIVE_RE = re.compile(
    r"\b(?:will|would|might|may|could|should|shall|until|before|when|whenever|whoever|whether|if|unless|someday|eventually|soon|"
    r"back\s+for|come\s+back|return|toward|towards|heading|head\s+to|on\s+the\s+way|build(?:s|ing)?\s+to|approach\w*|"
    r"dream\w*|wish\w*|hope\w*|want\w*|wants\s+to|trying\s+to|plans?\s+to|going\s+to|gonna|long\s+way\s+off|away|feels?\s+like)\b|\?|['’](?:ll|d)\b",
    re.IGNORECASE)
_SPLIT_RE = re.compile(r"(?<=[.!?\n])")


def has_finale_cue(text: str) -> bool:
    return bool(text) and bool(_CUE_RE.search(text))


def _screens(board: Optional[dict]) -> bool:
    """Only an EVICTED player, before the finale is committed."""
    if not isinstance(board, dict) or not board:
        return False
    if board.get("finished"):
        return False
    if str(board.get("phase") or "").lower() in ("finale", "post-season", "complete"):
        return False
    return str(board.get("playerStatus") or "").lower() == "evicted"


def _phantom(unit: str) -> bool:
    if not any(rx.search(unit) for rx in _ARRIVAL_RES):
        return False
    return not _NON_ASSERTIVE_RE.search(unit)


def strip_phantom_finale(text: str, board: Optional[dict]) -> "tuple[str, list[str]]":
    """(kept text, stripped units). Units are whole mirror parts (`(?<=[.!?\\n])`), so a stripped unit never splits a persisted sentence. Fail-open."""
    try:
        if not text or not _screens(board) or not has_finale_cue(text):
            return text, []
        kept, stripped = [], []
        for part in _SPLIT_RE.split(text):
            if part and _phantom(part):
                stripped.append(part)
            else:
                kept.append(part)
        return "".join(kept), stripped
    except Exception:
        return text, []
