"""ORW-408 (first slice) - the deterministic pre-display conflict check.

Owner ruling: when narration contradicts the engine's hard facts, quietly rewrite once (regenerate with the specific correction, show only the fixed reply); only if the redo still fails remove the
smallest wrong part; never cut mid-sentence. THIS SLICE is the pure CHECKER plus a counter. It does NOT rewrite: the live turn streams each sentence-buffered chunk to the player as it is produced
(agent_loop `_guard_stream_chunk` -> `yield data: {delta}`), so no whole reply exists before part of it is shown. A true "regenerate then show" needs the reply held back until its end; that is
the remaining slice (see the PR body). Until then a hit is only COUNTED (plain counter + INFO log; not a health event).

Three hard facts, all from Vault-free public state:
  asleep-speaks   a houseguest the engine lists as asleep speaks or acts in the scene
  clock-time      a clock time is stated while the zero-clocks setting is on (ORW-377 wording rules, reused)
  schedule-words  the next event is on a later day (`daySchedule.tomorrow`) but the text puts it today ("this afternoon", "tonight")
Pure functions, fail-open, no rng.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any, Iterable, NamedTuple, Optional

logger = logging.getLogger(__name__)

FACT_ASLEEP = "asleep-speaks"
FACT_CLOCK = "clock-time"
FACT_SCHEDULE = "schedule-words"

# The sleeper is only MENTIONED (asleep, snoring, in bed, dreaming): allowed. Anything else near their name with a voice or a movement is a conflict.
_SLEEP_OK_RE = re.compile(r"\b(?:asleep|sleep\w*|snor\w+|slumber\w*|dream\w*|turned\s+in|in\s+(?:his|her|their)\s+bed|in\s+bed|under\s+the\s+covers|out\s+cold|fast\s+asleep)\b", re.IGNORECASE)
_ACT_RE = re.compile(
    r"\b(?:says?|said|asks?|asked|replies|replied|whispers?|whispered|shouts?|shouted|laughs?|laughed|grins?|grinned|smiles?|smiled|walks?|walked|"
    r"steps?|stepped|enters?|entered|comes?|came|sits?|sat|stands?|stood|looks?\s+up|turns?|turned|grabs?|grabbed|pours?|poured|nods?|nodded|"
    r"shrugs?|shrugged|joins?|joined|leans?|leaned|opens?|opened|hugs?|hugged|mutters?|muttered|calls?|called|speaks?|spoke)\b", re.IGNORECASE)
_QUOTED_RE = re.compile(r"[\"“][^\"“”]*(?:[\"”]|$)")  # quoted speech; a dangling open quote runs to the end (fail-open)
_ACT_SRC = _ACT_RE.pattern[len(r"\b(?:"):-len(r")\b")]


def _outside_quotes(text: str) -> str:
    """The text with every quoted span blanked: a name inside speech is only mentioned, never the one speaking or acting."""
    return _QUOTED_RE.sub(" ", text)

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
    """Names of asleep houseguests who SPEAK (an `@[Name] -` speaker tag at a line start, or a `Name says/asks/...` attribution) or are the grammatical subject of an act verb, outside quoted speech.
    A name inside quotation marks, or merely mentioned (object, asleep, snoring), never counts."""
    hits: "list[str]" = []
    names = [n for n in (asleep_names or []) if str(n or "").strip()]
    if not text or not names:
        return hits
    outside = _outside_quotes(text)
    for n in names:
        forms = [re.escape(f) for f in _name_forms(n)]
        alt = "(?:" + "|".join(forms) + ")"
        if re.search(r"^[ \t]*@\[\s*" + alt + r"\s*\]\s*[\u2014\u2013-]", text, re.MULTILINE):
            hits.append(str(n))
            continue
        subj = re.compile(r"(?<!\w)" + alt + r"(?!\w),?\s+(?:\w+ly\s+)?(?:" + _ACT_SRC + r")\b", re.IGNORECASE)
        for sent in _sentences(outside):
            m = subj.search(sent)
            if not m:
                continue
            nm = re.search(r"(?<!\w)" + alt + r"(?!\w)", sent)
            rest = sent[:nm.start()] + " " + sent[nm.end():]  # the name itself must not count as a sleep word
            if _SLEEP_OK_RE.search(rest):
                continue  # mentioned as sleeping, no voice
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
    for sent in _sentences(_outside_quotes(text)):  # a quoted line is a character's guess, not the narration placing the event
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


PREDISPLAY_COUNTS: "dict[str, int]" = {}


def record_conflicts(facts: "list[str]", user: Any = None) -> None:
    """Count each hit in a plain counter + an INFO log line. Deliberately NOT record_soft_failure: until the rewrite slice exists a count-only hit is not a health event and must not show RED on the admin page."""
    for f in facts:
        PREDISPLAY_COUNTS[f] = PREDISPLAY_COUNTS.get(f, 0) + 1
        logger.info("[predisplay-conflict] %s (count only, no rewrite in this slice)", f)


async def check_and_count(text: str, owner: Any) -> "list[str]":
    """Find conflicts against the ALREADY-CACHED engine state and count them. Never fetches: with no fresh cached state the check is skipped, so a slow engine cannot delay a streamed chunk.
    Returns the fact ids (the caller ignores them in this slice). Off by `ORWELL_PREDISPLAY_CHECK=0`."""
    if not text or not predisplay_check_enabled():
        return []
    try:
        from src import engine_read_cache
        from src.zero_clocks import zero_clocks_on
        state = engine_read_cache.peek("getGameState", owner)
        if state is None:
            return []
        facts = find_conflicts(text, state, zero_clocks=zero_clocks_on())
        if facts:
            record_conflicts(facts, owner)
        return facts
    except Exception:  # failsoft-ok: counter only
        return []


# ── ORW-408 (rewrite slice): sentence-level quiet rewrite ─────────────────────────────────────────────────────────────
# The loop asks `split_at_first_conflict` about each guarded chunk BEFORE it is emitted. A hit withholds that sentence and the rest of the stream; ONE continuation call
# (`continuation_messages`) re-voices from the text already shown; `drop_conflicting_sentences` removes any whole sentence of the redo that still conflicts. Pure, fail-open, no rng.
REWRITE_COUNTS: "dict[str, int]" = {}


class Conflict(NamedTuple):
    fact: str
    detail: str  # the name / event label the correction names ("" for clock-time)


class RewriteSplit(NamedTuple):
    keep: str  # the sentences BEFORE the first conflicting one: safe to emit
    withheld: str  # the conflicting sentence and everything after it in the chunk
    sentence: str  # the first conflicting sentence alone
    conflicts: "tuple[Conflict, ...]"


def predisplay_rewrite_enabled() -> bool:
    """ORWELL_PREDISPLAY_REWRITE: default ON (built means on: any error falls back to today's emit-as-is). `0/false/off/no` turns it off. Needs the check itself on too."""
    return (os.environ.get("ORWELL_PREDISPLAY_REWRITE", "1").strip().lower() not in ("0", "false", "off", "no")) and predisplay_check_enabled()


def conflict_details(text: str, state: Any, *, zero_clocks: bool) -> "list[Conflict]":
    """Like `find_conflicts` but each hit carries the name/phrase the correction needs. Same detection; fail-open."""
    try:
        if not text or not isinstance(state, dict):
            return []
        out: "list[Conflict]" = []
        for n in asleep_conflicts(text, [a.get("name") for a in (state.get("asleep") or []) if isinstance(a, dict)]):
            out.append(Conflict(FACT_ASLEEP, n))
        if zero_clocks:
            from src.zero_clocks import sentence_states_zero_clock_time_raw
            if sentence_states_zero_clock_time_raw(text):
                out.append(Conflict(FACT_CLOCK, ""))
        sched = state.get("daySchedule")
        if schedule_conflict(text, sched):
            out.append(Conflict(FACT_SCHEDULE, str((sched or {}).get("next") or "").replace("-", " ")))
        return out
    except Exception:  # failsoft-ok: orw408-detail-check (fail-open: an unreadable check never holds narration)
        return []


_SENT_RE = re.compile(r"[^.!?\n]*(?:[.!?]+[\"\u201d\u2019')\]*_]*[ \t]*\n?|\n)|[^.!?\n]+$")


def _parts(text: str) -> "list[str]":
    # a sentence ends at . ! ? (plus any closing quote/emphasis marks that belong to it) or a newline; trailing whitespace stays with it. Lossless: "".join(parts) == text
    return _SENT_RE.findall(text)


def _fresh_state(owner: Any):
    from src import engine_read_cache
    from src.zero_clocks import zero_clocks_on
    return engine_read_cache.peek("getGameState", owner), zero_clocks_on()


def split_at_first_conflict(text: str, owner: Any) -> "Optional[RewriteSplit]":
    """None when there is nothing to rewrite: flag off, no FRESH cached engine state (never fetches), no conflict, or any hiccup. Otherwise the clean prefix + the withheld rest.
    The offending sentence is the first one whose addition makes the running prefix conflict (so a quote opened earlier keeps its context)."""
    try:
        if not text or not predisplay_rewrite_enabled():
            return None
        state, zc = _fresh_state(owner)
        if state is None:
            return None
        parts = _parts(text)
        acc = ""
        for i, part in enumerate(parts):
            hits = conflict_details(acc + part, state, zero_clocks=zc)
            if hits:
                REWRITE_COUNTS[hits[0].fact] = REWRITE_COUNTS.get(hits[0].fact, 0) + 1
                logger.info("[predisplay-rewrite] withholding a sentence: %s", ",".join(h.fact for h in hits))
                return RewriteSplit(acc, "".join(parts[i:]), part, tuple(hits))
            acc += part
        return None
    except Exception:  # failsoft-ok: orw408-split (fail-open: today's behaviour, the text is emitted)
        return None


def drop_conflicting_sentences(text: str, owner: Any) -> "tuple[str, list[str]]":
    """Second pass over the redo: drop each WHOLE sentence that still conflicts, keep the rest verbatim. Returns (kept, the dropped sentences verbatim). Fail-open (text unchanged, nothing dropped)."""
    try:
        if not text or not predisplay_rewrite_enabled():
            return text, []
        state, zc = _fresh_state(owner)
        if state is None:
            return text, []
        kept, dropped = "", []
        for part in _parts(text):
            if conflict_details(kept + part, state, zero_clocks=zc):
                dropped.append(part)
                continue
            kept += part
        if dropped:
            logger.info("[predisplay-rewrite] redo still conflicted: dropped %d whole sentence(s)", len(dropped))
        return kept, dropped
    except Exception:  # failsoft-ok: orw408-drop (fail-open: text unchanged)
        return text, []


def _correction_line(c: Conflict) -> str:
    if c.fact == FACT_ASLEEP:
        return f"{c.detail} is asleep and cannot speak or act in this scene."
    if c.fact == FACT_CLOCK:
        return "Do not state clock times; use the part of day."
    if c.fact == FACT_SCHEDULE:
        return f"The {c.detail or 'next event'} is tomorrow, not today; do not place it today or tonight."
    return correction_for(c.fact)


def continuation_messages(messages: "list[dict]", shown: str, conflicts: "Iterable[Conflict]") -> "list[dict]":
    """The turn's messages + what the player has already seen this round as the assistant's partial reply + ONE short system correction naming the fact(s)."""
    facts = " ".join(dict.fromkeys(_correction_line(c) for c in conflicts if _correction_line(c)))
    if (shown or "").strip():
        ask = ("Continue the scene from exactly where the text shown so far ends. Do not repeat any of it, do not mention this correction, and call no tools.")
    else:
        ask = "Write the scene now. Do not mention this correction and call no tools."
    out = list(messages)
    if (shown or "").strip():
        out.append({"role": "assistant", "content": shown})
    out.append({"role": "system", "content": f"CONTINUITY CORRECTION: {facts} {ask}".strip()})
    return out
