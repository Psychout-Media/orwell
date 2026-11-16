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


def mint_facet_ledger(seed, count: int, physical: Optional[list] = None) -> list:
    """Mint the cast-wide FacetLedger: ``count`` per-slot hands, dealt from the stratified budgets
    on DEDICATED side-streams. ``physical`` (optional, from ``assign_genesis_slots``'s per-slot
    ``physical`` flags) aligns the vocation deal so every PHYSICAL COMPETITOR slot holds a
    physically-credible family — replacing the deleted un-ledgered "first-responder" prompt
    steering with a budgeted deal. Pure + player-blind: same (seed, count, physical) ⇒ the same
    ledger, byte for byte."""
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

    s_rng = _Mulberry32(_hash_seed(f"{seed}:ledger:skin"))
    skins = _deal_budgeted(s_rng, count, SKIN_TONE_CUES)

    h_rng = _Mulberry32(_hash_seed(f"{seed}:ledger:hair"))
    hairs = _deal_budgeted(h_rng, count, HAIR_STYLES)
    bold_n = h_rng.int(HAIR_BOLD_MAX + 1)  # 0-2 bold-hair outlier slots
    bold_slots = list(range(count))
    _shuffle(bold_slots, h_rng)
    for k in range(min(bold_n, count)):
        hairs[bold_slots[k]] = HAIR_BOLD[h_rng.int(len(HAIR_BOLD))]

    t_rng = _Mulberry32(_hash_seed(f"{seed}:ledger:voicetic"))
    tics = _deal_unique(t_rng, count, VOICE_TICS)

    n_rng = _Mulberry32(_hash_seed(f"{seed}:ledger:phonology"))
    phon = _deal_unique(n_rng, count, NAME_PHONOLOGY)

    return [{
        "vocationFamily": families[i],
        "region": regions[i],
        "townSize": town_sizes[i],
        "state": states[i],
        "heightBuild": builds[i],
        "skinToneCue": skins[i],
        "hair": hairs[i],
        "voiceTic": tics[i],
        "namePhonology": phon[i],
    } for i in range(count)]


def hand_for(seed, count: int, houseguest_id, physical: Optional[list] = None) -> Optional[dict]:
    """The dealt hand for one ``npc:N`` id (roster order = slot order), or None for an id outside
    the roster shape/range. Re-mints the (pure, cheap) ledger — no state to thread."""
    try:
        n = int(str(houseguest_id).split(":", 1)[1])
    except (IndexError, ValueError):
        return None
    if not (1 <= n <= count):
        return None
    ledger = mint_facet_ledger(seed, count, physical)
    return ledger[n - 1] if ledger else None


def render_hand(hand: dict, hometown: bool = True) -> str:
    """One compact fixed-input clause rendering a dealt hand into a casting card."""
    if not isinstance(hand, dict):
        return ""
    return (
        f"vocation family: {hand.get('vocationFamily')} (pick a specific job inside it); "
        + (f"hometown: {hand.get('townSize')} in {hand.get('state') + ' (' + str(hand.get('region')) + ')' if hand.get('state') else hand.get('region')}; "
           if hometown else "") +
        f"height/build: {hand.get('heightBuild')}; "
        f"complexion depth (steering — heritage coherence wins): {hand.get('skinToneCue')}; "
        f"hair: {hand.get('hair')}; "
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
