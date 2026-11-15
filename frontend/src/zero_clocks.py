"""ORW-377 - "zero clocks in the house" (Ryne, playtest 2026-11-15).

Like the real show, the house has no clocks: the narrator and the houseguests name the PART OF THE DAY, never a clock time. PRESENTATION ONLY. The engine keeps its internal clock (day schedule, sleep debt,
bedtime, wake hour, due events all run on it, untouched); this module only changes what the narrator is HANDED and what the player is SHOWN. One switch, the FE setting `zero_clocks` (default ON), read per
call so it flips with no restart; OFF => every function here is an identity / returns False and the old behaviour is byte-identical.

Pure helpers, no I/O beyond the settings read. Fail-open everywhere.
"""
from __future__ import annotations

import json
import re
from typing import Any, Optional


def zero_clocks_on() -> bool:
    try:
        from src.settings import get_setting
        return bool(get_setting("zero_clocks", True))
    except Exception:  # failsoft-ok: presentation-only setting read; default ON
        return True


def band_for_minutes(minute_of_day: int) -> str:
    """The seven spoken bands; mirrors `clockBandFor` in src/engine/timeOfDay.ts (the engine's own band for the narrator prompt)."""
    h = (minute_of_day % 1440) / 60.0
    if h < 2:
        return "late night"
    if h < 8:  # ORW-392: early morning runs from 2am to the house's wake-up call (the old "small hours" band is gone)
        return "early morning"
    if h < 11.5:
        return "morning"
    if h < 13.5:
        return "midday"
    if h < 16:
        return "afternoon"
    if h < 20:
        return "evening"
    return "night"


_LABEL_RE = re.compile(r"^\s*(\d{1,2}):(\d{2})\s*(am|pm)(?:,\s*Day\s+(\d+))?\s*$", re.IGNORECASE)
_LABEL_ANY_RE = re.compile(r"\b(\d{1,2}):(\d{2})\s*(am|pm)\b(?:,\s*Day\s+(\d+))?", re.IGNORECASE)


def _minutes(h: int, m: int, ap: str) -> int:
    return ((h % 12) + (12 if ap.lower() == "pm" else 0)) * 60 + m


def band_label(label: Any) -> Optional[str]:
    """"4:15am, Day 5" -> "early morning, Day 5"; None when it is not an engine clock label."""
    mm = _LABEL_RE.match(label) if isinstance(label, str) else None
    if not mm:
        return None
    band = band_for_minutes(_minutes(int(mm.group(1)), int(mm.group(2)), mm.group(3)))
    return band + (f", Day {int(mm.group(4))}" if mm.group(4) else "")


def narrator_clock(label: Any) -> str:
    """What a narrator-facing note may quote of the engine clock: the band label when zero clocks is ON (and the label parses), else the raw label."""
    s = str(label) if label is not None else ""
    if zero_clocks_on():
        return band_label(s) or s
    return s


def _scrub_obj(o: Any) -> Any:
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            if k == "clockLabel" and isinstance(v, str):
                out[k] = band_label(v) or v
            elif k == "minutesUntil":
                continue  # a count of in-game minutes is a clock reading; `phase`/`tomorrow` already say when
            else:
                out[k] = _scrub_obj(v)
        return out
    if isinstance(o, list):
        return [_scrub_obj(x) for x in o]
    return o


def scrub_tool_output(text: Any) -> Any:
    """The tool result the MODEL reads: `clockLabel` becomes the band label and `minutesUntil` is dropped. Non-JSON text only has an engine clock label swapped. OFF / any hiccup => unchanged."""
    if not isinstance(text, str) or not text or not zero_clocks_on():
        return text
    try:
        if "clockLabel" not in text and "minutesUntil" not in text and not _LABEL_ANY_RE.search(text):
            return text
        try:
            data = json.loads(text)
        except Exception:
            data = None
        if isinstance(data, (dict, list)):
            return json.dumps(_scrub_obj(data), indent=2)
        return _LABEL_ANY_RE.sub(lambda m: band_for_minutes(_minutes(int(m.group(1)), int(m.group(2)), m.group(3))) + (f", Day {int(m.group(4))}" if m.group(4) else ""), text)
    except Exception:  # failsoft-ok: presentation-only scrub; the raw text stands (fail open)
        return text


# ---- the guard: a clock-time SENTENCE is dropped, never the scene ----
# DETECTED (a stated reading of the clock): H:MM ("6:15", "8:15 in the morning"), a number + am/pm ("3am", "3 a.m."), "N o'clock", "quarter/half past|to N", "twenty past six", "N in the
# morning/afternoon/evening" ("three in the morning"), "it's eight-thirty" / "at seven fifteen", "twelve noon/midnight", "noon/midnight sharp|exactly|on the dot".
# DELIBERATELY ALLOWED: plain "noon"/"midnight" (bands people say naturally), durations ("for two hours", "an hour later"), counts and days ("three of us", "7 days", "Day 4"), a bare "at eight" / "at nine".
_HW = r"(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})"
_TO_FORM_RE = re.compile(r"\b(?:five|ten|twenty(?:[- ]five)?)(?:\s+minutes)?\s+(?:to|till|until)\s+" + _HW + r"\b(?!\s+(?:minutes?|hours?|days?|weeks?|people|of|more|times|seconds?|years?))", re.IGNORECASE)
_VOTE_BEFORE_RE = re.compile(r"\b(?:vot(?:e|es|ed|ing)|tallies|tally|ballots?|margin|score[ds]?|unanimous(?:ly)?)\b", re.IGNORECASE)  # review of #2751: a tally word BEFORE "five to two" makes it a count, not a time
_CLOCK_TIME_RES = (
    re.compile(r"(?<![\d:.])\d{1,2}:[0-5]\d(?![\d:])"),
    re.compile(r"(?<![\w.])\d{1,2}\s?(?:a\.?m\.?|p\.?m\.?)(?![\w])", re.IGNORECASE),
    re.compile(r"\b" + _HW + r"\s+o[’']?\s?clock\b", re.IGNORECASE),
    re.compile(r"\b(?:(?:a\s+)?quarter|half)\s+(?:past|to|after|till|until)\s+" + _HW + r"\b", re.IGNORECASE),
    re.compile(r"\b(?:five|ten|twenty(?:[- ]five)?)(?:\s+minutes)?\s+(?:past|after)\s+" + _HW + r"\b", re.IGNORECASE),
    # review of #2657: "ten to eight" too. The to-form is its own constant (`_TO_FORM_RE`): a vote tally reads the same ("by a vote of five to two"), see `sentence_states_zero_clock_time_raw`
    _TO_FORM_RE,
    re.compile(r"(?<![\w:.])\d{1,2}\.[0-5]\d\s?(?:a\.?m\.?|p\.?m\.?)(?![\w])", re.IGNORECASE),  # review of #2657: "9.15am" / "4.30pm"
    re.compile(r"(?<!\bno )(?<!\bany )(?<!\bevery )(?<!\bsome )(?<!\beach )(?<!\bthe )(?<!\bfor )\b" + _HW + r"\s+in\s+the\s+(?:morning|afternoon|evening)\b", re.IGNORECASE),
    re.compile(r"\b(?:it(?:'s|’s|\s+is)|at|by|around|about)\s+" + _HW + r"[- ](?:fifteen|thirty|forty[- ]five|oh[- ]\w+)\b", re.IGNORECASE),
    re.compile(r"\btwelve\s+(?:noon|midnight)\b|\b(?:noon|midnight)\s+(?:sharp|exactly)\b|\bexactly\s+(?:at\s+)?(?:noon|midnight)\b|\b(?:noon|midnight)\s+on\s+the\s+dot\b", re.IGNORECASE),
)


def sentence_states_zero_clock_time_raw(text: Any) -> bool:
    """Does `text` state a clock reading? Pure; independent of the setting (the caller gates on `zero_clocks_on`)."""
    if not isinstance(text, str) or not text:
        return False
    for r in _CLOCK_TIME_RES:
        for m in r.finditer(text):
            if r is _TO_FORM_RE and _VOTE_BEFORE_RE.search(text[:m.start()]):
                continue  # "By a vote of five to two, ...": a tally, so the eviction sentence must not be dropped as a clock reading
            return True
    return False
