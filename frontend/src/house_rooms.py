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
