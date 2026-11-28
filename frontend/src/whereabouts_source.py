"""ORW-1141: one consistent source for the presence strip between turns.

/api/orwell/whereabouts serves either the engine's LIVE read or the per-turn FROZEN snapshot (with the
front-end's own NPC moves re-applied), chosen by `freeze_view` on every read. The choice can change
between two polls while nothing happened: the strip then read "Just you here" and a moment later four
faces (or the reverse) with no turn and no engine move between.

`choose` latches the answer: while the frame (the frozen snapshot plus its move count) and the live
occupancy are both unchanged, a read that would switch source gets the previous answer instead. A new
turn (new frame), a front-end move (move count) or an engine move (the live occupancy changed) all
release the latch, so a real change still shows at once.
"""
import json
import logging

logger = logging.getLogger(__name__)

_LATCH: dict = {}  # user -> {"frozen": obj, "moves": int, "sig": str, "branch": str, "payload": obj}


def live_signature(live) -> str:
    """Stable string of who is where in a live whereabouts read (room, present ids, nearby ids)."""
    if not isinstance(live, dict):
        return "none"

    def ids(refs):
        return sorted(str((r or {}).get("id") or (r or {}).get("name") or "") for r in (refs or []) if isinstance(r, dict))

    nearby = sorted(
        (str(nb.get("room") or ""), ids(nb.get("present")))
        for nb in (live.get("nearby") or []) if isinstance(nb, dict)
    )
    return json.dumps([str(live.get("room") or ""), ids(live.get("present")), nearby], sort_keys=True)


def choose(user, live, candidate, frozen, moves):
    """Return the whereabouts to serve. `candidate` is what `freeze_view` picked (the live object itself
    when it fell back to live); `frozen` is the turn's frozen snapshot object (or None); `moves` the
    number of front-end NPC moves recorded this turn."""
    key = user or ""
    branch = "live" if candidate is live else "frozen"
    sig = live_signature(live)
    prev = _LATCH.get(key)
    if (prev and prev["frozen"] is frozen and prev["moves"] == moves and prev["sig"] == sig
            and prev["branch"] != branch):
        logger.info("[orwell] whereabouts source held at %s (read would have switched to %s; no turn or engine move between)", prev["branch"], branch)
        return prev["payload"]
    if not prev or prev["branch"] != branch:
        logger.info("[orwell] whereabouts source: %s", branch)
    _LATCH[key] = {"frozen": frozen, "moves": moves, "sig": sig, "branch": branch, "payload": candidate}
    return candidate


def reset() -> None:
    _LATCH.clear()
