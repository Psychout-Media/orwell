"""ORW-480: the casting-director pass. Tags every card for every attribute KIND in the shared table (`cast_realism.json`, mirrored from
src/domain/castRealism.json), counts values across a cast, and names the values that are over their cap. Deterministic, pure, public
card text only; no model call. A new kind is a new entry in the table, not new code here."""
from __future__ import annotations

import json
import math
import os
import re
from functools import lru_cache
from typing import Optional

_TABLE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cast_realism.json")


@lru_cache(maxsize=1)
def table() -> dict:
    with open(_TABLE_PATH, encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=None)
def _word_re(word: str):
    # a space in a table word also matches a hyphen ("home health" reads "home-health")
    if word.endswith("*"):
        return re.compile(r"\b" + re.escape(word[:-1]).replace("\\ ", "[ -]"), re.I)
    return re.compile(r"\b" + re.escape(word).replace("\\ ", "[ -]") + r"(?:s|es)?\b", re.I)


def _matches(value_def: dict, text: str) -> Optional[int]:
    """The earliest position of any of the value's words in `text`, or None."""
    best = None
    for w in value_def.get("words", []):
        m = _word_re(w).search(text)
        if m and (best is None or m.start() < best):
            best = m.start()
    return best


def field_text(card: dict, field: str, first_item: bool = False) -> str:
    phys = card.get("physicalCharacteristics") if isinstance(card.get("physicalCharacteristics"), dict) else {}
    if field == "vocation":
        return str(card.get("vocation") or "")
    if field == "onCamera":
        return str(phys.get("onCamera") or card.get("onCamera") or "")
    if field == "wardrobe":
        w = phys.get("wardrobe") if isinstance(phys.get("wardrobe"), list) else card.get("wardrobe")
        items = [str(x) for x in w] if isinstance(w, list) else []
        return (items[0] if items else "") if first_item else " | ".join(items)
    return str(card.get(field) or phys.get(field) or "")


def tag_kind(kind_id: str, card: dict) -> list:
    """The values of one kind this card carries ([] when none): one for a single kind, every match for a multi kind."""
    kind = table()["kinds"][kind_id]
    text = field_text(card, kind["field"], kind.get("scope") == "first-item")
    if not text.strip():
        return []
    if kind.get("rule") == "rules":
        for rule in kind["rules"]:
            if any(_word_re(w.strip()).search(text) for w in rule["any"]) and not any(_word_re(w.strip()).search(text) for w in rule.get("not", [])):
                return [rule["sector"]]
        return ["other"]
    if kind.get("rule") == "head-noun":
        words = re.findall(r"[a-z]+", text.lower())
        return [words[-1]] if words else []
    hits = [(v, _matches(vd, text)) for v, vd in kind.get("values", {}).items()]
    hits = [(v, pos) for v, pos in hits if pos is not None]
    if kind.get("multi"):
        return [v for v, _ in hits]
    if hits:
        if kind.get("rule") == "earliest":
            return [min(hits, key=lambda x: x[1])[0]]
        return [hits[0][0]]
    return [kind["fallback"]] if kind.get("fallback") else []


def tag_card(card: dict) -> dict:
    """{kind: [values]} for every kind with at least one value."""
    out = {}
    for k in table()["kinds"]:
        v = tag_kind(k, card)
        if v:
            out[k] = v
    return out


def cap_for(kind_id: str, value: str, n: int) -> int:
    kind = table()["kinds"][kind_id]
    cap = (kind.get("values", {}).get(value) or {}).get("cap") or kind["cap"]
    if kind.get("rule") == "head-noun" and value in kind.get("generic", []):
        cap = kind["generic-cap"]
    return max(int(cap.get("min", 1)), int(math.ceil(float(cap.get("share", 0)) * n)))


def count_values(tags_list: list) -> dict:
    """{kind: {value: how many cards carry it}} over a list of `tag_card` results."""
    out: dict = {}
    for tags in tags_list:
        for k, vals in tags.items():
            for v in set(vals):
                out.setdefault(k, {})[v] = out.setdefault(k, {}).get(v, 0) + 1
    return out


def over_cap(tags_list: list, n: Optional[int] = None) -> dict:
    """{kind: {value: count}} for every value used by more cards than its cap allows in a cast of `n` (default: the list length)."""
    n = n or len(tags_list)
    found: dict = {}
    for k, vals in count_values(tags_list).items():
        for v, c in vals.items():
            if v == "other":
                continue
            if c > cap_for(k, v, n):
                found.setdefault(k, {})[v] = c
    return found


def offenders_for(tags: dict, earlier: list, n: int) -> dict:
    """The values this card would ADD beyond the cap, given the tags of the cards already accepted: {kind: [value]}. A card is
    an offender for a value when `cap` earlier cards already carry it, so the first cards keep their phrasing and only later cards
    are named."""
    counts = count_values(earlier)
    out: dict = {}
    for k, vals in tags.items():
        for v in vals:
            if v == "other":
                continue
            if counts.get(k, {}).get(v, 0) >= cap_for(k, v, n):
                out.setdefault(k, []).append(v)
    return out


def unreal_clothes(text: str) -> list:
    """The unreal-clothes words found in a wardrobe piece or the style line (a work badge, a costume, a uniform as a style...)."""
    return [w for w in table()["unreal-clothes"]["words"] if re.search(r"\b" + re.escape(w), text or "", re.I)]


def is_garment(item: str) -> bool:
    """True when the piece names at least one garment or accessory noun a shop sells."""
    return any(re.search(r"\b" + re.escape(n) + r"s?\b", item or "", re.I) for n in table()["garment-nouns"])


_JOB_KINDS = ("sector", "role")


def job_offenders(job: str, taken_jobs: list, n: int) -> dict:
    """{kind: [value]} when adding `job` to a cast that already holds `taken_jobs` would put its job sector over the cap or repeat
    a job head noun (two office managers, two coaches). Used at the genesis deal: an offending job is dropped so the engine floors
    that slot's job."""
    tag = tag_card({"vocation": job})
    earlier = [tag_card({"vocation": j}) for j in taken_jobs]
    found = offenders_for({k: v for k, v in tag.items() if k in _JOB_KINDS}, earlier, n)
    return found


def job_taken_hint(taken_jobs: list, n: int) -> str:
    """One prompt sentence naming the job sectors already at their cap and the job words already used, or "" when none."""
    tags = [tag_card({"vocation": j}) for j in taken_jobs]
    counts = count_values(tags)
    full = sorted(v for v, c in counts.get("sector", {}).items() if v != "other" and c >= cap_for("sector", v, n))
    roles = sorted(counts.get("role", {}))
    parts = []
    if full:
        parts.append("job sectors already FULL in this cast (pick a job in a different sector): " + ", ".join(full))
    if roles:
        parts.append("job words already used (do not end your job title with any of them): " + ", ".join(roles))
    return "; ".join(parts)


def garment_groups(item: str) -> list:
    """The garment groups a single wardrobe piece names (top, outer, bottom, shoes, jewelry ...). Two groups in one piece means the
    piece is two things ("a vest over a polo", "sneakers with a gold chain")."""
    found = []
    for g, nouns in table()["garment-groups"].items():
        if any(re.search(r"\b" + re.escape(n).replace("\\ ", "[ -]") + r"s?\b", item or "", re.I) for n in nouns):
            found.append(g)
    return found


def is_multi_garment(item: str) -> bool:
    """True when one wardrobe piece names garments from two different groups and joins them ("a vest over a polo", "sneakers with a gold
    chain"). A belt or scarf beside one garment ("jeans with a plain belt") is allowed."""
    groups = [g for g in garment_groups(item) if g != "belt-scarf"]
    if len(groups) < 2:
        return False
    return bool(re.search(r"\b(?:" + "|".join(re.escape(j) for j in table()["garment-joiners"]) + r")\b|,", item or "", re.I))


# ── ORW-480: the look fits the life (the engine deal in src/domain/styleFit.ts uses the same numbers) ──────────

def _fit():
    return table()["look-fit"]


def is_big_city(hometown) -> bool:
    city = str(hometown or "").split(",")[0].strip().lower()
    return any(c.lower() == city for c in _fit()["big-cities"])


def life_sector(vocation) -> str:
    return (tag_kind("sector", {"vocation": vocation or ""}) or ["other"])[0]


def life_affluence(vocation) -> float:
    return _fit()["sector-affluence"].get(life_sector(vocation), 1)


def style_fit_weight(family_id: str, vocation=None, hometown=None, age=None) -> float:
    """The fit of a style family to a life: 1 neutral, below about 0.3 a poor fit, above 1 a good one (same maths as styleFitWeight in TS)."""
    f = _fit()
    w = 1.0
    fam = f["family-affluence"].get(family_id)
    if fam is not None:
        gap = abs(fam - life_affluence(vocation))
        w *= 1 if gap <= 0.5 else (0.4 if gap <= 1 else 0.12)
    band = f["family-age"].get(family_id)
    if band and age is not None and (age < band[0] or age > band[1]):
        w *= 0.25
    town = f["family-town"].get(family_id)
    if town == "small" and is_big_city(hometown):
        w *= 0.4
    if town == "big" and hometown and not is_big_city(hometown):
        w *= 0.4
    if family_id in f["sector-families"].get(life_sector(vocation), []):
        w *= 2
    return w


def _upscale_words(text: str) -> list:
    return [w for w in _fit()["upscale-words"] if re.search(r"\b" + re.escape(w), text or "", re.I)]


_STATE_ABBR = {"AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
               "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky",
               "LA": "Louisiana", "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri",
               "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York", "NC": "North Carolina",
               "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
               "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming"}


def hometown_state(hometown) -> str:
    parts = [p_.strip() for p_ in str(hometown or "").split(",")]
    last = parts[-1] if len(parts) > 1 else ""
    return _STATE_ABBR.get(last.upper(), last)


def climate_misfit(card: dict) -> list:
    """Words that do not fit the hometown's weather or coast: winter layers in a hot state, beach clothes in a cold or inland one."""
    cl = _fit()["climate"]
    state = hometown_state(card.get("hometown"))
    city = str(card.get("hometown") or "").split(",")[0].strip()
    phys = card.get("physicalCharacteristics") if isinstance(card.get("physicalCharacteristics"), dict) else {}
    text = field_text(card, "wardrobe") + " | " + str(phys.get("style") or "")
    bad = []
    if state in cl["hot-states"]:
        bad += [w for w in cl["hot-forbid"] if re.search(r"\b" + re.escape(w), text, re.I)]
    if state in cl["cold-states"]:
        bad += [w for w in cl["cold-forbid"] if re.search(r"\b" + re.escape(w), text, re.I)]
    inland = state in cl["inland-states"] or (state == "Texas" and city not in cl["texas-coastal-cities"])
    if inland:
        bad += [w for w in cl["coastal-words"] if re.search(r"\b" + re.escape(w), text, re.I) and w not in bad]
    return bad


def look_fits_life(card: dict) -> list:
    """Why a card's look does not fit its life: [] when it does.
    "family": the dealt style family is a poor fit for the job sector, hometown and age (reported).
    "family-worn": ... and the wardrobe or style line really follows that family (a rewrite from the person fixes it).
    "upscale": two or more expensive-look words on a modest life. "climate": winter layers in a hot state, beach clothes inland or in a cold state.
    "missing": no wardrobe at all."""
    from src.orwell_style_families import family_for_label, families_mentioned
    out = []
    phys = card.get("physicalCharacteristics") if isinstance(card.get("physicalCharacteristics"), dict) else {}
    text = field_text(card, "wardrobe") + " | " + str(phys.get("style") or "")
    fam = family_for_label(str(card.get("presentation") or ""))
    if fam is not None and style_fit_weight(fam["id"], card.get("vocation"), card.get("hometown"), card.get("age")) < _fit()["min-weight"]:
        out.append("family")
        if fam["id"] in families_mentioned(text):
            out.append("family-worn")
    if life_affluence(card.get("vocation")) <= 0.5 and len(set(_upscale_words(text))) >= 2:
        out.append("upscale")
    if climate_misfit(card):
        out.append("climate")
    if not field_text(card, "wardrobe").strip():
        out.append("missing")
    return out
