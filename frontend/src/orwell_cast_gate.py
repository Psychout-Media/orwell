"""ORW-431: the ONE gate at the end of cast authoring.

Every authored card passes here, on the FINAL card (the roster card overlaid with the profile about to be written),
after the writers and repairs have run and BEFORE the write-back. A card that fails is mended deterministically where a
rule exists (ORW-388/430 `repair_story`, a trim to the last sentence end), else re-written a bounded number of times,
else left NOT authored (so the season start keeps waiting for it) with a RED soft-fail naming the houseguest id and the
reason codes. The gate works on public card text only and logs codes and ids only, never card text (the Vault Wall).
Pure helpers here; `orwell_cast_authoring.author_cast` owns the call site and the model call.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

BIO_OVERSIZE_CHARS = 720  # ORW-437: 1.5 x the 480-character ask in `rewrite_message`
GATE_REWRITE_BOUND = 2  # re-writes per card per run (each is one model call, inside the per-season give-up cap)
_ENDS = re.compile(r"[.!?][\"'”’)\]]*$")
_SENT_END = re.compile(r"[.!?][\"'”’)\]]*(?=\s|$)")
_NORM = re.compile(r"[^a-z0-9]+")


def gate_enabled() -> bool:
    return os.environ.get("ORWELL_CAST_GATE", "1").strip().lower() not in ("0", "false", "off", "no")


def ends_cleanly(text: str) -> bool:
    return bool(isinstance(text, str) and _ENDS.search(text.strip()))


def _norm(text) -> str:
    return _NORM.sub(" ", str(text or "").lower()).strip()


def _merged(profile: dict, npc: dict) -> dict:
    out = dict(npc or {})
    for k, v in (profile or {}).items():
        if k == "physicalCharacteristics" and isinstance(v, dict):
            out[k] = {**(out.get(k) or {}), **v}
        elif v not in (None, "", [], {}):
            out[k] = v
    return out


def _subject(text: str, npc: dict, cast) -> str:
    """The first name opening the text, when it is a first name on this cast ("" otherwise)."""
    m = re.match(r"\s*([A-Z][a-z'\-]+)\b", text or "")
    if not m:
        return ""
    low = m.group(1).lower()
    names = {str(c.get("name") or "").split(" ")[0].lower() for c in (cast or []) if isinstance(c, dict)}
    names.add(str((npc or {}).get("name") or "").split(" ")[0].lower())
    return low if low in names else ""


_ONES = "one two three four five six seven eight nine".split()
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
_NUM_WORDS = {w: str(i) for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen "
    "eighteen nineteen".split())}
_NUM_WORDS.update({k: str(v) for k, v in _TENS.items()})
# a compound ("thirty-five") must be read whole, or "five years" would be taken out of the middle of it (review of #2748)
_YEARS = re.compile(
    r"\b(?:(" + "|".join(_TENS) + r")[- ](" + "|".join(_ONES) + r")|(\d{1,3}|" + "|".join(_NUM_WORDS) + r"))[- ]years?\b", re.I)


def _year_counts(text: str) -> set:
    """The year counts a text states, spelled-out and numeric forms normalised ("eight years" == "8 years",
    "thirty-five years" == "35 years")."""
    out = set()
    for m in _YEARS.finditer(text):
        if m.group(1):
            out.add(str(_TENS[m.group(1).lower()] + _ONES.index(m.group(2).lower()) + 1))
        else:
            tok = m.group(3).lower()
            out.add(_NUM_WORDS.get(tok, str(int(tok)) if tok.isdigit() else tok))
    return out


def background_codes(card: dict) -> list:
    """`background` (genesis) and `biography` (authoring) state one life: a different year count in the two is a conflict."""
    bg, bio = card.get("background"), card.get("biography")
    if not (isinstance(bg, str) and isinstance(bio, str)):
        return []
    a = _year_counts(bg)
    b = _year_counts(bio)
    return ["background-years"] if a and b and not (a & b) else []


def mend(profile: dict, npc: dict, cast=None) -> list:
    """Deterministic repairs on the profile in place: the story repairs (name, pronoun, age, feature, show name for
    the biography and identityConcept) and . Returns codes."""
    from src import orwell_cast_authoring as A
    done = list(A.repair_story(profile, npc, cast))
    if _drop_name_from_oncamera(profile, npc):
        done.append("oncamera-name")
    return done


_IRREGULAR_PLURAL = {"is": "are", "has": "have", "does": "do", "goes": "go", "was": "were"}


def plural_verb(v: str):
    """The plural form of a third-person singular verb ("stands" -> "stand"), or None when it cannot be done safely."""
    w = v.lower()
    if w in _IRREGULAR_PLURAL:
        return _IRREGULAR_PLURAL[w]
    if not re.fullmatch(r"[a-z]+s", w) or re.search(r"(?:ss|us|ous|ics)$", w) or len(w) < 4:
        return None
    if re.search(r"[^aeiou]ies$", w):
        return w[:-3] + "y"
    if re.search(r"(?:ch|sh|x|z|ss|o)es$", w):
        return w[:-2]
    return w[:-1]


def _drop_name_from_oncamera(profile: dict, npc: dict) -> bool:
    """The card's own first name never rides in the on-camera line (it reaches the image provider): it becomes the pronoun
    (the possessive for "Name's"). For a they/them card the verb after it is made plural ("they stand"), or the safe wording
    "the houseguest" is used when it cannot be."""
    phys = (profile or {}).get("physicalCharacteristics")
    cam = phys.get("onCamera") if isinstance(phys, dict) else None
    first = str((npc or {}).get("name") or "").split(" ")[0]
    if not (isinstance(cam, str) and first and re.search(r"\b%s\b" % re.escape(first), cam)):
        return False
    pin = str((npc or {}).get("genderPresentation") or "").lower()
    subj, poss = {"man": ("he", "his"), "woman": ("she", "her")}.get(pin, ("they", "their"))
    plural = subj == "they"
    esc = re.escape(first)
    out = re.sub(r"\b%s(?:'s|\u2019s)(?![^\W\d_])" % esc, poss, cam)
    pat = re.compile(r"\b%s(?![^\W_-])" % esc)
    for _ in range(20):
        m = pat.search(out)
        if not m:
            break
        head, rest = out[:m.start()], out[m.end():]
        initial = head.strip() == "" or re.search(r"[.!?]\s+$", head) is not None
        if not plural:
            word = subj.capitalize() if initial else subj
        else:
            vm = re.match(r"^(\s+)((?:[A-Za-z]+ly\s+)?)([A-Za-z]+)", rest)
            if vm is None:
                word = "They" if initial else "they"
            else:
                pv = plural_verb(vm.group(3))
                if pv is None:
                    word = "The houseguest" if initial else "the houseguest"
                else:
                    word = "They" if initial else "they"
                    rest = vm.group(1) + vm.group(2) + pv + rest[vm.end():]
        out = head + word + rest
    if out == cam:
        return False
    if out[:1].islower():
        out = out[:1].upper() + out[1:]
    phys["onCamera"] = out
    return True


# TWO TIERS (Kevin's coordinator, 2026-11-15). A season must never wait on a non-blocking code.
# BLOCKING: the card is left NOT authored after the deterministic mend and a bounded number of re-writes.
BLOCKING = frozenset({
    "story-no-biography",                                   # no biography
    "identity-missing",                                     # no identity
    "story-name", "story-cast-name", "identity-name", "identity-cast-name",   # the houseguest's own name
    "story-pronoun", "identity-pronoun",                    # pronouns
    "story-age", "identity-age",                            # stated age
    "bio-dup-text",                                         # duplicated biography
})
# NON-BLOCKING: the card is accepted, the code is counted on the season line and recorded as a soft-fail, and the existing
# backfill (look fields) or upgrader is asked to fill it later. Anything not in BLOCKING is non-blocking.


def is_blocking(code: str) -> bool:
    return code in BLOCKING


def card_codes(profile: dict, npc: dict, cast=None, registry: Optional[dict] = None) -> list:
    """Every reason the final card fails the gate ([] = passes). Codes only. The consistency core is ORW-430's
    `card_consistency` (one implementation of each check); this adds the extras it does not cover."""
    from src import orwell_cast_authoring as A
    card = _merged(profile, npc)
    hid = str((npc or {}).get("id") or "")
    codes = list(A.card_consistency({**profile, "biography": card.get("biography") or profile.get("biography")}, card, cast))
    bio = card.get("biography")
    ident = card.get("identityConcept")
    if isinstance(bio, str) and bio.strip() and not ends_cleanly(bio):
        codes.append("bio-no-stop")
    if isinstance(bio, str) and bio.strip():
        # ORW-437: the format the rewrite message asks for (2-3 sentences, about 480 characters). NON-BLOCKING and counted: a
        # prod cast writer runs near 500 characters, so only a text 50% over the ask (or past three sentences) is reported.
        if len(bio) > BIO_OVERSIZE_CHARS or len(_SENT_END.findall(bio)) > 3:
            codes.append("bio-format")
    first = str(card.get("name") or "").split(" ")[0]
    if isinstance(bio, str) and bio.strip() and first and not re.search(r"\b%s\b" % re.escape(first), bio, re.I):
        codes.append("bio-no-own-name")  # non-blocking: a floor biography (written with no name) reads as a fragment
    v = card.get("voice")
    if not (isinstance(v, dict) and v and v.get("lexicon")):
        codes.append("voice-missing")
    codes += background_codes(card)
    if registry is not None and isinstance(bio, str) and bio.strip():
        for other, rec in registry.items():
            if other != hid and _norm(bio) and _norm(bio) == rec.get("bio"):
                codes.append("bio-dup-text")
                break
        subj = _subject(bio, card, cast)
        if subj and any(r.get("subject") == subj for o, r in registry.items() if o != hid):
            codes.append("bio-dup-subject")
        if isinstance(ident, str) and _norm(ident) and any(r.get("ident") == _norm(ident) for o, r in registry.items() if o != hid):
            codes.append("ident-dup-text")
    seen: set = set()
    return [c for c in codes if not (c in seen or seen.add(c))]


def rewrite_message(codes: list) -> str:
    return ("The biography failed the final check (" + ", ".join(codes) + "). Write the COMPLETE JSON object again. The "
            "biography is 2-3 whole sentences (under 480 characters, ending on a full stop), about the houseguest named "
            "on the card by that exact first name and the pronouns on the card, the stated age only, no look feature the "
            "look lacks, never \"Big Brother\"; include voice, physicalCharacteristics with wardrobe and an identityConcept.")


class SeasonGate:
    """One run's tallies and the registry of accepted texts (for the cross-cast checks). Counts and codes only."""

    def __init__(self, user: Optional[str] = None):
        self.user = user
        self.checked = self.repaired = self.rewritten = self.failing = self.accepted_soft = 0
        self.rep_rewritten = self.rep_fixed = 0  # cast-repetition re-writes asked and kept
        self.codes: dict = {}
        self.registry: dict = {}

    def count(self, codes) -> None:
        for c in codes:
            self.codes[c] = self.codes.get(c, 0) + 1

    def accept(self, hid: str, profile: dict, npc: dict, cast) -> None:
        card = _merged(profile, npc)
        bio = card.get("biography") or ""
        phys = card.get("physicalCharacteristics") if isinstance(card.get("physicalCharacteristics"), dict) else {}
        rec = {"bio": _norm(bio), "ident": _norm(card.get("identityConcept")),
               "subject": _subject(bio, card, cast),
               "oncam_end": " ".join(_norm(phys.get("onCamera")).split()[-3:]),
               "ident_open": " ".join(_norm(card.get("identityConcept")).split()[:2]),
               "oncam_open": " ".join(_norm(phys.get("onCamera")).split()[:3]),
               "mark": ("" if _norm(phys.get("distinguishingMark")).startswith("none") else _norm(phys.get("distinguishingMark")))}  # "none notable" is the engine's deliberately repeated plain face, not a repeated mark
        # cast-level repetition: REPORT-ONLY codes (counted in the season line); the writer is told what is taken
        for code, key in (("rep-oncamera-end", "oncam_end"), ("rep-ident-open", "ident_open"), ("rep-mark", "mark")):
            if rec[key] and any(r.get(key) == rec[key] for o, r in self.registry.items() if o != hid):
                self.count([code])
        self.registry[hid] = rec

    def repeats(self, hid: str, profile: dict, npc: dict, cast) -> dict:
        """Which cast-level repetition this card would add against the cards already accepted: {"identity": opening,
        "oncamera": ending} (only the keys that repeat). Pure; earlier cards only, so only a LATER card is ever named."""
        card = _merged(profile, npc)
        phys = card.get("physicalCharacteristics") if isinstance(card.get("physicalCharacteristics"), dict) else {}
        ident_open = " ".join(_norm(card.get("identityConcept")).split()[:2])
        oncam_end = " ".join(_norm(phys.get("onCamera")).split()[-3:])
        out = {}
        first = str(card.get("name") or "").split(" ")[0]
        if first and re.search(r"\b%s\b" % re.escape(first), str(card.get("identityConcept") or "")):
            out["identity-name"] = first  # the identity line names the person: it is read beside the card, never needs the name
        if ident_open and any(r.get("ident_open") == ident_open for o, r in self.registry.items() if o != hid):
            out["identity"] = ident_open
        if oncam_end and any(r.get("oncam_end") == oncam_end for o, r in self.registry.items() if o != hid):
            out["oncamera"] = oncam_end
        return out

    def taken_phrases(self, hid: str) -> dict:
        """What earlier cards in this cast already use, for the next writer's prompt (writer-side repetition fix)."""
        out = {"oncamera_endings": [], "oncamera_openings": [], "identity_openers": [], "marks": []}
        for o, r in self.registry.items():
            if o == hid:
                continue
            for k, key in (("oncamera_endings", "oncam_end"), ("oncamera_openings", "oncam_open"), ("identity_openers", "ident_open"), ("marks", "mark")):
                if r.get(key) and r[key] not in out[k]:
                    out[k].append(r[key])
        return {k: v for k, v in out.items() if v}

    def summary_line(self) -> str:
        per = ",".join(f"{k}={v}" for k, v in sorted(self.codes.items())) or "none"
        return (f"[cast-gate] season line: checked={self.checked} repaired={self.repaired} "
                f"rewritten={self.rewritten} failing={self.failing} accepted-with-non-blocking={self.accepted_soft} codes={per} "
                f"rep-rewritten={self.rep_rewritten} rep-fixed={self.rep_fixed}")

    def log_summary(self) -> None:
        if self.checked:
            logger.info(self.summary_line())


RewriteFn = Callable[..., Awaitable[Optional[dict]]]


def repetition_message(repeats: dict, taken: dict) -> str:
    """The one-field rewrite ask: name the phrasing to avoid and the openings or endings the other cards already use."""
    parts = []
    if "identity" in repeats:
        used = "; ".join(f'"{x}"' for x in (taken.get("identity_openers") or [])[:8])
        parts.append(f'the identityConcept opens with "{repeats["identity"]}", which another card in this cast already opens with'
                     f" (openings taken: {used}); open it a different way")
    if "identity-name" in repeats:
        parts.append("the identityConcept uses the person's name; write it again without the name, as one complete phrase that reads "
                     "as a sentence")
    if "oncamera" in repeats:
        used = "; ".join(f'"{x}"' for x in (taken.get("oncamera_endings") or [])[:8])
        parts.append(f'the physicalCharacteristics.onCamera line ends "{repeats["oncamera"]}", which another card already ends with'
                     f" (endings taken: {used}); end it a different way")
    return ("Only this needs fixing: " + " and ".join(parts) + ". Write the COMPLETE JSON object again with the same "
            "person: same name, pronouns, age, voice, biography and look; change nothing except the wording named above.")


_ACCESSORY_RE = re.compile(r"\b(?:nose (?:ring|stud|piercing)|lip (?:ring|stud)|septum|eyebrow (?:ring|piercing)|piercings?|ear ?rings?|hoops?)\b", re.I)
_HAIR_COLOUR_RE = re.compile(
    r"\b(pink|blue|green|purple|violet|orange|teal|blond|blonde|red|auburn|ginger|copper|black|brown|chestnut|grey|gray|silver|white|platinum)\s+hair\b", re.I)


def _oncamera_ok(cand: dict, npc: dict, cast) -> bool:
    """The rewritten on-camera line goes through the same look checks as a first-pass one, and may not invent a look feature
    (glasses, a piercing, a tattoo, a hair colour) the card's own look lacks."""
    from src import orwell_cast_authoring as A
    if A.look_problems(cand, npc):
        return False
    pc = dict(cand.get("physicalCharacteristics") or {})
    cam = str(pc.pop("onCamera", "") or "")
    base = {**cand, "physicalCharacteristics": pc}
    if A.story_missing_features(cam, base, npc):
        return False
    look = A._look_text(base, npc)
    if _ACCESSORY_RE.search(cam) and not _ACCESSORY_RE.search(look):
        return False
    hair = (str(pc.get("hair") or "") + " " + str(pc.get("photoHair") or "")).lower()
    for m in _HAIR_COLOUR_RE.finditer(cam):
        if m.group(1).lower() not in hair:
            return False
    return True


def _identity_ok(text: str) -> bool:
    return isinstance(text, str) and 12 <= len(" ".join(text.split())) <= 250  # the same bounds a first-pass identity gets


async def _repetition_rewrite(gate: SeasonGate, profile: dict, npc: dict, cast, rewrite_fn, hid: str) -> None:
    """At most ONE re-write of the repeated field(s) of a LATER card (the first card to use a phrasing keeps it), inside the
    gate's budget. Only identityConcept and physicalCharacteristics.onCamera can change, and only when the new text passes
    the whole gate and no longer repeats; otherwise the card ships as it is, still carrying the non-blocking code."""
    rep = gate.repeats(hid, profile, npc, cast)
    if not rep:
        return
    gate.rep_rewritten += 1
    try:
        fresh = await rewrite_fn(npc, ["rep"], message=repetition_message(rep, gate.taken_phrases(hid)))
    except Exception as e:  # failsoft-ok: a failed re-write leaves the card as it is
        logger.warning(f"[cast-gate] repetition re-write call failed for {hid}: {type(e).__name__}")
        return
    if not isinstance(fresh, dict):
        return
    new_ident = fresh.get("identityConcept")
    new_phys = fresh.get("physicalCharacteristics")
    new_cam = new_phys.get("onCamera") if isinstance(new_phys, dict) else None
    # each repeated field is judged on its own: kept only when the new text passes the whole gate and no longer repeats
    for key, ok in (("identity", isinstance(new_ident, str) and new_ident.strip()),
                    ("identity-name", isinstance(new_ident, str) and new_ident.strip()),
                    ("oncamera", isinstance(new_cam, str) and new_cam.strip())):
        if key not in rep or not ok:
            continue
        cand = {k: (dict(v) if isinstance(v, dict) else v) for k, v in profile.items()}
        if key in ("identity", "identity-name"):
            if key == "identity-name" and "identity" in rep:
                continue  # one identity rewrite answers both asks
            cand["identityConcept"] = new_ident
        else:
            base = cand.get("physicalCharacteristics")
            base = dict(base) if isinstance(base, dict) else dict((npc or {}).get("physicalCharacteristics") or {})
            base["onCamera"] = new_cam
            cand["physicalCharacteristics"] = base
        mend(cand, npc, cast)
        if any(is_blocking(c) for c in card_codes(cand, npc, cast, gate.registry)):
            continue
        if key in ("identity", "identity-name") and not _identity_ok(cand.get("identityConcept")):
            continue
        if key == "oncamera" and not _oncamera_ok(cand, npc, cast):
            continue
        still = gate.repeats(hid, cand, npc, cast)
        asked = [k for k in rep if k.startswith("identity")] if key.startswith("identity") else [key]
        if any(k in still for k in asked):
            continue  # it still repeats (or still names the person): that field ships as it is (fail open, the code is counted as before)
        profile.clear()
        profile.update(cand)
        gate.rep_fixed += 1


async def run_gate(gate: SeasonGate, profile: dict, npc: dict, cast, rewrite_fn: Optional[RewriteFn]):
    """Gate one card. Returns (profile_to_write_or_None, codes_left). Mends in place; re-writes (at most
    GATE_REWRITE_BOUND, only for BLOCKING codes) via `rewrite_fn(npc, codes) -> new profile or None`. A card still
    blocking is left not authored with a RED soft-fail (id + codes); non-blocking codes never hold a card back."""
    hid = str((npc or {}).get("id") or "")
    gate.checked += 1
    first = card_codes(profile, npc, cast, gate.registry)
    gate.count(first)
    if mend(profile, npc, cast):
        gate.repaired += 1
    codes = card_codes(profile, npc, cast, gate.registry)
    tries = 0
    while any(is_blocking(c) for c in codes) and rewrite_fn is not None and tries < GATE_REWRITE_BOUND:
        tries += 1
        try:
            fresh = await rewrite_fn(npc, [c for c in codes if is_blocking(c)])
        except Exception as e:  # failsoft-ok: a failed re-write is a failed attempt, never an abort
            logger.warning(f"[cast-gate] re-write call failed for {hid}: {type(e).__name__}")
            fresh = None
        if tries == 1:
            gate.rewritten += 1
        if isinstance(fresh, dict):
            # keep the first draft's look/voice/hidden fields the re-write did not return; the story text is the new one
            merged = {**profile, **{k: v for k, v in fresh.items() if v not in (None, "", [], {})}}
            if isinstance(profile.get("physicalCharacteristics"), dict) and isinstance(merged.get("physicalCharacteristics"), dict):
                # ORW-437: deep-merge the look, so an optional sub-field the re-write omitted keeps the first draft's value
                merged["physicalCharacteristics"] = {**profile["physicalCharacteristics"], **{
                    k: v for k, v in merged["physicalCharacteristics"].items() if v not in (None, "", [], {})}}
            mend(merged, npc, cast)
            profile.clear()
            profile.update(merged)
        codes = card_codes(profile, npc, cast, gate.registry)
    if (rewrite_fn is not None and tries < GATE_REWRITE_BOUND and not any(is_blocking(c) for c in codes)
            and not (npc or {}).get("met") and not (npc or {}).get("introduced")):
        await _repetition_rewrite(gate, profile, npc, cast, rewrite_fn, hid)
        codes = card_codes(profile, npc, cast, gate.registry)
    blocking = [c for c in codes if is_blocking(c)]
    soft = [c for c in codes if not is_blocking(c)]
    logger.debug(f"[cast-gate] {hid} tier={'blocking' if blocking else ('non-blocking' if soft else 'clean')} "
                 f"codes={','.join(codes) or '-'} rewrites={tries}")
    if blocking:
        gate.failing += 1
        try:
            from src import log_rings
            log_rings.record_soft_failure(
                "cast-gate:failed", f"card {hid} failed the final gate: {', '.join(blocking)} - left not authored",
                corrected="left-unauthored", user=gate.user, houseguest=hid)
        except Exception:  # failsoft-ok: the record must never break authoring
            pass
        logger.warning(f"[cast-gate] {hid} left not authored: {', '.join(blocking)}")
        return None, codes
    if soft:
        gate.accepted_soft += 1
        try:
            from src import log_rings
            log_rings.record_soft_failure(
                "cast-gate:non-blocking", f"card {hid} accepted with: {', '.join(soft)} - the backfill is asked to fill it",
                corrected="accepted-backfill-later", user=gate.user, houseguest=hid)
        except Exception:  # failsoft-ok
            pass
    gate.accept(hid, profile, npc, cast)
    return profile, codes
