"""ORW-418: the house's room list, read from the engine's own floor plan (src/domain/house.ts HOUSE_ROOMS) so the front end's move belts never carry a copy that drifts.

The front end once held its own list of 9 rooms; the engine has 13, so the hallway, lounge, dining room and bedroom C could never be reached by the belts. The list is parsed from the
engine source at import. If the source is not on disk (a front-end-only checkout), the vendored fallback below is used; tests/test_orw418_house_rooms.py pins the fallback to the parsed list."""
from __future__ import annotations

import os
import re
import unicodedata

_FALLBACK = (
    "kitchen", "living-room", "dining-room", "backyard", "hallway",
    "bedroom-a", "bedroom-b", "bedroom-c", "bathroom", "lounge",
    "hoh-room", "storage-room", "diary-room", "landing",
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


def fold_room_text(text) -> str:
    """ORW-466: lowercase, accents dropped ("séance" -> "seance") and curly apostrophes made straight, so a themed name matches however it was typed."""
    s = unicodedata.normalize("NFD", str(text or "")).replace("\u2018", "'").replace("\u2019", "'").replace("\u02bc", "'")
    return re.sub(r"\s+", " ", "".join(c for c in s if not unicodedata.combining(c)).lower()).strip()


# Generic last words a player may drop ("the coral reef" for "the Coral Reef Room"); the engine's `themedRoomAliases` (src/engine/roomLabels.ts) uses the same list.
_GENERIC_TAIL = re.compile(r"\s+(room|cabin|pod|cave|chamber|suite|quarters)$")


def _themed_forms(room_names):
    """[(form, room id, prose_safe)] for each themed room: the full name, the name without "the", and (not for the Diary Room) the name without a generic last word, bare and
    with "the". Folded (see `fold_room_text`). A form that would name two rooms is dropped, as the engine drops it."""
    by: dict = {}
    for rid, name in (room_names.items() if isinstance(room_names, dict) else ()):
        if rid not in HOUSE_ROOMS or not isinstance(name, str) or not name.strip():
            continue
        full = fold_room_text(name).replace("-", " ")  # ORW-918: text is matched with its hyphens made spaces, so the forms are too ("the Ring-Toss Lounge" was never found)
        bare = re.sub(r"^the\s+", "", full)
        forms = [(full, True), (bare, False)]
        short = bare if rid == "diary-room" else _GENERIC_TAIL.sub("", bare)
        if short != bare:
            forms += [(short, False), (f"the {short}", not short.endswith("'s"))]  # "the captain's" reads as a person, not a room, in prose
        if rid.startswith("bedroom") and bare.endswith(" bedroom"):  # ORW-1008: "the Palmetto room" for "the Palmetto Bedroom" (the engine's themedRoomAliases takes it too)
            head = bare[: -len(" bedroom")].strip()
            if head:
                forms += [(f"{head} room", False), (f"the {head} room", True)]
        for form, prose in forms:
            if len(form) >= 3:
                rooms, was_prose = by.get(form, (set(), False))
                by[form] = (rooms | {rid}, was_prose or prose)
    return [(f, next(iter(rooms)), prose) for f, (rooms, prose) in by.items() if len(rooms) == 1]


def themed_rooms_in(text, room_names) -> list:
    """ORW-466: the room ids `text` names by this season's themed names, in the order they appear: the full name ("the Coral Reef Room", "Main Street") or its short form
    with "the" ("the Coral Reef"), however accented or apostrophed. A bare one-word form ("hold" for "the Hold") is never looked for in prose. [] without a theme."""
    forms = [(f, rid) for f, rid, prose in _themed_forms(room_names) if prose]
    if not forms or not text:
        return []
    low = fold_room_text(str(text).replace("-", " "))
    hits = []
    for form, rid in forms:
        m = re.search(r"(?<![\w'])" + re.escape(form) + r"(?![\w'])", low)
        if m:
            hits.append((m.start(), rid))
    out: list = []
    for _, rid in sorted(hits):
        if rid not in out:
            out.append(rid)
    return out


# ORW-918: the plain words prose uses for the house's rooms, each with the room ids it can mean ("the lounge" can be the lounge or a season's "Ring-Toss Lounge"; "the bunk" any
# bedroom). Only words that name a ROOM in prose; a word that is often something else ("landing") is left out.
_PLAIN_ROOM_WORDS = (
    (r"kitchen|galley", ("kitchen",)),
    (r"back ?yard|the yard|out back", ("backyard",)),
    (r"living room", ("living-room",)),
    (r"lounge", ("lounge", "living-room")),
    (r"dining room|dining table", ("dining-room",)),
    (r"hallway|corridor", ("hallway",)),
    (r"bedroom|bunk ?room|bunks?", ("bedroom-a", "bedroom-b", "bedroom-c")),
    (r"bathroom", ("bathroom",)),
    (r"hoh room|hoh suite", ("hoh-room",)),
    (r"storage room", ("storage-room",)),
    (r"diary room", ("diary-room",)),
)


def rooms_named_in(text, room_names=None) -> list:
    """ORW-918: every place `text` names, as a list of candidate room-id sets in order: a season's themed name is one room, a plain word ("the lounge", "his bunk") is the rooms it
    can mean. [] when the text names no room. Deterministic; only ids the house has."""
    if not text:
        return []
    low = fold_room_text(str(text).replace("-", " "))
    hits = [(m.start(), frozenset({rid})) for form, rid, prose in _themed_forms(room_names) if prose
            for m in [re.search(r"(?<![\w'])" + re.escape(form) + r"(?![\w'])", low)] if m]
    for pat, ids in _PLAIN_ROOM_WORDS:
        m = re.search(r"\b(?:" + pat + r")\b", low)
        rooms = frozenset(i for i in ids if i in HOUSE_ROOMS)
        if m and rooms:
            hits.append((m.start(), rooms))
    out: list = []
    for _, rooms in sorted(hits, key=lambda h: h[0]):
        if rooms not in out:
            out.append(rooms)
    return out


def room_id_of(value, room_names=None) -> str | None:
    """The room id a move extraction answered, or None. ORW-466: tolerates an echo of the themed listing ("bedroom-a (this season: the Coral Reef Room)") and, with a
    house theme, the themed name itself or a form of it the engine also takes ("the Coral Reef Room" / "Coral Reef Room" / "the coral reef" / "Seance Room")."""
    if not isinstance(value, str):
        return None
    v = re.sub(r"\s*\(this season:[^)]*\)\s*$", "", value.strip(), flags=re.IGNORECASE).strip()
    if v in HOUSE_ROOMS:
        return v
    low = fold_room_text(v)
    for form, rid, _ in _themed_forms(room_names):
        if low == form:
            return rid
    return None
