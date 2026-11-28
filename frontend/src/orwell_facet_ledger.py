"""T0-6 — the ONE Casting Bible: the cast-wide seeded FacetLedger.

Minted BEFORE any LLM call, the ledger deals every houseguest slot a HAND of closed casting
facets from STRATIFIED per-cast budgets (with seeded jitter + rare-outlier slots):

  * vocation family      — which corner of the working world this person comes from
  * region / hometown    — a US region bucket + a town-size directive
  * height / build       — the physical silhouette
  * complexion depth     — a steering cue only (the 0063 heritage grounding stays the authority
                           at the engine's recordCastProfile write-back — the ledger spreads the
                           steering, the committed heritage wins)
  * hair                 — texture/length spread, with a seeded 0-2 bold-styled outlier slots
  * voice tic            — one habitual verbal quirk, unique per slot
  * name phonology       — a per-slot name-shape directive (syllables/initials), killing the
                           model's default-name clustering at the source

Marks/ink are deliberately NOT re-dealt here: the #1768 ink slot semantics (a seeded 2-4 inked
slots per cast on the ``:genesis:looks`` side-stream) stay exactly where they live —
``orwell_cast_genesis.assign_genesis_slots`` — and the ledger hand rides BESIDE that deal.

Every authoring lane receives its NPC's dealt hand + the cast-wide taken-list in its prompt
(genesis: ``build_genesis_messages`` renders the hand into the casting card and aggregates the
sibling hands as the taken-list; deep authoring: ``build_authoring_messages`` threads the hand +
the siblings' COMMITTED facets). Because the hands are disjoint by construction, 15 concurrent
per-NPC calls can no longer collide on the model's default picks (the "San Diego x2" /
"smokejumper cluster" class) — which is what makes the 15-wide single-wave genesis safe.

DETERMINISM: every deal runs on its OWN dedicated side-stream (``{seed}:ledger:<facet>``) of the
same mulberry32/FNV-1a pair the engine and the genesis port use — same seed ⇒ same ledger, and
adding/removing one facet never perturbs another. Pure functions, no wall clock, no global RNG.

STEERING, NEVER A VALIDATOR: like the season brief, the ledger steers the model's open-ended
generation; the engine's envelope (clamps / dedupe backstop / the T0-6 closed-facet-diff
validator at recordCastProfile) is what binds.
"""
from __future__ import annotations

from typing import Optional

_U32 = 0xFFFFFFFF


def _hash_seed(s: str) -> int:
    """FNV-1a 32-bit — a mirror of ``orwell_cast_genesis._hash_seed`` (kept local: genesis imports
    THIS module for the hands, so importing back would cycle). Parity is pinned by test."""
    h = 0x811c9dc5
    for ch in s:
        h = ((h ^ ord(ch)) * 0x01000193) & _U32
    return h


class _Mulberry32:
    """mulberry32 — a mirror of ``orwell_cast_genesis._Mulberry32`` (see ``_hash_seed`` note)."""

    def __init__(self, seed: int) -> None:
        self.state = (seed ^ 0x9e3779b9) & _U32

    def next(self) -> float:
        self.state = (self.state + 0x6d2b79f5) & _U32
        t = self.state
        t = ((t ^ (t >> 15)) * (t | 1)) & _U32
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & _U32)) & _U32
        t &= _U32
        return ((t ^ (t >> 14)) & _U32) / 4294967296.0

    def int(self, max_exclusive: int) -> int:
        if max_exclusive <= 0:
            return 0
        return int(self.next() * max_exclusive)


def _shuffle(arr: list, rng: "_Mulberry32") -> None:
    """Seeded Fisher–Yates (identical stream ⇒ identical permutation)."""
    i = len(arr) - 1
    while i > 0:
        j = rng.int(i + 1)
        arr[i], arr[j] = arr[j], arr[i]
        i -= 1


# ── the stratified pools (base budgets sum to a 15-slot cast; every base count ≤ the dup cap) ──

#: No dealt facet value may land on 3+ slots of one cast — the structural "zero facet triple-dups"
#: guarantee the collision gate pins (real casts repeat a niche at most twice).
FACET_DUP_CAP = 2

# (family, base budget, physically-credible?) — a believable working-America spread. The old
# un-ledgered "athletic/first-responder/performer" PROMPT steering line clustered every physical
# slot into the same three jobs; here first-responder work is simply one budgeted family among
# many, dealt to at most FACET_DUP_CAP slots like everything else.
VOCATION_FAMILIES = (
    ("athletic / coaching / fitness", 2, True),
    ("first-responder / military / uniformed service", 1, True),
    ("trades / manual / outdoor work", 2, True),
    ("service / hospitality / food", 2, False),
    ("creative / performing arts / media", 2, True),
    ("office / corporate / professional", 2, False),
    ("medical / care / wellness", 1, False),
    ("education / community / nonprofit", 1, False),
    ("sales / small-business / hustle", 1, False),
    ("tech / science / analytical", 1, False),
)
#: ORW-480: ordinary jobs inside each family, so the writer is not left to its favourites (nurse, paramedic, coach, office manager).
#: Each slot is shown three of them, dealt on its own side stream and distinct across the cast. Steering only.
FAMILY_JOBS = {
    "athletic / coaching / fitness": ("high-school track coach", "personal trainer", "minor-league groundskeeper", "swim instructor", "rock-gym manager", "bike-shop mechanic", "semi-pro softball player", "ski patrol volunteer", "boxing gym owner", "recreation league referee"),
    "first-responder / military / uniformed service": ("wildland firefighter", "county sheriff's deputy", "Coast Guard petty officer", "911 dispatcher", "park ranger", "Army National Guard sergeant", "airport firefighter", "court bailiff", "search-and-rescue volunteer", "prison chaplain"),
    "trades / manual / outdoor work": ("tree trimmer", "union electrician", "commercial fisherman", "long-haul trucker", "HVAC installer", "roofer", "welder", "landscape crew lead", "stonemason", "warehouse forklift driver"),
    "service / hospitality / food": ("line cook", "wedding-venue bartender", "barista and shop owner", "hotel night auditor", "food-truck owner", "sommelier", "pastry cook", "casino dealer", "pizzeria manager", "valet supervisor"),
    "creative / performing arts / media": ("wedding photographer", "community-theater actor", "session guitarist", "radio morning host", "tattoo artist", "freelance illustrator", "local news cameraman", "podcast producer", "hair stylist", "dance instructor"),
    "office / corporate / professional": ("insurance claims adjuster", "bank branch manager", "paralegal", "payroll specialist", "title-company closer", "city planner", "HR generalist", "supply-chain buyer", "tax preparer", "court reporter"),
    "medical / care / wellness": ("dental hygienist", "pharmacy technician", "massage therapist", "veterinary technician", "home-health aide", "respiratory therapist", "medical biller", "optician", "radiology technologist", "hospice night nurse"),
    "education / community / nonprofit": ("middle-school science teacher", "food-bank director", "librarian", "church youth pastor", "adult-literacy tutor", "community-college adjunct", "museum educator", "campus chaplain", "after-school program lead", "union organizer"),
    "sales / small-business / hustle": ("used-car salesman", "real-estate agent", "boutique owner", "farm-equipment salesperson", "insurance agent", "vending-route owner", "jewelry store manager", "auctioneer", "mattress-store owner", "wedding-cake baker"),
    "tech / science / analytical": ("network engineer", "data analyst", "water-treatment chemist", "wildlife biologist", "game developer", "IT help-desk lead", "lab technician", "GIS mapper", "audio engineer", "weather forecaster"),
}
#: Rare-outlier vocation families — at most one lands per cast, on a seeded minority of seasons.
OUTLIER_VOCATIONS = (
    "funeral / death-care services",
    "carnival, rodeo, or fair circuit",
    "long-haul transport / maritime work",
    "farm / ranch / agricultural life",
    "niche-pageant / oddball-influencer world",
)
#: Seeded probability that this cast carries one outlier vocation slot at all.
OUTLIER_VOCATION_CHANCE = 0.45

US_REGIONS = (
    ("the Northeast / New England", 2),
    ("the Mid-Atlantic", 2),
    ("the Southeast", 2),
    ("the Deep South / Appalachia", 2),
    ("the Midwest / Great Lakes", 2),
    ("Texas / the Southwest", 2),
    ("the Plains / Mountain West", 1),
    ("the West Coast", 2),
    ("the Pacific Northwest", 1),
)
#: ORW-464: the states each dealt region spans. The deal gives every slot a DIFFERENT state (a state repeats only when a region runs
#: out of fresh ones), so the cast does not draw "three from Texas" out of one writer's habits. Steering only, like the region.
REGION_STATES = {
    "the Northeast / New England": ("Massachusetts", "Connecticut", "Maine", "Vermont", "New Hampshire", "Rhode Island"),
    "the Mid-Atlantic": ("New York", "New Jersey", "Pennsylvania", "Maryland", "Delaware", "Virginia"),
    "the Southeast": ("Florida", "Georgia", "South Carolina", "North Carolina"),
    "the Deep South / Appalachia": ("Alabama", "Mississippi", "Louisiana", "Tennessee", "Kentucky", "West Virginia", "Arkansas"),
    "the Midwest / Great Lakes": ("Ohio", "Michigan", "Illinois", "Indiana", "Wisconsin", "Minnesota", "Iowa", "Missouri"),
    "Texas / the Southwest": ("Texas", "Arizona", "New Mexico", "Oklahoma"),
    "the Plains / Mountain West": ("Colorado", "Utah", "Idaho", "Montana", "Wyoming", "Nebraska", "Kansas", "North Dakota", "South Dakota"),
    "the West Coast": ("California", "Hawaii", "Nevada"),
    "the Pacific Northwest": ("Washington", "Oregon", "Alaska"),
}
TOWN_SIZES = (
    ("a big city", 2),
    ("a mid-size city", 2),
    ("a suburb", 2),
    ("a small city", 2),
    ("a small town", 2),
    ("a rural community", 2),
    ("a college town", 2),
    ("a coastal / lake town", 1),
)

HEIGHT_BUILDS = (
    ("tall and lanky", 2),
    ("tall and broad-shouldered", 2),
    ("average height, athletic build", 2),
    ("average height, soft build", 2),
    ("average height, unremarkable build", 2),
    ("compact and wiry", 2),
    ("short and stocky", 1),
    ("short and slight", 1),
    ("heavyset and solid", 1),
    ("long-limbed and rangy", 1),
)

# Complexion depth is STEERING ONLY — the 0063 heritage grounding owns the committed skinTone.
SKIN_TONE_CUES = (
    ("deep, cool-toned", 2),
    ("deep, warm-toned", 2),
    ("medium-deep brown", 2),
    ("warm brown", 2),
    ("tan / olive", 2),
    ("light-medium, warm undertone", 2),
    ("fair, cool undertone", 2),
    ("fair with freckles", 1),
    # ORW-1127: more depths inside each heritage's range, so a cast of 15 can keep every cue under the dup cap while each
    # slot stays inside its own range. The budgets here only matter to the legacy budgeted deal (nothing else reads them).
    ("rich dark brown", 1),
    ("deep, neutral-toned", 1),
    ("light brown, warm", 1),
    ("golden brown", 1),
    ("medium, golden undertone", 1),
    ("light, olive undertone", 1),
    ("fair, warm undertone", 1),
    ("pale, rosy", 1),
    ("fair, neutral undertone", 1),
    ("light, neutral undertone", 1),
    ("light-medium, neutral undertone", 1),
    ("ruddy, fair", 1),
)

HAIR_STYLES = (
    ("close-cropped", 2),
    ("short and neat", 2),
    ("shoulder-length", 2),
    ("long and straight", 2),
    ("loose waves", 2),
    ("tight natural curls", 2),
    ("braids or locs", 1),
    ("salt-and-pepper", 1),
    ("buzzed or shaved", 1),
    ("thick and unruly", 1),
)
#: A seeded 0-2 slots carry a BOLD hair statement (the hair lane's rare-outlier slots).
HAIR_BOLD_MAX = 2
HAIR_BOLD = (
    "boldly dyed (an unmissable color)",
    "a dramatic, high-maintenance style",
    "a retro signature cut",
)

# One habitual verbal quirk per slot, UNIQUE within a cast (pool > cast size).
VOICE_TICS = (
    "answers a question with a question first",
    "trails off mid-sentence when thinking",
    "repeats the last two words someone said before replying",
    "starts stories in the middle",
    "narrates their own actions out loud",
    "over-uses people's first names",
    "counts points off on their fingers",
    "drops into a stage whisper for secrets",
    "laughs before delivering bad news",
    "hums or whistles absently between thoughts",
    "swears creatively without real profanity",
    "quotes their hometown's sayings",
    "turns everything into a sports metaphor",
    "turns everything into a cooking metaphor",
    "apologizes before disagreeing",
    "says the quiet part loud, then walks it back",
    "asks 'you know what I mean?' constantly",
    "gives everyone nicknames within a day",
    "speaks in list form — 'one… two… three…'",
    "leaves long deliberate pauses before answering",
    "talks faster the more excited they get",
    "goes formal and precise when annoyed",
    "mutters sidebar commentary under their breath",
    "repeats their own catchword until someone reacts",
)

# Per-slot name-shape directives, unique within a cast (pool > cast size) — spreads syllable
# counts, initials, and surname texture so 15 concurrent calls can't cluster on default names.
NAME_PHONOLOGY = (
    "a one-syllable given name and a two-syllable surname",
    "a one-syllable given name and a longer surname",
    "a two-syllable given name and a one-syllable surname",
    "a two-syllable given name and a two-syllable surname",
    "a three-syllable given name and a short surname",
    "a vowel-initial given name",
    "a given name starting with a hard consonant (K, T, D, or G)",
    "a given name starting with a soft consonant (S, L, M, or N)",
    "a given name starting with J or R",
    "a nickname-style short-form given name",
    "an old-fashioned given name back in style",
    "a surname that is also a common noun or trade word",
    "a place-flavored or nature-flavored surname",
    "a surname with a double letter in it",
    "an alliterative first and last name",
    "a clipped, punchy full name (short given, short surname)",
    "a long, rolling full name (three-plus syllables somewhere)",
    "a given name from a non-Anglo naming tradition, kept authentic",
)



# ── ORW-1127: ONE coherent look per slot (heritage and age first, then everything that follows from them) ──────────────
#
# The look used to be dealt facet by facet, each on its own side stream, so a Black American slot could draw "fair with
# freckles" and a 24-year-old "salt-and-pepper". Now a slot's look is a single hand: its heritage group and age come first
# (from the roster card the engine dealt, the 0063 grounding), then skin cue, hair texture and colour, and face features are
# all drawn from the ranges that group and age allow, like a Punnett square rather than independent dice. Real
# mixed-heritage slots (and a rare outlier) draw from the UNION of two groups' ranges and are marked ``lookKind: "mixed"``.
# Steering only, like the rest of the ledger; the committed heritage still wins at the engine's write-back.

#: A slot whose age is under this never carries gray/silver hair; at or over GRAY_HAIR_MIN_AGE it often does. The authoring
#: look check (``gray-hair-young``) trips under 35, so the dealt hand keeps a wide margin.
GRAY_HAIR_MIN_AGE = 50
GRAY_HAIR_CHANCE = 0.7
#: The share of slots dealt as believable mixed-heritage looks (capped per cast), beyond the multiracial heritage itself.
MIXED_LOOK_CHANCE = 0.10
MIXED_LOOK_MAX = 2

_BASE_FEATURES = (
    "high cheekbones", "a strong jawline", "thick expressive eyebrows", "deep dimples", "a distinctive piece of everyday jewelry",
    "wire-rimmed glasses", "a round, open face", "a long, narrow face", "a broad forehead", "a square jaw", "a soft jaw",
    "a straight nose", "a strong, prominent nose", "full lips", "a wide, easy smile", "a gap-free, even smile",
    "a slim, angular face", "heavy-lidded eyes", "an expressive, mobile brow",
)

#: group -> the ranges its slots draw from (skin cues are SKIN_TONE_CUES values; textures are plain hair words).
LOOK_GROUPS = {
    "black": {
        "skins": ("deep, cool-toned", "deep, warm-toned", "medium-deep brown", "warm brown", "rich dark brown", "deep, neutral-toned", "light brown, warm"),
        "textures": ("close-cropped", "short and neat", "tight natural curls", "braids or locs", "buzzed or shaved", "a tapered fade", "twists or a natural afro", "thick and unruly"),
        "colours": ("black", "black", "dark brown-black"),
        "eyes": ("deep brown eyes", "warm dark-brown eyes", "large, expressive dark eyes", "hooded dark eyes"),
        "features": ("high cheekbones", "a strong jawline", "thick expressive eyebrows", "deep dimples", "full lips", "a wide, easy smile", "a broad nose", "a round, open face", "a square jaw", "wire-rimmed glasses", "heavy-lidded eyes", "an expressive, mobile brow"),
    },
    "latino": {
        "skins": ("warm brown", "tan / olive", "medium-deep brown", "golden brown", "light brown, warm", "medium, golden undertone", "light-medium, warm undertone"),
        "textures": ("short and neat", "close-cropped", "shoulder-length", "long and straight", "loose waves", "thick and unruly", "buzzed or shaved", "tight natural curls"),
        "colours": ("black", "dark brown", "dark brown", "brown"),
        "eyes": ("dark brown eyes", "warm brown eyes", "deep-set dark eyes", "large brown eyes"),
        "features": _BASE_FEATURES,
    },
    "east_asian": {
        "skins": ("light-medium, warm undertone", "light, olive undertone", "tan / olive", "fair, warm undertone", "medium, golden undertone", "fair, cool undertone", "light, neutral undertone", "light-medium, neutral undertone"),
        "textures": ("short and neat", "close-cropped", "shoulder-length", "long and straight", "buzzed or shaved", "thick and unruly", "loose waves"),
        "colours": ("black", "black", "dark brown-black", "dark brown"),
        "eyes": ("dark almond-shaped eyes", "dark, upturned eyes", "narrow, dark eyes", "soft dark-brown eyes"),
        "features": ("high cheekbones", "a soft jaw", "a round, open face", "a slim, angular face", "a straight nose", "a wide, easy smile", "wire-rimmed glasses", "a broad forehead", "a square jaw", "an expressive, mobile brow", "full lips", "a distinctive piece of everyday jewelry"),
    },
    "south_asian": {
        "skins": ("warm brown", "medium-deep brown", "golden brown", "tan / olive", "light brown, warm", "rich dark brown"),
        "textures": ("short and neat", "close-cropped", "shoulder-length", "long and straight", "loose waves", "thick and unruly", "tight natural curls"),
        "colours": ("black", "black", "dark brown"),
        "eyes": ("dark brown eyes", "large, dark eyes", "deep-set dark eyes", "warm brown eyes"),
        "features": ("high cheekbones", "a strong jawline", "thick expressive eyebrows", "a strong, prominent nose", "full lips", "a round, open face", "wire-rimmed glasses", "a slim, angular face", "a wide, easy smile", "heavy-lidded eyes", "a long, narrow face", "a distinctive piece of everyday jewelry"),
    },
    "middle_eastern": {
        "skins": ("tan / olive", "light-medium, warm undertone", "warm brown", "golden brown", "medium, golden undertone", "light, olive undertone"),
        "textures": ("short and neat", "close-cropped", "shoulder-length", "loose waves", "thick and unruly", "long and straight", "tight natural curls"),
        "colours": ("black", "dark brown", "dark brown"),
        "eyes": ("dark brown eyes", "hazel eyes", "large, dark eyes", "deep-set dark eyes"),
        "features": ("thick expressive eyebrows", "a strong, prominent nose", "high cheekbones", "a strong jawline", "full lips", "a long, narrow face", "wire-rimmed glasses", "a square jaw", "heavy-lidded eyes", "a wide, easy smile"),
    },
    "native": {
        "skins": ("warm brown", "medium-deep brown", "golden brown", "tan / olive", "light brown, warm"),
        "textures": ("long and straight", "shoulder-length", "short and neat", "close-cropped", "thick and unruly", "braids or locs"),
        "colours": ("black", "black", "dark brown"),
        "eyes": ("dark brown eyes", "deep-set dark eyes", "warm dark-brown eyes", "dark, steady eyes"),
        "features": ("high cheekbones", "a strong jawline", "a broad forehead", "a strong, prominent nose", "a round, open face", "a square jaw", "full lips", "a wide, easy smile", "thick expressive eyebrows", "wire-rimmed glasses"),
    },
    "white": {
        "skins": ("fair, cool undertone", "fair with freckles", "light-medium, warm undertone", "fair, warm undertone", "pale, rosy", "light, olive undertone", "tan / olive", "fair, neutral undertone", "light, neutral undertone", "light-medium, neutral undertone", "ruddy, fair"),
        "textures": ("short and neat", "close-cropped", "shoulder-length", "long and straight", "loose waves", "buzzed or shaved", "thick and unruly"),
        "colours": ("brown", "light brown", "dark brown", "blond", "dark blond", "auburn"),
        "eyes": ("blue eyes", "green eyes", "hazel eyes", "light brown eyes", "gray-blue eyes", "brown eyes", "bright, wide-set eyes"),
        "features": _BASE_FEATURES + ("freckles",),
    },
}
#: heritage label (the engine's EthnicityIdentity.heritage) -> (group, per-heritage skin override or None, colour override or None)
HERITAGE_LOOK = {
    "black american": ("black", None, None),
    "nigerian american": ("black", ("deep, cool-toned", "deep, warm-toned", "rich dark brown", "deep, neutral-toned", "medium-deep brown"), None),
    "caribbean american": ("black", None, None),
    "mexican american": ("latino", None, None),
    "puerto rican": ("latino", None, None),
    "dominican american": ("latino", ("medium-deep brown", "warm brown", "golden brown", "tan / olive", "light brown, warm"), None),
    "chinese american": ("east_asian", None, None),
    "filipino american": ("east_asian", ("tan / olive", "golden brown", "light-medium, warm undertone", "medium, golden undertone", "light brown, warm"), None),
    "korean american": ("east_asian", ("fair, warm undertone", "light-medium, warm undertone", "fair, cool undertone", "light, olive undertone"), None),
    "south asian american": ("south_asian", None, None),
    "vietnamese american": ("east_asian", ("light-medium, warm undertone", "light, olive undertone", "tan / olive", "medium, golden undertone"), None),
    "native american": ("native", None, None),
    "middle eastern american": ("middle_eastern", None, None),
    "irish american": ("white", ("fair with freckles", "fair, cool undertone", "pale, rosy", "fair, warm undertone", "fair, neutral undertone", "ruddy, fair"), ("light brown", "brown", "auburn", "red", "dark brown", "blond")),
    "italian american": ("white", ("light-medium, warm undertone", "tan / olive", "light, olive undertone", "fair, warm undertone", "light-medium, neutral undertone", "light, neutral undertone"), ("dark brown", "black", "brown", "dark brown")),
    "polish american": ("white", ("fair, cool undertone", "pale, rosy", "fair, warm undertone", "light-medium, warm undertone", "fair, neutral undertone", "ruddy, fair"), ("light brown", "brown", "blond", "dark blond", "dark brown")),
    "german american": ("white", None, None),
    "greek american": ("white", ("tan / olive", "light, olive undertone", "light-medium, warm undertone", "fair, warm undertone", "light-medium, neutral undertone", "light, neutral undertone"), ("dark brown", "black", "brown")),
    "scandinavian american": ("white", ("pale, rosy", "fair, cool undertone", "fair, warm undertone", "fair with freckles", "fair, neutral undertone", "light, neutral undertone"), ("blond", "dark blond", "light brown", "brown")),
}
#: keyword fallbacks for a heritage label the table does not list (the identity model is told to pick from the engine's list, so this is a belt).
_HERITAGE_KEYWORDS = (
    ("black", "black"), ("african", "black"), ("caribbean", "black"), ("hispanic", "latino"), ("latin", "latino"), ("mexican", "latino"),
    ("asian", "east_asian"), ("chinese", "east_asian"), ("korean", "east_asian"), ("japanese", "east_asian"), ("filipin", "east_asian"),
    ("indian", "south_asian"), ("pakistan", "south_asian"), ("native", "native"), ("indigenous", "native"), ("middle eastern", "middle_eastern"),
    ("arab", "middle_eastern"), ("white", "white"), ("european", "white"), ("american", "white"),
)
#: the seeded ancestry deal for a slot whose card names no heritage (a unit test or a legacy roster): US-population shaped weights.
_GROUP_WEIGHTS = (("white", 60), ("latino", 16), ("black", 13), ("east_asian", 6), ("south_asian", 3), ("middle_eastern", 1), ("native", 1))
_MIXABLE = ("white", "black", "latino", "east_asian", "south_asian", "native", "middle_eastern")


def heritage_group(label) -> Optional[str]:
    """The look group a heritage label belongs to, or None when it is blank or unrecognised ("multiracial" is handled by the deal itself)."""
    key = str(label or "").strip().lower()
    if not key or key in ("multiracial", "mixed", "biracial"):
        return None
    if key in HERITAGE_LOOK:
        return HERITAGE_LOOK[key][0]
    for word, grp in _HERITAGE_KEYWORDS:
        if word in key:
            return grp
    return None


def _is_multiracial(label) -> bool:
    return str(label or "").strip().lower() in ("multiracial", "mixed", "biracial", "multi-racial", "mixed race")


def _age_int(v) -> Optional[int]:
    try:
        return int(v) if v is not None and not isinstance(v, bool) else None
    except (TypeError, ValueError):
        return None


def _pick_spread(rng: "_Mulberry32", options, counts: dict, cap: int = FACET_DUP_CAP):
    """Pick one of ``options``: only values under ``cap`` if any, the least-used of those first (a seeded pick among ties), so a
    cast spreads across the range it is allowed instead of piling on one value. The cap yields only when EVERY option is full."""
    uniq = list(dict.fromkeys(options))
    under = [o for o in uniq if counts.get(o, 0) < cap] or uniq
    low = min(counts.get(o, 0) for o in under)
    best = [o for o in under if counts.get(o, 0) == low]
    pick = best[rng.int(len(best))]
    counts[pick] = counts.get(pick, 0) + 1
    return pick


def _deal_looks(seed, count: int, people: Optional[list]) -> list:
    """The coherent look hand for every slot. ``people`` is the roster's ``[{ethnicity, age}, ...]`` in slot order (any entry or key may
    be missing). Pure and seeded on ONE side stream, so the same seed and cards give the same looks."""
    rng = _Mulberry32(_hash_seed(f"{seed}:ledger:look"))
    # which slots are the cast's mixed-heritage looks: multiracial cards always, plus a small seeded share (capped)
    mixed_extra: set = set()
    order = list(range(count))
    _shuffle(order, rng)
    for i in order:
        if len(mixed_extra) < MIXED_LOOK_MAX and rng.next() < MIXED_LOOK_CHANCE:
            mixed_extra.add(i)
    skin_n: dict = {}
    hair_n: dict = {}
    eye_n: dict = {}
    feat_n: dict = {}
    tex_n: dict = {}
    out: list = [None] * count
    for i in order:  # a seeded visiting order, so cap pressure never favours slot 1
        card = people[i] if people and i < len(people) and isinstance(people[i], dict) else {}
        label = card.get("ethnicity")
        age = _age_int(card.get("age"))
        group = heritage_group(label)
        source = "card"
        kind = "heritage"
        partner = None
        if group is None and not _is_multiracial(label):
            group = _pick_group(rng)
            source = "dealt"
        if _is_multiracial(label):
            kind = "mixed"
            a, b = _pick_two_groups(rng)
            groups = (a, b)
            group = a
            partner = b
        elif i in mixed_extra:
            kind = "mixed"
            partner = _pick_other(rng, group)
            groups = (group, partner)
        else:
            groups = (group,)
        key = str(label or "").strip().lower()
        override = HERITAGE_LOOK.get(key) if kind == "heritage" else None
        skins: list = []
        textures: list = []
        colours: list = []
        eyes: list = []
        feats: list = []
        for g in groups:
            spec = LOOK_GROUPS[g]
            skins += list(override[1] if override and override[1] and g == group else spec["skins"])
            textures += list(spec["textures"])
            colours += list(override[2] if override and override[2] and g == group else spec["colours"])
            eyes += list(spec["eyes"])
            feats += list(spec["features"])
        skin = _pick_spread(rng, skins, skin_n)
        gray = None
        if age is not None and age >= GRAY_HAIR_MIN_AGE and rng.next() < GRAY_HAIR_CHANCE:
            gray = "salt-and-pepper" if age < 60 else "silver-gray"
        shades = [gray] if gray else colours
        combos = [(t, c) for t in dict.fromkeys(textures) for c in dict.fromkeys(shades)]
        open_ = [tc for tc in combos if hair_n.get(f"{tc[0]}, {tc[1]} hair", 0) < FACET_DUP_CAP] or combos
        low = min(tex_n.get(t, 0) for t, _c in open_)  # spread the textures first, then the whole hair string stays under the cap
        best = [tc for tc in open_ if tex_n.get(tc[0], 0) == low]
        texture, colour = best[rng.int(len(best))]
        hair = f"{texture}, {colour} hair"
        hair_n[hair] = hair_n.get(hair, 0) + 1
        tex_n[texture] = tex_n.get(texture, 0) + 1
        # face: eyes and one structural feature from the group's pools; freckles only on a fair slot, laugh lines only from 30 on
        feat_pool = [f for f in feats if f != "freckles" or "fair" in skin or "pale" in skin or "light" in skin]
        if age is not None and age >= 30:
            feat_pool += ["laugh lines"]
        if age is not None and age >= 45:
            feat_pool += ["deep laugh lines", "a lined, weathered face"]
        eye = _pick_spread(rng, eyes, eye_n)
        feat = _pick_spread(rng, feat_pool, feat_n)
        out[i] = {
            "lookGroup": group,
            "lookKind": kind,
            "lookMixedWith": partner,
            "lookSource": source,
            "skinToneCue": skin,
            "hairTexture": texture,
            "hairColour": colour,
            "hair": hair,
            "eyes": eye,
            "faceFeature": feat,
            "facialFeatures": f"{eye}; {feat}",
        }
    return out


def _pick_group(rng: "_Mulberry32") -> str:
    total = sum(w for _g, w in _GROUP_WEIGHTS)
    r = rng.next() * total
    for g, w in _GROUP_WEIGHTS:
        r -= w
        if r < 0:
            return g
    return _GROUP_WEIGHTS[0][0]


def _pick_other(rng: "_Mulberry32", group: str) -> str:
    pool = [g for g in _MIXABLE if g != group]
    return pool[rng.int(len(pool))]


def _pick_two_groups(rng: "_Mulberry32") -> tuple:
    a = _pick_group(rng)
    return a, _pick_other(rng, a)


def _deal_budgeted(rng: "_Mulberry32", count: int, entries, cap: int = FACET_DUP_CAP) -> list:
    """Deal ``count`` values from ``entries`` = ((value, base_budget), …): expand the budgets,
    pad/trim to ``count`` under the per-value ``cap``, apply up to two seeded JITTER moves (a unit
    re-dealt to another under-cap value), then a seeded shuffle. The cap is structural: no value
    can ever land 3+ times, whatever the jitter does."""
    vals: list = []
    for v, n, *_ in entries:
        vals.extend([v] * min(n, cap))
    i = 0
    while len(vals) < count and i < count * len(entries):
        v = entries[i % len(entries)][0]
        if vals.count(v) < cap:
            vals.append(v)
        i += 1
    vals = vals[:count]
    for _ in range(2):  # seeded jitter — a season leans a little differently each time
        if rng.next() < 0.6 and vals:
            frm = rng.int(len(vals))
            under = [v for v, *_ in entries if vals.count(v) < cap and v != vals[frm]]
            if under:
                vals[frm] = under[rng.int(len(under))]
    _shuffle(vals, rng)
    return vals


def _deal_unique(rng: "_Mulberry32", count: int, pool) -> list:
    """Deal ``count`` UNIQUE values from ``pool`` (pool ≥ count): seeded shuffle, take the head."""
    vals = list(pool)
    _shuffle(vals, rng)
    return vals[:count]


def mint_facet_ledger(seed, count: int, physical: Optional[list] = None, people: Optional[list] = None) -> list:
    """Mint the cast-wide FacetLedger: ``count`` per-slot hands, dealt from the stratified budgets
    on DEDICATED side-streams. ``physical`` (optional, from ``assign_genesis_slots``'s per-slot
    ``physical`` flags) aligns the vocation deal so every PHYSICAL COMPETITOR slot holds a
    physically-credible family — replacing the deleted un-ledgered "first-responder" prompt
    steering with a budgeted deal. Pure + player-blind: same (seed, count, physical) ⇒ the same
    ledger, byte for byte.

    ORW-1127: ``people`` (optional) is the roster's ``[{"ethnicity": ..., "age": ...}, ...]`` in slot order. The look (skin cue, hair
    texture and colour, eyes, face feature) is dealt as ONE coherent hand from the ranges that slot's heritage and age allow;
    with no ``people`` the heritage is dealt from a seeded US-shaped spread and the age is unknown (so never gray)."""
    if count <= 0:
        return []

    # VOCATION — its own stream; then align physically-credible families onto physical slots.
    v_rng = _Mulberry32(_hash_seed(f"{seed}:ledger:vocation"))
    families = _deal_budgeted(v_rng, count, VOCATION_FAMILIES)
    fam_physical = {f: phys for f, _n, phys in VOCATION_FAMILIES}
    if physical:
        for i in range(min(count, len(physical))):
            if not physical[i] or fam_physical.get(families[i], False):
                continue
            for j in range(count):
                if (j >= len(physical) or not physical[j]) and fam_physical.get(families[j], False):
                    families[i], families[j] = families[j], families[i]
                    break
    # The rare-outlier slot: a seeded minority of seasons re-deals ONE non-physical slot's family
    # to an odd corner of the world (real casts have exactly one rodeo clown, never three).
    if v_rng.next() < OUTLIER_VOCATION_CHANCE:
        outlier = OUTLIER_VOCATIONS[v_rng.int(len(OUTLIER_VOCATIONS))]
        candidates = [i for i in range(count)
                      if not (physical and i < len(physical) and physical[i])]
        if candidates:
            families[candidates[v_rng.int(len(candidates))]] = outlier

    r_rng = _Mulberry32(_hash_seed(f"{seed}:ledger:region"))
    regions = _deal_budgeted(r_rng, count, US_REGIONS)
    town_sizes = _deal_budgeted(r_rng, count, TOWN_SIZES)

    j_rng = _Mulberry32(_hash_seed(f"{seed}:ledger:jobs"))
    used_jobs: set = set()
    job_examples: list = []
    for fam in families:
        pool = [x for x in FAMILY_JOBS.get(fam, ()) if x not in used_jobs]
        _shuffle(pool, j_rng)
        picks = pool[:3]
        if len(picks) < 3 and FAMILY_JOBS.get(fam):  # a family dealt four or more times has run out of fresh jobs: reuse rather than offer none
            again = [x for x in FAMILY_JOBS[fam] if x not in picks]
            _shuffle(again, j_rng)
            picks += again[:3 - len(picks)]
        used_jobs.update(picks)
        job_examples.append(picks)
    # ORW-464: a state inside each slot's region, distinct across the cast. Its OWN side stream, so no other dealt value moves.
    st_rng = _Mulberry32(_hash_seed(f"{seed}:ledger:state"))
    states: list = []
    used_states: set = set()
    for region in regions:
        pool = [x for x in REGION_STATES.get(region, ()) if x not in used_states] or list(REGION_STATES.get(region, ()))
        pick = pool[st_rng.int(len(pool))] if pool else None
        states.append(pick)
        if pick:
            used_states.add(pick)

    b_rng = _Mulberry32(_hash_seed(f"{seed}:ledger:build"))
    builds = _deal_budgeted(b_rng, count, HEIGHT_BUILDS)

    looks = _deal_looks(seed, count, people)
    # A seeded 0-2 slots carry a BOLD hair statement (the hair lane's rare-outlier slots): marked ``lookKind: "outlier"``, and never an
    # older slot (a bold dye on a gray head reads as the gray-hair check's false alarm).
    h_rng = _Mulberry32(_hash_seed(f"{seed}:ledger:hair"))
    bold_n = h_rng.int(HAIR_BOLD_MAX + 1)
    bold_slots = list(range(count))
    _shuffle(bold_slots, h_rng)
    bold_done = 0
    for slot in bold_slots:
        if bold_done >= bold_n:
            break
        age = _age_int((people[slot] if people and slot < len(people) and isinstance(people[slot], dict) else {}).get("age"))
        if age is not None and age >= GRAY_HAIR_MIN_AGE:
            continue
        looks[slot]["hair"] = HAIR_BOLD[h_rng.int(len(HAIR_BOLD))]
        looks[slot]["hairTexture"] = None
        looks[slot]["hairColour"] = None
        if looks[slot]["lookKind"] == "heritage":
            looks[slot]["lookKind"] = "outlier"
        bold_done += 1

    t_rng = _Mulberry32(_hash_seed(f"{seed}:ledger:voicetic"))
    tics = _deal_unique(t_rng, count, VOICE_TICS)

    n_rng = _Mulberry32(_hash_seed(f"{seed}:ledger:phonology"))
    phon = _deal_unique(n_rng, count, NAME_PHONOLOGY)

    return [{
        "vocationFamily": families[i],
        "region": regions[i],
        "townSize": town_sizes[i],
        "jobExamples": job_examples[i],
        "state": states[i],
        "heightBuild": builds[i],
        **looks[i],
        "voiceTic": tics[i],
        "namePhonology": phon[i],
    } for i in range(count)]


def hand_for(seed, count: int, houseguest_id, physical: Optional[list] = None, people: Optional[list] = None) -> Optional[dict]:
    """The dealt hand for one ``npc:N`` id (roster order = slot order), or None for an id outside
    the roster shape/range. Re-mints the (pure, cheap) ledger — no state to thread."""
    try:
        n = int(str(houseguest_id).split(":", 1)[1])
    except (IndexError, ValueError):
        return None
    if not (1 <= n <= count):
        return None
    ledger = mint_facet_ledger(seed, count, physical, people)
    return ledger[n - 1] if ledger else None


def render_hand(hand: dict, hometown: bool = True) -> str:
    """One compact fixed-input clause rendering a dealt hand into a casting card."""
    if not isinstance(hand, dict):
        return ""
    return (
        f"vocation family: {hand.get('vocationFamily')} (pick a specific job inside it"
        + (f", for example {', '.join(hand['jobExamples'])}, or another ordinary job of this kind" if hand.get("jobExamples") else "")
        + "); "
        + (f"hometown: {hand.get('townSize')} in {hand.get('state') + ' (' + str(hand.get('region')) + ')' if hand.get('state') else hand.get('region')}; "
           if hometown else "") +
        f"height/build: {hand.get('heightBuild')}; "
        f"complexion depth (steering — heritage coherence wins): {hand.get('skinToneCue')}; "
        f"hair: {hand.get('hair')}; "
        + (f"face: {hand.get('facialFeatures')} (these belong together with the heritage, age and hair above); " if hand.get("facialFeatures") else "") +
        f"voice tic: {hand.get('voiceTic')}; "
        f"name phonology: {hand.get('namePhonology')}"
    )


def render_taken(ledger: list, exclude_index: Optional[int] = None) -> str:
    """The cast-wide TAKEN-LIST: a compact aggregation of every OTHER slot's dealt hand, injected
    into a per-NPC prompt so a single-slot call knows what the rest of the cast already occupies
    (concurrent calls cannot see each other — the ledger is their shared bible)."""
    fams: list = []
    regions: list = []
    phons: list = []
    states: list = []
    for i, hand in enumerate(ledger or []):
        if exclude_index is not None and i == exclude_index:
            continue
        if not isinstance(hand, dict):
            continue
        for coll, key in ((fams, "vocationFamily"), (regions, "region"), (phons, "namePhonology"), (states, "state")):
            v = hand.get(key)
            if v and v not in coll:
                coll.append(v)
    if not (fams or regions or phons or states):
        return ""
    return (
        "DEALT ACROSS THE REST OF THE CAST (their ground is taken — stay distinct on yours): "
        f"vocation families in play: {', '.join(fams)}. "
        f"home regions in play: {', '.join(regions)}. "
        + (f"home states taken: {', '.join(states)}. " if states else "") +
        f"name shapes in play: {'; '.join(phons)}."
    )
