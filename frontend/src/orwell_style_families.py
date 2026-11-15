"""ORW-360: the style-family list, mirrored from ``src/domain/styleFamilies.ts`` (one authority).

Parity-tested against the TS file (tests/test_orw360_style_families.py). Edit both together.
Each family: id, label (the presentation string), sample (the seeded one-line brief) and keywords
(tell-tale words used only to check an authored style stays inside its own family).
"""
from __future__ import annotations

import re

STYLE_FAMILIES: tuple[dict, ...] = (
    {"id": "rocker", "label": "rocker edge", "sample": "all black, leather jacket, graphic band tees", "keywords": ["rocker", "band tee", "leather jacket", "studded", "biker"]},
    {"id": "punk", "label": "DIY punk", "sample": "DIY patches, safety pins, plaid and heavy boots", "keywords": ["punk", "safety pin", "diy", "spiked", "bondage"]},
    {"id": "goth", "label": "goth", "sample": "black lace trim, silver jewelry, dark painted nails", "keywords": ["goth", "black lace", "dark lipstick", "silver jewelry", "corset"]},
    {"id": "preppy", "label": "preppy and buttoned-up", "sample": "oxfords, chinos, a crisp cardigan", "keywords": ["preppy", "oxford", "chinos", "cardigan", "boat shoes"]},
    {"id": "southern", "label": "southern Sunday best", "sample": "a pressed seersucker blazer or crisp light-blue shirt, loafers, a pocket square", "keywords": ["southern", "sunday best", "pearls", "loafers", "seersucker"]},
    {"id": "country-club", "label": "country-club sporty", "sample": "a polo, tennis or golf layers, a visor", "keywords": ["country club", "polo", "tennis", "golf", "visor"]},
    {"id": "quiet-luxury", "label": "quiet luxury", "sample": "cashmere, soft neutrals, one fine watch", "keywords": ["quiet luxury", "cashmere", "neutrals", "fine watch", "merino"]},
    {"id": "corporate", "label": "corporate business casual", "sample": "a blazer, button-down, slacks, polished shoes", "keywords": ["business casual", "button-down", "slacks", "lanyard", "dress shirt"]},
    {"id": "minimalist", "label": "minimalist monochrome", "sample": "one tone head to toe, clean lines, no accessories", "keywords": ["minimalist", "monochrome", "clean lines", "capsule wardrobe", "one tone"]},
    {"id": "streetwear", "label": "streetwear", "sample": "oversized hoodies, statement sneakers, a snapback", "keywords": ["streetwear", "sneakerhead", "snapback", "statement sneakers", "bucket hat"]},
    {"id": "luxury-streetwear", "label": "high-end street style", "sample": "a designer track set, a chunky chain, fresh sneakers", "keywords": ["designer", "track set", "chunky chain", "high-end street", "fresh kicks"]},
    {"id": "athleisure", "label": "athleisure and gym energy", "sample": "joggers or leggings, a zip-up, running shoes", "keywords": ["athleisure", "joggers", "leggings", "zip-up", "running shoes"]},
    {"id": "college-athlete", "label": "college athlete", "sample": "team-color shorts, slides, a compression tee", "keywords": ["team-color", "varsity", "compression", "slides", "jersey"]},
    {"id": "skater", "label": "skater", "sample": "baggy jeans, canvas sneakers, a beanie", "keywords": ["skater", "skate", "baggy jeans", "beanie", "canvas sneakers"]},
    {"id": "y2k", "label": "Y2K throwback", "sample": "low-rise jeans, a graphic cropped tee, tinted glasses", "keywords": ["y2k", "low-rise", "baby tee", "tinted glasses", "butterfly clips"]},
    {"id": "glam", "label": "full glam", "sample": "camera-ready contoured grooming, a highlighter glow, a sharply tailored outfit", "keywords": ["glam", "contour", "lashes", "highlighter", "bold lip"]},
    {"id": "bohemian", "label": "bohemian", "sample": "flowing layers, stacked rings, fringe", "keywords": ["bohemian", "boho", "fringe", "flowy", "maxi"]},
    {"id": "crunchy", "label": "crunchy granola", "sample": "natural fibers, sandals, a beaded anklet", "keywords": ["crunchy", "natural fibers", "hemp", "sandals", "anklet"]},
    {"id": "cottagecore", "label": "cottagecore", "sample": "a smocked linen shirt, a chunky knit sweater, a straw hat", "keywords": ["cottagecore", "prairie dress", "smocked", "puff sleeve", "gingham apron"]},
    {"id": "vintage", "label": "vintage thrift", "sample": "mixed decades, corduroy, a retro knit", "keywords": ["vintage", "thrift", "corduroy", "retro", "mixed decades"]},
    {"id": "beachy", "label": "beachy surf", "sample": "a faded tee, board shorts, a shell necklace", "keywords": ["beachy", "surf", "board shorts", "shell necklace", "flip-flops"]},
    {"id": "western", "label": "western ranch", "sample": "a pearl-snap shirt, boots, a big belt buckle", "keywords": ["western", "pearl-snap", "belt buckle", "cowboy", "ranch"]},
    {"id": "workwear", "label": "rugged workwear", "sample": "a canvas jacket, carpenter pants, work boots", "keywords": ["workwear", "carpenter", "work boots", "canvas jacket", "tool belt"]},
    {"id": "outdoorsy", "label": "outdoorsy technical", "sample": "a fleece, a puffer vest, hiking boots", "keywords": ["outdoorsy", "fleece", "puffer vest", "hiking", "trail"]},
    {"id": "camo", "label": "rural camo", "sample": "a camo jacket, a ball cap, flannel", "keywords": ["camo", "ball cap", "flannel", "hunting", "trucker hat"]},
    {"id": "military", "label": "military-tidy", "sample": "a tucked crisp tee, fitted cargos, a close crop", "keywords": ["military", "tucked", "close crop", "cargos", "high-and-tight"]},
    {"id": "academic", "label": "academic tweed", "sample": "a tweed blazer, a sweater vest, glasses", "keywords": ["academic", "tweed", "sweater vest", "elbow patch", "professor"]},
    {"id": "gamer", "label": "gamer and anime fan", "sample": "an oversized pastel hoodie, enamel pins", "keywords": ["gamer", "anime", "enamel pin", "pastel", "manga"]},
    {"id": "miami", "label": "Miami flashy", "sample": "a bold printed silk shirt, gold jewelry, white sneakers", "keywords": ["miami", "silk shirt", "gold jewelry", "white sneakers", "flashy"]},
    {"id": "healthcare", "label": "healthcare off-shift", "sample": "scrub pants, a zip jacket, clogs", "keywords": ["scrub", "clogs", "nurse", "badge reel", "hospital"]},
)

_BY_ID = {f["id"]: f for f in STYLE_FAMILIES}
_BY_LABEL = {f["label"]: f for f in STYLE_FAMILIES}


def family_for_label(label: str) -> dict | None:
    return _BY_LABEL.get((label or "").strip())


def family_by_id(fid: str) -> dict | None:
    return _BY_ID.get(fid)


def _kw_re(kw: str) -> re.Pattern:
    # word-start AND word-end: "surf" must not match inside "surface"; a plain inflection (surfs, surfing, scrubs, carpenters) still does
    return re.compile(r"(?<![a-z])" + re.escape(kw) + r"(?:e?s|ed|ers?|ing)?(?![a-z])", re.I)


_KW_RES = {f["id"]: [_kw_re(k) for k in f["keywords"]] for f in STYLE_FAMILIES}


def families_mentioned(text: str) -> list[str]:
    """Ids of every family whose keywords appear in ``text`` (word-start and word-end match, case-insensitive)."""
    return [fid for fid, res in _KW_RES.items() if any(r.search(text or "") for r in res)]
