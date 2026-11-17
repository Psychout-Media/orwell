"""ORW-508 Layer 3(b): a per-user memory of what the last seasons on this install used.

A language model (and a seeded deal) has favourites. Each time a season starts, the cast's names, hometowns,
jobs and marks are written here; the next cast is dealt and authored with "already used, avoid" lists built
from the last ``WINDOW`` seasons. It lives HERE, in the front end's own ``data/`` dir, keyed by user, and NOT
in the engine save: a save is per player and can be deleted or restored, and a new game would otherwise
forget what the last one used. The engine receives the lists only as an explicit ``avoid`` argument, so a
seeded headless run (which passes none) never reads it.

Mirrors ``orwell_seasons.py``: a small JSON map, atomically written, a corrupt file reads as empty. Vault-free by
construction: only public card facts (name, town, job, visible mark) are stored, never a hidden value.
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path

from core.atomic_io import atomic_write_json
from src.constants import DATA_DIR

LEDGER_PATH = Path(DATA_DIR) / "orwell_recent_seasons.json"

#: Seasons remembered per user (the same number as the engine module, ``LEDGER_WINDOW``).
WINDOW = 6
FACT_KINDS = ("names", "hometowns", "vocations", "marks", "phrases")
_MAX_ITEMS = 80
_MAX_CHARS = 120

_LOCK = threading.Lock()


def _key(user: str | None) -> str:
    return (user or "default").strip() or "default"


def _clean_list(xs) -> list:
    if not isinstance(xs, (list, tuple)):
        return []
    out, seen = [], set()
    for x in xs:
        if not isinstance(x, str):
            continue
        v = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", x)).strip()[:_MAX_CHARS]
        if not v or v.lower() in seen:
            continue
        seen.add(v.lower())
        out.append(v)
        if len(out) >= _MAX_ITEMS:
            break
    return out


def _clean_season(s) -> dict:
    s = s if isinstance(s, dict) else {}
    out = {}
    for k in FACT_KINDS:
        lst = _clean_list(s.get(k))
        if lst:
            out[k] = lst
    return out


def _load() -> dict:
    try:
        return json.loads(LEDGER_PATH.read_text(encoding="utf-8")) or {}
    except FileNotFoundError:
        return {}
    except Exception:
        # A corrupt store must never break the game: fall back to "nothing remembered".
        return {}


def seasons_for(user: str | None) -> list:
    """The user's remembered seasons, oldest first, at most ``WINDOW`` of them."""
    with _LOCK:
        raw = _load().get(_key(user))
    seasons = raw.get("seasons") if isinstance(raw, dict) else None
    if not isinstance(seasons, list):
        return []
    return [s for s in (_clean_season(x) for x in seasons) if s][-WINDOW:]


def avoid_for(user: str | None) -> dict:
    """The wire form the engine takes as ``avoid``: one list per kind, everything the remembered seasons used.
    Empty dict when nothing is remembered (so the caller sends nothing)."""
    merged: dict = {}
    for season in seasons_for(user):
        for k, vs in season.items():
            merged.setdefault(k, [])
            merged[k].extend(v for v in vs if v.lower() not in {m.lower() for m in merged[k]})
    return merged


def record_season(user: str | None, facts: dict) -> None:
    """Remember one season that just started; the oldest falls off past ``WINDOW``. Fail-soft: never raises."""
    season = _clean_season(facts)
    if not season:
        return
    try:
        with _LOCK:
            data = _load()
            k = _key(user)
            prev = data.get(k) if isinstance(data.get(k), dict) else {}
            seasons = [s for s in (_clean_season(x) for x in (prev.get("seasons") or [])) if s]
            seasons.append(season)
            data[k] = {"version": 1, "seasons": seasons[-WINDOW:]}
            atomic_write_json(str(LEDGER_PATH), data, indent=2)
    except Exception:
        pass


def facts_of_house(house) -> dict:
    """Public facts of a started cast (the engine's Vault-free roster): names, towns, jobs, visible marks."""
    names, towns, jobs, marks = [], [], [], []
    for c in house if isinstance(house, list) else []:
        if not isinstance(c, dict):
            continue
        if c.get("name"):
            names.append(c["name"])
        if c.get("hometown"):
            towns.append(c["hometown"])
        if c.get("vocation"):
            jobs.append(c["vocation"])
        m = (c.get("physicalCharacteristics") or {}).get("distinguishingMark") if isinstance(c.get("physicalCharacteristics"), dict) else None
        if isinstance(m, str) and m and not re.match(r"none\b", m, re.I):
            marks.append(m)
    return {"names": names, "hometowns": towns, "vocations": jobs, "marks": marks}
