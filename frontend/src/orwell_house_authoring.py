"""ORW-509 - the writer authors the season's HOUSE at season setup (no menu).

One bounded call, run beside cast genesis (the same setup moment, the same model resolution), authors a house for THIS season: a name, a pitch and a name plus a
look for each of the 14 rooms, from the season's own facts (the seeded brief) and three random anchor words. No theme list and no example house is in the prompt.
The engine reads the draft with ``acceptHouseThemeDraft`` (shape, length, unique, not-plain, fresh against the library and the last seasons); a refusal returns the
rule counts, the writer gets ONE retry with them, and after that the plain room labels stand (never a blocked season). Fail-soft: no model, no usable output, or a
refusal leaves the engine floor untouched. Roles and places only: no houseguest name is handed in.
"""
from __future__ import annotations

import hashlib
import json
import logging
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

ROOM_IDS = (
    "kitchen", "living-room", "dining-room", "backyard", "hallway", "bedroom-a", "bedroom-b", "bedroom-c",
    "bathroom", "lounge", "hoh-room", "storage-room", "diary-room", "landing",
)
# Random starting points (objects and places). Not a menu: the writer is told to let ONE of them colour the house and to invent the rest.
ANCHORS = (
    "harbor tuba ledger lantern ferry orchard kettle compass ladder thimble trellis anvil bobbin canoe chimney cobbler cricket dinghy easel feather funnel garland hammock "
    "harvest jigsaw kayak kiln locket marble meadow mitten mosaic nutmeg paddle pebble pennant quilt radish raft ribbon rooster saddle satchel scarecrow sextant skillet sled "
    "spindle sponge stencil sundial tambourine teapot thermos tractor turnip umbrella velvet violin wagon walnut weathervane whistle windmill yarn anchor attic balcony barn "
    "beacon blanket bonfire bridge cabin carousel cellar chalk clover comet cottage curtain dune ember fiddle fountain glacier grove guitar hearth island jungle junkyard "
    "lagoon library lighthouse market mill motel mountain museum oven pantry parade pier pond porch postcard quarry railway reef ridge river sandbar shed shore silo skylight "
    "staircase tent tide tower trail tunnel valley vineyard volcano waterfall wharf workshop"
).split()

LlmFn = Callable[[list], Awaitable[str]]
WriteFn = Callable[[dict], Awaitable[dict]]


def anchors_for(seed, n: int = 3) -> list:
    """Three distinct random anchor words, a pure function of the season seed (a side stream; no shared randomness)."""
    h = int(hashlib.sha256(f"{seed}:world:house-anchor".encode()).hexdigest(), 16)
    pool = list(ANCHORS)
    out = []
    for _ in range(n):
        i = h % len(pool)
        h //= len(pool) or 1
        out.append(pool.pop(i))
    return out


def build_messages(brief: Optional[dict], seed, rejected: Optional[dict] = None) -> list:
    facts = ""
    if isinstance(brief, dict):
        facts = f"This season's casting direction: {brief.get('demographicSkew', '')}; {brief.get('regionalFlavor', '')}.\n"
    system = (
        "You are the production designer of a reality-TV house. Invent THIS season's house: a short NAME, a one-sentence PITCH, and for EACH of the 14 rooms a NAME (3-48 "
        "characters) and a LOOK (one line of physical detail: materials, colours, objects; no people, no events). The three bedrooms are related but distinct "
        "(bedroom-a sleeps six, bedroom-b and bedroom-c five). Every room name must be different and must SAY what the room is: it is the room's own plain word (kitchen, living room, dining room, bedroom, bathroom, lounge, hallway, backyard, and the HOH room, landing, storage room and Diary Room as they are) with at most ONE lowercase themed word in front of it, or just the plain word. A name is refused when the theme stands in for the room (a themed word with no plain word), or when more than one word comes before the plain word; the one themed word is a lowercase common word from the season's theme, never a title, a place or a person's name. The theme lives in the LOOK, not in the name. Invent from the season facts and "
        "the anchor words; do not reach for a stock theme. Output ONLY a JSON object: "
        '{"name":"..","pitch":"..","rooms":{"kitchen":{"name":"..","look":".."}, ...}} with exactly these room keys: ' + ", ".join(ROOM_IDS) + "."
    )
    user = (
        facts
        + f"Anchor words (let ONE colour the house; do not use them all): {', '.join(anchors_for(seed))}.\n"
    )
    if rejected:
        user += "The last draft was refused (" + ", ".join(f"{k} x{v}" for k, v in rejected.items()) + "): make every room name new and distinct, and keep the lengths in range.\n"
    user += "JSON only:"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def parse_house(text: str) -> Optional[dict]:
    if not text:
        return None
    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`")
        t = t[t.find("{"):] if "{" in t else t
    a, b = t.find("{"), t.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        obj = json.loads(t[a:b + 1])
    except ValueError:
        return None
    return obj if isinstance(obj, dict) and isinstance(obj.get("rooms"), dict) else None


async def author_house(brief: Optional[dict], seed, llm_fn: LlmFn, write_fn: WriteFn, retries: int = 1) -> dict:
    """One call (plus at most ``retries`` re-asks after an engine refusal), then the plain labels stand. Returns ``{accepted, attempts, rejected}``."""
    rejected: Optional[dict] = None
    for attempt in range(1 + max(0, retries)):
        try:
            text = await llm_fn(build_messages(brief, seed, rejected))
        except Exception as e:  # fail-soft: a model error never blocks the season, but it is recorded
            from src import log_rings  # #1599: fail-soft, never silent
            log_rings.record_soft_failure("house-authoring:model-failed", e, corrected="the plain house labels stand")
            return {"accepted": False, "attempts": attempt + 1, "rejected": {"model": 1}}
        house = parse_house(text)
        if house is None:
            rejected = {"unparseable": 1}
            continue
        try:
            res = await write_fn({"npcs": [], "house": house})
        except Exception as e:
            from src import log_rings  # #1599: fail-soft, never silent
            log_rings.record_soft_failure("house-authoring:write-failed", e, corrected="the plain house labels stand")
            return {"accepted": False, "attempts": attempt + 1, "rejected": {"write": 1}}
        h = (res or {}).get("house") or {}
        if h.get("accepted"):
            return {"accepted": True, "attempts": attempt + 1, "rejected": {}}
        rejected = h.get("rejected") or {"refused": 1}
    return {"accepted": False, "attempts": 1 + max(0, retries), "rejected": rejected or {}}


_DONE: set = set()  # (user, seed) that already authored (accepted or not): one bounded call per season, never a second grind


async def run_house(seed, owner: Optional[str]) -> dict:
    """Resolve the live model + the engine write-back and author the house for the warmed season. Idempotent per (user, seed); fail-soft."""
    key = (owner or "default", str(seed))
    if key in _DONE:
        return {"accepted": False, "attempts": 0, "rejected": {}, "reason": "already-ran"}
    _DONE.add(key)
    try:
        from src import orwell_cast_genesis as genesis
        from src import orwell_engine
        llm_fn = await genesis._resolve_llm_fn(owner)
        if llm_fn is None:
            _DONE.discard(key)  # nothing was spent: a retried warm may try the house again
            return {"accepted": False, "attempts": 0, "rejected": {"model": 1}}

        async def _write(proposal: dict) -> dict:
            return await orwell_engine.record_cast_genesis(proposal, user=owner)

        return await author_house(genesis.generate_season_brief(int(seed)), seed, llm_fn, _write)
    except Exception as e:
        _DONE.discard(key)  # the call itself failed (a provider error): a retried warm may try again
        from src import log_rings  # #1599: fail-soft, never silent
        log_rings.record_soft_failure("house-authoring:skipped", e, corrected="the plain house labels stand")
        return {"accepted": False, "attempts": 0, "rejected": {"error": 1}}
