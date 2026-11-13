"""ORW-320 (ORW-253 slice 7, spec docs/features/0146-npc-minds-model-words.md, "the house you never saw", amendment 2026-11-13) - the nightly
reflections, written AFTER the crown.

Once the winner is crowned the engine's post-season retrospective carries ``houseYouNeverSaw``: per houseguest, their real story (aim and why, goals,
the real reason beside what they said, a long con). This module reads THAT (the sanctioned unsealing, never a live game) and has the UTILITY model
write, per houseguest and per night their story moved, one first-person reflection ``{"reflection": "<= 60 words"}``. Each call sees ONE houseguest's
own unsealed history up to that night and nothing else (ADR 0019 per-call scope; no other houseguest's story, no engine state). The engine validates
and keeps the first record per houseguest-night (``recordNpcReflections``, refused until the season is finished).

Ryne's rule (2026-11-12, answer 2): a failed call is retried ONCE; a second failure skips that night and raises an admin alert (RED on /admin/status
via ``log_rings.record_soft_failure``). No model resolved => alert once, and the engine version stands: nothing is invented to cover a gap. Background,
fire-and-forget, idempotent, never raises. Tests inject ``llm_fn`` / ``write_fn``; they never call a live model.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

LlmFn = Callable[[list], Awaitable[str]]
WriteFn = Callable[[dict], Awaitable[dict]]

MAX_WORDS = 60
_CONCURRENCY = 4
# Spend guard (ORW-320 review): every reflection night is written (a long-lasting houseguest's late nights are the dramatic ones), so there is no
# per-houseguest count cap. The season's expected calls are LOGGED up front; only a runaway total (far above the few hundred a season normally
# costs) stops further calls, newest nights first, with a RED alert so it is never silent.
_SPEND_GUARD_CALLS = 1500
_EST_COST_PER_CALL_USD = 0.0003
_IN_FLIGHT: set[str] = set()
_ATTEMPTED: set[str] = set()
_FIRST_PERSON = re.compile(r"\b(I|I'm|I've|I'd|I'll|my|me|mine|myself)\b")
_DAY = re.compile(r"day (\d+)")


def _key(user: Optional[str]) -> str:
    return user or "default"


def _json_object(text: str) -> Optional[dict]:
    """The first balanced JSON object in a reply (models wrap JSON in prose or a fence)."""
    if not isinstance(text, str):
        return None
    start = text.find("{")
    while start != -1:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(text[start:i + 1])
                        return obj if isinstance(obj, dict) else None
                    except (ValueError, TypeError):
                        break
        start = text.find("{", start + 1)
    return None


def _day_of(text: str) -> Optional[int]:
    m = _DAY.search(text or "")
    return int(m.group(1)) if m else None


def story_through(story: dict, night: int) -> dict:
    """ONE houseguest's own unsealed story as it stood on `night`: goals formed by then (an ending after that night reads as still open), decisions
    made by then, the long con only once it began. Never another houseguest's story, never later knowledge, never the written reflections."""
    goals = []
    for g in story.get("goals") or []:
        formed = _day_of(g.get("from", ""))
        if formed is not None and formed > night:
            continue
        ended = g.get("ended", "")
        end_day = _day_of(ended)
        goals.append({**{k: g[k] for k in ("aim", "why", "from") if k in g}, "ended": "still open" if end_day is not None and end_day > night else ended})
    decisions = [{k: d[k] for k in ("act", "real", "said", "honesty", "aired") if k in d}
                 for d in story.get("decisions") or [] if isinstance(d.get("day"), int) and d["day"] <= night]
    out: dict = {"goals": goals, "decisions": decisions}
    if story.get("seasonAim"):
        out["seasonAim"] = story["seasonAim"]
    con = story.get("longCon")
    if con and (_day_of(con.get("from", "")) or 0) <= night:
        end_day = _day_of(con.get("ended", ""))
        out["longCon"] = {**con, "ended": "still running" if end_day is not None and end_day > night else con.get("ended", "")}
    return out


def reflection_messages(story: dict, night: int) -> list[dict]:
    system = (
        "You are writing one private end-of-day thought for a reality-TV houseguest, in their own voice, using ONLY the notes below about "
        "their own game so far. Write it in the first person. Output ONLY a JSON object, no prose: "
        f'{{"reflection":"<= {MAX_WORDS} words, first person"}}. '
        "Stay inside the notes: invent no events, no people and no numbers; do not know anything after this night."
    )
    user = f"It is the end of day {night}. Their notes: " + json.dumps(story_through(story, night), ensure_ascii=False)
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def parse_reflection(text: str) -> Optional[str]:
    obj = _json_object(text or "")
    r = obj.get("reflection") if obj else None
    if not isinstance(r, str):
        return None
    r = re.sub(r"\s+", " ", r).strip()
    if not r or len(r.split()) > MAX_WORDS or not _FIRST_PERSON.search(r):
        return None
    return r


async def _attempt(llm_fn: LlmFn, messages: list) -> Optional[str]:
    try:
        return parse_reflection(await llm_fn(messages) or "")
    except Exception as e:  # failsoft-ok: handled-by-caller (retried once, then skipped + alerted)
        logger.warning("[house-reflections] model call failed: %s", e)
        return None


async def write_reflections(stories: list[dict], llm_fn: LlmFn, write_fn: WriteFn) -> dict:
    """One call per houseguest-night not yet written (retry once), then ONE write-back per houseguest of every success.
    Returns ``{accepted, rejected, skipped: n, writeFailed: bool}``. Never raises."""
    sem = asyncio.Semaphore(_CONCURRENCY)
    totals = {"accepted": 0, "rejected": 0, "skipped": 0, "writeFailed": False, "guarded": 0}
    planned = sum(len([n for n in s.get("reflectionNights") or [] if isinstance(n, int)]) for s in stories)
    logger.info("[house-reflections] expecting about %d reflection call(s) this season (~$%.2f at %.4f per call; guard %d)",
                planned, planned * _EST_COST_PER_CALL_USD, _EST_COST_PER_CALL_USD, _SPEND_GUARD_CALLS)
    calls = {"n": 0}

    async def one(story: dict) -> None:
        hid = (story.get("houseguest") or {}).get("id")
        if not hid:
            return
        have = {r.get("night") for r in story.get("reflections") or []}
        todo = [n for n in story.get("reflectionNights") or [] if isinstance(n, int) and n not in have]
        got = []
        for night in sorted(todo, reverse=True):  # newest first: if the guard ever trips, the late dramatic nights are the ones kept
            if calls["n"] >= _SPEND_GUARD_CALLS:
                totals["guarded"] += 1
                continue
            calls["n"] += 1
            msgs = reflection_messages(story, night)
            async with sem:
                text = await _attempt(llm_fn, msgs) or await _attempt(llm_fn, msgs)
            if text:
                got.append({"id": hid, "night": night, "reflection": text})
            else:
                totals["skipped"] += 1
        if not got:
            return
        try:
            res = await write_fn({"reflections": got}) or {}
            totals["accepted"] += int(res.get("accepted") or 0)
            totals["rejected"] += int(res.get("rejected") or 0)
        except Exception as e:  # failsoft-ok: handled-by-caller (run_reflections alerts)
            logger.warning("[house-reflections] write-back failed: %s", e)
            totals["writeFailed"] = True

    await asyncio.gather(*(one(s) for s in stories))
    return totals


def _alert(owner: Optional[str], key: str, what) -> None:
    """Ryne's rule: a skipped item raises an admin alert (RED on /admin/status). Never raises."""
    try:
        from src import log_rings
        log_rings.record_soft_failure(key, str(what), corrected="engine-version-stands", user=owner)
    except Exception:  # pragma: no cover - failsoft-ok: recorder-self
        pass


def pending(stories: list[dict]) -> bool:
    return any(set(s.get("reflectionNights") or []) - {r.get("night") for r in s.get("reflections") or []} for s in stories)


async def run_reflections(owner: Optional[str], stories: list[dict]) -> dict:
    """Resolve the utility model and write the missing reflections; alert on anything skipped. No model => alert once and return (nothing invented)."""
    try:
        from src.orwell_cast_authoring import _resolve_llm_fn
        llm_fn = await _resolve_llm_fn(owner)
    except Exception as e:  # noqa: BLE001 - failsoft-ok: handled-by-terminal (_alert -> log_rings.record_soft_failure, RED)
        _alert(owner, "house-reflections:resolver-failed", e)
        return {"reason": "resolver-failed"}
    if llm_fn is None:
        _alert(owner, "house-reflections:no-model", "no utility model resolved")
        return {"reason": "no-model"}
    from src import orwell_engine

    async def _write(req: dict) -> dict:
        return await orwell_engine.record_npc_reflections(req, user=owner)

    res = await write_reflections(stories, llm_fn, _write)
    if res.get("guarded"):
        _alert(owner, "house-reflections:spend-guard", f"spend guard stopped {res['guarded']} reflection call(s) after {_SPEND_GUARD_CALLS}")
    if res.get("skipped") or res.get("writeFailed"):
        _alert(owner, "house-reflections:skipped", f"{res.get('skipped', 0)} reflection(s) skipped" + (" (write-back failed)" if res.get("writeFailed") else ""))
    return res


def kickoff_house_reflections(owner: Optional[str], retrospective: Optional[dict]) -> None:
    """Fire-and-forget, once per finished season per process, when the retrospective is opened and reflections are missing. Never blocks the route; never raises."""
    try:
        stories = [s for s in (retrospective or {}).get("houseYouNeverSaw") or [] if isinstance(s, dict)]
        if not stories or not pending(stories):
            return
        k = _key(owner)
        season = f"{k}|{((retrospective or {}).get('winner') or {}).get('id')}|{len(stories)}"
        if k in _IN_FLIGHT or season in _ATTEMPTED:
            return
        _ATTEMPTED.add(season)
        _IN_FLIGHT.add(k)

        async def _runner():
            try:
                await run_reflections(owner, stories)
            except Exception as e:  # pragma: no cover - failsoft-ok: handled-by-terminal (_alert -> log_rings.record_soft_failure, RED)
                _alert(owner, "house-reflections:background-run-failed", e)
            finally:
                _IN_FLIGHT.discard(k)

        try:
            asyncio.get_running_loop().create_task(_runner())
        except RuntimeError:
            _IN_FLIGHT.discard(k)
    except Exception as e:  # pragma: no cover - failsoft-ok: never breaks the retrospective route
        logger.warning("[house-reflections] kickoff skipped: %s", e)
