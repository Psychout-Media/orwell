import { PLAYER, npc } from "../domain/ids";
import type { EntityId } from "../domain/ids";
import type { PhysicalCharacteristics } from "../domain/physicalCharacteristics";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { SeededRandom } from "../adapters/random/SeededRandom";
import { physicalFacetToAppearance } from "./portraitPrompts";
import { generateVoice, type VoiceProfile } from "./voice";
import { generateInfluence, type Influence } from "./campaigns";
import { GIVEN_NAMES } from "./data/givenNames";
import { SURNAMES } from "./data/surnames";
import { VOCATIONS } from "./data/vocations";
import { HOMETOWNS } from "./data/hometowns";
import type { Hometown } from "./data/hometowns";
import { TRIGGER, type EruptionKind } from "./triggerConstants";

/**
 * CharacterFactory + OOBE (feature 0004). Generates a curated, randomly-named
 * house of NPCs within plausible Big Brother archetype bounds, and runs the
 * first-run OOBE that produces the ONLY human-authored profile (the player).
 *
 * Names are SEEDED SAMPLES from vendored real-name corpora (E38 / product ruling #1,
 * 2026-06-10): the corpora are raw material only — no full-name+persona pairing is
 * hard-coded ("no fixed cast", the amended 0004 do-not), the legacy Bible's names stay
 * banned (excluded from the corpora, guarded by test), and identity never carries
 * across seeds. Each houseguest splits into a static `Character` (baseline) and a
 * dynamic `Soul` (evolving) per docs/decisions/0001 & 0002.
 */
export type Archetype =
  | "comp-beast" | "mastermind" | "social-butterfly" | "floater" | "villain"
  | "underdog" | "flirt" | "loyalist" | "wildcard" | "analyst" | "hothead" | "peacemaker";

export type StrategyStyle =
  | "aggressive" | "social" | "strategic" | "under-the-radar" | "emotional" | "loyal";

export type Disposition = "clash" | "bond" | "neutral";

interface ArchetypeSpec {
  archetype: Archetype;
  styles: StrategyStyle[];
  disposition: Disposition;
  bias: { physical: number; mental: number; social: number };
}

export const ARCHETYPES: readonly ArchetypeSpec[] = [
  { archetype: "comp-beast",       styles: ["aggressive", "strategic"],      disposition: "clash",   bias: { physical: 0.85, mental: 0.45, social: 0.45 } },
  { archetype: "mastermind",       styles: ["strategic", "under-the-radar"], disposition: "neutral", bias: { physical: 0.4,  mental: 0.85, social: 0.55 } },
  { archetype: "social-butterfly", styles: ["social", "emotional"],          disposition: "bond",    bias: { physical: 0.45, mental: 0.5,  social: 0.85 } },
  { archetype: "floater",          styles: ["under-the-radar", "social"],    disposition: "neutral", bias: { physical: 0.45, mental: 0.5,  social: 0.55 } },
  { archetype: "villain",          styles: ["aggressive", "strategic"],      disposition: "clash",   bias: { physical: 0.55, mental: 0.75, social: 0.5  } },
  { archetype: "underdog",         styles: ["emotional", "loyal"],           disposition: "bond",    bias: { physical: 0.45, mental: 0.5,  social: 0.55 } },
  { archetype: "flirt",            styles: ["social", "emotional"],          disposition: "bond",    bias: { physical: 0.5,  mental: 0.45, social: 0.8  } },
  { archetype: "loyalist",         styles: ["loyal", "social"],              disposition: "bond",    bias: { physical: 0.5,  mental: 0.5,  social: 0.65 } },
  { archetype: "wildcard",         styles: ["emotional", "aggressive"],      disposition: "clash",   bias: { physical: 0.6,  mental: 0.5,  social: 0.5  } },
  { archetype: "analyst",          styles: ["strategic", "under-the-radar"], disposition: "neutral", bias: { physical: 0.4,  mental: 0.8,  social: 0.5  } },
  { archetype: "hothead",          styles: ["aggressive", "emotional"],      disposition: "clash",   bias: { physical: 0.7,  mental: 0.4,  social: 0.45 } },
  { archetype: "peacemaker",       styles: ["loyal", "social"],              disposition: "bond",    bias: { physical: 0.45, mental: 0.55, social: 0.7  } },
];

const SPEC_OF = new Map<Archetype, ArchetypeSpec>(ARCHETYPES.map((s) => [s.archetype, s]));

export const CAST_SIZE = 16;
export const NPC_COUNT = 15;
export const ENSEMBLE = {
  MIN_DISTINCT_ARCHETYPES: 6,
  MIN_DISTINCT_STYLES: 4,
  MAX_PER_ARCHETYPE: 3,
} as const;

/**
 * A typed HIDDEN element of an NPC (queue item B50) — "tons of hidden elements" per the mandate.
 * Engine-side ONLY (it lives on the NPC's static Character, which the player projection never carries);
 * it surfaces RARELY into off-screen scene content (gated by `hiddenSurfaces`) and reaches the player
 * only if an in-game pathway later carries it (gossip / being told). Seed-stable (part of the static
 * character, 0007). Distinct from the dynamic Soul (0041 evolution): these are fixed secrets, not mood.
 *
 * Feature 0091 adds the `"trigger"` kind: a VOLATILE secret (a buried temper, a grudge they smile
 * through, a desperate streak) carries, ENGINE-SIDE ONLY, a `volatility ∈ [0,1]` (how easily it goes
 * off) and an eruption `kind` (the PUBLIC scene type it maps to). Under accumulated strain + a fresh
 * spark + a temperature roll it FIRES a Vault-safe public house event the player witnesses — but the
 * sealed `detail`/`volatility`/`kind` themselves NEVER cross the wall (only the eruption is seen).
 */
export type HiddenElementKind = "secret-motive" | "pre-game-tie" | "concealed-aptitude" | "divergent-persona" | "trigger";
export interface HiddenElement {
  kind: HiddenElementKind;
  detail: string;
  /**
   * Feature 0091 — TRIGGER elements only (engine-side, VAULT-class). How easily this volatile secret
   * goes off ∈ [0,1] (the static charge minted on a dedicated side-rng). Never projected, never a number
   * the player sees — identical Vault treatment to every other hidden element's content. Absent on a
   * non-trigger element and on a pre-0091 save (which loads without it — the field simply stays absent).
   */
  volatility?: number;
  /**
   * Feature 0091 — TRIGGER elements only (engine-side, VAULT-class). The PUBLIC eruption scene type this
   * trigger maps to (`blow-up` / `showmance-detonation` / `mask-slips` / `meltdown`) — a *type* of public
   * blow-up, NEVER the sealed cause. Drives the eruption-pool line the narrator voices; the sealed detail
   * stays Vault-side. Absent on a non-trigger element and on a pre-0091 save.
   */
  eruptionKind?: EruptionKind;
  /**
   * Feature 0091 — TRIGGER elements only. MONOTONIC fired flag (0007/0030): set true the first time this
   * trigger erupts, so a one-shot fuse (a slipped mask) never re-fires and a restored game remembers which
   * fuses are spent. Never cleared. Absent ⇒ never fired (a pre-0091 save / an un-armed element).
   */
  fired?: boolean;
  /**
   * Feature 0091 — TRIGGER elements only. The week this trigger last fired (0007/0030) — read against the
   * re-arm cooldown so a re-armable blow-up/meltdown can't detonate two weeks running. Absent ⇒ never fired.
   */
  lastFiredWeek?: number;
}

export interface Character {
  archetype: Archetype;
  strategyStyle: StrategyStyle;
  stats: { physical: number; mental: number; social: number };
  // --- Curated PUBLIC persona facets (0004 amendment + B61 cast voices) ---
  // Seed-stable, Vault-free: the things any houseguest can see/hear across the kitchen
  // counter — projected on the houseguest card as the narrator's voice anchor.
  // NOT aptitudes, NOT hidden attributes (those live in `hiddenElements`), NOT Soul content.
  background: string;
  appearance: string;
  age: number;
  presentation: string;
  /**
   * Feature 0116 — the model-authored FREEFORM identity concept, in the model's own words (e.g. "a
   * chaos-agent podcaster who treats the house like a live show"). PUBLIC and Vault-free — the open-set
   * identity the narrator voices (ADR 0005 generalized to world-gen: recorded faithfully, NEVER
   * normalized). It rides ALONGSIDE the DERIVED `archetype` tag (the mechanical coupling key), never
   * replacing it. Present only when cast genesis authored the skeleton; absent ⇒ the deterministic floor
   * cast (the archetype IS the identity). Byte-stable once committed, like the rest of the static Character.
   */
  identityConcept?: string;
  /**
   * Concrete, DIVERSE backstory facets (L28, 2026-06-19) — generated at cast time so the cast is a
   * producer-filtered crew (varied jobs & geography) that NEVER mirrors the player, and so the
   * narrator voices the STORED origin instead of re-inventing (and drifting) it. Public, Vault-free:
   * the kind of thing any houseguest shares across the kitchen counter. Seed-stable & byte-persisted
   * like the rest of the static Character (0007/0030). `vocation` is a noun phrase ("ER nurse");
   * `hometown` is a concrete "City, ST". Optional only for back-compat with pre-L28 saves (which
   * load without them and re-derive nothing — the field simply stays as persisted).
   */
  vocation?: string;
  hometown?: string;
  /**
   * The houseguest's OBSERVABLE public DEMEANOR / speaking register (L28, 2026-06-19) — how they come
   * across to anyone in the room. PUBLIC and Vault-free, exactly like `archetype`/`strategyStyle`: it is
   * the surface vibe a stranger reads across the kitchen counter, NOT hidden strategic intent, stats, or
   * soul state (those stay in `hiddenElements`/the Soul). Its job is to break the "every houseguest is a
   * warm, witty, emotionally-available professional" homogeneity — the cast is FORCED to spread across a
   * diverse register pool (blunt, deadpan, anxious, grandiose, terse, quiet…), capped so no single vibe
   * dominates. The narrator voices the STORED register so each person sounds distinct and consistent all
   * season. Seed-stable & byte-persisted like the rest of the static Character; player-INDEPENDENT.
   * Optional only for back-compat with pre-demeanor saves (which load without it and re-derive nothing).
   */
  demeanor?: string;
  /**
   * The houseguest's VOICE fingerprint (feature 0084) — HOW they talk, a richer structured sibling of
   * `demeanor`: register / rhythm / energy / directness / humor / stress-tell + a prose signature + a
   * light habitual lexicon. PUBLIC and Vault-free (how a person talks is observable), and BYTE-STABLE
   * for the whole season — voice is IDENTITY and never drifts (owner ruling 2026-06-25; all the
   * turn-to-turn dynamism lives in the soul-derived `mood`). Generated cast-wide off a names-keyed side
   * rng (player-INDEPENDENT, no main-stream draw), so it joins the byte-stable static baseline the
   * 0007/0031 superset check guards against regeneration/drift. Optional only for back-compat with
   * pre-0084 saves (which load without it and re-derive nothing — the field stays as persisted).
   */
  voice?: VoiceProfile;
  /**
   * The static INFLUENCE aptitudes campaigns turn on (feature 0085): `persuasiveness` (how much this
   * houseguest's lobbying carries) + `susceptibility` (how easily THEY are swayed by others' campaigns).
   * ENGINE-ONLY inputs like the comp `stats` — NEVER projected to the player, byte-stable, minted off a
   * names-keyed side rng (no main-stream draw ⇒ zero calibration impact). Optional for pre-0085 saves.
   */
  influence?: Influence;
  /**
   * Deep character profile — PUBLIC facets (feature 0058). A real multi-sentence `biography` (not a
   * one-liner) and a STRUCTURED `physicalCharacteristics` facet (the single source of truth shared by
   * the portrait prompt AND the text narration, L29/L23). Part of the byte-stable static baseline, so
   * the 0007/0031 superset check guards them against regeneration/drift — exactly like the rest of the
   * Character. Public & Vault-free (the §3 presentable parts). The HIDDEN half (secrets, true goals,
   * weakness, Day-1 perception) lives in the Vault, NEVER here (it would project out). Optional only
   * for back-compat with pre-0058 saves (which load without them and re-derive nothing).
   */
  biography?: string;
  physicalCharacteristics?: PhysicalCharacteristics;
  /**
   * One-time PROVENANCE flag for the season-start deep-profile authoring write-back (#1067). The seeded
   * deterministic floor (`seedDeepProfiles`) sets `biography`/`physicalCharacteristics`/`vocation` to a
   * PLACEHOLDER; the FE then authors a RICHER replacement via `recordCastProfile`. Replacing those public
   * deep-profile facets is a legitimate season-start UPGRADE, not the memory-thinning the 0007/0031
   * non-degradation guard exists to catch — but a byte-compare can't tell "richer authored" from
   * "thinned". This flag is the discriminator (mirrors the 0062 `worldSnapshot.source` upgrade precedent):
   * unset on the seeded floor, set `true` the first time authoring folds a public facet. `isSuperset`
   * permits the facet change ONLY on the one-directional floor→authored transition; once `true`, the
   * whole Character (authored bio included) is byte-stable forever — a later drift/thinning is still
   * refused. Never projected to the player (it is not part of any outward view); Vault-free.
   */
  deepProfileAuthored?: boolean;
  /**
   * PUBLIC diversity-identity facets (feature 0063) — the cast's engine-guaranteed authentic diversity.
   * `ethnicity` is a FIRST-CLASS heritage/cultural-identity facet (an authentic facet of a full
   * character, never a stereotype kit) that GROUNDS `physicalCharacteristics.skinTone` so text and
   * portrait agree; `genderPresentation` is how the houseguest presents (descriptive, never a
   * competition input); `outOrientation` is present ONLY when the houseguest is PUBLICLY out (the house
   * knows it — a public facet like hometown). A PRIVATELY-held orientation is NEVER here — it is
   * Vault-sealed (engine-only) and surfaces only via a 0002 pathway. Public, Vault-free, byte-stable
   * (0007/0031). DESCRIPTIVE ONLY — these never bend any competition/vote/outcome. Optional for
   * back-compat with pre-0063 saves (which load without them and re-derive nothing).
   */
  ethnicity?: string;
  genderPresentation?: "man" | "woman" | "nonbinary";
  outOrientation?: string;
  /**
   * Seeded, typed HIDDEN elements (B50) — engine-side secrets the public persona may match or wildly
   * diverge from. NEVER projected to the player (the NPC card carries name + status only); they surface
   * rarely into hidden off-screen content and reach the player only via a pathway. Empty for the player
   * (their hidden material is the authored `privateStrategy`).
   */
  hiddenElements: HiddenElement[];
}

export interface Soul {
  emotionalBaseline: number;
  volatility: number;
  emotionalState: number;
  /** The persisted trajectory of `emotionalState` — the season arc (0041), monotonic (0007/0030). */
  emotionalHistory: number[];
  memory: string[];
  /**
   * 0124 — the DEEPER-evolution fields, all OPTIONAL + hidden (present only when the `ORWELL_SOUL_DEPTH`
   * layer is on; absent ⇒ the 0041 single-scalar behavior, byte-identical). Never cross the Vault Wall.
   * - `distress` / `confidence`: INDEPENDENT affect axes (0..1) — a houseguest can ride a comp win high
   *   (`confidence`▲) while rattled by a blindside (`distress`▲) at the same time, unlike the single
   *   `emotionalState` slider. Composed into the competition modifier + decision leanings when present.
   * - `temperamentDrift`: a bounded signed lean ([-1,+1], + toward clash-paranoia / − toward bond-trust)
   *   that accrues from events and mean-reverts toward 0; bends the EFFECTIVE disposition, never the
   *   static CHARACTER (0007).
   * - `settleScale`: a disposition-derived multiplier on how fast a calm stretch settles them (clash < 1
   *   ⇒ agitation lingers; bond > 1 ⇒ shrugs it off). Set at cast genesis from their disposition.
   */
  distress?: number;
  confidence?: number;
  temperamentDrift?: number;
  settleScale?: number;
  /** B28 (flag ORWELL_NPC_TELLS): the persisted observable tells `{kind, since, band}` (top 2, hysteresis against the previous record). Absent => a pre-change save is byte-identical. Hidden, words only. */
  tells?: Array<{ kind: import("./tells").TellKind; since: number; band: import("./tells").TellBand }>;
}

export interface Houseguest {
  id: EntityId;
  name: string;
  authored: "generated";
  character: Character;
  soul: Soul;
}

export interface PlayerCharacter {
  id: EntityId;
  name: string;
  authored: "oobe";
  character: Character;
  /** The player has a dynamic Soul like any houseguest (initial: no relationship beliefs yet). */
  soul: Soul;
  /**
   * The player's OWN words for their public persona, as typed at OOBE — narrative/display only.
   * Free text (not constrained to the canonical archetype enum), so the game master can voice the
   * player exactly as they described themselves. The hidden `character.archetype`/`strategyStyle`
   * still drive STATS from a canonical spec (anti-sycophancy, 0006) — these never do.
   */
  persona?: { archetype?: string; strategyStyle?: string };
  /** Authored private material (secret strategy/targets) — DR-tagged NO_NPC_PATHWAY at game start. */
  privateStrategy?: string;
  /** Why they came to play (casting interview, 0050) — player-only authored material, never an NPC pathway. */
  motivation?: string;
  /**
   * True when the player never supplied a recognizable archetype and the engine DEFAULTED them
   * to the median spec (C6): surfaced on the casting card so an early/typo'd finalization is
   * visible, never a silent stat grant.
   */
  archetypeDefaulted?: boolean;
}

export interface GameHouse {
  player: PlayerCharacter;
  npcs: Houseguest[];
}

// --- Real-name sampling from vendored corpora (E38 / ruling #1 — never a fixed cast) ---

/** The vendored raw material (test seam): given names + surnames, never name+persona pairings. */
export const NAME_CORPORA = { given: GIVEN_NAMES, surnames: SURNAMES } as const;

/** The inverse realism gate (E38): every part of a generated display name is corpus-membered. */
export function isCorpusName(fullName: string): boolean {
  const parts = fullName.split(" ");
  if (parts.length !== 2) return false;
  return GIVEN_NAMES.includes(parts[0]!) && SURNAMES.includes(parts[1]!);
}

/**
 * Seeded sampling WITHOUT replacement per season: unique full names, unique given names AND
 * unique SURNAMES within a house (the show never casts two same-named houseguests in a season,
 * and two unrelated houseguests sharing a surname reads as a casting slip — #853). The corpora
 * are raw material — which name lands on which archetype is entirely the seed's draw. The
 * pre-seeded `used`/`usedGiven` sets carry CROSS-SEASON memory (NAME-1 / #547) so a new season's
 * cast avoids names used by prior seasons in the same game.
 *
 * RNG-SAFETY (E38 / #338): the loop's RNG consumption is byte-identical to before #853 — it re-loops
 * (drawing a fresh given + surname) ONLY on the original given / full-name collision conditions, never
 * on a surname collision. A surname collision is resolved WITHOUT any draw: since a unique `given`
 * already makes the full name unique, we deterministically advance through the corpus to the next free
 * surname. So the main stream — and every downstream stat / volatility / age draw seeded off it — is
 * unchanged for ALL seeds; only the surname STRING differs on the (rare) colliding seed, which is the
 * fix. (An earlier approach re-looped on surname collisions, shifting the stream and breaking
 * seed-pinned tests like portraitVariety's age band.)
 */
function uniqueName(
  rng: RandomnessSource,
  used: Set<string>,
  usedGiven: Set<string>,
  usedSurnames: Set<string>,
): string {
  for (let guard = 0; guard < 1000; guard++) {
    const given = rng.pick(GIVEN_NAMES);
    let surname = rng.pick(SURNAMES);
    // Re-loop ONLY on the original given / full-name collisions — NOT on a surname collision — so RNG
    // consumption per iteration is byte-identical to before #853 (one given + one surname pick, same
    // re-loop triggers). Re-looping on a surname collision shifted the main stream and perturbed
    // downstream age / stat draws, breaking seed-pinned tests (portraitVariety's age band).
    if (used.has(`${given} ${surname}`) || usedGiven.has(given)) continue;
    // Surname de-dup WITHOUT consuming RNG: a unique `given` already makes the full name unique, so on
    // a surname collision we deterministically advance through the corpus to the next free surname (no
    // extra draw → main stream unchanged; both #853 and the #338 golden-RNG isolation hold).
    if (usedSurnames.has(surname)) {
      const start = SURNAMES.indexOf(surname);
      for (let step = 1; step < SURNAMES.length; step++) {
        const cand = SURNAMES[(start + step) % SURNAMES.length]!;
        if (!usedSurnames.has(cand)) {
          surname = cand;
          break;
        }
      }
    }
    const name = `${given} ${surname}`;
    used.add(name);
    usedGiven.add(given);
    usedSurnames.add(surname);
    return name;
  }
  // Same fail-stop contract as before (the guard is far beyond reachable: 805 surnames / 501 given
  // names vs a 15-cast leave ample headroom — seedPriorNames is the piece that keeps it that way).
  throw new Error("could not sample a unique name");
}

// --- Generation ---------------------------------------------------------------

function shuffled<T>(items: readonly T[], rng: RandomnessSource): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Curated draw: round-robin over a shuffled archetype pool → spread, no clumping. */
function curatedArchetypes(rng: RandomnessSource, count: number): ArchetypeSpec[] {
  const pool = shuffled(ARCHETYPES, rng);
  const out: ArchetypeSpec[] = [];
  for (let i = 0; out.length < count; i++) out.push(pool[i % pool.length]!);
  return out;
}

function jittered(bias: { physical: number; mental: number; social: number }, rng: RandomnessSource) {
  const j = (v: number): number => Math.max(0, Math.min(1, v + (rng.next() - 0.5) * 0.1));
  return { physical: j(bias.physical), mental: j(bias.mental), social: j(bias.social) };
}

// The legacy archetype-flavored background line's job pool (RETAINED for main-stream byte-stability;
// the CONCRETE diverse vocation now lives on `vocation`, dealt cast-wide off a side stream — see L28).
const OCCUPATIONS = ["nurse", "bartender", "teacher", "athlete", "marketer", "chef", "engineer", "stylist", "realtor", "musician", "firefighter", "student", "barista", "trainer"];

// --- Diverse backstory facets (L28): producer-filtered vocation + hometown, spread across the cast ---
// The whole point of L28: a real BB cast is DIVERSE and NEVER mirrors the player. The factory draws
// a concrete vocation + hometown for every NPC from large vendored corpora, capped so no job and no
// region piles up implausibly across the 15-cast. The assignment is computed CAST-WIDE (so the caps
// can apply across everyone) off a SIDE rng derived only from the SEED — never the player's profile —
// so the same seed yields the same 15 backstories regardless of who the player is.

/** No single vocation may appear more than this many times across the 15-cast (L28 diversity cap). */
export const MAX_PER_VOCATION = 2;
/** No single hometown region may exceed this share of the cast (keeps geography spread, L28). */
export const MAX_PER_REGION = 5;

export interface BackstoryFacets {
  vocation: string;
  hometown: string;
}

/**
 * Deal `count` DIVERSE (vocation, hometown) pairs off a seeded rng (L28). Vocations are unique up to
 * `MAX_PER_VOCATION`; hometowns spread across regions up to `MAX_PER_REGION` each, and no exact city
 * repeats. Player-INDEPENDENT by construction (the rng is seed-derived; no player field is read), and
 * deterministic per seed. The corpora are large enough that the caps are comfortably satisfiable for a
 * 15-cast; if a draw can't satisfy a cap within a guard budget it relaxes that one pick rather than
 * looping forever (never silently re-mirrors — it simply takes the next legal-ish draw).
 */
export function generateBackstoryFacets(rng: RandomnessSource, count: number): BackstoryFacets[] {
  const out: BackstoryFacets[] = [];
  const vocationUses = new Map<string, number>();
  const regionUses = new Map<Hometown["region"], number>();
  const usedCities = new Set<string>();

  const pickVocation = (): string => {
    for (let g = 0; g < 400; g++) {
      const v = rng.pick(VOCATIONS);
      if ((vocationUses.get(v) ?? 0) < MAX_PER_VOCATION) {
        vocationUses.set(v, (vocationUses.get(v) ?? 0) + 1);
        return v;
      }
    }
    const v = rng.pick(VOCATIONS); // budget exhausted — take the draw rather than loop forever
    vocationUses.set(v, (vocationUses.get(v) ?? 0) + 1);
    return v;
  };
  const pickHometown = (): string => {
    for (let g = 0; g < 400; g++) {
      const h = rng.pick(HOMETOWNS);
      if (!usedCities.has(h.city) && (regionUses.get(h.region) ?? 0) < MAX_PER_REGION) {
        usedCities.add(h.city);
        regionUses.set(h.region, (regionUses.get(h.region) ?? 0) + 1);
        return h.city;
      }
    }
    const h = rng.pick(HOMETOWNS); // budget exhausted — take the draw rather than loop forever
    usedCities.add(h.city);
    regionUses.set(h.region, (regionUses.get(h.region) ?? 0) + 1);
    return h.city;
  };

  for (let i = 0; i < count; i++) out.push({ vocation: pickVocation(), hometown: pickHometown() });
  return out;
}

// --- Observable DEMEANOR / voice register (L28): a FORCED SPREAD so the house is not all warm bonders ---
// The deeper half of L28: even with varied jobs, every houseguest was voiced in the SAME warm, witty,
// emotionally-available register. A real producer-cast crew is a SPREAD of vibes — a villain grates, a
// hothead flares, a quiet one stays quiet, a deadpan one underplays. This is a PUBLIC observable facet
// (how someone comes across in the room), like archetype/strategyStyle — NOT hidden intent, stats, or
// soul (those live in `hiddenElements`/Soul). Drawn cast-wide off a SEED-derived side rng (never the
// player's profile), capped so no single register piles up. CRITICAL: every word is a plain adjective
// that does NOT contain the stat-key substrings "physical"/"mental"/"social" (so it can never serialize
// into a `"physical":`-style leak the Vault scans hunt for) and carries no hidden-layer vocabulary.
export const DEMEANORS = [
  "warm and bubbly",
  "abrasive and blunt",
  "deadpan and dry",
  "anxious and eager",
  "grandiose and theatrical",
  "terse and guarded",
  "cynical and sarcastic",
  "sweet and earnest",
  "intense and competitive",
  "goofy and chaotic",
  "quiet and watchful",
  "steady and maternal",
  "cocky and brash",
  "bubbly but cutting",
  "stoic and unbothered",
  "loud and confrontational",
  "shy and awkward",
  "smooth and charming",
  "scrappy and defiant",
  "no-nonsense and matter-of-fact",
] as const;

/** The demeanor pool, exported for the L28 voice-spread tests (same precedent as APPEARANCE_POOLS). */
export const DEMEANOR_POOL = DEMEANORS;

/**
 * No single demeanor/register may appear more than this many times across the 15-cast (L28 voice-spread
 * cap) — the linchpin that stops the house from collapsing back into a room of identical warm bonders.
 * The pool is large enough (20) that ≤2 per register easily covers 15 with plenty of distinct voices.
 */
export const MAX_PER_DEMEANOR = 2;

/**
 * Deal `count` picks from `pool` off a seeded rng, each used at most `maxEach` times — a generic capped
 * spread (L28). Player-INDEPENDENT (reads only its rng) and deterministic per seed. Relaxes a pick
 * rather than looping forever if a cap can't be met within the guard budget (the pools comfortably
 * satisfy a 15-cast, so the relaxation path is unreachable in practice — but never spins).
 */
export function spreadFacet(rng: RandomnessSource, pool: readonly string[], count: number, maxEach: number): string[] {
  const out: string[] = [];
  const uses = new Map<string, number>();
  const pick = (): string => {
    for (let g = 0; g < 400; g++) {
      const v = rng.pick(pool);
      if ((uses.get(v) ?? 0) < maxEach) {
        uses.set(v, (uses.get(v) ?? 0) + 1);
        return v;
      }
    }
    const v = rng.pick(pool); // budget exhausted — take the draw rather than loop forever
    uses.set(v, (uses.get(v) ?? 0) + 1);
    return v;
  };
  for (let i = 0; i < count; i++) out.push(pick());
  return out;
}

/**
 * Deal `count` DIVERSE demeanors/registers off a seeded rng (L28), each used at most `MAX_PER_DEMEANOR`
 * times so the house reads as a genuinely mixed crew (not all warm). Player-INDEPENDENT & deterministic
 * per seed — a thin wrapper over `spreadFacet` over the `DEMEANORS` pool.
 */
export function generateDemeanors(rng: RandomnessSource, count: number): string[] {
  return spreadFacet(rng, DEMEANORS, count, MAX_PER_DEMEANOR);
}

// --- Public appearance generation (0004 amendment): seed-stable, Vault-free facets ---
// G24: the pools were 7×7×6 short phrases that said nothing about complexion, hair color,
// or distinguishing features — every unspecified slot fell to the image model's default
// face and the cast converged. Widened with the axes that most differentiate real faces;
// every entry is GENDER-NEUTRAL (names are sampled from a mixed-gender corpus with no
// gender tag, so no facet may assume one). Real BB casts are visibly diverse — complexion
// is a first-class facet, not an accident of the model's training prior.
const BUILDS = [
  "athletic", "lanky", "stocky", "willowy", "broad-shouldered", "petite", "average-build",
  "compact and muscular", "tall and rangy", "solidly built", "slender", "soft and sturdy",
];
const COMPLEXIONS = [
  "deep brown skin", "rich dark complexion", "warm brown skin", "olive complexion",
  "golden tan complexion", "light olive skin", "fair freckled skin", "pale complexion",
  "medium tan skin", "amber-toned complexion", "ebony complexion", "rosy fair skin",
];
const HAIR = [
  "close-cropped black hair", "long dark waves", "tight natural curls", "a platinum-blond bob",
  "shoulder-length auburn hair", "a sleek black ponytail", "short copper-red hair",
  "a salt-and-pepper buzzcut", "loose chestnut curls", "braided dark hair",
  "a silver-streaked undercut", "honey-blond beach waves", "jet-black slicked-back hair",
  "dyed teal-tipped hair",
];
const FEATURES = [
  "freckles across the nose", "a dimpled smile", "wire-rimmed glasses", "a small nose stud",
  "strong cheekbones", "a gap-toothed grin", "thick expressive eyebrows",
  "a faint scar above one eyebrow", "laugh lines", "a beauty mark on one cheek",
  "a square jawline", "round soft features",
];
const LOOKS = [
  "a warm smile", "a sharp gaze", "an easy grin", "a guarded expression", "bright eyes",
  "a confident stance", "a restless energy", "a calm, unhurried bearing",
];
// 2026-07-21 prompt audit: "tattooed rocker edge" made a CLOTHING-STYLE axis mandate body ink — a
// second, uncapped ink source beside the distinguishing-mark deal (the cast-uniformity index case).
// The rocker vibe stays; the ink now lives ONLY in the distinguishing-mark budget (one authority).
const PRESENTATION = [
  "casual and laid-back", "polished and camera-ready", "sporty and energetic", "bohemian",
  "sharp and put-together", "approachable", "athleisure and gym energy",
  "vintage thrift-store style", "preppy and buttoned-up", "rocker edge — all black and leather",
  "beachy and sun-faded", "minimalist monochrome",
];

/** The facet pools, exported for the G24 variety tests (same precedent as NAME_CORPORA). */
export const APPEARANCE_POOLS = { BUILDS, COMPLEXIONS, HAIR, FEATURES, LOOKS, PRESENTATION } as const;

/**
 * No single body type/build may exceed this many across the 15-cast (L28 — "no real spread of body
 * type"). The per-NPC appearance side rng draws builds INDEPENDENTLY and can cluster; a cast-wide
 * capped deal forces the spread. 12 builds / ≤2 each comfortably covers 15.
 */
export const MAX_PER_BUILD = 2;

/**
 * No single PRESENTATION style may exceed this many across the 15-cast (2026-07-21 prompt audit — the
 * "tattooed rocker edge ×3" index case). Presentation was the last per-NPC `rng.pick` appearance facet
 * with NO cast-wide spread: measured over 40 seeds, 85% of floor casts dealt some presentation 3+ times
 * (worst: the SAME string on six houseguests). The cast-wide capped deal below forces the spread the
 * same way builds/demeanors already do. 12 presentations / ≤2 each comfortably covers 15.
 */
export const MAX_PER_PRESENTATION = 2;

/**
 * Replace the BUILD slot (the first comma-separated segment) of a generated appearance string with
 * `build`, leaving complexion/hair/features/look intact. The appearance is built as
 * "<build>, <complexion>, <hair>, <features>, <look>" (see generateAppearance), so swapping the head
 * segment re-targets only body type. Falls back to a prefix if the shape is unexpected (never throws).
 */
function withBuild(appearance: string, build: string): string {
  const rest = appearance.split(", ").slice(1);
  return rest.length ? [build, ...rest].join(", ") : `${build}, ${appearance}`;
}

function generateAppearance(rng: RandomnessSource): { appearance: string; age: number; presentation: string } {
  // 21–52, skewed young (min of two draws): real casts cluster in the 20s–30s with a
  // genuine handful of 40s/50s — a flat band read as one generation of near-twins.
  const age = 21 + Math.min(rng.int(32), rng.int(32));
  return {
    age,
    presentation: rng.pick(PRESENTATION),
    appearance: `${rng.pick(BUILDS)}, ${rng.pick(COMPLEXIONS)}, ${rng.pick(HAIR)}, ${rng.pick(FEATURES)}, ${rng.pick(LOOKS)}`,
  };
}

// --- Hidden-element generation (B50): typed secrets, engine-side, surfacing rarely ---
// `concealed-aptitude` is minted from `CONCEALED_APTITUDES` (stat-backed), and `trigger` is not a draw
// pool at all (0091 — it is an ARMING of an already-minted volatile wording via `armTriggers`), so both
// are excluded here.
const HIDDEN_ELEMENT_POOLS: Record<Exclude<HiddenElementKind, "concealed-aptitude" | "trigger">, readonly string[]> = {
  "secret-motive": [
    "is secretly playing to win money for someone back home",
    "is here for redemption after a public failure",
    "wants the fame far more than the prize",
    "has something to prove to a doubter watching at home",
    "is quietly desperate and will gamble bigger than they let on",
  ],
  "pre-game-tie": [
    "recognized another houseguest from before the show",
    "shares a hometown with someone in the house",
    "has a mutual friend with a rival they haven't admitted",
    "once crossed paths with a houseguest years ago",
    "made a quiet pre-show pact they intend to honor",
  ],
  "divergent-persona": [
    "plays sweet but keeps a private target list",
    "acts like a harmless floater while reading the whole house",
    "smiles through a grudge they will never forget",
    "seems naive but clocks every move",
    "looks fiercely loyal but will cut first when it counts",
  ],
};

/** Each concealed aptitude names the STAT that must back it (audit C9 — no unbackable flavor). */
export const CONCEALED_APTITUDES: ReadonlyArray<{ detail: string; stat: keyof StatProfile }> = [
  { detail: "is far sharper at puzzles than they pretend", stat: "mental" },
  { detail: "is a hidden endurance machine", stat: "physical" },
  { detail: "has a near-photographic memory", stat: "mental" },
  { detail: "is a closet strategist playing the fool", stat: "mental" },
  { detail: "is physically stronger than their frame suggests", stat: "physical" },
];

type StatProfile = { physical: number; mental: number; social: number };

/** The fit an NPC's secrets must respect (audit C9): their real stats + their PUBLIC archetype bias. */
export interface HiddenElementFit {
  stats: StatProfile;
  /** The public archetype's stat bias — what the house already EXPECTS of them across the counter. */
  publicBias: StatProfile;
}

/**
 * Internal-consistency gates for hidden elements (audit C9). A concealed aptitude must be REAL
 * (the actual hidden stat clears `statFloor`) and actually CONCEALED (the public archetype does
 * not already advertise that stat — its bias sits under `publicBiasCeiling`). At most ONE
 * secret-motive per NPC: a character cannot be simultaneously playing for redemption AND fame.
 */
export const HIDDEN_ELEMENT_GATES = {
  statFloor: 0.6,
  publicBiasCeiling: 0.65,
  maxSecretMotives: 1,
} as const;

// The DRAW kinds (0091: `"trigger"` is NOT here — it is armed from an existing wording, not drawn).
const HIDDEN_KINDS: readonly Exclude<HiddenElementKind, "trigger">[] = ["secret-motive", "pre-game-tie", "concealed-aptitude", "divergent-persona"];

/** How many hidden elements each NPC carries (the mandate's "tons", bounded for a season). */
export const HIDDEN_ELEMENT_RANGE = { min: 3, max: 6 } as const;

/**
 * Feature 0091 — which already-minted VOLATILE hidden-element wordings can be ARMED into triggers, and the
 * PUBLIC eruption scene type each maps to. The volatile lines the B50 pools already contain (a smiled-through
 * grudge, a cut-first loyalist, a quietly-desperate gambler, a kept mask) are reclassified into the `"trigger"`
 * kind when armed — but ONLY a wording in this map can ever become a trigger (no other hidden element fires),
 * and the per-NPC cap + population sparseness keep most of the cast un-triggered (the 0059 "≤2 ties"
 * discipline). The eruption kind is the PUBLIC scene type (`blow-up`/`meltdown`/`mask-slips`), never the
 * sealed wording. `showmance-detonation` has no B50 wording to arm yet (deep profiles, 0058, author the
 * richest ones); the eruption pool for it still exists for when one is added.
 */
export const TRIGGER_WORDINGS: ReadonlyMap<string, EruptionKind> = new Map([
  // divergent-persona volatile lines — a temper / a turn / a dropped mask
  ["smiles through a grudge they will never forget", "blow-up"],
  ["looks fiercely loyal but will cut first when it counts", "blow-up"],
  ["plays sweet but keeps a private target list", "mask-slips"],
  ["acts like a harmless floater while reading the whole house", "mask-slips"],
  ["seems naive but clocks every move", "mask-slips"],
  // secret-motive volatile line — a desperate streak that breaks under pressure
  ["is quietly desperate and will gamble bigger than they let on", "meltdown"],
] as const);

/**
 * Feature 0091 — ARM a houseguest's eligible volatile hidden elements into triggers, IN PLACE, on a
 * DEDICATED side rng (so the B50 hidden-element draw sequence above is byte-IDENTICAL — only an armed
 * element gains a `kind`/`volatility`/`eruptionKind`; nothing is added/removed/reordered). Bounded + rare:
 * the per-NPC `maxTriggers` cap and the per-element `population` sparseness roll keep most of the cast
 * un-triggered. Pure; takes its own rng so the main house stream stays byte-stable (0007). Mutates the
 * passed elements in place and returns them (a no-op when no element is an eligible volatile wording).
 */
export function armTriggers(elements: HiddenElement[], rng: RandomnessSource, c = TRIGGER): HiddenElement[] {
  let armed = 0;
  for (const el of elements) {
    if (armed >= c.maxTriggers) break;
    const eruptionKind = TRIGGER_WORDINGS.get(el.detail);
    if (eruptionKind === undefined) continue;          // not a volatile wording — never a trigger
    // Population sparseness: most volatile wordings stay inert (a house of ticking bombs is noise). One
    // roll per eligible element keeps the dedicated stream deterministic.
    if (rng.next() >= c.population) continue;
    el.kind = "trigger";
    el.eruptionKind = eruptionKind;
    el.volatility = c.volatilityMintMin + rng.next() * (c.volatilityMintMax - c.volatilityMintMin);
    armed++;
  }
  return elements;
}

/**
 * Mint 3–6 DISTINCT, seeded, typed hidden elements for one NPC (B50). Driven by a SIDE rng (hashed off
 * the name) at generation so it never perturbs the main house stream (stats/names stay byte-stable, 0007).
 * With a `fit` (audit C9), the secrets are internally CONSISTENT: at most one secret-motive, and a
 * concealed aptitude only where the hidden stats genuinely back it AND the public persona conceals it.
 *
 * Feature 0091 — AFTER the B50 mint, the eligible volatile lines are ARMED into triggers under a per-NPC
 * cap + sparseness, on a DEDICATED `triggerRng` (so the B50 draw sequence is byte-identical; only an armed
 * element gains its `volatility`/eruption `kind`). Callers that don't pass a `triggerRng` mint exactly the
 * pre-0091 elements (no trigger ever armed) — pure tests and the legacy path stay byte-stable.
 */
export function generateHiddenElements(
  rng: RandomnessSource,
  fit?: HiddenElementFit,
  triggerRng?: RandomnessSource,
): HiddenElement[] {
  const count = HIDDEN_ELEMENT_RANGE.min + rng.int(HIDDEN_ELEMENT_RANGE.max - HIDDEN_ELEMENT_RANGE.min + 1); // 3..6
  const G = HIDDEN_ELEMENT_GATES;
  const aptitudes = CONCEALED_APTITUDES.filter((a) =>
    !fit || (fit.stats[a.stat] >= G.statFloor && fit.publicBias[a.stat] <= G.publicBiasCeiling));
  const out: HiddenElement[] = [];
  const seen = new Set<string>();
  let motives = 0;
  for (let attempts = 0; out.length < count && attempts < 200; attempts++) {
    const kind = rng.pick(HIDDEN_KINDS);
    let detail: string;
    if (kind === "concealed-aptitude") {
      if (aptitudes.length === 0) continue; // nothing backable/concealable — never mint flavor (C9)
      detail = aptitudes[rng.int(aptitudes.length)]!.detail;
    } else {
      if (kind === "secret-motive" && fit && motives >= G.maxSecretMotives) continue; // one motive max (C9)
      detail = rng.pick(HIDDEN_ELEMENT_POOLS[kind]);
    }
    const key = `${kind}::${detail}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind, detail });
      if (kind === "secret-motive") motives++;
    }
  }
  // 0091: arm eligible volatile lines into triggers on the DEDICATED side rng (byte-stable B50 stream).
  if (triggerRng) armTriggers(out, triggerRng);
  return out;
}

/**
 * Pre-seed a fresh season's used-name sets from PRIOR seasons' names (NAME-1 / #547) so the corpus
 * path stops repeating across a game. BOUNDED & fail-soft: the exclusion is only honored while the
 * corpus keeps comfortable headroom for the 15-cast (we never starve the sampler — `uniqueName`'s
 * guard would otherwise throw). Given names are the scarcer corpus (500 vs 805 surnames), so we
 * cap the carried-over given-name exclusion to leave at least `NAME_HEADROOM` fresh given names.
 */
const NAME_HEADROOM = NPC_COUNT * 4;
function seedPriorNames(
  priorNames: readonly string[] | undefined,
  used: Set<string>,
  usedGiven: Set<string>,
): void {
  if (!priorNames || priorNames.length === 0) return;
  const givenBudget = Math.max(0, GIVEN_NAMES.length - NAME_HEADROOM);
  for (const raw of priorNames) {
    const name = raw.trim();
    if (!name) continue;
    if (name.includes(" ")) used.add(name); // full-name exclusion (cheap — surnames are plentiful)
    const given = name.split(" ")[0]!;
    // Only exclude a given name while there is headroom; otherwise let it recur (real names do).
    if (GIVEN_NAMES.includes(given) && usedGiven.size < givenBudget) usedGiven.add(given);
  }
}

export function generateHouse(
  rng: RandomnessSource,
  priorNames?: readonly string[],
): { npcs: Houseguest[] } {
  const specs = curatedArchetypes(rng, NPC_COUNT);
  const used = new Set<string>();
  const usedGiven = new Set<string>();
  // #853: also enforce UNIQUE SURNAMES within a house (two unrelated houseguests sharing a surname
  // reads as a casting slip). Scoped to THIS house only (not pre-seeded from prior seasons): a
  // surname recurring in a later season is realistic and surnames are plentiful, so we don't carry
  // it cross-season the way `used`/`usedGiven` do.
  const usedSurnames = new Set<string>();
  // NAME-1 (#547): avoid names used by prior seasons in the same game (bounded, fail-soft).
  seedPriorNames(priorNames, used, usedGiven);
  // Draw order on the MAIN stream (name, style, stats, background, volatility) is preserved exactly;
  // appearance is generated off a SIDE rng (hashed off the name) so the cosmetic 0004 amendment
  // never perturbs competition-relevant generation (keeps seeded house composition byte-stable).
  // (E38 re-baselined the seeded streams once — the name draw now consumes 2 picks, not phonemes —
  // and the side streams hash off the new names and re-derive, exactly as the audit specified.)
  const npcs: Houseguest[] = specs.map((spec, i) => {
    const name = uniqueName(rng, used, usedGiven, usedSurnames);
    const strategyStyle = rng.pick(spec.styles);
    const stats = jittered(spec.bias, rng);
    // The legacy archetype-flavored background line's OCCUPATIONS pick is RETAINED (byte-stable: it
    // still consumes the same OCCUPATIONS main-stream draw so stats/volatility/names downstream never
    // shift, E38/G24 precedent). But the legacy pool is uncapped (14 jobs, uncapped draw), so it
    // CLUSTERS at premiere (F10/#1021 — "3 marketing, 2 firefighters"). The DRAW stays (byte-stability);
    // the surfaced `background` string is RECOMPOSED below in the L28 second pass from the capped,
    // cast-wide `vocation` (≤MAX_PER_VOCATION), so the clustered legacy job never reaches the roster.
    const background = `a ${rng.pick(OCCUPATIONS)} who plays as a ${spec.archetype}`;
    const volatility = rng.next();
    return {
      id: npc(i + 1),
      name,
      authored: "generated" as const,
      character: {
        archetype: spec.archetype,
        strategyStyle,
        stats,
        background,
        ...generateAppearance(new SeededRandom(hashSeed(`${name}:${i}`))),
        // B50: minted off a SEPARATE side rng so the main stream stays byte-stable (engine-side secrets).
        // C9: minted against the NPC's REAL stats + PUBLIC archetype bias, so secrets stay consistent.
        // 0091: trigger ARMING runs on its OWN dedicated side rng (a distinct `:trigger:` stream), so the
        // B50 hidden-element draw sequence is byte-identical AND the main house stream is untouched — the
        // calibration spine (and every seed-pinned test) is byte-stable whether triggers arm or not.
        hiddenElements: generateHiddenElements(
          new SeededRandom(hashSeed(`${name}:hidden:${i}`)),
          { stats, publicBias: spec.bias },
          new SeededRandom(hashSeed(`${name}:trigger:${i}`)),
        ),
      },
      soul: { emotionalBaseline: 0.5, volatility, emotionalState: 0.5, emotionalHistory: [], memory: [] },
    };
  });

  // L28: deal the DIVERSE, capped (vocation, hometown) facets in a SECOND pass — off a side rng keyed
  // off the cast's drawn names (seed-deterministic & player-INDEPENDENT, since the names are; the
  // player's profile is never read here). Cast-wide so the caps (≤2 per vocation, region-spread)
  // apply across everyone. It touches no main-stream draw, so stats/names/volatility stay byte-stable.
  const facetRng = new SeededRandom(hashSeed(`backstory:${npcs.map((n) => n.name).join("|")}`));
  const facets = generateBackstoryFacets(facetRng, npcs.length);
  // L28 (the deeper half): deal a SPREAD of observable DEMEANORS/registers the same way — cast-wide off
  // a seed-derived side rng, capped (≤MAX_PER_DEMEANOR each) so the house is NOT all warm bonders. And
  // deal BUILDS cast-wide too (the per-NPC appearance side rng draws builds INDEPENDENTLY, so it can
  // cluster into a generation of near-twins — L28's "no real spread of body type"): a forced ≤2-per-build
  // deal overwrites just the build slot of `appearance`, leaving every other appearance facet untouched.
  const demeanorRng = new SeededRandom(hashSeed(`demeanor:${npcs.map((n) => n.name).join("|")}`));
  const demeanors = generateDemeanors(demeanorRng, npcs.length);
  const buildRng = new SeededRandom(hashSeed(`build:${npcs.map((n) => n.name).join("|")}`));
  const builds = spreadFacet(buildRng, BUILDS, npcs.length, MAX_PER_BUILD);
  // 2026-07-21 prompt audit (the cast-uniformity index case): deal PRESENTATION cast-wide too — the
  // per-NPC side rng drew it with replacement, so one style ("tattooed rocker edge") landed on 3-6
  // houseguests at once. Same discipline as builds: a dedicated names-keyed side rng (seed-stable,
  // player-INDEPENDENT, off the main stream), capped ≤MAX_PER_PRESENTATION.
  const presentationRng = new SeededRandom(hashSeed(`presentation:${npcs.map((n) => n.name).join("|")}`));
  const presentations = spreadFacet(presentationRng, PRESENTATION, npcs.length, MAX_PER_PRESENTATION);
  // 0084: deal each houseguest a distinct VOICE fingerprint cast-wide off a names-keyed side rng — one
  // advancing stream, archetype-biased per NPC, so the cast sounds like sixteen people. Player-INDEPENDENT
  // and off the main stream (no calibration impact), byte-stable for the season (voice is identity).
  const voiceRng = new SeededRandom(hashSeed(`voice:${npcs.map((n) => n.name).join("|")}`));
  // 0085: deal the static INFLUENCE aptitudes (persuasiveness/susceptibility) cast-wide off a names-keyed
  // side rng — archetype-correlated, byte-stable, off the main stream (no calibration impact). Engine-only.
  const influenceRng = new SeededRandom(hashSeed(`influence:${npcs.map((n) => n.name).join("|")}`));
  npcs.forEach((n, i) => {
    n.character.vocation = facets[i]!.vocation;
    n.character.hometown = facets[i]!.hometown;
    // F10/#1021: recompose the surfaced background from the CAPPED vocation, replacing the clustered
    // legacy OCCUPATIONS job. The OCCUPATIONS draw above is untouched (byte-stability of the main
    // stream); only WHICH job appears in the prose changes — to the diverse, ≤MAX_PER_VOCATION one.
    n.character.background = `a ${facets[i]!.vocation} who plays as a ${n.character.archetype}`;
    n.character.demeanor = demeanors[i]!;
    n.character.appearance = withBuild(n.character.appearance, builds[i]!);
    n.character.presentation = presentations[i]!;
    n.character.voice = generateVoice(voiceRng, n.character.archetype);
    n.character.influence = generateInfluence(influenceRng, n.character.archetype);
  });
  return { npcs };
}

/** The OOBE intake — the only human-authored profile. `name` is required; the rest deepen it. */
export interface OobeInput {
  name: string;
  archetype?: Archetype;
  strategyStyle?: StrategyStyle;
  /** Optional authored backstory; deepens the static Character. */
  backstory?: string;
  /** Optional authored private strategy; becomes player-only knowledge (DR rule, 0013). */
  privateStrategy?: string;
  /**
   * The player's OWN words for their persona (free text, as typed) — kept for narrative even when
   * they don't match a canonical archetype/style. Display only; never feeds stats.
   */
  personaArchetype?: string;
  personaStrategyStyle?: string;
  /** Why they came to play (casting interview, 0050) — player-only; also seeds the Soul memory. */
  motivation?: string;
  /** Distilled get-to-know answers from the casting interview (0050) — seed the Soul memory. */
  interviewNotes?: string[];
  /**
   * How the player presents (issue #1326) — OPTIONAL, player-authored counterpart of a houseguest's
   * public `genderPresentation` facet (same enum, same `domain/gender` helpers) — so the narrator can
   * voice the player's own recorded pronouns instead of guessing from their name. Absent ⇒ omitted
   * from the Character entirely (never a fabricated default — mirrors every other OOBE field here).
   */
  genderPresentation?: "man" | "woman" | "nonbinary";
}

/** Per-disposition emotional volatility seed (the emotional-modifier baseline, decision 0001). Exported so
 *  0124's disposition-tuned reactivity (part C) stamps NPCs from the SAME table the player already uses. */
export const VOL_OF: Record<Disposition, number> = { clash: 0.7, bond: 0.3, neutral: 0.5 };

/**
 * The placeholder archetype slot the player carries when they supplied no recognizable archetype
 * (the `Character.archetype` field is non-optional, so a value must sit here). It is a NEUTRAL slot
 * ONLY — it NO LONGER seeds the player's stats. The floater bias used to be dealt as a fabricated
 * identity (#529): a typo'd/early finalization silently received a real, biased stat profile the
 * human never authored. The engine must never INVENT player canon — so when the archetype is absent
 * the stats are NEUTRAL/unbiased (see `NEUTRAL_PLAYER_STATS`), this slot is just the placeholder, and
 * `archetypeDefaulted` flags that the field is unauthored. (NEVER `ARCHETYPES[0]` — the comp-beast.)
 */
export const DEFAULT_ARCHETYPE: Archetype = "floater";

/**
 * The stat profile for a player who authored NO archetype (#529). Perfectly neutral/unbiased —
 * NOT a fabricated archetype bias. Absence ⇒ empty/neutral, never invented. Sits comfortably inside
 * `NPC_STAT_RANGE`, so it never min-maxes and never grants an edge (anti-sycophancy via fallback).
 */
export const NEUTRAL_PLAYER_STATS: { physical: number; mental: number; social: number } =
  { physical: 0.5, mental: 0.5, social: 0.5 };

/**
 * The ONLY human-authored profile, produced at first-run character creation.
 *
 * Engine contract (#529 — the engine NEVER invents canon about the human player; absence ⇒
 * empty/neutral, never fabricated). `name` is the ONE hard-required field (throws when missing —
 * the test sandbox + heavy UAT rely on a name-only intake, so this is the only throw here; the
 * "refuse to finalize on a missing required field" hard stop lives at the FE boundary, not here).
 * For every other field, ABSENCE yields empty/neutral state, never improvised content:
 *  - APPEARANCE/age/presentation: when the human authored no look, they stay EMPTY (`""`/0) — the
 *    player portrait is NEVER improvised from a name hash (the old `generateAppearance(name hash)`
 *    is gone). `getPortraitPrompt` returns null for an empty player appearance.
 *  - ARCHETYPE/stats: absent ⇒ NEUTRAL/unbiased stats (`NEUTRAL_PLAYER_STATS`), a neutral volatility,
 *    `archetypeDefaulted: true`, and an EMPTY persona — never the fabricated "floater" identity.
 *  - BACKGROUND: absent ⇒ EMPTY (`""`) — never a placeholder presented as canon.
 */
/**
 * ORW-208 - resolve the stored strategy style for a chosen archetype. The canonical style must be one of the archetype's own `styles`
 * (it drives hidden stats and leakiness). A requested style OUTSIDE that list is still replaced with the list's first entry (the closed
 * set is unchanged), but the substitution is now REPORTED (`adjusted`) instead of silent, so the caller can surface it. An unauthored
 * (defaulted) archetype keeps the neutral first-entry placeholder and reports nothing (the style was never authored against it).
 */
export function resolveStrategyStyle(
  archetype: string | undefined,
  requested: string | undefined,
): { applied: StrategyStyle; adjusted?: { requested: string; applied: StrategyStyle } } {
  const known = archetype !== undefined && SPEC_OF.has(archetype as Archetype);
  const spec = known ? SPEC_OF.get(archetype as Archetype)! : SPEC_OF.get(DEFAULT_ARCHETYPE)!;
  if (known && requested && (spec.styles as readonly string[]).includes(requested)) return { applied: requested as StrategyStyle };
  const applied = spec.styles[0]!;
  return known && requested ? { applied, adjusted: { requested, applied } } : { applied };
}

export function runPlayerOOBE(input: OobeInput): PlayerCharacter {
  // Validation: a profile can't be half-authored. `name` is the required field.
  if (!input || typeof input.name !== "string" || input.name.trim().length === 0) {
    throw new Error("character creation requires a name");
  }
  const defaulted = !(input.archetype && SPEC_OF.has(input.archetype));
  const spec = defaulted ? SPEC_OF.get(DEFAULT_ARCHETYPE)! : SPEC_OF.get(input.archetype!)!;
  // Stats come from the AUTHORED archetype only. Unauthored ⇒ neutral/unbiased (#529): never deal a
  // fabricated archetype's bias to a human who never chose it.
  const stats = defaulted ? { ...NEUTRAL_PLAYER_STATS } : { ...spec.bias };
  const strategyStyle = resolveStrategyStyle(input.archetype, input.strategyStyle).applied; // ORW-208: same rule, now reportable
  // The casting interview seeds the Soul memory (0050): the house's long-term memory starts with
  // who the player said they were. These are the player's OWN pre-game memories — recallable and
  // persisted (0007/0030), never an NPC pathway (the interview is OOC; no one witnessed it).
  const interviewMemory = [
    ...(input.motivation?.trim() ? [`casting interview — why I came: ${input.motivation.trim()}`] : []),
    ...(input.interviewNotes ?? [])
      .map((n) => n.trim()).filter((n) => n.length > 0)
      .map((n) => `casting interview — ${n}`),
  ];
  // The player's self-described persona is THEIR words only (display/narration). Unlike NPCs, it does
  // NOT fall back to a canonical archetype label — an unauthored persona stays empty (#529): the
  // engine never speaks a persona the human never typed.
  const personaArchetype = input.personaArchetype?.trim();
  const personaStrategyStyle = input.personaStrategyStyle?.trim();
  return {
    id: PLAYER,
    name: input.name.trim(),
    authored: "oobe",
    character: {
      // A non-optional slot must hold a value; when unauthored this is the neutral PLACEHOLDER only —
      // the stats above are already neutral, so it grants nothing. `archetypeDefaulted` marks it unauthored.
      archetype: spec.archetype,
      strategyStyle,
      stats,
      // Absent backstory ⇒ EMPTY (#529): never present a placeholder background as authored canon.
      background: input.backstory?.trim() || "",
      // No name-hash appearance (#529): the human authored no look, so it stays empty — the portrait
      // is never improvised from a name hash.
      appearance: "",
      age: 0,
      presentation: "",
      // The player authors their own hidden material (`privateStrategy`); the typed hidden-element pool
      // is for generated NPCs only, so the player's stays empty.
      hiddenElements: [],
      // #1326: the player's own recorded pronouns, mirroring a houseguest's public `genderPresentation`
      // facet — present ONLY when the player actually answered (never a fabricated default; mirrors the
      // rest of this Character literal, which omits rather than invents an unauthored field).
      ...(input.genderPresentation ? { genderPresentation: input.genderPresentation } : {}),
    },
    soul: { emotionalBaseline: 0.5, volatility: defaulted ? VOL_OF.neutral : VOL_OF[spec.disposition], emotionalState: 0.5, emotionalHistory: [], memory: interviewMemory },
    // Only the player's OWN words populate the persona; absent ⇒ omitted entirely (no canonical fallback).
    ...((personaArchetype || personaStrategyStyle)
      ? { persona: { ...(personaArchetype ? { archetype: personaArchetype } : {}), ...(personaStrategyStyle ? { strategyStyle: personaStrategyStyle } : {}) } }
      : {}),
    ...(input.privateStrategy?.trim() ? { privateStrategy: input.privateStrategy.trim() } : {}),
    ...(input.motivation?.trim() ? { motivation: input.motivation.trim() } : {}),
    ...(defaulted ? { archetypeDefaulted: true } : {}),
  };
}

export function startNewGame(
  opts: {
    seed: number; playerName: string;
    archetype?: Archetype; strategyStyle?: StrategyStyle;
    /** The player's free-text persona words (display only; preserved even if not canonical). */
    personaArchetype?: string; personaStrategyStyle?: string;
    /** Casting-interview deepeners (0050): authored material that seeds Character/Soul. */
    backstory?: string; privateStrategy?: string; motivation?: string; interviewNotes?: string[];
    /** How the player presents (issue #1326) — OPTIONAL, mirrors a houseguest's public facet. */
    genderPresentation?: "man" | "woman" | "nonbinary";
    /** NAME-1 (#547): prior seasons' names this game's new cast should avoid (bounded, fail-soft). */
    priorCastNames?: readonly string[];
  },
): GameHouse {
  const rng = new SeededRandom(opts.seed);
  const npcs = generateHouse(rng, opts.priorCastNames).npcs;
  const player = runPlayerOOBE({
    name: opts.playerName,
    ...(opts.archetype ? { archetype: opts.archetype } : {}),
    ...(opts.strategyStyle ? { strategyStyle: opts.strategyStyle } : {}),
    ...(opts.personaArchetype ? { personaArchetype: opts.personaArchetype } : {}),
    ...(opts.personaStrategyStyle ? { personaStrategyStyle: opts.personaStrategyStyle } : {}),
    ...(opts.backstory ? { backstory: opts.backstory } : {}),
    ...(opts.privateStrategy ? { privateStrategy: opts.privateStrategy } : {}),
    ...(opts.motivation ? { motivation: opts.motivation } : {}),
    ...(opts.interviewNotes ? { interviewNotes: opts.interviewNotes } : {}),
    ...(opts.genderPresentation ? { genderPresentation: opts.genderPresentation } : {}),
  });
  return { player, npcs };
}

// --- Helpers for the spec's invariants ----------------------------------------

export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

export function isPlausibleArchetype(a: string): a is Archetype {
  return SPEC_OF.has(a as Archetype);
}

export function dispositionOf(a: Archetype): Disposition {
  return SPEC_OF.get(a)!.disposition;
}

/**
 * The PUBLIC competitive menace of an archetype — its strongest aptitude bias (B55/audit C5).
 * Drives the move-in THREAT prior: a comp-beast LOOKS dangerous across the kitchen counter on
 * day one. Public-persona-derived only; the houseguest's actual hidden stats never inform it.
 */
export function archetypeMenace(a: Archetype): number {
  const b = SPEC_OF.get(a)!.bias;
  return Math.max(b.physical, b.mental, b.social);
}

const inUnit = (v: number): boolean => v >= 0 && v <= 1;

const JITTER = 0.05; // generateHouse's jittered() spread (±0.05), clamped to [0,1]

/** The aptitude range any generated houseguest can occupy (archetype bias ± jitter, clamped). */
export const NPC_STAT_RANGE: { min: number; max: number } = (() => {
  const all = ARCHETYPES.flatMap((s) => [s.bias.physical, s.bias.mental, s.bias.social]);
  return { min: Math.max(0, Math.min(...all) - JITTER), max: Math.min(1, Math.max(...all) + JITTER) };
})();

/** True iff the player's authored aptitudes sit within the cast's balanced bounds (no self-min-maxing). */
export function playerAptitudesWithinNpcBounds(p: PlayerCharacter): boolean {
  const { physical, mental, social } = p.character.stats;
  return [physical, mental, social].every((v) => v >= NPC_STAT_RANGE.min && v <= NPC_STAT_RANGE.max);
}

// --- The casting card (0050): qualitative reads only — words cross the wall, numbers never do ---

/** Every canonical strategy style, derived from the single source of truth (no hand-copied list). */
export const ALL_STRATEGY_STYLES: readonly StrategyStyle[] =
  [...new Set(ARCHETYPES.flatMap((s) => s.styles))];

export type StrengthTier = "standout" | "solid" | "scrappy";

/** The producer's read of one aptitude — a tier WORD derived from the hidden stat (0050 §5). */
export function strengthTier(v: number): StrengthTier {
  return v >= 0.7 ? "standout" : v >= 0.55 ? "solid" : "scrappy";
}

/** A Vault-free portrait descriptor (0020): PUBLIC facets only — never aptitudes, hidden, or Soul. */
export interface PortraitDescriptor {
  name: string;
  age: number;
  appearance: string;
  presentation: string;
  /** Archetype-as-vibe (public persona), never the numeric aptitudes behind it. */
  vibe: string;
}

/**
 * Build the portrait descriptor the front-end image-gen consumes. It draws ONLY on the
 * Character's public identity facets; it deliberately omits P/M/S aptitudes, hidden
 * attributes, and all Soul content — so a portrait can never leak secret state (0001/0020).
 */
export function portraitDescriptorFor(hg: { name: string; character: Character }): PortraitDescriptor {
  const c = hg.character;
  return {
    name: hg.name,
    age: c.age,
    // L29 single source of truth: when the structured 0058 facet exists it AUTHORS the look (through the
    // SAME builder the portrait prompt uses), so this descriptor can never diverge from the cast photo;
    // the prose `appearance` is the pre-0058 fallback only.
    appearance: c.physicalCharacteristics ? physicalFacetToAppearance(c.physicalCharacteristics) : c.appearance,
    presentation: c.presentation,
    vibe: `${c.archetype} energy, a ${c.strategyStyle} presence`,
  };
}

/** Internal-consistency / plausible-archetype ruleset the factory must honor. */
export function isPlausibleHouseguest(hg: Houseguest): boolean {
  const spec = SPEC_OF.get(hg.character.archetype);
  if (!spec) return false;
  if (!spec.styles.includes(hg.character.strategyStyle)) return false;
  const { physical, mental, social } = hg.character.stats;
  if (![physical, mental, social].every(inUnit)) return false;
  return hg.name.length > 0 && hg.character.background.length > 0;
}
