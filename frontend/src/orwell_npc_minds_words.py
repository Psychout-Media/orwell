"""ORW-319 (ORW-253 slice 5, spec docs/features/0146-npc-minds-model-words.md, lanes 1 and 2) - the model's words at cast time.

Lane 1 (per houseguest): read that houseguest's PUBLIC profile and propose their everyday habits (2-3 from a closed set) and a season-aim
hint (a closed set) with a short why. Lane 2 (once per season): read the cast's PUBLIC facets and propose the house culture (nicknamed
spots, rituals, a running joke). The ENGINE validates every value against the same closed sets and keeps the first record
(``recordNpcTraits`` / ``recordHouseCulture``); its own habits and leanings stand for anything skipped.

Ryne's rule (2026-11-12, answer 2): if a model call fails, retry ONCE; if it fails again, skip that item and raise an admin alert (RED on
/admin/status via ``log_rings.record_soft_failure``). The engine's own version stands, so play never waits on this and nothing is invented
to cover a failure. Each lane-1 call sees ONE houseguest's public profile only (ADR 0019 per-call scope); lane 2 sees only public facets.
Never a hidden element, a soul, a number or another houseguest's private anything. Background, fire-and-forget, never raises.
Tests inject ``llm_fn`` / ``write_fn``; they never call a live model.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

LlmFn = Callable[[list], Awaitable[str]]
WriteFn = Callable[[dict], Awaitable[dict]]

# Mirrors of the engine's closed sets (the engine re-validates; these only shape the prompt and drop obvious junk early).
HABITS = ("early-riser", "night-owl", "gym-rat", "house-cook", "neat-freak", "napper", "devout", "camera-talker",
          "storyteller", "card-shark", "sun-seeker")
AIMS = ("win-by-comps", "win-by-being-liked", "run-the-house", "reach-jury", "last-alliance-standing", "prove-not-a-floater")
ROOMS = ("kitchen", "living-room", "dining-room", "backyard", "hallway", "bedroom-a", "bedroom-b", "bedroom-c", "bathroom",
         "lounge", "hoh-room", "storage-room")
TIMES = ("morning", "afternoon", "evening", "night", "late-night")
RITUAL_ACTIONS = ("cook", "work-out", "do-chores", "nap", "prank", "comfort", "homesick-talk", "bed-talk", "game-of-cards",
                  "sunbathe", "tell-stories")
# The ONLY card keys any call may see: public facets (the roster card the whole house can read).
PUBLIC_KEYS = ("name", "age", "vocation", "hometown", "demeanor", "identityConcept", "biography", "presentation", "archetype",
               "strategyStyle")

_IN_FLIGHT: set[str] = set()


def _key(user: Optional[str]) -> str:
    return user or "default"


def public_card(hg: dict) -> dict:
    """Only the public facets of one houseguest card (never an id, a soul, a hidden element or a number other than age)."""
    return {k: hg[k] for k in PUBLIC_KEYS if isinstance(hg, dict) and hg.get(k) not in (None, "")}


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


# ── lane 1: habits and a season-aim hint, one houseguest per call ───────────────────────────────────────────────────────

def traits_messages(card: dict) -> list[dict]:
    system = (
        "You are a reality-TV casting producer reading ONE houseguest's public profile. Decide how they live in the house day to day "
        "and what they most want from the season. Output ONLY a JSON object, no prose: "
        '{"habits":[2 or 3 of: ' + ", ".join(HABITS) + '],"aimHint":"one of: ' + ", ".join(AIMS) + '","aimWhy":"<= 12 words, from the profile"}. '
        "Ground every choice in the profile; no names of other people; no numbers."
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": "Profile: " + json.dumps(public_card(card), ensure_ascii=False)}]


def parse_traits(text: str) -> Optional[dict]:
    obj = _json_object(text or "")
    if not obj:
        return None
    habits = [h for h in dict.fromkeys(obj.get("habits") or []) if h in HABITS][:3]
    if len(habits) < 2:
        return None
    out: dict = {"habits": habits}
    if obj.get("aimHint") in AIMS:
        out["aimHint"] = obj["aimHint"]
        if isinstance(obj.get("aimWhy"), str) and obj["aimWhy"].strip():
            out["aimWhy"] = obj["aimWhy"].strip()[:80]
    return out


async def _attempt(llm_fn: LlmFn, messages: list, parse) -> Optional[dict]:
    try:
        return parse(await llm_fn(messages) or "")
    except Exception as e:  # failsoft-ok: handled-by-caller (retried once, then skipped + alerted)
        logger.warning("[npc-minds-words] model call failed: %s", e)
        return None


async def author_traits(cards: list[dict], llm_fn: LlmFn, write_fn: WriteFn) -> dict:
    """Lane 1: one call per houseguest (retry once on a failure), then ONE write-back of every success.
    Returns ``{accepted, rejected, skipped: [ids]}``. Never raises."""
    traits, skipped = [], []
    for card in cards:
        hid = card.get("id")
        if not hid:
            continue
        msgs = traits_messages(card)
        got = await _attempt(llm_fn, msgs, parse_traits) or await _attempt(llm_fn, msgs, parse_traits)
        if got:
            traits.append({"id": hid, **got})
        else:
            skipped.append(hid)
    result = {"accepted": 0, "rejected": 0}
    if traits:
        try:
            result = await write_fn({"traits": traits}) or result
        except Exception as e:  # failsoft-ok: handled-by-caller (run_words alerts)
            logger.warning("[npc-minds-words] traits write-back failed: %s", e)
            result = {"accepted": 0, "rejected": len(traits), "writeFailed": True}
    return {**result, "skipped": skipped}


# ── lane 2: house culture, once per season ───────────────────────────────────────────────────────────────────────────────

def culture_messages(cards: list[dict]) -> list[dict]:
    system = (
        "You are a reality-TV producer imagining THIS season's house culture from the cast's public profiles: the little things a "
        "house invents. Output ONLY a JSON object, no prose: "
        '{"spots":[up to 3 x {"room": one of ' + "/".join(ROOMS) + ', "nickname": "<= 4 words"}],'
        '"rituals":[up to 3 x {"timeOfDay": one of ' + "/".join(TIMES) + ', "action": one of ' + "/".join(RITUAL_ACTIONS) + ', "name": "<= 4 words"}],'
        '"runningJoke":"<= 12 words"}. No names of houseguests, no numbers, nothing about the game or anyone\'s strategy.'
    )
    return [{"role": "system", "content": system},
            {"role": "user", "content": "Cast: " + json.dumps([public_card(c) for c in cards], ensure_ascii=False)}]


def parse_culture(text: str) -> Optional[dict]:
    obj = _json_object(text or "")
    if not obj:
        return None
    spots = [s for s in (obj.get("spots") or []) if isinstance(s, dict) and s.get("room") in ROOMS and s.get("nickname")][:3]
    rituals = [r for r in (obj.get("rituals") or []) if isinstance(r, dict) and r.get("timeOfDay") in TIMES
               and r.get("action") in RITUAL_ACTIONS and r.get("name")][:3]
    joke = obj.get("runningJoke") if isinstance(obj.get("runningJoke"), str) and obj["runningJoke"].strip() else None
    if not spots and not rituals and not joke:
        return None
    return {"spots": spots, "rituals": rituals, **({"runningJoke": joke.strip()} if joke else {})}


async def author_culture(cards: list[dict], llm_fn: LlmFn, write_fn: WriteFn) -> dict:
    """Lane 2: one call (retry once), then the write-back. Returns the write result or ``{accepted: False, reason}``. Never raises."""
    msgs = culture_messages(cards)
    got = await _attempt(llm_fn, msgs, parse_culture) or await _attempt(llm_fn, msgs, parse_culture)
    if not got:
        return {"accepted": False, "reason": "skipped"}
    try:
        return await write_fn(got) or {"accepted": False, "reason": "write-failed"}
    except Exception as e:  # failsoft-ok: handled-by-caller (run_words alerts)
        logger.warning("[npc-minds-words] culture write-back failed: %s", e)
        return {"accepted": False, "reason": "write-failed"}


# ── live wiring ────────────────────────────────────────────────────────────────────────────────────────────────────────────

def _alert(owner: Optional[str], key: str, what) -> None:
    """Ryne's rule: a skipped item raises an admin alert (RED on /admin/status). Never raises."""
    try:
        from src import log_rings
        log_rings.record_soft_failure(key, str(what), corrected="engine-version-stands", user=owner)
    except Exception:  # pragma: no cover - failsoft-ok: recorder-self
        pass


async def run_words(owner: Optional[str]) -> dict:
    """Resolve the utility model and the PUBLIC cast cards, run lanes 1 and 2, alert on anything skipped. No model ⇒ alert once and
    return (the engine's own habits and leanings stand). Never raises."""
    try:
        from src.orwell_cast_authoring import _resolve_llm_fn
        llm_fn = await _resolve_llm_fn(owner)
    except Exception as e:  # noqa: BLE001 - failsoft-ok: handled-by-terminal (_alert -> log_rings.record_soft_failure, RED)
        _alert(owner, "npc-minds:resolver-failed", e)
        return {"traits": None, "culture": None, "reason": "resolver-failed"}
    if llm_fn is None:
        _alert(owner, "npc-minds:no-model", "no utility model resolved")
        return {"traits": None, "culture": None, "reason": "no-model"}
    from src import orwell_engine
    try:
        state = await orwell_engine.get_game_state(user=owner)
    except Exception as e:  # noqa: BLE001 - failsoft-ok: handled-by-terminal (_alert -> log_rings.record_soft_failure, RED)
        _alert(owner, "npc-minds:state-failed", e)
        return {"traits": None, "culture": None, "reason": "state-failed"}
    house = [hg for hg in (state or {}).get("house") or [] if isinstance(hg, dict) and hg.get("id") and not hg.get("isPlayer")]

    async def _write_traits(req: dict) -> dict:
        return await orwell_engine.record_npc_traits(req, user=owner)

    async def _write_culture(req: dict) -> dict:
        return await orwell_engine.record_house_culture(req, user=owner)

    traits = await author_traits(house, llm_fn, _write_traits)
    if traits.get("skipped") or traits.get("writeFailed"):
        _alert(owner, "npc-minds:traits-skipped", f"{len(traits.get('skipped') or [])} houseguest(s) skipped")
    culture = await author_culture(house, llm_fn, _write_culture)
    if not (isinstance(culture, dict) and culture.get("accepted")) and (culture or {}).get("reason") != "frozen":
        _alert(owner, "npc-minds:culture-skipped", (culture or {}).get("reason", "unknown"))
    return {"traits": traits, "culture": culture}


def kickoff_npc_minds_words(owner: Optional[str]) -> None:
    """Fire-and-forget lanes 1 and 2 once per season start. Never blocks game start; never raises."""
    k = _key(owner)
    if k in _IN_FLIGHT:
        return
    _IN_FLIGHT.add(k)

    async def _runner():
        try:
            await run_words(owner)
        except Exception as e:  # pragma: no cover - failsoft-ok: handled-by-terminal (_alert -> log_rings.record_soft_failure, RED)
            _alert(owner, "npc-minds:background-run-failed", e)
        finally:
            _IN_FLIGHT.discard(k)

    try:
        asyncio.get_running_loop().create_task(_runner())
    except RuntimeError:
        try:
            __import__("src.llm_core", fromlist=["run_isolated"]).run_isolated(_runner())
        except Exception:
            _IN_FLIGHT.discard(k)
