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
    times = _spread(ids, TIMES, "time", seed)
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
FIELDS = ("where", "doing", "inFrame", "wear", "signature", "timeLight", "expressionBody", "why")
LIMITS = {"where": 170, "doing": 170, "wear": 170, "signature": 90, "timeLight": 130, "expressionBody": 210, "why": 300}
IN_FRAME_ITEM_MAX = 70

SYSTEM = (
    "You write ONE photo brief per person for a pre-season cast photo shoot of a reality show. The production visited each person at home on a roughly "
    "ordinary day of their own life and photographed them there: a plain, honest portrait of a real resident, not a studio shot. You see the whole cast so "
    "you can spread places, times and clothes; no two people may share a place or a look.\n"
    "Answer with JSON only: an object keyed by the person's id, each value an object with exactly these keys:\n"
    "where: one specific place from THIS person's own life that their biography names or implies, in concrete words (what and where it is, what is around it); never a "
    "bare category.\n"
    "doing: what they are in the middle of, paused for the photo, natural and not acted.\n"
    "inFrame: an array of exactly two things in the frame that belong to them, taken from their sheet.\n"
    "wear: what they wear today, taken from their wardrobe, in their own everyday clothes.\n"
    "signature: one item or detail on them that makes them memorable and fits their life.\n"
    "timeLight: the time of day, the light and the weather. The anchors given for each person (the facet of life to feature, the time, the season and weather, the "
    "energy) are fixed facts: follow them; if the weather does not fit the town and season, keep the time and use the nearest plausible weather.\n"
    "expressionBody: the facial expression and body language, taken from their demeanor, their voice and their on-camera line, at the strength of a real person at ease: "
    "upright and natural.\n"
    "why: one sentence that quotes, in double quotes, the exact phrases of their sheet that you used.\n"
    "Rules for every person. The facet of life to feature is the thing the photo shows; when it says near their work, the place is close to where they work but they wear "
    "their own clothes and nothing shows the job: no uniform, scrubs, apron, badge, work gear or work prop. The job is never a caption for the photo anywhere else either; "
    "a hobby or a family object is welcome. Posture is natural and upright (standing, or seated on something at normal height, or leaning lightly on something that is there); "
    "nothing is acted. No eyes shut, no open palm held out to nobody, no hat or sunglasses indoors, no sunglasses at all. Only the person is in sharp focus; life in the "
    "background (other people, animals, vehicles) is welcome and wanted but out of focus. No readable brand names, signs or text. Do not write the person's name: say "
    "'the person'. Do not describe framing, lens or camera. Invent from the sheet; do not reuse wording between people."
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
    }


def build_messages(cards: list, anchors: dict) -> list:
    cast = {str(c["id"]): {**sheet_of(c), "anchors": anchors.get(str(c["id"]), {})} for c in cards if isinstance(c, dict) and c.get("id")}
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": json.dumps({"cast": cast}, ensure_ascii=False)}]


# ---------------------------------------------------------------------------------------------------- the checks (narrow, deterministic)
ACTED_RE = re.compile(
    r"hunch|slump|sprawl|lung(?:e|ing)|crouch|elbows? on (?:the |his |her |their )?knees|between (?:the |his |her |their )?knees|hanging|behind (?:the |his |her |their )?head|"
    r"chin resting|\bfists?\b|point\w* at|thumbs.?up|flex|jazz|snarl|bared|fierce|mugg|comic|disbelief|startled|wiggl|slapping|stretched out|"
    r"eyes (?:shut|closed|squeezed)|squeezed shut|eyes closed|dejected|on all fours|doubled over|cross-legged on the (?:ground|steps)", re.I)
OPEN_PALM_RE = re.compile(r"palms? (?:up|open|out)|open (?:hand|palm)|hand open|hands open|palm facing up", re.I)
TALKING_RE = re.compile(r"mid-sentence|talking to|telling (?:a|the) story|speaking to|laughing with|in conversation|chatting", re.I)
WORK_GEAR_RE = re.compile(r"\b(?:scrubs|uniform|apron|badge|lanyard|hard hat|turnout|stethoscope|name ?tag|high-vis|hi-vis|work gear|work boots|safety vest|chef'?s? (?:coat|jacket|whites))\b", re.I)
TEXT_RE = re.compile(r"\b(?:logo|brand|sign (?:reading|that says)|reads? ['\"]|lettering|slogan|printed words|text on|written on|banner reading)\b|[A-Z][a-z]+(?:'s)? (?:Pizza|Diner|Market|Bar|Cafe|Café)\b(?= sign)", re.I)
BRAND_RE = re.compile(r"\b(?:nike|adidas|puma|coca[- ]cola|pepsi|starbucks|mcdonald'?s|walmart|target|ford|chevy|chevrolet|toyota|honda|harley|carhartt|patagonia|north face|levi'?s|vans|converse|apple|samsung|budweiser|corona|yeti)\b", re.I)
HAT_RE = re.compile(r"\b(?:hat|cap|beanie|fedora|visor|bonnet)\b", re.I)
SUNGLASSES_RE = re.compile(r"\b(?:sunglasses|shades|goggles)\b", re.I)
INDOOR_RE = re.compile(r"\b(?:indoors?|inside|kitchen|living room|bedroom|dining|diner|booth|café|cafe|studio|shop(?! (?:window|front))|church (?:hall|basement|kitchen)|garage|hallway|stairwell|apartment|bar|kitchenette|bathroom|office|classroom|gym|locker|barn)\b", re.I)
OUTDOOR_RE = re.compile(r"\b(?:outdoors?|outside|yard|garden|porch|steps|stoop|dock|pier|beach|river|lake|trail|field|street|sidewalk|road|park|lot|ditch|bank|roof|balcony|patio|driveway|hill|dune|farm|orchard|court)\b", re.I)
DARK_TOP_RE = re.compile(r"\b(?:black|charcoal|navy|dark (?:grey|gray|blue))\b", re.I)
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
TIME_BUCKET_MAX = 5
GESTURES = (
    ("arms-crossed", r"arms (?:folded|crossed)"), ("hand-to-head", r"(?:back of (?:the |his |her |their )?neck|(?:the |his |her |their )hair)\b"),
    ("hips", r"hands? on (?:the |his |her |their )?hips?"), ("open-palm", r"palms? (?:up|open|out)|hand open|hands open"),
    ("pockets", r"pockets?\b"), ("holding-arm", r"holding (?:the |his |her |their )?(?:other|opposite) (?:wrist|arm|forearm|elbow)"),
)
GESTURE_MAX = 2
DARK_MAX = 4


def _norm(t: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", str(t or "").lower()).strip()


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
        elif isinstance(v, str) and v.strip():
            out[k] = re.sub(r"\s+", " ", v).strip()
    return out or None


def _sheet_text(card: dict) -> str:
    s = sheet_of(card)
    return " ".join(str(v) for v in (s["biography"], s["identity"], s["demeanor"], s["voice"], s["castingType"], s["onCamera"], s["style"], s["hometown"], s["job"], " ".join(s["wardrobe"])))


def check_brief(card: dict, anchors: dict, brief: Optional[dict]) -> list:
    """The reason codes a brief fails with (empty = accepted)."""
    if not brief:
        return ["missing"]
    codes: list = []
    for k in FIELDS:
        if k not in brief:
            codes.append(f"missing-{k}")
    if codes:
        return codes
    if len(brief["inFrame"]) != 2:
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
    if indoor and HAT_RE.search(brief["wear"] + " " + brief["signature"]):
        codes.append("hat-indoors")
    where = brief["where"].strip()
    if GENERIC_WHERE.match(where) or len(where.split()) < 5:
        codes.append("generic-place")
    # the place is from THIS person's life: it shares a content word with the sheet (biography, identity, hometown, on-camera line, wardrobe)
    elif not (_tokens(where) & _tokens(_sheet_text(card))):
        codes.append("place-not-from-sheet")
    # the job is not a caption (unless the facet is near work)
    job = str(card.get("vocation") or "")
    if job and anchors.get("facet") != NEAR_WORK:
        job_words = {w for w in _norm(job).split() if len(w) >= 4 and w not in ("night", "head", "manager", "assistant", "senior", "junior", "small", "local")}
        if job_words and (job_words & _tokens(brief["where"] + " " + brief["doing"] + " " + " ".join(brief["inFrame"]) + " " + brief["signature"])):
            codes.append("job-caption")
    # the trace: a quoted phrase that really is in the sheet
    quotes = [q for q in re.findall(r"[\"“]([^\"”]{6,})[\"”]", brief["why"]) if q.strip()]
    sheet = _norm(_sheet_text(card))
    if not any(_norm(q) and _norm(q) in sheet for q in quotes):
        codes.append("no-sheet-quote")
    return codes


def _place_kind(where: str) -> str:
    for kind, rx in PLACE_KINDS:
        if re.search(rx, where, re.I):
            return kind
    return "other"


def _time_bucket(t: str) -> str:
    low = str(t).lower()
    for b, rx in (("morning", r"morning|sunrise|dawn"), ("noon", r"noon|midday"), ("afternoon", r"afternoon"), ("golden", r"golden|sunset"), ("evening", r"dusk|evening|blue hour|lamp|night")):
        if re.search(rx, low):
            return b
    return "other"


def check_cast(cards: list, anchors: dict, briefs: dict) -> dict:
    """Cast-level reason codes per id (the LATER brief of a clash is the offender): a place kind or a time bucket or a gesture family beyond its cap, the near-work count, dark tops."""
    out: dict = {}
    ids = [str(c["id"]) for c in cards if isinstance(c, dict) and c.get("id")]
    kinds: dict = {}
    times: dict = {}
    gest: dict = {}
    dark = 0
    near = 0
    for i in sorted(ids, key=lambda x: [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", x)]):
        b = briefs.get(i)
        if not b:
            continue
        code: list = []
        k = _place_kind(b["where"])
        kinds[k] = kinds.get(k, 0) + 1
        if k != "other" and kinds[k] > PLACE_KIND_MAX:
            code.append("place-kind-repeat")
        tb = _time_bucket(b["timeLight"])
        times[tb] = times.get(tb, 0) + 1
        if tb != "other" and times[tb] > TIME_BUCKET_MAX:
            code.append("light-repeat")
        for fam, rx in GESTURES:
            if re.search(rx, b["doing"] + " " + b["expressionBody"], re.I):
                gest[fam] = gest.get(fam, 0) + 1
                if gest[fam] > GESTURE_MAX:
                    code.append(f"gesture-repeat-{fam}")
        first_garment = (b["wear"].split(",")[0] if b["wear"] else "")
        if DARK_TOP_RE.search(first_garment):
            dark += 1
            if dark > DARK_MAX:
                code.append("dark-palette")
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
    "of the people already accepted (so you can differ from them). Rewrite each failing brief in full, fixing every code. Answer with the same JSON shape keyed by id, "
    "only for the people given."
)


def build_editor_messages(cards: list, anchors: dict, briefs: dict, failures: dict) -> list:
    by_id = {str(c["id"]): c for c in cards if isinstance(c, dict) and c.get("id")}
    def scrubbed(i: str):
        b = briefs.get(i)
        name = str(by_id[i].get("name") or "")
        return None if not b else {k: ([_scrub(x, name) for x in v] if isinstance(v, list) else _scrub(v, name)) for k, v in b.items()}
    bad = {i: {**sheet_of(by_id[i]), "anchors": anchors.get(i, {}), "failedCodes": codes, "previousBrief": scrubbed(i)} for i, codes in failures.items() if i in by_id}
    kept = {i: {"where": b["where"], "wear": b["wear"], "timeLight": b["timeLight"]} for i, b in briefs.items() if i not in failures and b}
    return [{"role": "system", "content": EDITOR_SYSTEM}, {"role": "user", "content": json.dumps({"rewrite": bad, "alreadyAccepted": kept}, ensure_ascii=False)}]


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


async def author_briefs(cards: list, llm_fn: LlmFn, seed=0) -> dict:
    """The whole pipeline for a cast: anchors, ONE writer call, the per-brief checks, ONE editor pass for the offenders, the floor for the rest.
    Returns ``{briefs: {id: brief}, floor: [ids], anchors, rejected: {code: n}, calls: n, rewritten: n}`` (``briefs`` holds only accepted ones)."""
    cards = [c for c in (cards or []) if isinstance(c, dict) and c.get("id")]
    ids = [str(c["id"]) for c in cards]
    anchors = deal_anchors(cards, seed)
    ledger: list = []
    rejected: dict = {}

    def tally(codes_by_id: dict) -> None:
        for codes in codes_by_id.values():
            for c in codes:
                rejected[c] = rejected.get(c, 0) + 1

    raw = await _call(llm_fn, build_messages(cards, anchors), ledger, "writer")
    briefs = {i: clean_brief(raw.get(i)) for i in ids}
    by_id = {str(c["id"]): c for c in cards}
    failures = {i: check_brief(by_id[i], anchors[i], briefs[i]) for i in ids}
    failures = {i: c for i, c in failures.items() if c}
    tally(failures)
    accepted = {i: b for i, b in briefs.items() if b and i not in failures}
    for i, codes in check_cast(cards, anchors, accepted).items():
        failures[i] = failures.get(i, []) + codes
    tally({i: c for i, c in failures.items() if i in accepted})
    accepted = {i: b for i, b in accepted.items() if i not in failures}
    rewritten = 0
    if failures:
        fixed = await _call(llm_fn, build_editor_messages(cards, anchors, {**{i: b for i, b in briefs.items() if b}, **accepted}, failures), ledger, "editor")
        for i in list(failures):
            nb = clean_brief(fixed.get(i))
            if not nb:
                continue
            codes = check_brief(by_id[i], anchors[i], nb)
            if not codes:
                trial = {**accepted, i: nb}
                codes = check_cast(cards, anchors, trial).get(i, [])
            if not codes:
                accepted[i] = nb
                rewritten += 1
            else:
                tally({i: codes})
    floor = [i for i in ids if i not in accepted]
    logger.info(f"[photo-brief] {len(ids)} briefs: accepted {len(ids) - len(floor) - rewritten}, rewritten {rewritten}, floor {len(floor)}; "
                f"rejected by code {json.dumps(rejected, sort_keys=True)}; writer calls {len(ledger)}")
    return {"briefs": accepted, "floor": floor, "anchors": anchors, "rejected": rejected, "calls": len(ledger), "rewritten": rewritten}


# ---------------------------------------------------------------------------------------------------- the prompt
_SPAN_RE = re.compile(r"Wearing .*?(?=Framing, the same for the whole series:)", re.S)
CLOTHES_CLAUSE = "in their own everyday clothes and never a uniform, scrubs, apron, badge or work gear"


def _sentence(t: str) -> str:
    x = re.sub(r"[\s.]+$", "", str(t or "").strip())
    return f"{x}." if x else ""


def brief_sentences(brief: dict) -> str:
    """The brief as the four sentences that replace the engine's clothes, setting, light and moment (and prop) sentences."""
    return " ".join(s for s in (
        _sentence(f"Wearing {brief['wear']}, and {brief['signature']}, {CLOTHES_CLAUSE}"),
        _sentence(f"Setting: {brief['where']}"),
        _sentence(f"In the frame, theirs: {brief['inFrame'][0]} and {brief['inFrame'][1]}"),
        _sentence(f"Light: {brief['timeLight']}"),
        _sentence(f"The moment: {brief['doing']}; {brief['expressionBody']}"),
    ) if s)


def compose_prompt(floor_prompt: str, brief: Optional[dict]) -> str:
    """The final prompt: the engine's prompt with the span from the clothes sentence to the framing sentence replaced by the brief. Without a brief, or when the
    engine's prompt has no such span, the floor prompt stands untouched."""
    if not brief or not isinstance(floor_prompt, str) or not _SPAN_RE.search(floor_prompt):
        return floor_prompt
    return _SPAN_RE.sub(lambda m: brief_sentences(brief) + " ", floor_prompt, count=1)


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
        out = []
        for e in prompts:
            i = str(e.get("houseguestId") or e.get("id")) if isinstance(e, dict) else ""
            c = cache.get(i) or {}
            b = c.get("brief") if i in by_id and c.get("sheet") == _sheet_key(by_id[i]) else None
            out.append({**e, "prompt": compose_prompt(str(e.get("prompt") or ""), b)} if b else e)
        return out
    except Exception as e:  # failsoft-ok: best-effort-enrichment (the engine's own shot card stands)
        logger.info(f"[photo-brief] skipped: {type(e).__name__}")
        return prompts
