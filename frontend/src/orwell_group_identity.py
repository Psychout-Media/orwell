"""ORW-566 part c (spec 0183) - the model's words for a group: a name, a ritual, a signal, an inside joke.

Part a/b gave every close pair and every NPC alliance an engine floor (a spot, a name drawn from the house's own culture). This driver writes the
live words on top of it, LAZILY: one cheap utility call per NEW group (about three to six a season), never a batch at cast time. After a turn it
asks the engine which groups still wait for words (``groupsAwaitingWords``: ids, member ids, a room, the house's authored culture and the names
other groups already carry), reads each member's PUBLIC card, and writes the result back (``recordGroupIdentity``). The ENGINE validates every
string, keeps the first record per group (write-once) and may rename a hidden alliance once.

No model or provider => the engine's floor stands and nothing is invented. A failed call retries ONCE, then is skipped with a soft-failure alert
(the group stays in the waiting list for the next turn, but a group that failed twice is not retried this process run). The prompt states RULES, never a menu or a sample (Ryne's standing rule): engine ids are validated engine-side, not listed here.
Input is member PUBLIC cards + the culture + the room; never a hidden element, a soul, a number, a bond or what was said.
Background, fire-and-forget, never raises. Tests inject ``llm_fn`` / ``write_fn``; they never call a live model.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Awaitable, Callable, Optional

from src.orwell_npc_minds_words import _json_object, public_card

logger = logging.getLogger(__name__)

LlmFn = Callable[[list], Awaitable[str]]
WriteFn = Callable[[dict], Awaitable[dict]]

_WORD_KEYS = ("name", "ritual", "signal", "insideJoke")
_IN_FLIGHT: set[str] = set()
_GAVE_UP: dict[str, set[str]] = {}  # per owner: groups whose call failed twice (not retried again this run)


def _key(user: Optional[str]) -> str:
    return user or "default"


def group_messages(group: dict, cards: list[dict]) -> list[dict]:
    """The one call for one group: rules in the system message, the members' public cards + the house's culture + the room in the user message."""
    kind_line = ("This is an alliance." if group.get("kind") == "alliance" else "This is a pair of close allies who keep a private habit.")
    system = (
        "You are a reality-TV producer giving one small group of houseguests the private words they would invent for themselves. "
        + kind_line + " Output ONLY a JSON object with the string keys name, ritual, signal and insideJoke, no prose. "
        "Rules: write every value from what these people actually share in their public profiles and from the house's own culture given below. "
        "The name is short, at most four words, and is never a generic label. Do not repeat any group name the house already carries. "
        "The ritual is one short phrase for what the group does together. The signal is one short phrase for a private cue they give each other. "
        "The inside joke is one short phrase only they would get. Plain words only: no real-world brands, no digits, no identifiers, "
        "no houseguest's name, nothing about votes, secrets or strategy, and nothing said in private. Leave a key out rather than pad it."
    )
    user = {
        "members": [public_card(c) for c in cards],
        "room": group.get("spot") or group.get("room"),
        "houseCulture": group.get("culture") or {},
        "groupNamesAlreadyTaken": group.get("otherNames") or [],
    }
    return [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(user, ensure_ascii=False)}]


def parse_words(text: str) -> Optional[dict]:
    obj = _json_object(text or "")
    if not obj:
        return None
    out = {k: obj[k].strip() for k in _WORD_KEYS if isinstance(obj.get(k), str) and obj[k].strip()}
    return out or None


async def _attempt(llm_fn: LlmFn, messages: list) -> Optional[dict]:
    try:
        return parse_words(await llm_fn(messages) or "")
    except Exception as e:  # failsoft-ok: handled-by-caller (retried once, then skipped + alerted)
        logger.warning("[group-identity] model call failed: %s", e)
        return None


async def author_group(group: dict, cards: list[dict], llm_fn: LlmFn, write_fn: WriteFn) -> dict:
    """One group: one call (retry once on a failure), then the write-back. Returns the write result or ``{accepted: False, reason}``. Never raises."""
    gid = group.get("groupId")
    if not isinstance(gid, str) or not gid:
        return {"accepted": False, "reason": "no-id"}
    msgs = group_messages(group, cards)
    got = await _attempt(llm_fn, msgs) or await _attempt(llm_fn, msgs)
    if not got:
        return {"accepted": False, "reason": "skipped"}
    try:
        return await write_fn({"groupId": gid, **got}) or {"accepted": False, "reason": "write-failed"}
    except Exception as e:  # failsoft-ok: handled-by-caller (run_group_words alerts)
        logger.warning("[group-identity] write-back failed: %s", e)
        return {"accepted": False, "reason": "write-failed"}


def _alert(owner: Optional[str], key: str, what) -> None:
    """A skipped group raises an admin alert (RED on /admin/status); the engine floor stands. Never raises."""
    try:
        from src import log_rings
        log_rings.record_soft_failure(key, str(what), corrected="engine-floor-stands", user=owner)
    except Exception:  # pragma: no cover - failsoft-ok: recorder-self
        pass


async def run_group_words(owner: Optional[str], llm_fn: Optional[LlmFn] = None, read_fn=None, state_fn=None, write_fn: Optional[WriteFn] = None) -> dict:
    """Read the waiting groups, author each, write back. The injected callables are the test seam; live they resolve to the utility model and the engine wrappers.
    Nothing waiting => returns before resolving any model. No model => the floor stands, one alert. Never raises."""
    try:
        from src import orwell_engine
        read_fn = read_fn or (lambda: orwell_engine.groups_awaiting_words(user=owner))
        waiting = [g for g in (await read_fn() or []) if isinstance(g, dict) and g.get("groupId")]
        gave_up = _GAVE_UP.setdefault(_key(owner), set())
        waiting = [g for g in waiting if g["groupId"] not in gave_up]
        if not waiting:
            return {"groups": 0}
        if llm_fn is None:
            from src.orwell_cast_authoring import _resolve_llm_fn
            llm_fn = await _resolve_llm_fn(owner)
        if llm_fn is None:
            _alert(owner, "group-identity:no-model", "no utility model resolved")
            return {"groups": 0, "reason": "no-model"}
        state_fn = state_fn or (lambda: orwell_engine.get_game_state(user=owner))
        state = await state_fn()
        house = {hg.get("id"): hg for hg in (state or {}).get("house") or [] if isinstance(hg, dict) and hg.get("id")}
        write_fn = write_fn or (lambda req: orwell_engine.record_group_identity(req, user=owner))
        results = {}
        for g in waiting:
            cards = [house[m] for m in (g.get("members") or []) if m in house]
            res = await author_group(g, cards, llm_fn, write_fn)
            results[g["groupId"]] = res
            if not (isinstance(res, dict) and res.get("accepted")) and res.get("reason") not in ("frozen",):
                gave_up.add(g["groupId"])
                _alert(owner, "group-identity:group-skipped", res.get("reason", "unknown"))
        return {"groups": len(waiting), "results": results}
    except Exception as e:  # noqa: BLE001 - failsoft-ok: handled-by-terminal (_alert -> log_rings.record_soft_failure, RED)
        _alert(owner, "group-identity:run-failed", e)
        return {"groups": 0, "reason": "run-failed"}


def kickoff_group_identity(owner: Optional[str]) -> None:
    """Fire-and-forget after a player turn. Off when the engine has the group-identity flag off; idempotent per owner (one run in flight);
    cheap when nothing waits (one engine read). Never blocks the turn; never raises."""
    try:
        from src import orwell_engine
        if not orwell_engine.engine_flag("groupIdentity", default=True):
            return
    except Exception:  # failsoft-ok: flag-probe (an unknown flag carries on; the engine refuses every write when it is off)
        pass
    k = _key(owner)
    if k in _IN_FLIGHT:
        return
    _IN_FLIGHT.add(k)

    async def _runner():
        try:
            await run_group_words(owner)
        except Exception as e:  # pragma: no cover - failsoft-ok: handled-by-terminal
            _alert(owner, "group-identity:background-run-failed", e)
        finally:
            _IN_FLIGHT.discard(k)

    try:
        asyncio.get_running_loop().create_task(_runner())
    except RuntimeError:
        try:
            __import__("src.llm_core", fromlist=["run_isolated"]).run_isolated(_runner())
        except Exception:
            _IN_FLIGHT.discard(k)
