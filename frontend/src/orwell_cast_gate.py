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

BIO_ASK_CHARS = 480  # ORW-952: the length the cast prompt and `rewrite_message` ask for, from this one number so they match the gate
BIO_OVERSIZE_CHARS = BIO_ASK_CHARS * 3 // 2  # ORW-437: 1.5 x the ask (720)
REALISM_LOWPRIO_BUDGET = 6  # of those, the ones that are not about the look fitting the life (a prop, a smile, a gaze, a repeated garment)
REALISM_REWRITE_BUDGET = 12  # casting-director rewrites per cast: each is a model call inside the serialized gate, so the time it adds is bounded
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
    if _dealt_mark(profile, npc):
        done.append("mark-dealt")
    if _dedupe_mark(profile, npc):
        done.append("mark-duplicated")
    if _drop_name_from_oncamera(profile, npc):
        done.append("oncamera-name")
    if _drop_foreign_mark_words(profile, npc):
        done.append("mark-words-elsewhere")
    if _scrub_leaked_labels(profile):
        done.append("label-scrubbed")
    return done


_IRREGULAR_PLURAL = {"is": "are", "has": "have", "does": "do", "goes": "go", "was": "were"}


# Words ending in -s that are never a third-person verb after a name ("always stands"): left as they are (same list as the TS side).
_S_ADVERBS = frozenset((
    "always sometimes perhaps nevertheless besides otherwise towards afterwards backwards forwards upwards downwards regardless "
    "nowadays indoors outdoors overseas mostly thus anyways nonetheless meanwhile").split())


def plural_verb(v: str):
    """The plural form of a third-person singular verb ("stands" -> "stand"), or None when it cannot be done safely."""
    w = v.lower()
    if w in _S_ADVERBS:
        return None
    if w in _IRREGULAR_PLURAL:
        return _IRREGULAR_PLURAL[w]
    if not re.fullmatch(r"[a-z]+s", w) or re.search(r"(?:ss|us|ous|ics)$", w) or len(w) < 4:
        return None
    if len(w) == 4 and w.endswith("ies"):
        return w[:-1]  # lies, ties, dies, vies: "lie", not "ly" (review of #2781)
    if re.search(r"[^aeiou]uses$", w) and len(w) > 4:
        return None  # focuses, pauses: "focus" or "pause" cannot be told apart safely: the caller says "the houseguest"
    if re.search(r"[^aeiou]ies$", w):
        return w[:-3] + "y"
    if re.search(r"(?:ch|sh|x|z|ss|o)es$", w):
        return w[:-2]
    return w[:-1]


# Given names that are also everyday words or months: for these only the capitalised form is the name ("may" the verb is not). Same list as src/engine/commonWordNames.ts.
_COMMON_WORD_NAMES = frozenset((
    "may will grace hope summer faith mark art rose june april august dawn joy ivy pearl amber frank lane chase cliff drew gene guy hunter miles "
    "autumn winter storm river sky rain bill jack rich ray jay pat griffin penny trinity violet wade willow").split())
# Words after which a name is the subject of a new clause ("... and Namea stands").
_SUBJECT_INTRODUCERS = frozenset("and but while as then when because so if that where though until".split())


def _dealt_mark(profile: dict, npc: dict) -> bool:
    """The engine DEALS each houseguest's distinguishing mark (a pool of 44, each at most once per cast, about four per cast), and the
    dealt one is authoritative: a writer's own mark (it favoured "deep dimples" on three cards of one cast), or a rewrite that failed
    to differ, is put back to what was dealt. A card with no dealt mark on its roster entry is left as the writer wrote it."""
    dealt = ((npc or {}).get("physicalCharacteristics") or {}).get("distinguishingMark") if isinstance((npc or {}).get("physicalCharacteristics"), dict) else None
    phys = (profile or {}).get("physicalCharacteristics")
    if not (isinstance(dealt, str) and dealt.strip() and isinstance(phys, dict)):
        return False
    if " ".join(str(phys.get("distinguishingMark") or "").split()) == " ".join(dealt.split()):
        return False
    phys["distinguishingMark"] = dealt
    return True


def _scrub_leaked_labels(profile: dict) -> bool:
    """An internal category label ("red-pink", "brown-tan", "colour-any" ...) in any card text becomes its plain word: real people say red, pink,
    coral or tan. The prompts show only plain words; this is the net under them."""
    phys = (profile or {}).get("physicalCharacteristics")
    if not isinstance(phys, dict):
        return False
    try:
        from src import orwell_cast_realism as _R
    except Exception:  # failsoft-ok: the table never blocks a card
        return False
    changed = False
    for field in ("wardrobe", "style", "lookSignature", "onCamera", "photoHair", "facialFeatures", "hair"):
        v = phys.get(field)
        if isinstance(v, list):
            new = [_R.scrub_labels(x) if isinstance(x, str) else x for x in v]
        elif isinstance(v, str):
            new = _R.scrub_labels(v)
        else:
            continue
        if new != v:
            phys[field] = new
            changed = True
    return changed


_FACE_MARK_WORDS = re.compile(r"\b(?:dimples?|dimpled|freckles?|freckled|beauty marks?)\b", re.I)


def _drop_foreign_mark_words(profile: dict, npc: dict) -> bool:
    """A face mark (dimples, freckles, a beauty mark) is the dealt mark's alone: the writer's habit of putting "dimples creasing" into
    the on-camera or face line of a card that was not dealt them made the same face on several cards. The clause that names it is
    dropped from onCamera and facialFeatures unless the dealt mark carries that word; nothing is dropped when it would empty the line."""
    phys = (profile or {}).get("physicalCharacteristics")
    if not isinstance(phys, dict):
        return False
    mark = str(phys.get("distinguishingMark") or ((npc or {}).get("physicalCharacteristics") or {}).get("distinguishingMark") or "")
    allowed = {re.sub(r"(?:s|ed)$", "", w.lower()) for w in _FACE_MARK_WORDS.findall(mark)}
    changed = False
    for field in ("onCamera", "facialFeatures"):
        text = phys.get(field)
        if not isinstance(text, str) or not _FACE_MARK_WORDS.search(text):
            continue
        clauses = re.split(r"(?<=[,;.!?])\s+|\s+[\u2014\u2013-]\s+", text)
        kept = [c for c in clauses if not any(re.sub(r"(?:s|ed)$", "", w.lower()) not in allowed for w in _FACE_MARK_WORDS.findall(c))]
        if not kept or len(kept) == len(clauses):
            continue
        out = " ".join(kept).strip().rstrip(",;")
        if field == "onCamera" and not re.search(r"[.!?]$", out):
            out += "."
        phys[field] = out
        changed = True
    return changed


def _dedupe_mark(profile: dict, npc: dict) -> bool:
    """The distinguishing mark lives in distinguishingMark only: a clause of facialFeatures that restates it (a gap-toothed grin, the same
    freckles or glasses) is dropped. Clauses are cut at commas and "and"; nothing is dropped when it would leave the line empty."""
    phys = (profile or {}).get("physicalCharacteristics")
    if not isinstance(phys, dict):
        return False
    mark = _norm(phys.get("distinguishingMark") or ((npc or {}).get("physicalCharacteristics") or {}).get("distinguishingMark"))
    face = phys.get("facialFeatures")
    if not mark or mark.startswith("none") or not isinstance(face, str):
        return False
    stop = {"a", "an", "the", "of", "on", "in", "one", "small", "with", "and", "to", "at"}
    key = {w for w in mark.split() if w not in stop and len(w) > 3}
    if not key:
        return False
    parts = [p_ for p_ in re.split(r",\s*|\s+and\s+", face) if p_.strip()]
    kept = [p_ for p_ in parts if len({w for w in _norm(p_).split()} & key) < 1]
    if len(kept) == len(parts) or not kept:
        return False
    phys["facialFeatures"] = ", ".join(kept)
    return True


def _drop_name_from_oncamera(profile: dict, npc: dict) -> bool:
    """The card's own first name never rides in the on-camera line (it reaches the image provider): it becomes the pronoun
    (the possessive for "Name's"). For a they/them card the verb after it is made plural ("they stand"), or the safe wording
    "the houseguest" is used when it cannot be."""
    phys = (profile or {}).get("physicalCharacteristics")
    cam = phys.get("onCamera") if isinstance(phys, dict) else None
    first = str((npc or {}).get("name") or "").split(" ")[0]
    flags = 0 if first.lower() in _COMMON_WORD_NAMES else re.IGNORECASE  # "namea stands" is still the name; "may" the verb is not
    if not (isinstance(cam, str) and first and re.search(r"\b%s\b" % re.escape(first), cam, flags)):
        return False
    pin = str((npc or {}).get("genderPresentation") or "").lower()
    subj, poss = {"man": ("he", "his"), "woman": ("she", "her")}.get(pin, ("they", "their"))
    plural = subj == "they"
    esc = re.escape(first)
    out = re.sub(r"\b%s(?:'s|\u2019s)(?![^\W\d_])" % esc, poss, cam, flags=flags)
    pat = re.compile(r"\b%s(?![^\W_-])" % esc, flags)
    for _ in range(20):
        m = pat.search(out)
        if not m:
            break
        head, rest = out[:m.start()], out[m.end():]
        initial = head.strip() == "" or re.search(r"[.!?]\s+$", head) is not None
        pw = re.search(r"([A-Za-z]+)\s*$", head)
        subject_position = initial or re.search(r"[,;:\u2014\u2013(-]\s*$", head) is not None or (pw is not None and pw.group(1).lower() in _SUBJECT_INTRODUCERS)
        if not subject_position:
            word = "the houseguest"  # after a verb or preposition ("the camera catches Namea"): a subject pronoun would be ungrammatical
        elif not plural:
            word = subj.capitalize() if initial else subj
        else:
            vm = re.match(r"^(\s+)((?:(?:[A-Za-z]+ly|always|sometimes|often|never|perhaps)\s+)?)([A-Za-z]+)", rest)
            if re.match(r"^\s*,", rest):
                word = "The houseguest" if initial else "the houseguest"  # "Name, arms folded, stands ...": the verb is not next
            elif vm is None:
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


def _look_life_codes(card: dict) -> list:
    try:
        from src import orwell_cast_realism as _R
        return _R.believability_look_life(card)
    except Exception:  # failsoft-ok: the realism table never blocks a card
        return []


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
    codes += _look_life_codes(card)  # ORW-563: non-blocking and counted on the season line; the cast-level judge (orwell_cast_believability) decides who is re-picked
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
            "biography is 2-3 whole sentences (under " + str(BIO_ASK_CHARS) + " characters, ending on a full stop), about the houseguest named "
            "on the card by that exact first name and the pronouns on the card, the stated age only, no look feature the "
            "look lacks, never \"Big Brother\"; include voice, physicalCharacteristics with wardrobe and an identityConcept.")


_REALISM_ONCAMERA_KINDS = ("prop", "expression", "smile-kind", "gaze", "pose", "closing-read")  # the room is no longer asked of the writer
_REALISM_WARDROBE_KINDS = ("garment", "colour", "colour-any", "pattern", "signature", "look-fit")


def _realism_tags(card: dict) -> dict:
    try:
        from src import orwell_cast_realism as _R
        return _R.tag_card(card)
    except Exception:  # failsoft-ok: the realism table never blocks a card
        return {}


def _look_fit_failures(card: dict) -> list:
    try:
        from src import orwell_cast_realism as _R
        return _R.look_fits_life(card)
    except Exception:  # failsoft-ok: the realism table never blocks a card
        return []


def _plain(kind: str, value: str) -> str:
    try:
        from src import orwell_cast_realism as _R
        return _R.plain_label(kind, value)
    except Exception:  # failsoft-ok: the table never blocks a card
        return str(value).replace("-", " ")


_REALISM_ASK = {
    "look-fit": lambda v: ("clothes this person could really own and buy where they live on their own income, for their job, age and the "
                           "weather and coast of their hometown (nothing expensive-looking, no costume of a style family, no winter layers in a hot "
                           "state or beach clothes inland)"),
    "prop": lambda v: f"nothing in hand that reads as a {v} prop (no {v})",
    "expression": lambda v: "no smile, grin or smirk: a serious, wry, guarded, thoughtful or amused-without-smiling face",
    "smile-kind": lambda v: f"no {v} smile",
    "gaze": lambda v: "eyes not on the lens: looking away, down, or at something in the room",
    "pose": lambda v: f"not a {v} pose",
    "room": lambda v: f"not in the {v.replace('-', ' ')}: another house spot",
    "closing-read": lambda v: 'no closing "the one who ..." read',
    "garment": lambda v: f"no {v.replace('-', ' ')} among the pieces",
    "colour": lambda v: f"a main piece that is not {_plain('colour', v)}",
    "colour-any": lambda v: f"less {_plain('colour-any', v)} anywhere in the outfit (another colour for at least two pieces)",
    "pattern": lambda v: ("at least one piece with a pattern (stripes, plaid, a floral), a plain graphic with no words, or visible wear "
                          "(faded, worn-in), the way people really dress"),
    "signature": lambda v: ("a lookSignature (ONE memorable thing about how they look or dress, drawn from their life, that nobody else in the "
                            "cast has)" if v == "missing" else f"a lookSignature that is not about {_plain('signature', v)}: another card already has that"),
}


def _realism_ask(kinds: dict) -> str:
    return "; ".join(_REALISM_ASK.get(k, lambda v, k=k: f"no {v}")(v) for k, vals in kinds.items() for v in vals)


class SeasonGate:
    """One run's tallies and the registry of accepted texts (for the cross-cast checks). Counts and codes only."""

    def __init__(self, user: Optional[str] = None):
        self.user = user
        self.checked = self.repaired = self.rewritten = self.failing = self.accepted_soft = 0
        self.rep_rewritten = self.rep_fixed = 0  # cast-repetition re-writes asked and kept
        self.realism_rewrites = 0  # casting-director rewrites asked this run (bounded by REALISM_REWRITE_BUDGET)
        self.want_signature = False  # a real cast run asks for the memorable look signature (set by the authoring pass)
        self.wardrobe_asked: set = set()  # cards whose wardrobe has been sent for a casting-director rewrite
        self.realism_demand = 0  # cards that WANTED a casting-director rewrite (offenders found), budget or not
        self.realism_found = self.realism_fixed = 0  # ORW-480: casting-director offenders named, and the ones a rewrite cleared
        self.n = 0  # the cast size, from the first card gated
        self.codes: dict = {}
        self.believe: dict = {}  # ORW-563: the cast-level believability judge's tallies (calls, chars, flagged, repicked)
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
               "tags": _realism_tags(card),
               "hair_open": " ".join(_norm(phys.get("photoHair")).split()[:2]),
               "mark": ("" if _norm(phys.get("distinguishingMark")).startswith("none") else _norm(phys.get("distinguishingMark")))}  # "none notable" is the engine's deliberately repeated plain face, not a repeated mark
        # cast-level repetition: REPORT-ONLY codes (counted in the season line); the writer is told what is taken
        for code, key in (("rep-oncamera-end", "oncam_end"), ("rep-ident-open", "ident_open"), ("rep-mark", "mark")):
            if rec[key] and any(r.get(key) == rec[key] for o, r in self.registry.items() if o != hid):
                self.count([code])
        if self.want_signature and not str(phys.get("lookSignature") or "").strip():
            self.count(["realism-signature:none"])
        for x in _look_fit_failures(card):
            self.count([f"realism-look-fit:{x}"])  # family (a poor-fit dealt family), family-worn, upscale, climate, missing
        for kind, vals in self.realism_offenders(hid, card).items():
            for v in vals:
                self.count([f"realism-{kind}:{v}"])  # what the casting director found on this card, whether or not a rewrite cleared it
        self.registry[hid] = rec

    def realism_offenders(self, hid: str, card: dict) -> dict:
        """{kind: [value]} this card would add beyond the casting-director caps, against the cards already accepted (ORW-480)."""
        n = self.n or 15
        tags = _realism_tags(card)
        earlier = [r.get("tags") or {} for o, r in self.registry.items() if o != hid]
        try:
            from src import orwell_cast_realism as _R
            return _R.offenders_for(tags, earlier, n)
        except Exception:  # failsoft-ok: the realism table never blocks a card
            return {}

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
        off = self.realism_offenders(hid, card)
        cam = {k: v for k, v in off.items() if k in _REALISM_ONCAMERA_KINDS}
        wd = {k: v for k, v in off.items() if k in _REALISM_WARDROBE_KINDS}
        # a poor-fit dealt family alone also asks for a wardrobe from the person (the label cannot change, so it is asked once per card and
        # is not held against the rewrite afterwards)
        want = ("family-worn", "upscale", "climate", "missing") + (() if hid in self.wardrobe_asked else ("family",))
        lf = [x for x in _look_fit_failures(card) if x in want]
        if self.want_signature and not str(phys.get("lookSignature") or "").strip():
            wd.setdefault("signature", []).append("missing")  # the writer's own memorable thing (low priority: asked after the fit asks)
        if lf:  # ORW-480: clothes that do not fit this life (a poor-fit family worn, expensive looks, the wrong weather, none at all): rewritten from the person
            wd["look-fit"] = lf
        if cam:
            out["realism-oncamera"] = cam
        if wd:
            out["realism-wardrobe"] = wd
        if ident_open and any(r.get("ident_open") == ident_open for o, r in self.registry.items() if o != hid):
            out["identity"] = ident_open
        if oncam_end and any(r.get("oncam_end") == oncam_end for o, r in self.registry.items() if o != hid):
            out["oncamera"] = oncam_end
        return out

    def taken_phrases(self, hid: str) -> dict:
        """What earlier cards in this cast already use, for the next writer's prompt (writer-side repetition fix)."""
        out = {"oncamera_endings": [], "oncamera_openings": [], "photohair_openings": [], "identity_openers": [], "marks": []}
        for o, r in self.registry.items():
            if o == hid:
                continue
            for k, key in (("oncamera_endings", "oncam_end"), ("oncamera_openings", "oncam_open"), ("photohair_openings", "hair_open"), ("identity_openers", "ident_open"), ("marks", "mark")):
                if r.get(key) and r[key] not in out[k]:
                    out[k].append(r[key])
        try:
            from src import orwell_cast_realism as _R0
            _cap = _R0.cap_for("signature", "hair", self.n or 15)
        except Exception:  # failsoft-ok: the table never blocks a card
            _cap = 2
        _cnt: dict = {}
        for o, r in self.registry.items():
            if o != hid:
                for v in (r.get("tags") or {}).get("signature", []):
                    if v != "other":
                        _cnt[v] = _cnt.get(v, 0) + 1
        sigs = sorted(v for v, n_ in _cnt.items() if n_ >= _cap)  # only the kinds already FULL are named as taken
        if sigs:
            out["signatures"] = [_plain("signature", v) for v in sigs]  # plain words, never the internal category names
            try:
                from src import orwell_cast_realism as _R
                out["signatures_free"] = [_plain("signature", c) for c in _R.signature_categories() if c not in sigs]
            except Exception:  # failsoft-ok: the table never blocks a card
                pass
        full: list = []
        try:
            from src import orwell_cast_realism as _R2
            for kind in ("colour", "colour-any"):
                counts: dict = {}
                for o, r in self.registry.items():
                    if o != hid:
                        for v in set((r.get("tags") or {}).get(kind, [])):
                            counts[v] = counts.get(v, 0) + 1
                full += [_plain(kind, v) for v, n_ in counts.items() if n_ >= _R2.cap_for(kind, v, self.n or 15)]
        except Exception:  # failsoft-ok: the table never blocks a card
            pass
        if full:
            out["colours"] = sorted(set(full))  # the colour families already at their cap, in plain words
        return {k: v for k, v in out.items() if v}

    def marks_dealt(self) -> str:
        """The distinguishing marks this cast carries, by category: "3[glasses,freckles,tattoo]" (the cross-season note, ORW-480)."""
        kinds = [t["mark"][0] for t in (r.get("tags") or {} for r in self.registry.values()) if t.get("mark")]
        return f"{len(kinds)}[{','.join(sorted(kinds))}]"

    def summary_line(self) -> str:
        per = ",".join(f"{k}={v}" for k, v in sorted(self.codes.items())) or "none"
        return (f"[cast-gate] season line: checked={self.checked} repaired={self.repaired} "
                f"rewritten={self.rewritten} failing={self.failing} accepted-with-non-blocking={self.accepted_soft} codes={per} "
                f"rep-rewritten={self.rep_rewritten} rep-fixed={self.rep_fixed} realism-demand={self.realism_demand} "
                f"realism-asked={self.realism_rewrites}/{REALISM_REWRITE_BUDGET} realism-fixed={self.realism_fixed} marks={self.marks_dealt()}")

    def believability_line(self) -> str:
        from src import orwell_cast_believability as B
        return B.stats_line(self.believe)

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
    if "realism-oncamera" in repeats:
        parts.append("the onCamera line repeats what other cards in this cast already show (" + _realism_ask(repeats["realism-oncamera"])
                     + "); keep exactly one house spot, a still moment, the person's own pronoun and nothing that is not in their look")
    if "realism-wardrobe" in repeats:
        parts.append("the wardrobe repeats what other cards already wear (" + _realism_ask(repeats["realism-wardrobe"])
                     + "); two or three real garments a shop sells, chosen from this person's job, hometown, age and money; the "
                     "lookSignature is one thing someone would use to describe them to a friend, bought or done where they live"
                     + (f" (signature kinds already taken, do NOT use these: {', '.join(taken['signatures'])}; kinds still free, pick one that fits "
                        f"their life: {', '.join(taken.get('signatures_free') or [])})" if taken.get("signatures") else "")
                     + (f" (no more {', '.join(taken['colours'])}: use other colours)" if taken.get("colours") else ""))
    return ("Only this needs fixing: " + " and ".join(parts) + ". Reply with ONLY a JSON object holding just the field or fields "
            "named above (identityConcept, and/or physicalCharacteristics with onCamera and/or wardrobe, style and lookSignature; when the wardrobe is asked, give a short \"style\" line too that describes these very clothes in plain words and names no style family), for the same person: same "
            "pronouns, age and look; change nothing except the wording named above.")


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


def _wardrobe_ok(cand: dict, npc: dict) -> bool:
    """A rewritten wardrobe passes the same look checks as a first-pass one (shape, real garments, pronouns, the taken main piece)."""
    from src import orwell_cast_authoring as A
    return not [c for c in A.look_problems(cand, npc) if c != "style-wrong-family"]  # the dealt family is the poor fit being replaced: the style line is rewritten from the clothes


def _identity_ok(text: str) -> bool:
    return isinstance(text, str) and 12 <= len(" ".join(text.split())) <= 250  # the same bounds a first-pass identity gets


_WARDROBE_WEIGHT = {"look-fit": 5, "garment": 1, "colour": 1, "pattern": 1, "signature": 1}


def _wardrobe_score(wd) -> int:
    """How much a wardrobe still asks for: a look-fit offender weighs 5, any other offender 1 (the dealt-family flag weighs 2: it is asked once
    per card, so a later check never carries it)."""
    return sum((2 if (k == "look-fit" and x == "family") else _WARDROBE_WEIGHT.get(k, 1)) for k, v in (wd or {}).items() for x in v)


async def _repetition_rewrite(gate: SeasonGate, profile: dict, npc: dict, cast, rewrite_fn, hid: str) -> None:
    """At most ONE re-write of the repeated field(s) of a LATER card (the first card to use a phrasing keeps it), inside the
    gate's budget. Only identityConcept and physicalCharacteristics.onCamera can change, and only when the new text passes
    the whole gate and no longer repeats; otherwise the card ships as it is, still carrying the non-blocking code."""
    rep = gate.repeats(hid, profile, npc, cast)
    if any(k.startswith("realism-") for k in rep):
        gate.realism_demand += 1
    if gate.realism_rewrites >= REALISM_REWRITE_BUDGET or (gate.realism_rewrites >= REALISM_LOWPRIO_BUDGET and not rep.get("realism-wardrobe", {}).get("look-fit")):
        rep = {k: v for k, v in rep.items() if not k.startswith("realism-")}  # the budget is spent (the look-fits-life ones have the larger share): report only
    if not rep:
        return
    if any(k.startswith("realism-") for k in rep):
        gate.realism_rewrites += 1
    gate.rep_rewritten += 1
    if "realism-wardrobe" in rep:
        gate.wardrobe_asked.add(hid)
    try:
        fresh = await rewrite_fn(npc, ["rep"], message=repetition_message(rep, gate.taken_phrases(hid)))
    except Exception as e:  # failsoft-ok: a failed re-write leaves the card as it is
        logger.warning(f"[cast-gate] repetition re-write call failed for {hid}: {type(e).__name__}")
        return
    if not isinstance(fresh, dict):
        gate.count(["rw-no-reply"])
        return
    new_ident = fresh.get("identityConcept")
    new_phys = fresh.get("physicalCharacteristics")
    # a writer asked for "just the field" often answers with the field at the top level instead of inside physicalCharacteristics: both are read
    new_phys = {**{k: fresh[k] for k in ("onCamera", "wardrobe", "style", "lookSignature") if k in fresh}, **(new_phys if isinstance(new_phys, dict) else {})}
    new_cam = new_phys.get("onCamera")
    new_wd = new_phys.get("wardrobe")
    if isinstance(new_wd, list) and len(new_wd) > 3 and all(isinstance(x, str) and x.strip() for x in new_wd):
        new_wd = new_wd[:3]  # four pieces: the main piece and the next two stand
    new_sig = new_phys.get("lookSignature")
    has_cam = isinstance(new_cam, str) and new_cam.strip()
    has_wd = isinstance(new_wd, list) and 2 <= len(new_wd) <= 3 and all(isinstance(x, str) and x.strip() for x in new_wd)
    has_sig = isinstance(new_sig, str) and new_sig.strip()
    if "realism-oncamera" in rep and "oncamera" not in rep:
        rep = {**rep, "oncamera": ""}  # the same line answers both asks
    # each repeated field is judged on its own: kept only when the new text passes the whole gate and no longer repeats
    for key, ok in (("identity", isinstance(new_ident, str) and new_ident.strip()),
                    ("identity-name", isinstance(new_ident, str) and new_ident.strip()),
                    ("oncamera", has_cam), ("realism-wardrobe", has_wd or (has_sig and "signature" in (rep.get("realism-wardrobe") or {})))):
        if key not in rep:
            continue
        if not ok:
            gate.count([f"rw-no-{key}", "rw-reply-keys:" + "+".join(sorted(str(k) for k in list(fresh)[:6]))])  # the writer's reply carried no usable value for the asked field
            continue
        cand = {k: (dict(v) if isinstance(v, dict) else v) for k, v in profile.items()}
        if key in ("identity", "identity-name"):
            if key == "identity-name" and "identity" in rep:
                continue  # one identity rewrite answers both asks
            cand["identityConcept"] = new_ident
        else:
            base = cand.get("physicalCharacteristics")
            base = dict(base) if isinstance(base, dict) else dict((npc or {}).get("physicalCharacteristics") or {})
            if key == "oncamera":
                base["onCamera"] = new_cam
            else:
                if has_wd:
                    base["wardrobe"] = [" ".join(x.split()) for x in new_wd]
                if has_sig:
                    base["lookSignature"] = " ".join(new_sig.split())[:90]  # the signature travels with the wardrobe it is carried by
                new_style = new_phys.get("style") if isinstance(new_phys, dict) else None
                if has_wd and "look-fit" in (rep.get("realism-wardrobe") or {}):
                    # the style line travels with the clothes it describes: the writer's own line, unless it still names the poor-fit family
                    # (or is missing), then the pieces themselves in plain words
                    plain = ", ".join(" ".join(x.split()).lower() for x in new_wd)
                    style = " ".join(new_style.split()) if isinstance(new_style, str) and new_style.strip() else plain
                    if "family-worn" in _look_fit_failures({**cand, "physicalCharacteristics": {**base, "style": style}}):
                        style = plain
                    base["style"] = style
            cand["physicalCharacteristics"] = base
        mend(cand, npc, cast)
        if any(is_blocking(c) for c in card_codes(cand, npc, cast, gate.registry)):
            gate.count([f"rw-blocking-{key}"])
            continue
        if key in ("identity", "identity-name") and not _identity_ok(cand.get("identityConcept")):
            continue
        if key == "oncamera" and not _oncamera_ok(cand, npc, cast):
            continue
        if key == "realism-wardrobe" and not _wardrobe_ok(cand, npc):
            from src import orwell_cast_authoring as _A
            gate.count(["rw-look-" + "+".join(sorted(c for c in _A.look_problems(cand, npc) if c != "style-wrong-family"))])
            continue
        still = gate.repeats(hid, cand, npc, cast)
        if key == "realism-wardrobe":
            # a rewrite that IMPROVES the card is kept; perfection is not demanded (a fixed look-fit is not thrown away because a colour or
            # signature cap is already over for the whole cast): the weighted offenders must drop and no new look-fit offender may appear
            if _wardrobe_score(still.get("realism-wardrobe")) < _wardrobe_score(rep.get("realism-wardrobe")) and not (
                    set((still.get("realism-wardrobe") or {}).get("look-fit", [])) - set((rep.get("realism-wardrobe") or {}).get("look-fit", []))):
                still.pop("realism-wardrobe", None)
        if key.startswith("identity"):
            asked = [k for k in rep if k.startswith("identity")]
        elif key == "oncamera":
            asked = [k for k in ("oncamera", "realism-oncamera") if k in rep]
        else:
            asked = [key]
        if key == "realism-wardrobe" and "realism-wardrobe" in still:
            gate.count(["rw-not-improved"])
        if any(k in still for k in asked):  # a realism dict is non-empty only while an offender remains (the asked one or a new one)
            continue  # it still repeats (or still names the person): that field ships as it is (fail open, the code is counted as before)
        profile.clear()
        profile.update(cand)
        gate.rep_fixed += 1
        if key in ("realism-wardrobe",) or (key == "oncamera" and "realism-oncamera" in rep):
            gate.realism_fixed += 1
            gate.count(["realism-fixed"])


async def run_gate(gate: SeasonGate, profile: dict, npc: dict, cast, rewrite_fn: Optional[RewriteFn]):
    """Gate one card. Returns (profile_to_write_or_None, codes_left). Mends in place; re-writes (at most
    GATE_REWRITE_BOUND, only for BLOCKING codes) via `rewrite_fn(npc, codes) -> new profile or None`. A card still
    blocking is left not authored with a RED soft-fail (id + codes); non-blocking codes never hold a card back."""
    hid = str((npc or {}).get("id") or "")
    gate.checked += 1
    gate.n = gate.n or len(cast or [])
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
