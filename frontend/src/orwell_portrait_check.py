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
    m = re.search(r"Setting: the house ([^,.]+)", prompt)
    if m:
        facts["spot"] = m.group(1).strip()[:80]
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
        lines.append(f"Spot: the house {facts['spot']}")
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


def build_request(model_id: str, image_url: str, facts: dict) -> dict:
    text = (
        "You are a strict photo editor for a reality-TV cast portrait. Look at the photo and list only the "
        "problems that are clearly present. Checklist codes: " + _CHECKLIST + ".\n\n"
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


def _record_spend(user, data: dict) -> None:
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
                return  # an unpriced model has no honest dollar figure: never ledger a 0.0 cost as if it were measured
        extra = {"cost_estimated": True} if estimated else {}
        orwell_token_ledger.record_turn(
            user, call_class=CHECK_CALL_CLASS,
            input_tokens=usage.get("prompt_tokens") or 0,
            output_tokens=usage.get("completion_tokens") or 0,
            cost=cost or 0.0, provider=CHECK_PROVIDER, **extra)
    except Exception:  # failsoft-ok: observability (ledgering must never fail a portrait)
        pass


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
    _record_spend(user, data)
    problems = _parse_problems(data)
    if problems and facts.get("gender") == "nonbinary":
        # no clothing contradicts a nonbinary presentation: the rule has no meaning there (review of #2748)
        problems = [p for p in problems if p != "wrong-presentation"]
    if problems is None:
        return None
    return {"ok": not problems, "problems": problems}


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
