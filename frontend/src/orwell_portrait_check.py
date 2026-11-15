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
    "text-or-logo": "no text or logos anywhere",
    "messy-hair": "neat, groomed hair with no flyaways or frizz",
    "bad-hands": "natural hands with five separate fingers, or keep the hands out of frame",
    "mouth-mid-word": "a closed or gently smiling mouth, not caught mid-word",
    "skin-patch": "clear skin with no bruise, wound, bandage or patch on the face",
    "wrong-age": "the stated age",
    "wrong-clothes": "the stated clothing",
    "wrong-presentation": "clothes that match the stated gender presentation",
    "eyes-off": "eyes looking straight at the camera",
    "not-a-portrait": "a head-and-shoulders portrait photo",
    "missing-feature": "every stated visible feature (glasses, piercings, facial hair, hair colour and length)",
    # ORW-480: the realism codes
    "not-a-real-photo": "a real, unposed photograph with real skin texture, not a studio, stock, glossy or rendered look",
    "bad-held-object": "natural hands and held objects with correct fingers, grip and shape, or nothing held",
    "fake-clothes": "ordinary real garments with proper seams, fit and structure",
}
KNOWN_CODES = frozenset(PROBLEM_WORDS)


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
_HAIR_COLOUR_RE = re.compile(
    r"\b(?:jet black|blue-black|black|dark brown|light brown|chestnut|brown|blond|blonde|strawberry blonde|red|auburn|ginger|copper|"
    r"grey|gray|silver|white|platinum)\b", re.I)
_HAIR_LENGTH_RE = re.compile(r"\b(?:buzzed|shaved|cropped|close-cropped|short|chin-length|shoulder-length|long|waist-length)\b", re.I)


_HAIR_ACCESSORY_RE = re.compile(r"\b(?:with|tied|held|pinned|secured|clipped|topped|wrapped|tucked|under|beneath)\b", re.I)


def visible_features(prompt: str) -> list:
    """The visible features the brief states (glasses, piercings, facial hair, hair colour and length), as phrases.
    The hair colour and length are read from the brief's own `Hair: ...` clause in any word order (ORW-437: "tight black
    curls", "shoulder-length waves", "jet black"), else from the older "<colour> hair" wording."""
    out = []
    hm = _HAIR_CLAUSE_RE.search(prompt or "")
    for label, rx in _FEATURE_RES:
        if hm and label.startswith("hair"):
            continue
        m = re.search(rx, prompt or "", re.I)
        if m:
            out.append(m.group(0).lower() if label.startswith("hair") else label)
    if hm:
        # Only the hair itself: what follows an accessory word ("tied with a red ribbon") is not the hair colour.
        clause = _HAIR_ACCESSORY_RE.split(hm.group(1), maxsplit=1)[0]
        c, ln = _HAIR_COLOUR_RE.search(clause), _HAIR_LENGTH_RE.search(clause)
        if c:
            out.append(f"{c.group(0).lower()} hair")
        if ln:
            out.append(f"{ln.group(0).lower()} hair")
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
    if "unit photographer" in prompt and "The moment:" in prompt:
        # ORW-480: a candid brief. The moment may be a laugh, mid-word, looking away, with loose hairs: those are not faults.
        # Eyes on the lens only when the moment says so.
        facts["candid"] = True
        mm = re.search(r"The moment: ([^.]+)\.", prompt)
        facts["moment"] = mm.group(1).strip()[:200] if mm else ""
        if re.search(r"\b(?:into|at|straight into|directly into) the lens\b", facts["moment"], re.I):
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
        note = " (any clothing fits; never report wrong-presentation)" if facts["gender"] == "nonbinary" else ""
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
    "eyes-off (eyes not on the camera; only judge this when the facts say eyes on camera was asked), "
    "not-a-portrait (not a head-and-shoulders or waist-up portrait photo), "
    "missing-feature (a stated visible feature, such as glasses, a piercing, facial hair, the hair colour or length, is not in the photo)"
)


_REALISM_CHECKLIST = (
    "not-a-real-photo (it does not look like a real photograph: a glossy studio or stock-photo look, plastic or airbrushed skin, "
    "a rendered or illustrated look, a blurred-away background that hides the place), "
    "bad-held-object (hands or a held object look unnatural: wrong finger count, fused or bent fingers, a held thing with a wrong shape), "
    "fake-clothes (the clothes are not real garments: impossible construction, melted seams, a collar or lapel that makes no sense, a lanyard or badge as costume)"
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
        # deepseek-flash reasons before it answers; a small cap leaves the content empty.
        "max_tokens": 2000,
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
        if cost is None:
            # ORW-437: DeepSeek's own API returns no dollar cost; estimate it the way llm_core does, never ledger 0.0
            from src.llm_core import _deepseek_cost_estimate
            ptd = usage.get("prompt_tokens_details") if isinstance(usage.get("prompt_tokens_details"), dict) else {}
            cached = ptd.get("cached_tokens")
            if cached is None:
                cached = usage.get("prompt_cache_hit_tokens")
            cost = _deepseek_cost_estimate(str(data.get("model") or _check_model_id(user)), usage.get("prompt_tokens") or 0,
                                           cached or 0, usage.get("completion_tokens") or 0)
            estimated = cost is not None
            if not estimated:
                return None  # an unpriced model has no honest dollar figure: never ledger a 0.0 cost as if it were measured
        extra = {"cost_estimated": True} if estimated else {}
        orwell_token_ledger.record_turn(
            user, call_class=call_class,
            input_tokens=usage.get("prompt_tokens") or 0,
            output_tokens=usage.get("completion_tokens") or 0,
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
    async with httpx.AsyncClient(timeout=CHECK_TIMEOUT_S) as client:
        resp = await client.post(url, json=body, headers=headers)
    if resp.status_code != 200:
        logger.info("[portrait-check] http %s", resp.status_code)
        return None
    data = resp.json()
    if not isinstance(data, dict):
        return None
    cost = _record_spend(user, data)
    problems = _parse_problems(data)
    if problems and facts.get("gender") == "nonbinary":
        # no clothing contradicts a nonbinary presentation: the rule has no meaning there (review of #2748)
        problems = [p for p in problems if p != "wrong-presentation"]
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
        logger.info("[portrait-check] skipped: %s", type(e).__name__)
        return None
