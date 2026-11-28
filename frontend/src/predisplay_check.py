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

ORW-715 adds two more, from the engine's own ceremony facts (`ceremony.veto.decision`, `eviction.evictee`), checked INCLUDING quoted speech (a houseguest voicing the result is how an invented one reaches the
player): veto-decision (a veto decision stated before the engine made one, or the wrong one: use / not use / who came down / the replacement) and evictee-named (a different houseguest named as evicted).
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any, Iterable, NamedTuple, Optional

logger = logging.getLogger(__name__)

_STATE_FIELDS = ("asleep", "daySchedule", "ceremony", "eviction", "whereabouts", "timeOfDay", "earlyMorning")  # the only parts of the cached board the checks read
FACT_ASLEEP = "asleep-speaks"
FACT_CLOCK = "clock-time"
FACT_SCHEDULE = "schedule-words"
FACT_PART_OF_DAY = "part-of-day"
FACT_VETO = "veto-decision"  # ORW-715
FACT_EVICTEE = "evictee-named"  # ORW-715
FACT_EVENT_ROOM = "event-room"  # ORW-740b
FACT_PLAYER_ROOM = "player-room"  # ORW-1003, a hard fact here since ORW-408
FACT_TIME_JUMP = "time-jump"  # ORW-1150: the narration passes the night (morning comes, hours go by, people wake) while the engine clock still stands at night
FACT_BED_WORD = "bed-word"  # ORW-1150: a bed word the room's real beds do not have ("double" in a room of singles)
FACT_SLEEPER_ROOM = "sleeper-room"  # ORW-1150: a sleeping houseguest the engine does not have in the player's room is narrated in a bed there
FACT_ABSENT = "absent-present"  # ORW-408: someone who is not in the room speaks or acts there (the presence wall detects it)

# The sleeper is only MENTIONED (asleep, snoring, in bed, dreaming): allowed. Anything else near their name with a voice or a movement is a conflict.
_SLEEP_OK_RE = re.compile(r"\b(?:asleep|sleep\w*|snor\w+|slumber\w*|dream\w*|turned\s+in|in\s+(?:his|her|their)\s+bed|in\s+bed|under\s+the\s+covers|out\s+cold|fast\s+asleep)\b", re.IGNORECASE)
_ACT_RE = re.compile(
    r"\b(?:says?|said|asks?|asked|replies|replied|whispers?|whispered|shouts?|shouted|laughs?|laughed|grins?|grinned|smiles?|smiled|walks?|walked|"
    r"steps?|stepped|enters?|entered|comes?|came|sits?|sat|stands?|stood|looks?\s+up|turns?|turned|grabs?|grabbed|pours?|poured|nods?|nodded|"
    r"shrugs?|shrugged|joins?|joined|leans?|leaned|opens?|opened|hugs?|hugged|mutters?|muttered|calls?|called|speaks?|spoke)\b", re.IGNORECASE)
_ACT_SRC = _ACT_RE.pattern[len(r"\b(?:"):-len(r")\b")]


_MAX_CARRIED_QUOTE = 600  # a quote carried this many characters without a closing mark is a stray mark, not speech: stop exempting


def _scan_quotes(text: str, open_at_start: bool) -> "tuple[str, bool]":
    """(the text with every quoted span blanked, whether a quote is still open at the end). A straight quote toggles; a curly open/close sets the state. Only double quotes count
    (an apostrophe is never a quote, and a straight quote right after a digit is an inch mark, never an opening quote). `open_at_start` carries an open quote in from the earlier chunks of
    the same round (ORW-408 review: a multi-sentence quoted line streams as several chunks, and every chunk after the first arrives without its opening quote). The carry is BOUNDED so one
    stray mark cannot exempt the rest of the round: an open quote ends at a paragraph break (a blank line) and after `_MAX_CARRIED_QUOTE` characters without a closing mark."""
    out: "list[str]" = []
    open_q = bool(open_at_start)
    run = 0  # characters spent inside the current open quote
    blank_pending = False  # a newline has been seen since the last non-space character
    prev = ""
    for ch in text:
        if ch == "\n":
            if blank_pending and open_q:
                open_q, run = False, 0  # a blank line ends any quote
            blank_pending = True
            out.append(" " if open_q else ch)
            prev = ch
            continue
        if ch not in " \t\r":
            blank_pending = False
        if ch == '"':
            if not open_q and prev.isdigit():
                out.append(ch)  # an inch mark (5'10"), not a quote
            else:
                out.append(" " if open_q else "")
                open_q = not open_q
                run = 0
                if open_q:
                    out.append(" ")
        elif ch == "\u201c":
            open_q, run = True, 0
            out.append(" ")
        elif ch == "\u201d":
            open_q, run = False, 0
            out.append(" ")
        else:
            out.append(" " if open_q else ch)
        if open_q:
            run += 1
            if run > _MAX_CARRIED_QUOTE:
                open_q, run = False, 0
        prev = ch
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


# ── ORW-715: the veto decision and the vote result as hard facts ───────────────────────────────────────────────────────
# A season playtest had a houseguest announce "I'm not using it" a day before the engine made any veto decision, and "I used it. I took X down" when the engine had the holder save herself. The engine now
# publishes `ceremony.veto.decision` ({made: false} until the ceremony's result step; then used / saved / replacement) and `eviction.evictee` once the vote is decided; these checks compare the text to them.
# Unlike the other facts, QUOTED speech is checked here: a houseguest voicing the result in dialogue is exactly how the invented result reached the player. Hypothetical, conditional and question
# sentences are exempt, as is anything that says it has not happened yet. Names are matched against the engine's own ceremony names; a name the board does not know is never a conflict.
_HEDGE_RE = re.compile(r"\b(?:if|unless|whether|would|could|might|may|maybe|perhaps|should|suppose|supposing|wonder\w*|what\s+if|hypothetical\w*|when|until|promis\w+|swear\w*|yet|still\s+deciding|has(?:n't|\s+not)\s+decided|not\s+decided)\b", re.IGNORECASE)
_VETO_WORD = r"(?:the\s+(?:power\s+of\s+)?veto|the\s+pov|my\s+veto|that\s+veto)"
_FP = r"I(?:'ve|\s+have|'m|\s+am)?"  # first person: "I used it" needs no veto word, the speaker is the holder in a veto scene
_USE_RE = re.compile(
    r"\b" + _FP + r"\s+(?:used|using|decided\s+to\s+use|chosen\s+to\s+use|choosing\s+to\s+use)\s+(?:it|" + _VETO_WORD + r")"
    + r"|\b(?:used|uses|using)\s+" + _VETO_WORD
    + r"|\b" + _VETO_WORD + r"\s+(?:was|is|has\s+been|got)\s+used\b"
    + r"|\bdecided\s+to\s+use\s+(?:it|" + _VETO_WORD + r")|\bI(?:'ve|\s+have)?\s+decided\s+to\s+use\b", re.IGNORECASE)
_NOT_USE_RE = re.compile(
    r"\bI(?:'m|\s+am)\s+not\s+(?:using|going\s+to\s+use)\b|\bI\s+(?:won't|will\s+not|do\s+not|don't|did\s+not|didn't)\s+use\b|\bI(?:'ve|\s+have)?\s+decided\s+not\s+to\s+use\b"
    r"|\bdecided\s+not\s+to\s+use\s+(?:it|" + _VETO_WORD + r")|\b(?:did\s+not|didn't|does\s+not|doesn't|will\s+not|won't|is\s+not\s+going\s+to)\s+use\s+" + _VETO_WORD
    + r"|\b(?:is\s+not|isn't|was\s+not|wasn't)\s+using\s+" + _VETO_WORD, re.IGNORECASE)
_NAME_TOKEN = r"(?-i:[A-Z][\w'’\-]+(?:\s+[A-Z][\w'’\-]+)?)"  # case-SENSITIVE inside the otherwise case-blind patterns
_TOOK_DOWN_RE = re.compile(r"\b(?:took|take|takes|taking|pulled|pull|pulls|pulling|saved|save|saves|saving)\s+(?P<who>myself|himself|herself|themselves?|" + _NAME_TOKEN + r")\s+(?:down|off)\b"
                           r"|\b(?:uses?|used|using)\s+(?:it|the\s+(?:power\s+of\s+)?veto)\s+on\s+(?P<who2>myself|himself|herself|themselves?|" + _NAME_TOKEN + r")\b", re.IGNORECASE)
# ORW-1052: a named houseguest voiced as off the block / safe / saved by the veto (the incident: "Eva is off the block" while Eva stood nominated, and "she saved Eva" while the holder saved herself)
_OFF_BLOCK_RE = re.compile(r"\b(?P<who>" + _NAME_TOKEN + r")(?:'s|\s+is|\s+was|\s+gets|\s+got|\s+comes?|\s+came)\s+(?:now\s+)?(?:off\s+the\s+block|no\s+longer\s+(?:on\s+the\s+block|nominated)|(?:taken|pulled|saved)\s+(?:down|off)(?:\s+the\s+block)?|safe\b)", re.IGNORECASE)
_SAVED_NAME_RE = re.compile(r"\b(?:saved|saves|saving)\s+(?P<who>" + _NAME_TOKEN + r")\b(?!\s+from)", re.IGNORECASE)
_REPLACEMENT_RE = re.compile(r"\b(?:names?|named|naming|put|puts|putting)\s+(?P<who>" + _NAME_TOKEN + r")\s+(?:up\s+)?as\s+the\s+replacement\b|\b(?P<who2>" + _NAME_TOKEN + r")\s+(?:is|was|becomes|became)\s+the\s+replacement\b", re.IGNORECASE)
_EVICTED_RE = re.compile(r"\b(?P<who>" + _NAME_TOKEN + r")(?:,\s*you(?:'ve|\s+have)?|\s+(?:is|was|has\s+been|have\s+been|are))\s+(?:been\s+)?evicted\b", re.IGNORECASE)
_SELF_WORDS = {"myself", "himself", "herself", "themself", "themselves"}


def _name_is(who: str, name: Any) -> bool:
    """`who` (as written in the text) is the houseguest `name`: the whole name, or a single-token shorthand of it (first name)."""
    w = (who or "").strip().lower()
    n = str(name or "").strip().lower()
    if not w or not n:
        return False
    return w == n or (len(w.split()) == 1 and w in n.split())


def _ceremony_names(cer: dict) -> "list[str]":
    out: "list[str]" = []
    veto = cer.get("veto") if isinstance(cer.get("veto"), dict) else {}
    dec = veto.get("decision") if isinstance(veto.get("decision"), dict) else {}
    for node in [cer.get("hoh"), veto.get("holder"), dec.get("saved"), dec.get("replacement")] + list(cer.get("nominees") or []):
        if isinstance(node, dict) and str(node.get("name") or "").strip():
            out.append(str(node["name"]).strip())
    return out


def _names_claim(rx: "re.Pattern[str]", sent: str, known: "list[str]") -> bool:
    """`rx` matches `sent` and the person it names is yourself-word or someone on the ceremony board (so a stray capitalised word never counts)."""
    for m in rx.finditer(sent):
        who = (m.group("who") or m.group("who2") or "").strip()
        if who.lower() in _SELF_WORDS or any(_name_is(who, k) for k in known):
            return True
    return False


def veto_decision_conflict(text: str, ceremony: Any) -> "Optional[str]":
    """The first sentence of `text` that states a veto decision / who came down / who is the replacement against the engine's `ceremony.veto.decision`. Before the decision is MADE, stating any decision
    is an invented result; after, a statement that disagrees with the engine's is wrong. None when there is no holder / no decision field (flag off, older engine) or nothing conflicts."""
    if not text or not isinstance(ceremony, dict):
        return None
    veto = ceremony.get("veto") if isinstance(ceremony.get("veto"), dict) else {}
    dec = veto.get("decision")
    if not veto.get("holder") or not isinstance(dec, dict):
        return None
    made, used = bool(dec.get("made")), bool(dec.get("used"))
    holder = (veto.get("holder") or {}).get("name")
    saved, repl = (dec.get("saved") or {}).get("name"), (dec.get("replacement") or {}).get("name")
    known = _ceremony_names(ceremony)
    nominee_names = [str(n.get("name")) for n in (ceremony.get("nominees") or []) if isinstance(n, dict) and n.get("name")]
    for sent in _sentences(text):
        if "?" in sent or _HEDGE_RE.search(sent):
            continue
        if made:
            # ORW-1052: the saved houseguest (and the holder when she saved herself) may be voiced off the block; a houseguest still nominated may not, and a saved-name must be the engine's saved one
            for m in _OFF_BLOCK_RE.finditer(sent):
                who = m.group("who").strip()
                if any(_name_is(who, n) for n in nominee_names) and not (saved and _name_is(who, saved)):
                    return sent.strip()
            for m in _SAVED_NAME_RE.finditer(sent):
                who = m.group("who").strip()
                if any(_name_is(who, k) for k in known) and (not used or not (saved and _name_is(who, saved))):
                    return sent.strip()
        if not made or not used:
            # nothing is decided / nothing was used: any use, any "took X down", any replacement naming a person of the board is a claim the engine did not make (and, unmade, a not-use claim too)
            if _USE_RE.search(sent) or (not made and _NOT_USE_RE.search(sent)) or _names_claim(_TOOK_DOWN_RE, sent, known) or _names_claim(_REPLACEMENT_RE, sent, known):
                return sent.strip()
            continue
        if _NOT_USE_RE.search(sent):
            return sent.strip()
        for m in _TOOK_DOWN_RE.finditer(sent):
            who = (m.group("who") or m.group("who2") or "").strip()
            if who.lower() in _SELF_WORDS or who.lower() == "themselves":
                if saved and holder and not _name_is(holder, saved) and str(holder).strip().lower() != str(saved).strip().lower():
                    return sent.strip()
            elif saved and any(_name_is(who, k) for k in known) and not _name_is(who, saved):
                return sent.strip()
        for m in _REPLACEMENT_RE.finditer(sent):
            who = (m.group("who") or m.group("who2") or "").strip()
            if repl and any(_name_is(who, k) for k in known) and not _name_is(who, repl):
                return sent.strip()
    return None


def evictee_conflict(text: str, eviction: Any, ceremony: Any) -> "Optional[str]":
    """Once the engine has decided the eviction (`eviction.evictee`), a sentence that says a DIFFERENT houseguest of the board was evicted contradicts it. No decided evictee => no fact (the
    ballot reveal is staged and the tally is the outcome guard's job). None when nothing conflicts."""
    if not text or not isinstance(eviction, dict) or not isinstance(eviction.get("evictee"), dict):
        return None
    evictee = str(eviction["evictee"].get("name") or "").strip()
    if not evictee or not isinstance(ceremony, dict):
        return None
    known = _ceremony_names(ceremony)
    for sent in _sentences(text):
        if "?" in sent or _HEDGE_RE.search(sent):
            continue
        for m in _EVICTED_RE.finditer(sent):
            who = m.group("who").strip()
            if not _name_is(who, evictee) and any(_name_is(who, k) for k in known):
                return sent.strip()
    return None


# ── ORW-740b: the room a competition or ceremony is called to ───────────────────────────────────────────────────────────────────────
# While a whole-house event is in session the engine seats everyone in ONE room (`whereabouts.houseEvent.room`, the same read as `whereabouts.room`: ceremonies in the living room, competitions in the
# backyard). A sentence that CALLS or GATHERS the house into a different room of this house contradicts it. Checked including quoted speech (production's call is spoken). Fail-open: no event in
# session, no room names, or an unreadable board => no conflict. A sentence that also names the engine's room (a move from one to the other) is never a conflict.
_EVENT_KINDS = ("hoh-competition", "veto-competition", "nominations", "veto-draw", "veto-ceremony", "eviction")
_CALL_RE = re.compile(r"\b(?:called|calls|calling|gather\w*|summon\w*|herd\w*|assembl\w*|everyone|everybody|whole\s+house|all\s+of\s+you|houseguests|spill\w*|files?|filed|filing|fills?|filled)\b", re.IGNORECASE)


def _room_words(name: Any) -> "list[str]":
    n = re.sub(r"^\s*the\s+", "", str(name or ""), flags=re.IGNORECASE).strip().lower()
    return [n] if len(n) >= 4 else []


def event_room_conflict(text: str, whereabouts: Any) -> Optional[str]:
    """The engine's name for the event room when a sentence of `text` calls or gathers the house into a different room of the house; None otherwise."""
    try:
        if not text or not isinstance(whereabouts, dict):
            return None
        ev = whereabouts.get("houseEvent")
        if not isinstance(ev, dict) or ev.get("kind") not in _EVENT_KINDS or not isinstance(ev.get("room"), str):
            return None
        names = whereabouts.get("roomNames") if isinstance(whereabouts.get("roomNames"), dict) else {}
        if not names or ev["room"] not in names:
            return None
        # a room is called by its themed name or its plain one ("the living room"), so both forms are the room
        here = _room_words(names[ev["room"]]) + _room_words(str(ev["room"]).replace("-", " "))
        others = [w for k, v in names.items() if k != ev["room"] for w in _room_words(v) + _room_words(str(k).replace("-", " "))]
        if not here or not others:
            return None
        for sent in _sentences(text):
            low = sent.lower()
            if not _CALL_RE.search(sent) or any(h in low for h in here):
                continue
            for o in others:
                if re.search(r"\b(?:to|into|in|inside|toward|towards)\s+(?:the\s+)?" + re.escape(o) + r"\b", low):
                    return str(names[ev["room"]])
        return None
    except Exception:  # failsoft-ok: orw740b-event-room (an unreadable check never holds narration)
        return None


# ── ORW-408 / ORW-1003: where the player is ─────────────────────────────────────────────────────────────────────────
# The narration wrote the player into a room they did not go to (the engine keeps their real room). This replaces the presence wall's drop: the sentence is now quietly rewritten like any other hard fact.
# A sentence that PLACES the player ("you drift into...", "you're in...") somewhere the engine does not have them. Modals, conditionals, questions and quoted speech place nobody.
_PLAYER_PLACED_RE = re.compile(
    r"\byou(?:'re|\u2019re|\s+are|\s+find\s+yourself)?\s+(?:\w+ly\s+)?(?:now\s+)?(?:walk|walking|step|stepping|head|heading|drift|drifting|slip|slipping|wander|wandering|stroll|strolling|settle|settling|sit|sitting|stand|standing|"
    r"arrive|arriving|follow|following|move|moving|duck|ducking|climb|climbing|drop|sink|sinking|lie|lying|stretch|stretching|perch|perched|in\b|back\b|alone\b)[^.!?]*?\b(?:in|into|onto|inside|to|on)\b",
    re.IGNORECASE)
_PLAYER_NOT_PLACED_RE = re.compile(r"\b(?:could|would|might|can|should|may|if|whether|want|wanna|do\s+you|will\s+you)\b|\?", re.IGNORECASE)


# ORW-1136: the narration WRITES the setting as a bedroom ("four of you in a bedroom", "in the bedroom") while the engine puts the player in a room that is not one. Only the plain noun, only a sentence that
# places the scene there; a bedroom named as somewhere else ("down the hall", a door, a movement out of it) places nothing.
_SETTING_BEDROOM_RE = re.compile(r"\b(?:in|inside|within)\s+(?:the|this|that|a|an|your|their|our|\w+'s)\s+(?:\w+\s+){0,2}?bedroom\b(?!\s*(?:door|doorway|hall|corridor))", re.IGNORECASE)
_SETTING_ELSEWHERE_RE = re.compile(r"\b(?:down|across|along|outside|beyond|upstairs|downstairs|next\s+door|toward|towards|past|heard|from|leaves?|left|leaving|out\s+of|back\s+to|head(?:s|ed|ing)?|go(?:es|ing)?|went|walk(?:s|ed|ing)?|used\s+to|earlier|before|was|were|had|last|yesterday|sleep\w*|slept|snor\w+|nap\w*|bunk\w*)\b", re.IGNORECASE)


def setting_room_conflict(text: str, whereabouts: Any, *, in_quote: bool = False) -> Optional[str]:
    """The engine's name for the player's room when a sentence writes the scene's setting as a bedroom and the engine room is not a bedroom; None otherwise."""
    try:
        if not text or not isinstance(whereabouts, dict) or not whereabouts.get("room"):
            return None
        room = str(whereabouts["room"])
        if room.startswith("bedroom-") or room == "hoh-room":
            return None
        names = whereabouts.get("roomNames") if isinstance(whereabouts.get("roomNames"), dict) else None
        for sent in _sentences(_outside_quotes(text, in_quote)):
            if _PLAYER_NOT_PLACED_RE.search(sent) or _SETTING_ELSEWHERE_RE.search(sent):
                continue
            if _SETTING_BEDROOM_RE.search(sent):
                return str((names or {}).get(room) or "the " + room.replace("-", " "))
        return None
    except Exception:  # failsoft-ok: orw1136-setting-room (an unreadable check never holds narration)
        return None


def player_room_conflict(text: str, whereabouts: Any, *, in_quote: bool = False) -> Optional[str]:
    """The engine's name for the player's room when the narration places them elsewhere; None otherwise (no room, no room named, or a room that can be theirs)."""
    try:
        if not text or not isinstance(whereabouts, dict) or not whereabouts.get("room"):
            return None
        from src.house_rooms import rooms_named_in
        room = str(whereabouts["room"])
        names = whereabouts.get("roomNames") if isinstance(whereabouts.get("roomNames"), dict) else None
        for sent in _sentences(_outside_quotes(text, in_quote)):
            if _PLAYER_NOT_PLACED_RE.search(sent):
                continue
            m = _PLAYER_PLACED_RE.search(sent)
            if not m:
                continue
            named = rooms_named_in(sent[m.start():], names)
            if named and not any(room in rooms for rooms in named):
                return str((names or {}).get(room) or "the " + room.replace("-", " "))
        return setting_room_conflict(text, whereabouts, in_quote=in_quote)  # ORW-1136: the setting itself written as a bedroom
    except Exception:  # failsoft-ok: orw408-player-room (an unreadable check never holds narration)
        return None


def find_conflicts(text: str, state: Any, *, zero_clocks: bool, in_quote: bool = False, owner: Any = None) -> "list[str]":
    """The hard-fact conflicts in `text` against the Vault-free `getGameState` dict. Returns fact ids, e.g. ["clock-time"]. Fail-open: any hiccup => [].
    Derived from `conflict_details` (review of #2723) so a hard fact is defined in one place."""
    return [c.fact for c in conflict_details(text, state, zero_clocks=zero_clocks, in_quote=in_quote, owner=owner)]


def correction_for(fact: str) -> str:
    """The short correction the (future) single regeneration would carry. Names the fact, not the guilty text."""
    return {
        FACT_ASLEEP: "A houseguest who has turned in for the night spoke or acted; they are asleep and do not speak or act.",
        FACT_CLOCK: "A clock time was stated; the house has no clocks, so name only the part of the day.",
        FACT_SCHEDULE: "The next event is on a later day; do not place it today or tonight.",
        FACT_PART_OF_DAY: "The narration placed the present in the wrong part of the day; use only the part of the day the game gave.",
        FACT_VETO: "The veto decision is stated wrongly or before the game made it; state only the engine's decision, or none if it is not made yet.",
        FACT_EVICTEE: "A houseguest is named as evicted who the game did not evict; name only the engine's evictee.",
        FACT_TIME_JUMP: "The narration passed the night but the game's clock has not moved; stay in the present moment.",
        FACT_BED_WORD: "A bed was named that the room does not have; name only the room's real beds.",
        FACT_SLEEPER_ROOM: "A sleeping houseguest was put in a bed in the player's room; narrate sleepers only where the game has them.",
        FACT_PLAYER_ROOM: "The narration put the player in a room they are not in; keep them where the game has them.",
        FACT_EVENT_ROOM: "The house is called to, or gathered in, a room other than the one the game staged the event in; name only the engine's room.",
    }.get(fact, "")


PREDISPLAY_COUNTS: "dict[str, int]" = {}


def record_conflicts(facts: "list[str]", user: Any = None) -> None:
    """Count each hit in a plain counter + an INFO log line. Deliberately NOT record_soft_failure: until the rewrite slice exists a count-only hit is not a health event and must not show RED on the admin page."""
    for f in facts:
        PREDISPLAY_COUNTS[f] = PREDISPLAY_COUNTS.get(f, 0) + 1
        _tc = _tally(user)["conflicts"]
        _tc[f] = _tc.get(f, 0) + 1
        logger.info("[predisplay-conflict] %s (count only, no rewrite in this slice)", f)


# ORW-408: how often the check ran, what it could not check and why, and where its state came from. Plain counters (statuses and numbers only): the admin health
# snapshot (`predisplay` key) and status page read `stats_snapshot()`. "checked" counts the guarded text chunks the check saw with a usable state (a reply is several chunks).
CHECK_STATS: "dict[str, Any]" = {
    "checked": 0,  # chunks checked against a usable state
    "skipped": {},  # reason -> chunks not checked: "no-cache" / "stale" (refresh off), "timeout" (the bounded read ran out), "other" (read failed, no game, unreadable state)
    "stateFrom": {"cache": 0, "read": 0},  # the state was already cached and fresh / needed the one bounded read
    "cacheMiss": {},  # why the cache could not serve a chunk before the read: "no-cache" (nothing stored: never read, or an engine write dropped it) / "stale" (older than 30 s)
    "turns": 0,
    "turnsWithConflict": 0,
}
_TURN: "dict[str, dict]" = {}  # owner -> this turn's tally, flushed by `end_turn` (bounded)
_READ_BACKOFF: "dict[str, float]" = {}  # owner -> monotonic time before which a timed-out read is not retried (a slow engine must not tax every chunk)
_BACKOFF_S = 10.0


def predisplay_read_timeout_s() -> float:
    """ORWELL_PREDISPLAY_READ_TIMEOUT_S (default 1.0): the longest the check waits for the one fresh getGameState read. `0` turns the refresh off (the check then only uses what is cached)."""
    try:
        return max(0.0, float(os.environ.get("ORWELL_PREDISPLAY_READ_TIMEOUT_S", "1.0")))
    except ValueError:
        return 1.0


def _okey(owner: Any) -> str:
    return "" if owner is None else str(owner)


def _tally(owner: Any) -> dict:
    k = _okey(owner)
    t = _TURN.get(k)
    if t is None:
        if len(_TURN) > 256:
            _TURN.clear()
        t = _TURN[k] = {"checked": 0, "skipped": {}, "conflicts": {}}
    return t


def _note_skip(owner: Any, reason: str) -> None:
    CHECK_STATS["skipped"][reason] = CHECK_STATS["skipped"].get(reason, 0) + 1
    t = _tally(owner)
    t["skipped"][reason] = t["skipped"].get(reason, 0) + 1


def end_turn(owner: Any) -> None:
    """One INFO line per turn: chunks checked, skipped (by reason), conflicts (by fact). Called from the turn's `finally`; a turn that never reached the check logs nothing."""
    try:
        t = _TURN.pop(_okey(owner), None)
        if t is None:
            return
        CHECK_STATS["turns"] += 1
        if t["conflicts"]:
            CHECK_STATS["turnsWithConflict"] += 1
        logger.info("[predisplay-turn] checked=%d skipped=%s conflicts=%s", t["checked"],
                    ",".join("%s:%d" % kv for kv in sorted(t["skipped"].items())) or "0",
                    ",".join("%s:%d" % kv for kv in sorted(t["conflicts"].items())) or "0")
    except Exception:  # failsoft-ok: counter only
        pass


def stats_snapshot() -> "dict[str, Any]":
    """Statuses and numbers only (no text, no names), for the admin health snapshot."""
    return {
        "enabled": predisplay_check_enabled(),
        "rewriteEnabled": predisplay_rewrite_enabled(),
        "readTimeoutS": predisplay_read_timeout_s(),
        "checked": CHECK_STATS["checked"],
        "skipped": dict(CHECK_STATS["skipped"]),
        "skippedTotal": sum(CHECK_STATS["skipped"].values()),
        "stateFrom": dict(CHECK_STATS["stateFrom"]),
        "cacheMiss": dict(CHECK_STATS["cacheMiss"]),
        "conflicts": dict(PREDISPLAY_COUNTS),
        "conflictsTotal": sum(PREDISPLAY_COUNTS.values()),
        "rewrites": dict(REWRITE_COUNTS),
        "turns": CHECK_STATS["turns"],
        "turnsWithConflict": CHECK_STATS["turnsWithConflict"],
        "claimCommit": _claim_stats(),
    }


def _claim_stats() -> "dict[str, Any]":
    try:
        from src import claim_commit
        return claim_commit.stats()
    except Exception:  # failsoft-ok: counter only
        return {}


async def _usable_state(owner: Any) -> "tuple[Any, str]":
    """(state, "") or (None, skip reason). The cached state when fresh; otherwise ONE bounded getGameState read (ORW-408: a narrator turn writes, which drops the cache, so a
    peek-only check skipped almost every reply). The read is single-flight and stored by `engine_read_cache`, so the rewrite's synchronous `peek` right after sees it too. Never
    waits longer than `predisplay_read_timeout_s()`; a timeout or failure is a counted skip and backs off 10 s so a slow engine cannot tax every chunk."""
    import asyncio
    import time
    from src import engine_read_cache
    state, why = engine_read_cache.peek_status("getGameState", owner, fields=_STATE_FIELDS)
    if state is not None:
        CHECK_STATS["stateFrom"]["cache"] += 1
        return state, ""
    CHECK_STATS["cacheMiss"][why] = CHECK_STATS["cacheMiss"].get(why, 0) + 1
    tmo = predisplay_read_timeout_s()
    if tmo <= 0:
        return None, why
    k = _okey(owner)
    if _READ_BACKOFF.get(k, 0.0) > time.monotonic():
        return None, "timeout"
    try:
        from src import orwell_engine
        full = await asyncio.wait_for(orwell_engine.get_game_state_polled(owner, timeout=tmo), tmo)
    except asyncio.TimeoutError:
        _READ_BACKOFF[k] = time.monotonic() + _BACKOFF_S
        return None, "timeout"
    except Exception:  # failsoft-ok: a failed read is a counted skip
        _READ_BACKOFF[k] = time.monotonic() + _BACKOFF_S
        return None, "other"
    _READ_BACKOFF.pop(k, None)
    if not isinstance(full, dict) or full.get("started") is False:
        return None, "other"
    CHECK_STATS["stateFrom"]["read"] += 1
    return {f: full[f] for f in _STATE_FIELDS if f in full}, ""


async def check_and_count(text: str, owner: Any, *, in_quote: bool = False) -> "list[str]":
    """Find conflicts against the engine's hard facts and count them. The state is the cached one when fresh, else one bounded read (`_usable_state`); when neither is available the
    chunk is a COUNTED skip (with its reason), never a silent one. Returns the fact ids (the caller ignores them). Off by `ORWELL_PREDISPLAY_CHECK=0`."""
    if not text or not predisplay_check_enabled():
        return []
    try:
        from src.zero_clocks import zero_clocks_on
        state, why = await _usable_state(owner)
        if state is None:
            _note_skip(owner, why or "other")
            return []
        CHECK_STATS["checked"] += 1
        _tally(owner)["checked"] += 1
        facts = find_conflicts(text, state, zero_clocks=zero_clocks_on(), in_quote=in_quote, owner=owner)
        if facts:
            record_conflicts(facts, owner)
        try:  # ORW-1156: one ledger of every claim the narration made, backed or not
            from src import claim_commit
            claim_commit.tally_chunk(text, state, owner, in_quote=in_quote, external_facts=facts)
        except Exception:  # failsoft-ok: counter only
            pass
        return facts
    except Exception:  # failsoft-ok: counter only
        try:
            _note_skip(owner, "other")
        except Exception:  # failsoft-ok: counter only
            pass
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
    """ORWELL_PREDISPLAY_REWRITE: default ON (Kevin, 2026-11-26, ORW-408). The pre-deploy review findings that held it back (quote state per chunk, a doubled or dropped tool
    call, nothing shown while the redo runs, the dropped keepalive, the unread late tool call, the swallowed cancel) are fixed in #2728 and #3335. `0/false/off/no` turns the
    rewrite off (the count-only check then still runs). Needs the check itself on too."""
    return (os.environ.get("ORWELL_PREDISPLAY_REWRITE", "1").strip().lower() not in ("0", "false", "off", "no")) and predisplay_check_enabled()


# ORW-408 (part of day): the narrator is handed the part of the day every turn and still wrote "the night wears on" at 6pm and "this afternoon" at night. Only the NARRATION places the time (quoted talk
# is a character's guess), and a sentence about the past or the future ("was", "earlier", "tomorrow") is not placing the present.
_NIGHT_NOW_RE = re.compile(r"\b(?:the\s+night\s+wears\s+on|(?:the\s+)?(?:middle|dead)\s+of\s+the\s+night|(?:the\s+)?small\s+hours|(?:it\s+is|it's|this)\s+late\s+(?:at\s+)?night|late\s+into\s+the\s+night|past\s+midnight)\b", re.IGNORECASE)
_DAY_NOW_RE = re.compile(r"\b(?:this\s+(?:morning|afternoon)|the\s+(?:morning|afternoon|midday)\s+(?:sun|light))\b", re.IGNORECASE)
_NOT_NOW_RE = re.compile(r"\b(?:tomorrow|yesterday|last\s+night|earlier|was|were|had|will|won't|until|by\s+the\s+time)\b", re.IGNORECASE)


def part_of_day_conflict(text: str, time_of_day: Any, early_morning: Any, *, in_quote: bool = False) -> Optional[str]:
    """The sentence that places the present in the wrong part of the day, or None."""
    band = str(time_of_day or "")
    if not text or band not in ("morning", "afternoon", "evening", "night", "late-night"):
        return None
    daylight = band in ("morning", "afternoon", "evening") and early_morning is not True
    rx = _NIGHT_NOW_RE if daylight else _DAY_NOW_RE if band in ("night", "late-night") else None
    if rx is None:
        return None
    for sent in _sentences(_outside_quotes(text, in_quote)):
        if rx.search(sent) and not _NOT_NOW_RE.search(sent):
            return sent.strip()
    return None


# ORW-1150 (prod 11-28 04:24Z): the narrator wrote a whole night away ("the lamp off for hours", the house up, the beds empty) while the engine clock stood at 11:41pm. The engine clock is the only clock: a
# sentence that passes the night is a conflict while the engine's part of day is still evening or night. When the engine DID move (a turn-in or sleep ran this turn) the fresh state already says morning,
# so the same words pass. Only narration counts (quoted talk is a guess); a sentence about the past or the future is not passing time now.
_JUMP_RE = re.compile(
    r"\b(?:(?:the\s+)?(?:next|following)\s+morning|morning\s+(?:comes|came|arrives|arrived|breaks|broke|finds|light|sun)|(?:the\s+)?(?:dawn|sunrise|daybreak)\b|first\s+light|"
    r"(?:sun|sunlight|daylight)\s+(?:streams?|pours?|spills?|filters?|creeps?|slants?|climbs?)|hours\s+(?:pass\w*|later|go(?:es)?\s+by|slip\w*|drift\w*|tick\w*)|"
    r"(?:through|all|the\s+rest\s+of)\s+the\s+night|overnight|slept\s+through|(?:you|he|she|they|everyone|the\s+house)\s+(?:wakes?|woke|rouses?|stirs?|stirred)\b|(?:waking|wakes?|woke)\s+up|"
    r"(?:lamp|light|lights)\b[^.!?]{0,40}\bfor\s+hours|for\s+hours\b[^.!?]{0,40}\b(?:asleep|sleeping|dark|silent|off))",
    re.IGNORECASE)
_JUMP_NOT_NOW_RE = re.compile(r"\b(?:tomorrow|yesterday|last\s+night|earlier|had|will|won't|would|could|might|should|if|until|before|by\s+the\s+time|when\s+(?:the|it)|wake[- ]?up\s+call|alarm|plan\w*|want\w*|hope\w*)\b|\?", re.IGNORECASE)


def time_jump_conflict(text: str, time_of_day: Any, early_morning: Any, *, in_quote: bool = False) -> Optional[str]:
    """The sentence that passes the night while the engine is still in the evening or at night, or None. Engine morning (or the early-morning flag) never conflicts: the clock did move."""
    band = str(time_of_day or "")
    if not text or band not in ("evening", "night", "late-night") or early_morning is True:
        return None
    for sent in _sentences(_outside_quotes(text, in_quote)):
        if _JUMP_RE.search(sent) and not _JUMP_NOT_NOW_RE.search(sent):
            return sent.strip()
    return None


# ORW-1150: bed words. The engine publishes the player's bedroom's real beds (`whereabouts.bedLayout`: singles and doubles). A word for a bed the room does not hold is a conflict.
_DOUBLE_WORD_RE = re.compile(r"\b(?:(?:the|a|an|your|that|this|his|her|their)\s+(?:big\s+|wide\s+|large\s+)?double(?:\s+bed)?|double\s+beds?|queen(?:\s+bed)?|king(?:\s+bed)?)\b(?![- ]?(?:take|check|time|dose|shot|door|agent|vision|major|life|entendre|click|tap|dutch|espresso|checked))", re.IGNORECASE)
_SINGLE_WORD_RE = re.compile(r"\b(?:single|twin)\s+beds?\b|\b(?:slim\s+)?singles\b", re.IGNORECASE)


def bed_word_conflict(text: str, whereabouts: Any) -> Optional[str]:
    """What the narration calls a bed the player's room does not have ("double" / "single"), or None. Needs the engine's bed layout for the room; without it nothing is checked."""
    try:
        lay = whereabouts.get("bedLayout") if isinstance(whereabouts, dict) else None
        if not text or not isinstance(lay, dict):
            return None
        singles, doubles = int(lay.get("singles") or 0), int(lay.get("doubles") or 0)
        if doubles == 0:
            m = _DOUBLE_WORD_RE.search(text)
            if m:
                return "double"
        if singles == 0:
            m = _SINGLE_WORD_RE.search(text)
            if m:
                return "single"
        return None
    except Exception:  # failsoft-ok: orw1150-bed-word (an unreadable check never holds narration)
        return None


# ORW-1150: sleepers. A houseguest the engine lists as asleep who is not in the player's room is narrated in a bed there. The engine's room for the sleeper is the truth; the player's room is not it.
_IN_BED_RE = re.compile(r"\b(?:in\s+(?:his|her|their|the|a)\s+(?:own\s+)?(?:beds?|bunks?)|in\s+beds?|under\s+the\s+covers|tucked\s+in|curled\s+up\s+in\s+(?:bed|(?:his|her|their)\s+bed))\b", re.IGNORECASE)


def sleeper_room_conflict(text: str, state: Any, *, in_quote: bool = False) -> Optional[str]:
    """The names (the engine's present list, for the correction) when a sentence puts an asleep houseguest who is not present in the player's room into a bed in it; None otherwise."""
    try:
        wh = state.get("whereabouts") if isinstance(state, dict) else None
        if not text or not isinstance(wh, dict) or not wh.get("room"):
            return None
        here = {str(p.get("name")) for p in (wh.get("present") or []) if isinstance(p, dict) and p.get("name")}
        sleepers = [str(a.get("name")) for a in (state.get("asleep") or []) if isinstance(a, dict) and a.get("name") and str(a.get("name")) not in here]
        if not sleepers:
            return None
        from src.house_rooms import rooms_named_in
        room = str(wh["room"])
        names = wh.get("roomNames") if isinstance(wh.get("roomNames"), dict) else None
        for sent in _sentences(_outside_quotes(text, in_quote)):
            if not _IN_BED_RE.search(sent):
                continue
            who = [n for n in sleepers if any(re.search(r"(?<!\w)" + re.escape(f) + r"(?!\w)", sent) for f in _name_forms(n))]
            if not who:
                continue
            named = rooms_named_in(sent, names)
            letter = re.search(r"\bbed\s?room[\s-]+([A-Ca-c])\b", sent)
            if letter and room.startswith("bedroom-") and room != "bedroom-" + letter.group(1).lower():
                continue  # a lettered bedroom that is not the player's
            if named and not any(room in rooms for rooms in named):
                continue  # placed in another room: the presence of the player's room is not in question
            return ", ".join(sorted(here)) if here else "nobody else"
        return None
    except Exception:  # failsoft-ok: orw1150-sleeper-room (an unreadable check never holds narration)
        return None


def conflict_details(text: str, state: Any, *, zero_clocks: bool, in_quote: bool = False, owner: Any = None) -> "list[Conflict]":
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
        if part_of_day_conflict(text, state.get("timeOfDay"), state.get("earlyMorning"), in_quote=in_quote):
            out.append(Conflict(FACT_PART_OF_DAY, str(state.get("timeOfDay") or "").replace("-", " ")))
        if time_jump_conflict(text, state.get("timeOfDay"), state.get("earlyMorning"), in_quote=in_quote):
            out.append(Conflict(FACT_TIME_JUMP, str(state.get("timeOfDay") or "").replace("-", " ")))
        bw = bed_word_conflict(text, state.get("whereabouts"))
        if bw:
            out.append(Conflict(FACT_BED_WORD, bw))
        sr = sleeper_room_conflict(text, state, in_quote=in_quote)
        if sr:
            out.append(Conflict(FACT_SLEEPER_ROOM, sr))
        sched = state.get("daySchedule")
        if schedule_conflict(text, sched, in_quote=in_quote):
            out.append(Conflict(FACT_SCHEDULE, str((sched or {}).get("next") or "").replace("-", " ")))
        if veto_decision_conflict(text, state.get("ceremony")):
            out.append(Conflict(FACT_VETO, _veto_correction_detail(state.get("ceremony"))))
        if evictee_conflict(text, state.get("eviction"), state.get("ceremony")):
            out.append(Conflict(FACT_EVICTEE, str(((state.get("eviction") or {}).get("evictee") or {}).get("name") or "")))
        room = event_room_conflict(text, state.get("whereabouts"))
        if room:
            out.append(Conflict(FACT_EVENT_ROOM, room))
        mine = player_room_conflict(text, state.get("whereabouts"), in_quote=in_quote)
        if mine:
            out.append(Conflict(FACT_PLAYER_ROOM, mine))
        if owner is not None:  # ORW-1156: a claim of a bed, an alliance or a deal with no commit behind it (needs the turn's commits, so only with an owner)
            from src import claim_commit
            for fact, detail in claim_commit.claim_conflicts(text, state, owner, in_quote=in_quote):
                out.append(Conflict(fact, detail))
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
    return engine_read_cache.peek("getGameState", owner, fields=_STATE_FIELDS), zero_clocks_on()


def split_at_wall_drop(before: str, after: str, owner: Any) -> "Optional[RewriteSplit]":
    """ORW-408: the presence wall cut a sentence (someone not in the room speaking or acting). Instead of showing the reply with a hole in it, withhold from the first cut sentence and redo it
    once with who really is here; the wall stays on the redo as the "remove the smallest wrong part" step. None when the rewrite is off or nothing was cut. Fail-open."""
    try:
        if before == after or not before or not predisplay_rewrite_enabled():
            return None
        parts = _parts(before)
        keep, i = "", 0
        while i < len(parts) and (after or "").startswith(keep + parts[i]):
            keep += parts[i]
            i += 1
        if i >= len(parts) or not parts[i].strip():
            return None
        state, _ = _fresh_state(owner)
        here = ((state or {}).get("whereabouts") or {}).get("present") if isinstance(state, dict) else None
        names = ", ".join(str(p.get("name")) for p in (here or []) if isinstance(p, dict) and p.get("name"))
        detail = names if here else ("nobody else" if here == [] else "")
        REWRITE_COUNTS[FACT_ABSENT] = REWRITE_COUNTS.get(FACT_ABSENT, 0) + 1
        logger.info("[predisplay-rewrite] withholding a sentence: %s", FACT_ABSENT)
        return RewriteSplit(keep, "".join(parts[i:]), parts[i], (Conflict(FACT_ABSENT, detail),))
    except Exception:  # failsoft-ok: orw408-wall-split (fail-open: the wall's own cut stands)
        return None


def split_at_first_conflict(text: str, owner: Any, *, in_quote: bool = False, skip: "tuple[str, ...]" = ()) -> "Optional[RewriteSplit]":
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
            hits = [c for c in conflict_details(acc + part, state, zero_clocks=zc, in_quote=in_quote, owner=owner) if c.fact not in skip]
            if hits:
                REWRITE_COUNTS[hits[0].fact] = REWRITE_COUNTS.get(hits[0].fact, 0) + 1
                try:
                    from src import claim_commit
                    claim_commit.note(hits[0].fact, "regenerated", owner)
                except Exception:  # failsoft-ok: counter only
                    pass
                logger.info("[predisplay-rewrite] withholding a sentence: %s", ",".join(h.fact for h in hits))
                return RewriteSplit(acc, "".join(parts[i:]), part, tuple(hits))
            acc += part
        return None
    except Exception:  # failsoft-ok: orw408-split (fail-open: today's behaviour, the text is emitted)
        return None


def drop_conflicting_sentences(text: str, owner: Any, *, in_quote: bool = False, skip: "tuple[str, ...]" = ()) -> "tuple[str, list[str]]":
    """Second pass over the redo: drop each WHOLE sentence that still conflicts, keep the rest verbatim. Returns (kept, the dropped sentences verbatim). Fail-open (text unchanged, nothing dropped)."""
    try:
        if not text or not predisplay_rewrite_enabled():
            return text, []
        state, zc = _fresh_state(owner)
        if state is None:
            return text, []
        kept, dropped = "", []
        for part in _parts(text):
            if any(c.fact not in skip for c in conflict_details(kept + part, state, zero_clocks=zc, in_quote=in_quote, owner=owner)):
                dropped.append(part)
                try:
                    from src import claim_commit
                    for c in conflict_details(kept + part, state, zero_clocks=zc, in_quote=in_quote, owner=owner):
                        claim_commit.note(c.fact, "dropped", owner)
                except Exception:  # failsoft-ok: counter only
                    pass
                continue
            kept += part
        if dropped:
            logger.info("[predisplay-rewrite] redo still conflicted: dropped %d whole sentence(s)", len(dropped))
        return kept, dropped
    except Exception:  # failsoft-ok: orw408-drop (fail-open: text unchanged)
        return text, []


def _veto_correction_detail(cer: Any) -> str:
    """The engine's own statement of the veto decision, carried into the correction (public ceremony names only)."""
    try:
        veto = cer.get("veto") or {}
        dec = veto.get("decision") or {}
        holder = (veto.get("holder") or {}).get("name") or "the holder"
        if not dec.get("made"):
            return "not made"
        if not dec.get("used"):
            return f"{holder} did not use it"
        saved = (dec.get("saved") or {}).get("name")
        on = "themselves" if saved and saved == (veto.get("holder") or {}).get("name") else (saved or "a nominee")
        repl = (dec.get("replacement") or {}).get("name")
        blk = [str(n.get("name")) for n in (cer.get("nominees") or []) if isinstance(n, dict) and n.get("name")]
        return (f"{holder} used it on {on}" + (" (the holder saved themself and nobody else)" if on == "themselves" else "")
                + (f" and {repl} is the replacement" if repl else "") + (f"; the two on the block are {' and '.join(blk)}" if blk else ""))
    except Exception:  # failsoft-ok: orw715-detail
        return ""


def _correction_line(c: Conflict) -> str:
    if c.fact == FACT_ASLEEP:
        return f"{c.detail} is asleep and cannot speak or act in this scene."
    if c.fact == FACT_CLOCK:
        return "Do not state clock times; use the part of day."
    if c.fact == FACT_SCHEDULE:
        return f"The {c.detail or 'next event'} is tomorrow, not today; do not place it today or tonight."
    if c.fact == FACT_VETO:
        if c.detail == "not made":
            return "The veto decision has not been made yet; nobody has decided, so no one says which way it went or who comes down."
        return f"The veto decision is made and it is: {c.detail}. State only that."
    if c.fact == FACT_EVICTEE:
        return f"{c.detail} is the houseguest the game evicted; no one else was evicted."
    if c.fact == FACT_PART_OF_DAY:
        return f"It is {c.detail or 'the part of day the game gave'} now; place nothing in another part of the day."
    if c.fact == FACT_EVENT_ROOM:
        return f"The whole house is gathered in {c.detail} for this event; do not call or place it anywhere else."
    if c.fact == FACT_TIME_JUMP:
        return f"The game's clock has not moved: it is still {c.detail or 'the same part of the day'}. Do not pass the night, wake anyone, or say hours went by; stay in this moment."
    if c.fact == FACT_BED_WORD:
        return "The beds in this room are " + ("all singles; there is no double here" if c.detail == "double" else "doubles, not singles") + ". Name only beds the room really has."
    if c.fact == FACT_SLEEPER_ROOM:
        who = "Nobody else is" if c.detail == "nobody else" else (f"Only {c.detail} are" if "," in c.detail else f"Only {c.detail} is")
        return f"{who} in the room with the player; the sleeping houseguests are not in beds here. Narrate them only where the game has them, or not at all."
    if c.fact == FACT_ABSENT:
        who = "Nobody else is" if c.detail == "nobody else" else (f"Only {c.detail} are" if "," in c.detail else f"Only {c.detail} is") if c.detail else "Only the houseguests the game lists are"
        return f"{who} in the room with the player; no one else speaks or acts here."
    if c.fact == FACT_PLAYER_ROOM:
        return f"The player is in {c.detail}; do not move or place them anywhere else."
    from src import claim_commit
    if c.fact in claim_commit.FACTS:  # ORW-1156
        return claim_commit.correction_for(c.fact, c.detail)
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


_MIN_REPEAT_CHARS = 12


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
            if len(n) >= _MIN_REPEAT_CHARS and (n in recent or n in tail_norm):  # a short line ("Okay.", "Fine.") that merely equals a shown one is legitimate
                i += 1
                continue
            break
        return "".join(parts[i:])
    except Exception:  # failsoft-ok: orw408-repeat-drop (fail-open: the redo is used as is; the guard chain still judges it)
        return redo
