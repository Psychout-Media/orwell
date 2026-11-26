"""ORW-271 (slice 2) - condense closed in-game days out of the narrator's PROMPT, never out of storage.

Two halves over the engine's append-only day ledger (``dayLedger`` / ``recordDaySummary``):

1. PROMPT VIEW (``apply_prompt_view``): before the context trimmer, every history row stamped with an in-game day
   older than the current day - 1 (plus the earlier rows of the previous day, keeping its last ``KEEP_TAIL_ROWS``
   raw) is replaced, IN THE SENT MESSAGE LIST ONLY, by ONE ``[Story so far]`` system message built from the ledger
   (week entries first, then un-merged day entries; authored ``text`` preferred, the engine floor otherwise).
   Stored history is never rewritten (ORW-224 / mandate #4). Summaries are immutable, so the prefix is append-only.
   Rows with no ``game_day`` (casting, pre-game, un-stamped) are left alone. Any error => the input list unchanged.

2. AUTHOR TASK (``kickoff_after_turn_in``): after a successful ``turnIn`` a background, idempotent, fail-soft task
   asks the utility LLM for a short summary of the closed day built ONLY from the player-visible user/assistant
   text of that day (no tool results, no reasoning), and writes it back. When 7+ un-merged day entries sit older
   than the last 7 and the ledger holds 14+ days, the oldest 7 are condensed into one week entry. No provider =>
   a no-op; the engine floor stands. Never blocks sleep.

Vault-free by construction: the only inputs are the engine's own ledger (public projection) and the player-visible
chat text.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

KEEP_TAIL_ROWS = 6          # raw rows of the previous day kept verbatim
DAY_WORDS = 120             # ORW-402: the FLOOR of the per-day word budget; it grows with the day, up to DAY_WORDS_MAX
DAY_WORDS_MAX = 400
KEY_LIST_WORDS = 80
_CHARS_PER_BUDGET_WORD = 40  # a day of ~4,800 chars or less gets 120 words; ~16,000+ chars gets the 400 cap
_CHUNK_CHARS = 6000
_MAX_DAY_CHARS = 120000
WEEK_WORDS = 150
WEEK_SPAN = 7
KEEP_RECENT_DAYS = 7        # day entries newer than this window are never week-merged
WEEK_TRIGGER_TOTAL = 14
_MAX_ROW_CHARS = 2500
_MAX_INPUT_CHARS = 14000
STORY_HEADER = "[Story so far]"
YESTERDAY_HEADER = "Engine record of yesterday"

HEAL_DAYS_PER_RUN = 3       # ORW-387: earlier closed days with no (or an error-shaped) summary re-authored per run
_HEAL_TRIES_MAX = 3         # per (user, day) per process, so a provider that keeps failing is not asked every turn

HEAL_DAYS_PER_RUN = 3       # ORW-387: earlier closed days with no (or an error-shaped) summary re-authored per run
_HEAL_TRIES_MAX = 3         # per (user, day) per process, so a provider that keeps failing is not asked every turn

_IN_FLIGHT: set = set()
_HEAL_TRIES: dict = {}

LlmFn = Callable[[list], Awaitable[str]]


def enabled() -> bool:
    """ORWELL_DAY_CONDENSE, ON by default; ``=0|false|no|off`` or the diagnostic ``ORWELL_FLAGS_OFF=1`` turns it off."""
    if str(os.environ.get("ORWELL_FLAGS_OFF", "")).strip().lower() in ("1", "true", "yes", "on"):
        return False
    return str(os.environ.get("ORWELL_DAY_CONDENSE", "")).strip().lower() not in ("0", "false", "no", "off")


# ── prompt view ──────────────────────────────────────────────────────────────────

def _row_day(m) -> Optional[int]:
    md = m.get("metadata") if isinstance(m, dict) else None
    d = md.get("game_day") if isinstance(md, dict) else None
    return d if isinstance(d, int) and not isinstance(d, bool) and d > 0 else None


def _assign_days(messages: list) -> list:
    """Per-row in-game day: an assistant row's own stamp; a user row (saved before framing) takes the day of the next
    stamped assistant row. Non user/assistant rows and unresolvable rows get None (left alone)."""
    days: list = [None] * len(messages)
    nxt: Optional[int] = None
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        role = m.get("role") if isinstance(m, dict) else None
        if role == "assistant":
            own = _row_day(m)
            days[i] = own
            nxt = own  # an unstamped assistant row breaks the chain for the user rows before it
        elif role == "user":
            days[i] = _row_day(m) or nxt
    return days


_ERROR_TEXT = re.compile(r'^\s*(event:|data:)|"status"\s*:\s*[45]\d\d|\breturned HTTP [45]\d\d\b', re.I)


def looks_like_error(text) -> bool:
    """ORW-387: transport or provider error text (an SSE frame, an HTTP 4xx/5xx body) that must never be stored or
    shown as a summary."""
    return isinstance(text, str) and bool(_ERROR_TEXT.search(text))


def _authored_text(e: dict) -> str:
    text = e.get("text") if isinstance(e, dict) else None
    return text.strip() if isinstance(text, str) and text.strip() and not looks_like_error(text) else ""


def days_needing_summary(ledger: list) -> list:
    """Closed days whose summary is missing or error-shaped, oldest first."""
    return sorted(e["day"] for e in (ledger or []) if isinstance(e, dict) and e.get("tier", "day") == "day"
                  and isinstance(e.get("day"), int) and not e.get("merged") and not _authored_text(e))


def _record_text(e: dict) -> str:
    """The engine's deterministic record of a day, in full (every event, every theme)."""
    events = [str(x) for x in (e.get("events") or []) if str(x).strip()]
    themes = [str(x) for x in (e.get("themes") or []) if str(x).strip()]
    parts = ([f"themes: {', '.join(themes)}"] if themes else []) + ([f"events: {'; '.join(events)}"] if events else [])
    return " | ".join(parts)


def _entry_text(e: dict) -> str:
    text = _authored_text(e)
    if text:
        return text
    events = [str(x) for x in (e.get("events") or []) if str(x).strip()][:6]
    themes = [str(x) for x in (e.get("themes") or []) if str(x).strip()]
    head = f" ({', '.join(themes)})" if themes else ""
    return (head.strip() + " " + "; ".join(events)).strip() if (head or events) else "a quiet day."


def build_story_so_far(ledger: list, up_to_day: int) -> str:
    """The ``[Story so far]`` block: week-tier entries first, then un-merged day entries (day <= up_to_day)."""
    weeks = [e for e in ledger if isinstance(e, dict) and e.get("tier") == "week"]
    days = [e for e in ledger if isinstance(e, dict) and e.get("tier", "day") == "day"
            and not e.get("merged") and isinstance(e.get("day"), int) and e["day"] <= up_to_day]
    lines = [STORY_HEADER]
    for e in sorted(weeks, key=lambda x: (x.get("coversDays") or [x.get("day", 0)])[0]):
        cd = e.get("coversDays") or [e.get("day"), e.get("day")]
        lines.append(f"- Days {cd[0]}-{cd[1]}: {_entry_text(e)}")
    for e in sorted(days, key=lambda x: x["day"]):
        lines.append(f"- Day {e['day']}: {_entry_text(e)}")
    # ORW-402 layer 1: yesterday's deterministic engine record in full, as a TRAILING block so the day lines above
    # stay an append-only prefix (the record only ever changes at the tail as days close).
    yest = next((e for e in days if e["day"] == up_to_day), None)
    rec = _record_text(yest) if yest else ""
    if rec:
        lines.append(f"{YESTERDAY_HEADER} (Day {up_to_day}): {rec}")
    return "\n".join(lines)


def apply_prompt_view(messages: list, ledger: list) -> list:
    """Return the message list to SEND: closed-day rows replaced by one ``[Story so far]`` system message. Pure; never
    mutates ``messages`` or the stored rows; ANY problem => the original list."""
    try:
        if not enabled() or not isinstance(messages, list) or not ledger:
            return messages
        day_entries = {e["day"] for e in ledger if isinstance(e, dict) and e.get("tier", "day") == "day"
                       and isinstance(e.get("day"), int)}
        if not day_entries:
            return messages
        days = _assign_days(messages)
        stamped = [d for d in days if d is not None]
        current = max([max(day_entries) + 1] + stamped)
        prev = current - 1
        prev_idx = [i for i, d in enumerate(days) if d == prev]
        keep_prev = set(prev_idx[-KEEP_TAIL_ROWS:])
        drop: set = set()
        for i, d in enumerate(days):
            if d is None or d not in day_entries:
                continue  # unstamped, or the engine has no entry for that day yet: stay raw
            if d < prev or (d == prev and i not in keep_prev):
                drop.add(i)
        if not drop:
            return messages
        first = min(drop)
        summary = {"role": "system", "content": build_story_so_far(ledger, prev)}
        out: list = []
        for i, m in enumerate(messages):
            if i == first:
                out.append(summary)
            if i in drop:
                continue
            out.append(m)
        return out
    except Exception as e:  # fail-soft: send as today
        logger.warning("[day-condense] prompt view failed, sending raw history: %s", e)
        return messages


# ── author task ──────────────────────────────────────────────────────────────────

def _day_rows(history: list, day: int) -> list:
    msgs = [{"role": getattr(m, "role", None) if not isinstance(m, dict) else m.get("role"),
             "content": getattr(m, "content", None) if not isinstance(m, dict) else m.get("content"),
             "metadata": getattr(m, "metadata", None) if not isinstance(m, dict) else m.get("metadata")}
            for m in (history or [])]
    days = _assign_days(msgs)
    parts: list = []
    for m, d in zip(msgs, days):
        if d != day or m["role"] not in ("user", "assistant") or not isinstance(m["content"], str):
            continue
        txt = " ".join(m["content"].split())[:_MAX_ROW_CHARS]
        if txt:
            parts.append(("Player: " if m["role"] == "user" else "Narration: ") + txt)
    return parts


def visible_day_text(history: list, day: int) -> str:
    """The PLAYER-VISIBLE text of one in-game day: user + assistant ``content`` only. Tool results, tool events and
    reasoning (metadata) never enter. ORW-402: the WHOLE day (only a very large safety ceiling applies)."""
    return "\n".join(_day_rows(history, day))[-_MAX_DAY_CHARS:]


def day_word_budget(chars: int) -> int:
    """ORW-402: the summary budget scales with the day's visible length: DAY_WORDS floor, DAY_WORDS_MAX cap."""
    return max(DAY_WORDS, min(DAY_WORDS_MAX, int(chars) // _CHARS_PER_BUDGET_WORD))


def _chunks(text: str) -> list:
    """Split the day's text on row boundaries into pieces of about _CHUNK_CHARS (an over-long row is cut)."""
    out: list = []
    cur = ""
    for line in text.split("\n"):
        while len(line) > _CHUNK_CHARS:
            line, rest = line[:_CHUNK_CHARS], line[_CHUNK_CHARS:]
            out.append(line)
            line = rest
        if cur and len(cur) + len(line) + 1 > _CHUNK_CHARS:
            out.append(cur)
            cur = line
        else:
            cur = f"{cur}\n{line}" if cur else line
    if cur:
        out.append(cur)
    return out


_KEY_LIST_RULE = ("After the prose, add one line starting 'Key list:' with the open promises, nicknames and running "
                  "jokes, each quoted as closely to the text as you can, separated by semicolons. "
                  "A promise goes in the prose only with the promiser's own words in double quotes, copied from the text; "
                  "never say anyone promised, swore or assured something the text does not show them saying.")  # ORW-918


def _day_messages(day: int, text: str, words: int = DAY_WORDS) -> list:
    system = ("You condense one in-game day of a reality-TV house story into a memory note for the narrator. "
              f"At most {words} words, plain prose: the themes, the key events, and any open threads. "
              f"{_KEY_LIST_RULE} Use only what the text says; invent nothing.")
    return [{"role": "system", "content": system}, {"role": "user", "content": f"Day {day}:\n{text}\n\nSummary:"}]


def _chunk_messages(day: int, n: int, total: int, text: str, words: int) -> list:
    system = (f"You condense part {n} of {total} of one in-game day of a reality-TV house story into notes for the "
              f"narrator. At most {words} words, plain prose: events, who said or promised what, open threads. "
              f"{_KEY_LIST_RULE} Use only what the text says; invent nothing.")
    return [{"role": "system", "content": system}, {"role": "user", "content": f"Day {day}, part {n}/{total}:\n{text}\n\nNotes:"}]


def _merge_messages(day: int, notes: list, words: int) -> list:
    system = ("Merge these part-notes of one in-game day of a reality-TV house story into ONE memory note for the "
              f"narrator, in time order. At most {words} words of plain prose covering the WHOLE day. "
              f"{_KEY_LIST_RULE} Keep every open promise, nickname and running joke from the parts. Invent nothing.")
    body = "\n\n".join(f"Part {i + 1}: {t}" for i, t in enumerate(notes))
    return [{"role": "system", "content": system}, {"role": "user", "content": f"Day {day}:\n{body}\n\nSummary:"}]


def _week_messages(frm: int, to: int, parts: list) -> list:
    system = (f"Condense these daily notes of a reality-TV house story into ONE note of at most {WEEK_WORDS} words: "
              "themes, key events, open threads. Use only what the notes say.")
    body = "\n".join(f"Day {d}: {t}" for d, t in parts)
    return [{"role": "system", "content": system}, {"role": "user", "content": f"Days {frm}-{to}:\n{body}\n\nSummary:"}]


def _clip_words(text: str, n: int) -> str:
    return " ".join((text or "").split()[:n]).strip()


def _clip_with_key_list(text: str, words: int) -> str:
    """Clip the prose to ``words`` and the 'Key list:' line separately, so the verbatim list is never clipped away."""
    head, sep, keys = (text or "").partition("Key list:")
    out = _clip_words(head, words)
    keys = _clip_words(keys, KEY_LIST_WORDS) if sep else ""
    return f"{out} Key list: {keys}".strip() if keys else out


# ORW-918: a sentence that has someone promise / swear / vow / assure / pledge / give their word.
_PROMISE_RE = re.compile(r"\b(promis\w*|swor[en]|swear\w*|vow\w*|assur\w*|pledg\w*|guarantee\w*|gave (?:his|her|their|my|your) word|giving (?:his|her|their) word)\b", re.I)
_QUOTE_RE = re.compile(r"[\"\u201c\u201d]([^\"\u201c\u201d]{6,})[\"\u201c\u201d]")
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+|(?<=[.!?][\"\u201d])\s+|\s+(?=- )")


def _fold_quote(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(t).replace("\u2019", "'").replace("'", "").lower()).strip()


_STOP = frozenset("that this with what they them their there from have were will would your about into than then when which just also over very".split())


def _stems(t: str) -> set:
    """The content words of a sentence (4+ letters, not a stop word, the promise words themselves left out), cut to 5 letters so 'promised'/'promise' meet."""
    return {w[:5] for w in _fold_quote(t).split() if len(w) >= 4 and w not in _STOP and not _PROMISE_RE.fullmatch(w)}


def drop_unquoted_promises(summary: str, day_text: str) -> str:
    """ORW-918: the PROSE of a day summary (before 'Key list:') loses every sentence that has someone promise something unless the day shows that promise: it quotes,
    in double quotes, words that are in the day's own text, or a sentence of the day that reports a promise carries most of its content words. The closed day's rows are replaced by this summary in the narrator's prompt, so an invented promise would be cited as the player's
    word. Deterministic; the Key list (already quotes by rule) is left as it is. Never raises: any problem returns the summary unchanged."""
    try:
        head, sep, keys = (summary or "").partition("Key list:")
        src = _fold_quote(day_text)
        # the day's own sentences that report a promise (a narrated "A promised B an alliance" is the day showing it, quoted or not)
        told = [_stems(x) for x in re.split(r"(?<=[.!?])\s+|\n", day_text or "") if _PROMISE_RE.search(x)]
        kept, dropped = [], 0
        for sent in _SENTENCE_RE.split(head):
            if _PROMISE_RE.search(sent):
                quotes = [_fold_quote(q) for q in _QUOTE_RE.findall(sent)]
                mine = _stems(sent)
                shown = bool(mine) and any(len(mine & t) >= 0.6 * len(mine) for t in told)
                if not shown and not any(q and q in src for q in quotes):
                    dropped += 1
                    continue
            kept.append(sent)
        if dropped:
            logger.info("[day-condense] %s promise line(s) with no quote from the day's text dropped", dropped)
        prose = " ".join(x.strip() for x in kept if x.strip())
        return f"{prose} {sep}{keys}".strip() if sep else prose
    except Exception:  # failsoft-ok: the summary as written stands
        return summary


async def _summarise_day(day: int, text: str, llm_fn) -> str:
    """ORW-402 layer 2: one call for a short day; otherwise summarise each chunk, then merge. Returns "" on an error-shaped
    reply (the caller records it)."""
    words = day_word_budget(len(text))
    pieces = _chunks(text)
    if len(pieces) <= 1:
        return await llm_fn(_day_messages(day, text, words)) or ""
    per = max(60, words // 2)
    notes: list = []
    for i, piece in enumerate(pieces, 1):
        r = await llm_fn(_chunk_messages(day, i, len(pieces), piece, per)) or ""
        if looks_like_error(r):
            return r
        if not r.strip():
            # A chunk that came back empty (a provider error mid-run) must not leave a hole: the engine keeps the first
            # authored text for good, so write nothing and let the day be retried.
            logger.warning("[day-condense] day %s: chunk %s of %s came back empty; nothing written", day, i, len(pieces))
            return ""
        notes.append(" ".join(r.split()))
    return await llm_fn(_merge_messages(day, notes, words)) or ""


async def _author_day(entry: dict, llm_fn, history: list, write_fn) -> dict:
    day = entry["day"]
    if _authored_text(entry):
        return {"accepted": False, "reason": "already"}
    text = visible_day_text(history, day)
    if not text.strip():
        return {"accepted": False, "reason": "no-text"}
    raw = await _summarise_day(day, text, llm_fn)
    if looks_like_error(raw):
        logger.warning("[day-condense] day %s: the model call returned an error, not a summary; nothing written", day)
        try:
            from src import log_rings
            log_rings.record_soft_failure("day-condense:error-text", raw[:200], corrected="the engine floor stands")
        except Exception:  # failsoft-ok: recorder-self
            pass
        return {"accepted": False, "reason": "error-text"}
    raw = drop_unquoted_promises(raw, text)  # ORW-918: a promise the day never shows is never handed to the narrator as fact
    out = _clip_with_key_list(raw, day_word_budget(len(text)))
    if not out:
        return {"accepted": False, "reason": "empty"}
    return await write_fn(day, out)


async def condense_day(owner, closed_day: int, *, llm_fn: Optional[LlmFn], history: list,
                       ledger_fn: Callable[[], Awaitable[list]],
                       write_fn: Callable[..., Awaitable[dict]], heal_days: Optional[list] = None) -> dict:
    """Author the closed day's summary (idempotent: a day that already has text is skipped), then the week tier when due.
    Injected deps => testable with no model/engine. Never raises. `heal_days` (review of #2751): when given, only those earlier days may be healed this run (the batch `kickoff_heal` charged a try to);
    None keeps the old rule (any earlier day that needs a summary, up to HEAL_DAYS_PER_RUN)."""
    try:
        if llm_fn is None:
            return {"accepted": False, "reason": "no-model"}
        ledger = await ledger_fn()
        entry = next((e for e in ledger if e.get("tier", "day") == "day" and e.get("day") == closed_day), None)
        if entry is None:
            return {"accepted": False, "reason": "no-entry"}
        result = await _author_day(entry, llm_fn, history, write_fn)
        # ORW-387: heal earlier closed days left without a real summary (a failed call, or an error stored as text).
        healed = 0
        for d in days_needing_summary(ledger):
            if d == closed_day or healed >= HEAL_DAYS_PER_RUN or (heal_days is not None and d not in heal_days):
                continue
            healed += 1
            await _author_day(next(e for e in ledger if e.get("tier", "day") == "day" and e.get("day") == d),
                              llm_fn, history, write_fn)
        await _maybe_week(llm_fn, ledger_fn, write_fn)
        return result
    except Exception as e:
        logger.warning("[day-condense] day condense failed: %s", e)
        try:
            from src import log_rings
            log_rings.record_soft_failure("day-condense:condense-failed", e, corrected="raw history stays in the prompt", user=owner)
        except Exception:  # failsoft-ok: recorder-self
            pass
        return {"accepted": False, "reason": "error"}


async def _maybe_week(llm_fn, ledger_fn, write_fn) -> None:
    ledger = await ledger_fn()
    days = sorted((e for e in ledger if e.get("tier", "day") == "day" and isinstance(e.get("day"), int)),
                  key=lambda e: e["day"])
    if len(days) < WEEK_TRIGGER_TOTAL:
        return
    older = [e for e in days[:-KEEP_RECENT_DAYS] if not e.get("merged")]
    if len(older) < WEEK_SPAN:
        return
    chunk = older[:WEEK_SPAN]
    frm, to = chunk[0]["day"], chunk[-1]["day"]
    if any(e.get("tier") == "week" and e.get("coversDays") == [frm, to] for e in ledger):
        return
    parts = [(e["day"], _entry_text(e)) for e in chunk]
    raw = await llm_fn(_week_messages(frm, to, parts)) or ""
    out = "" if looks_like_error(raw) else _clip_words(raw, WEEK_WORDS)
    if out:
        await write_fn(to, out, tier="week", covers_days=[frm, to])


def _key(owner) -> str:
    return owner or "default"


_ANY_GAME = object()


def _game_sid(owner):
    """The game identity a background author task is tied to: the user's bound canonical game session id (None when
    unbound). A season reset / new game clears the binding, so a different value later means a different game."""
    try:
        from src import orwell_game_session
        return orwell_game_session.get_game_session(owner)
    except Exception:
        return None


async def run_condense(owner, closed_day: Optional[int], sid=_ANY_GAME, heal_days: Optional[list] = None) -> dict:
    """Resolve the live deps and condense. A missing model / session is a quiet no-op (the engine floor stands).

    ``sid`` (review of #2685): the game the background task was started for. When given, the task is a no-op as soon as the
    user's game session is no longer that one, and it re-checks right before every write, so a summary authored from the
    old transcript can never land in a new season that reuses the same day number."""
    if not enabled() or not closed_day:
        return {"accepted": False, "reason": "off"}
    if sid is not _ANY_GAME and _game_sid(owner) != sid:
        return {"accepted": False, "reason": "game-changed"}
    try:
        from src.orwell_cast_authoring import _resolve_llm_fn, resolve_prose_llm_fn
        from src import orwell_engine, orwell_game_session
        from src.ai_interaction import get_session_manager
    except Exception:
        return {"accepted": False, "reason": "no-deps"}
    llm_fn = await resolve_prose_llm_fn(_resolve_llm_fn, owner)  # ORW-387: the summaries are plain prose
    history: list = []
    try:
        hist_sid = orwell_game_session.get_game_session(owner)
        mgr = get_session_manager()
        if hist_sid and mgr:
            history = list(mgr.get_session(hist_sid).history)
    except Exception:
        history = []

    async def _ledger() -> list:
        if sid is not _ANY_GAME and _game_sid(owner) != sid:
            return []
        return await orwell_engine.day_ledger(user=owner)

    async def _write(day, text, tier="day", covers_days=None) -> dict:
        if sid is not _ANY_GAME and _game_sid(owner) != sid:
            return {"accepted": False, "reason": "game-changed"}
        return await orwell_engine.record_day_summary(day, text, tier=tier, covers_days=covers_days, user=owner)

    return await condense_day(owner, int(closed_day), llm_fn=llm_fn, history=history, ledger_fn=_ledger, write_fn=_write, heal_days=heal_days)


def closed_day_from_turn_in(result) -> Optional[int]:
    """The day a successful turnIn just closed (its inline ``dailyRecap.day``); None for a no-op turnIn."""
    try:
        import json
        view = json.loads(result["output"]) if isinstance(result, dict) and isinstance(result.get("output"), str) else None
        d = ((view or {}).get("dailyRecap") or {}).get("day")
        return d if isinstance(d, int) and not isinstance(d, bool) and d > 0 else None
    except Exception:
        return None


def kickoff_after_turn_in(owner, result) -> None:
    """Fire-and-forget the author task after a successful turnIn result. Idempotent per (user, day) while in flight;
    never blocks, never raises."""
    try:
        if not enabled():
            return
        day = closed_day_from_turn_in(result)
        if not day:
            return
        try:  # ORW-554: the day just closed, so the next one is being played (token ledger costs per played day)
            from src import orwell_token_ledger
            orwell_token_ledger.note_game_day(owner, day + 1)
        except Exception:  # failsoft-ok: telemetry only
            pass
        sid = _game_sid(owner)
        k = f"{_key(owner)}:{sid}:{day}"  # keyed by game too: a new season reusing the day number is a different task
        if k in _IN_FLIGHT:
            return
        _IN_FLIGHT.add(k)

        async def _runner():
            try:
                await run_condense(owner, day, sid)
            except Exception as e:  # pragma: no cover - defensive
                logger.warning("[day-condense] background task failed: %s", e)
                try:
                    from src import log_rings
                    log_rings.record_soft_failure("day-condense:background-failed", e, corrected="raw history stays in the prompt", user=owner)
                except Exception:  # failsoft-ok: recorder-self
                    pass
            finally:
                _IN_FLIGHT.discard(k)

        try:
            asyncio.get_running_loop().create_task(_runner())
        except RuntimeError:
            _IN_FLIGHT.discard(k)  # no loop (sync caller): skip rather than block sleep
    except Exception:  # failsoft-ok: expected-empty (fire-and-forget kickoff; the author task records its own failures, and a missed kickoff just leaves the raw history in the prompt)
        pass


def kickoff_heal(owner, ledger: list) -> None:
    """ORW-387: if a closed day has no real summary, re-author it in the background from the stored history (bounded
    tries per process). Called from the prompt view; never blocks a turn, never raises."""
    try:
        if not enabled():
            return
        need = days_needing_summary(ledger)
        if not need:
            return
        sid = _game_sid(owner)

        def _kk(d):
            return f"{_key(owner)}:{sid}:{d}"  # keyed by game too: the retry counter of the old season never mutes the new one
        # review of #2668: the OLDEST day that still has tries left (a newest day that exhausted its tries must not starve the older ones),
        # and every day one run will attempt (this one plus up to HEAL_DAYS_PER_RUN - 1 later ones, see `condense_day`) is charged a try.
        open_days = [d for d in need if _HEAL_TRIES.get(_kk(d), 0) < _HEAL_TRIES_MAX]
        if not open_days:
            return
        day = open_days[0]
        k = _kk(day)
        if k in _IN_FLIGHT:
            return
        batch = open_days[:HEAL_DAYS_PER_RUN]  # review of #2751: ONE batch is charged AND handed to the worker, so the days charged are exactly the days attempted
        for d in batch:
            _HEAL_TRIES[_kk(d)] = _HEAL_TRIES.get(_kk(d), 0) + 1
        _IN_FLIGHT.add(k)

        async def _runner():
            try:
                await run_condense(owner, day, sid, heal_days=batch[1:])
            except Exception as e:  # pragma: no cover - defensive
                logger.warning("[day-condense] heal task failed: %s", e)
                try:
                    from src import log_rings
                    log_rings.record_soft_failure("day-condense:heal-task-failed", e, corrected="raw history stays in the prompt", user=owner)
                except Exception:  # failsoft-ok: recorder-self
                    pass
            finally:
                _IN_FLIGHT.discard(k)

        try:
            asyncio.get_running_loop().create_task(_runner())
        except RuntimeError:
            _IN_FLIGHT.discard(k)
    except Exception as e:  # fail-soft: healing must never hurt a turn
        logger.debug("[day-condense] heal kickoff skipped: %s", e)
        try:
            from src import log_rings
            log_rings.record_soft_failure("day-condense:heal-kickoff-failed", e, corrected="raw history stays in the prompt", user=owner)
        except Exception:  # failsoft-ok: recorder-self
            pass
