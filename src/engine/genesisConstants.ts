import { HIDDEN_ELEMENT_RANGE } from "./characterFactory";
import type { Archetype } from "./characterFactory";
import { DEFAULT_TIE_BUDGET } from "./seededRelationships";

/**
 * Feature 0116 — model-authored cast genesis: the SINGLE tunable module for the engine's validation
 * ENVELOPE (the 0028 `temperatureConstants.ts` precedent). The model proposes the whole 15-NPC
 * skeleton; the engine OWNS the numbers. Every bound the envelope enforces lives here so the "how much
 * anything weighs" line (ADR 0005, generalized to world-gen) retunes without touching envelope logic.
 *
 * These are the §9 open-decision #2 constants, firmed at build with sensible defaults. Because the
 * SEEDED calibration/heavy sims run on the deterministic FLOOR (no model ⇒ no proposal ⇒ this module is
 * never consulted — see the byte-neutrality gate in §7/§8), NONE of these values move a shipped
 * calibration gate. They are tuned instead against the genesis-shaped property gate (§8 — the
 * `EARNED_WINS` analog over envelope-PASSING casts), which is the only sim that plays a committed
 * genesis cast. Do NOT wire these into the floor.
 */

// ── Banded VARIABLE stat totals (§3 "Stats"; the envelope's centerpiece) ──────────────────────────
/**
 * The engine's REFERENCE MAXIMUM total, on the sum-of-three [0,1]³ stat scale (physical + mental +
 * social). Pinned at build. A top-of-band NPC averages `GENESIS_TOTAL_MAX / 3` per stat; the band edge
 * below opens the floor for genuine floaters. Chosen a touch above today's archetype-table ceiling (the
 * strongest floor archetype totals ~1.8) so a committed genesis cast admits a WIDER power spread than
 * the floor — "real comp beasts AND real floaters exist by design" (§3). Tunable against the §8 gate.
 */
export const GENESIS_TOTAL_MAX = 2.1;

/** The band is `[GENESIS_TOTAL_BAND_FLOOR_FRACTION × max, max]` — default 70–100% of the reference max (§3). */
export const GENESIS_TOTAL_BAND_FLOOR_FRACTION = 0.7;

/** The committed stat-total band `[lo, hi]` on the [0,1]³ scale. A proposal's total is clamped/renormalized inside it — no model number escapes (§8). */
export const GENESIS_TOTAL_BAND: { lo: number; hi: number } = {
  lo: GENESIS_TOTAL_BAND_FLOOR_FRACTION * GENESIS_TOTAL_MAX, // 1.47
  hi: GENESIS_TOTAL_MAX, // 2.1
};

/** Per-stat clamp `[min, max]` (§3): every committed stat sits inside this before/after total renormalization. */
export const GENESIS_STAT_CLAMP: { min: number; max: number } = { min: 0.2, max: 0.9 };

/**
 * Cast-wide VARIANCE FLOOR (§3/§8): the committed cast must clear a real dispersion of totals AND of
 * each stat across the 15 NPCs — no super-cast, no dud-cast, no fifteen identical mid-liners. Measured as
 * the population standard deviation. A flat cast has ~0 dispersion; a genuinely varied one clears these
 * comfortably. A cast-wide failure re-rolls the cast slice (it is NOT clamped in place — flatness can only
 * be fixed by re-proposing).
 */
export const GENESIS_VARIANCE_FLOOR = {
  /** Min population stdev of the 15 stat TOTALS (the band spans 0.63 ⇒ a real spread clears this). */
  totalStdev: 0.08,
  /** Min population stdev of EACH stat (physical/mental/social) across the cast. */
  perStatStdev: 0.08,
} as const;

// ── Hidden elements (§3 "Hidden elements") — the count range is the characterFactory single source ──
/** Per-NPC hidden-element count range (3–6) — re-exported from the floor so genesis and floor never diverge (§3). */
export const GENESIS_HIDDEN_ELEMENT_RANGE = HIDDEN_ELEMENT_RANGE;

// ── Pre-show tie graph (§3 "Pre-show tie graph") — sparse by design (0059) ─────────────────────────
/** Max pre-show ties the genesis proposal may carry (0059's sparseness budget; 0–2, sparse by design). Excess is dropped/re-rolled. */
export const GENESIS_TIE_BUDGET = DEFAULT_TIE_BUDGET; // 2

// ── Bounded re-roll (§4) ───────────────────────────────────────────────────────────────────────────
/**
 * The re-roll budget N (§4/§9): how many bounded re-roll attempts the FE driver echoes violations into
 * before the strict/floor fork. The ENGINE returns structured violations every attempt; N is the FE
 * driver's loop bound. Exposed here so the driver and the tests read one number. (The engine chassis
 * does not itself loop — it validates + commits + reports; the follow-on FE driver owns the loop.)
 */
export const GENESIS_MAX_REROLLS = 3;

// ── The seeded SEASON BRIEF (§2 DECIDED #5) — engine-owned, finite, seed-derived dimension pools ────
/**
 * The brief STEERS the model's open-ended generation (a demographic skew + a regional flavor) and is
 * derived ONLY from the seed on a dedicated side-stream — so same seed ⇒ same brief (replayable) and
 * different seeds steer different casting directions. The dimension space is finite, so distinct seeds
 * can occasionally deal a similar brief — the brief steers variety, it is not a uniqueness guarantee
 * (§2). Player-blind like everything else in genesis. The brief NEVER binds a validator (only the
 * engine's own caps/floors/bands bind, §3) — it is creative steering (open set).
 *
 * NOTE (the accent redesign): the OLD single house-wide `ensembleVibe` homogenized the whole cast, so it
 * was removed from the brief and replaced by a PER-SLOT `GENESIS_ENSEMBLE_ACCENTS` accent carried by only
 * a seeded 20–30% of the cast (see `assignGenesisSlots`). The two pools below are HIGHER-DIMENSIONAL than
 * the originals (real age-shape and US-region lines) so the demographic/regional space is materially wider.
 */
export const BRIEF_DEMOGRAPHIC_SKEWS: readonly string[] = [
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
];

export const BRIEF_REGIONAL_FLAVORS: readonly string[] = [
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
];

// ── Per-slot ENSEMBLE ACCENTS (the de-homogenized replacement for the old house-wide `ensembleVibe`) ──
/**
 * A distinctive house-mood ACCENT carried by only a SEEDED 20–30% of the cast (`assignGenesisSlots`) —
 * the accent-carrying slots stand out with a specific flavor while the rest are "their own people". The
 * pool is deliberately BROAD and orthogonal (well beyond the original 8) so the accented minority reads
 * varied, never one homogenizing house-wide mood. Per-slot creative steering (open set) — never a
 * validator.
 */
export const GENESIS_ENSEMBLE_ACCENTS: readonly string[] = [
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
];

// ── Per-slot DIVERSITY AXES (independent seeded delivery dials, EVERY slot) ──────────────────────────
/**
 * Three ORTHOGONAL delivery axes drawn INDEPENDENTLY per houseguest (`assignGenesisSlots`), so per-person
 * variety is SEEDED and enforced rather than hoped for from sampling temperature — the loudest houseguest
 * can genuinely be loud, the quietest genuinely buttoned-up. Wide pools by design (subdued↔explosive,
 * blunt↔flowery, buttoned-up↔unfiltered). Per-slot creative steering (open set) — never a validator.
 */
export const GENESIS_ENERGY_AXIS: readonly string[] = [
  "subdued and low-key",
  "calm and measured",
  "steady and even-keeled",
  "warm and animated",
  "high-energy and bouncy",
  "restless and wired",
  "explosive and larger-than-life",
  "mellow to the point of sleepy",
];

export const GENESIS_REGISTER_AXIS: readonly string[] = [
  "blunt and plainspoken",
  "clipped and economical",
  "dry and understated",
  "folksy and colloquial",
  "polished and articulate",
  "ornate and theatrical",
  "flowery and effusive",
  "slangy and irreverent",
];

export const GENESIS_EXPRESSIVENESS_AXIS: readonly string[] = [
  "guarded and buttoned-up",
  "reserved and hard to read",
  "measured, reveals little",
  "openly emotional",
  "expressive and demonstrative",
  "unfiltered and says everything out loud",
  "loud and impossible to ignore",
  "theatrically over-sharing",
];

// Three FURTHER orthogonal axes (owner casting-craft upgrade) — hot↔cold reactivity, deluded↔self-aware,
// main-character↔loner. The 'deluded' and 'main-character' ends are peak Big Brother; the pools reach real
// extremes so the cast is not uniformly polite/reserved.
export const GENESIS_EMOTIONAL_REGISTER_AXIS: readonly string[] = [
  "hot-reactive — quick to laugh, cry, or blow up",
  "warm and easily moved",
  "even-tempered",
  "cool and slow to react",
  "cold and hard to rattle",
  "volatile — swings fast between extremes",
];
export const GENESIS_SELF_AWARENESS_AXIS: readonly string[] = [
  "deluded — certain they're the smartest strategist in the house",
  "overconfident, always a step behind their own reputation",
  "a clear, realistic read on themselves",
  "sharply self-aware, clocks their own tells",
  "insecure, quietly underrates themselves",
];
export const GENESIS_SOCIAL_GRAVITY_AXIS: readonly string[] = [
  "a magnetic main-character who fills the room",
  "a natural center of attention",
  "sociable, comfortable in any group",
  "quietly present, part of the furniture",
  "a loner who orbits the edges of the house",
];

// The LOUD ends of the amplifiable axes — an amplified "big personality" slot draws ONLY from these, which
// is how genesis GUARANTEES a loud/reactive/main-character contingent instead of a uniformly reserved cast.
export const GENESIS_ENERGY_LOUD: readonly string[] = [
  "warm and animated", "high-energy and bouncy", "restless and wired", "explosive and larger-than-life",
];
export const GENESIS_EXPRESSIVENESS_LOUD: readonly string[] = [
  "openly emotional", "expressive and demonstrative", "unfiltered and says everything out loud",
  "loud and impossible to ignore", "theatrically over-sharing",
];
export const GENESIS_EMOTIONAL_REGISTER_LOUD: readonly string[] = [
  "hot-reactive — quick to laugh, cry, or blow up", "volatile — swings fast between extremes",
  "warm and easily moved",
];
export const GENESIS_SOCIAL_GRAVITY_LOUD: readonly string[] = [
  "a magnetic main-character who fills the room", "a natural center of attention",
];

/** How many houseguests are seeded as amplified "big personalities" (drawing only from the loud ends). */
export const GENESIS_AMPLIFIED_MIN = 4;
export const GENESIS_AMPLIFIED_SPAN = 2; // 4 or 5 amplified per cast (owner: guarantee 3-4+ loud)

// ── The seeded AGE CURVE (owner casting-craft upgrade — a real-world cast age distribution) ──────────
/**
 * A believable BB age spread: a young-skewing cast that EXPLICITLY fills the 27–45 middle (the zone the
 * un-tuned cast left empty). Each band is `[lo, hi]` with a target `count` for a 15-NPC cast; the counts
 * sum to the cast size (padded/trimmed for other sizes), then shuffled onto slots. The model picks the
 * exact integer age inside the band AND a given name from that birth ERA.
 */
export interface GenesisAgeBand { lo: number; hi: number; count: number; }
export const GENESIS_AGE_BANDS: readonly GenesisAgeBand[] = [
  { lo: 21, hi: 26, count: 4 },
  { lo: 27, hi: 33, count: 5 },
  { lo: 34, hi: 45, count: 4 },
  { lo: 46, hi: 60, count: 2 },
];

// ── The CASTING-ROLE vocabulary + quota (owner casting-craft upgrade) ────────────────────────────────
/**
 * A richer casting vocabulary than the 12 mechanical competition archetypes — the classic Big Brother
 * "types" a casting director actually assembles. Each role is STEERING FLAVOR injected into the sketch
 * prompt and MAPS to one of the 12 mechanical `Archetype` tags (the closed competition-bias key the engine
 * owns), so the cast reads as a believable BB ensemble WITHOUT expanding the mechanical enum (which would
 * shift the deterministic floor cast + every calibration/heavy-sim seed). `cerebral` roles (their PUBLIC
 * tag is analyst/mastermind) count toward the combined cerebral cap; `physical` roles get a physical-stat
 * lean + an athletic/first-responder/performer vocation so genuine comp threats exist.
 */
export interface GenesisCastingRole {
  /** The rich casting-type label (prompt flavor). */
  role: string;
  /** The mapped mechanical archetype tag (∈ the 12-member enum) the engine commits + biases off. */
  archetype: Archetype;
  /** Publicly reads as a thinker (analyst/mastermind) — counts toward the combined cerebral cap. */
  cerebral: boolean;
  /** A physical competitor — steered toward a high physical stat + an athletic/performative vocation. */
  physical: boolean;
  /** One-line casting note injected with the role (what makes this type tick). */
  note: string;
}

export const GENESIS_CASTING_ROLES: readonly GenesisCastingRole[] = [
  { role: "comp-beast (humble)", archetype: "comp-beast", cerebral: false, physical: true,
    note: "a genuine physical/endurance threat who lets the wins speak — quietly dangerous" },
  { role: "comp-threat self-mastermind", archetype: "comp-beast", cerebral: false, physical: true,
    note: "a physical player convinced he is ALSO a strategic genius — narrates himself as the mastermind" },
  { role: "mastermind", archetype: "mastermind", cerebral: true, physical: false,
    note: "the quiet architect running the house three moves ahead" },
  { role: "under-the-radar assassin", archetype: "floater", cerebral: false, physical: false,
    note: "a floater FACADE with a mastermind underneath — harmless-looking, quietly lethal" },
  { role: "analyst", archetype: "analyst", cerebral: true, physical: false,
    note: "reads the board like a spreadsheet, all logic and probabilities" },
  { role: "floater", archetype: "floater", cerebral: false, physical: false,
    note: "drifts to whoever holds power, never a target, never a leader" },
  { role: "villain", archetype: "villain", cerebral: false, physical: false,
    note: "the willing bad guy — but SECRETLY believes they're the hero, the loyal one, or the victim" },
  { role: "underdog", archetype: "underdog", cerebral: false, physical: false,
    note: "written off early, playing with a chip on their shoulder" },
  { role: "showmance instigator", archetype: "flirt", cerebral: false, physical: false,
    note: "here to spark a romance — flirts hard, wants a showmance nucleus" },
  { role: "flirt", archetype: "flirt", cerebral: false, physical: false,
    note: "charming and touchy, plays the social-romantic angle" },
  { role: "hothead", archetype: "hothead", cerebral: false, physical: true,
    note: "a short fuse who detonates the house on a dime" },
  { role: "america's sweetheart", archetype: "social-butterfly", cerebral: false, physical: false,
    note: "beloved, warm, non-threatening — everyone's friend, floats on goodwill" },
  { role: "mom/dad figure", archetype: "peacemaker", cerebral: false, physical: false,
    note: "the house parent who feeds and mediates everyone — and is SECRETLY cutthroat underneath" },
  { role: "wildcard", archetype: "wildcard", cerebral: false, physical: false,
    note: "chaotic and unpredictable, loyal to nothing, capable of anything" },
  { role: "loyalist", archetype: "loyalist", cerebral: false, physical: false,
    note: "rides for their ride-or-die to a fault, loyalty over logic" },
  { role: "superfan gamebot", archetype: "analyst", cerebral: true, physical: false,
    note: "an over-studied superfan who quotes past seasons and over-plays their BB knowledge" },
];

/** Cap for ANY single casting role across the cast (owner: cap any archetype at 2). */
export const GENESIS_ROLE_MAX_PER_CAST = 2;
/** Combined cap on PUBLIC cerebral roles (analyst + mastermind + superfan) across the cast (owner: ~3 of 16). */
export const GENESIS_CEREBRAL_MAX_PER_CAST = 3;

// ── The accent fraction (the seeded per-cast binding) ────────────────────────────────────────────────
/**
 * GENDER/pronouns are deliberately NOT seeded here: the identity model already proposes correct,
 * name-coherent, diverse genders per houseguest, and the downstream diversity/identity layer
 * (`diversity.ts`) is the final coherence authority (it derives gender from the committed name and
 * re-picks a mismatched name). Forcing a seeded pronoun token would discard that good diversity, so
 * genesis only asks the model — in prose — to fix each houseguest's chosen pronouns and stay consistent.
 */

/** The seeded per-cast ENSEMBLE-ACCENT fraction band: 20–30% of the cast carries an accent (§ accent redesign). */
export const GENESIS_ACCENT_FRACTION: { min: number; max: number } = { min: 0.2, max: 0.3 };

// ── The seeded LOOK LANE (2026-07-21 prompt audit — the cast-uniformity index case) ─────────────────
/**
 * Per-NPC genesis calls cannot see their siblings, so left unconstrained the model's appearance prior
 * dominates — a live bundle showed EVERY houseguest authored with visible tattoos ("full sleeve of …
 * tattoos" ×4) and repeated hometowns. The fix is STRUCTURAL, not prose pleading: the engine deals a
 * seeded, deterministic LOOK LANE per slot — a small minority of slots (`GENESIS_INK_MIN`..`+SPAN`)
 * are the cast's visibly-tattooed contingent (a real BB cast has ~2-4/16), every other slot is
 * explicitly no-visible-ink and carries a suggested distinguishing feature drawn from a wide pool
 * (freckles / glasses / jewelry / dimples / nothing-notable; ORW-388: no scars, birthmarks or teeth, the portrait cannot hold them). Dealt on its own dedicated
 * side-stream (`:genesis:looks` — the #338 RNG-isolation lesson), mirrored byte-for-byte by the FE.
 * Steering only (open set — the model may write the feature in its own words); never a validator.
 */
export const GENESIS_INK_MIN = 2;
export const GENESIS_INK_SPAN = 2; // 2-4 visibly-tattooed slots per cast
export const GENESIS_LOOK_FEATURES: readonly string[] = [
  "wire-rimmed glasses",
  "high cheekbones",
  "freckles",
  "a strong jawline",
  "thick expressive eyebrows",
  "deep dimples",
  "bright, wide-set eyes",
  "a distinctive piece of everyday jewelry",
  "laugh lines",
  "a beauty mark",
  "no single notable mark — a plain, clean look",
  "no single notable mark — ordinary and unremarkable up close",
  "no single notable mark — the kind of face that blends into a crowd photo",
];
