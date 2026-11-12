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
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

KEEP_TAIL_ROWS = 6          # raw rows of the previous day kept verbatim
DAY_WORDS = 120
WEEK_WORDS = 150
WEEK_SPAN = 7
KEEP_RECENT_DAYS = 7        # day entries newer than this window are never week-merged
WEEK_TRIGGER_TOTAL = 14
_MAX_ROW_CHARS = 1200
_MAX_INPUT_CHARS = 14000
STORY_HEADER = "[Story so far]"

_IN_FLIGHT: set = set()

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


def _entry_text(e: dict) -> str:
    text = e.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()
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

def visible_day_text(history: list, day: int) -> str:
    """The PLAYER-VISIBLE text of one in-game day: user + assistant ``content`` only. Tool results, tool events and
    reasoning (metadata) never enter."""
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
    return "\n".join(parts)[-_MAX_INPUT_CHARS:]


def _day_messages(day: int, text: str) -> list:
    system = ("You condense one in-game day of a reality-TV house story into a short memory note for the narrator. "
              f"At most {DAY_WORDS} words, plain prose: the themes, the key events, and any open threads. "
              "Use only what the text says; invent nothing.")
    return [{"role": "system", "content": system}, {"role": "user", "content": f"Day {day}:\n{text}\n\nSummary:"}]


def _week_messages(frm: int, to: int, parts: list) -> list:
    system = (f"Condense these daily notes of a reality-TV house story into ONE note of at most {WEEK_WORDS} words: "
              "themes, key events, open threads. Use only what the notes say.")
    body = "\n".join(f"Day {d}: {t}" for d, t in parts)
    return [{"role": "system", "content": system}, {"role": "user", "content": f"Days {frm}-{to}:\n{body}\n\nSummary:"}]


def _clip_words(text: str, n: int) -> str:
    return " ".join((text or "").split()[:n]).strip()


async def condense_day(owner, closed_day: int, *, llm_fn: Optional[LlmFn], history: list,
                       ledger_fn: Callable[[], Awaitable[list]],
                       write_fn: Callable[..., Awaitable[dict]]) -> dict:
    """Author the closed day's summary (idempotent: a day that already has text is skipped), then the week tier when due.
    Injected deps => testable with no model/engine. Never raises."""
    try:
        if llm_fn is None:
            return {"accepted": False, "reason": "no-model"}
        ledger = await ledger_fn()
        entry = next((e for e in ledger if e.get("tier", "day") == "day" and e.get("day") == closed_day), None)
        if entry is None:
            return {"accepted": False, "reason": "no-entry"}
        result: dict = {"accepted": False, "reason": "already"}
        if not (entry.get("text") or "").strip():
            text = visible_day_text(history, closed_day)
            if not text.strip():
                result = {"accepted": False, "reason": "no-text"}
            else:
                out = _clip_words(await llm_fn(_day_messages(closed_day, text)) or "", DAY_WORDS)
                if not out:
                    result = {"accepted": False, "reason": "empty"}
                else:
                    result = await write_fn(closed_day, out)
        await _maybe_week(llm_fn, ledger_fn, write_fn)
        return result
    except Exception as e:
        logger.warning("[day-condense] day condense failed: %s", e)
        try:
            from src import log_rings
            log_rings.record_soft_failure("day-condense:condense-failed", e, corrected="raw history stays in the prompt")
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
    out = _clip_words(await llm_fn(_week_messages(frm, to, parts)) or "", WEEK_WORDS)
    if out:
        await write_fn(to, out, tier="week", covers_days=[frm, to])


def _key(owner) -> str:
    return owner or "default"


async def run_condense(owner, closed_day: Optional[int]) -> dict:
    """Resolve the live deps and condense. A missing model / session is a quiet no-op (the engine floor stands)."""
    if not enabled() or not closed_day:
        return {"accepted": False, "reason": "off"}
    try:
        from src.orwell_cast_authoring import _resolve_llm_fn
        from src import orwell_engine, orwell_game_session
        from src.ai_interaction import get_session_manager
    except Exception:
        return {"accepted": False, "reason": "no-deps"}
    llm_fn = await _resolve_llm_fn(owner)
    history: list = []
    try:
        sid = orwell_game_session.get_game_session(owner)
        mgr = get_session_manager()
        if sid and mgr:
            history = list(mgr.get_session(sid).history)
    except Exception:
        history = []

    async def _ledger() -> list:
        return await orwell_engine.day_ledger(user=owner)

    async def _write(day, text, tier="day", covers_days=None) -> dict:
        return await orwell_engine.record_day_summary(day, text, tier=tier, covers_days=covers_days, user=owner)

    return await condense_day(owner, int(closed_day), llm_fn=llm_fn, history=history, ledger_fn=_ledger, write_fn=_write)


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
        k = f"{_key(owner)}:{day}"
        if k in _IN_FLIGHT:
            return
        _IN_FLIGHT.add(k)

        async def _runner():
            try:
                await run_condense(owner, day)
            except Exception as e:  # pragma: no cover - defensive
                logger.warning("[day-condense] background task failed: %s", e)
                try:
                    from src import log_rings
                    log_rings.record_soft_failure("day-condense:background-failed", e, corrected="raw history stays in the prompt")
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
