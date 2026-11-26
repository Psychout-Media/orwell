"""ORW-1030: an agreed companion is a committed engine fact that moves with the player until it is ended.

The 11-26 prod audit found five cases where a houseguest who agreed to walk with the player vanished or was swapped the next turn. The engine's `companions` field only lists who shares the
player's room; nothing recorded that someone had AGREED to come along, so the engine's own presence drift (a held scene-room houseguest still rolls to leave) and an unrequested-arrival drop in
the narrated-move belt undid it. This module keeps the agreed set per user, registers it from the player's own words plus the narration, re-seats each companion in the player's room through the
engine's `moveHouseguest` (a legal adjacent move, the engine stays the authority), and hands the narrator an engine-truth steer line. It ends only when the player says so. Deterministic, no model.
Fail-open: any hiccup skips; the next turn re-checks."""
from __future__ import annotations

import logging
import re
from typing import Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)

_MAX_COMPANIONS = 3

# the player asks someone to come along / says who they will go with
_ACCOMPANY_RE = re.compile(
    r"\b(?:come|walk|go|head|tag\s+along|follow)\b[^.!?\n]{0,30}\bwith\s+(?:me|us)\b|\bcome\s+(?:along|with)\b|\bjoin\s+me\b|\blet'?s\s+(?:go|walk|head)\b|\bwalk\s+me\b"
    r"|\b(?:i'?ll|i\s+will|i'?m\s+going\s+to|let\s+me)\s+go\s+with\b|\bgo\s+with\s+(?:just\s+)?\w+|\bcome\s+with\b|\bwalk\s+(?:there\s+)?together\b",
    re.I)
# the player ends it
_END_RE = re.compile(
    r"\b(?:stay\s+here|you\s+stay|wait\s+here|i'?ll\s+go\s+(?:alone|by\s+myself|on\s+my\s+own)|go(?:ing)?\s+(?:alone|by\s+myself)|on\s+my\s+own|by\s+myself|never\s*mind|you\s+can\s+go|"
    r"go\s+back|catch\s+you\s+later|see\s+you\s+later|leave\s+me|i\s+need\s+(?:a\s+)?(?:minute|moment|space|to\s+be\s+alone))\b", re.I)
# the narration shows the houseguest declining
_REFUSE_RE = re.compile(r"\b(?:declines?|declined|refuses?|refused|shakes?\s+(?:her|his|their)\s+head|can'?t\s+(?:right\s+now|come)|says?\s+no|not\s+now|stays?\s+(?:behind|put))\b", re.I)

_COMPANIONS: Dict[str, Dict[str, str]] = {}   # user key -> {houseguest id: name}
_LAST_PRESENT: Dict[str, set] = {}            # user key -> ids that shared the player's room at the last check


def _key(user) -> str:
    return user if user is not None else ""


def _first(name: str) -> str:
    return str(name or "").split()[0] if str(name or "").strip() else ""


def _named_in(text: str, name: str) -> bool:
    f = _first(name)
    return bool(f) and bool(re.search(r"\b" + re.escape(f) + r"\b", text or "", re.I))


def companions_of(user) -> Dict[str, str]:
    return dict(_COMPANIONS.get(_key(user)) or {})


def clear(user) -> None:
    _COMPANIONS.pop(_key(user), None)
    _LAST_PRESENT.pop(_key(user), None)


def steer_line(user) -> str:
    """Engine-truth line for the narrator's next framing; empty when nobody is walking with the player."""
    comp = companions_of(user)
    if not comp:
        return ""
    names = ", ".join(comp.values())
    return ("WALKING WITH THE PLAYER (engine truth): " + names + " agreed to come along and is with the player now. They stay with the player, move with the player to every room, and speak and react in every scene "
            "until the player says they go their own way. Never write them out of the scene, leave them behind, or swap in someone else.")


def register(user, last_user: str, present: Iterable[dict], prior_present: Iterable[str], narration: str) -> List[str]:
    """Pure-ish: apply end and invite rules to the stored set. `present` = [{id, name}] now with the player. Returns the ids added."""
    k = _key(user)
    text = last_user or ""
    roster = {p.get("id"): p.get("name") for p in present if isinstance(p, dict) and p.get("id") and p.get("name")}
    store = _COMPANIONS.setdefault(k, {})
    if _END_RE.search(text):
        named = [hid for hid, n in list(store.items()) if _named_in(text, n)]
        for hid in (named or list(store)):
            store.pop(hid, None)
        if not store:
            _COMPANIONS.pop(k, None)
        return []
    added: List[str] = []
    if _ACCOMPANY_RE.search(text) and not _REFUSE_RE.search(narration or ""):
        named = [hid for hid, n in roster.items() if _named_in(text, n)]
        # unnamed ask ("come with me"): the houseguests the narration shows going along
        pool = named or [hid for hid, n in roster.items() if _named_in(narration or "", n)]
        for hid in pool:
            if hid in store or len(store) >= _MAX_COMPANIONS:
                continue
            store[hid] = roster[hid]
            added.append(hid)
    if not store:
        _COMPANIONS.pop(k, None)
    return added


async def update(user, last_user: str, narration: str) -> int:
    """Post-turn: register / end companions from the player's words, then re-seat every companion in the player's room. Returns the number of engine moves applied. Never raises."""
    try:
        from src import orwell_engine as _oe
        w = await _oe.whereabouts(user=user)
        if not isinstance(w, dict) or not w.get("room"):
            return 0
        k = _key(user)
        present = [p for p in (w.get("present") or []) if isinstance(p, dict)]
        register(user, last_user, present, _LAST_PRESENT.get(k) or (), narration)
        moved = await _reseat(user, w)
        _LAST_PRESENT[k] = {p.get("id") for p in present if p.get("id")} | set(companions_of(user))
        return moved
    except Exception as e:  # failsoft-ok: companions are a steady-state aid; the next turn re-checks
        logger.warning("[orwell] companions update skipped: %s: %s", type(e).__name__, e)
        return 0


async def enforce(user) -> int:
    """Pre-reply: the engine's presence drift since last turn is undone before the narrator reads the room. Never raises."""
    try:
        if not companions_of(user):
            return 0
        from src import orwell_engine as _oe
        w = await _oe.whereabouts(user=user)
        if not isinstance(w, dict) or not w.get("room"):
            return 0
        return await _reseat(user, w)
    except Exception as e:  # failsoft-ok: see update()
        logger.warning("[orwell] companions enforce skipped: %s: %s", type(e).__name__, e)
        return 0


async def _reseat(user, w: dict) -> int:
    from src import orwell_engine as _oe
    room = w.get("room")
    here = {p.get("id") for p in (w.get("present") or []) if isinstance(p, dict)}
    moved = 0
    res = None
    for hid in list(companions_of(user)):
        if hid in here:
            continue
        try:
            res = await _oe.move_houseguest(hid, room, user=user)
        except Exception as e:
            logger.info("[orwell] companion %s re-seat failed: %s", hid, e)
            continue
        if isinstance(res, dict) and res.get("status") == "moved":
            moved += 1
        elif isinstance(res, dict) and res.get("status") == "illegal":
            logger.info("[orwell] companion %s could not be re-seated into %s (illegal move); kept for next turn", hid, room)
    if moved and isinstance(res, dict):
        try:
            from routes import chat_helpers as _ch
            _ch._refresh_beat_seq(user, res)  # the move commits: adopt its beatSeq token
        except Exception:
            pass
    return moved
