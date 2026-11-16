"""ORW-480: the per-person SHOT BRIEF for cast photos.

Why: a shot card dealt from short lists (17 places, a table of expressions, a table of lights) cannot carry what is specific to one person's
sheet (the drainage ditch he skates, the clam dock behind her shop, the vegetable patch behind his apartment). So the primary path is a brief
AUTHORED PER PERSON by the cast writer (the same DeepSeek writer the cast authoring uses, never a Claude model) from the WHOLE public sheet, in one
call for the cast so the writer can spread the places, times and clothes. The engine adds RANDOM ANCHORS per person from seeded side streams (the facet
of life to feature, the time of day, the season and weather, the energy), passed as fixed facts so two casts cannot converge and the writer's favourites
cannot win. Acceptance is narrow and deterministic: a check on each brief, then ONE cast-level editor rewrite pass for the offenders (bounded), then the
FLOOR (the engine's dealt shot card, already in the prompt it built) for any brief that still fails. Rejections are counted in one log line.

The fixed sentences are never authored: the documentary opener, the person line, the face card, the hair, the single portrait-format sentence and the closers.
Only the clothes, setting, light and moment sentences of the engine's prompt are replaced by the brief.

Public sheet fields only (age, gender presentation, hometown, job, biography, demeanor, voice, casting type, on-camera line, wardrobe, style); the person's own
first and last name are scrubbed from every text sent to the writer and a brief that names them is rejected. Vault-free by construction.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Awaitable, Callable, Optional, Union

logger = logging.getLogger(__name__)

LlmFn = Callable[[Union[str, list]], Awaitable[str]]

# ---------------------------------------------------------------------------------------------------- random anchors
FACETS = (
    "home and family", "a hobby named in the biography", "a hangout in their hometown", "friends or a neighbour",
    "what they do on a weekend", "their own street or block", "a place they go to be alone", "a place they would take someone they love",
    "a small thing they look after at home", "a place from their childhood that they still use",
)
NEAR_WORK = "near their work (their own clothes, no work gear, no work prop)"
NEAR_WORK_MAX = 3
TIME_PARTS = {
    "morning": ("early morning, just after sunrise", "mid-morning", "late morning"),
    "noon": ("around noon", "midday, the sun high"),
    "afternoon": ("early afternoon", "mid-afternoon", "late afternoon"),
    "golden": ("the golden hour before sunset",),
    "evening": ("dusk", "the blue hour after sunset", "early evening, the first lamps on"),
}
TIMES = (
    "early morning, just after sunrise", "mid-morning", "late morning", "around noon", "early afternoon", "mid-afternoon",
    "late afternoon", "the golden hour before sunset", "dusk", "the blue hour after sunset", "early evening, the first lamps on",
)
SEASONS = {
    "spring": ("a first warm day", "light rain just ending", "thin high cloud", "wet ground after rain", "a windy day"),
    "summer": ("clear and hot", "hazy sun", "humid and heavy", "a passing cloud, bright", "dry heat"),
    "autumn": ("low grey overcast", "crisp and clear", "leaves down on the ground", "a cool, damp day", "a windy day"),
    "winter": ("crisp and cold", "low grey overcast", "snow still on the ground where it belongs, else bare ground", "thin pale sun", "a raw, damp day"),
}
ENERGIES = ("lively", "easy", "focused", "restless", "warm", "dry and amused", "tired but content", "playful", "steady", "wide awake")


def _h(*parts) -> int:
    return int(hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:12], 16)


def _spread(ids: list, options: tuple, tag: str, seed) -> dict:
    """Every id gets one option, each option used as evenly as possible: a seeded rotation of the cycle, dealt to the ids in a seeded order."""
    rot = _h(tag, "rot", seed, len(ids)) % len(options)
    seq = [options[(k + rot) % len(options)] for k in range(len(ids))]
    order = sorted(ids, key=lambda i: _h(tag, "order", seed, i))
    return dict(zip(order, seq))


def deal_anchors(cards: list, seed=0) -> dict:
    """Per-person fixed facts from seeded side streams: {id: {facet, time, season, weather, energy}}. At most NEAR_WORK_MAX (and about a fifth of the cast) are near work."""
    ids = [str(c.get("id")) for c in cards if isinstance(c, dict) and c.get("id")]
    jobs = {str(c.get("id")): str(c.get("vocation") or "").strip() for c in cards if isinstance(c, dict)}
    by_rank = sorted(ids, key=lambda i: _h("work", seed, i))
    near_n = min(NEAR_WORK_MAX, max(0, len(ids) // 7))
    near = {i for i in by_rank if jobs.get(i)}
    near = set(sorted(near, key=lambda i: _h("work", seed, i))[:near_n])
    # the time of day is dealt over the PARTS of the day first (about a fifth of the cast each), then a time inside the part: never a cast that is all dusk
    parts = _spread(ids, tuple(TIME_PARTS), "part", seed)
    times = {i: TIME_PARTS[parts[i]][_h("time", seed, i) % len(TIME_PARTS[parts[i]])] for i in ids}
    energies = _spread(ids, ENERGIES, "energy", seed)
    seasons = _spread(ids, tuple(SEASONS), "season", seed)
    out = {}
    for i in ids:
        facet = NEAR_WORK if i in near else FACETS[_h("facet", seed, i) % len(FACETS)]
        season = seasons[i]
        out[i] = {"facet": facet, "time": times[i], "season": season,
                  "weather": SEASONS[season][_h("weather", seed, i) % len(SEASONS[season])], "energy": energies[i]}
    return out


# ---------------------------------------------------------------------------------------------------- the writer call
FIELDS = ("where", "doing", "inFrame", "wear", "signature", "timeLight", "expressionBody", "why", "tie", "jobHints")
REQUIRED = ("where", "doing", "inFrame", "wear", "timeLight", "why", "tie")   # the signature is wanted but a brief without one is not rejected
LIMITS = {"where": 200, "doing": 190, "wear": 190, "signature": 120, "timeLight": 150, "expressionBody": 230, "why": 320, "tie": 240}
IN_FRAME_ITEM_MAX = 90

SYSTEM = (
    "You write ONE photo brief per person for a pre-season cast photo shoot of a reality show. The production visited each person at home on a roughly "
    "ordinary day of their own life and photographed them there: a plain, honest portrait of a real resident, not a studio shot. You see the whole cast so "
    "you can spread places, times and clothes; no two people may share a place or a look.\n"
    "Answer with JSON only: an object keyed by the person's id, each value an object with exactly these keys:\n"
    "where: one specific place from THIS person's own life that their biography names or implies, in concrete words (what and where it is, what is around it); never a "
    "bare category.\n"
    "doing: what they are in the middle of, paused for the photo: they have stopped for the camera and are not performing the activity (nothing swung, thrown, cast, jumped, raised overhead "
    "or mid-motion); natural and not acted. This sentence alone says how they stand or sit and what their hands are doing.\n"
    "inFrame: an array of exactly two OBJECTS in the frame that belong to their life in this place, taken from their sheet; not clothes or jewellery or nails they are wearing and not the signature item.\n"
    "wear: what they wear today, taken from their wardrobe, in their own everyday clothes.\n"
    "signature: when the sheet has a lookSignature, write exactly that; otherwise one object or detail of theirs that makes them memorable and fits their life; it is not one of the clothes listed in wear. Anything worn (jewellery, painted nails, a chain, a patch on a sleeve) is part of wear, not an object.\n"
    "timeLight: the time of day, the light and the weather. The anchors given for each person (the facet of life to feature, the time, the season and weather, the "
    "energy) are fixed facts: follow them; if the weather does not fit the town and season, keep the time and use the nearest plausible weather. When the weather is cold, wet or windy "
    "and their clothes would not do for it, add a layer from their own style (a jacket, an overshirt, a cardigan), as a real person would.\n"
    "expressionBody: the FACE only (expression, gaze, how wide the smile is), taken from their demeanor, their voice and their on-camera line, at the strength of a real person at ease; "
    "no arms, hands, legs or posture here, because doing already says them.\n"
    "why: one sentence that quotes, in double quotes, the exact phrases of their sheet that you used.\n"
    "jobHints: an array listing which of your inFrame objects and your signature (copied exactly) hint at their job; at most ONE may. The rest come from home, a hobby or family: "
    "the day in the life is never a total tell of who they are. Use an empty array when none does.\n"
    "tie: one sentence that quotes, in double quotes, the exact phrase of their sheet that this PLACE comes from: their home, their family, a hobby, a routine of their hometown, "
    "or a place next to their work. It is checked and never printed; a place with no tie to the sheet is rejected.\n"
    "Rules for every person. The facet of life to feature is the thing the photo shows; when it says near their work, the place is close to where they work but they wear "
    "their own clothes and nothing shows the job: no uniform, scrubs, apron, badge, work gear or work prop. The job is never a caption for the photo anywhere else either; "
    "a hobby or a family object is welcome. Posture is natural and upright (standing, or seated on something at normal height, or leaning lightly on something that is there); "
    "nothing is acted. Never change their hair or its styling, whatever the activity. No eyes shut, no open palm held out to nobody, no hat or sunglasses indoors, no sunglasses at all. Only the person is in sharp focus; life in the "
    "background (other people, animals, vehicles) is welcome and wanted but out of focus. No readable brand names, signs or text. Do not write the person's name: say "
    "'the person'. Do not describe framing, lens or camera. Invent from the sheet; do not reuse wording between people. Every object, signature item and place is used by ONE "
    "person only: when 'alreadyUsed' lists things, choose different ones."
)


def _scrub(text: str, name: str) -> str:
    out = str(text or "")
    for part in sorted({p for p in re.split(r"\s+", name or "") if len(p) >= 3}, key=len, reverse=True):
        out = re.sub(r"\b%s(?:['’]s)?\b" % re.escape(part), "the person", out)
    return out


def sheet_of(card: dict) -> dict:
    """The public sheet the writer reads (names scrubbed)."""
    name = str(card.get("name") or "")
    phys = card.get("physicalCharacteristics") if isinstance(card.get("physicalCharacteristics"), dict) else {}
    ct = card.get("castingType") if isinstance(card.get("castingType"), dict) else {}
    voice = card.get("voice")
    if isinstance(voice, dict):
        voice = "; ".join(str(v) for v in voice.values() if isinstance(v, str))
    return {
        "age": card.get("age"), "gender": card.get("genderPresentation"), "hometown": card.get("hometown"), "job": card.get("vocation"),
        "biography": _scrub(card.get("biography") or card.get("identityConcept") or "", name),
        "identity": _scrub(card.get("identityConcept") or "", name),
        "demeanor": _scrub(card.get("demeanor") or "", name), "voice": _scrub(voice or "", name)[:300],
        "castingType": f"{ct.get('label', '')}: {ct.get('read', '')}".strip(": "),
        "onCamera": _scrub(phys.get("onCamera") or "", name),
        "wardrobe": [_scrub(w, name) for w in (phys.get("wardrobe") or []) if isinstance(w, str)],
        "style": _scrub(phys.get("style") or "", name),
        **({"lookSignature": _scrub(phys.get("lookSignature"), name)} if isinstance(phys.get("lookSignature"), str) and phys.get("lookSignature").strip() else {}),
    }


CODE_WORDS = {
    "generic-place": "the place must be one specific place from their own life, in concrete words, not a bare category",
    "place-not-from-sheet": "the place must come from this person's own sheet (biography, hometown, identity)",
    "job-caption": "the job must not show in the place or the action; use a hobby, family or hometown facet",
    "work-gear": "no uniform, scrubs, apron, badge, lanyard, hard hat or stethoscope anywhere",
    "text-or-brand": "no readable text, signs, logos or brand names",
    "acted-or-odd-pose": "a natural upright pose only: no hunch, slump, sprawl, fists, pointing, flexing, eyes shut",
    "open-palm-to-nobody": "no open palm held out unless they are mid-sentence to someone",
    "hat-indoors": "no hat indoors", "sunglasses": "no sunglasses",
    "no-sheet-quote": "the why line must quote, in double quotes, exact phrases from their sheet",
    "inframe-worn-or-signature": "the two objects in the frame are things of theirs in this place: not worn clothing and not the signature item",
    "body-in-wear": "wear lists clothes only: no arms, shoulders, chin, eyes, smile or pose",
    "body-in-signature": "the signature is a thing or a detail of theirs, not a pose or an expression",
    "signature-repeats-wear": "the signature must not repeat something already listed in wear",
    "job-objects": "at most one object (of the two in the frame and the signature) may hint at the job; the rest come from home, a hobby or family",
    "no-place-tie": "the tie must quote, in double quotes, the exact phrase of the sheet this place comes from",
    "place-not-tied": "the place must come from the phrase quoted in tie (they share content words): home, family, a hobby, a hometown routine or next to their work",
    "weather-layer": "the weather is cold or wet: add a layer from their own style to wear",
    "object-repeat": "another person already has one of these objects or signature items: choose different things of theirs",
    "place-kind-repeat": "another person already has this kind of place: choose a different kind of place from their life",
    "light-repeat": "too many people share this time of day: keep the anchored time",
    "dark-palette": "too many people wear black, charcoal or navy: choose a colour from their wardrobe",
    "near-work-count": "too many people are photographed near work",
}


def _explain(codes: list) -> list:
    return [CODE_WORDS.get(c, c) for c in codes]


def used_summary(briefs: dict) -> dict:
    """What the accepted briefs already use, so the next writer or the editor chooses differently: objects, signatures, places, first garments."""
    objects, sigs, places, wear = [], [], [], []
    times: dict = {}
    for b in briefs.values():
        if not b:
            continue
        tb = _time_bucket(str(b.get("timeLight") or ""))
        times[tb] = times.get(tb, 0) + 1
        objects += [str(x) for x in (b.get("inFrame") or [])]
        if b.get("signature"):
            sigs.append(str(b["signature"]))
        places.append(str(b["where"])[:90])
        wear.append(str(b.get("wear") or "").split(",")[0])
    return {"objects": objects, "signatures": sigs, "places": places, "firstGarments": wear, "partsOfTheDayUsed": times}


def build_messages(cards: list, anchors: dict, used: Optional[dict] = None) -> list:
    cast = {str(c["id"]): {**sheet_of(c), "anchors": anchors.get(str(c["id"]), {})} for c in cards if isinstance(c, dict) and c.get("id")}
    payload = {"cast": cast, "maxCharacters": LIMITS}
    if used and any(used.values()):
        payload["alreadyUsed"] = used
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]


# ---------------------------------------------------------------------------------------------------- the checks (narrow, deterministic)
ACTED_RE = re.compile(
    r"hunch|slump|sprawl|lung(?:e|ing)|crouch|elbows? on (?:the |his |her |their )?knees|between (?:the |his |her |their )?knees|behind (?:the |his |her |their )?head|"
    r"chin resting|\bfists?\b|point\w* at|thumbs.?up|flex|jazz|snarl|bared|fierce|mugg|comic|disbelief|startled|wiggl|slapping|stretched out|"
    r"eyes (?:shut|closed|squeezed)|squeezed shut|eyes closed|dejected|on all fours|doubled over|cross-legged on the (?:ground|steps)|"
    r"\b(?:swinging|throwing|hurling|tossing|jumping|leaping|twirling|casting (?:a|the|his|her|their)|punching|kicking|lunging|whipping|slinging)\b|"
    r"mid-(?:swing|throw|jump|leap|spin|cast|kick|toss|motion|action|air)|(?:arms?|hands?) (?:raised|thrown|held|stretched) (?:up|high|overhead|above)|arms? (?:raised|up) |hands? (?:in|up in) the air", re.I)
OPEN_PALM_RE = re.compile(r"palms? (?:up|open|out)|open (?:hand|palm)|hand open|hands open|palm facing up", re.I)
TALKING_RE = re.compile(r"mid-sentence|talking to|telling (?:a|the) story|speaking to|laughing with|in conversation|chatting", re.I)
WORK_GEAR_RE = re.compile(r"\b(?:scrubs|uniform|apron|badge|lanyard|hard hat|turnout gear|stethoscope|name ?tag|high-vis|hi-vis|chef'?s? (?:coat|jacket|whites))\b", re.I)
TEXT_RE = re.compile(r"\b(?:logo|brand|sign (?:reading|that says)|reads? ['\"]|lettering|slogan|printed words|text on|written on|banner reading)\b|[A-Z][a-z]+(?:'s)? (?:Pizza|Diner|Market|Bar|Cafe|Café)\b(?= sign)", re.I)
_BRAND_STRONG = re.compile(r"\b(?:nike|adidas|coca[- ]cola|pepsi|starbucks|mcdonald'?s|walmart|harley|carhartt|patagonia|north face|levi'?s|budweiser|yeti|samsung|toyota|chevrolet)\b", re.I)
_BRAND_CAPITAL = re.compile(r"\b(?:Target|Ford|Apple|Honda|Vans|Converse|Puma|Corona|Chevy)\b")      # ordinary words in lower case (a target, a ford, vans): brands only when capitalised


class _Brand:
    """One search over the strong brands (any case) and the ambiguous ones (capitalised only)."""
    pattern = _BRAND_STRONG.pattern + "|" + _BRAND_CAPITAL.pattern

    @staticmethod
    def search(text):
        t = str(text or "")
        return _BRAND_STRONG.search(t) or _BRAND_CAPITAL.search(t)


BRAND_RE = _Brand()
HAT_RE = re.compile(r"\b(?:hat|cap|beanie|fedora|visor|bonnet)\b", re.I)
SUNGLASSES_RE = re.compile(r"\b(?:sunglasses|shades|goggles)\b", re.I)
INDOOR_RE = re.compile(r"\b(?:indoors?|inside|kitchen|living room|bedroom|dining|diner|booth|café|cafe|studio|shop(?! (?:window|front))|church (?:hall|basement|kitchen)|garage|hallway|stairwell|apartment|bar|kitchenette|bathroom|office|classroom|gym|locker|barn)\b", re.I)
OUTDOOR_RE = re.compile(r"\b(?:outdoors?|outside|yard|garden|porch|steps|stoop|dock|pier|beach|river|lake|trail|field|street|sidewalk|road|park|lot|ditch|bank|roof|balcony|patio|driveway|hill|dune|farm|orchard|court)\b", re.I)
DARK_TOP_RE = re.compile(r"\b(?:black|charcoal|navy|dark (?:grey|gray|blue))\b", re.I)
CLOTHING_RE = re.compile(r"\b(?:jackets?|jeans|trousers|pants|slacks|shorts|skirts?|dress(?:es)?|shirts?|t-?shirts?|tees?|tops?|tunics?|blouses?|hoodies?|sweaters?|cardigans?|knits?|vests?|coats?|parkas?|boots?|sneakers?|shoes?|loafers?|sandals?|flats?|socks?|scarf|scarves|hats?|caps?|beanies?|gloves?|earrings?|necklaces?|bracelets?|rings?|watch|belt|overalls|leggings|fleece|pullover|henley|polo|corduroy|denim|jumpsuit|apron|hoops?|jewelry|jewellery|sleeves?|collars?|cuffs?|nails?|nail polish|chains?|pendants?|anklets?|glasses|piercings?|studs?|clothes|clothing|garments?|outfits?|wardrobe)\b", re.I)
ACCESSORY_RE = re.compile(r"\b(?:earrings?|necklaces?|bracelets?|rings?|chains?|pendants?|anklets?|watch|glasses|piercings?|hoops?|studs?|jewelry|jewellery|nails?|nail polish|scarf|scarves)\b", re.I)
LAYER_RE = re.compile(r"\b(?:jacket|coat|overshirt|cardigan|sweater|fleece|hoodie|flannel|parka|vest|raincoat|windbreaker|wool|knit|long-sleeve|long sleeve|pullover|sweatshirt|corduroy)\b", re.I)
HOT_RE = re.compile(r"hot|heat|warm|humid", re.I)
COLD_WET_RE = re.compile(r"cold|damp|snow|rain|drizzle|raw|windy|crisp|grey overcast|low grey|wet|chill", re.I)
OBJ_STOP = frozenset("small silver golden battered worn old large little faded scuffed wooden metal plastic favorite favourite vintage colorful colourful bright rusty chipped steaming tattered simple plain leather cotton heavy folding another beside behind their theirs there where which while resting leaning propped sitting standing nearby sleeping half-finished half-eaten around against beneath above lined filled always things these those being would could about after before still again often usually never every other others sticking hanging lying placed kept holding carried tucked stuck pinned worn-in focus blurred distance distant background softly".split())
BODY_PART_RE = re.compile(r"\b(?:arms?|hands?|fingers?|legs?|ankles?|knees?|feet|foot|shoulders?|posture|stance|standing|sitting|seated|leaning|perched|crossed|folded|stretched|upright|torso|waist|hips?)\b", re.I)
BODY_RE = re.compile(r"\b(?:arms?|shoulders?|chin|eyes?|dimples?|smil\w*|laugh\w*|gaze|gazing|hands|fingers|standing|sitting|seated|leaning|posture|stance|brows?|mouth|lips?|grin\w*|stare|looking)\b(?!-)", re.I)
GENERIC_WHERE = re.compile(r"^(?:the |a |an |their |his |her )?(?:own )?(?:kitchen|living room|bedroom|dining room|backyard|back yard|front porch|porch|park|street|diner|coffee shop|cafe|café|yard|garden|house|home|apartment|bar|gym|shop|store|field|lake|beach|market|main street)\.?$", re.I)
PLACE_KINDS = (
    ("water", r"\b(?:dock|pier|lake|river|creek|bay|beach|harbou?r|canal|pond|shore|boat|marina|clam)\b"),
    ("street", r"\b(?:street|sidewalk|corner|block|crosswalk|alley|storefront|main street|stoop)\b"),
    ("yard", r"\b(?:yard|garden|patch|porch|steps|driveway|fence|lawn|balcony|patio)\b"),
    ("field", r"\b(?:field|trail|ridge|ditch|hill|woods|orchard|farm|pasture|prairie|dune|desert)\b"),
    ("kitchen", r"\b(?:kitchen|table|stove|counter|dining)\b"),
    ("indoor-room", r"\b(?:living room|bedroom|studio|hallway|garage|basement|attic|workshop|closet)\b"),
    ("public-building", r"\b(?:church|library|diner|bar|cafe|café|school|gym|hall|court|rink|stadium|shop|salon|theater|karaoke)\b"),
)
PLACE_KIND_MAX = 3
TIME_BUCKET_MAX = 4
GESTURES = (
    ("arms-crossed", r"arms (?:folded|crossed)"), ("hand-to-head", r"(?:back of (?:the |his |her |their )?neck|(?:the |his |her |their )hair)\b"),
    ("hips", r"hands? on (?:the |his |her |their )?hips?"), ("open-palm", r"palms? (?:up|open|out)|hand open|hands open"),
    ("pockets", r"pockets?\b"), ("holding-arm", r"holding (?:the |his |her |their )?(?:other|opposite) (?:wrist|arm|forearm|elbow)"),
)
GESTURE_MAX = 2
DARK_MAX = 4


def _norm(t: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", str(t or "").lower()).strip()


FUNCTION_WORDS = frozenset("with over from that this them they then were have into onto near down very just also like upon each both such same only more some than what when much many your their there where while about after under onto its his her".split())


def _cw(text: str) -> set:
    """Content words (4+ letters, no function words or common adjectives): what two phrases really share, so 'with' and 'over' never count as an overlap."""
    return {w for w in _norm(text).split() if len(w) >= 4 and w not in FUNCTION_WORDS and w not in OBJ_STOP}


def _quote_in_sheet(quote: str, sheet_norm: str) -> bool:
    """A quote counts when, after case and punctuation are normalised, it is in the sheet, or a run of 3 consecutive words of it is (fewer when the quote is shorter);
    a quote cut with an ellipsis counts by its parts."""
    for part in re.split(r"\.\.\.|\u2026", str(quote or "")):
        words = _norm(part).split()
        if not words:
            continue
        n = min(3, len(words))
        if _norm(part) in sheet_norm or any(" ".join(words[k:k + n]) in sheet_norm for k in range(len(words) - n + 1)):
            if len(" ".join(words)) >= 5:
                return True
    return False


def _tie_words(text: str, card: Optional[dict] = None) -> set:
    """Content words of a phrase for the tie check, plus the person's hometown words (a town name counts at any length)."""
    out = _cw(text)
    if card:
        town = {w.lower() for w in re.findall(r"[A-Za-z\u02bb']{3,}", str(card.get("hometown") or ""))}
        out |= {w for w in _norm(text).split() if w in town}
    return out


def tie_ok(card: dict, where: str, tie: str) -> str:
    """'' when the tie holds, else the code. It holds when a quoted phrase really is in the sheet AND the place is tied to it: the quote shares a word with the place,
    or (a paraphrase) the tie sentence and the place share 2 or more content words."""
    sheet_norm = _norm(_sheet_text(card))
    quotes = [q for q in re.findall(r"[\"\u201c]([^\"\u201d]{4,})[\"\u201d]", str(tie or "")) if _quote_in_sheet(q, sheet_norm)]
    if not quotes:
        return "no-place-tie"
    if any(_tokens(q) & _tokens(where) for q in quotes):
        return ""
    if len(_tie_words(tie, card) & _tie_words(where, card)) >= 2:
        return ""
    return "place-not-tied"


def repair_tie(card: dict, where: str) -> str:
    """A tie built from the sheet itself: the clause of the biography or identity that shares the most words with the place (a town name counts), quoted exactly.
    '' when no clause shares any word."""
    best, best_n = "", 0
    for text in (card.get("biography"), card.get("identityConcept"), card.get("hometown")):
        for clause in re.split(r"(?<=[.;:!?])\s+|,\s+(?=[a-z])", str(text or "")):
            clause = clause.strip().rstrip(".")
            if len(clause) < 8 or len(clause) > 160:
                continue
            n = len(_tie_words(clause, card) & _tie_words(where, card))
            if n > best_n:
                best, best_n = clause, n
    if best_n < 1:
        return ""
    return f'"{best}"'


def _tokens(t: str) -> set:
    return {w for w in _norm(t).split() if len(w) >= 5}


def clean_brief(raw) -> Optional[dict]:
    """The brief with every field a clean string (inFrame a list of two), or None when it is not a usable object."""
    if not isinstance(raw, dict):
        return None
    out: dict = {}
    for k in FIELDS:
        v = raw.get(k)
        if k == "inFrame":
            if isinstance(v, str):
                v = [x.strip() for x in re.split(r"[;\n]|,\s+and\s+|\s+and\s+", v) if x.strip()]
            if not isinstance(v, list):
                continue
            items = [re.sub(r"\s+", " ", x).strip() for x in v if isinstance(x, str) and x.strip()]
            if items:
                out[k] = items
        elif k == "jobHints":
            if isinstance(v, list):
                out[k] = [re.sub(r"\s+", " ", x).strip() for x in v if isinstance(x, str) and x.strip()]
        elif isinstance(v, str) and v.strip():
            out[k] = re.sub(r"\s+", " ", v).strip()
    return out or None


def _sheet_text(card: dict) -> str:
    s = sheet_of(card)
    return " ".join(str(v) for v in (s["biography"], s["identity"], s["demeanor"], s["voice"], s["castingType"], s["onCamera"], s["style"], s["hometown"], s["job"], " ".join(s["wardrobe"]), s.get("lookSignature", "")))


_CLAUSE_SPLIT = re.compile(r"(?<=[,;])\s+")


def _trim(text: str, limit: int) -> str:
    """Cut at the last clause boundary (comma, semicolon, ' and ') within the limit, else at a word."""
    t = str(text or "").strip().rstrip(".;, ")
    if len(t) <= limit:
        return t
    cut = max((t.rfind(x, 0, limit) for x in (", ", "; ", " and ", " with ", " while ")), default=-1)
    if cut >= int(limit * 0.45):
        return t[:cut].rstrip(" ,;")
    return t[:limit].rsplit(" ", 1)[0].rstrip(" ,;")


def _drop_clauses(text: str, rx) -> str:
    parts = [p for p in re.split(r"\s*[,;]\s*", str(text or "")) if p.strip()]
    kept = [p for p in parts if not rx.search(p)]
    return ", ".join(kept)


HELDABLE_RE = re.compile(r"\b(?:gloves?|hats?|caps?|beanies?|boots?|shoes?|sneakers?|helmets?|scarf|scarves|aprons?|jackets?|coats?)\b", re.I)
HELD_RE = re.compile(r"\b(?:by the|hanging|hung|held|holding|slung|draped|tossed|lying|resting|propped|pair of|boxing|on a (?:hook|nail|peg|rack|shelf|hanger)|on the (?:hook|nail|peg|rail|post|bench|step|table|fence|shelf)|beside|next to|in (?:her|his|their) hands?)\b", re.I)


def _worn_like(item: str) -> bool:
    """A garment or accessory the person wears. A heldable thing (gloves, a hat, boots, a helmet) that is held, hung up or set down is an object, not clothing."""
    m = CLOTHING_RE.search(item)
    if not m:
        return False
    if HELDABLE_RE.fullmatch(m.group(0)) and HELD_RE.search(item) and not re.search(r"\b(?:wearing|worn|on (?:her|his|their) (?:head|hands|feet))\b", item, re.I):
        return False
    return True


def _obj_tokens(text: str) -> set:
    """The significant words of an object or signature (singular, no common adjectives), for the cast-wide 'one person only' rule."""
    out = set()
    for w in _norm(text).split():
        if len(w) >= 5 and w not in OBJ_STOP:
            out.add(w[:-1] if w.endswith("s") and not w.endswith("ss") else w)
    return out


def _needs_layer(anchors: Optional[dict]) -> bool:
    """Cold, wet or windy weather, or an autumn or winter day that is not hot: a real person wears a layer."""
    a = anchors or {}
    weather = str(a.get("weather") or "")
    if COLD_WET_RE.search(weather):
        return True
    return str(a.get("season") or "") in ("autumn", "winter") and not HOT_RE.search(weather)


def repair_brief(card: dict, brief: Optional[dict], anchors: Optional[dict] = None) -> Optional[dict]:
    """Deterministic repair before the checks (it never leaves a field empty that a check then rejects): strip trailing periods, take the person's name out, drop a
    clause that shows work gear, text, a brand or sunglasses, drop a clause about the body from the clothes and the signature, move a worn accessory (earrings, nails,
    a chain) out of the objects into the clothes, drop an object that is a garment or repeats the clothes or the signature, trim over-long fields at a clause boundary,
    and add a layer from the person's own style when the weather is cold or wet and their clothes do not fit it."""
    if not brief:
        return brief
    out = dict(brief)
    names = [p for p in re.split(r"\s+", str(card.get("name") or "")) if len(p) >= 3]
    def fix(text: str) -> str:
        t = str(text or "").strip()
        for n in names:
            t = re.sub(r"\b%s(?:['\u2019]s)?\b" % re.escape(n), "the person", t)
        return t.rstrip(". ")
    for k in ("where", "doing", "wear", "signature", "timeLight", "expressionBody", "why", "tie"):
        if isinstance(out.get(k), str):
            out[k] = fix(out[k])
    if isinstance(out.get("inFrame"), list):
        out["inFrame"] = [fix(x) for x in out["inFrame"] if isinstance(x, str)]
    class _Bad:
        @staticmethod
        def search(t):
            return WORK_GEAR_RE.search(t) or TEXT_RE.search(t) or BRAND_RE.search(t) or SUNGLASSES_RE.search(t)
    bad_rx = _Bad()
    for k in ("where", "doing", "wear", "signature", "expressionBody"):
        if isinstance(out.get(k), str) and bad_rx.search(out[k]):
            out[k] = _drop_clauses(out[k], bad_rx) or out[k]
    # the clothes line is clothes only, the signature is a thing: a clause about the body (arms, shoulders, chin, eyes, smile ...) is dropped
    for k in ("wear", "signature"):
        if k == "signature" and out.get("_look"):
            continue
        if isinstance(out.get(k), str) and BODY_RE.search(out[k]):
            kept = _drop_clauses(re.sub(r"\s+and\s+(?=(?:a|an|the|his|her|their)?\s*(?:arms?|shoulders?|chin|eyes?|dimples?|hands|gaze)\b)", ", ", out[k], flags=re.I), BODY_RE)
            if kept:
                out[k] = kept
    # the face line is the face only: a clause about arms, hands, legs or posture is dropped (doing says the body, once)
    if isinstance(out.get("expressionBody"), str):
        kept = _drop_clauses(out["expressionBody"], BODY_PART_RE)
        if kept:
            out["expressionBody"] = kept
        else:
            out.pop("expressionBody", None)
    wear = str(out.get("wear") or "")
    wear_words = _cw(wear)
    # the signature: gone (not refilled by guessing) when it only repeats what is worn
    sig = str(out.get("signature") or "")
    if sig:
        sw = _cw(sig)
        if CLOTHING_RE.search(sig) and sw & wear_words and not out.get("_look"):
            sig = ""
    # the objects: a worn accessory joins the clothes; a garment, a repeat of the clothes or of the signature is dropped
    objects, moved = [], []
    for item in (out.get("inFrame") or []):
        if bad_rx.search(item):
            continue
        iw = _cw(item)
        if ACCESSORY_RE.search(item) and not HELDABLE_RE.search(item) and not (iw & wear_words):
            moved.append(item)
        elif (ACCESSORY_RE.search(item) and not HELDABLE_RE.search(item)) or _worn_like(item) or (iw & wear_words) or (sig and _obj_tokens(item) & _obj_tokens(sig)):
            continue
        else:
            objects.append(item)
    if moved:
        wear = f"{wear}, " + ", ".join(m.rstrip(". ") for m in moved) if wear else ", ".join(moved)
    # a worn signature is part of the clothes (compose says it once): it is not an object either
    if sig and CLOTHING_RE.search(sig) and not (_cw(sig) & wear_words):
        pass
    out["wear"] = wear
    out["inFrame"] = objects[:2]
    if sig:
        out["signature"] = sig
    else:
        out.pop("signature", None)
    # the weather: cold or wet and the clothes do not fit it: a layer from their own style, as a real person would
    if anchors and _needs_layer(anchors) and out.get("wear") and not LAYER_RE.search(out["wear"]):
        wardrobe = [w for w in ((card.get("physicalCharacteristics") or {}).get("wardrobe") or []) if isinstance(w, str) and LAYER_RE.search(w)]
        out["wear"] = f"{out['wear']}, with {wardrobe[0].strip().rstrip('.')} over it" if wardrobe else f"{out['wear']}, with a plain overshirt over it"
    for k, lim in LIMITS.items():
        if k != "why" and isinstance(out.get(k), str):
            out[k] = _trim(out[k], lim)
    out["inFrame"] = [_trim(x, IN_FRAME_ITEM_MAX) for x in out["inFrame"]]
    # the tie: when it does not hold, built from the sheet itself (the clause closest to the place), never sent to the floor for it
    if out.get("where") and (not out.get("tie") or tie_ok(card, out["where"], out["tie"])):
        t = repair_tie(card, out["where"])
        if t:
            out["tie"] = t
    return out


def check_brief(card: dict, anchors: dict, brief: Optional[dict]) -> list:
    """The reason codes a brief fails with (empty = accepted)."""
    if not brief:
        return ["missing"]
    codes: list = []
    for k in REQUIRED:
        if not brief.get(k):
            codes.append(f"missing-{k}")
    if codes:
        return codes
    brief = {**brief, "signature": brief.get("signature") or "", "expressionBody": brief.get("expressionBody") or ""}
    look = bool(brief.get("_look"))
    if not 1 <= len(brief["inFrame"]) <= 2:
        codes.append("inframe-count")
    for k, lim in LIMITS.items():
        if len(brief[k]) > lim:
            codes.append(f"too-long-{k}")
    if any(len(x) > IN_FRAME_ITEM_MAX for x in brief["inFrame"]):
        codes.append("too-long-inFrame")
    body = " ".join([brief["where"], brief["doing"], brief["wear"], brief["signature"], brief["timeLight"], brief["expressionBody"], " ".join(brief["inFrame"])])
    name_parts = [p for p in re.split(r"\s+", str(card.get("name") or "")) if len(p) >= 3]
    if any(re.search(r"\b%s\b" % re.escape(p), body, re.I) for p in name_parts):
        codes.append("name-leak")
    if ACTED_RE.search(" ".join([brief["doing"], brief["expressionBody"], " ".join(brief["inFrame"])])):
        codes.append("acted-or-odd-pose")
    if OPEN_PALM_RE.search(brief["doing"] + " " + brief["expressionBody"]) and not TALKING_RE.search(brief["doing"] + " " + brief["expressionBody"]):
        codes.append("open-palm-to-nobody")
    if WORK_GEAR_RE.search(body):
        codes.append("work-gear")
    if TEXT_RE.search(body) or BRAND_RE.search(body):
        codes.append("text-or-brand")
    if SUNGLASSES_RE.search(brief["wear"] + " " + brief["signature"]):
        codes.append("sunglasses")
    indoor = bool(INDOOR_RE.search(brief["where"])) and not OUTDOOR_RE.search(brief["where"])
    if indoor and HAT_RE.search(brief["wear"] + " " + ("" if look else brief["signature"])):
        codes.append("hat-indoors")
    where = brief["where"].strip()
    if GENERIC_WHERE.match(where) or len(where.split()) < 5:
        codes.append("generic-place")
    # the place is from THIS person's life: it shares a content word with the sheet, AND the writer names the tie: a quoted phrase of the sheet that the place comes
    # from (home, family, hobby, a hometown routine, next to their work), which must really be in the sheet and share a word with the place
    elif not (_tokens(where) & _tokens(_sheet_text(card))):
        codes.append("place-not-from-sheet")
    else:
        tie_code = tie_ok(card, where, brief["tie"])
        if tie_code:
            codes.append(tie_code)
    # the clothes sentence holds clothes only; the signature is a thing, not a pose and not a repeat of what is worn
    if BODY_RE.search(brief["wear"]):
        codes.append("body-in-wear")
    if BODY_RE.search(brief["signature"]) and not look:
        codes.append("body-in-signature")
    wear_words = _cw(brief["wear"])
    sig_words = _cw(brief["signature"])
    if sig_words and CLOTHING_RE.search(brief["signature"]) and (sig_words & wear_words) and not look:
        codes.append("signature-repeats-wear")
    if _needs_layer(anchors) and not LAYER_RE.search(brief["wear"]):
        codes.append("weather-layer")
    # the two own objects are things from their life in this place: not clothing they wear, and not the signature item again
    worn = _tokens(brief["wear"]) | wear_words
    sig = _tokens(brief["signature"])
    for item in brief["inFrame"]:
        it = _tokens(item) | _cw(item)
        if (it & worn) or (_tokens(item) & sig) or _worn_like(item) or (ACCESSORY_RE.search(item) and not HELDABLE_RE.search(item)):
            codes.append("inframe-worn-or-signature")
            break
    # at most ONE object (of the two in the frame and the signature) may hint at the job, by the writer's own list or by a word of the job title
    if anchors.get("facet") != NEAR_WORK:
        job_words2 = {w for w in _norm(str(card.get("vocation") or "")).split() if len(w) >= 5 and w not in FUNCTION_WORDS and w not in OBJ_STOP}
        listed = {_norm(x) for x in (brief.get("jobHints") or [])}
        things = list(brief["inFrame"]) + ([brief["signature"]] if brief["signature"] and not look else [])
        hinting = [t for t in things if _norm(t) in listed or (job_words2 & _tokens(t))]
        if len(hinting) >= 2:
            codes.append("job-objects")
    # the job is not a caption (unless the facet is near work)
    job = str(card.get("vocation") or "")
    if job and anchors.get("facet") != NEAR_WORK:
        job_words = {w for w in _norm(job).split() if len(w) >= 5 and w not in ("night", "head", "manager", "assistant", "senior", "junior", "small", "local", "county", "commercial", "league", "community", "college", "academic", "recreation", "family", "service", "services", "general", "associate", "assistant", "director", "specialist", "coordinator")}
        head = re.split(r"\b(?:near|beside|across|next to|down the street|outside|by|behind|from|along|close to)\b", brief["where"], 1)[0]
        if job_words and (job_words & _tokens(head + " " + brief["doing"])):        # the place IS the workplace, or the action is the job: a home or a park near it is fine
            codes.append("job-caption")
    # the trace: a quoted phrase that really is in the sheet
    quotes = [q for q in re.findall(r"[\"\u201c]([^\"\u201d]{5,})[\"\u201d]", brief["why"]) if q.strip()]
    sheet = _norm(_sheet_text(card))
    if not any(_quote_in_sheet(q, sheet) for q in quotes):
        codes.append("no-sheet-quote")
    return codes


def _place_kind(where: str) -> str:
    for kind, rx in PLACE_KINDS:
        if re.search(rx, where, re.I):
            return kind
    return "other"


def _time_bucket(t: str) -> str:
    low = str(t).lower()
    for b, rx in (("morning", r"morning|sunrise|dawn"), ("afternoon", r"afternoon"), ("noon", r"\bnoon\b|midday"), ("evening", r"dusk|evening|blue hour|lamp|night"), ("golden", r"golden|sunset")):
        if re.search(rx, low):
            return b
    return "other"


def check_cast(cards: list, anchors: dict, briefs: dict, relax: int = 0) -> dict:
    """Cast-level reason codes per id (the LATER brief of a clash is the offender): a place kind or a time bucket or a gesture family beyond its cap, the near-work count, dark tops."""
    out: dict = {}
    ids = [str(c["id"]) for c in cards if isinstance(c, dict) and c.get("id")]
    kinds: dict = {}
    times: dict = {}
    gest: dict = {}
    dark = 0
    near = 0
    objs_seen: set = set()
    for i in sorted(ids, key=lambda x: [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", x)]):
        b = briefs.get(i)
        if not b:
            continue
        code: list = []
        k = _place_kind(b["where"])
        kinds[k] = kinds.get(k, 0) + 1
        if k != "other" and kinds[k] > PLACE_KIND_MAX + relax:
            code.append("place-kind-repeat")
        tb = _time_bucket(b["timeLight"])
        times[tb] = times.get(tb, 0) + 1
        if tb != "other" and times[tb] > TIME_BUCKET_MAX + relax:
            code.append("light-repeat")
        for fam, rx in GESTURES:
            if re.search(rx, b["doing"] + " " + b["expressionBody"], re.I):
                gest[fam] = gest.get(fam, 0) + 1
                if gest[fam] > GESTURE_MAX + relax:
                    code.append(f"gesture-repeat-{fam}")
        first_garment = (b["wear"].split(",")[0] if b["wear"] else "")
        if DARK_TOP_RE.search(first_garment):
            dark += 1
            if dark > DARK_MAX + relax:
                code.append("dark-palette")
        obj_toks = _obj_tokens(" ".join(b.get("inFrame") or []))
        sig_toks = _obj_tokens(str(b.get("signature") or ""))
        foreign_look: set = set()
        for j, bj in briefs.items():
            if j != i and bj and bj.get("_look") and bj.get("signature"):
                foreign_look |= _obj_tokens(str(bj["signature"]))
        # a card's own signature is never the offender: the later person's OBJECTS change instead
        if (obj_toks & (objs_seen | foreign_look)) or (not b.get("_look") and sig_toks & (objs_seen | foreign_look)):
            code.append("object-repeat")
        objs_seen |= obj_toks | sig_toks
        if anchors.get(i, {}).get("facet") == NEAR_WORK or re.search(r"near (?:where )?(?:they|he|she) work|outside (?:the |their )work", b["where"], re.I):
            near += 1
            if near > NEAR_WORK_MAX:
                code.append("near-work-count")
        if code:
            out[i] = code
    return out


# ---------------------------------------------------------------------------------------------------- the editor pass
EDITOR_SYSTEM = SYSTEM + (
    "\nYou are now the EDITOR. You get only the people whose briefs failed a check, each with their sheet, their anchors, the codes that failed, and the briefs "
    "of the people already accepted (so you can differ from them). Rewrite each failing brief in full, fixing every code. For each person under 'complete', keep the brief as it is "
    "and give back the same JSON shape with the missing parts added (a second object, a signature), different from everything in 'alreadyUsed'. Answer with the same JSON shape keyed by id, "
    "only for the people given."
)


def missing_parts(brief: Optional[dict]) -> list:
    """What an accepted brief still lacks: a second object, a signature."""
    if not brief:
        return []
    out = []
    if len(brief.get("inFrame") or []) < 2:
        out.append("one more object of theirs in the frame")
    if not brief.get("signature"):
        out.append("a signature object or detail")
    return out


def build_editor_messages(cards: list, anchors: dict, briefs: dict, failures: dict, complete: Optional[dict] = None) -> list:
    by_id = {str(c["id"]): c for c in cards if isinstance(c, dict) and c.get("id")}
    def scrubbed(i: str):
        b = briefs.get(i)
        name = str(by_id[i].get("name") or "")
        return None if not b else {k: ([_scrub(x, name) for x in v] if isinstance(v, list) else _scrub(v, name)) for k, v in b.items()}
    bad = {i: {**sheet_of(by_id[i]), "anchors": anchors.get(i, {}), "failedCodes": codes, "whatToFix": _explain(codes), "previousBrief": scrubbed(i)} for i, codes in failures.items() if i in by_id}
    top = {i: {**sheet_of(by_id[i]), "anchors": anchors.get(i, {}), "keep": scrubbed(i), "needs": need} for i, need in (complete or {}).items() if i in by_id}
    kept = {i: {"where": b["where"], "wear": b["wear"], "timeLight": b["timeLight"]} for i, b in briefs.items() if i not in failures and i not in (complete or {}) and b}
    payload = {"rewrite": bad, "alreadyAccepted": kept, "alreadyUsed": used_summary({i: b for i, b in briefs.items() if i not in failures}), "maxCharacters": LIMITS}
    if top:
        payload["complete"] = top
    return [{"role": "system", "content": EDITOR_SYSTEM}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}]


async def _call(llm_fn: LlmFn, messages: list, ledger: list, kind: str) -> dict:
    try:
        text = await llm_fn(messages)
    except Exception as e:  # failsoft-ok: best-effort-enrichment (no brief: the floor shot card stands)
        logger.info(f"[photo-brief] {kind} call failed: {type(e).__name__}")
        ledger.append({"kind": kind, "ok": False})
        return {}
    ledger.append({"kind": kind, "ok": True})
    try:
        from src import orwell_cast_authoring as A
        obj = A._extract_json(text or "") or {}
    except Exception:
        obj = {}
    return obj if isinstance(obj, dict) else {}


def _objects_of(raw: dict, i: str) -> list:
    """The object phrases the objects ask returned for `i`, whatever the shape: a list of strings, a list of {object/name/item} dicts, or an {inFrame|objects: [...]} dict."""
    got = _find_any(raw, i)
    if isinstance(got, dict):
        for k in ("inFrame", "objects", "items", "needObjects"):
            if isinstance(got.get(k), list):
                got = got[k]
                break
    if isinstance(got, str):
        got = [x.strip() for x in re.split(r"[;\n]", got) if x.strip()]
    if not isinstance(got, list):
        return []
    out = []
    for x in got:
        if isinstance(x, dict):
            x = next((x[k] for k in ("object", "name", "item", "phrase", "text") if isinstance(x.get(k), str)), "")
        if isinstance(x, str) and x.strip():
            out.append(x.strip())
    return out


def _find_any(obj, i: str):
    """Like `_find` but returns lists and strings too, and looks under 'needObjects' / 'objects' wrappers."""
    if not isinstance(obj, dict):
        return None
    num = re.sub(r"\D", "", i)
    for layer in (obj, *[obj.get(k) for k in ("needObjects", "objects", "rewrite", "briefs", "results") if isinstance(obj.get(k), dict)]):
        for key in (i, i.replace(":", "_"), num, f"npc{num}", f"npc-{num}"):
            if key in layer and layer[key] is not None:
                return layer[key]
    return None


def _find(obj: dict, i: str):
    """The brief of `i` in a writer or editor reply, whatever the wrapping or id spelling (npc:3, npc_3, 3, under rewrite / briefs / cast / results)."""
    if not isinstance(obj, dict):
        return None
    num = re.sub(r"\D", "", i)
    for layer in (obj, *[obj.get(k) for k in ("rewrite", "briefs", "cast", "results", "rewrites") if isinstance(obj.get(k), dict)]):
        for key in (i, i.replace(":", "_"), num, f"npc{num}", f"npc-{num}"):
            if isinstance(layer.get(key), dict):
                return layer[key]
    return None


def look_signature(card: dict) -> str:
    """The authored per-person `physicalCharacteristics.lookSignature` (one thing that makes them memorable, at most 90 characters), when the card has one."""
    phys = card.get("physicalCharacteristics") if isinstance(card.get("physicalCharacteristics"), dict) else {}
    v = phys.get("lookSignature")
    return re.sub(r"\s+", " ", v).strip().rstrip(".")[:90] if isinstance(v, str) and v.strip() else ""


def _prepare(card: dict, raw, anchors: dict) -> Optional[dict]:
    """A writer or editor reply for one person, made a brief: cleaned, the card's own lookSignature used as the signature when it has one, then repaired."""
    b = clean_brief(raw)
    ls = look_signature(card)
    if b and ls:
        b["signature"] = ls
        b["_look"] = True          # the card's own signature: never dropped, never printed twice, exempt from the worn-repeat and hat-indoors rules
    return repair_brief(card, b, anchors)


CALM_DOING = "paused from what they were doing, standing upright with their hands at rest"


def calm_brief(brief: dict) -> dict:
    """The deterministic last repair for an acted or odd pose: the person pauses from the activity and stands with hands at rest; the face line stays."""
    out = dict(brief)
    out["doing"] = CALM_DOING
    return out


def _drop_used(brief: dict, seen: set) -> dict:
    """Drop the objects and the signature that another person already has (never the last thing standing, never the place)."""
    out = dict(brief)
    objs = [x for x in out.get("inFrame") or [] if not (_obj_tokens(x) & seen)]
    out["inFrame"] = objs or (out.get("inFrame") or [])[:1]
    if out.get("signature") and not out.get("_look") and _obj_tokens(out["signature"]) & seen:
        out.pop("signature", None)
    return out


def _natural(ids: list) -> list:
    return sorted(ids, key=lambda x: [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", x)])


OBJECTS_SYSTEM = (
    "You give a person's missing objects for a cast photo. For each person you get their sheet, the objects they already have in the frame, how many more are needed, "
    "and a list of things 'notAnyOf' that other people already have or that are clothes. Answer with JSON only: an object keyed by the person's id, each value an array of the "
    "requested number of short object phrases: things of THEIRS in the place they are photographed, taken from their sheet; not clothes, not jewellery, not anything worn, "
    "and not anything in notAnyOf or like it."
)


async def _objects_pass(cards: list, anchors: dict, accepted: dict, llm_fn: LlmFn, ledger: list, diag: Optional[dict] = None) -> int:
    """One targeted ask for the people left with fewer than two objects: 'give a different object, not any of: ...'. Returns how many objects landed."""
    by_id = {str(c["id"]): c for c in cards}
    need = {i: 2 - len(b.get("inFrame") or []) for i, b in accepted.items() if len(b.get("inFrame") or []) < 2}
    if not need:
        return 0
    taken = used_summary(accepted)
    avoid = sorted({*taken["objects"], *taken["signatures"]})
    payload = {i: {**sheet_of(by_id[i]), "anchors": anchors.get(i, {}), "alreadyInFrame": accepted[i].get("inFrame") or [], "needCount": n,
                   "notAnyOf": avoid + [accepted[i].get("wear", ""), str(accepted[i].get("signature") or "")]} for i, n in need.items() if i in by_id}
    raw = await _call(llm_fn, [{"role": "system", "content": OBJECTS_SYSTEM}, {"role": "user", "content": json.dumps({"needObjects": payload}, ensure_ascii=False)}], ledger, "objects")
    if diag is not None:
        diag["raw"] = raw
    landed = 0
    for i in need:
        got = _objects_of(raw, i)
        if not got:
            if diag is not None:
                diag.setdefault("why", {})[i] = "no-usable-reply"
            continue
        b = accepted[i]
        wear_words = _cw(b.get("wear") or "")
        seen = set()
        for j, bj in accepted.items():
            if j != i:
                seen |= _obj_tokens(" ".join(bj.get("inFrame") or []) + " " + str(bj.get("signature") or ""))
        seen |= _obj_tokens(str(b.get("signature") or ""))
        objs = list(b.get("inFrame") or [])
        for item in got:
            item = _trim(re.sub(r"\s+", " ", str(item)).strip(), IN_FRAME_ITEM_MAX)
            toks = _obj_tokens(item)
            iw = _cw(item)
            why = ("empty" if not item else "full" if len(objs) >= 2 else "clothing" if _worn_like(item) else "worn-accessory" if (ACCESSORY_RE.search(item) and not HELDABLE_RE.search(item))
                   else "repeats-the-clothes" if iw & wear_words else "work-gear" if WORK_GEAR_RE.search(item) else "text-or-brand" if (TEXT_RE.search(item) or BRAND_RE.search(item))
                   else "no-noun" if not toks else "used-by-another" if toks & seen else "repeats-own" if toks & _obj_tokens(" ".join(objs)) else "")
            if why:
                if diag is not None:
                    diag.setdefault("why", {}).setdefault(i, []).append(f"{why}: {item[:40]}")
                continue
            objs.append(item)
            seen |= toks
            landed += 1
        accepted[i] = {**b, "inFrame": objs}
    return landed


async def author_briefs(cards: list, llm_fn: LlmFn, seed=0, batches: int = 2) -> dict:
    """The whole pipeline for a cast: anchors; the writer in `batches` sequential calls (each one sees what the earlier ones used); the per-brief checks after a deterministic
    repair; ONE editor pass for the offenders and the incomplete (a second object, a signature); the cast-wide 'one person only' rule for objects, signatures and places;
    the floor for the rest. Returns ``{briefs, floor, anchors, rejected, calls, rewritten, raw}`` (``briefs`` holds only accepted ones)."""
    cards = [c for c in (cards or []) if isinstance(c, dict) and c.get("id")]
    ids = _natural([str(c["id"]) for c in cards])
    by_id = {str(c["id"]): c for c in cards}
    anchors = deal_anchors(cards, seed)
    ledger: list = []
    rejected: dict = {}
    raws: list = []

    def tally(codes_by_id: dict) -> None:
        for codes in codes_by_id.values():
            for c in codes:
                rejected[c] = rejected.get(c, 0) + 1

    n_batches = batches if len(ids) >= 8 and batches > 1 else 1
    size = -(-len(ids) // n_batches)
    briefs: dict = {}
    failures: dict = {}
    accepted: dict = {}
    for k in range(n_batches):
        part = ids[k * size:(k + 1) * size]
        if not part:
            continue
        raw = await _call(llm_fn, build_messages([by_id[i] for i in part], anchors, used_summary(accepted)), ledger, "writer")
        raws.append(raw)
        for i in part:
            briefs[i] = _prepare(by_id[i], _find(raw, i), anchors[i])
            codes = check_brief(by_id[i], anchors[i], briefs[i])
            if not codes:
                codes = check_cast(cards, anchors, {**accepted, i: briefs[i]}).get(i, [])
            if codes:
                failures[i] = codes
            else:
                accepted[i] = briefs[i]
    tally(failures)
    last_codes: dict = {i: list(c) for i, c in failures.items()}
    complete = {i: missing_parts(b) for i, b in accepted.items() if missing_parts(b)}
    rewritten = 0
    calmed = 0
    fixed: dict = {}
    if failures or complete:
        fixed = await _call(llm_fn, build_editor_messages(cards, anchors, {**{i: b for i, b in briefs.items() if b}, **accepted}, failures, complete), ledger, "editor")
        seen_before = lambda i, extra=None: set().union(*[_obj_tokens(" ".join(b.get("inFrame") or []) + " " + str(b.get("signature") or "")) for j, b in accepted.items() if j != i])  # noqa: E731
        for i in list(failures):
            nb = _prepare(by_id[i], _find(fixed, i), anchors[i])
            if not nb:
                rejected["editor-unusable"] = rejected.get("editor-unusable", 0) + 1
                last_codes[i] = [c for c in (last_codes.get(i) or []) if not c.startswith("editor")] + ["editor-unusable"]
                continue
            codes = check_brief(by_id[i], anchors[i], nb)
            if not codes:
                trial = {**accepted, i: nb}
                codes = check_cast(cards, anchors, trial).get(i, [])
                if codes and set(codes) <= {"object-repeat"}:       # a clash of objects is repaired by dropping the repeated ones, not by the floor
                    nb = _drop_used(nb, seen_before(i))
                    codes = check_brief(by_id[i], anchors[i], nb) or check_cast(cards, anchors, {**accepted, i: nb}).get(i, [])
            if not codes:
                accepted[i] = nb
                rewritten += 1
            else:
                tally({i: codes})
                last_codes[i] = [c for c in (last_codes.get(i) or []) if not c.startswith("editor")] + [f"editor:{c}" for c in codes]
        # every deterministic repair is applied on its own, then the brief is checked again: an acted pose becomes a calm one, a tie is built from the sheet,
        # a repeated object is dropped, a cast cap is relaxed by one; a person is on the floor only for what cannot be repaired (a generic place, not from the sheet, work gear ...)
        FIXABLE = {"acted-or-odd-pose", "no-place-tie", "place-not-tied", "object-repeat", "place-kind-repeat", "light-repeat", "dark-palette", "near-work-count"}
        for i in list(failures):
            if i in accepted:
                continue
            allc = {c.replace("editor:", "") for c in (last_codes.get(i) or [])} | set(failures.get(i, []))
            base = _prepare(by_id[i], _find(fixed, i), anchors[i]) or briefs.get(i)
            if not base:
                continue
            cand = dict(base)
            if (allc & {"acted-or-odd-pose"}) or ACTED_RE.search(" ".join([str(cand.get("doing") or ""), str(cand.get("expressionBody") or "")])):
                cand = calm_brief(cand)
            if cand.get("where") and tie_ok(by_id[i], cand["where"], cand.get("tie") or ""):
                t = repair_tie(by_id[i], cand["where"])
                if t:
                    cand["tie"] = t
            seen = seen_before(i)
            if _obj_tokens(" ".join(cand.get("inFrame") or [])) & seen:
                cand = _drop_used(cand, seen)
            codes = check_brief(by_id[i], anchors[i], cand) or check_cast(cards, anchors, {**accepted, i: cand}, relax=1).get(i, [])
            if not codes:
                accepted[i] = cand
                rewritten += 1
                calmed += 1
            else:
                last_codes[i] = [c for c in (last_codes.get(i) or []) if not c.startswith("final:")] + [f"final:{c}" for c in codes]
        for i in complete:                                          # a top-up: only an improvement is kept, an accepted brief is never lost
            nb = _prepare(by_id[i], _find(fixed, i), anchors[i])
            if nb and len(missing_parts(nb)) < len(missing_parts(accepted[i])) and not check_brief(by_id[i], anchors[i], nb) \
                    and not check_cast(cards, anchors, {**accepted, i: nb}).get(i):
                accepted[i] = nb
    # one targeted ask for everyone left with fewer than two objects (a repeat dropped, a garment dropped)
    objects_landed = 0
    obj_diag: dict = {}
    if accepted and any(len(b.get("inFrame") or []) < 2 for b in accepted.values()):
        objects_landed = await _objects_pass(cards, anchors, accepted, llm_fn, ledger, obj_diag)
    floor = [i for i in ids if i not in accepted]
    floor_reasons = {i: (last_codes.get(i) or ["no-reply"]) for i in floor}
    one_object = [i for i, b in accepted.items() if len(b.get("inFrame") or []) < 2]
    logger.info(f"[photo-brief] {len(ids)} briefs: accepted {len(ids) - len(floor) - rewritten}, rewritten {rewritten}, floor {len(floor)} {json.dumps(floor_reasons, sort_keys=True)}; "
                f"rejected by code {json.dumps(rejected, sort_keys=True)}; calmed {calmed}; objects landed {objects_landed}, one object left on {len(one_object)} {json.dumps(obj_diag.get('why') or {}, sort_keys=True)}; writer calls {len(ledger)}")
    return {"briefs": accepted, "floor": floor, "floorReasons": floor_reasons, "anchors": anchors, "rejected": rejected, "calls": len(ledger), "rewritten": rewritten,
            "objectsLanded": objects_landed, "oneObject": one_object, "calmed": calmed, "objectsWhy": obj_diag.get("why"),
            "raw": {"writer": raws, "editor": fixed or None, "objects": obj_diag.get("raw")}}


# ---------------------------------------------------------------------------------------------------- the prompt
_SPAN_RE = re.compile(r"Wearing .*?(?=Framing, the same for the whole series:)", re.S)
CLOTHES_CLAUSE = "in their own everyday clothes and never a uniform, scrubs, apron, badge or work gear"


def _sentence(t: str) -> str:
    x = re.sub(r"[\s.]+$", "", str(t or "").strip())
    return f"{x}." if x else ""


HAIR_SIG_RE = re.compile(r"\b(?:hair|braids?|locs|dreads?|curls?|curly|waves?|wavy|bun|ponytail|pigtails|afro|fade|buzz\w*|bob|bangs|fringe|twist\w*|updo|mohawk|shaved head|bald|pompadour|undercut)\b", re.I)


def is_hair_signature(sig: str) -> bool:
    return bool(sig) and bool(HAIR_SIG_RE.search(sig))


def _lc(text: str, proper: Optional[set] = None) -> str:
    """Lower-case the first letter for a mid-sentence start, unless the first word is a proper name (a word of the hometown)."""
    t = str(text or "").strip()
    if len(t) < 2 or not t[0].isupper() or t[1].isupper():
        return t
    first = re.split(r"[\s,;]+", t)[0].strip(".").lower()
    if proper and first in proper:
        return t
    return t[0].lower() + t[1:]


def proper_words(card: Optional[dict]) -> set:
    """Words that stay capitalised mid-sentence: those of the person's hometown."""
    return {w.lower() for w in re.findall(r"[A-Za-z\u02bb']+", str((card or {}).get("hometown") or "")) if w}


def brief_sentences(brief: dict, proper: Optional[set] = None) -> str:
    """The brief as the sentences that replace the engine's clothes, setting, light and moment (and prop) sentences. The clothes sentence holds only what is worn;
    the person's own objects (the two in the frame and the signature item) are listed together."""
    lc = lambda t: _lc(t, proper)  # noqa: E731
    wear = str(brief["wear"]).rstrip(". ")
    sig = str(brief.get("signature") or "").rstrip(". ")
    objs = [str(x).rstrip(". ") for x in brief["inFrame"]]
    if is_hair_signature(sig):
        sig = ""           # a hair signature is the Hair sentence (compose_prompt), not clothes and not an object
    if not sig:
        pass
    elif CLOTHING_RE.search(sig):
        # a worn signature (earrings, a patched sleeve) is part of the clothes, said once; anything else is one of their objects
        if brief.get("_look") or not (_cw(sig) & _cw(wear)):
            wear = f"{wear}, and {lc(sig)}"
    else:
        objs.append(sig)
    listed = (", ".join(lc(o) for o in objs[:-1]) + f" and {lc(objs[-1])}") if len(objs) > 1 else (lc(objs[0]) if objs else "")
    return " ".join(s for s in (
        _sentence(f"Wearing {lc(wear)}, {CLOTHES_CLAUSE}"),
        _sentence(f"Setting: {lc(brief['where'])}"),
        _sentence(f"In the frame, theirs: {listed}") if listed else "",
        _sentence(f"Light: {lc(brief['timeLight'])}"),
        _sentence(f"The moment: {lc(str(brief['doing']).rstrip('. '))}" + (f"; {lc(str(brief['expressionBody']).rstrip('. '))}" if brief.get("expressionBody") else "")),
    ) if s)


_LIGHT_RE = re.compile(r"Light: [^.]*\.")


def floor_with_anchors(floor_prompt: str, anchors: Optional[dict]) -> str:
    """The engine's own prompt (the floor) with its Light sentence taken from this person's random anchors (time, weather), so fallbacks do not converge on the
    same few lights. The engine's setting, performance and clothes stay."""
    if not anchors or not isinstance(floor_prompt, str) or not _LIGHT_RE.search(floor_prompt):
        return floor_prompt
    light = _sentence(f"Light: {_lc(anchors.get('time', ''))}, {anchors.get('weather', '')}")
    return _LIGHT_RE.sub(lambda m: light, floor_prompt, count=1)


_FLOOR_MOMENT_RE = re.compile(r"The moment: ([^.]*)\.")


def floor_expression(floor_prompt: str) -> str:
    """The expression of the engine's own moment sentence ("The moment: <expression>; <posture>; <hands>."): only the first part, never its pose."""
    m = _FLOOR_MOMENT_RE.search(floor_prompt or "")
    return m.group(1).split(";")[0].strip() if m else ""


def compose_prompt(floor_prompt: str, brief: Optional[dict], proper: Optional[set] = None) -> str:
    """The final prompt: the engine's prompt with the span from the clothes sentence to the framing sentence replaced by the brief. Without a brief, or when the
    engine's prompt has no such span, the floor prompt stands untouched."""
    if not brief or not isinstance(floor_prompt, str) or not _SPAN_RE.search(floor_prompt):
        return floor_prompt
    face = str(brief.get("expressionBody") or "").strip() or floor_expression(floor_prompt)
    out = _SPAN_RE.sub(lambda m: brief_sentences({**brief, "expressionBody": face}, proper) + " ", floor_prompt, count=1)
    sig = str(brief.get("signature") or "").strip().rstrip(".")
    if is_hair_signature(sig):
        # when the signature is hair it overrides the hair line's styling (a braid cannot come from the activity): the sentence says it and that it holds whatever they are doing
        out = re.sub(r"Hair: .*?(?= Wearing )", lambda m: f"Hair: {sig}, exactly as the sheet says, worn this way whatever the person is doing.", out, count=1, flags=re.S)
    return out


def final_prompt(floor_prompt: str, brief: Optional[dict], anchors: Optional[dict], card: Optional[dict] = None) -> str:
    """The brief when there is one, else the floor with this person's anchored light."""
    return compose_prompt(floor_prompt, brief, proper_words(card)) if brief else floor_with_anchors(floor_prompt, anchors)


# ---------------------------------------------------------------------------------------------------- the production seam
CACHE_FILE = "_photo_briefs.json"
MIN_CAST = 3


def brief_enabled(user) -> bool:
    """The setting `portrait_brief_enabled` (default off until the briefs are approved on real photos)."""
    try:
        from src.settings import get_user_setting
        v = get_user_setting("portrait_brief_enabled", owner=user or "", default=False)
        if isinstance(v, str):
            return v.strip().lower() in ("true", "1", "on", "yes")
        return bool(v)
    except Exception:
        return False


def _cache_path(user):
    from src import orwell_portraits as P
    return P.user_portrait_dir(user) / CACHE_FILE


def _load_cache(user) -> dict:
    try:
        d = json.loads(_cache_path(user).read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _save_cache(user, cache: dict) -> None:
    import os
    import secrets
    try:
        path = _cache_path(user)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except Exception as e:  # failsoft-ok: best-effort-enrichment (an unsaved brief is authored again next time)
        logger.info(f"[photo-brief] cache not saved: {type(e).__name__}")


def _sheet_key(card: dict) -> str:
    return hashlib.sha256(json.dumps(sheet_of(card), sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


async def _roster_cards(user) -> list:
    """The public cards of the cast: the live house, else the warmed pre-season roster."""
    from src import orwell_engine
    state = await orwell_engine.get_game_state(user=user)
    house = [h for h in (state.get("house") or []) if isinstance(h, dict) and h.get("id")] if isinstance(state, dict) else []
    if len(house) >= MIN_CAST:
        return house
    pre = await orwell_engine.pre_seed_cast(user=user)
    return [h for h in ((pre or {}).get("house") or []) if isinstance(h, dict) and h.get("id")]


async def apply_briefs(prompts: list, user, *, llm_fn: Optional[LlmFn] = None, cards: Optional[list] = None, seed=0) -> list:
    """The engine's ``[{houseguestId, name, prompt}]`` with each person's clothes, setting, light and moment sentences replaced by their authored brief.
    Briefs are authored once for the whole cast (when 3 or more people lack one) and cached per user; a single re-shoot reuses the cached brief. Never raises:
    with no writer, a failed call or a failed check the engine's own prompt (the floor) stands."""
    try:
        if not isinstance(prompts, list) or not prompts:
            return prompts
        cache = _load_cache(user)
        ids = [str(e.get("houseguestId") or e.get("id")) for e in prompts if isinstance(e, dict)]
        card_list = cards if cards is not None else await _roster_cards(user)
        by_id = {str(c.get("id")): c for c in card_list if isinstance(c, dict)}
        fresh = [i for i in ids if i in by_id and (cache.get(i) or {}).get("sheet") != _sheet_key(by_id[i])]
        if len(fresh) >= MIN_CAST:
            fn = llm_fn
            if fn is None:
                from src import orwell_cast_authoring as A
                fn = await A.resolve_authoring_llm_fn(user, min_output_tokens=9000)
            if fn is not None:
                cast = [by_id[i] for i in ids if i in by_id]
                res = await author_briefs(cast, fn, seed=seed)
                for i, b in res["briefs"].items():
                    cache[i] = {"sheet": _sheet_key(by_id[i]), "brief": b}
                _save_cache(user, cache)
        anchors = deal_anchors([by_id[i] for i in ids if i in by_id], seed)
        out = []
        for e in prompts:
            i = str(e.get("houseguestId") or e.get("id")) if isinstance(e, dict) else ""
            c = cache.get(i) or {}
            b = c.get("brief") if i in by_id and c.get("sheet") == _sheet_key(by_id[i]) else None
            new = final_prompt(str(e.get("prompt") or ""), b, anchors.get(i), by_id.get(i)) if i in by_id else str(e.get("prompt") or "")
            out.append({**e, "prompt": new} if new != e.get("prompt") else e)
        return out
    except Exception as e:  # failsoft-ok: best-effort-enrichment (the engine's own shot card stands)
        logger.info(f"[photo-brief] skipped: {type(e).__name__}")
        return prompts
