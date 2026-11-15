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
_ACT_SRC = _ACT_RE.pattern[len(r"\b(?:"):-len(r")\b")]


def _scan_quotes(text: str, open_at_start: bool) -> "tuple[str, bool]":
    """(the text with every quoted span blanked, whether a quote is still open at the end). A straight quote toggles; a curly open/close sets the state. Only double quotes count
    (an apostrophe is never a quote). `open_at_start` carries an open quote in from the earlier chunks of the same round (ORW-408 review: a multi-sentence quoted line streams as
    several chunks, and every chunk after the first arrives without its opening quote). A dangling open quote runs to the end of the text (fail-open: nothing in it can conflict)."""
    out: "list[str]" = []
    open_q = bool(open_at_start)
    for ch in text:
        if ch == '"':
            out.append(" " if open_q else "")
            open_q = not open_q
            if open_q:
                out.append(" ")
        elif ch == "\u201c":
            open_q = True
            out.append(" ")
        elif ch == "\u201d":
            open_q = False
            out.append(" ")
        else:
            out.append(" " if open_q else ch)
    return "".join(out), open_q


def quote_open_after(text: str, open_at_start: bool = False) -> bool:
    """True when `text` (which starts inside an open quote iff `open_at_start`) ends inside an open quote."""
    return _scan_quotes(text or "", open_at_start)[1]


def _outside_quotes(text: str, in_quote: bool = False) -> str:
    """The text with every quoted span blanked: a name inside speech is only mentioned, never the one speaking or acting. `in_quote`: the text begins inside an already-open quote."""
    return _scan_quotes(text, in_quote)[0]

_TODAY_WORDS_RE = re.compile(r"\b(?:this\s+(?:morning|afternoon|evening)|tonight|later\s+today|today|this\s+(?:very\s+)?(?:hour|night)|in\s+(?:a\s+few|an?)\s+hours?|in\s+\w+\s+minutes)\b", re.IGNORECASE)
# The scheduled EVENT itself, by the engine's day-schedule id. Deliberately specific: a bare "veto", "vote" or "comp" is strategy talk, not the event.
_EVENT_PHRASES = {
    "hoh-competition": r"(?:hoh|head\s+of\s+household)\s+(?:comp(?:etition)?|challenge)|the\s+(?:comp(?:etition)?|challenge)",
    "nominations": r"nominations?(?:\s+(?:ceremony|night))?",
    "veto-draw": r"(?:the\s+)?veto\s+(?:player\s+)?draw|the\s+draw",
    "veto-competition": r"(?:power\s+of\s+)?veto\s+(?:comp(?:etition)?|challenge)",
    "veto-ceremony": r"(?:power\s+of\s+)?veto\s+ceremony",
    "eviction": r"(?:the\s+)?(?:live\s+)?eviction(?:\s+(?:vote|night|ceremony))?|the\s+live\s+vote",
    "final-eviction": r"(?:the\s+)?(?:final\s+)?eviction(?:\s+(?:vote|night|ceremony))?|the\s+(?:final|live)\s+vote",
    "finale": r"(?:the\s+)?(?:season\s+)?finale|finale\s+night",
}
_HAPPENS = r"(?:is|are|happens?|takes?\s+place|starts?|begins?|kicks?\s+off|goes?\s+down|runs?|comes?|arrives?|is\s+scheduled|(?:will|'ll|going\s+to)\s+(?:be|happen|start|begin|take\s+place))"


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


def asleep_conflicts(text: str, asleep_names: Iterable[Any], *, in_quote: bool = False) -> "list[str]":
    """Names of asleep houseguests who SPEAK (an `@[Name] -` speaker tag at a line start, or a `Name says/asks/...` attribution) or are the grammatical subject of an act verb, outside quoted speech.
    A name inside quotation marks, or merely mentioned (object, asleep, snoring), never counts. `in_quote`: the text begins inside a quote opened in an earlier chunk.
    Names match case-sensitively and as whole words, so a houseguest named like a common word ("Will", "Grace") does not match "she will come back"."""
    hits: "list[str]" = []
    names = [n for n in (asleep_names or []) if str(n or "").strip()]
    if not text or not names:
        return hits
    outside = _outside_quotes(text, in_quote)
    for n in names:
        forms = [re.escape(f) for f in _name_forms(n)]
        alt = "(?:" + "|".join(forms) + ")"
        if re.search(r"^[ \t]*@\[\s*" + alt + r"\s*\]\s*[\u2014\u2013-]", outside, re.MULTILINE):  # review of #2728/#2700: a tag inside a quotation is not a speaker tag
            hits.append(str(n))
            continue
        subj = re.compile(r"(?<!\w)" + alt + r"(?!\w),?\s+(?i:(?:\w+ly\s+)?(?:" + _ACT_SRC + r")\b)")  # the NAME is case-sensitive; only the verb is not
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


def _event_today_re(nxt: str) -> "Optional[re.Pattern[str]]":
    """One sentence-shape regex per scheduled event: the EVENT itself happens today (event ... is/happens ... today-word, today-word ... is ... event, or the event directly followed by a today-word).
    Generic strategy talk (a bare "veto", "vote" or "comp" near a time word) is not the event and never matches."""
    ev = _EVENT_PHRASES.get(nxt)
    if not ev:
        return None
    today = _TODAY_WORDS_RE.pattern
    return re.compile(
        r"\b(?:" + ev + r")\W+(?:\w+\W+){0,2}?" + _HAPPENS + r"\b[^.!?\n]*?" + today
        + r"|\b(?:" + ev + r")\W+(?:\w+\W+)?" + today
        + r"|" + today + r"\W+(?:\w+\W+){0,3}?(?:is|are|brings?|has)\W+(?:\w+\W+){0,2}?\b(?:" + ev + r")\b",
        re.IGNORECASE)


def schedule_conflict(text: str, schedule: Any, *, in_quote: bool = False) -> Optional[str]:
    """When the engine says the next event is on a LATER day, a sentence that states that EVENT itself (named from the engine's day schedule: nominations, the veto competition, the eviction...)
    happens today / tonight / this <part of day> contradicts it. Generic strategy talk about a veto or a vote is not the event. None otherwise. `in_quote`: the text begins inside an open quote."""
    if not text or not isinstance(schedule, dict) or not schedule.get("tomorrow"):
        return None
    nxt = schedule.get("next")
    rx = _event_today_re(nxt) if isinstance(nxt, str) else None
    if rx is None:
        return None
    for sent in _sentences(_outside_quotes(text, in_quote)):  # a quoted line is a character's guess, not the narration placing the event
        if re.search(r"\b(?:tomorrow|yesterday|last\s+night|earlier|was|were|had)\b", sent, re.IGNORECASE):
            continue
        if rx.search(sent):
            return sent.strip()
    return None


def find_conflicts(text: str, state: Any, *, zero_clocks: bool, in_quote: bool = False) -> "list[str]":
    """The hard-fact conflicts in `text` against the Vault-free `getGameState` dict. Returns fact ids, e.g. ["clock-time"]. Fail-open: any hiccup => [].
    Derived from `conflict_details` (review of #2723) so a hard fact is defined in one place."""
    return [c.fact for c in conflict_details(text, state, zero_clocks=zero_clocks, in_quote=in_quote)]


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


async def check_and_count(text: str, owner: Any, *, in_quote: bool = False) -> "list[str]":
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
        facts = find_conflicts(text, state, zero_clocks=zero_clocks_on(), in_quote=in_quote)
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
    """ORWELL_PREDISPLAY_REWRITE: default OFF. A pre-deploy review found the rewrite can fire on a character's quoted line (quote state
    resets per streamed chunk), can drop or double a tool call made after the withheld sentence, and leaves the player waiting with nothing shown.
    The count-only check stays on. `1/true/on/yes` turns the rewrite on. Needs the check itself on too."""
    return (os.environ.get("ORWELL_PREDISPLAY_REWRITE", "0").strip().lower() in ("1", "true", "on", "yes")) and predisplay_check_enabled()


def conflict_details(text: str, state: Any, *, zero_clocks: bool, in_quote: bool = False) -> "list[Conflict]":
    """Like `find_conflicts` but each hit carries the name/phrase the correction needs. Same detection; fail-open."""
    try:
        if not text or not isinstance(state, dict):
            return []
        out: "list[Conflict]" = []
        for n in asleep_conflicts(text, [a.get("name") for a in (state.get("asleep") or []) if isinstance(a, dict)], in_quote=in_quote):
            out.append(Conflict(FACT_ASLEEP, n))
        if zero_clocks:
            from src.zero_clocks import sentence_states_zero_clock_time_raw
            if sentence_states_zero_clock_time_raw(text):
                out.append(Conflict(FACT_CLOCK, ""))
        sched = state.get("daySchedule")
        if schedule_conflict(text, sched, in_quote=in_quote):
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


def split_at_first_conflict(text: str, owner: Any, *, in_quote: bool = False) -> "Optional[RewriteSplit]":
    """None when there is nothing to rewrite: flag off, no FRESH cached engine state (never fetches), no conflict, or any hiccup. Otherwise the clean prefix + the withheld rest.
    The offending sentence is the first one whose addition makes the running prefix conflict (so a quote opened earlier keeps its context). `in_quote`: the chunk begins inside a quote opened by an earlier chunk of the round."""
    try:
        if not text or not predisplay_rewrite_enabled():
            return None
        state, zc = _fresh_state(owner)
        if state is None:
            return None
        parts = _parts(text)
        acc = ""
        for i, part in enumerate(parts):
            hits = conflict_details(acc + part, state, zero_clocks=zc, in_quote=in_quote)
            if hits:
                REWRITE_COUNTS[hits[0].fact] = REWRITE_COUNTS.get(hits[0].fact, 0) + 1
                logger.info("[predisplay-rewrite] withholding a sentence: %s", ",".join(h.fact for h in hits))
                return RewriteSplit(acc, "".join(parts[i:]), part, tuple(hits))
            acc += part
        return None
    except Exception:  # failsoft-ok: orw408-split (fail-open: today's behaviour, the text is emitted)
        return None


def drop_conflicting_sentences(text: str, owner: Any, *, in_quote: bool = False) -> "tuple[str, list[str]]":
    """Second pass over the redo: drop each WHOLE sentence that still conflicts, keep the rest verbatim. Returns (kept, the dropped sentences verbatim). Fail-open (text unchanged, nothing dropped)."""
    try:
        if not text or not predisplay_rewrite_enabled():
            return text, []
        state, zc = _fresh_state(owner)
        if state is None:
            return text, []
        kept, dropped = "", []
        for part in _parts(text):
            if conflict_details(kept + part, state, zero_clocks=zc, in_quote=in_quote):
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


_TAIL_CHARS = 200


def _flatten_tool_history(messages: "list[dict]") -> "list[dict]":
    """The history as plain chat: this one-shot call sends NO tools, and a provider that sees assistant `tool_calls` / `tool` messages without a tool list can refuse the request. Same
    shape the loop already uses for text-protocol results (`[Tool execution results]` as a user message). New dicts; the caller's list is untouched."""
    out: "list[dict]" = []
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role == "tool":
            out.append({"role": "user", "content": "[Tool execution results]\n\n" + str(m.get("content") or "")})
            continue
        nm = {k: v for k, v in m.items() if k not in ("tool_calls", "reasoning_content")}
        if role == "assistant" and m.get("tool_calls"):
            if not str(nm.get("content") or "").strip():
                continue  # a calls-only assistant turn has no prose to keep
        out.append(nm)
    return out


def continuation_messages(messages: "list[dict]", shown: str, conflicts: "Iterable[Conflict]") -> "list[dict]":
    """The turn's messages (tool turns flattened) + what the player has already seen this round as the assistant's partial reply + ONE final USER message that names the fact(s),
    quotes the exact tail of the shown text (the last ~200 characters) and says to continue from there without repeating it."""
    facts = " ".join(dict.fromkeys(_correction_line(c) for c in conflicts if _correction_line(c)))
    out = _flatten_tool_history(messages)
    if (shown or "").strip():
        tail = shown.rstrip()[-_TAIL_CHARS:]
        ask = (f"Your reply so far ended exactly with: \"{tail}\" Continue the scene from the very next sentence after that, as the same reply. Do NOT restart the scene, "
               "do NOT repeat or paraphrase any of the text already shown, do not mention this correction, and call no tools.")
        out.append({"role": "assistant", "content": shown})
    else:
        ask = "Write the scene now. Do not mention this correction and call no tools."
    out.append({"role": "user", "content": f"CONTINUITY CORRECTION: {facts} {ask}".strip()})
    return out


def _norm(s: str) -> str:
    s = (s or "").replace("\u201c", '"').replace("\u201d", '"').replace("\u2018", "'").replace("\u2019", "'")
    return re.sub(r"\s+", " ", re.sub(r"[\s\"'*_]+$|^[\s\"'*_]+", "", s)).strip().lower()


def drop_repeated_prefix(redo: str, shown: str) -> str:
    """Drop LEADING sentences of the redo that repeat (exact, after whitespace/quote/case normalisation) the tail of what was already shown: a model that restarts the scene instead of
    continuing it must not narrate the same lines twice. Stops at the first sentence that is new. Lossless otherwise (the rest keeps its spacing)."""
    try:
        if not redo or not (shown or "").strip():
            return redo
        shown_sents = [n for n in (_norm(p) for p in _parts(shown)) if n]
        recent = set(shown_sents[-6:])
        tail_norm = _norm(shown[-(_TAIL_CHARS * 2):])
        parts = _parts(redo)
        i = 0
        while i < len(parts):
            n = _norm(parts[i])
            if not n:
                i += 1
                continue
            if n in recent or (len(n) >= 12 and n in tail_norm):
                i += 1
                continue
            break
        return "".join(parts[i:])
    except Exception:  # failsoft-ok: orw408-repeat-drop (fail-open: the redo is used as is; the guard chain still judges it)
        return redo
