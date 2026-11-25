"""ORW-807 (0200 "your edit") - the narrator's own episode titles, written AFTER the crown.

Once the winner is crowned the engine's post-season retrospective carries ``yourEdit``: the season cut as episodes, each with its facts (the week's
HOH, who left, whether the count was close, the top moments as kind/actor/subject, the alliances that formed or ended) and a composed FLOOR title.
This module reads THAT (the sanctioned post-crown door, never a live game) and has the UTILITY model write one short title per episode from those
facts only, then writes them back (``recordEpisodeTitles``: the engine keeps the first title per week, refuses anything before the crown). The window
then shows the authored title in place of the floor.

Background, fire-and-forget, idempotent (episodes that already carry an ``authoredTitle`` are never asked again), never raises. No model resolved, or a
reply that does not parse => the floor titles stand (nothing invented to cover a gap). Tests inject ``llm_fn`` / ``write_fn``; they never call a live model.
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

MAX_TITLE_WORDS = 10
MAX_TITLE_CHARS = 90
_IN_FLIGHT: set[str] = set()
_ATTEMPTED: set[str] = set()
_RAW_ID = re.compile(r"\b(?:npc|player):\S", re.I)


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


def untitled(episodes: list[dict]) -> list[dict]:
    """The episodes still on their floor title (no authored one yet)."""
    return [e for e in episodes if isinstance(e, dict) and isinstance(e.get("week"), int) and not e.get("authoredTitle")]


def _facts(ep: dict) -> dict:
    """The facts of one episode the model may title from (exactly what the edit shows; nothing else)."""
    out: dict = {"week": ep["week"]}
    for k in ("hoh", "evictee", "crown"):
        if isinstance(ep.get(k), str) and ep[k]:
            out[k] = ep[k]
    if ep.get("close"):
        out["close"] = True
    moments = [{k: m[k] for k in ("kind", "actor", "subject") if isinstance(m, dict) and isinstance(m.get(k), str)} for m in ep.get("moments") or []]
    if moments:
        out["moments"] = moments
    alliances = [{"name": a.get("name"), "what": a.get("what")} for a in ep.get("alliances") or [] if isinstance(a, dict) and a.get("name")]
    if alliances:
        out["alliances"] = alliances
    out["floorTitle"] = ep.get("title", "")
    return out


def title_messages(episodes: list[dict]) -> list[dict]:
    system = (
        "You title the episodes of a finished season of a reality competition show, like a showrunner naming episodes in the edit. "
        f"For each episode give ONE short, evocative title (at most {MAX_TITLE_WORDS} words) grounded ONLY in that episode's facts: never invent an event, "
        "a name or an outcome the facts do not hold. No numbers for votes, no quotation marks, no emoji. "
        'Reply with JSON only: {"titles": [{"week": <week>, "title": "<title>"}, ...]}, one entry per episode given.'
    )
    user = "Episodes (facts only):\n" + json.dumps([_facts(e) for e in episodes], ensure_ascii=False)
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def parse_titles(text: str, weeks: set[int]) -> list[dict]:
    """The usable ``{week, title}`` pairs from a reply: known weeks only, one per week, short, no raw ids. Anything else is dropped."""
    obj = _json_object(text or "")
    rows = obj.get("titles") if obj else None
    out: list[dict] = []
    seen: set[int] = set()
    for r in rows if isinstance(rows, list) else []:
        if not isinstance(r, dict):
            continue
        week, title = r.get("week"), r.get("title")
        if not isinstance(week, int) or isinstance(week, bool) or week not in weeks or week in seen or not isinstance(title, str):
            continue
        title = re.sub(r"\s+", " ", title).strip().strip('"“”').strip()
        if not title or len(title) > MAX_TITLE_CHARS or len(title.split()) > MAX_TITLE_WORDS or _RAW_ID.search(title):
            continue
        seen.add(week)
        out.append({"week": week, "title": title})
    return out


async def write_titles(episodes: list[dict], llm_fn: LlmFn, write_fn: WriteFn) -> dict:
    """One model call for every untitled episode (retried once), then ONE write-back. Returns ``{recorded, titled, reason?}``. Never raises."""
    todo = untitled(episodes)
    if not todo:
        return {"recorded": 0, "titled": 0, "reason": "nothing-to-title"}
    weeks = {e["week"] for e in todo}
    msgs = title_messages(todo)
    titles: list[dict] = []
    for _ in range(2):
        try:
            titles = parse_titles(await llm_fn(msgs) or "", weeks)
        except Exception as e:  # failsoft-ok: handled-by-caller (retried once, then the floor stands)
            logger.warning("[episode-titles] model call failed: %s", e)
            titles = []
        if titles:
            break
    if not titles:
        return {"recorded": 0, "titled": 0, "reason": "no-usable-reply"}
    try:
        res = await write_fn({"titles": titles}) or {}
    except Exception as e:  # failsoft-ok: handled-by-caller (run_titles alerts)
        logger.warning("[episode-titles] write-back failed: %s", e)
        return {"recorded": 0, "titled": len(titles), "reason": "write-failed"}
    return {"recorded": int(res.get("recorded") or 0), "titled": len(titles)}


def _alert(owner: Optional[str], key: str, what) -> None:
    """A skipped run is visible on /admin/status (never silent). Never raises."""
    try:
        from src import log_rings
        log_rings.record_soft_failure(key, str(what), corrected="floor-titles-stand", user=owner)
    except Exception:  # pragma: no cover - failsoft-ok: recorder-self
        pass


async def run_titles(owner: Optional[str], episodes: list[dict]) -> dict:
    """Resolve the utility model and write the missing titles. No model => alert once and return (the floor titles stand)."""
    try:
        from src.orwell_cast_authoring import _resolve_llm_fn
        llm_fn = await _resolve_llm_fn(owner)
    except Exception as e:  # noqa: BLE001 - failsoft-ok: handled-by-terminal (_alert -> log_rings.record_soft_failure)
        _alert(owner, "episode-titles:resolver-failed", e)
        return {"reason": "resolver-failed"}
    if llm_fn is None:
        _alert(owner, "episode-titles:no-model", "no utility model resolved")
        return {"reason": "no-model"}
    from src import orwell_engine

    async def _write(req: dict) -> dict:
        return await orwell_engine.record_episode_titles(req.get("titles") or [], user=owner)

    res = await write_titles(episodes, llm_fn, _write)
    if res.get("reason") in ("no-usable-reply", "write-failed"):
        _alert(owner, "episode-titles:skipped", res["reason"])
    return res


def kickoff_episode_titles(owner: Optional[str], retrospective: Optional[dict]) -> None:
    """Fire-and-forget, once per finished season per process, when the retrospective is opened and an episode is still on its floor title. Never raises."""
    try:
        episodes = [e for e in (((retrospective or {}).get("yourEdit") or {}).get("episodes") or []) if isinstance(e, dict)]
        if not untitled(episodes):
            return
        k = _key(owner)
        season = f"{k}|{((retrospective or {}).get('winner') or {}).get('id')}|{len(episodes)}"
        if k in _IN_FLIGHT or season in _ATTEMPTED:
            return
        _ATTEMPTED.add(season)
        _IN_FLIGHT.add(k)

        async def _runner():
            try:
                await run_titles(owner, episodes)
            except Exception as e:  # pragma: no cover - failsoft-ok: handled-by-terminal (_alert -> log_rings.record_soft_failure)
                _alert(owner, "episode-titles:background-run-failed", e)
            finally:
                _IN_FLIGHT.discard(k)

        try:
            asyncio.get_running_loop().create_task(_runner())
        except RuntimeError:
            _IN_FLIGHT.discard(k)
    except Exception as e:  # pragma: no cover - failsoft-ok: never breaks the retrospective route
        logger.warning("[episode-titles] kickoff skipped: %s", e)
