"""ORW-956: the ONE table of rules a generated cast card must follow.

Every check on a cast card (the gate in `orwell_cast_gate`, the look and story checks in `orwell_cast_authoring`, the
parse floors) has a row here: its reason code, the card field it applies to, the plain instruction sentence the writer's
prompt carries, and the check that emits the code. The prompts (`PHOTO_SHEET_RULES`, `_SYSTEM` and the per-card user
message in `orwell_cast_authoring`) are templates with `[[rule:KEY]]` markers that `render` fills from `SENTENCES`, so a
rule cannot be checked without being stated, and a repair that re-asks one failing field names the failing rule's own
sentence. The thresholds live here once (`BIO_ASK_CHARS` and the rest) and the checks read them from here.

This module is a LEAF: it imports nothing from the cast modules, so both the gate and the authoring module can import it.
Example clauses that the short-list guard (ci/check_short_lists.py) allowlists in `orwell_cast_authoring.py` stay there and
are passed in as `[[eg:KEY]]` values, so this file carries no example line. The drift test is
`frontend/tests/test_orw956_cast_rules_table.py`.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

# ── thresholds: one number each, read by the prompt sentences below and by the checks ─────────────────────────────
BIO_ASK_CHARS = 480            # the length the prompt and the gate's rewrite message ask for (ORW-952)
BIO_OVERSIZE_CHARS = BIO_ASK_CHARS * 3 // 2   # ORW-437: the gate reports `bio-format` only past 1.5 x the ask (720)
BIO_MAX_SENTENCES = 3          # the gate reports `bio-format` past this many sentences
BIO_FLOOR_CHARS = 80           # parse floor: a shorter biography is dropped
BIO_FLOOR_SENTENCES = 2        # parse floor: fewer sentence ends than this is dropped
IDENTITY_MIN_CHARS = 20        # `identity-missing` below this
IDENTITY_PARSE_MIN_CHARS = 12  # parse keeps an identityConcept from this length
IDENTITY_MAX_CHARS = 250       # parse drops an identityConcept past this length
WARDROBE_MIN_PIECES = 2
WARDROBE_MAX_PIECES = 3
WARDROBE_PIECE_MAX_CHARS = 60
PHOTOHAIR_MAX_CHARS = 90
ONCAMERA_MAX_CHARS = 240
SIGNATURE_MAX_CHARS = 90
SPOT_MAX = 3                   # at most this many houseguests share one house spot in their on-camera moment

ONCAMERA_BANNED_WORDS = (
    "then", "says", "said", "narrates", "narrating", "jokes", "joke", "story", "monologue", "answers",
    "answering", "asks", "humming", "calling out", "mid-sentence", "mid-story", "mid-joke", "everyone",
    "someone", "whoever", "anyone", "stranger", "the group", "the others", "houseguests", "scrubs",
    "scrubbing", "cooking", "washing", "counting", "ticking off", "hands flying", "gesturing", "paces",
    "pacing",
)
PHOTOHAIR_BANNED_WORDS = (
    "usually", "by afternoon", "messy", "frizzy", "flyaway", "flyaways", "fly-away", "fly away", "ragged",
    "unruly", "fuzzy", "frays", "frayed", "shoved",
)

# ── the instruction sentences (the exact prompt wording) ───────────────────────────────────────────────────────────
# `[[eg:KEY]]` is filled by the caller (the example clauses stay in orwell_cast_authoring.py); `[[name]]` by the caller.
SENTENCES = {
    # the photo sheet (PHOTO_SHEET_RULES: first draft, photo-sheet writer, field rewrites)
    "pronouns": (
        "In the onCamera line, the photoHair line and the wardrobe, use no pronoun other than this person's own, never "
        "\"they\" or \"their\" for a man or a woman, and do not refer to anyone else. "),
    "wardrobe-shape": (
        f"(1) wardrobe: an array of {WARDROBE_MIN_PIECES}-{WARDROBE_MAX_PIECES} pieces, each under {WARDROBE_PIECE_MAX_CHARS} characters, "
        "in camera-ready condition, with no visible words, logos, band names or brand names, "),
    "wardrobe-garment": (
        "and each a real garment or accessory a shop sells, chosen from this person's job, hometown, age, money and personality "
        "(the style family is only a lean). "),
    "wardrobe-real": (
        "Test every piece with one question: would this person, with this job, age, income and the weather of their hometown, really "
        "wear it on an ordinary day, at work or off it (not another trade's work gear, not the wrong season for the job, not above their "
        "money, not a costume)? "),
    "wardrobe-taken": (
        "The FIRST piece is the MAIN piece (the jacket, shirt, dress or top). It must not repeat a main piece already listed in "
        "taken.mainPieces (compare the garment[[eg:main-piece]]). "),
    "wardrobe-pieces": (
        "Every piece is ONE garment or accessory a shop sells (a shirt, a jacket, jeans, boots, a watch): no piece that combines two "
        "things (not \"a vest over a polo\", not \"sneakers with a gold chain\": two pieces), no uniform worn as a style (never "
        "\"worn like a uniform\"), no costume, no work badge, name tag or lanyard, no bare skin under a blazer, no hand-sewn or DIY "
        "decoration. "),
    "style-family": (
        "The pieces and the style line keep to the presentation's own style family when they read as one, and never blend two families. "),
    "label-leak": (
        "Write colours and styles in plain words a shopper would use, never a hyphenated category label made of two colour names. "),
    "photohair": (
        f"(2) photoHair: at most {PHOTOHAIR_MAX_CHARS} characters: the SAME cut, length and colour as their written hair, styled and neat "
        "for a photo shoot, said positively[[eg:photohair]]. Never use these words: " + ", ".join(PHOTOHAIR_BANNED_WORDS) + ". "),
    "oncamera": (
        "(3) onCamera: the MOMENT: ONE still moment a photographer captures, chosen for THIS person from their demeanor, identity "
        "concept and voice energy. It says where they are in the house, how they hold themselves, where they look, and one expression, "
        f"in one to three short sentences of at most {ONCAMERA_MAX_CHARS} characters. It names no room of the house (the room of the photo "
        "is chosen separately), so describe posture, hands, gaze and expression only, with nothing that a room would have to supply (no "
        "counter, sofa, doorway or window to lean on or sit at). Where the eyes go follows the person: on the camera for the open and "
        "bold; off to one side, down, at something in the room or past the lens for the guarded, shy, distracted or busy. Hands at rest "
        "or doing ONE simple thing (arms folded, hands in pockets, a hand on a knee, tucking hair, adjusting a cuff, elbow propped). "
        "The expression follows the person too: smiling only if this person would; a serious, wry, tired, guarded, "
        "amused-without-smiling or thoughtful face is as likely as a smile; never mid-word. Usually no prop: a prop only when this "
        "person's job or life gives a reason, never a mug or cup, and at most one. Only when the OPENING PATTERN line says closing read: "
        "yes, end with a read of who they are in 3-8 words, introduced by \"the one who\"; otherwise end the line plainly. It is a still "
        "photograph, not a scene: no sequence of events, no speech, no chores, no other people. Never use these words: "
        + ", ".join(w for w in ONCAMERA_BANNED_WORDS if w != "someone") + ", someone. "
        "Use the pronoun that matches genderPresentation, but never open the line with the pronoun and a posture verb "
        "(not \"He stands\", \"She stands\", \"He leans\"): open it with the spot, the hands, the gaze or the expression, "
        "or the way an OPENING PATTERN line in the prompt says. Never use the houseguest's name in the onCamera line, only the pronoun. "),
    "signature": (
        f"(4) lookSignature: at most {SIGNATURE_MAX_CHARS} characters: exactly ONE thing about how this person looks or dresses that someone "
        "would use to describe them to a friend. It comes from their own life as the biography tells it (their job, hometown, family, "
        "hobby or a habit), is something they could really buy or do where they live on their own money, and is something nobody else in "
        "the cast has: a different kind of thing from every signature in taken.signatures. It is a real, ordinary choice (a hairstyle, "
        "jewellery, glasses, a garment worn a certain way, facial hair, nails), never a costume, a uniform, a prop, a tattoo or anything "
        "with words on it, and the wardrobe carries it (the pieces and this line agree). It is ONE thing, never a whole outfit. When it is "
        "about hair it names only the cut, length and texture that this card's own hair and photoHair lines already carry. "),
    # the first-draft prompt (_SYSTEM) and its per-card user message
    "identity-length": f"ONE sentence (at least {IDENTITY_MIN_CHARS} and under {IDENTITY_MAX_CHARS} characters)",
    "identity-no-name": "do not put the person's name in it",
    "bio-length": (
        f"a {BIO_FLOOR_SENTENCES}-{BIO_MAX_SENTENCES} sentence presentable backstory (life outside the house), "
        f"under {BIO_ASK_CHARS} characters"),
    "look-fields": "(wardrobe is an array, photoHair and onCamera short lines, see PHOTO SHEET below)",
    "story-matches": (
        "STORY MATCHES THE CARD (HARD): the biography is read beside the card, so it must agree with it. "
        "Use ONLY the houseguest's pinned pronouns for the houseguest (other people keep their own, named by role); "
        "state no age except the skeleton's exact age (a life stage or no number is better); name no body or face feature "
        "(tooth gap, tattoo, glasses, scar, freckles) that your own physicalCharacteristics does not carry; and the show "
        "is Orwell, never Big Brother. "),
    "age-coherence": (
        "AGE COHERENCE: hair, skin and ageLook must fit the stated age; no gray, silver or salt-and-pepper "
        "hair under 35 unless it is written as dyed. "),
    "build-coherence": (
        "BUILD COHERENCE: heightBuild must not combine opposites[[eg:build]]. Keep the FITNESS LEVEL of the seeded "
        "heightBuild: an athletic person stays athletic, a soft or slight one stays so; enrich the wording "
        "only, in neutral, flattering terms (never \"gone soft\" or \"soft through the middle from long "
        "shifts\")"),
    "voice": "\"lexicon\" is an array of 2-3 habitual filler words/phrases",
    "bio-subject": (
        "The biography is about [[name]] and no one else: write it about [[name]] by that exact name (or by role), "
        "and never give them any other first name. Use the first name at least once in the biography."),
    "background-years": (
        "The skeleton's background and identityConcept are FACTS about [[name]]: the biography must agree with them "
        "(same job, same years of service, same workplace) and may add to them, never contradict them."),
    "taken": (
        "CAST-WIDE TAKEN LIST (the other houseguests occupy this ground — do NOT duplicate it or drift this houseguest toward it)"),
    # sentences added by ORW-956 for checks the prompt never stated
    "bio-no-stop": "The biography ends on a full stop.",
    "identity-story": (
        "The identityConcept uses only the pinned pronouns for the houseguest, states no age other than the card's age, "
        "and names no other houseguest."),
    "no-copy": (
        "Write the biography and the identityConcept fresh for this card: never copy another card's text, and never open the "
        "biography with the first name that another card's biography opens with."),
}


@dataclass(frozen=True)
class Rule:
    """One check and the sentence that states it.

    code      the reason code the check emits (`card_codes`, `look_problems`, `story_problems` ...), or a family prefix
    fields    the card field(s) the rule applies to; the repair path re-asks the field(s) a failing rule names
    sentence  key into SENTENCES: the plain instruction the prompt carries for this rule
    where     which prompt carries it: "sheet" (PHOTO_SHEET_RULES, so every writer), "system" (_SYSTEM), "user" (the per-card message)
    check     the function that emits the code (module.function), so the drift test can find it
    blocking  True when the gate leaves the card not authored while the code stands after the mend and the re-writes
    repair    True when a failing field is re-asked once (with the sentence) before the fallback may delete it
    """
    code: str
    fields: tuple
    sentence: str
    where: str
    check: str
    blocking: bool = False
    repair: bool = False


_A, _G, _P = "orwell_cast_authoring.", "orwell_cast_gate.", "orwell_cast_realism."
_look = _A + "look_problems"
RULES = (
    # ── the photo sheet: look_problems ──
    Rule("pronoun-mismatch", ("onCamera", "photoHair", "wardrobe"), "pronouns", "sheet", _look, repair=True),
    Rule("wardrobe-shape", ("wardrobe",), "wardrobe-shape", "sheet", _look, repair=True),
    Rule("wardrobe-not-garment", ("wardrobe",), "wardrobe-garment", "sheet", _look, repair=True),
    Rule("wardrobe-unreal", ("wardrobe", "style"), "wardrobe-pieces", "sheet", _look, repair=True),
    Rule("wardrobe-multi", ("wardrobe",), "wardrobe-pieces", "sheet", _look, repair=True),
    Rule("wardrobe-taken", ("wardrobe",), "wardrobe-taken", "sheet", _look),
    Rule("style-wrong-family", ("style", "wardrobe"), "style-family", "sheet", _look, repair=True),
    Rule("label-leak", ("wardrobe", "style", "lookSignature", "onCamera", "photoHair"), "label-leak", "sheet", _look),
    Rule("photohair-messy", ("photoHair",), "photohair", "sheet", _look, repair=True),
    Rule("oncamera-scene", ("onCamera",), "oncamera", "sheet", _look, repair=True),
    Rule("oncamera-shape", ("onCamera",), "oncamera", "sheet", _A + "write_photo_sheet", repair=True),
    Rule("oncamera-taken", ("onCamera",), "oncamera", "sheet", _look, repair=True),
    Rule("signature-shape", ("lookSignature",), "signature", "sheet", _look, repair=True),
    Rule("signature-hair", ("lookSignature",), "signature", "sheet", _look, repair=True),
    # ── the look-fit family of the realism table (counted, never blocking) ──
    Rule("family", ("wardrobe", "style"), "wardrobe-real", "sheet", _P + "look_fits_life"),
    Rule("family-worn", ("wardrobe", "style"), "wardrobe-real", "sheet", _P + "look_fits_life"),
    Rule("upscale", ("wardrobe", "style"), "wardrobe-real", "sheet", _P + "look_fits_life"),
    Rule("climate", ("wardrobe", "style"), "wardrobe-real", "sheet", _P + "look_fits_life"),
    Rule("missing", ("wardrobe",), "wardrobe-real", "sheet", _P + "look_fits_life"),
    # ── the first draft: hair and build, the story, the identity line, the biography ──
    Rule("gray-hair-young", ("hair",), "age-coherence", "system", _look, repair=True),
    Rule("build-contradiction", ("heightBuild",), "build-coherence", "system", _look, repair=True),
    Rule("story-pronoun", ("biography",), "story-matches", "system", _A + "story_problems", blocking=True),
    Rule("story-age", ("biography",), "story-matches", "system", _A + "story_problems", blocking=True),
    Rule("story-feature", ("biography",), "story-matches", "system", _A + "story_problems"),
    Rule("story-show-name", ("biography",), "story-matches", "system", _A + "story_problems"),
    Rule("story-name", ("biography",), "bio-subject", "user", _A + "story_name_codes", blocking=True),
    Rule("story-cast-name", ("biography",), "bio-subject", "user", _A + "story_name_codes", blocking=True),
    Rule("story-no-biography", ("biography",), "bio-length", "system", _A + "card_consistency", blocking=True),
    Rule("bio-floor", ("biography",), "bio-length", "system", _A + "parse_dropped", repair=True),
    Rule("identity-missing", ("identityConcept",), "identity-length", "system", _A + "card_consistency", blocking=True),
    Rule("identity-length", ("identityConcept",), "identity-length", "system", _A + "parse_dropped", repair=True),
    Rule("identity-name", ("identityConcept",), "identity-no-name", "system", _A + "card_consistency", blocking=True),
    Rule("identity-cast-name", ("identityConcept",), "identity-story", "system", _A + "card_consistency", blocking=True),
    Rule("identity-pronoun", ("identityConcept",), "identity-story", "system", _A + "card_consistency", blocking=True),
    Rule("identity-age", ("identityConcept",), "identity-story", "system", _A + "card_consistency", blocking=True),
    Rule("look-missing-wardrobe", ("wardrobe",), "look-fields", "system", _A + "card_consistency"),
    Rule("look-missing-onCamera", ("onCamera",), "look-fields", "system", _A + "card_consistency"),
    Rule("look-missing-photoHair", ("photoHair",), "look-fields", "system", _A + "card_consistency"),
    # ── the gate: card_codes and the cast registry ──
    Rule("bio-no-stop", ("biography",), "bio-no-stop", "system", _G + "card_codes"),
    Rule("bio-format", ("biography",), "bio-length", "system", _G + "card_codes"),
    Rule("bio-no-own-name", ("biography",), "bio-subject", "user", _G + "card_codes"),
    Rule("voice-missing", ("voice",), "voice", "system", _G + "card_codes"),
    Rule("background-years", ("biography", "background"), "background-years", "user", _G + "background_codes"),
    Rule("bio-dup-text", ("biography",), "no-copy", "system", _G + "card_codes", blocking=True),
    Rule("bio-dup-subject", ("biography",), "no-copy", "system", _G + "card_codes"),
    Rule("ident-dup-text", ("identityConcept",), "no-copy", "system", _G + "card_codes"),
    Rule("rep-oncamera-end", ("onCamera",), "taken", "user", _G + "SeasonGate.accept"),
    Rule("rep-ident-open", ("identityConcept",), "taken", "user", _G + "SeasonGate.accept"),
    Rule("rep-mark", ("distinguishingMark",), "taken", "user", _G + "SeasonGate.accept"),
)
# The gate's blocking codes. Before ORW-956 this was a literal set in orwell_cast_gate; the tier lives on the rule now.
# (`bio-dup-text` was blocking there too.)
BY_CODE = {r.code: r for r in RULES}
if len(BY_CODE) != len(RULES):  # a duplicated code would hide a rule
    raise RuntimeError("orwell_cast_rules: duplicate rule code")
BLOCKING = frozenset(r.code for r in RULES if r.blocking)

_MARK = re.compile(r"\[\[(rule|eg):([a-z\-]+)\]\]|\[\[(name)\]\]")


def render(template: str, extras: Optional[dict] = None, used: Optional[set] = None) -> str:
    """Fill a prompt template: `[[rule:KEY]]` with SENTENCES[KEY] (its own `[[eg:..]]` and `[[name]]` markers then come
    from `extras`: {"eg:KEY": text, "name": text}). An unknown key or a missing extra raises, so a typo cannot ship a
    prompt with a hole in it. `used` collects the sentence keys rendered (the drift test reads it)."""
    extras = extras or {}

    def sub(m):
        if m.group(3):
            if "name" not in extras:
                raise KeyError("name")
            return str(extras["name"])
        kind, key = m.group(1), m.group(2)
        if kind == "rule":
            if key not in SENTENCES:
                raise KeyError(f"unknown rule sentence {key!r}")
            if used is not None:
                used.add(key)
            return render(SENTENCES[key], extras, used)
        if f"eg:{key}" not in extras:
            raise KeyError(f"eg:{key}")
        return str(extras[f"eg:{key}"])
    return _MARK.sub(sub, template)


def sentence(code: str, extras: Optional[dict] = None) -> str:
    """The instruction sentence of one rule, as the prompt words it (what a repair re-asks the writer)."""
    return render(SENTENCES[BY_CODE[code].sentence], extras).strip()


def rules_for_field(field: str, codes) -> list:
    """The rules among `codes` that apply to `field` (the repair path asks the field with exactly these sentences)."""
    return [BY_CODE[c] for c in codes if c in BY_CODE and field in BY_CODE[c].fields]
