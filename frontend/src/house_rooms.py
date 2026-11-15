"""ORW-418: the house's room list, read from the engine's own floor plan (src/domain/house.ts HOUSE_ROOMS) so the front end's move belts never carry a copy that drifts.

The front end once held its own list of 9 rooms; the engine has 13, so the hallway, lounge, dining room and bedroom C could never be reached by the belts. The list is parsed from the
engine source at import. If the source is not on disk (a front-end-only checkout), the vendored fallback below is used; tests/test_orw418_house_rooms.py pins the fallback to the parsed list."""
from __future__ import annotations

import os
import re

_FALLBACK = (
    "kitchen", "living-room", "dining-room", "backyard", "hallway",
    "bedroom-a", "bedroom-b", "bedroom-c", "bathroom", "lounge",
    "hoh-room", "storage-room", "diary-room",
)


def parse_engine_rooms(path: str | None = None) -> tuple[str, ...] | None:
    path = path or os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "src", "domain", "house.ts")
    try:
        text = open(path, encoding="utf-8").read()
        m = re.search(r"export const HOUSE_ROOMS: readonly Room\[\] = \[(.*?)\];", text, re.S)
        rooms = tuple(re.findall(r'"([a-z-]+)"', m.group(1))) if m else ()
        return rooms or None
    except Exception:  # failsoft-ok: the vendored fallback list is pinned to the engine's by a test; a missing source file just uses it
        return None


HOUSE_ROOMS: tuple[str, ...] = parse_engine_rooms() or _FALLBACK


def room_id_list(rooms, room_names=None) -> str:
    """The room ids for a move-extraction prompt, comma-separated. ORW-466: with a house theme (`room_names`, the whereabouts `roomNames`), each id also carries this season's
    name, "bedroom-a (this season: the Coral Reef Room)", so the player's "the coral reef" maps to bedroom-a. The id stays what the model returns. No theme: the plain ids."""
    if not isinstance(room_names, dict) or not room_names:
        return ", ".join(rooms)

    def _one(r: str) -> str:
        n = room_names.get(r)
        return f"{r} (this season: {n.strip()})" if isinstance(n, str) and n.strip() else r
    return ", ".join(_one(r) for r in rooms)


def room_id_of(value, room_names=None) -> str | None:
    """The room id a move extraction answered, or None. ORW-466: tolerates an echo of the themed listing ("bedroom-a (this season: the Coral Reef Room)") and, with a
    house theme, the themed name itself ("the Coral Reef Room" / "Coral Reef Room")."""
    if not isinstance(value, str):
        return None
    v = re.sub(r"\s*\(this season:[^)]*\)\s*$", "", value.strip(), flags=re.IGNORECASE).strip()
    if v in HOUSE_ROOMS:
        return v
    low = v.lower()
    for rid, name in (room_names.items() if isinstance(room_names, dict) else ()):
        if rid in HOUSE_ROOMS and isinstance(name, str) and name.strip() and name.strip().lower() in (low, f"the {low}"):
            return rid
    return None
