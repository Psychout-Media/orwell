"""Showrunner memory, part B, canon ledger v1 (ORW-223 slice 1) - the FRONT-END half of the room-canon write-back.

After a narrated turn, one small constrained extraction asks a utility model which STANDING physical details of the
room the narration newly stated (a decor item, a loose object lying around), and writes each BACK to the engine with
``recordRoomCanon({roomId, feature})``. The engine re-validates everything (known room, <= 120 chars, no event /
outcome / secret / place / device / relationship / number, played game only) and keeps the ledger; the Show Brief then
lists the current room's canon so later turns stay consistent.

Hard rules: best-effort and fail-soft (no model, a bad reply, a refused write => nothing happens, never an error to the
player); invents nothing (it only relays what the narration already said); sends exactly ``{roomId, feature}``; never
touches hidden state. Gated by the Show Brief flag (the brief is where canon shows) and the engine's ``ORWELL_ROOM_CANON``
flag (an engine-off write is simply refused). Tests never need a live model: the extraction fn is injectable.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

FEATURE_MAX_CHARS = 120   # the engine's cap (ROOM_CANON_FEATURE_MAX); we never send more
MAX_FEATURES_PER_TURN = 2  # the engine's per-scene canon budget is 2
NARRATION_MAX_CHARS = 3600  # ORW-1066: the whole turn, tail first (the player usually ends in a new room there); 1500 head chars missed it
_MIN_NARRATION_CHARS = 80  # a one-liner has no room texture worth a model call

LlmFn = Callable[[list], Awaitable[str]]
WriteFn = Callable[[dict], Awaitable[dict]]

_SYSTEM = (
    "You extract STANDING physical details of a room from a Big Brother narration so a later scene stays consistent. "
    "Reply IMMEDIATELY with ONLY a JSON object, no prose, no code fence: "
    '{"features":["<a short noun phrase, at most 15 words>"]} . '
    "Take details ONLY of the room where the scene ENDS (where the player is at the end of the narration); ignore any room the player left "
    "earlier in the narration. "
    "Include ONLY a decor item or a loose everyday object the narration newly placed in the room (a mug on the ledge, "
    "a faded blanket over the sofa arm). NEVER include what a person does, says, thinks or feels; events, votes, "
    "deals, plans, secrets, discoveries; hidden or new places; keys, notes, devices; counts or numbers; or anything "
    "about the house rules. Most turns have none: reply {\"features\":[]} when unsure."
)


# ORW-1066: nothing is lost silently. Every discard and every engine refusal is counted by reason, in process
# (``discard_counts``), and refusals other than an accepted write are one soft failure per reason per turn.
_DISCARDS: dict = {}
_LAST_ROOM: dict = {}


def _count(reason: str, n: int = 1) -> None:
    _DISCARDS[reason] = _DISCARDS.get(reason, 0) + n


def discard_counts() -> dict:
    return dict(_DISCARDS)


def clean_features(raw: object) -> list[str]:
    """Features from an extraction reply, bounded: strings only, one line, <= 120 chars (longer ones are DROPPED, not
    truncated), no duplicates, at most ``MAX_FEATURES_PER_TURN``."""
    feats = raw.get("features") if isinstance(raw, dict) else None
    out: list[str] = []
    for f in feats if isinstance(feats, list) else []:
        if not isinstance(f, str):
            _count("feature-not-a-string")
            continue
        t = re.sub(r"\s+", " ", f).strip().strip('"').strip()
        if not t or len(t) > FEATURE_MAX_CHARS or t.lower() in (x.lower() for x in out):
            _count("feature-empty-long-or-duplicate")
            continue
        out.append(t)
        if len(out) >= MAX_FEATURES_PER_TURN:
            _count("features-over-cap", max(1, len(feats) - feats.index(f) - 1))
            break
    return out


def _parse(reply: str) -> object:
    """The LAST brace-balanced JSON object in a (possibly reasoning-prefixed) reply, or None."""
    for m in reversed([m.start() for m in re.finditer(r"\{", reply or "")]):
        depth = 0
        for j in range(m, len(reply)):
            depth += (reply[j] == "{") - (reply[j] == "}")
            if depth == 0:
                try:
                    obj = json.loads(reply[m:j + 1])
                except ValueError:
                    break
                if isinstance(obj, dict) and "features" in obj:
                    return obj
                break
    return None


async def capture_room_canon(narration: str, room_id: Optional[str], llm: LlmFn, write: WriteFn) -> int:
    """Extract the narration's newly stated room texture and write it back. Returns how many writes the engine
    ACCEPTED. Never raises."""
    try:
        if not isinstance(room_id, str) or not room_id or len(narration or "") < _MIN_NARRATION_CHARS:
            return 0
        reply = await llm([
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": f"THE NARRATION:\n{narration[-NARRATION_MAX_CHARS:]}\n\nJSON:"},
        ])
        accepted = 0
        refused: dict = {}
        for feature in clean_features(_parse(reply or "")):
            res = await write({"roomId": room_id, "feature": feature})
            if isinstance(res, dict) and res.get("accepted") is True:
                accepted += 1
            else:
                reason = str(res.get("reason") or "refused") if isinstance(res, dict) else "no-reply"
                slug = re.sub(r"[^a-z0-9]+", "-", reason.lower()).strip("-")[:30] or "refused"
                refused[slug] = refused.get(slug, 0) + 1
                _count("refused-" + slug)
        if refused:
            from src import log_rings
            for slug, n in refused.items():
                log_rings.record_soft_failure(f"room-canon:refused-{slug}",
                                              RuntimeError(f"the engine refused {n} room-canon write(s): {slug}"))
        return accepted
    except Exception as e:  # fail-soft: canon is enrichment, never the turn
        logger.debug(f"[room-canon] skipped: {e}")
        try:
            from src import log_rings
            log_rings.record_soft_failure("room-canon:capture-failed", e, corrected="the show goes on without it")
        except Exception:  # failsoft-ok: recorder-self
            pass
        return 0


async def after_turn(narration: str, owner, endpoint_url, model, headers) -> int:
    """The live hook (called from the agent loop's end-of-turn banking). Off when the Show Brief is off."""
    try:
        from src.orwell_show_brief import show_brief_enabled
        if not show_brief_enabled():
            return 0
        from src.llm_core import llm_call_async
        from src import orwell_engine as _oe

        wa = await _oe.whereabouts(user=owner)
        room_id = wa.get("room") if isinstance(wa, dict) else None
        _key = owner or "default"
        if isinstance(room_id, str) and _LAST_ROOM.get(_key) not in (None, room_id):
            _count("turn-started-in-another-room")  # the player moved: features are asked for in the room the scene ends in
        if isinstance(room_id, str):
            if len(_LAST_ROOM) > 2000:
                _LAST_ROOM.clear()
            _LAST_ROOM[_key] = room_id

        async def _llm(messages: list) -> str:
            return await llm_call_async(url=endpoint_url, model=model, messages=messages, headers=headers,
                                        temperature=0.2, max_tokens=600, timeout=30,
                                        call_class="utility-extraction", user=(owner or "default"))

        async def _write(payload: dict) -> dict:
            return await _oe.record_room_canon(payload["roomId"], payload["feature"], user=owner)

        return await capture_room_canon(narration, room_id, _llm, _write)
    except Exception as e:
        logger.debug(f"[room-canon] hook skipped: {e}")
        try:
            from src import log_rings
            log_rings.record_soft_failure("room-canon:hook-failed", e, corrected="the show goes on without it", user=owner)
        except Exception:  # failsoft-ok: recorder-self
            pass
        return 0
