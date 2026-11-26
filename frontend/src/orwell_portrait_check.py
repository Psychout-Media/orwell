"""ORW-384: the automatic photo check for AI cast portraits.

A vision model looks at a freshly shot cast photo and answers JSON only: which checklist problems it
shows. `check_portrait` never raises and never blocks a portrait: no vision model, a timeout, an HTTP
error or unparseable JSON all return None ("skipped"), and the caller keeps the photo as is.

The wall: only the (downscaled) image and a short facts block built from the PUBLIC portrait brief
(age, gender presentation, main clothing piece, the spot, whether eyes on camera was asked) leave the
process. No name, no backstory, no Vault content, no full prompt.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)

CHECK_TIMEOUT_S = 45.0
CHECK_CALL_CLASS = "portrait-check"
DEFAULT_CHECK_MODEL = "deepseek-flash"
CHECK_PROVIDER = "deepseek"
DEEPSEEK_HOST = "deepseek.com"
_MAX_SIDE = 768

# code -> plain words (used in the re-shoot "Fix in this version" line)
PROBLEM_WORDS = {
    "not-one-person": "show exactly one person",
    "text-or-logo": "no text or logos anywhere, and no printed words, logos or graphics on any clothing",
    "messy-hair": "neat, groomed hair with no flyaways or frizz",
    "bad-hands": "natural hands with five separate fingers, or keep the hands out of frame",
    "mouth-mid-word": "a closed or gently smiling mouth, not caught mid-word",
    "skin-patch": "clear skin with no bruise, wound, bandage or patch on the face",
    "wrong-age": "the stated age exactly, not older and not younger",
    "wrong-clothes": "the stated clothing",
    "wrong-presentation": "clothes that match the stated gender presentation",
    # the person themselves reads as the stated presentation (a man or a woman as the card says; never judged for a nonbinary card)
    "wrong-gender": "a person who reads as the gender presentation the card states (man or woman), exactly as the card describes them",
    "eyes-off": "eyes looking straight at the camera",
    "not-a-portrait": "a head-and-shoulders portrait photo",
    "missing-feature": "every stated visible feature (glasses, piercings, facial hair, hair colour, length and style)",
    # ORW-480: the realism codes
    "not-a-real-photo": "a real, unposed photograph with real skin texture, not a studio, stock, glossy or rendered look",
    "bad-held-object": "natural hands and held objects with correct fingers, grip and shape, or nothing held",
    "fake-clothes": "ordinary real garments with proper seams, fit and structure",
    # ORW-480: a frame or border (a black edge, a film-scan rim) and a provider watermark
    "frame-or-border": "a photograph that runs to all four edges: no frame, border, black edge or film-scan rim",
    "watermark": "no watermark, sparkle, star or logo mark in any corner",
    # ORW-480: anatomy proportions
    "bad-proportions": "natural adult body proportions: hands the right size for the face, head in proportion to the body, arms and legs of natural length, every limb joined to the right shoulder or hip",
}
KNOWN_CODES = frozenset(PROBLEM_WORDS)


def has_border(png: bytes) -> bool:
    """A cheap, deterministic edge test (no model call): True when all four edges of the picture are one flat, very dark (or very light) band, as a black frame or a
    film-scan rim is. Needs Pillow; without it, or on an unreadable image, False."""
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(png))
        im.load()
        im = im.convert("L")
        im.thumbnail((256, 256))
        w, h = im.size
        t = max(2, int(min(w, h) * 0.03))
        px = im.load()

        def band(coords):
            vals = [px[x, y] for x, y in coords]
            mean = sum(vals) / len(vals)
            sd = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
            return mean, sd
        sides = (
            band((x, y) for x in range(w) for y in range(t)), band((x, y) for x in range(w) for y in range(h - t, h)),
            band((x, y) for x in range(t) for y in range(h)), band((x, y) for x in range(w - t, w) for y in range(h)),
        )
        return all(sd < 7 and (mean < 28 or mean > 238) for mean, sd in sides)
    except Exception:  # failsoft-ok: best-effort-enrichment (no edge verdict: the vision check still looks)
        return False


def problems_in_words(codes: list) -> str:
    return ", ".join(PROBLEM_WORDS[c] for c in codes if c in PROBLEM_WORDS)


# ── facts from the public portrait brief ─────────────────────────────────────────────────────
_GENDER_WORDS = {"man": "man", "woman": "woman", "boy": "boy", "girl": "girl", "nonbinary": "nonbinary"}


_FEATURE_RES = (
    ("glasses", r"\b(?:glasses|spectacles|eyeglasses)\b"), ("nose stud or ring", r"\bnose (?:stud|ring|piercing)\b"),
    ("piercings", r"\b(?:lip|brow|eyebrow|septum|ear) (?:ring|stud|piercing)s?\b|\bhoops?\b|\bearrings?\b"),
    ("beard", r"\bbeard\b"), ("moustache", r"\bm(?:ou|u)stache\b"), ("stubble", r"\bstubble\b"), ("goatee", r"\bgoatee\b"),
    ("hair colour", r"\b(?:black|dark brown|light brown|brown|blond|blonde|red|auburn|ginger|grey|gray|silver|white|platinum) hair\b"),
    ("hair length", r"\b(?:buzzed|shaved|cropped|short|shoulder-length|long|waist-length)(?: [a-z]+)? hair\b"),
)


_HAIR_CLAUSE_RE = re.compile(r"\bHair:\s*([^.]+)\.")
# The colour and length words the check has always known (ORW-437); a hair line that has one keeps exactly that reading.
_HAIR_COLOUR_RE = re.compile(
    r"\b(?:jet black|blue-black|black|dark brown|light brown|chestnut|brown|blond|blonde|strawberry blonde|red|auburn|ginger|copper|"
    r"grey|gray|silver|white|platinum)\b", re.I)
_HAIR_LENGTH_RE = re.compile(r"\b(?:buzzed|shaved|cropped|close-cropped|short|chin-length|shoulder-length|long|waist-length)\b", re.I)
# ORW-460: only for a hair line the words above leave with NOTHING to check ("voluminous dark waves", "neat locs past the
# shoulder", "a salt-and-pepper buzzcut"): the softer colour words, the other lengths and cuts, then the shape of the style.
_SOFT_COLOUR_RE = re.compile(
    r"\b(?:salt[- ]and[- ]pepper|dark|light|ashy?|sandy|espresso|caramel|chocolate|mahogany|honey|golden|"
    r"magenta|pink|purple|violet|teal|cobalt|green|orange|blue)\b", re.I)
_SOFT_LENGTH_RE = re.compile(
    r"\b(?:chin[- ]length|jaw[- ]length|collar[- ]length|medium[- ]length|past (?:the |her |his |their )?shoulders?|"
    r"to the collar|bald|lob|bob|pixie|buzz ?cut|crop|fade)\b", re.I)
_HAIR_STYLE_RE = re.compile(
    r"\b(?:waves|wavy|curls|curly|coils|braids?|braided|locs|twist-out|ponytail|bun|afro|bangs|blowout|mohawk|straight|slicked back)\b", re.I)
# An accent is not the hair colour: "caramel highlights", "magenta peekaboo", a dyed top, "a red ribbon". Only a phrase that holds an
# accessory or accent noun is dropped, so "with a dark brown base" and "..., espresso-brown and neat" keep their colour.
_ACCENT_NOUNS = (r"(?:highlights?|highlighted|streaks?|peekaboo|tips?|tipped|ribbons?|clips?|ties?|bands?|scrunchies?|pins?|bows?|"
                 r"elastic|headbands?|scarf|barrettes?|combs?|wrap|cast|tint|tinge|hint|sheen|glint|undertones?|flecks?|"
                 r"top|front|ends|roots)")
# a colour right after one of these is a trace, not the hair colour: "more silver at the temples", "scattered silver", "a faint copper"
_ACCENT_BEFORE_RE = re.compile(r"(?:more|scattered|touch of|hint of|faint|subtle|slight|streaks of|flecks of|a little|some|bit of)\s+$", re.I)
# a length word about the sides, not the whole head: "short tight sides", "cropped close at the sides", "a clean short taper"
_SIDES_AFTER_RE = re.compile(r"^[\w\s-]{0,22}\b(?:sides|taper|temples|nape|edges)\b", re.I)
_ACCENT_PHRASE_RE = re.compile(
    r"\b(?:with|tied|held|pinned|secured|clipped|topped|wrapped|tucked|under|beneath|dyed)\b[^,;]*\b" + _ACCENT_NOUNS + r"\b[^,;]*", re.I)
_ACCENT_AFTER_RE = re.compile(r"^[- ]*" + _ACCENT_NOUNS + r"\b", re.I)


# The length is read as it always was: from the part of the line before an accessory word ("... tied with a ribbon").
_HAIR_ACCESSORY_RE = re.compile(r"\b(?:with|tied|held|pinned|secured|clipped|topped|wrapped|tucked|under|beneath)\b", re.I)


def _first_base(rx, text: str):
    """The first match of `rx` that is not an accent colour (a colour word directly before "highlights", "streaks", a ribbon ...)."""
    for m in rx.finditer(text):
        if _ACCENT_AFTER_RE.match(text[m.end():]) or _ACCENT_BEFORE_RE.search(text[:m.start()]):
            continue
        return m
    return None


def _first_length(rx, text: str):
    for m in rx.finditer(text):
        if _SIDES_AFTER_RE.match(text[m.end():]) or re.search(r"\bsides\b|\btaper\b", text[max(0, m.start() - 12):m.start()], re.I):
            continue
        return m
    return None


def hair_features(clause: str) -> list:
    """The checkable hair features in one hair line. The base colour and the length when the line says them (as before);
    a line with neither gets the softer colour, the cut or length, or the style shape, so a real hair line always yields at
    least one (ORW-460)."""
    text = _ACCENT_PHRASE_RE.sub(" ", clause)
    out = []
    c, ln = _first_base(_HAIR_COLOUR_RE, text), _HAIR_LENGTH_RE.search(_HAIR_ACCESSORY_RE.split(clause, maxsplit=1)[0])
    if c:
        out.append(f"{c.group(0).lower()} hair")
    if ln:
        out.append(f"{ln.group(0).lower()} hair")
    if out:
        return out
    sc = _first_base(_SOFT_COLOUR_RE, text)
    if sc:
        out.append(f"{sc.group(0).lower()} hair")
    sl = _first_length(_SOFT_LENGTH_RE, text)
    if sl:
        w = sl.group(0).lower()
        out.append(f"{w} hair" if re.fullmatch(r"(?:chin|jaw|collar|medium)[- ]length|bald", w)
                   else f"hair with a {w}" if re.fullmatch(r"lob|bob|pixie|buzz ?cut|crop|fade", w) else f"hair {w}")
    if not out:
        st = _HAIR_STYLE_RE.search(text)
        if st:
            w = st.group(0).lower()
            out.append(f"hair {w}" if w == "slicked back" else f"hair in {w}")
    return out


def visible_features(prompt: str) -> list:
    """The visible features the brief states (glasses, piercings, facial hair, hair colour, length and style), as phrases.
    The hair features are read from the brief's own `Hair: ...` clause in any word order (ORW-437: "tight black curls",
    "shoulder-length waves", "jet black"; ORW-460: "dark", "caramel", "salt-and-pepper", "past the shoulders", a cut or a style),
    else from the older "<colour> hair" wording."""
    out = []
    hm = _HAIR_CLAUSE_RE.search(prompt or "")
    for label, rx in _FEATURE_RES:
        if hm and label.startswith("hair"):
            continue
        m = re.search(rx, prompt or "", re.I)
        if m:
            out.append(m.group(0).lower() if label.startswith("hair") else label)
    if hm:
        out.extend(hair_features(hm.group(1)))
    return out


def facts_from_prompt(prompt: str) -> dict:
    """Conservative parse of the portrait prompt (v3 and older wordings). Missing facts are omitted."""
    facts: dict = {}
    if not isinstance(prompt, str) or not prompt:
        return facts
    m = re.search(r"\b(\d{1,3})-year-old\b", prompt) or re.search(r"\blooks exactly (\d{1,3}) years old\b", prompt)
    if m:
        facts["age"] = int(m.group(1))
    m = re.search(r"\b\d{1,3}-year-old\s+[A-Za-z' -]{0,60}?\b(man|woman|boy|girl|nonbinary)\b", prompt)  # ORW-437: the brief says "nonbinary person with a soft androgynous look"
    if m:
        facts["gender"] = _GENDER_WORDS[m.group(1)]
    else:
        m = re.search(r"Subject: an? (man|woman) \((masculine|feminine) presentation\)", prompt)
        if m:
            facts["gender"] = m.group(1)
    m = re.search(r"\bWearing:?\s+([^.]+)\.", prompt)
    if m:
        first = re.split(r",| and ", m.group(1))[0].strip()
        if first:
            facts["clothing"] = first[:120]
    m = re.search(r"Setting: (?:the house )?([^,.]+)", prompt)
    if m:
        facts["spot"] = m.group(1).strip()[:80]
    if "The moment:" in prompt and "Setting:" in prompt:
        # ORW-480: a candid brief. The moment may be a laugh, mid-word, looking away, with loose hairs: those are not faults.
        # Eyes on the lens only when the moment says so.
        facts["candid"] = True
        mm = re.search(r"The moment: ([^.]+)\.", prompt)
        facts["moment"] = mm.group(1).strip()[:200] if mm else ""
        if re.search(r"\b(?:into|at|on|toward|towards) the (?:lens|camera)\b", facts["moment"], re.I):
            facts["eyes_on_camera"] = True
        feats = visible_features(prompt)
        if feats:
            facts["features"] = feats
        return facts
    seg = ""
    if "Setting:" in prompt:
        head = prompt.split("Setting:", 1)[0]
        wm = re.search(r"\bWearing:?\s+[^.]+\.", head)
        seg = head[wm.end():] if wm else ""
    elif "On camera:" in prompt:
        seg = prompt.split("On camera:", 1)[1]
    feats = visible_features(prompt)
    if feats:
        facts["features"] = feats
    low = seg.lower()
    if ("camera" in low or "lens" in low) and "looking away" not in low and "looks away" not in low:
        facts["eyes_on_camera"] = True
    return facts


def facts_block(facts: dict) -> str:
    lines = []
    if facts.get("age"):
        lines.append(f"Stated age: {int(facts['age'])}")
    if facts.get("gender"):
        if facts["gender"] == "nonbinary":
            note = " (any clothing and any look fit; never report wrong-presentation or wrong-gender)"
        else:
            note = " (the card's own statement: judge the whole person; hair length, build and clothes alone never make this wrong)"
        lines.append(f"Stated gender presentation: {facts['gender']}{note}")
    if facts.get("clothing"):
        lines.append(f"Main clothing piece: {facts['clothing']}")
    if facts.get("spot"):
        lines.append(f"Spot: {facts['spot']}" if facts.get("candid") else f"Spot: the house {facts['spot']}")
    if facts.get("moment"):
        lines.append(f"Intended moment (any of it is fine, including laughing, mid-word, looking away): {facts['moment']}")
    if facts.get("features"):
        lines.append("Stated visible features (each must be visible): " + ", ".join(facts["features"]))
    if facts.get("eyes_on_camera"):
        lines.append("Eyes on camera was asked: yes")
    return "\n".join(lines) if lines else "No stated facts."


_CHECKLIST = (
    "not-one-person (zero or several people), text-or-logo (visible text, logo or watermark), "
    "messy-hair (flyaways, frizz, unkempt), bad-hands (extra, fused or twisted fingers), "
    "mouth-mid-word (mouth caught open mid-speech), skin-patch (a bruise, wound, bandage or patch on the face), "
    "wrong-age (the person reads more than about 8 years off the stated age), "
    "wrong-clothes (the main clothing piece is missing or clearly different), "
    "wrong-presentation (the clothes contradict the stated gender presentation), "
    "wrong-gender (the person plainly reads as the other gender than the one stated, judged on the whole person: short or long hair, build, height, clothes and make-up are never evidence on their own; a person who plausibly fits the stated presentation is fine; use it only when the stated man clearly reads as a woman or the stated woman clearly reads as a man), "
    "eyes-off (eyes not on the camera; only judge this when the facts say eyes on camera was asked), "
    "not-a-portrait (not a head-and-shoulders or waist-up portrait photo), "
    "missing-feature (a stated visible feature, such as glasses, a piercing, facial hair, the hair colour, length or style, is not in the photo), "
    "frame-or-border (a black or white frame, border or film-scan edge around the picture), "
    "watermark (a visible watermark, sparkle, four-point star or logo mark in a corner), "
    "bad-proportions (a clear body-proportion error: a hand that looks tiny or huge next to the face (an adult hand is about as tall as the face, chin to hairline), a head too big or too small for the body, an arm or leg far longer or shorter than the other or than natural adult length, an extra, missing or merged limb, a limb joined to the wrong place; a foreshortened limb that is plausible for the pose is not a problem)"
)


_REALISM_CHECKLIST = (
    "not-a-real-photo (it does not look like a real photograph: a glossy studio or stock-photo look, plastic or airbrushed skin, "
    "a rendered or illustrated look, a blurred-away background that hides the place), "
    "bad-held-object (hands or a held object look unnatural: wrong finger count, fused or bent fingers, a held thing with a wrong shape), "
    "fake-clothes (the clothes are not real garments: impossible construction, melted seams, a collar or lapel that makes no sense, a lanyard or badge as costume), "
    "frame-or-border (a black or white frame, border or film-scan edge around the picture), "
    "watermark (a visible watermark, sparkle, four-point star or logo mark in a corner), "
    "bad-proportions (a clear body-proportion error: a hand that looks tiny or huge next to the face (an adult hand is about as tall as the face, chin to hairline), a head too big or too small for the body, an arm or leg far longer or shorter than the other or than natural adult length, an extra, missing or merged limb, a limb joined to the wrong place; a foreshortened limb that is plausible for the pose is not a problem)"
)
# codes that do not apply to a candid brief: the moment may be a laugh or a glance, and loose hairs are asked for
_CANDID_SKIPPED = ("messy-hair", "mouth-mid-word", "not-a-portrait")


def _checklist_for(facts: dict) -> str:
    base = _CHECKLIST
    if facts.get("candid"):
        base = ", ".join(part for part in re.split(r", (?=[a-z]+(?:-[a-z]+)+ \()", _CHECKLIST)
                         if not part.startswith(_CANDID_SKIPPED))
        return base + ", " + _REALISM_CHECKLIST
    return base


def build_request(model_id: str, image_url: str, facts: dict) -> dict:
    text = (
        "You are a strict photo editor for a reality-TV cast photo. Look at the photo and list only the "
        "problems that are clearly present. Checklist codes: " + _checklist_for(facts) + ".\n\n"
        "Facts about who should be shown:\n" + facts_block(facts) + "\n\n"
        'Answer with JSON only, no other text: {"problems": ["code", ...]} (an empty list if the photo is fine).'
    )
    return {
        "model": model_id,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": image_url}},
        ]}],
        "temperature": 0,
        # deepseek-flash reasons before it answers; on 5 of 12 real cast photos the 2000 budget ran out in the
        # reasoning and the content came back empty with finish_reason length, so the photo was kept UNCHECKED
        # silently. This gives the check room to answer.
        "max_tokens": 8000,
    }


def _image_data_url(png: bytes) -> str:
    """768 px JPEG when Pillow is there, else the PNG as is."""
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(png))
        im.load()
        im = im.convert("RGB")
        im.thumbnail((_MAX_SIDE, _MAX_SIDE))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:  # failsoft-ok: best-effort-enrichment (send the PNG as is)
        return "data:image/png;base64," + base64.b64encode(png).decode()


def _message_content_text(data: dict) -> str:
    """The first choice's message content as text (a list of parts joins its `text` parts), '' when absent."""
    try:
        content = data["choices"][0]["message"]["content"]
    except Exception:
        return ""
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return content if isinstance(content, str) else ""


def _empty_cut_off(data: dict) -> bool:
    """True when the first choice ran out of tokens (`finish_reason` "length") and its content is blank:
    the reasoning used the whole budget and no verdict came back."""
    try:
        finish_reason = data["choices"][0].get("finish_reason")
    except Exception:
        return False
    return finish_reason == "length" and not _message_content_text(data).strip()


def _parse_problems(data: dict) -> Optional[list]:
    try:
        content = data["choices"][0]["message"]["content"]
    except Exception:
        return None
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    if not isinstance(content, str) or not content.strip():
        return None  # empty content (reasoning ate the budget): skip, fail open
    m = re.search(r"\{.*\}", content, re.S)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except Exception:
        return None
    probs = obj.get("problems") if isinstance(obj, dict) else None
    if not isinstance(probs, list):
        return None
    out: list = []
    for p in probs:
        if isinstance(p, str) and p in KNOWN_CODES and p not in out:
            out.append(p)
    if probs and not out:
        return None  # ORW-437: a verdict naming only codes we do not know is malformed, never "no problems": skip, fail open
    return out


def _record_spend(user, data: dict, call_class: str = CHECK_CALL_CLASS) -> Optional[float]:
    """Ledger the call; return its dollar cost when the provider returned it (or it was estimated), else None."""
    try:
        from src import orwell_token_ledger
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        cost, estimated = usage.get("cost"), False
        ptd = usage.get("prompt_tokens_details") if isinstance(usage.get("prompt_tokens_details"), dict) else {}
        cached = ptd.get("cached_tokens")
        if cached is None:
            cached = usage.get("prompt_cache_hit_tokens")
        if cost is None:
            # ORW-437: DeepSeek's own API returns no dollar cost; estimate it the way llm_core does, never ledger 0.0
            from src.llm_core import _deepseek_cost_estimate
            cost = _deepseek_cost_estimate(str(data.get("model") or _check_model_id(user)), usage.get("prompt_tokens") or 0,
                                           cached or 0, usage.get("completion_tokens") or 0)
            estimated = cost is not None
            if not estimated:
                return None  # an unpriced model has no honest dollar figure: never ledger a 0.0 cost as if it were measured
        extra = {"cost_estimated": True} if estimated else {}
        orwell_token_ledger.record_turn(
            user, call_class=call_class,
            input_tokens=usage.get("prompt_tokens") or 0,
            cached_tokens=cached or 0,
            cache_miss_tokens=usage.get("prompt_cache_miss_tokens"),
            output_tokens=usage.get("completion_tokens") or 0,
            call_site="photo-check", model=str(data.get("model") or "") or None,
            cost=cost or 0.0, provider=CHECK_PROVIDER, **extra)
        return float(cost) if cost is not None else None
    except Exception:  # failsoft-ok: observability (ledgering must never fail a portrait)
        return None


def _check_model_id(user) -> str:
    """The configured model id, honoured only if it is a bare DeepSeek id; anything else is ignored."""
    from src.settings import get_user_setting
    spec = str(get_user_setting("portrait_check_model", owner=user or "", default=DEFAULT_CHECK_MODEL) or "").strip()
    low = spec.lower()
    if low.startswith("deepseek-") and "/" not in spec and "@" not in spec:
        return spec
    return DEFAULT_CHECK_MODEL


def _resolve_deepseek(model_id: str, owner):
    """(chat_url, headers) of an enabled DeepSeek endpoint (host api.deepseek.com), else ValueError.
    Never any other provider: the check has no fallback."""
    from src.database import SessionLocal, ModelEndpoint
    from src.llm_core import _host_match
    from src.endpoint_resolver import normalize_base, build_chat_url, build_headers
    from src.auth_helpers import owner_filter, is_admin_user
    db = SessionLocal()
    try:
        q = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)  # noqa: E712
        if owner and not is_admin_user(owner):
            q = owner_filter(q, ModelEndpoint, owner, include_shared=True)
        for ep in q.all():
            if _host_match(ep.base_url, "api." + DEEPSEEK_HOST):
                base = normalize_base(ep.base_url)
                return build_chat_url(base), build_headers(ep.api_key, base)
    finally:
        db.close()
    raise ValueError("no enabled DeepSeek endpoint")


async def _call(png: bytes, facts: dict, user) -> Optional[dict]:
    import httpx
    model_id = _check_model_id(user)
    url, headers = await asyncio.to_thread(_resolve_deepseek, model_id, user or None)
    body = build_request(model_id, _image_data_url(png), facts)

    async def post_once():
        async with httpx.AsyncClient(timeout=CHECK_TIMEOUT_S) as client:
            return await client.post(url, json=body, headers=headers)

    resp = await post_once()
    if resp.status_code != 200:
        logger.info("[portrait-check] http %s", resp.status_code)
        return None
    data = resp.json()
    if not isinstance(data, dict):
        return None
    if _empty_cut_off(data):
        # ORW-480: reasoning ate the token budget: one retry, same url, headers and body. The cut-off call was billed, so it is ledgered too.
        _record_spend(user, data)
        resp = await post_once()
        data = resp.json() if resp.status_code == 200 else None
        if not isinstance(data, dict) or _empty_cut_off(data):
            logger.warning('[portrait-check] no verdict: the model ran out of tokens')
            return None
    cost = _record_spend(user, data)
    problems = _parse_problems(data)
    if problems and facts.get("gender") not in ("man", "woman", "boy", "girl"):
        # no clothing contradicts a nonbinary presentation, and nobody is judged against a binary gender the card does not state (review of #2748)
        problems = [p for p in problems if p not in ("wrong-presentation", "wrong-gender")]
    if problems is None:
        return None
    if cost is not None:
        try:  # ORW-480: the check's cost joins the photo's running total for the attempt log (the verdict dict stays as it was)
            from src import orwell_portraits as P
            P._note_gen_cost(cost)
        except Exception:  # failsoft-ok: observability
            pass
    return {"ok": not problems, "problems": problems}


# ── ORW-480: the cast-level look: ONE vision call over a contact sheet of the whole cast ─────────────────
CAST_CALL_CLASS = "portrait-cast-check"
CAST_RESHOOT_MAX = 3            # most photos one cast look may send back for a re-shoot (each is a paid image)
_TILE = 256
_COLS = 5
_REPEAT_KINDS = ("prop", "pose", "room", "light")
_REPEAT_MIN = {"prop": 2, "pose": 3, "room": 3, "light": 3}

CAST_REASON_WORDS = {
    "pair": "a clearly different face from the rest of the cast: another face shape, nose, eyes, brows and jaw than the others",
    "prop": "no held object that other photos in the cast already show",
    "pose": "a different pose from the others in the cast",
    "room": "a different place from the others in the cast",
    "light": "a different kind of light from the others in the cast",
}


def contact_sheet(pngs: list) -> Optional[str]:
    """A numbered grid (1..n, left to right, top to bottom) of the cast photos as one JPEG data URL, or None without Pillow."""
    try:
        from PIL import Image, ImageDraw
        rows = (len(pngs) + _COLS - 1) // _COLS
        sheet = Image.new("RGB", (_COLS * _TILE, rows * _TILE), "white")
        for i, png in enumerate(pngs):
            im = Image.open(io.BytesIO(png))
            im.load()
            im = im.convert("RGB")
            im.thumbnail((_TILE, _TILE))
            x, y = (i % _COLS) * _TILE, (i // _COLS) * _TILE
            sheet.paste(im, (x + (_TILE - im.width) // 2, y + (_TILE - im.height) // 2))
            d = ImageDraw.Draw(sheet)
            d.rectangle((x, y, x + 34, y + 26), fill="black")
            d.text((x + 6, y + 6), str(i + 1), fill="white")
        buf = io.BytesIO()
        sheet.save(buf, "JPEG", quality=85)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:  # failsoft-ok: best-effort-enrichment (no sheet, no cast look; every photo stands)
        return None


def build_cast_request(model_id: str, image_url: str, n: int) -> dict:
    text = (
        f"This is a contact sheet of {n} reality-TV cast photos, numbered 1 to {n} (number in the top-left corner of each). "
        "Each photo is a different person. Answer two things.\n"
        "1) pairs: any two photos whose people look like the SAME person or near twins (face shape, nose, eyes, jaw), as number pairs.\n"
        "2) repeats: anything shown too often across photos. kind is one of prop (the same held object on 2 or more photos), "
        "pose (the same body pose on 3 or more), room (the same room or background on 3 or more), light (the same lighting on 3 or more). "
        "Give the photo numbers that share it and a few words naming it.\n"
        'Answer with JSON only, no other text: {"pairs": [[1, 2]], "repeats": [{"kind": "prop", "numbers": [3, 4], "what": "a white mug"}]}. '
        "Use empty lists when there is nothing."
    )
    return {"model": model_id, "messages": [{"role": "user", "content": [
        {"type": "text", "text": text}, {"type": "image_url", "image_url": {"url": image_url}}]}],
        "temperature": 0, "max_tokens": 3000}


def _parse_cast(data: dict, n: int) -> Optional[dict]:
    try:
        content = data["choices"][0]["message"]["content"]
    except Exception:
        return None
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    if not isinstance(content, str) or not content.strip():
        return None
    m = re.search(r"\{.*\}", content, re.S)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except Exception:
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("pairs", []), list) or not isinstance(obj.get("repeats", []), list):
        return None
    ok_num = lambda x: isinstance(x, int) and not isinstance(x, bool) and 1 <= x <= n  # noqa: E731
    pairs = [[a, b] for p in obj.get("pairs", []) if isinstance(p, list) and len(p) == 2
             for a, b in [(p[0], p[1])] if ok_num(a) and ok_num(b) and a != b]
    repeats = []
    for r in obj.get("repeats", []):
        if not isinstance(r, dict) or r.get("kind") not in _REPEAT_KINDS or not isinstance(r.get("numbers"), list):
            continue
        nums = sorted({x for x in r["numbers"] if ok_num(x)})
        if len(nums) >= _REPEAT_MIN[r["kind"]]:
            repeats.append({"kind": r["kind"], "numbers": nums, "what": str(r.get("what") or "")[:80]})
    return {"pairs": pairs, "repeats": repeats}


def cast_sends_back(result: dict, ids: list, spared: set, limit: int = CAST_RESHOOT_MAX) -> dict:
    """{houseguest id: reason in words} of the photos to re-shoot: the LATER photo of each look-alike pair, and every photo
    after the first of a repeat. A photo in `spared` (already re-shot once) is never sent back; at most `limit` in all."""
    out: dict = {}
    def add(num: int, key: str) -> None:
        hid = ids[num - 1]
        if hid not in spared and hid not in out and len(out) < limit:
            out[hid] = CAST_REASON_WORDS[key]
    for a, b in result.get("pairs", []):
        add(max(a, b), "pair")
    for r in result.get("repeats", []):
        for num in r["numbers"][1:]:
            add(num, r["kind"])
    return out


async def _cast_call(pngs: list, user) -> Optional[dict]:
    import httpx
    sheet = contact_sheet(pngs)
    if sheet is None:
        return None
    model_id = _check_model_id(user)
    url, headers = await asyncio.to_thread(_resolve_deepseek, model_id, user or None)
    async with httpx.AsyncClient(timeout=CHECK_TIMEOUT_S * 2) as client:
        resp = await client.post(url, json=build_cast_request(model_id, sheet, len(pngs)), headers=headers)
    if resp.status_code != 200:
        logger.info("[portrait-check] cast http %s", resp.status_code)
        return None
    data = resp.json()
    if not isinstance(data, dict):
        return None
    cost = _record_spend(user, data, call_class=CAST_CALL_CLASS)
    result = _parse_cast(data, len(pngs))
    if result is not None and cost is not None:
        result["cost"] = cost
    return result


async def check_cast(pngs: list, user) -> Optional[dict]:
    """ONE vision call over a contact sheet of the cast: {"pairs": [[i, j]], "repeats": [{kind, numbers, what}]} (1-based
    photo numbers), or None when skipped (fail open). Never raises. Needs at least 3 photos."""
    try:
        from src import orwell_portraits as P
        if P.image_gen_disabled() or not check_enabled(user) or len(pngs or []) < 3:
            return None
        return await asyncio.wait_for(_cast_call(pngs, user), timeout=CHECK_TIMEOUT_S * 2)
    except BaseException as e:  # failsoft-ok: fail-open (the cast stands as shot)
        if isinstance(e, (KeyboardInterrupt, SystemExit)) or (
                isinstance(e, asyncio.CancelledError) and not isinstance(e, asyncio.TimeoutError)):
            raise
        logger.info("[portrait-check] cast look skipped: %s", type(e).__name__)
        return None


def check_enabled(user) -> bool:
    try:
        from src.settings import get_user_setting
        v = get_user_setting("portrait_check_enabled", owner=user or "", default=True)
        if isinstance(v, str):  # ORW-437: a persisted "false" / "0" / "off" must disable the check (bool("false") is True)
            return v.strip().lower() not in ("false", "0", "off", "no", "")
        return bool(v)
    except Exception:
        return False


def _face_tag() -> str:
    """ORW-953: which face a skipped check was for (the id the portrait run is working on), for the log line. Never raises."""
    try:
        from src import orwell_portraits as P
        return P._hid_tag()
    except Exception:  # failsoft-ok: best-effort-enrichment (a log label only)
        return "unknown face"


async def check_portrait(png: bytes, facts: dict, user) -> Optional[dict]:
    """{"ok": bool, "problems": [codes]}, or None when the check was skipped (fail open). Never raises."""
    try:
        from src import orwell_portraits as P
        if P.image_gen_disabled() or not check_enabled(user) or not png:
            return None
        return await asyncio.wait_for(_call(png, facts or {}, user), timeout=CHECK_TIMEOUT_S)
    except BaseException as e:  # failsoft-ok: fail-open (the photo is kept as is)
        if isinstance(e, (KeyboardInterrupt, SystemExit)) or (
                isinstance(e, asyncio.CancelledError) and not isinstance(e, asyncio.TimeoutError)):
            raise
        logger.info("[portrait-check] skipped: %s (%s)", type(e).__name__, _face_tag())
        return None
