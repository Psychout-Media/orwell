"""Feature 0116 (phase 2 of the casting upgrade) — the FE model-authoring DRIVER for model-authored
cast GENESIS. Phase 1 (orwell_cast_authoring) re-routes the DEPTH to the model; this drives the
SKELETON itself: the producer-LLM proposes the ENTIRE 15-NPC cast — names, freeform identities,
personas, hidden elements, banded stats, and the pre-show tie graph — and the ENGINE validates,
clamps, repairs, and commits it inside an envelope it owns (``recordCastGenesis`` →
``src/engine/castGenesis.ts``, already shipped). Mirrors the sibling write-back drivers:

    engine pre-seeds the player-INDEPENDENT deterministic FLOOR cast (preSeedCast) + returns the
      Vault-free roster ids
      → THIS module: the producer-LLM proposes the WHOLE skeleton, steered ONLY by a seeded
        season brief (player-BLIND), as strict JSON
      → recordCastGenesis writes it back; the ENGINE validates the proposal against its envelope
        (banded stat clamp — no model number escapes; the cast-wide variance floor; name validators;
        the closed hidden-element kinds + C9 gates; tie-graph sanity; hidden-game-weight stripping),
        folds the committed skeleton onto the byte-stable warmed cast, and seals the hidden half
      → structured, Vault-free violations come back; a bounded re-roll (≤GENESIS_MAX_REROLLS) echoes
        the re-roll violations to the model and re-proposes.
      → only THEN do the 0063 identity seed + the phase-1 deep authoring run (pipeline order:
        SKELETON → identity → author → shoot), each reading the genesis-committed ground truth.

THE HARD BOUNDARY (mandate #3 anti-sycophancy + mandate #2 Vault Wall):
  * genesis is PLAYER-BLIND by construction — NOTHING about the player crosses into the sketch prompt
    (a structural gate over the assembled prompt, §8), so the cast cannot be bent toward a player it
    never saw; the engine's post-hoc near-duplicate nudge catches an accidental collision;
  * the model proposes ONLY descriptive identity + BANDED stats — NEVER a hidden game weight (influence,
    trigger arming/volatility, the Day-1 read of the player, soul baselines, showmance seeds, every
    magnitude stay engine-seeded off the committed cast). No model number escapes the engine's clamp;
  * the model NEVER seals anything — the engine owns the wall + the guarantee. This module only
    proposes + forwards; the private orientation is re-sealed engine-side.

Deterministic FLOOR is byte-neutral: no model / a failed call / garbage output ⇒ no proposal ⇒ the
engine's deterministic factory simply stands (the fail-soft write-back contract that keeps the stubbed
lanes + the golden replay byte-identical, §7). Under the DEFAULT ``strict`` enrichment policy a failure
is LOUD (an ERROR + an admin-visible ledger entry + the strict-failed latch the loud pre-finalize gate
reads, §4 / #1313 precedent); under ``soft`` it is the legacy silent no-op.

Design: the orchestrator (``seed_cast_genesis``) takes INJECTED ``llm_fn`` + ``write_fn``, so the whole
pipeline is unit-testable without a live model or engine. ``run_genesis`` wires the real deps and is
awaited inside the pre-warm author lane (``orwell_prewarm.prewarm_cast``) BEFORE identity + authoring —
genesis is a PRE-GAME operation (``recordCastGenesis`` is refused once the season runs), so it rides the
pre-warm that overlaps the casting interview and is done by finalize; game start never blocks on it.
"""
from __future__ import annotations

import asyncio
import json
from typing import Awaitable, Callable, Optional

try:  # the structured logger if present; a no-op stand-in keeps this importable in isolation
    from loguru import logger
except Exception:  # pragma: no cover
    class _L:  # minimal fallback
        def info(self, *a, **k): pass
        def warning(self, *a, **k): pass
        def error(self, *a, **k): pass
        def debug(self, *a, **k): pass
    logger = _L()


# ── the seeded SEASON BRIEF — a faithful Python port of src/engine/castGenesis.generateSeasonBrief ──────
#
# The engine derives the brief from a DEDICATED side-stream (`${seed}:genesis:brief`) so same seed ⇒ same
# brief (replayable) and the brief is player-INDEPENDENT (derived only from the seed). It STEERS the
# model's open-ended generation and NEVER binds a validator (only the engine's caps/floors/bands bind).
# The engine records ITS OWN brief off the same seed as the world-gen artifact; this faithful port makes
# the FE steer with the SAME brief the engine will record. The pools mirror src/engine/genesisConstants.ts
# (BRIEF_*), and the RNG mirrors SeededRandom (mulberry32) + hashSeed (FNV-1a 32-bit) exactly.

_U32 = 0xFFFFFFFF


def _hash_seed(s: str) -> int:
    """FNV-1a 32-bit, byte-identical to src/engine/characterFactory.hashSeed (Math.imul → mask u32)."""
    h = 0x811c9dc5
    for ch in s:
        h = ((h ^ ord(ch)) * 0x01000193) & _U32
    return h


class _Mulberry32:
    """A faithful port of src/adapters/random/SeededRandom (mulberry32). Unsigned-32-bit throughout —
    every JS `>>> 0` / `Math.imul` / bitwise op is emulated by masking to u32, so the stream is
    byte-identical to the engine's for a given seed. Pure: same seed → same stream."""

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

    def pick(self, items):
        return items[self.int(len(items))]


# Mirror of src/engine/genesisConstants.ts (BRIEF_* + the per-slot pools). Keep in lockstep with the
# engine pools so the FE steers with the same brief the engine records AND deals the same per-slot casting
# cards; a drift is only a cosmetic steering mismatch (none of this binds a validator), but the parity
# tests pin a few known seeds so a silent drift is caught.
#
# The old house-wide `ensembleVibe` was REMOVED (it homogenized the whole cast); the ensemble mood now
# rides per-slot as an ACCENT on a seeded 20–30% minority (`assign_genesis_slots`). The demographic +
# regional pools are widened to real, higher-dimensional age-shape / US-region lines.
BRIEF_DEMOGRAPHIC_SKEWS = (
    "skew younger — a twenties-heavy house with something to prove",
    "skew older — a cast of established adults with real lives on pause",
    "a wide age range, early-twenties up through the fifties",
    "a mostly-thirties professional class at a crossroads",
    "a youth-forward house with a couple of seasoned outliers",
    "an evenly-mixed generational spread, no dominant cohort",
    "a college-age-to-late-twenties house, few over thirty",
    "a barbell split — a young contingent and a veteran contingent, little in between",
    "a thirties-and-forties core with a couple of early-twenties wildcards",
    "a house anchored by forty- and fifty-somethings with real careers",
    "a Gen-Z-heavy cast raised online",
    "a millennial-dominant house in the thick of career and family pressure",
    "a late-twenties-to-mid-thirties cluster, everyone at a turning point",
    "a multi-generational mix from twenty-one to the early sixties",
)
BRIEF_REGIONAL_FLAVORS = (
    "a heavy Gulf-coast contingent",
    "a Pacific-Northwest-leaning cast",
    "a Northeast-urban skew",
    "a Midwest-heartland core",
    "a Southern-heavy house",
    "a coast-to-coast spread with no regional center",
    "a Mountain-West and desert-Southwest lean",
    "a mix of small-town roots and big-city transplants",
    "a California-heavy cast, NorCal to SoCal",
    "a Deep-South and Appalachian core",
    "a Texas-and-the-Southwest contingent",
    "a Great-Lakes and Rust-Belt skew",
    "a Florida-and-Southeast lean",
    "a New-England and Mid-Atlantic tilt",
    "a Plains-and-prairie heartland cast",
    "a mix of Sun-Belt transplants and lifelong locals",
)
# Per-slot ENSEMBLE ACCENTS (the de-homogenized replacement for the house-wide ensembleVibe): a distinct
# house-mood carried by only a seeded 20–30% of the cast; broad + orthogonal so the accented minority
# reads varied. Mirror of GENESIS_ENSEMBLE_ACCENTS.
GENESIS_ENSEMBLE_ACCENTS = (
    "a slow-burn grudge-holder who never forgets a slight",
    "a loud, clash-forward instigator who won't let a fight rest",
    "a warm, alliance-hungry connector who bonds fast and hard",
    "a cerebral, quiet strategist who plays three moves ahead",
    "a chaotic wildcard whose loyalties never quite hold",
    "a status-hungry spotlight-chaser used to being the main character",
    "a written-off underdog with a chip on their shoulder",
    "a hopeless romantic wired for a showmance",
    "a relentless optimist who reframes every disaster as a bonding moment",
    "a deadpan cynic narrating the house like a nature documentary",
    "a rule-obsessed traditionalist who polices etiquette and the chore wheel",
    "a conspiracy-minded paranoiac who reads a threat into everything",
    "a big-hearted house-parent who mothers everyone whether they like it or not",
    "an unbothered floater who drifts through the drama untouched",
    "a competitive gym-rat who turns every dish and doorway into a contest",
    "a gossip-hungry information broker who trades secrets like currency",
    "a theatrical drama-magnet forever narrating their own storyline",
    "a stoic lone-wolf who keeps their cards close and their distance closer",
    "a people-pleasing peacemaker terrified of being disliked",
    "a blunt truth-teller with no interior monologue and no filter",
    "a superstitious ritualist with a lucky charm for every competition",
    "a homesick sweetheart who wears every emotion on their sleeve",
    "a smooth operator who charms first and schemes later",
    "a restless live-wire who cannot sit still or stay quiet",
)
# Per-slot DIVERSITY AXES — independent seeded delivery dials drawn for EVERY slot (wide + orthogonal so
# per-person variety is seeded, not left to sampling temperature). Mirror of GENESIS_*_AXIS.
GENESIS_ENERGY_AXIS = (
    "subdued and low-key",
    "calm and measured",
    "steady and even-keeled",
    "warm and animated",
    "high-energy and bouncy",
    "restless and wired",
    "explosive and larger-than-life",
    "mellow to the point of sleepy",
)
GENESIS_REGISTER_AXIS = (
    "blunt and plainspoken",
    "clipped and economical",
    "dry and understated",
    "folksy and colloquial",
    "polished and articulate",
    "ornate and theatrical",
    "flowery and effusive",
    "slangy and irreverent",
)
GENESIS_EXPRESSIVENESS_AXIS = (
    "guarded and buttoned-up",
    "reserved and hard to read",
    "measured, reveals little",
    "openly emotional",
    "expressive and demonstrative",
    "unfiltered and says everything out loud",
    "loud and impossible to ignore",
    "theatrically over-sharing",
)
# Three FURTHER orthogonal axes (owner casting-craft upgrade). Mirror of GENESIS_*_AXIS.
GENESIS_EMOTIONAL_REGISTER_AXIS = (
    "hot-reactive — quick to laugh, cry, or blow up",
    "warm and easily moved",
    "even-tempered",
    "cool and slow to react",
    "cold and hard to rattle",
    "volatile — swings fast between extremes",
)
GENESIS_SELF_AWARENESS_AXIS = (
    "deluded — certain they're the smartest strategist in the house",
    "overconfident, always a step behind their own reputation",
    "a clear, realistic read on themselves",
    "sharply self-aware, clocks their own tells",
    "insecure, quietly underrates themselves",
)
GENESIS_SOCIAL_GRAVITY_AXIS = (
    "a magnetic main-character who fills the room",
    "a natural center of attention",
    "sociable, comfortable in any group",
    "quietly present, part of the furniture",
    "a loner who orbits the edges of the house",
)
# The LOUD ends of the amplifiable axes — an amplified "big personality" slot draws ONLY from these.
GENESIS_ENERGY_LOUD = (
    "warm and animated", "high-energy and bouncy", "restless and wired", "explosive and larger-than-life",
)
GENESIS_EXPRESSIVENESS_LOUD = (
    "openly emotional", "expressive and demonstrative", "unfiltered and says everything out loud",
    "loud and impossible to ignore", "theatrically over-sharing",
)
GENESIS_EMOTIONAL_REGISTER_LOUD = (
    "hot-reactive — quick to laugh, cry, or blow up", "volatile — swings fast between extremes",
    "warm and easily moved",
)
GENESIS_SOCIAL_GRAVITY_LOUD = (
    "a magnetic main-character who fills the room", "a natural center of attention",
)
GENESIS_AMPLIFIED_MIN = 4
GENESIS_AMPLIFIED_SPAN = 2  # 4 or 5 amplified per cast (owner: guarantee 3-4+ loud)

# The seeded LOOK LANE (2026-07-21 prompt audit — the cast-uniformity index case). Mirror of
# GENESIS_INK_MIN / GENESIS_INK_SPAN / GENESIS_LOOK_FEATURES: a seeded 2-4 slots per cast are the
# visibly-tattooed contingent; every other slot is explicitly no-visible-ink and carries a suggested
# distinguishing feature from this wide pool (scars/freckles/glasses/jewelry/teeth/nothing-notable),
# so the model's tattoo prior can never uniformize the cast. Steering only, never a validator.
GENESIS_INK_MIN = 2
GENESIS_INK_SPAN = 2  # 2-4 visibly-tattooed slots per cast
GENESIS_LOOK_FEATURES = (
    "wire-rimmed glasses",
    "a faint scar with a story behind it",
    "freckles",
    "a gap-toothed grin",
    "a birthmark",
    "deep dimples",
    "a chipped front tooth",
    "a distinctive piece of everyday jewelry",
    "laugh lines",
    "a beauty mark",
    "no single notable mark — a plain, clean look",
    "no single notable mark — ordinary and unremarkable up close",
    "no single notable mark — the kind of face that blends into a crowd photo",
)

# The seeded AGE curve (owner casting-craft upgrade) — mirror of GENESIS_AGE_BANDS: [lo, hi, count].
GENESIS_AGE_BANDS = ((21, 26, 4), (27, 33, 5), (34, 45, 4), (46, 60, 2))

# The CASTING-ROLE vocabulary + quota — mirror of GENESIS_CASTING_ROLES. Each: (role, archetype, cerebral,
# physical, note). `archetype` maps the rich role to one of the 12 mechanical archetype tags the engine
# owns (the enum is NOT expanded — that would shift the deterministic floor + calibration).
GENESIS_CASTING_ROLES = (
    ("comp-beast (humble)", "comp-beast", False, True,
     "a genuine physical/endurance threat who lets the wins speak — quietly dangerous"),
    ("comp-threat self-mastermind", "comp-beast", False, True,
     "a physical player convinced he is ALSO a strategic genius — narrates himself as the mastermind"),
    ("mastermind", "mastermind", True, False,
     "the quiet architect running the house three moves ahead"),
    ("under-the-radar assassin", "floater", False, False,
     "a floater FACADE with a mastermind underneath — harmless-looking, quietly lethal"),
    ("analyst", "analyst", True, False,
     "reads the board like a spreadsheet, all logic and probabilities"),
    ("floater", "floater", False, False,
     "drifts to whoever holds power, never a target, never a leader"),
    ("villain", "villain", False, False,
     "the willing bad guy — but SECRETLY believes they're the hero, the loyal one, or the victim"),
    ("underdog", "underdog", False, False,
     "written off early, playing with a chip on their shoulder"),
    ("showmance instigator", "flirt", False, False,
     "here to spark a romance — flirts hard, wants a showmance nucleus"),
    ("flirt", "flirt", False, False,
     "charming and touchy, plays the social-romantic angle"),
    ("hothead", "hothead", False, True,
     "a short fuse who detonates the house on a dime"),
    ("america's sweetheart", "social-butterfly", False, False,
     "beloved, warm, non-threatening — everyone's friend, floats on goodwill"),
    ("mom/dad figure", "peacemaker", False, False,
     "the house parent who feeds and mediates everyone — and is SECRETLY cutthroat underneath"),
    ("wildcard", "wildcard", False, False,
     "chaotic and unpredictable, loyal to nothing, capable of anything"),
    ("loyalist", "loyalist", False, False,
     "rides for their ride-or-die to a fault, loyalty over logic"),
    ("superfan gamebot", "analyst", True, False,
     "an over-studied superfan who quotes past seasons and over-plays their BB knowledge"),
)
GENESIS_ROLE_MAX_PER_CAST = 2
GENESIS_CEREBRAL_MAX_PER_CAST = 3
# The believable BB casting recipe (essential→optional order) + the seeded underdog flex. Mirror of the
# engine's GENESIS_CASTING_RECIPE / GENESIS_UNDERDOG_FLEX.
_GENESIS_CASTING_RECIPE = (
    "comp-beast (humble)", "mastermind", "floater", "villain", "showmance instigator", "flirt",
    "hothead", "america's sweetheart", "mom/dad figure", "underdog", "comp-threat self-mastermind",
    "under-the-radar assassin", "wildcard", "loyalist", "floater", "analyst",
)
_GENESIS_UNDERDOG_FLEX = ("underdog", "analyst", "superfan gamebot")

# The seeded accent-fraction band. Mirror of GENESIS_ACCENT_FRACTION. GENDER/pronouns are deliberately
# NOT seeded — the identity model proposes correct, diverse, name-coherent genders and diversity.ts is the
# coherence authority; genesis only asks (in prose) that each houseguest's chosen pronouns stay consistent.
GENESIS_ACCENT_FRACTION_MIN = 0.2
GENESIS_ACCENT_FRACTION_MAX = 0.3


def generate_season_brief(seed: int) -> dict:
    """Derive the seeded season brief — byte-identical to src/engine/castGenesis.generateSeasonBrief.
    Same seed ⇒ same brief; player-INDEPENDENT (seed-only). Returns ``{demographicSkew, regionalFlavor}``
    (the old house-wide ``ensembleVibe`` is gone — the ensemble mood now rides per-slot, see
    ``assign_genesis_slots``)."""
    rng = _Mulberry32(_hash_seed(f"{seed}:genesis:brief"))
    return {
        "demographicSkew": rng.pick(BRIEF_DEMOGRAPHIC_SKEWS),
        "regionalFlavor": rng.pick(BRIEF_REGIONAL_FLAVORS),
    }


def render_season_brief(b: dict) -> str:
    """One short casting-direction line for the sketch prompt (mirrors engine renderSeasonBrief)."""
    if not isinstance(b, dict):
        return ""
    return f"This season: {b.get('demographicSkew', '')}; {b.get('regionalFlavor', '')}."


# ── the seeded PER-SLOT casting directives (the cross-cast constraints, computed up front) ──────────────
# Genesis authors ONE houseguest per LLM call (a call cannot see its siblings), so EVERY cross-cast
# constraint — the casting-role quota, the age curve, the accented minority, the amplified-loud contingent —
# is dealt HERE, seeded + deterministic, and injected into each per-NPC prompt as a fixed casting card.
# Byte-identical to src/engine/castGenesis.assignGenesisSlots (same side-streams, same Fisher–Yates, same
# rounding). GENDER is NOT seeded (the identity model proposes coherent, diverse genders — course-correction).

def _seeded_shuffle(arr: list, rng: "_Mulberry32") -> None:
    """Fisher–Yates in place, driven by the seeded RNG (identical stream ⇒ identical permutation)."""
    i = len(arr) - 1
    while i > 0:
        j = rng.int(i + 1)
        arr[i], arr[j] = arr[j], arr[i]
        i -= 1


_ROLE_BY_LABEL = {r[0]: r for r in GENESIS_CASTING_ROLES}


def _build_casting_plan(rng: "_Mulberry32", count: int) -> list:
    """Build the seeded casting PLAN — a believable role multiset honoring the per-role + cerebral caps.
    Mirrors the engine's buildCastingPlan."""
    plan = []
    role_counts: dict = {}
    cerebral = [0]

    def try_add(label: str) -> bool:
        r = _ROLE_BY_LABEL[label]
        if role_counts.get(label, 0) >= GENESIS_ROLE_MAX_PER_CAST:
            return False
        if r[2] and cerebral[0] >= GENESIS_CEREBRAL_MAX_PER_CAST:  # r[2] = cerebral
            return False
        plan.append(r)
        role_counts[label] = role_counts.get(label, 0) + 1
        if r[2]:
            cerebral[0] += 1
        return True

    for label in _GENESIS_CASTING_RECIPE:
        if len(plan) >= count:
            break
        try_add(label)
    guard = 0
    while len(plan) < count and guard < count * len(_GENESIS_CASTING_RECIPE):
        guard += 1
        added = False
        for label in _GENESIS_CASTING_RECIPE:
            if len(plan) >= count:
                break
            if try_add(label):
                added = True
        if not added:
            break
    # Seeded flex: swap the (first) underdog for a seeded alternate — inter-season cerebral-slot variety.
    flex = _GENESIS_UNDERDOG_FLEX[rng.int(len(_GENESIS_UNDERDOG_FLEX))]
    if flex != "underdog":
        idx = next((k for k, r in enumerate(plan) if r[0] == "underdog"), -1)
        alt = _ROLE_BY_LABEL[flex]
        if idx >= 0 and not (alt[2] and cerebral[0] >= GENESIS_CEREBRAL_MAX_PER_CAST):
            plan[idx] = alt
    _seeded_shuffle(plan, rng)
    return plan


def _build_age_plan(rng: "_Mulberry32", count: int) -> list:
    """Build the seeded AGE plan — the real-world cast age curve, one (lo, hi) per slot, shuffled. Mirrors
    the engine's buildAgePlan."""
    bands = []
    base_total = sum(b[2] for b in GENESIS_AGE_BANDS)
    for lo, hi, cnt in GENESIS_AGE_BANDS:
        n = max(0, round((cnt / base_total) * count))
        bands.extend([(lo, hi)] * n)
    while len(bands) < count:
        bands.append((GENESIS_AGE_BANDS[0][0], GENESIS_AGE_BANDS[0][1]))
    bands = bands[:count]
    _seeded_shuffle(bands, rng)
    return bands


def assign_genesis_slots(seed: int, count: int) -> list[dict]:
    """Deal the seeded per-slot casting cards for ``count`` houseguests (roster order) — byte-identical to
    the engine's ``assignGenesisSlots``. Each cross-cast constraint runs on its OWN dedicated side-stream
    (RNG isolation) so adding/removing one never perturbs the others. Returns a list of
    ``{role, roleNote, archetype, physical, ageLo, ageHi, accent, amplified, energy, register,
    expressiveness, emotionalRegister, selfAwareness, socialGravity}``. GENDER is deliberately NOT seeded
    — the identity model proposes correct, diverse, name-coherent genders. PURE + player-blind."""
    if count <= 0:
        return []

    # 1. ROLE — the believable casting plan (rich roles mapped to mechanical archetype tags).
    role_plan = _build_casting_plan(_Mulberry32(_hash_seed(f"{seed}:genesis:roles")), count)
    # 2. AGE — the real-world age curve.
    age_plan = _build_age_plan(_Mulberry32(_hash_seed(f"{seed}:genesis:ages")), count)

    # 3. ACCENT — a seeded 20–30% carry a distinct ensemble accent; the rest are their own people.
    c_rng = _Mulberry32(_hash_seed(f"{seed}:genesis:accent"))
    fraction = GENESIS_ACCENT_FRACTION_MIN + c_rng.next() * (GENESIS_ACCENT_FRACTION_MAX - GENESIS_ACCENT_FRACTION_MIN)
    accent_count = max(0, min(count, int(count * fraction + 0.5)))
    carry = ([True] * accent_count) + ([False] * (count - accent_count))
    _seeded_shuffle(carry, c_rng)
    accent_pool = list(GENESIS_ENSEMBLE_ACCENTS)
    _seeded_shuffle(accent_pool, c_rng)
    accent_cursor = 0

    # 3.5. LOOK LANE (2026-07-21 prompt audit) — a seeded 2-4 slots carry the cast's visible ink; every
    # other slot is explicitly no-visible-ink with a suggested feature from a shuffled wide pool. Its
    # OWN dedicated side-stream (`:genesis:looks`) — byte-identical to the engine's deal.
    l_rng = _Mulberry32(_hash_seed(f"{seed}:genesis:looks"))
    ink_count = max(0, min(count, GENESIS_INK_MIN + l_rng.int(GENESIS_INK_SPAN + 1)))
    inked = ([True] * ink_count) + ([False] * (count - ink_count))
    _seeded_shuffle(inked, l_rng)
    feature_pool = list(GENESIS_LOOK_FEATURES)
    _seeded_shuffle(feature_pool, l_rng)
    feature_cursor = 0

    # 4. AXES — six delivery dials; a seeded 4–5 "amplified" slots draw ONLY from the loud ends.
    x_rng = _Mulberry32(_hash_seed(f"{seed}:genesis:axes"))
    amplified_count = max(0, min(count, GENESIS_AMPLIFIED_MIN + x_rng.int(GENESIS_AMPLIFIED_SPAN + 1)))
    amplified = ([True] * amplified_count) + ([False] * (count - amplified_count))
    _seeded_shuffle(amplified, x_rng)

    def pick(full, loud, amp):
        pool = loud if amp else full
        return pool[x_rng.int(len(pool))]

    out = []
    for i in range(count):
        role = role_plan[i]
        amp = amplified[i]
        accent = None
        if carry[i]:
            accent = accent_pool[accent_cursor % len(accent_pool)]
            accent_cursor += 1
        out.append({
            "role": role[0],
            "roleNote": role[4],
            "archetype": role[1],
            "physical": role[3],
            "ageLo": age_plan[i][0],
            "ageHi": age_plan[i][1],
            "accent": accent,
            "amplified": amp,
            "energy": pick(GENESIS_ENERGY_AXIS, GENESIS_ENERGY_LOUD, amp),
            "register": GENESIS_REGISTER_AXIS[x_rng.int(len(GENESIS_REGISTER_AXIS))],
            "expressiveness": pick(GENESIS_EXPRESSIVENESS_AXIS, GENESIS_EXPRESSIVENESS_LOUD, amp),
            "emotionalRegister": pick(GENESIS_EMOTIONAL_REGISTER_AXIS, GENESIS_EMOTIONAL_REGISTER_LOUD, amp),
            "selfAwareness": GENESIS_SELF_AWARENESS_AXIS[x_rng.int(len(GENESIS_SELF_AWARENESS_AXIS))],
            "socialGravity": pick(GENESIS_SOCIAL_GRAVITY_AXIS, GENESIS_SOCIAL_GRAVITY_LOUD, amp),
            "ink": inked[i],
            "lookFeature": "" if inked[i] else feature_pool[feature_cursor % len(feature_pool)],
        })
        if not inked[i]:
            feature_cursor += 1
    return out


def render_slot_directive(hid: str, d: dict) -> str:
    """Render one slot's casting card as a compact fixed-input line for the sketch prompt (mirrors the
    engine's renderSlotDirective; the T0-6 FacetLedger hand — when dealt — rides as an extra clause).

    T0-6: the old un-ledgered "athletic/first-responder/performer" steering line is DELETED — a
    physical slot's job now comes from its DEALT vocation family (a budgeted deal, not a prompt
    cluster), so the phys note only asks for credibility inside that family."""
    accent = f"house-accent: {d.get('accent')}" if d.get("accent") else "no house-accent (their own person)"
    phys = (" PHYSICAL COMPETITOR (give a high physical stat and pick a physically credible job inside "
            "the dealt vocation family).") if d.get("physical") else ""
    big = (" BIG PERSONALITY — write them genuinely loud/reactive/unfiltered; do NOT let the accent tone "
           "them down.") if d.get("amplified") else ""
    look = ("look: visible tattoos ARE part of their look (one of the cast's few inked houseguests — "
            "make the ink specific and personal)") if d.get("ink") else (
        f"look: NO visible tattoos; distinguishing feature, if any: {d.get('lookFeature')}")
    # T0-6: the dealt FacetLedger hand rides the card as an extra fixed-input clause (absent in a
    # legacy/no-ledger card ⇒ byte-identical output — back-compatible with every existing caller).
    hand = d.get("ledger")
    hand_clause = ""
    if isinstance(hand, dict):
        try:
            from src.orwell_facet_ledger import render_hand
            rendered = render_hand(hand)
            if rendered:
                hand_clause = f" DEALT FACETS: {rendered}."
        except Exception:  # pragma: no cover - defensive: a ledger hiccup never breaks the card
            hand_clause = ""
    return (f"{hid} — cast as: {d.get('role')} ({d.get('roleNote')}); archetype tag: {d.get('archetype')}; "
            f"age ~{d.get('ageLo')}-{d.get('ageHi')} (name from that birth era); {accent}; "
            f"energy: {d.get('energy')}; register: {d.get('register')}; "
            f"expressiveness: {d.get('expressiveness')}; reactivity: {d.get('emotionalRegister')}; "
            f"self-awareness: {d.get('selfAwareness')}; social-gravity: {d.get('socialGravity')}; "
            f"{look}."
            + phys + big + hand_clause)


# ── the envelope vocabulary (mirrors src/engine/castGenesis.ts + genesisConstants.ts) ───────────────────
# The ENGINE is the authority — it clamps stats into its band, validates names, closes the hidden-element
# kinds, C9-gates them, checks tie-graph sanity, and strips hidden weights — so this vocabulary only shapes
# the PROMPT + a light FE pre-filter. Keep it in sync with the engine so the model proposes valid shapes.
_ARCHETYPES = (
    "comp-beast", "mastermind", "social-butterfly", "floater", "villain", "underdog",
    "flirt", "loyalist", "wildcard", "analyst", "hothead", "peacemaker",
)
# Mirror of the engine's TIE_NATURES (src/engine/seededRelationships.ts). #1909: the pre-show romance nature was renamed
# "showmance" -> "prior-romance" (the in-house Showmance ARC keeps the word); "showmance" is still ACCEPTED from older
# model output / prompts and aliased forward. Natures are flavour only: no nature is a competition or vote input.
_TIE_NATURES = (
    "casting-callback", "mutual-friend", "shared-hometown", "old-acquaintance", "prior-romance",
    "family", "ex", "old-friend", "rival", "former-teammate", "online-acquaintance",
)
_LEGACY_TIE_NATURE_ALIASES = {"showmance": "prior-romance"}
# The freely-authorable hidden-element kinds. `concealed-aptitude` is engine-stat-gated (a free-text one
# is stripped) and `trigger` is engine-armed (never proposable), so we steer the model AWAY from both —
# the engine strips them regardless; omitting them keeps the per-NPC count above the 3-min floor.
_HIDDEN_KINDS = ("secret-motive", "pre-game-tie", "divergent-persona")

# Mirror of GENESIS_HIDDEN_ELEMENT_RANGE / GENESIS_TIE_BUDGET / GENESIS_MAX_REROLLS / the stat band.
GENESIS_HIDDEN_MIN = 3
GENESIS_HIDDEN_MAX = 6
GENESIS_TIE_BUDGET = 2
#: The bounded re-roll budget N (§4) — mirrors GENESIS_MAX_REROLLS in src/engine/genesisConstants.ts.
GENESIS_MAX_REROLLS = 3
# The stat band the ENGINE owns (src/engine/genesisConstants.ts) — echoed in the prompt as guidance so the
# model proposes in-range; the engine clamps regardless (no model number escapes).
_STAT_MIN, _STAT_MAX = 0.2, 0.9
_TOTAL_LO, _TOTAL_HI = 1.47, 2.1


# ── the producer-framed genesis sketch prompt (player-BLIND — a structural gate) ────────────────────────
#
# ANTI-SYCOPHANCY (mandate #3): the WHOLE cast is designed as if the player does not exist. The prompt
# carries NO player identity at all — no name, no casting answer, no profile field. The cast is steered
# ONLY by the seeded season brief (player-independent) so it cannot tilt toward (or against) the player,
# and the calibration balance (juryReach) is preserved: the model authors WHO people are; the engine keeps
# HOW MUCH anything weighs (every hidden game weight stays engine-seeded).
_SYSTEM = (
    "You are the CASTING DIRECTOR for a Big Brother season, designing houseguests from scratch. Invent "
    "vivid, distinctive, reality-TV-plausible people — no two alike, each with their own life, look, "
    "voice, and secret game. Author ONLY the houseguest id(s) you are given below. Output STRICT JSON "
    "only (no prose around it): an object with two keys, \"npcs\" and \"ties\".\n"
    "Each houseguest comes with a CASTING CARD — fixed inputs you MUST honor for that person:\n"
    "  * CAST AS: a Big Brother casting type + a one-line note. Build this person AS that type; if the "
    "note names a hidden belief or twist (e.g. a villain who secretly believes they're the hero, a "
    "house-parent who is secretly cutthroat, a self-styled 'genius'), FOLD it into their identity and a "
    "hidden element.\n"
    "  * ARCHETYPE TAG: the exact mechanical tag to put in the \"archetype\" field (do not substitute).\n"
    "  * AGE ~lo-hi: put an integer age in that band and pick a given name from that BIRTH ERA.\n"
    "  * HOUSE-ACCENT: a distinct house mood — if one is given, let it color this person; if 'no "
    "house-accent', they are simply their own person, not colored by any single mood.\n"
    "  * DELIVERY DIALS (energy / register / expressiveness / reactivity / self-awareness / "
    "social-gravity): push them to their FULL extreme — a 'loud and impossible to ignore', 'hot-reactive', "
    "'deluded', or 'main-character' card means a genuinely loud/reactive/deluded/spotlight-hogging person, "
    "NOT a muted version; a 'guarded'/'cold'/'loner' card means someone genuinely closed-off. If a card "
    "says PHYSICAL COMPETITOR, give a high physical stat and pick a physically credible job inside the "
    "dealt vocation family. If it says BIG PERSONALITY, do NOT let the accent or anything else tone them "
    "down. The cast should span the WHOLE range, never cluster in a polite reserved middle.\n"
    "  * DEALT FACETS (T0-6 — the casting office's ONE bible; fixed inputs): when the card deals a "
    "vocation family, hometown (town-size + region), height/build, complexion depth, hair, voice tic, or "
    "name phonology, honor EACH one for that houseguest — pick the specific job inside the dealt family, "
    "a real city of the dealt size in the dealt region, a name that fits the dealt phonology, and weave "
    "the dealt voice tic into how they talk. The complexion cue is steering — coherence with the "
    "houseguest's own heritage wins. A 'DEALT ACROSS THE REST OF THE CAST' line lists the ground the "
    "OTHER houseguests already hold: stay distinct from it (their families, regions, and name shapes are "
    "taken).\n"
    "  * LOOK: the card's ink budget is FIXED. 'visible tattoos ARE part of their look' means this is "
    "one of the cast's FEW inked houseguests — make the ink specific and personal (what, where, why). "
    "'NO visible tattoos' means exactly that: no sleeve, no forearm script, no neck/hand ink anywhere in "
    "their appearance, biography, or secrets — a real cast has only a small tattooed minority, so NEVER "
    "invent ink the card did not grant. Where the card suggests a distinguishing feature (glasses, a "
    "scar, freckles, a birthmark, jewelry — or nothing notable), work THAT into the look instead; plenty "
    "of real faces have no single notable mark at all.\n"
    "\"npcs\": an array, ONE object PER houseguest id given below (keep the SAME ids), each with:\n"
    '  "id": the exact houseguest id from the roster below (echo it verbatim).\n'
    '  "name": a normal, real, everyday FIRST and LAST name (EXACTLY two words) that a modern American '
    "reality-TV contestant could actually have. Ordinary surnames are SOMETIMES a little distinctive and "
    "sometimes perfectly plain — both are fine; don't force blandness, and don't reach for anything "
    "flashy either. A familiar short-form or nickname given name (Mike, Liz, Gabe, Nat, Cass) is totally "
    "fine. Pick a given name that fits this houseguest's AGE and BIRTH ERA (people are named in different "
    "decades — a name that fits a 24-year-old need not fit a 55-year-old), fits their region/heritage, and "
    "AVOID overtly Biblical / scriptural given names (e.g. not Ryne, Marcus, or Felix). NAME SHAPE (just "
    "get each name right on its own — a single bad name only falls back to a default for THAT one "
    "houseguest, it never redraws the cast): (1) EXACTLY two plain words, a given name then a surname — "
    "never a single word, never three-plus words. (2) letters only — NO titles, honorifics, initials, "
    "middle names, quoted nicknames, hyphenated compounds, numerals, punctuation, emoji, or markup "
    "(roughly 3-12 letters per word). (3) not invented, fantasy, gibberish, or stage-name shaped. "
    "(4) do NOT reuse any first name OR surname already listed as taken by an earlier houseguest.\n"
    '  "identity": ONE vivid sentence capturing who this person IS — their concept in your own words '
    "(this is what the show voices; make each unmistakably distinct).\n"
    '  "archetype": use EXACTLY the archetype tag given in this houseguest\'s casting card (do not '
    "substitute a different one).\n"
    '  "vocation": a SHORT occupation noun phrase (e.g. "court reporter") — a specific job inside the '
    "casting card's DEALT vocation family (a PHYSICAL COMPETITOR card means a physically credible job in "
    "that family); favor castable, story-rich jobs over generic desk work, and NEVER a job already listed "
    "as taken by an earlier houseguest.\n"
    '  "hometown": a US hometown (city, state) that fits the season\'s regional flavor. Every houseguest '
    "comes from a DIFFERENT city — never reuse a hometown listed as taken, and never default to the same "
    "famous metro: suburbs, small cities, and towns are exactly as castable as big cities (a real cast "
    "comes from Chula Vista, Waco, and Kenosha as often as from Chicago or San Diego).\n"
    '  "demeanor": a short phrase for how they carry themselves (e.g. "warm but guarded").\n'
    '  "background": a short phrase of life context.\n'
    '  "biography": a 2-3 sentence presentable backstory (their life outside the house).\n'
    '  "appearance": a short concrete phrase describing their look, written with NO pronouns and NO gendered words '
    "(their gender is pinned in a later step, so \"her hazel eyes\" / \"his jaw\" would contradict it; say \"hazel eyes\", \"a square jaw\") and consistent "
    "with the casting card's look line — the ink budget and any suggested feature are fixed inputs.\n"
    '  "age": an integer age inside the casting card\'s age band.\n'
    '  "stats": { "physical", "mental", "social" } — three numbers, EACH between '
    f"{_STAT_MIN} and {_STAT_MAX}, whose TOTAL lands roughly between {_TOTAL_LO} and {_TOTAL_HI}. "
    "VARY the totals WIDELY across the cast — real competition beasts (high totals) AND real floaters "
    "(low totals), never fifteen identical mid-liners. These describe raw aptitude, not who wins.\n"
    f'  "hiddenElements": an array of {GENESIS_HIDDEN_MIN} to {GENESIS_HIDDEN_MAX} SECRETS, each '
    '{ "kind", "detail" } where kind is one of "secret-motive" (AT MOST ONE per houseguest), '
    '"pre-game-tie", or "divergent-persona", and detail is one vivid sentence in your own words. '
    "Ground each secret in THIS person's specific life. "
    f"EVERY houseguest MUST have AT LEAST {GENESIS_HIDDEN_MIN} hidden elements "
    f"(aim for {GENESIS_HIDDEN_MIN}-{GENESIS_HIDDEN_MAX}) — count the array for each houseguest before "
    "moving to the next.\n"
    '"ties": an array of 0 to ' + str(GENESIS_TIE_BUDGET) + " pre-show connections between houseguests "
    '(sparse by design — often just one, sometimes none), each { "a", "b", "nature", "backstory" } '
    "where a and b are two DIFFERENT houseguest ids from the roster, nature is one of "
    f"{', '.join(_TIE_NATURES)} (family means siblings or cousins; rival means real bad blood; keep them plausible for a "
    "reality-show cast and vary them), and backstory is one sentence. No houseguest may appear in more than "
    "one tie.\n"
    "COHERE every houseguest's name, look, hometown, vocation, and age with each other and with the "
    "season brief. Make the cast reflect a real, diverse American crew. Assign EVERY id in the roster.\n"
    "IDENTITY COHERENCE (HARD): pin each houseguest's CHOSEN PRONOUNS FIRST (you decide them — make the "
    "cast's genders varied and realistic, women, men, and the occasional nonbinary houseguest), then give "
    "them a name and an appearance that match, and keep EVERY self-reference to that houseguest — across "
    "their identity, biography, appearance, and secrets — consistent with those pronouns. Within a SINGLE "
    "houseguest, NEVER refer to the houseguest with pronouns other than their chosen pronouns (no 'her "
    "shyness' beside 'his forearm'). Keep their age consistent with their life story (do not write 'spent "
    "thirty years' or 'grandmother' for someone in their twenties), and keep their stated occupation the "
    "same throughout (the biography and secrets must not name a different job than the vocation).\n"
    "OUTPUT CONTRACT (HARD): reply with a SINGLE raw JSON object and NOTHING else — no prose, no "
    "markdown, no ```json fences, no preamble. The first character MUST be '{' and the last MUST be '}'."
)

_STRICT_RETRY = (
    "Your previous reply did not contain a parseable JSON object. Reply now with ONLY the JSON object — "
    "start with '{', end with '}', no prose, no markdown, no fences."
)


def build_genesis_messages(roster: list, brief: dict,
                           violation_feedback: Optional[str] = None,
                           directives: Optional[dict] = None,
                           used_names: Optional[list] = None,
                           used_facets: Optional[dict] = None) -> list[dict]:
    """The producer prompt for the WHOLE cast (or, in the live per-NPC path, one houseguest). Seeds the
    model with the season BRIEF (player-independent steering), the roster IDS, and — when supplied — each
    id's seeded CASTING CARD (role / age / accent / delivery axes: the cross-cast constraints dealt up
    front by ``assign_genesis_slots`` and injected as fixed inputs, since a per-NPC call cannot see the
    rest of the cast). ``used_names`` (F3): the display names ALREADY committed by EARLIER calls — injected
    as an in-prompt ledger so the model avoids cross-call first-name/surname COLLISIONS in the first place
    (a collision otherwise gets floored to a gender-blind pool name, which is the personality↔gender
    mismatch root cause). Never the floor identities (so the model designs fresh) and NEVER any player field
    (player-blind, a structural gate). ``violation_feedback`` — on a bounded re-roll — quotes back the
    engine's structured violations so the model fixes exactly what failed. ``directives`` maps id → the
    ``assign_genesis_slots`` card; omitted (unit tests) ⇒ no card injection (back-compatible). Returns chat
    messages for the utility/narration model."""
    ids = [str(n.get("id")) for n in (roster or []) if isinstance(n, dict) and n.get("id")]
    lines = [
        f"Design the full cast — {len(ids)} houseguests. {render_season_brief(brief)}",
        "Roster ids (author ONE houseguest object per id, echoing the id verbatim, same order):",
        json.dumps(ids, ensure_ascii=False),
    ]
    taken = [str(n).strip() for n in (used_names or []) if str(n).strip()]
    if taken:
        lines.append(
            "Names ALREADY taken by earlier houseguests in THIS cast — do NOT reuse any of these first "
            "names OR surnames (every houseguest needs a distinct given name and surname): "
            + ", ".join(taken) + ".")
    # 2026-07-21 prompt audit (the "San Diego x2" defect): thread the ALREADY-USED hometowns/vocations
    # forward between waves exactly like the name ledger, so per-NPC calls stop landing on the model's
    # default picks. The engine's cross-cast dedupe backstop still catches any within-wave collision.
    if isinstance(used_facets, dict):
        towns = [str(t).strip() for t in (used_facets.get("hometowns") or []) if str(t).strip()]
        if towns:
            lines.append(
                "Hometowns ALREADY used in THIS cast — every houseguest comes from a DIFFERENT city, so "
                "pick another real place entirely (a different city, not the same city re-spelled): "
                + ", ".join(towns) + ".")
        jobs = [str(v).strip() for v in (used_facets.get("vocations") or []) if str(v).strip()]
        if jobs:
            lines.append(
                "Vocations ALREADY used in THIS cast — do NOT repeat any of these jobs: "
                + ", ".join(jobs) + ".")
    if directives:
        cards = [render_slot_directive(hid, directives[hid]) for hid in ids if hid in directives]
        if cards:
            lines.append("CASTING CARDS (fixed inputs — honor each one for its houseguest):")
            lines.extend(cards)
        # T0-6 — the cast-wide TAKEN-LIST: a per-NPC call (roster = one id) cannot see its siblings,
        # so aggregate the OTHER slots' dealt FacetLedger hands (the directives map covers the whole
        # cast) into one compact "already taken" line. With every hand dealt up front, collisions are
        # structurally impossible — this line just keeps the model FROM DRIFTING toward taken ground.
        sibling_hands = [d.get("ledger") for hid, d in directives.items()
                         if hid not in ids and isinstance(d, dict) and isinstance(d.get("ledger"), dict)]
        if sibling_hands:
            try:
                from src.orwell_facet_ledger import render_taken
                taken_line = render_taken(sibling_hands)
                if taken_line:
                    lines.append(taken_line)
            except Exception:  # pragma: no cover - defensive: never break the prompt over the ledger
                pass
    if violation_feedback:
        lines.append(
            "Your previous proposal had these problems (fix EXACTLY these, keep everything else): "
            + violation_feedback)
    lines.append("Return the cast-genesis JSON now (npcs + ties). JSON only.")
    return [{"role": "system", "content": _SYSTEM}, {"role": "user", "content": "\n".join(lines)}]


def _extract_json(text: str) -> Optional[dict]:
    """Pull the first usable JSON OBJECT out of the model's reply — robust to prose-wrapped output.
    Reuses the sibling cast-authoring extractor (balanced-brace, string-aware) when importable; falls
    back to a first-``{``/last-``}`` slice otherwise. Genesis returns a single ``{npcs, ties}`` object."""
    if not text:
        return None
    try:
        from src.orwell_cast_authoring import _extract_json as _shared
        return _shared(text)
    except Exception:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        obj = json.loads(text[start:end + 1])
        return obj if isinstance(obj, dict) else None
    except (ValueError, TypeError):
        return None


def _salvage_truncated_npcs(text: str) -> Optional[dict]:
    """2026-07-13 salvage guard: recover the COMPLETE leading npc entries from a TRUNCATED sketch
    reply (a ``finish_reason=length`` completion chops the JSON mid-array, so ``_extract_json``
    finds nothing). Scans the ``"npcs": [...`` array with a string-aware balanced-brace walk and
    ``json.loads``-es each complete ``{...}`` element until the text runs out or breaks.

    A partial-but-valid leading set IS committable by design: the engine envelope natively supports
    a partial proposal (positional binding + the deterministic floor for every unproposed slot —
    ``parse_genesis_proposal`` already forwards subsets), so half a model-authored cast beats a
    whole deterministic floor. Returns ``{"npcs": [...]}`` (raw dicts — the caller's normal
    per-entry filtering still applies) or ``None`` when nothing complete could be recovered. Ties
    are deliberately NOT salvaged (they trail the npcs array, so truncation already ate them; the
    engine treats absent ties as an empty graph)."""
    if not isinstance(text, str) or not text:
        return None
    m = text.find('"npcs"')
    if m == -1:
        return None
    start = text.find("[", m)
    if start == -1:
        return None
    entries: list = []
    i = start + 1
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in " \t\r\n,":
            i += 1
            continue
        if ch == "]":
            break  # the array closed cleanly (truncation hit later — e.g. inside ties)
        if ch != "{":
            break  # unexpected shape — keep only what parsed so far
        depth = 0
        in_str = False
        esc = False
        j = i
        end = -1
        while j < n:
            c = text[j]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            else:
                if c == '"':
                    in_str = True
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        end = j
                        break
            j += 1
        if end == -1:
            break  # this element was cut off mid-object — stop; keep the complete ones before it
        try:
            one = json.loads(text[i:end + 1])
        except (ValueError, TypeError):
            break
        if isinstance(one, dict):
            entries.append(one)
        i = end + 1
    if not entries:
        return None
    return {"npcs": entries}


def recover_reasoning_channel_json(reasoning: str) -> Optional[str]:
    """S3b (RC4): recover a genesis/authoring JSON payload the model MISROUTED into the reasoning
    channel. glm-4.7 (and other reasoners) sometimes emit the whole answer as ``reasoning``/``thinking``
    deltas and leave the visible body EMPTY — even with ``reasoning:{enabled:false}`` sent (verified in
    the live bundle: 6 NPCs fell to the floor because the parser read ``''`` while the JSON sat in the
    reasoning channel). Rather than discard paid-for content, we strict-scan the reasoning text for a
    parseable JSON object (the balanced-brace extractor, then the truncation salvage) and return the
    recovered JSON STRING so the normal parser can consume it. Returns ``None`` when the reasoning holds
    no usable JSON object (then the caller keeps the empty visible body ⇒ the deterministic floor stands).

    The RED-eligible ``reasoning-channel-misroute`` health event is recorded by the CALLER (which holds
    the owner + call-class context); this helper is a pure detector."""
    if not isinstance(reasoning, str) or not reasoning.strip():
        return None
    obj = _extract_json(reasoning)
    if obj is None:
        obj = _salvage_truncated_npcs(reasoning)
    if obj is None:
        return None
    try:
        return json.dumps(obj, ensure_ascii=False)
    except (ValueError, TypeError):
        return None


def _clean_str(v, max_len: int = 500) -> Optional[str]:
    """A light FE pre-filter: a non-empty string, whitespace-collapsed + length-capped. The ENGINE
    re-neutralizes + caps everything again (C8), so this only keeps the payload tidy."""
    if not isinstance(v, str):
        return None
    s = " ".join(v.split())
    if not s:
        return None
    return s[:max_len]


# ── E1 (#1733): author-time garble / gendered-role lint for the genesis SELF-REFERENTIAL fields ─────
#
# `demeanor` and `appearance` are authored HERE, at genesis, BEFORE the 0063 identity call decides
# `genderPresentation` — so unlike the LATER `orwell_cast_authoring.coherence_conflicts` lint (which
# checks authored prose against an ALREADY-PINNED gender), these two fields can never be safely
# cross-checked against a pin that doesn't exist yet. The bundle's F7 defect ("patient and fatherly"
# demeanor on a houseguest later pinned "woman") is fixed at the SOURCE instead: a gendered relational-
# role term is simply never appropriate in a neutral "how they carry themselves" / "look" phrase (the
# genesis prompt's own framing, e.g. "warm but guarded") REGARDLESS of which gender ends up pinned, so
# it is rejected outright rather than pin-checked. Mixed-script garble is rejected for the same
# gender-agnostic reason. A rejected value is DROPPED (never persisted) — the field then falls to the
# engine's deterministic floor (`generateDemeanors` / the seeded appearance pool), matching the
# existing fail-soft "no model ⇒ floor stands" pattern.
#
# The script-garble + gendered-descriptor vocabulary is CANONICAL in `orwell_cast_authoring` (the F2
# lint owns it); imported here rather than re-declared, mirroring the sibling dynamic-import pattern
# (`orwell_cast_identity._resolve_llm_fn` importing `orwell_cast_authoring._resolve_llm_fn`) — no
# module-level import cycle (cast_authoring only imports cast_genesis lazily inside one function body).
# The self-referential prose fields this lint scans — genesis's OWN framing for both is a NEUTRAL
# carriage/look phrase ("warm but guarded"), so a gendered relational-role term never belongs in either.
_GENESIS_GARBLE_FIELDS = ("demeanor", "appearance")


def _is_garbled_or_gendered(text: str) -> bool:
    """True iff `text` carries non-Latin-script garble OR a gendered relational-role term ("fatherly",
    "maternal") — content that is never appropriate in a neutral genesis carriage/appearance phrase,
    and unsafe to pin-check here since `genderPresentation` isn't decided until the LATER 0063 identity
    call. Vault-free. Defers to `orwell_cast_authoring`'s canonical detectors; a defensive import
    failure fails OPEN (never blocks genesis parsing over a lint-plumbing fault)."""
    if not text:
        return False
    try:
        from src.orwell_cast_authoring import _FEM_DESCRIPTOR_RE, _MASC_DESCRIPTOR_RE, _has_script_garble
    except Exception:  # pragma: no cover - defensive: a dedup import must never break genesis parsing
        return False
    if _has_script_garble(text):
        return True
    return bool(_MASC_DESCRIPTOR_RE.search(text)) or bool(_FEM_DESCRIPTOR_RE.search(text))


def parse_genesis_proposal(text: str, valid_ids: set) -> dict:
    """Parse the model reply into a ``recordCastGenesis`` request ``{npcs: [...], ties: [...]}``, keeping
    ONLY recognized shapes for KNOWN houseguest ids. A light FE pre-filter mirroring the engine's
    validation (the engine clamps/validates/repairs regardless, so this is best-effort): a non-dict entry,
    an unknown id, a garbage stat, or an out-of-set tie nature is dropped. Returns ``{}`` when nothing
    usable was proposed (the deterministic floor then stands). PLAYER-BLIND — no player field is read or
    written; the engine seals the hidden half."""
    obj = _extract_json(text)
    if obj is None:
        # 2026-07-13 salvage guard: a cap-truncated reply (finish_reason=length survived even the
        # doubled-cap retry) still carries complete leading npc objects — commit those (the engine
        # positionally binds + floors the rest) instead of discarding the whole proposal.
        obj = _salvage_truncated_npcs(text)
        if obj is not None:
            _n = len(obj.get("npcs") or [])
            logger.warning(
                f"[cast-genesis] reply was truncated mid-JSON — salvaged {_n} complete leading "
                f"houseguest entr{'y' if _n == 1 else 'ies'} (the engine floors the rest)")
    if obj is None:
        return {}
    npcs_out: list = []
    raw_npcs = obj.get("npcs")
    if isinstance(raw_npcs, list):
        for raw in raw_npcs:
            if not isinstance(raw, dict):
                continue
            hid = raw.get("id")
            hid = str(hid) if hid is not None else None
            # Keep an entry with a KNOWN id (explicit binding) or NO id (engine positional binding).
            # Drop an entry whose id is present-but-unknown (a stale/hallucinated slot).
            if hid is not None and hid not in valid_ids:
                continue
            one: dict = {}
            if hid is not None:
                one["id"] = hid
            for k, cap in (("name", 60), ("identity", 300), ("vocation", 60), ("hometown", 60),
                           ("demeanor", 120), ("background", 200), ("biography", 500),
                           ("presentation", 200), ("appearance", 300)):
                cleaned = _clean_str(raw.get(k), cap)
                # E1 (#1733): reject garbled / gendered-relational-role demeanor+appearance BEFORE they
                # ever reach the write-back — never persist junk; the field falls to the deterministic
                # floor instead (matching the fail-soft "no model ⇒ floor stands" contract).
                if cleaned and k in _GENESIS_GARBLE_FIELDS and _is_garbled_or_gendered(cleaned):
                    logger.warning(
                        f"[cast-genesis] garbled/gendered {k} for {hid or '(unbound slot)'} — "
                        "dropping so the deterministic floor stands")
                    continue
                if cleaned:
                    one[k] = cleaned
            arche = raw.get("archetype")
            if isinstance(arche, str) and arche.strip() in _ARCHETYPES:
                one["archetype"] = arche.strip()
            age = raw.get("age")
            if isinstance(age, (int, float)) and not isinstance(age, bool):
                one["age"] = int(age)
            stats = raw.get("stats")
            if isinstance(stats, dict):
                st = {}
                for sk in ("physical", "mental", "social"):
                    sv = stats.get(sk)
                    if isinstance(sv, (int, float)) and not isinstance(sv, bool):
                        st[sk] = float(sv)
                if st:
                    one["stats"] = st
            hidden = raw.get("hiddenElements")
            if isinstance(hidden, list):
                els = []
                for el in hidden:
                    if not isinstance(el, dict):
                        continue
                    kind = el.get("kind")
                    detail = _clean_str(el.get("detail"), 300)
                    if isinstance(kind, str) and kind.strip() and detail:
                        els.append({"kind": kind.strip(), "detail": detail})
                if els:
                    one["hiddenElements"] = els[:GENESIS_HIDDEN_MAX]
            # Keep the slot even if only an id survived — the engine positionally binds + floors the rest.
            if one:
                npcs_out.append(one)
    ties_out: list = []
    raw_ties = obj.get("ties")
    if isinstance(raw_ties, list):
        for raw in raw_ties:
            if not isinstance(raw, dict):
                continue
            a = raw.get("a")
            b = raw.get("b")
            a = str(a) if a is not None else None
            b = str(b) if b is not None else None
            if not a or not b or a == b or a not in valid_ids or b not in valid_ids:
                continue
            tie = {"a": a, "b": b}
            nature = raw.get("nature")
            if isinstance(nature, str):
                n = _LEGACY_TIE_NATURE_ALIASES.get(nature.strip(), nature.strip())
                if n in _TIE_NATURES:
                    tie["nature"] = n
            backstory = _clean_str(raw.get("backstory"), 300)
            if backstory:
                tie["backstory"] = backstory
            ties_out.append(tie)
    if not npcs_out:
        return {}
    out: dict = {"npcs": npcs_out}
    if ties_out:
        out["ties"] = ties_out
    return out


def _reroll_feedback(violations: list) -> Optional[str]:
    """Quote back ONLY the ``re-roll`` violations (the ones the model must fix) as a short, Vault-free
    feedback string for the next attempt. Clamped/stripped/ignored/dropped actions are engine-handled and
    need no model fix. Returns None when nothing needs a re-roll."""
    if not isinstance(violations, list):
        return None
    items = []
    for v in violations:
        if not isinstance(v, dict) or v.get("action") != "re-roll":
            continue
        scope = v.get("scope")
        field = v.get("rule") or v.get("field") or "a field"
        if scope == "npc" and v.get("npcId"):
            items.append(f"houseguest {v.get('npcId')}: {field}")
        else:
            items.append(f"cast-wide: {field}")
        if len(items) >= 12:
            break
    return "; ".join(items) if items else None


# ── the orchestrator (injectable — fully unit-testable) ────────────────────────

LlmFn = Callable[[list[dict]], Awaitable[str]]
WriteFn = Callable[[dict], Awaitable[dict]]

#: PER-NPC generation (owner directive 2026-07-20): genesis authors ONE houseguest per LLM call — this
#: maximizes per-NPC independence (killing the batch self-harmonization that made every houseguest read
#: "reserved") AND eliminates cross-call name collisions at the source. `GENESIS_CHUNK_SIZE` is the
#: number IN FLIGHT at once (a "wave").
#:
#: T0-6 (owner casting-speed ruling, 2026-07-21): a FULL 15-WIDE SINGLE WAVE — every NPC concurrently.
#: The old 3-wave bound existed because concurrent calls can't see each other's picks (waves froze the
#: used-names/facets ledger between them); with the seeded FacetLedger dealing every slot a DISJOINT
#: hand (vocation family / region / build / hair / voice tic / name phonology) + the cast-wide
#: taken-list injected into each per-NPC prompt UP FRONT, collisions are structurally impossible, so
#: nothing is left for the waves to serialize. Failed-call isolation is unchanged (a failed call is
#: retried alone; the engine floors its slot); the combined-dedupe backstop still drops any residual
#: duplicate name/hometown/vocation before the one atomic write-back. ``seed_cast_genesis`` defaults
#: to NO concurrency (one whole-cast call) so direct-call unit tests stay byte-identical; the live
#: ``_run_genesis_once`` opts in.
GENESIS_CHUNK_SIZE = 15


async def _gather_chunked_proposal(roster: list, brief: dict, llm_fn: LlmFn, valid_ids: set,
                                   feedback: Optional[str], chunk_size: int,
                                   directives: Optional[dict] = None) -> dict:
    """Gather a whole-cast proposal by authoring ONE houseguest per LLM call, run in WAVES of
    ``chunk_size`` concurrent calls (bounded concurrency), then COMBINE into one ``{npcs, ties}`` for a
    single atomic write-back. Each call is proposed with ONLY its own id valid (it can't hallucinate a
    sibling), a FAILED call is retried ONCE alone (strict-JSON), and names are de-duped across calls (a
    colliding name field is dropped so the engine floors that slot). The used-names ledger is frozen per
    wave and threaded FORWARD into the next wave so later houseguests avoid earlier names. A call that
    fails both tries is skipped (the engine floors its slot); a PARTIAL cast still commits. Ties are not
    authored per-NPC (a single-id call can't form a valid pair) — the engine's seeded floor tie graph
    stands. Returns the combined proposal, or ``{}`` when EVERY call failed."""
    concurrency = chunk_size if (isinstance(chunk_size, int) and chunk_size > 0) else 5
    entries = [n for n in (roster or []) if isinstance(n, dict) and n.get("id")]
    ids = [str(n.get("id")) for n in entries]
    combined_npcs: list = []
    combined_ties: list = []
    used_given: set = set()
    used_surname: set = set()
    used_full: set = set()
    used_display: list = []  # F3: the running name ledger, threaded forward between waves
    used_towns: list = []    # 2026-07-21: the running hometown ledger (same wave-frozen threading)
    used_jobs: list = []     # 2026-07-21: the running vocation ledger
    tied: set = set()
    any_ok = False

    async def _author_one(entry: dict, ledger_snapshot: list, facets_snapshot: dict) -> Optional[dict]:
        """Author ONE houseguest (its own single-id call), retried alone once on a miss. Best-effort."""
        one_ids = {str(entry.get("id"))}
        messages = build_genesis_messages([entry], brief, feedback, directives, ledger_snapshot,
                                          facets_snapshot)
        try:
            text = await llm_fn(messages)
        except Exception as e:
            logger.warning(f"[cast-genesis] npc {entry.get('id')} llm failed: {e}")
            text = ""
        prop = parse_genesis_proposal(text or "", one_ids)
        if not prop:
            try:  # retry ONLY this houseguest once (strict-JSON) — never re-grind the cast
                text = await llm_fn(messages + [{"role": "user", "content": _STRICT_RETRY}])
            except Exception as e:
                logger.warning(f"[cast-genesis] npc {entry.get('id')} strict retry failed: {e}")
                text = ""
            prop = parse_genesis_proposal(text or "", one_ids)
        return prop or None

    waves = [entries[i:i + concurrency] for i in range(0, len(entries), concurrency)] if entries else []
    for wave in waves:
        # The ledger is FROZEN for the whole wave (concurrent calls can't see each other's names); the
        # seeded pre-assignment + the engine dedupe backstop cover any within-wave collision.
        ledger_snapshot = list(used_display)
        facets_snapshot = {"hometowns": list(used_towns), "vocations": list(used_jobs)}
        results = await asyncio.gather(*[_author_one(e, ledger_snapshot, facets_snapshot) for e in wave])
        for prop in results:
            if not prop:
                continue
            any_ok = True
            for npc in prop.get("npcs") or []:
                # 2026-07-21 / T0-6: the committed-facet dedupe. Beyond feeding the ledgers forward,
                # a DUPLICATE committed hometown (every houseguest comes from a different city) or an
                # exact-duplicate vocation is DROPPED from the entry so the engine floors that one
                # field — zero duplicate committed hometowns even in a full-wide single wave (the
                # engine's cross-cast dedupe backstop still stands behind this).
                town = npc.get("hometown")
                if isinstance(town, str) and town.strip():
                    t = town.strip()
                    if t.lower() in {x.lower() for x in used_towns}:
                        npc.pop("hometown", None)  # collision — the engine floors this slot's town
                    else:
                        used_towns.append(t)
                job = npc.get("vocation")
                if isinstance(job, str) and job.strip():
                    j = job.strip()
                    if j.lower() in {x.lower() for x in used_jobs}:
                        npc.pop("vocation", None)  # collision — the engine floors this slot's job
                    else:
                        used_jobs.append(j)
                name = npc.get("name")
                if isinstance(name, str) and name.strip():
                    toks = name.strip().lower().split()
                    given = toks[0] if toks else ""
                    surname = toks[-1] if toks else ""
                    full = name.strip().lower()
                    if full in used_full or (given and given in used_given) or (surname and surname in used_surname):
                        npc.pop("name", None)  # collision — drop the name; the engine floors it
                    else:
                        used_full.add(full)
                        used_display.append(name.strip())  # feed forward to the next wave (F3 ledger)
                        if given:
                            used_given.add(given)
                        if surname:
                            used_surname.add(surname)
                combined_npcs.append(npc)
            for tie in prop.get("ties") or []:
                if len(combined_ties) >= GENESIS_TIE_BUDGET:
                    break
                a = tie.get("a")
                b = tie.get("b")
                if not a or not b or a == b or a in tied or b in tied:
                    continue  # no NPC in two ties (sparse-by-design)
                combined_ties.append(tie)
                tied.add(a)
                tied.add(b)
    if not any_ok or not combined_npcs:
        return {}
    out: dict = {"npcs": combined_npcs}
    if combined_ties:
        out["ties"] = combined_ties[:GENESIS_TIE_BUDGET]
    logger.info(f"[cast-genesis] per-NPC gather combined {len(combined_npcs)} of {len(ids)} "
                f"houseguest proposal(s) across {len(waves)} wave(s) of ≤{concurrency}")
    return out


async def seed_cast_genesis(roster: list, seed: int, llm_fn: LlmFn, write_fn: WriteFn,
                            *, chunk_size: Optional[int] = None) -> dict:
    """Propose the WHOLE cast skeleton → parse → write back (recordCastGenesis) → bounded re-roll
    (≤GENESIS_MAX_REROLLS), echoing the engine's structured re-roll violations back to the model.
    Best-effort + fail-soft: any failure leaves the engine's deterministic FLOOR cast in place
    (byte-neutral). Returns ``{committed, accepted, varianceOk, rerolls, reason?}`` — Vault-free counts.

    ``chunk_size`` (per-NPC concurrency): when set (e.g. 5), the sketch is authored ONE houseguest per
    call, run in bounded-concurrency WAVES of ``chunk_size`` — maximal per-NPC independence, a failed call
    retried alone — then combined into ONE atomic write-back. ``None`` (the default) keeps the single
    whole-cast call (byte-identical to before; the live path opts into per-NPC, direct-call unit tests do not).

    PLAYER-BLIND: the roster is the warmed FLOOR cast's Vault-free cards; only the IDS are used to bind
    proposals — no player field is threaded in, and the model never sees the floor identities."""
    valid_ids = {str(n.get("id")) for n in (roster or []) if isinstance(n, dict) and n.get("id")}
    if not valid_ids:
        return {"committed": 0, "accepted": False, "varianceOk": True, "rerolls": 0, "reason": "empty-roster"}
    brief = generate_season_brief(seed)
    # The seeded per-slot casting cards (role/archetype 1-3x / accented 20-30% / delivery axes) --
    # the cross-cast constraints computed up front and injected per slot (each per-NPC call sees only its own).
    roster_ids = [str(n.get("id")) for n in (roster or []) if isinstance(n, dict) and n.get("id")]
    slot_list = assign_genesis_slots(seed, len(roster_ids))
    # T0-6 — mint the cast-wide FacetLedger BEFORE any LLM call and merge each slot's dealt hand into
    # its casting card (the `ledger` key rides the directive; `render_slot_directive` renders it and
    # `build_genesis_messages` aggregates the sibling hands as the per-NPC taken-list). The ledger is
    # aligned to the slots' `physical` flags so a PHYSICAL COMPETITOR slot always holds a physically
    # credible dealt family. Fail-soft: a ledger hiccup leaves the plain cards (steering only).
    if slot_list:
        try:
            from src.orwell_facet_ledger import mint_facet_ledger
            hands = mint_facet_ledger(seed, len(roster_ids), [bool(s.get("physical")) for s in slot_list])
            if hands and len(hands) == len(slot_list):
                slot_list = [{**s, "ledger": hands[i]} for i, s in enumerate(slot_list)]
        except Exception as e:  # pragma: no cover - defensive
            logger.warning(f"[cast-genesis] facet-ledger mint failed (plain cards stand): {e}")
    directives = {hid: slot_list[i] for i, hid in enumerate(roster_ids)} if slot_list else None
    feedback: Optional[str] = None
    best = {"committed": 0, "accepted": False, "varianceOk": True, "rerolls": 0, "reason": "no-usable-proposal"}
    # T0-6: ANY positive chunk_size selects the per-NPC path (chunk_size is the wave WIDTH — with the
    # ledger dealing disjoint hands, the live path runs one full-cast-wide wave, chunk_size == cast
    # size, which the old `< len(valid_ids)` bound wrongly demoted to a single whole-cast call).
    _chunked = isinstance(chunk_size, int) and chunk_size > 0
    for attempt in range(1 + GENESIS_MAX_REROLLS):
        if _chunked:
            proposal = await _gather_chunked_proposal(roster, brief, llm_fn, valid_ids, feedback, chunk_size,
                                                      directives)
            if not proposal:
                logger.debug("[cast-genesis] every chunk failed — keeping the deterministic floor")
                best["reason"] = "no-usable-proposal"
                break
        else:
            messages = build_genesis_messages(roster, brief, feedback, directives)
            try:
                text = await llm_fn(messages)
            except Exception as e:  # the model can fail — carry on, the floor stands
                logger.warning(f"[cast-genesis] llm failed (attempt {attempt}): {e}")
                best["reason"] = "llm-failed"
                break
            proposal = parse_genesis_proposal(text or "", valid_ids)
            if not proposal:
                # No parseable/usable proposal — one strict-JSON reparse retry, then fall to the floor.
                if attempt == 0:
                    try:
                        text = await llm_fn(messages + [{"role": "user", "content": _STRICT_RETRY}])
                    except Exception as e:
                        logger.warning(f"[cast-genesis] strict-json retry failed: {e}")
                        text = ""
                    proposal = parse_genesis_proposal(text or "", valid_ids)
                if not proposal:
                    logger.debug("[cast-genesis] nothing usable proposed — keeping the deterministic floor")
                    best["reason"] = "no-usable-proposal"
                    break
        try:
            res = await write_fn(proposal)
        except Exception as e:
            logger.warning(f"[cast-genesis] write-back failed (attempt {attempt}): {e}")
            best["reason"] = "write-back-failed"
            break
        if not (isinstance(res, dict) and res.get("accepted")):
            _reason = res.get("reason") if isinstance(res, dict) else f"non-dict ({type(res).__name__})"
            logger.warning(f"[cast-genesis] write-back not accepted: {_reason or 'accepted=false'}")
            best["reason"] = str(_reason or "not-accepted")
            break
        violations = res.get("violations") if isinstance(res.get("violations"), list) else []
        best = {
            "committed": int(res.get("committed") or 0),
            "accepted": True,
            "varianceOk": bool(res.get("varianceOk", True)),
            "rerolls": attempt,
        }
        feedback = _reroll_feedback(violations)
        if not feedback and best["varianceOk"]:
            # A clean commit — no re-roll violations, cast cleared the variance floor. Done.
            logger.info(f"[cast-genesis] committed skeleton for {best['committed']} houseguest(s) "
                        f"(attempt {attempt}, clean)")
            return best
        # Re-roll: echo the violations (or the variance failure) back and try again, up to the budget.
        if not feedback and not best["varianceOk"]:
            feedback = "cast-wide: the stat totals are too flat — spread them WIDELY (real beasts AND real floaters)"
        logger.info(f"[cast-genesis] re-rolling (attempt {attempt} → {attempt + 1}); violations: {feedback}")
    if best.get("accepted"):
        logger.info(f"[cast-genesis] committed skeleton for {best['committed']} houseguest(s) "
                    f"after {best['rerolls']} re-roll(s) (residual violations tolerated — engine floored the rest)")
    return best


# ── strict-failure latch for the loud pre-finalize gate (§4 / #1313 precedent) ─────────────────────────
# Under the DEFAULT strict enrichment policy a genesis run that ends on the deterministic floor (no model,
# a failed call, or exhausted re-rolls with no accepted commit) is a LOUD failure — and casting finalize
# must be held/refused BEFORE the player commits their character (never a silent floor). This latch is what
# the do_create_character pre-finalize gate reads. Cleared on the new-season scrub.
_STRICT_FAILED: set = set()

# Idempotency: the seed for which genesis already COMMITTED per user. Genesis is kicked from TWO seams
# (the interview-open pre-warm `prewarm_cast` — the async overlap — AND the `do_create_character`
# pre-finalize belt that guarantees it runs even when the pre-warm route was never hit, e.g. the
# HTTP/golden flow). Keyed by (user, seed) so the SECOND kick for the same warmed cast is a no-op — no
# duplicate LLM sketch call, no double fold. Cleared on the new-season scrub.
_COMMITTED: dict = {}


def _key(user: Optional[str]) -> str:
    return str(user) if user else "default"


def mark_strict_failed(user: Optional[str]) -> None:
    _STRICT_FAILED.add(_key(user))


def clear_strict_failed(user: Optional[str]) -> None:
    _STRICT_FAILED.discard(_key(user))


def strict_failed(user: Optional[str]) -> bool:
    """True iff the last genesis run for this user FAILED under the strict policy (ended on the floor) —
    the loud pre-finalize gate refuses casting finalize when this is set."""
    return _key(user) in _STRICT_FAILED


def genesis_committed(user: Optional[str], seed) -> bool:
    """True iff genesis already committed a skeleton for this user's CURRENT warmed seed — the
    idempotency guard shared by the pre-warm kick and the pre-finalize belt (no duplicate sketch call)."""
    return seed is not None and _COMMITTED.get(_key(user)) == seed


def _mark_committed(user: Optional[str], seed, committed: int) -> None:
    if seed is not None:
        _COMMITTED[_key(user)] = seed


def reset_state(user: Optional[str] = None) -> None:
    """New-season scrub: clear the strict-failed latch + the idempotency latch so a fresh cast starts
    clean (``user=None`` clears everyone). Also drops the in-flight dedup handles (the tasks
    themselves self-clean and are never cancelled — an old-season run just finishes unobserved)."""
    if user is None:
        _STRICT_FAILED.clear()
        _COMMITTED.clear()
        _IN_FLIGHT.clear()
    else:
        _STRICT_FAILED.discard(_key(user))
        _COMMITTED.pop(_key(user), None)
        for k in [k for k in _IN_FLIGHT if k[0] == _key(user)]:
            _IN_FLIGHT.pop(k, None)


def refusal_message() -> str:
    """The clear, player-visible casting-finalize refusal (strict policy, genesis failed)."""
    return (
        "Casting can't finalize yet (strict enrichment policy): the season's cast could not be "
        "model-authored, so it would fall back to the generic deterministic floor. Configure a chat "
        "model endpoint (Settings → Models), retry, or set enrichment_policy=soft to allow the "
        "deterministic floor.")


# ── the live wiring (best-effort, background; graceful no-op when no model) ─────

async def _resolve_llm_fn(owner: Optional[str]) -> Optional[LlmFn]:
    """Resolve the model for the cast-genesis SKETCH call. Genesis is expressive, end-to-end character
    work like deep authoring, so it routes to the cast-authoring resolver (NARRATION model by default, hot
    sampling temperature, explicit utility fallback). Returns None when no usable text model resolves —
    genesis then silently no-ops and the engine's deterministic floor stands.

    2026-07-13 (the prod cap fix): the sketch is ONE completion carrying the WHOLE 15-NPC skeleton
    JSON, so the resolver is asked for the GENESIS output-cap floor
    (``token_policy.GENESIS_SKETCH_MIN_OUTPUT_TOKENS`` ≥ 8000) — the one-NPC-sized class cap (3000)
    chopped the proposal mid-JSON (``finish_reason=length`` → ``no-usable-proposal``). Signature-
    tolerant: a legacy ``(owner)`` test stub for ``resolve_authoring_llm_fn`` keeps intercepting."""
    try:
        from src.orwell_cast_authoring import resolve_authoring_llm_fn
    except Exception:
        return None
    try:
        try:
            from src.token_policy import GENESIS_SKETCH_MIN_OUTPUT_TOKENS as _floor
        except Exception:  # pragma: no cover - token_policy is a sibling pure module
            _floor = 8000
        try:
            import inspect
            params = inspect.signature(resolve_authoring_llm_fn).parameters
            takes_floor = "min_output_tokens" in params or any(
                p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())
        except (TypeError, ValueError):
            takes_floor = False
        if takes_floor:
            return await resolve_authoring_llm_fn(owner, min_output_tokens=_floor)
        return await resolve_authoring_llm_fn(owner)  # a legacy-signature stub (tests)
    except Exception:
        return None


# 2026-07-13 in-flight dedup: genesis is kicked from TWO seams (the interview-open pre-warm and the
# do_create_character pre-finalize belt). The `_COMMITTED` idempotency latch only engages AFTER a
# commit, so a finalize that lands while the pre-warm's run is STILL GRINDING used to start a SECOND
# full sketch grind (double LLM spend) — and, because the finalize kick is awaited inside the chat
# turn, the player's casting chat hung for the WHOLE fresh grind. One task per (user, seed): the
# second kick awaits the SAME in-flight run (shielded, so an awaiter's cancellation — e.g. a client
# disconnect on the pre-warm route — never kills the shared run).
_IN_FLIGHT: dict = {}


async def run_genesis(roster: list, seed: int, owner: Optional[str], *,
                      write: Optional[WriteFn] = None) -> dict:
    """Resolve the live deps and model-author the cast skeleton onto the pre-warmed floor. Under ``soft``
    a missing model / failed run is the legacy silent no-op (the deterministic floor stands byte-
    identically). Under the DEFAULT ``strict`` policy the failure is LOUD: an ERROR + an admin-visible
    ledger entry + the strict-failed latch the loud pre-finalize gate reads (§4 / #1313 precedent).

    PLAYER-BLIND: no player identity is threaded in — the cast is proposed off the seeded brief alone.
    Returns the ``seed_cast_genesis`` result dict (Vault-free counts). Concurrency-safe per
    (user, seed): a second kick while a run is in flight AWAITS that run instead of re-grinding."""
    # Idempotency: genesis is kicked from BOTH the interview-open pre-warm AND the do_create_character
    # pre-finalize belt — if it already committed for THIS warmed seed, this second kick is a no-op (no
    # duplicate sketch call, no double fold).
    if genesis_committed(owner, seed):
        return {"committed": 0, "accepted": True, "varianceOk": True, "rerolls": 0,
                "reason": "already-committed"}
    k = (_key(owner), seed)
    task = _IN_FLIGHT.get(k)
    if task is None or task.done():
        task = asyncio.get_running_loop().create_task(
            _run_genesis_once(roster, seed, owner, write=write))
        _IN_FLIGHT[k] = task

        def _cleanup(t, _k=k):
            if _IN_FLIGHT.get(_k) is t:
                _IN_FLIGHT.pop(_k, None)
        task.add_done_callback(_cleanup)
    else:
        logger.info("[cast-genesis] a run for this (user, seed) is already in flight — "
                    "awaiting it instead of starting a second sketch grind")
    # shield: if THIS awaiter is cancelled (e.g. the pre-warm HTTP request disconnects), the shared
    # run keeps going so the other seam (the pre-finalize belt) still gets its result.
    return await asyncio.shield(task)


async def _run_genesis_once(roster: list, seed: int, owner: Optional[str], *,
                            write: Optional[WriteFn] = None) -> dict:
    """The single-flight body of ``run_genesis`` (see the dedup wrapper above)."""
    strict = False
    try:
        from src import enrichment_policy
        strict = enrichment_policy.is_strict()
    except Exception:
        strict = False
    # A fresh run starts clean — clear any prior strict-failed latch for this user before re-evaluating.
    clear_strict_failed(owner)

    def _fail_loud(reason: str, detail: Optional[str] = None) -> None:
        if not strict:
            return
        mark_strict_failed(owner)
        try:
            from src import enrichment_policy
            enrichment_policy.record_failure(owner, "cast-genesis", reason, detail=detail)
        except Exception:
            pass

    llm_fn = await _resolve_llm_fn(owner)
    if llm_fn is None:
        if strict:
            _fail_loud("no model resolved for the cast-genesis call class",
                       detail="the deterministic cast skeleton must not stand silently under the strict policy")
        else:
            logger.debug("[cast-genesis] no utility/narration model — keeping the deterministic floor")
        return {"committed": 0, "accepted": False, "varianceOk": True, "rerolls": 0, "reason": "no-model"}
    from src import orwell_engine

    async def _write(proposal: dict) -> dict:
        return await orwell_engine.record_cast_genesis(proposal, user=owner)

    # The LIVE path authors ONE houseguest per call in bounded-concurrency waves (GENESIS_CHUNK_SIZE in
    # flight) — maximizing per-NPC independence + killing cross-call name collisions; a failed call is
    # retried alone. The combined proposal is still written back in one atomic call (the engine's
    # cross-cast dedupe + variance floor stay authoritative).
    result = await seed_cast_genesis(roster, seed, llm_fn, write or _write, chunk_size=GENESIS_CHUNK_SIZE)
    # STRICT: a run that committed NOTHING (all already logged inside seed_cast_genesis) is ledgered
    # loudly + latches the pre-finalize gate. Soft: byte-identical legacy silent floor.
    if isinstance(result, dict) and result.get("accepted") and int(result.get("committed") or 0) > 0:
        _mark_committed(owner, seed, int(result.get("committed") or 0))  # idempotency: no second sketch call
    else:
        _fail_loud("cast genesis committed nothing (model or write-back failed)",
                   detail=f"result={result}")
    return result
