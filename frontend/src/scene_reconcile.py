"""ORW-1148: reconcile a scene the player (and the story) hold with the board the engine holds.

Prod 2026-11-28 03:54 to 04:05Z: the story and the player had three houseguests together in one bedroom, the engine had them elsewhere. For six turns every reply re-grounded the narrator to the
engine and the beat never moved, because nothing ever resolved the disagreement: the system only re-asserted the engine and repeated it. This module is the missing step.

* `note_contradiction` / `note_clean_turn` count how many turns in a row the same disagreement (the same room, overlapping names) shows up. One count per turn, however many guards see it.
* `reground_allowed` is the "never the same fact twice in a row" gate: the first sighting is re-grounded once, a repeat is handed to `reconcile` instead of nagging again.
* `reconcile` resolves a repeated disagreement. A person who is awake, in the house, within `MAX_HOPS` rooms and let in is walked over through the engine's own `moveHouseguest` (the engine stays the
  authority and refuses an illegal move); the narrator is told to voice the arrival. A person who cannot come (asleep, gone, too far, a closed door) is explained once, with the real options.
* `regroup` is the logged ops entry point (dry run or commit) for a live save, so nobody needs an ad hoc script. `frontend/scripts/orwell_regroup.py` calls it.

Deterministic, no model. Fail-open: any hiccup returns a no-op outcome and the old re-ground stands."""
from __future__ import annotations

import json
import logging
import os
import re
import time
from collections import deque
from typing import Iterable, Optional

logger = logging.getLogger(__name__)

MAX_HOPS = 3            # "a room or two away" plus the corridor: the farthest walk that still counts as reachable
REPEAT_TURNS = 2        # the same disagreement on this many turns in a row is a loop, not a slip
MAX_PEOPLE = 4

_FALLBACK_ADJACENCY = {
    "kitchen": ("living-room", "dining-room", "backyard", "storage-room"),
    "living-room": ("kitchen", "dining-room", "hallway", "bathroom", "lounge", "landing", "diary-room"),
    "dining-room": ("kitchen", "living-room", "backyard"),
    "backyard": ("kitchen", "dining-room"),
    "hallway": ("living-room", "bedroom-a", "bedroom-b", "bedroom-c"),
    "bedroom-a": ("hallway",), "bedroom-b": ("hallway",), "bedroom-c": ("hallway",),
    "bathroom": ("living-room", "lounge"), "lounge": ("living-room", "bathroom"),
    "landing": ("living-room", "hoh-room"), "hoh-room": ("landing",),
    "storage-room": ("kitchen",), "diary-room": ("living-room",),
}


def parse_engine_adjacency(path: Optional[str] = None) -> Optional[dict]:
    """The engine's own walk graph (src/domain/house.ts HOUSE_ADJACENCY), parsed so this module carries no drifting copy; None when the source is not on disk."""
    path = path or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "src", "domain", "house.ts")
    try:
        text = open(path, encoding="utf-8").read()
        m = re.search(r"export const HOUSE_ADJACENCY: [^=]*=\s*new Map<[^>]*>\(\[(.*?)\]\);", text, re.S)
        if not m:
            return None
        out = {}
        for room, lst in re.findall(r'\[\s*"([a-z-]+)"\s*,\s*\[([^\]]*)\]\s*\]', m.group(1)):
            out[room] = tuple(re.findall(r'"([a-z-]+)"', lst))
        return out or None
    except Exception:  # failsoft-ok: the vendored fallback graph is pinned to the engine's by a test; a missing source file just uses it
        return None


ADJACENCY: dict = parse_engine_adjacency() or _FALLBACK_ADJACENCY


def hops(a: str, b: str) -> Optional[int]:
    """Doors between two rooms on the engine's walk graph; None when either is unknown or they are not connected."""
    if a == b:
        return 0
    if a not in ADJACENCY or b not in ADJACENCY:
        return None
    seen, q = {a: 0}, deque([a])
    while q:
        cur = q.popleft()
        for n in ADJACENCY.get(cur, ()):
            if n not in seen:
                seen[n] = seen[cur] + 1
                if n == b:
                    return seen[n]
                q.append(n)
    return None


# ── the repeat counter (one count per turn) ──────────────────────────────────────────────────────
_STREAK: dict = {}   # user key -> {"room", "names": set, "count", "token", "handled"}


def _k(user) -> str:
    return user if user is not None else ""


def reset(user=None) -> None:
    _STREAK.pop(_k(user), None)


def reset_all() -> None:
    _STREAK.clear()


def note_contradiction(user, token, room: str, names: Iterable[str]) -> int:
    """Record that this turn's story put `names` in `room` while the engine has them elsewhere. `token` identifies the turn (any object; the same token is the same turn), so several guards
    seeing the same turn count once. Returns how many turns in a row this disagreement has now stood."""
    names = {str(n) for n in names if str(n).strip()}
    if not names:
        return 0
    k = _k(user)
    cur = _STREAK.get(k)
    if cur and cur["token"] is token:
        cur["names"] |= names
        return cur["count"]
    if cur and cur["room"] == room and cur["names"] & names:
        cur.update(names=cur["names"] | names, count=cur["count"] + 1, token=token)
        return cur["count"]
    _STREAK[k] = {"room": room, "names": names, "count": 1, "token": token, "handled": None}
    return 1


def note_clean_turn(user, token) -> None:
    """A turn with no disagreement ends the streak (a handled one is over, a slip that did not repeat is forgotten)."""
    cur = _STREAK.get(_k(user))
    if cur and cur["token"] is not token:
        _STREAK.pop(_k(user), None)


def count(user) -> int:
    cur = _STREAK.get(_k(user))
    return cur["count"] if cur else 0


def handled(user) -> Optional[str]:
    """How the standing disagreement was already resolved ("committed" or "explained"), or None."""
    cur = _STREAK.get(_k(user))
    return cur.get("handled") if cur else None


def mark_handled(user, mode: str) -> None:
    cur = _STREAK.get(_k(user))
    if cur:
        cur["handled"] = mode


def reground_allowed(user) -> bool:
    """Never re-ground the same fact twice in a row: true for the first sighting only. A repeat goes to `reconcile`, and once it was resolved the plain nag stays off."""
    cur = _STREAK.get(_k(user))
    return not cur or cur["count"] < REPEAT_TURNS


def should_reconcile(user) -> bool:
    cur = _STREAK.get(_k(user))
    return bool(cur) and cur["count"] >= REPEAT_TURNS and not cur.get("handled")


# ── resolving it ──────────────────────────────────────────────────────────────────────────────
def _join(names) -> str:
    names = [str(n) for n in names]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def _room_word(room: str, room_names=None) -> str:
    nm = (room_names or {}).get(room) if isinstance(room_names, dict) else None
    return nm.strip() if isinstance(nm, str) and nm.strip() else str(room).replace("-", " ")


def committed_directive(names, room, room_names=None) -> str:
    return ("ENGINE TRUTH, SCENE RECONCILED: the engine has just walked " + _join(names) + " into " + _room_word(room, room_names) + ", where the player is, so the scene you and the player were "
            "playing is now real. Voice their arrival in one short beat, then play on with them here and move the story forward. Do not re-explain where they were and do not question the scene again.")


def explained_directive(refused, room, here_names=(), room_names=None) -> str:
    why = "; ".join(f"{n} {r}" for n, r in refused)
    left = (" The people actually here are " + _join(here_names) + ".") if here_names else ""
    return ("SAY THIS ONCE, THEN MOVE ON: the scene the player described cannot happen as told in " + _room_word(room, room_names) + " (" + why + ")." + left + " Tell the player plainly in one or two "
            "lines why, then offer the real options: walk over to them, wait until they can come, or carry on with who is here. Do not stage them in this room and do not repeat this explanation on later turns.")


def _id_of(state: dict, name: str) -> Optional[str]:
    for h in (state.get("house") or []):
        if isinstance(h, dict) and h.get("name") == name and h.get("id"):
            return str(h["id"])
    return None


def _status_of(state: dict, name: str) -> str:
    for h in (state.get("house") or []):
        if isinstance(h, dict) and h.get("name") == name:
            return str(h.get("status") or "active")
    return "gone"


def _asleep(state: dict) -> set:
    return {str(a.get("name")) for a in (state.get("asleep") or []) if isinstance(a, dict) and a.get("name")}


async def reconcile(user, room: str, names: Iterable[str], state: dict, engine, *, npc_rooms: Optional[dict] = None, room_names=None, here_names=()) -> dict:
    """Resolve a repeated disagreement. Returns {"mode": "committed"|"explained"|"none", "moved": [names], "refused": [(name, reason)], "directive": str, "beatSeq": last move result}. Never raises.
    `engine` is `src.orwell_engine` (or a stand-in with `move_houseguest(id, room, user=)`)."""
    out = {"mode": "none", "moved": [], "refused": [], "directive": "", "last": None}
    try:
        npc_rooms = npc_rooms or {}
        sleepers = _asleep(state)
        moved, refused = [], []
        for name in sorted({str(n) for n in names})[:MAX_PEOPLE]:
            st = _status_of(state, name)
            hid = _id_of(state, name)
            if st != "active" or not hid:
                refused.append((name, "has already left the house"))
                continue
            if name in sleepers:
                refused.append((name, "has turned in and is asleep"))
                continue
            known = npc_rooms.get(name)
            if known:
                d = hops(str(known), room)
                if d is not None and d > MAX_HOPS:
                    refused.append((name, "is too far across the house to be here"))
                    continue
            try:
                res = await engine.move_houseguest(hid, room, user=user)
            except Exception as e:  # failsoft-ok: scene-reconcile (recorded RED; the person is explained below as unable to come, the loop never retries blind)
                from src import log_rings as _lr
                _lr.record_soft_failure("scene-reconcile:move", e, corrected="explained", user=user)
                refused.append((name, "could not get here just now"))
                continue
            status = res.get("status") if isinstance(res, dict) else None
            if status in ("moved", "noop"):
                moved.append(name)
                out["last"] = res
            else:
                refused.append((name, "is behind a door that stays shut to this scene"))
        out["moved"], out["refused"] = moved, refused
        if moved:
            out["mode"] = "committed"
            out["directive"] = committed_directive(moved, room, room_names)
        if refused:
            tail = explained_directive(refused, room, here_names, room_names)
            out["mode"] = out["mode"] if moved else "explained"
            out["directive"] = (out["directive"] + "\n" + tail) if moved else tail
    except Exception as e:  # failsoft-ok: scene-reconcile is a repair step; on any hiccup the old re-ground path stands
        logger.warning("[orwell] scene reconcile skipped: %s: %s", type(e).__name__, e)
    return out


# ── the ops entry point ──────────────────────────────────────────────────────────────────────
def _ops_log_path() -> str:
    return os.environ.get("ORWELL_OPS_LOG") or os.path.join(os.path.expanduser("~"), ".orwell", "ops-regroup.jsonl")


def _ops_log(entry: dict) -> None:
    logger.warning("[orwell] ops-regroup %s", json.dumps(entry, sort_keys=True, default=str))
    try:
        p = _ops_log_path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, sort_keys=True, default=str) + "\n")
    except Exception:  # failsoft-ok: the logger line above is the record when the file cannot be written
        pass


async def regroup(user, room: str, who: Iterable[str], engine, *, reason: str, apply: bool = False, operator: str = "ops") -> dict:
    """Bring `who` (names or ids) into `room` on a live save through the engine's own moveHouseguest, with an audit line before and after. Dry run unless `apply`. Returns the report;
    each person is one of moved, noop, illegal, unknown, error, would-move."""
    state = await engine.get_game_state(user=user)
    house = [h for h in ((state or {}).get("house") or []) if isinstance(h, dict)]
    report = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "operator": operator, "user": user, "room": room, "reason": reason, "apply": bool(apply), "people": []}
    for w in who:
        h = next((x for x in house if w in (x.get("id"), x.get("name"))), None)
        if not h or (h.get("status") or "active") != "active":
            report["people"].append({"who": w, "result": "unknown"})
            continue
        if not apply:
            report["people"].append({"who": w, "id": h.get("id"), "name": h.get("name"), "result": "would-move"})
            continue
        try:
            res = await engine.move_houseguest(h["id"], room, user=user)
            report["people"].append({"who": w, "id": h.get("id"), "name": h.get("name"), "result": (res or {}).get("status", "error")})
        except Exception as e:  # failsoft-ok: ops-regroup reports the error per person; the rest continue
            report["people"].append({"who": w, "id": h.get("id"), "name": h.get("name"), "result": "error", "error": type(e).__name__})
    _ops_log(report)
    return report
