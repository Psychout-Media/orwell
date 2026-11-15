"""ORW-408 (first slice) - the deterministic pre-display conflict check.

Owner ruling: when narration contradicts the engine's hard facts, quietly rewrite once (regenerate with the specific correction, show only the fixed reply); only if the redo still fails remove the
smallest wrong part; never cut mid-sentence. THIS SLICE is the pure CHECKER plus a counter. It does NOT rewrite: the live turn streams each sentence-buffered chunk to the player as it is produced
(agent_loop `_guard_stream_chunk` -> `yield data: {delta}`), so no whole reply exists before part of it is shown. A true "regenerate then show" needs the reply held back until its end; that is
the remaining slice (see the PR body). Until then a hit is only COUNTED as `predisplay-conflict:<fact>` through the soft-fail ledger.

Three hard facts, all from Vault-free public state:
  asleep-speaks   a houseguest the engine lists as asleep speaks or acts in the scene
  clock-time      a clock time is stated while the zero-clocks setting is on (ORW-377 wording rules, reused)
  schedule-words  the next event is on a later day (`daySchedule.tomorrow`) but the text puts it today ("this afternoon", "tonight")
Pure functions, fail-open, no rng.
"""
from __future__ import annotations

import os
import re
from typing import Any, Iterable, Optional

FACT_ASLEEP = "asleep-speaks"
FACT_CLOCK = "clock-time"
FACT_SCHEDULE = "schedule-words"

# The sleeper is only MENTIONED (asleep, snoring, in bed, dreaming): allowed. Anything else near their name with a voice or a movement is a conflict.
_SLEEP_OK_RE = re.compile(r"\b(?:asleep|sleep\w*|snor\w+|slumber\w*|dream\w*|turned\s+in|in\s+(?:his|her|their)\s+bed|in\s+bed|under\s+the\s+covers|out\s+cold|fast\s+asleep)\b", re.IGNORECASE)
_ACT_RE = re.compile(
    r"\b(?:says?|said|asks?|asked|replies|replied|whispers?|whispered|shouts?|shouted|laughs?|laughed|grins?|grinned|smiles?|smiled|walks?|walked|"
    r"steps?|stepped|enters?|entered|comes?|came|sits?|sat|stands?|stood|looks?\s+up|turns?|turned|grabs?|grabbed|pours?|poured|nods?|nodded|"
    r"shrugs?|shrugged|joins?|joined|leans?|leaned|opens?|opened|hugs?|hugged|mutters?|muttered|calls?|called|speaks?|spoke)\b", re.IGNORECASE)
_QUOTE_RE = re.compile(r"[\"“”]")

_TODAY_WORDS_RE = re.compile(r"\b(?:this\s+(?:morning|afternoon|evening)|tonight|later\s+today|today|this\s+(?:very\s+)?(?:hour|night)|in\s+(?:a\s+few|an?)\s+hours?|in\s+\w+\s+minutes)\b", re.IGNORECASE)
_EVENT_WORDS = {
    "hoh-competition": r"hoh|head\s+of\s+household|competition|comp",
    "nominations": r"nominat\w+",
    "veto-draw": r"veto|draw",
    "veto-competition": r"veto|competition|comp",
    "veto-ceremony": r"veto|ceremony",
    "eviction": r"evict\w+|vote|live\s+vote",
    "final-eviction": r"evict\w+|vote",
    "finale": r"finale",
}


def predisplay_check_enabled() -> bool:
    return os.environ.get("ORWELL_PREDISPLAY_CHECK", "1").strip().lower() not in ("0", "false", "off", "no")


def _sentences(text: str) -> "list[str]":
    return [s for s in re.split(r"(?<=[.!?\n])", text) if s.strip()]


def _name_forms(name: Any) -> "list[str]":
    n = str(name or "").strip()
    if not n:
        return []
    forms = {n}
    first = n.split()[0]
    if len(first) >= 3:
        forms.add(first)
    return sorted(forms, key=len, reverse=True)


def asleep_conflicts(text: str, asleep_names: Iterable[Any]) -> "list[str]":
    """Names of asleep houseguests the text has speaking or acting. A sentence that only says they are asleep is fine."""
    hits: "list[str]" = []
    names = [n for n in (asleep_names or []) if str(n or "").strip()]
    if not text or not names:
        return hits
    for sent in _sentences(text):
        for n in names:
            for form in _name_forms(n):
                m = re.search(r"(?<!\w)" + re.escape(form) + r"(?!\w)", sent)
                if not m:
                    continue
                rest = sent[:m.start()] + " " + sent[m.end():]  # the name itself must not count as a sleep word
                if _SLEEP_OK_RE.search(rest) and not _QUOTE_RE.search(sent):
                    break  # mentioned as sleeping, no voice
                if _QUOTE_RE.search(sent) or _ACT_RE.search(sent):
                    hits.append(str(n))
                break
    return sorted(set(hits))


def schedule_conflict(text: str, schedule: Any) -> Optional[str]:
    """When the engine says the next event is on a LATER day, a sentence that names that event with a today-word contradicts it. None otherwise."""
    if not text or not isinstance(schedule, dict) or not schedule.get("tomorrow"):
        return None
    nxt = schedule.get("next")
    pat = _EVENT_WORDS.get(nxt) if isinstance(nxt, str) else None
    if not pat:
        return None
    ev = re.compile(r"\b(?:" + pat + r")\b", re.IGNORECASE)
    for sent in _sentences(text):
        if re.search(r"\b(?:tomorrow|yesterday|last\s+night|earlier|was|were|had)\b", sent, re.IGNORECASE):
            continue
        if ev.search(sent) and _TODAY_WORDS_RE.search(sent):
            return sent.strip()
    return None


def find_conflicts(text: str, state: Any, *, zero_clocks: bool) -> "list[str]":
    """The hard-fact conflicts in `text` against the Vault-free `getGameState` dict. Returns fact ids, e.g. ["clock-time"]. Fail-open: any hiccup => []."""
    try:
        if not text or not isinstance(state, dict):
            return []
        out: "list[str]" = []
        if asleep_conflicts(text, [a.get("name") for a in (state.get("asleep") or []) if isinstance(a, dict)]):
            out.append(FACT_ASLEEP)
        if zero_clocks:
            from src.zero_clocks import sentence_states_zero_clock_time_raw
            if sentence_states_zero_clock_time_raw(text):
                out.append(FACT_CLOCK)
        if schedule_conflict(text, state.get("daySchedule")):
            out.append(FACT_SCHEDULE)
        return out
    except Exception:  # failsoft-ok: a counter-only check; narration is never held on its own hiccup
        return []


def correction_for(fact: str) -> str:
    """The short correction the (future) single regeneration would carry. Names the fact, not the guilty text."""
    return {
        FACT_ASLEEP: "A houseguest who has turned in for the night spoke or acted; they are asleep and do not speak or act.",
        FACT_CLOCK: "A clock time was stated; the house has no clocks, so name only the part of the day.",
        FACT_SCHEDULE: "The next event is on a later day; do not place it today or tonight.",
    }.get(fact, "")


def record_conflicts(facts: "list[str]", user: Any = None) -> None:
    """Count each hit as `predisplay-conflict:<fact>` through the soft-fail ledger. Never raises."""
    for f in facts:
        try:
            from src.log_rings import record_soft_failure
            record_soft_failure("predisplay-conflict:" + f, RuntimeError("narration contradicted an engine hard fact"), corrected="counted only (no rewrite in this slice)", user=user)
        except Exception:  # failsoft-ok: recorder-self
            pass


async def check_and_count(text: str, owner: Any) -> "list[str]":
    """Read the live state, find conflicts, count them. Returns the fact ids (the caller ignores them in this slice). Off by `ORWELL_PREDISPLAY_CHECK=0`."""
    if not text or not predisplay_check_enabled():
        return []
    try:
        from src import orwell_engine
        from src.zero_clocks import zero_clocks_on
        state = await orwell_engine.get_game_state_polled(user=owner)
        facts = find_conflicts(text, state, zero_clocks=zero_clocks_on())
        if facts:
            record_conflicts(facts, owner)
        return facts
    except Exception:  # failsoft-ok: counter only
        return []
