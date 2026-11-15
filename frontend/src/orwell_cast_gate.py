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


_YEARS = re.compile(r"\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty)[- ]years?\b", re.I)


def background_codes(card: dict) -> list:
    """`background` (genesis) and `biography` (authoring) state one life: a different year count in the two is a conflict."""
    bg, bio = card.get("background"), card.get("biography")
    if not (isinstance(bg, str) and isinstance(bio, str)):
        return []
    a = {m.group(1).lower() for m in _YEARS.finditer(bg)}
    b = {m.group(1).lower() for m in _YEARS.finditer(bio)}
    return ["background-years"] if a and b and not (a & b) else []


def mend(profile: dict, npc: dict) -> list:
    """Deterministic repairs on the profile in place: the story repairs (name, pronoun, age, feature, show name for
    the biography and identityConcept) and . Returns codes."""
    from src import orwell_cast_authoring as A
    done = list(A.repair_story(profile, npc))
    return done


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
               "mark": _norm(phys.get("distinguishingMark"))}
        # cast-level repetition: REPORT-ONLY codes (counted in the season line); the writer is told what is taken
        for code, key in (("rep-oncamera-end", "oncam_end"), ("rep-ident-open", "ident_open"), ("rep-mark", "mark")):
            if rec[key] and any(r.get(key) == rec[key] for o, r in self.registry.items() if o != hid):
                self.count([code])
        self.registry[hid] = rec

    def taken_phrases(self, hid: str) -> dict:
        """What earlier cards in this cast already use, for the next writer's prompt (writer-side repetition fix)."""
        out = {"oncamera_endings": [], "identity_openers": [], "marks": []}
        for o, r in self.registry.items():
            if o == hid:
                continue
            for k, key in (("oncamera_endings", "oncam_end"), ("identity_openers", "ident_open"), ("marks", "mark")):
                if r.get(key) and r[key] not in out[k]:
                    out[k].append(r[key])
        return {k: v for k, v in out.items() if v}

    def summary_line(self) -> str:
        per = ",".join(f"{k}={v}" for k, v in sorted(self.codes.items())) or "none"
        return (f"[cast-gate] season line: checked={self.checked} repaired={self.repaired} "
                f"rewritten={self.rewritten} failing={self.failing} accepted-with-non-blocking={self.accepted_soft} codes={per}")

    def log_summary(self) -> None:
        if self.checked:
            logger.info(self.summary_line())


RewriteFn = Callable[[dict, list], Awaitable[Optional[dict]]]


async def run_gate(gate: SeasonGate, profile: dict, npc: dict, cast, rewrite_fn: Optional[RewriteFn]):
    """Gate one card. Returns (profile_to_write_or_None, codes_left). Mends in place; re-writes (at most
    GATE_REWRITE_BOUND, only for BLOCKING codes) via `rewrite_fn(npc, codes) -> new profile or None`. A card still
    blocking is left not authored with a RED soft-fail (id + codes); non-blocking codes never hold a card back."""
    hid = str((npc or {}).get("id") or "")
    gate.checked += 1
    first = card_codes(profile, npc, cast, gate.registry)
    gate.count(first)
    if mend(profile, npc):
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
            mend(merged, npc)
            profile.clear()
            profile.update(merged)
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
