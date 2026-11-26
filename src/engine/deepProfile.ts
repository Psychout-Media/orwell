import type { EntityId } from "../domain/ids";
import type { PhysicalCharacteristics } from "../domain/physicalCharacteristics";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { SeededRandom } from "../adapters/random/SeededRandom";
import { hashSeed, spreadFacet, dealPresentationFamilies } from "./characterFactory";
import { tagKind } from "../domain/castRealism";
import { STYLE_FAMILIES, familyForLabel } from "../domain/styleFamilies";
import { dealCastingTypes, type CastingType } from "../domain/castingTypes";
import type { Archetype, Character, Houseguest } from "./characterFactory";
import { THREAD } from "./threadConstants";
import { dealLookTails, composedMarks } from "./lookVariants";

export type { PhysicalCharacteristics };

/**
 * Feature 0058 — deep character profiles ("born deep, persist, play out").
 *
 * THIS module: the DETERMINISTIC, seeded floor for the §3-depth profile, split across the Vault Wall —
 * the offline fallback the engine validates LLM output against, and the live profile source when no
 * authoring model is wired. From each houseguest's seed-stable Character it produces TWO things:
 *
 *   1. PUBLIC facets (`PublicDepth`) — a real multi-sentence `biography` (not a one-liner) + a
 *      STRUCTURED `physicalCharacteristics` facet (the single source of truth for BOTH the portrait
 *      prompt AND the text narration, L29/L23). These ride on the public, byte-stable `Character` and
 *      DO cross to the player.
 *
 *   2. HIDDEN profile (`DeepProfile`) — 2–3 secrets, the TRUE strategic goals, the named weakness /
 *      blind spot, and the Day-1 perception-of-the-player read. ENGINE-ONLY: it is sealed into the
 *      Vault and NEVER appears on any outward projection (the §8 Vault-Wall non-negotiable). It is a
 *      richer, structured sibling of the older `hiddenElements` (B50) — same discipline, more depth.
 *
 * Phase 2 is LIVE (no longer deferred): the LLM authors these (endless variety) and writes them BACK
 * through `GameSession.recordCastProfile` — the engine then validates / repairs / splits / seals (the
 * 0051 portrait-prompt handshake mirror, ledger L28b). The portrait consumption (L29 — the structured
 * physical facet feeds `castPortraitPrompts`), the premiere voicing (L31 — the public biography is
 * voiced through the `premiere` moment prompt), and the FULL thread trigger/resolution scheduler
 * (feature 0060 — `GameSessionAdapter.scheduleStoryThreads`, wired into the off-screen tick) are all
 * wired. This module remains the deterministic floor: it seeds, seals, persists, and the live scheduler
 * walks the threads dormant→active→surfaced→resolved→expired.
 *
 * Determinism: every generator is driven by a SIDE rng hashed off the houseguest's name + seed, so it
 * never perturbs the main house stream (stats/names stay byte-stable, 0007) and the same seed yields
 * the same depth regardless of who the player is (L28 non-mirroring).
 *
 * No-leak discipline (CRITICAL): no PUBLIC facet string may serialize a banned stat KEY substring
 * ("physical"/"mental"/"social") or a bare float — the Vault scans hunt for `"physical":`-style keys
 * and floats. The public pools below are plain English with none of that vocabulary.
 */

// ── PUBLIC: the structured physical-characteristics facet (the ONE source of truth, L29/L23) ──────
// `PhysicalCharacteristics` is the pure DOMAIN type (`src/domain/physicalCharacteristics.ts`),
// re-exported above. Each axis is a short, gender-neutral English phrase; STRUCTURED so the portrait
// prompt and the narration read the SAME fields and never drift (distinct from the prose `appearance`).

/** The PUBLIC depth facets — ride on the byte-stable Character, cross to the player. */
export interface PublicDepth {
  /** A real multi-sentence backstory (not a one-liner) — the presentable parts. */
  biography: string;
  physicalCharacteristics: PhysicalCharacteristics;
  /** ORW-381: the houseguest's casting type, dealt off its own `${seed}:casting-type` side stream. */
  castingType: CastingType;
}

// ── HIDDEN: the §3 profile that never crosses the wall ────────────────────────────────────────────
/** A Day-1 read of the player (v0 §10) — seeds the NPC→player edge. Hidden; no number ever shown. */
export interface DayOnePerception {
  /** A short clause: how this NPC reads the player at move-in (e.g. "harmless, socially useful"). */
  read: string;
  /** Signed seeds for the NPC→player edge (each in [-1,1]); folded into the move-in edge, never shown. */
  trustLean: number;
  affinityLean: number;
  threatLean: number;
}

/**
 * The full HIDDEN profile (0058 §3) — ENGINE-ONLY, sealed into the Vault, never on any outward
 * projection. A structured, deeper sibling of `hiddenElements` (B50). Seed-stable (part of the
 * baseline a houseguest is "born with"); folds into the hidden weights through the story threads.
 */
export interface DeepProfile {
  /** 2–3 real secrets — the kind that play out (financial desperation, a hidden alliance, a past). */
  secrets: string[];
  /** The TRUE strategic goals (distinct from the public persona's stated game). */
  trueGoals: string[];
  /** The named weakness / blind spot — a behavioral seed the game can exploit on a delay. */
  weakness: string;
  /** The Day-1 perception-of-the-player read (seeds the NPC→player edge). */
  dayOnePerception: DayOnePerception;
}

// ── A story thread (0058 §5) — the v0 §15 "Loose End" shape, Vault-sealed ─────────────────────────
export type ThreadStatus = "dormant" | "active" | "surfaced" | "resolved" | "expired";

/** The hidden-weight interaction nature a thread folds when it activates (a 0023 InteractionType). */
export type ThreadWeightImpact = "conflict" | "betrayal" | "alliance" | "bonding" | "strategy" | "gossip";

/**
 * Feature 0060 §3 — the STRUCTURED, machine-evaluable trigger condition (a small closed enum, mirroring
 * `decisionConstants.ts`'s closed `NominationTactic`/disposition sets). It rides ALONGSIDE the prose
 * `trigger` (never replacing it — the prose stays for full-fidelity recall / narrator flavor, 0058 §6).
 * Each member is a GATE on when the world is ripe, evaluated against a Vault-free `SeasonPosition`
 * snapshot — never a content channel: the predicates read only PUBLIC position facts (nominations, week,
 * living-cast size, power holders, the engine's own relationship reads), never the thread premise.
 */
export type TriggerCondition =
  /** the source houseguest is currently nominated */
  | "on-block"
  /** the source has been on the block in ≥ THREAD.nominatedWeeksForRivalry distinct weeks */
  | "nominated-twice"
  /** the source's standing has dropped — bottom-quantile bond/threat read among the living house */
  | "cornered-socially"
  /** the living-cast count has fallen to ≤ THREAD.tightenCastSize */
  | "house-tightens"
  /** the source holds power this week (HOH / veto) — the goal demands a visible play */
  | "goal-demands-move";

export const TRIGGER_CONDITIONS: readonly TriggerCondition[] = [
  "on-block", "nominated-twice", "cornered-socially", "house-tightens", "goal-demands-move",
];

/**
 * A hidden dramatic thread derived from a character's secrets / weakness / goals. Sealed into the
 * Vault at seal time, persisted across restart, and folded into the relationship/soul layer when it
 * activates (reusing the 0023 consequence fold — NOT a parallel subsystem). Surfacing to others/the
 * player happens ONLY via in-game pathways (0002), never exposition.
 */
export interface StoryThread {
  /** Stable id within a season (so seal/persist/restore are idempotent). */
  id: string;
  /** The character the thread belongs to. */
  sourceId: EntityId;
  /** What the thread is about (the secret/weakness/goal it dramatizes). */
  premise: string;
  /** The game condition that activates/escalates it (prose; the scheduler reads `triggerCondition`). */
  trigger: string;
  /**
   * Feature 0060 §3 — the STRUCTURED condition the scheduler evaluates each tick against the live,
   * Vault-free season position. Mapped from the source class (secret/weakness/goal) at derive time so
   * it agrees in spirit with the prose `trigger`. OPTIONAL on the type so a pre-0060 saved thread (no
   * structured field) loads cleanly; the engine defaults it by source class on restore (back-compat).
   */
  triggerCondition?: TriggerCondition;
  /** How it can become known — in-game pathways only (witnessed / told / overheard / gossip). */
  surfacingPathways: string[];
  /** The interaction nature whose hidden delta this thread folds when it activates (0023 kind). */
  weightImpact: ThreadWeightImpact;
  /** Lifecycle. Phase 1 seeds them `dormant`; the 0060 scheduler walks dormant→active→surfaced→resolved
   *  (or →expired). The status is persisted, so a driven thread survives a restart at its status (0030). */
  status: ThreadStatus;
  /**
   * Feature 0060 — the WEEK the thread last changed lifecycle (seeded at 0 on derive; set to the live
   * week on each transition). The scheduler reads it for the resolve/expire windows. Optional on the
   * type for pre-0060 back-compat; defaulted to the live week on restore when absent.
   */
  lifecycleWeek?: number;
}

// ── Deterministic PUBLIC generation ───────────────────────────────────────────────────────────────
// All pools are gender-neutral English with NO stat-key substring and NO float.

// ORW-381: each build entry carries a fitness band. The band is picked from the houseguest's physical stat
// with noise at creation (a hint, not a readout; Vault Wall exception 4, owner-ruled 2026-11-14). Only the
// words below are ever stored: the band name and the stat never leave the engine. Neutral, flattering lines.
export type BuildBand = "athletic" | "average" | "soft";
const BUILD_ENTRIES: readonly { readonly desc: string; readonly band: BuildBand }[] = [
  { desc: "tall and athletic", band: "athletic" },
  { desc: "compact and muscular", band: "athletic" },
  { desc: "lean and toned, a runner's build", band: "athletic" },
  { desc: "broad-shouldered and strong", band: "athletic" },
  { desc: "average height, athletic", band: "athletic" },
  { desc: "wiry and quick", band: "athletic" },
  { desc: "average height, trim", band: "average" },
  { desc: "medium build, relaxed posture", band: "average" },
  { desc: "tall and lean", band: "average" },
  { desc: "short and compact", band: "average" },
  { desc: "average height, easy build", band: "average" },
  { desc: "average height, soft and sturdy", band: "soft" },
  { desc: "petite and slight", band: "soft" },
  { desc: "tall and slender", band: "soft" },
  { desc: "slim, delicate-framed", band: "soft" },
  { desc: "short and rounded, warm and solid", band: "soft" },
];
const HEIGHT_BUILD: readonly string[] = BUILD_ENTRIES.map((e) => e.desc);
/** The build words for tests that pin the list. */
export const BUILD_WORDS: readonly string[] = HEIGHT_BUILD;
/** The band of a stored build string (engine-side test helper; never projected). */
export function buildBandOf(desc: string): BuildBand | undefined { return BUILD_ENTRIES.find((e) => desc === e.desc || desc.startsWith(`${e.desc} `))?.band; }

/**
 * Pick each houseguest's build band from their physical stat plus noise: ONE `rng.int` per houseguest on the
 * `${seed}:build-band` side stream. stat >= 0.65: athletic 70 / average 25 / soft 5; 0.45 to 0.65: average 60 /
 * athletic 20 / soft 20; below 0.45: soft 60 / average 30 / athletic 10. Reads the hidden stat at creation only.
 */
export function dealBuildBands(rng: RandomnessSource, physicalStats: readonly number[]): BuildBand[] {
  return physicalStats.map((stat) => {
    const r = rng.int(100);
    if (stat >= 0.65) return r < 70 ? "athletic" : r < 95 ? "average" : "soft";
    if (stat >= 0.45) return r < 60 ? "average" : r < 80 ? "athletic" : "soft";
    return r < 60 ? "soft" : r < 90 ? "average" : "athletic";
  });
}

/** One `rng.int` per houseguest: an unused (cap-respecting) entry of the houseguest's band, else any unused one. */
export function dealBuildSpread(
  rng: RandomnessSource, count: number, bands: readonly BuildBand[] | undefined, maxEach: number,
): string[] {
  const uses = new Map<string, number>();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = rng.int(1_000_000);
    const open = BUILD_ENTRIES.filter((e) => (uses.get(e.desc) ?? 0) < maxEach);
    const pool = open.length ? open : BUILD_ENTRIES;
    const band = bands?.[i];
    const inBand = band ? pool.filter((e) => e.band === band) : pool;
    const from = inBand.length ? inBand : pool;
    const v = from[Math.floor((r / 1_000_000) * from.length) % from.length]!.desc;
    uses.set(v, (uses.get(v) ?? 0) + 1);
    out.push(v);
  }
  return out;
}
const SKIN_TONE = [
  "deep brown skin", "warm tan complexion", "fair freckled skin", "olive complexion",
  "rich dark complexion", "golden-brown skin", "pale rosy complexion", "amber-toned skin",
  "medium brown skin", "light olive complexion",
];
// ORW-381: hair is dealt by AGE and never repeats inside a cast (MAX_PER_HAIR 1). Each entry is a neat,
// positive cut-and-colour line tagged with the youngest and oldest age it may be dealt to. Gray, silver
// and salt-and-pepper entries start at 40 (a 40+ houseguest may still draw a non-gray entry).
type HairLean = "man" | "woman";
interface HairEntry { readonly desc: string; readonly minAge: number; readonly maxAge: number; readonly lean?: HairLean }
const H = (desc: string, minAge = 18, maxAge = 99, lean?: HairLean): HairEntry => ({ desc, minAge, maxAge, ...(lean ? { lean } : {}) });
const HAIR_ENTRIES: readonly HairEntry[] = [
  H("tight natural curls, jet black"), H("long glossy dark waves", 18, 99, "woman"), H("a sharp close-cropped fade", 18, 99, "man"),
  H("a platinum-blond bob", 18, 45, "woman"), H("shoulder-length auburn hair"), H("a sleek black ponytail"),
  H("short copper-red hair"), H("loose chestnut curls"), H("neat braided dark hair"),
  H("honey-blond beach waves", 18, 45, "woman"), H("glossy chestnut curls to the shoulder"),
  H("a clean side-parted dark crop", 18, 99, "man"), H("a smooth espresso-brown bob", 18, 99, "woman"), H("a polished slicked-back black style", 18, 99, "man"),
  H("thick wavy dark-brown hair"), H("a tousled sandy-blond cut", 18, 45), H("a sleek caramel-highlighted lob", 18, 99, "woman"),
  H("a tapered low fade with a twist-out top", 18, 99, "man"), H("long straight jet-black hair", 18, 99, "woman"), H("a rich auburn pixie cut", 18, 99, "woman"),
  H("neat locs past the shoulder"), H("a golden-blond swept-back style", 18, 45, "man"), H("a short natural dark afro"),
  H("a bright strawberry-blond ponytail", 18, 40, "woman"), H("a classic dark-brown side part", 18, 99, "man"), H("a voluminous dark blowout", 18, 99, "woman"),
  H("a salt-and-pepper buzzcut", 40, 99, "man"), H("a silver-streaked swept-back style", 40, 99, "man"),
  H("a distinguished silver crop", 40), H("a sleek silver-gray bob", 40, 99, "woman"),
];
/** The heritages whose natural hair is dark: a light blond, copper, auburn or strawberry cut is not dealt to them. */
const DARK_HAIR_HERITAGES = new Set([
  "Black American", "Nigerian American", "Caribbean American", "Mexican American", "Puerto Rican", "Dominican American", "Chinese American",
  "Filipino American", "Korean American", "South Asian American", "Vietnamese American", "Native American", "Middle Eastern American",
]);
const LIGHT_HAIR_RE = /\b(?:blond|copper|auburn|strawberry|platinum|golden|honey|sandy|caramel)\b/i;
/** True when the hair entry fits the person's gender (a men's cut is not dealt to a woman or the reverse; nonbinary and unstated take any) and heritage. */
export function hairFits(desc: string, gender?: string, heritage?: string): boolean {
  const e = HAIR_ENTRIES.find((x) => x.desc === desc);
  if (!e) return true;
  if (e.lean !== undefined && (gender === "man" || gender === "woman") && e.lean !== gender) return false;
  if (heritage !== undefined && DARK_HAIR_HERITAGES.has(heritage) && LIGHT_HAIR_RE.test(desc)) return false;
  return true;
}
/**
 * ORW-480: the cut that goes with a houseguest's FINAL gender and heritage, after identity or genesis changed either. A cut that already fits is kept
 * (no change for a coherent cast); one that does not is replaced by an unused fitting entry of the person's age, drawn off the given rng.
 * Returns {id: new hair} for the people changed only.
 */
export function recohereHair(
  rng: RandomnessSource,
  people: ReadonlyArray<{ id: string; hair: string | undefined; age: number; gender?: string; heritage?: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const taken = new Set(people.map((p) => p.hair).filter((h): h is string => !!h));
  for (const p of people) {
    if (!p.hair || hairFits(p.hair, p.gender, p.heritage)) continue;
    const pool = HAIR_ENTRIES.filter((e) => !taken.has(e.desc) && p.age >= e.minAge && p.age <= e.maxAge && hairFits(e.desc, p.gender, p.heritage));
    if (pool.length === 0) continue;
    const pick = pool[Math.floor(rng.next() * pool.length) % pool.length]!.desc;
    taken.delete(p.hair); taken.add(pick);
    out[p.id] = pick;
  }
  return out;
}
/** The cleaned hair strings, for tests that pin the list. */
export const HAIR_DESC: readonly string[] = HAIR_ENTRIES.map((e) => e.desc);
const HAIR_GRAY = /\b(gray|grey|silver|salt-and-pepper)\b/i;
/** True when a hair entry is a gray/silver/salt-and-pepper one (only dealt at 40+). */
export function isGrayHair(desc: string): boolean { return HAIR_GRAY.test(desc); }

// ORW-480: forty plain, specific face descriptions (never a mark: no glasses, freckles, dimples, piercings, scars or a tooth gap), dealt
// at most once per cast, so no one description turns up in most casts (the writer sharpens it on the card).
const FACIAL = [
  "strong cheekbones", "a square jaw and deep-set eyes", "round soft features", "a sharp angular face", "an open friendly face",
  "heavy expressive eyebrows", "a narrow refined face", "a warm crinkle-eyed smile", "an even symmetrical face", "a broad expressive grin",
  "a long face with a prominent nose", "wide-set eyes and a soft chin", "a heart-shaped face", "a strong brow and a straight nose",
  "full cheeks and small eyes", "an oval face with a high forehead", "a broad nose and a wide smile", "narrow eyes and a firm mouth",
  "a pointed chin and arched brows", "a rounded jaw and big dark eyes", "a defined jaw and a slightly upturned nose", "soft eyes and a gentle mouth",
  "a high forehead and thin lips", "a wide face with a short nose", "a long jaw and a thoughtful gaze", "large expressive eyes and a small mouth",
  "a strong nose and sculpted cheeks", "a pronounced chin and thick lashes", "a flat-planed face with a calm expression", "a broad forehead and a quick smile",
  "a slim face with a prominent jaw", "deep-set eyes and a wry mouth", "round cheeks and a short chin", "a roman nose and a steady look",
  "a petite face with bright eyes", "a wide jaw and a flat brow", "angular brows and a lean face", "a soft round chin and wide cheekbones",
  "a squarish face with a ready grin", "hooded eyes and a full mouth",
];
// ORW-480: marks are SIGNATURES a portrait can hold (glasses, ear and nose piercings, freckles, dimples, beauty marks, three tattoos): no scars,
// birthmarks, tooth gaps or smiles. FORTY-FOUR of them, each dealt at most once per cast, and about 3 or 4 of a 15-cast carry one, so no
// single mark turns up in more than about one cast in ten (the old pool of eleven put each one in about every other season).
// ORW-508: the marks are composed (lookVariants.composedMarks: frame x colour glasses, metal x type x side earrings, nose rings, density x
// area freckles, dimples, beauty marks and small tattoos), several hundred named marks, plus the plain "none notable". The hand list of 43 is gone.
const MARKS: readonly string[] = [...composedMarks(), "none notable"];
const MARK_KIND = new Map<string, string>();
/** The mark's category (glasses, ear-piercing, freckles ...) from the shared casting-director table. */
const markKind = (m: string): string => {
  let k = MARK_KIND.get(m);
  if (k === undefined) { k = tagKind("mark", { distinguishingMark: m } as never)[0] ?? "other"; MARK_KIND.set(m, k); }
  return k;
};
/** No category of mark on more than this many cards of a cast. */
const MAX_MARKS_PER_KIND = 2;
/** Share of a cast dealt "none notable" (rounded to a whole count per cast): 11 of 15, so 4 carry a mark. */
const MARK_NONE_SHARE = 0.76;
// ORW-360: the seeded style is no longer dealt from a second list. It is the `sample` of the houseguest's
// OWN presentation family (src/domain/styleFamilies.ts), so the brief and the label always agree. The
// rocker vibe stays ink-free; visible ink is the distinguishing-mark budget's alone (2026-07-21 audit).

// #533: the salient look axes — hair, facial features, and style — were drawn with an INDEPENDENT
// per-NPC `rng.pick()`, with NO cast-wide spread cap, so a 15-cast could deal the same "platinum-blond
// bob" five times (the repetitive-cast bug). These are the L28-style SPREAD caps (the same discipline
// skinTone/build/ethnicity already use via `spreadFacet`/`MAX_PER_*`): the cast is DEALT each facet with
// each value used at most this many times, instead of independent per-NPC picks.
export const MAX_PER_HAIR = 1;
export const MAX_PER_FACIAL = 1;
// #1317 (cast portraits converge, root cause 2): `heightBuild`/`skinTone` were drawn with a BARE
// per-NPC `rng.pick()` — no cast-wide spread cap — while hair/facial/style already got the L28-style
// cap above. Same discipline, same pool sizes (10 each): capped at 2 so a 15-cast comfortably spreads
// across at least 5 distinct values per axis instead of risking the same build/tone piling up.
export const MAX_PER_HEIGHT_BUILD = 2;
export const MAX_PER_SKIN_TONE = 2;
// 2026-07-21 prompt audit: `distinguishingMark` was the last physical axis drawn with a bare per-NPC
// `rng.pick()` — no cast-wide cap — so one mark could pile up across the cast (the "full sleeve of
// tattoos ×4" defect). Named marks are now dealt cast-wide at ≤2 each; "none notable" (deliberately
// repeated in the pool — most faces have no salient mark) is EXEMPT from the cap, so a realistic
// majority-plain cast stays legal.
export const MAX_PER_MARK = 1;

/** An age-look cue keyed off the houseguest's age band — keeps the look age-appropriate (0058 §3). */
export function ageLookFor(age: number): string {
  if (age < 25) return "fresh, early-twenties energy";
  if (age < 32) return "bright, late-twenties look";
  if (age < 40) return "polished, thirties poise";
  if (age < 50) return "fit and well-kept, forties ease, a few laugh lines";
  return "distinguished, fit fifties, laugh lines and presence";
}

/**
 * Pre-dealt, cast-wide PHYSICAL spread for the salient look axes (#533): each entry is one NPC's
 * dealt hair / facial / style, capped cast-wide so no value piles up (`MAX_PER_*`). Built once per
 * cast off a seeded side rng and indexed positionally with the cast iteration, exactly the way
 * `characterFactory` deals `builds` over `BUILDS`.
 */
export interface PhysicalSpread {
  heightBuild: string;
  skinTone: string;
  hair: string;
  facial: string;
  style: string;
  /** 2026-07-21 prompt audit: the cast-wide capped distinguishing-mark deal (named marks ≤MAX_PER_MARK; "none…" uncapped). */
  mark: string;
  /** ORW-508: the independent tail each composed axis carries (lookVariants.ts). */
  tails?: import("./lookVariants").LookTails;
}

/**
 * ORW-381: deal `count` marks with exactly ONE `rng.int` per houseguest (fixed draws, no rejection loop).
 * A cast gets round(MARK_NONE_SHARE * count) "none notable" slots, spread by sequential selection (slot i is
 * plain with probability needed/remaining), the rest draw an unused NAMED mark (each at most `maxEach`
 * times; once the named marks run out the slot is "none notable").
 */
export function dealMarksSpread(rng: RandomnessSource, count: number, maxEach: number): string[] {
  const named = MARKS.filter((m) => !/^none\b/i.test(m));
  const none = MARKS.find((m) => /^none\b/i.test(m))!;
  const uses = new Map<string, number>();
  const kindUses = new Map<string, number>();
  let noneLeft = Math.round(MARK_NONE_SHARE * count);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = rng.int(1_000_000);
    const remaining = count - i;
    if (noneLeft > 0 && r * remaining < noneLeft * 1_000_000) { noneLeft--; out.push(none); continue; }
    const open = named.filter((m) => (uses.get(m) ?? 0) < maxEach && (kindUses.get(markKind(m)) ?? 0) < MAX_MARKS_PER_KIND);
    if (open.length === 0) { out.push(none); continue; }
    // the same draw already decided "named"; spread what is left of it evenly over the open marks (using it raw leaned on the end of the list)
    const u = Math.min(0.999999, Math.max(0, (r * remaining - noneLeft * 1_000_000) / (Math.max(1, remaining - noneLeft) * 1_000_000)));
    const v = open[Math.floor(u * open.length)]!;
    uses.set(v, (uses.get(v) ?? 0) + 1);
    kindUses.set(markKind(v), (kindUses.get(markKind(v)) ?? 0) + 1);
    out.push(v);
  }
  return out;
}

/**
 * ORW-381: deal hair by age with exactly ONE `rng.int` per houseguest and no rejection loop. Each draw maps
 * onto the entries still unused AND allowed for that houseguest's age (gray/silver only at 40+); if none is
 * left for that age it takes from all unused; past the list size it reuses (cap relaxes, unreachable at 30).
 */
export function dealHairSpread(
  rng: RandomnessSource, count: number, ages: readonly number[] | undefined, maxEach: number,
  genders?: ReadonlyArray<string | undefined>, heritages?: ReadonlyArray<string | undefined>,
): string[] {
  const uses = new Map<string, number>();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = rng.int(1_000_000);
    const age = ages?.[i];
    const unused = HAIR_ENTRIES.filter((e) => (uses.get(e.desc) ?? 0) < maxEach);
    const pool = unused.length ? unused : HAIR_ENTRIES;
    const allowed = pool.filter((e) => (age === undefined ? !isGrayHair(e.desc) : age >= e.minAge && age <= e.maxAge));
    // ORW-480: the cut follows the person's gender and heritage when they are known (a woman is not dealt a men's fade, a dark-haired heritage no platinum bob)
    const fitting = allowed.filter((e) => hairFits(e.desc, genders?.[i], heritages?.[i]));
    const from = fitting.length ? fitting : allowed.length ? allowed : pool;
    const v = from[Math.floor((r / 1_000_000) * from.length) % from.length]!.desc;
    uses.set(v, (uses.get(v) ?? 0) + 1);
    out.push(v);
  }
  return out;
}

/**
 * Deal the salient look axes cast-wide with L28-style spread caps (#533; #1317 extends the cap to
 * `heightBuild`/`skinTone`). Deterministic per seed. This runs off a DEDICATED side rng, isolated
 * from every other stream (the caller always constructs a fresh `SeededRandom` just for this call),
 * so widening what it draws here can never perturb any other seeded outcome.
 */
export function dealCastPhysicalSpread(
  rng: RandomnessSource, count: number, presentations?: readonly string[], ages?: readonly number[],
  buildBands?: readonly BuildBand[], genders?: ReadonlyArray<string | undefined>, heritages?: ReadonlyArray<string | undefined>,
): PhysicalSpread[] {
  const heightBuild = dealBuildSpread(rng, count, buildBands, MAX_PER_HEIGHT_BUILD);
  const skinTone = spreadFacet(rng, SKIN_TONE, count, MAX_PER_SKIN_TONE);
  const hair = dealHairSpread(rng, count, ages, MAX_PER_HAIR, genders, heritages);
  const facial = spreadFacet(rng, FACIAL, count, MAX_PER_FACIAL);
  const mark = dealMarksSpread(rng, count, MAX_PER_MARK);
  // ORW-360: the style is the sample of the houseguest's own presentation family. A caller with no cast
  // context (presentations absent) gets a family per slot dealt last off this same rng.
  const labels = presentations ?? dealPresentationFamilies(rng, count);
  const style = Array.from({ length: count }, (_, i) =>
    (familyForLabel(labels[i] ?? "") ?? STYLE_FAMILIES[i % STYLE_FAMILIES.length]!).sample);
  // ORW-508: drawn LAST off this same dedicated rng, so every base value above is exactly what it was.
  const tails = dealLookTails(rng, count);
  return Array.from({ length: count }, (_, i) => ({
    heightBuild: `${heightBuild[i]!} ${tails[i]!.build}`, skinTone: `${skinTone[i]!} ${tails[i]!.skin}`, hair: `${hair[i]!}, ${tails[i]!.hair}`,
    facial: `${facial[i]!} ${tails[i]!.facial}`, style: `${style[i]!}, ${tails[i]!.style}`, mark: mark[i]!, tails: tails[i]!,
  }));
}

/**
 * Deterministically build the structured physical facet for one houseguest off a SIDE rng. The
 * age-look reads the houseguest's PUBLIC age so words and picture agree (L29/L23). When a cast-wide
 * `spread` is supplied (#533) the salient axes (hair/facial/style) come from the spread-capped deal
 * instead of independent per-NPC picks; absent, it falls back to the per-NPC `rng.pick()` (a lone
 * profile with no cast context — e.g. a single-card regeneration).
 */
export function generatePhysicalCharacteristics(
  rng: RandomnessSource, age: number, spread?: PhysicalSpread,
): PhysicalCharacteristics {
  return {
    // #1317: heightBuild/skinTone now come from the cast-wide spread-capped deal when one is supplied
    // (the live cast-generation path), matching hair/facial/style; a standalone call with no cast
    // context falls back to the old independent per-NPC pick.
    heightBuild: spread ? spread.heightBuild : rng.pick(HEIGHT_BUILD),
    skinTone: spread ? spread.skinTone : rng.pick(SKIN_TONE),
    // ORW-437: the same min/max age bounds `dealHairSpread` applies (a 50-year-old never draws a bob tagged 18 to 45).
    hair: spread ? spread.hair : rng.pick(HAIR_ENTRIES.filter((e) => age >= e.minAge && age <= e.maxAge).map((e) => e.desc)),
    facialFeatures: spread ? spread.facial : rng.pick(FACIAL),
    // 2026-07-21 prompt audit: the mark rides the cast-wide capped deal when a spread is supplied (the
    // live path) — a lone regeneration without cast context keeps the per-NPC pick over the same pool.
    distinguishingMark: spread ? spread.mark : rng.pick(MARKS),
    ageLook: spread?.tails ? `${ageLookFor(age)} ${spread.tails.ageLook}` : ageLookFor(age),
    style: spread ? spread.style : rng.pick(STYLE_FAMILIES).sample,
  };
}

// A small set of biography roots/drives/closers — composed into a real multi-sentence backstory.
// PUBLIC: presentable life-outside material, NO stat vocabulary, NO float. Anchored to the public
// `background` line so the biography agrees with the already-shown persona facet.
const BIO_ROOTS = [
  "grew up in a big, loud family",
  "was raised by a single parent who worked two jobs",
  "left a small town the day after graduation",
  "came up through community college and grit",
  "spent years bouncing between cities before settling down",
  "was the quiet kid who learned to read a room",
  "built a life from scratch after a rough start",
  "comes from a tight-knit household with high expectations",
];
const BIO_DRIVES = [
  "and never stopped chasing something bigger",
  "and carries a quiet chip on the shoulder about it",
  "and learned early to count only on themselves",
  "and turned that hustle into a real career",
  "and still feels the pull of where they came from",
  "and wants to make the people back home proud",
];
const BIO_CLOSERS = [
  "Friends describe them as the one you call in a crisis.",
  "They say they applied on a dare and surprised themselves by getting cast.",
  "They have a life they put on hold for one wild summer.",
  "They are the first in their circle to ever do anything like this.",
  "They swear they are here for the experience, not just the money.",
  "They have something to prove and a quiet plan to do it.",
];

/**
 * Compose a real MULTI-SENTENCE biography from the public persona facet + the seeded roots. Two
 * sentences by construction (the §3 "real backstory, not a one-liner" requirement). Public, Vault-free.
 */
export function generateBiography(rng: RandomnessSource, c: Pick<Character, "background">): string {
  const who = c.background ? `Outside the house, they are ${c.background}` : "Outside the house, they had an ordinary life";
  const root = rng.pick(BIO_ROOTS);
  const drive = rng.pick(BIO_DRIVES);
  const closer = rng.pick(BIO_CLOSERS);
  return `${who} who ${root} ${drive}. ${closer}`;
}

// ── Deterministic HIDDEN generation (the §3 hidden half) ──────────────────────────────────────────
// L41: the pools are deliberately LARGE and the cast deal is SPREAD-CAPPED (see MAX_PER_* below), so
// the hidden layer is as diverse as the public one — no single "secret mastermind"/"secretly clocking
// every move" trope can cluster across the cast (the 2026-06-19 finale-reveal defect). Mirrors the L28
// `spreadFacet`/`MAX_PER_*` discipline in characterFactory. Every entry is plain English: no banned
// stat-key substring (`"physical":`-style) and no bare float, so the §8 Vault scans stay clean.
const SECRET_POOL = [
  "is in real financial trouble — the prize money is urgent, not aspirational",
  "is hiding a serious-superfan knowledge of the game behind a casual front",
  "has a past public failure they came here to redeem",
  "made a quiet pre-show promise to someone watching at home",
  "is nursing a grudge from outside the house they will never admit",
  "has a private health worry they keep hidden as a psychological edge",
  "is far lonelier than the confident persona lets on",
  "carries a family secret that shapes every move they make",
  "is playing for someone else entirely, not themselves",
  "has a temper they have learned to mostly contain",
  "told a flattering lie about their job that they now have to maintain",
  "is recently heartbroken and overcompensating with bravado",
  "has done this kind of high-pressure social game before, under another banner",
  "is quietly the most competitive person here and hides it behind charm",
  "owes someone on the outside and needs the win to make it right",
  "came in with a rival they recognized but is pretending they didn't",
  "is far more religious or principled than the party persona suggests",
  "has a soft spot that one specific archetype can exploit every time",
  "is documenting everyone for a tell-all they plan to write after",
  "secretly cannot stand the houseguest they are publicly closest to",
  "is younger or older than they let the house assume",
  "has a phobia or limit that a comp could expose at the worst moment",
  "is here mostly to prove something to a parent who doubted them",
  "made an off-camera alliance pact in the sequester hotel already",
];

// True strategic goals — distinct from a stated public game. No stat vocabulary.
const TRUE_GOAL_POOL = [
  "reach the end as a beloved houseguest whose strategy stays invisible",
  "build one secret two-person final deal nobody sees coming",
  "let the loud personalities take the heat while quietly steering evictions",
  "neutralize the sharpest hidden threat before the jury phase",
  "win in a way the people back home can be proud of",
  "control the house through suggestion, never visible power",
  "get to the end against someone they can clearly beat",
  "stay off the radar until the numbers force a move",
  "be the obvious leader and dare the house to take the shot",
  "collect every secret in the house and trade them like currency",
  "run a loud decoy game while a quiet one does the real work",
  "win enough comps that they never have to rely on anyone",
  "play an emotional, loyalty-first game and make the jury love them",
  "engineer a big blindside early to set the house's fear of them",
  "ride a strong shield as far as it lasts, then cut it clean",
  "flip whichever way the numbers point and never hold a grudge",
  "protect one specific person to the end, even past their own game",
  "avoid blood on their hands and let others do every eviction",
];

// Named weaknesses / blind spots — behavioral seeds the game exploits on a delay.
const WEAKNESS_POOL = [
  "underestimates quiet houseguests and reads them as non-threats too long",
  "cannot resist being the most relevant person in the room",
  "is too loyal once committed and finds it hard to cut anyone",
  "plays several moves ahead of where the house actually is",
  "lets a bruised ego drive decisions when challenged in public",
  "trusts a warm conversation far more than it has earned",
  "freezes under direct pressure and over-explains",
  "needs to be liked and folds when an alliance turns cold",
  "talks too much when nervous and leaks their own plans",
  "holds grudges and lets revenge override the smart move",
  "is so conflict-averse they let others make their decisions",
  "overestimates their own social read and gets blindsided",
  "gets attached fast and cannot play against people they like",
  "chases comp wins for the spotlight even when laying low is smarter",
  "believes their own cover story and forgets who they're lying to",
  "panics at the first sign of being on the wrong side of the house",
];

// ── CHARACTER-CONDITIONED HIDDEN generation (the P1 coherence fix) ───────────────────────────────────
// The owner's P1 defect: the secrets/goals/weakness above are drawn from FLAT SHARED pools, so they read
// as a templated grab-bag — generic, repeated across the cast, and incoherent with the houseguest's
// actual backstory/occupation/archetype/age. A private chef's secret should read like a private chef's;
// a firefighter's weakness like a firefighter's.
//
// The fix below COMPOSES each secret/goal/weakness FROM the individual `Character` — interpolating the
// houseguest's CONCRETE `vocation` (e.g. "ER nurse") and reading their `archetype` + `age` band — so the
// generated text is grounded in THIS person's specific life. Because the cast carries DIVERSE vocations
// (L28: capped at MAX_PER_VOCATION=2 across the 15-cast) and the templates interpolate that vocation
// noun, two houseguests almost never produce a verbatim-identical premise (a vocation collision would
// still differ on archetype/age/template draw). The selection is fully SEED-DETERMINISTIC (every choice
// runs through the same side rng) and PLAYER-INDEPENDENT (it reads only the NPC's own Character, never
// the player). Every fragment is plain English with NO banned stat-key substring and NO bare float, so
// the §8 Vault scans stay clean.
//
// Determinism + the floor's job: this is the guaranteed, coherent fallback. The LLM authoring (the open
// set) still overrides it through `recordCastProfile` for endless variety — but even the seeded floor is
// now an individual, coherent hidden life rather than a shared-pool draw.

/** The houseguest facets the conditioned generators read. All public/engine-side; never the player. */
type ConditioningFacets = {
  archetype: Archetype;
  vocation: string;
  ageBand: AgeBand;
};

type AgeBand = "young" | "established" | "seasoned";
function ageBandOf(age: number): AgeBand {
  if (age < 28) return "young";
  if (age < 42) return "established";
  return "seasoned";
}

/**
 * A concise, gender-neutral life-stake phrase keyed to a vocation SECTOR — the occupational TEXTURE a
 * secret/goal/weakness can borrow so it reads like THIS job's. Vocations map to a sector by keyword so
 * the 120+ corpus needs no per-job table; an unmatched vocation falls to the generic "their work" stake
 * (still grounded — the vocation noun is interpolated by the secret templates regardless).
 */
type VocationSector =
  | "trades" | "healthcare" | "service" | "business" | "tech"
  | "arts" | "education" | "publicService" | "outdoors" | "fitness" | "curio" | "generic";

// #848: the keyword set is matched FIRST-WIN over this ordered list, so a too-coarse / mis-ordered
// keyword mis-keys a vocation into a sector whose stakes don't fit it (the live repro: "cheese monger"
// matched the gimmick bucket's "cheese" and inherited novelty-act stakes like "a stunt that went viral").
// Two disciplines keep the mapping honest: (1) ORDER specific-before-generic and keep the precise
// COMPOUND keyword ahead of a single-word one that would otherwise steal the vocation ("aerospace
// technician" must reach `tech`, not be eaten by healthcare's old bare "technician"; "nail technician"
// reaches `service`, "special-education aide" reaches `education`, "city planner"/"court reporter" reach
// `publicService`, "data analyst" reaches `tech`); and (2) food & trade vocations are SPLIT OUT of the
// gimmick bucket — `curio` is now genuine reality-show novelty/performance acts only, so its stakes fit
// every member. Every corpus vocation resolves to a sector whose stake pool plausibly fits it (a coherence
// regression test pins this); an unmatched vocation still falls to the grounded `generic` stakes.
const SECTOR_KEYWORDS: ReadonlyArray<{ sector: VocationSector; words: readonly string[] }> = [
  // healthcare — precise clinical roles ONLY (so "nail technician" / "aerospace technician" /
  // "special-education aide" are NOT pulled in by a bare "technician"/"aide" before their real sector).
  { sector: "healthcare", words: ["nurse", "paramedic", "hygienist", "physical therapist", "occupational therapist", "pharmacist", "radiologic", "veterinary technician", "phlebotomist", "home health aide", "optometrist", "emt"] },
  { sector: "trades", words: ["electrician", "plumber", "welder", "carpenter", "mechanic", "hvac", "foreman", "landscaper", "painter", "machinist", "roofer", "locksmith"] },
  // service, hospitality, FOOD & personal-care — food vendors (cheese monger) and beauty/personal-care
  // (nail tech, massage) live here, AHEAD of the gimmick bucket, so their stakes read job-shaped.
  { sector: "service", words: ["bartender", "barista", "cook", "chef", "sommelier", "concierge", "flight attendant", "cruise-ship", "wedding planner", "food-truck", "cheese", "tattoo", "barber", "hairstylist", "nail", "massage"] },
  // tech & engineering — "data analyst" / "aerospace" resolve here (ahead of business "analyst" /
  // healthcare "technician"); the keywords are compound/anchored so they don't over-capture.
  { sector: "tech", words: ["software", "it support", "data analyst", "qa ", "civil engineer", "aerospace", "robotics", "drone", "video-game streamer", "ux ", "network administrator"] },
  { sector: "business", words: ["real-estate agent", "salesperson", "adjuster", "broker", "financial advisor", "supply-chain", "account executive", "small-business owner", "pharmaceutical rep", "bank teller", "recruiter", "boutique owner"] },
  { sector: "arts", words: ["graphic designer", "photographer", "podcast", "musician", "filmmaker", "comedian", "dancer", "novelist", "muralist", "voice-over", "fashion buyer", "gallery", "dj"] },
  { sector: "education", words: ["teacher", "counselor", "student", "tutor", "docent", "librarian", "special-education aide"] },
  // public service & law — "city planner" / "court reporter" resolve here (not service's "planner" /
  // business's "rep" substring).
  { sector: "publicService", words: ["firefighter", "dispatcher", "paralegal", "social worker", "postal carrier", "city planner", "court reporter", "park ranger", "customs officer"] },
  { sector: "outdoors", words: ["fisherman", "rancher", "vineyard", "beekeeper", "florist", "trucker", "wildland", "ski-resort", "marine biologist", "farmer", "zookeeper"] },
  { sector: "fitness", words: ["trainer", "yoga", "crossfit", "athlete", "climbing", "swim coach", "boxing", "surf", "spin", "physical-education"] },
  // the only-on-a-reality-show curios — GIMMICK / performance acts ONLY (food & trades split out above),
  // so the novelty-act stakes below fit every member.
  { sector: "curio", words: ["competitive-eating", "cuddler", "escape-room", "renaissance", "mascot", "axe-throwing", "ghost-tour", "balloon", "poker"] },
];

function sectorOf(vocation: string): VocationSector {
  const v = vocation.toLowerCase();
  for (const { sector, words } of SECTOR_KEYWORDS) {
    if (words.some((w) => v.includes(w))) return sector;
  }
  return "generic";
}

// A vocation-sector "stake" — the personal/financial/identity weight a hidden secret can hang on the
// houseguest's actual working life. One short clause per sector (the vocation noun is filled in by the
// secret template, so the clause stays job-shaped without repeating the noun).
const SECTOR_STAKE: Record<VocationSector, readonly string[]> = {
  trades: ["the body that does the work is starting to give out", "a job site injury they never fully reported", "a business they bankrolled on credit that is underwater"],
  healthcare: ["a patient outcome they still carry and tell no one about", "a license board complaint they buried", "the burnout they mask with relentless cheer"],
  service: ["a regular who knew them before all this and could talk", "tips skimmed in a desperate stretch they never made right", "a viral on-shift moment they are terrified resurfaces"],
  business: ["a deal that went sideways and took clients' money with it", "numbers they fudged that have not caught up to them yet", "a non-compete they are quietly violating by being here"],
  tech: ["code or data they took with them when they left", "an online life under another name no one connects to them", "a startup that imploded and the people it burned"],
  arts: ["a body of work that flopped publicly and privately gutted them", "a collaborator they cut out who is still owed", "a persona online that is nothing like who they really are"],
  education: ["a student or family situation that ended their last job", "a credential they overstated to get cast", "the quiet conviction that they peaked years ago"],
  publicService: ["a call that went wrong they have never talked through", "a disciplinary file they hope stays sealed", "the toll the work takes that they refuse to admit"],
  outdoors: ["land or a season's livelihood riding on this prize", "a remote stretch of their past nobody here can verify", "a partner back home holding it all together alone"],
  fitness: ["an injury or diagnosis that ends the career they perform", "clients or a gym they left in the lurch to be here", "a body image they police far harder than they let on"],
  curio: ["a stunt that went viral for the wrong reasons", "the gap between the bit they perform and a flat real life", "debts the novelty act never actually covered"],
  generic: ["money troubles the prize would quietly fix", "a chapter of their life they have edited out of the story", "people back home depending on this far more than they say"],
};

// Archetype-keyed strategic FRAME for a secret — the hidden shape that archetype's hidden life tends to
// take. Composed WITH the vocation stake so a villain-chef and a villain-firefighter read differently.
const ARCHETYPE_SECRET_FRAME: Record<Archetype, readonly string[]> = {
  "comp-beast": ["downplays just how badly they need to dominate every comp to feel safe", "is hiding that the physical edge is a front for deep insecurity about the social game"],
  "mastermind": ["has already mapped a final-two betrayal they will deny to the end", "is running a longer con than anyone suspects and keeps a private tally of it"],
  "social-butterfly": ["secretly cannot stand the houseguest they are publicly closest to", "trades on warmth they do not feel and is exhausted by the performance"],
  "floater": ["has a side they will commit to the instant the numbers reveal themselves", "is far more calculating than the go-along act lets the house believe"],
  "villain": ["enjoys the manipulation more than the win and hides how far they will go", "came in with a target they are pretending is a brand-new grudge"],
  "underdog": ["is playing to prove something to someone who wrote them off", "hides a sharper, more ruthless game under the sympathetic story"],
  "flirt": ["is using attraction as pure strategy and feels nothing they perform", "has a relationship on the outside the showmance would detonate"],
  "loyalist": ["made a pre-show pact they will honor even against their own game", "is secretly bracing to betray the one person they swore loyalty to"],
  "wildcard": ["plans the chaos that looks like impulse and hides the method in it", "is concealing how rattled the unpredictability actually leaves them"],
  "analyst": ["keeps a private read on every houseguest they would never admit to having", "is overthinking a fear of being exposed as all theory, no nerve"],
  "hothead": ["is one trigger from a blowup they have been told would sink them", "buries a temper that already cost them dearly outside the house"],
  "peacemaker": ["uses the mediator role to quietly control which way fights resolve", "resents always being the one who absorbs everyone else's drama"],
};

// Archetype-keyed TRUE goal (distinct from the public game), grounded by the archetype's drive. Composed
// with no vocation interpolation (a goal is strategic, not occupational) but still archetype-specific.
const ARCHETYPE_GOAL: Record<Archetype, readonly string[]> = {
  "comp-beast": ["win enough comps to never depend on anyone's loyalty", "be feared into a final two no one dares to evict"],
  "mastermind": ["steer every eviction from the shadows and reach the end uncredited", "build one secret two-person deal the house never sees coming"],
  "social-butterfly": ["be so universally liked the jury can't vote against them", "sit beside someone the jury clearly resents and coast to the win"],
  "floater": ["survive to the end by never being anyone's primary target", "let the loud rivals burn each other and inherit the house"],
  "villain": ["engineer a blindside big enough to make the house fear them", "control the game through pressure and dare anyone to take the shot"],
  "underdog": ["outlast everyone who counted them out and win it earned", "carry one ally as far as it goes, then make the cold cut clean"],
  "flirt": ["ride a showmance shield to the final stretch, then cut it loose", "use charm to get every secret in the house and trade them"],
  "loyalist": ["reach the end beside the person they trust most and let the jury decide", "play a clean, loyalty-first game the jury can respect"],
  "wildcard": ["blow the house up at the perfect moment and win in the wreckage", "be impossible to read until the numbers force the move"],
  "analyst": ["play the cleanest strategic game in the house and prove the theory", "stay invisible until the late game, then make every move the right one"],
  "hothead": ["win on raw will before the temper costs them the game", "channel the fire into comps and rattle everyone else into mistakes"],
  "peacemaker": ["broker the house into the shape that carries them to the end", "avoid blood on their hands and let others do every eviction"],
};

// Archetype-keyed WEAKNESS / blind spot — a behavioral seed the game exploits on a delay, grounded by
// the archetype's failure mode. Composed WITH a vocation-flavored tell so a comp-beast nurse and a
// comp-beast trucker fail a little differently.
const ARCHETYPE_WEAKNESS: Record<Archetype, readonly string[]> = {
  "comp-beast": ["leans on comp wins for safety long after laying low was the smarter play", "reads quiet social houseguests as non-threats until it is far too late"],
  "mastermind": ["plays several moves ahead of where the house actually is and gets caught alone", "trusts their own cleverness over a warm conversation that has earned nothing"],
  "social-butterfly": ["needs to be liked and folds the instant an alliance turns cold", "talks too much when nervous and leaks their own plans"],
  "floater": ["is so conflict-averse they let others make their decisions for them", "waits one beat too long to commit and lands on the wrong side"],
  "villain": ["lets a bruised ego drive decisions the moment they are challenged in public", "underestimates how fast a house unites against a known threat"],
  "underdog": ["gets attached fast and cannot play against the people they like", "lets the chip on their shoulder pick fights they cannot win"],
  "flirt": ["confuses a showmance's loyalty for a vote they have not actually secured", "is blindsided when the charm stops working on the right person"],
  "loyalist": ["is too loyal once committed and cannot cut anyone, even to survive", "honors a dead alliance long past the point it serves them"],
  "wildcard": ["chases the dramatic move over the smart one for the spotlight", "panics at the first sign of being on the wrong side of the house"],
  "analyst": ["overthinks a clear move until the window to make it closes", "freezes under direct social pressure and over-explains"],
  "hothead": ["holds grudges and lets revenge override the smart move", "erupts at exactly the moment composure would have saved them"],
  "peacemaker": ["avoids the hard cut so long that the house makes it for them", "absorbs everyone's conflict until they have no allies of their own"],
};

// An age-band tell — a short stake the secret/weakness can pick up so a 23-year-old and a 50-year-old of
// the same archetype/job still read differently. Kept generic-but-grounded (no stat vocab, no float).
const AGE_TELL: Record<AgeBand, readonly string[]> = {
  young: ["with everything to prove and no fallback if it goes wrong", "trying to outrun how new they still are at all of this"],
  established: ["with a real life on pause and the clock loud in their head", "knowing this is the one swing they get before responsibilities close in"],
  seasoned: ["treating this as the last shot to be seen the way they always wanted", "carrying years of being overlooked into every move they make"],
};

// #850 — how many DETERMINISTIC variants each rotatable component yields when resolving a cross-cast
// collision (the count of distinct values to walk through with NO rng). Each equals its pool's length so
// the rotation (offset 0..len-1, taken `% len` in build*) covers EVERY distinct value with no gaps:
// SECTOR_STAKE lists are 3 long; ARCHETYPE_* / AGE_TELL / GOAL_STAKE lists are 2. A secret thus has up to
// 3×2×2 = 12 no-rng variants and a goal/weakness 2×2 — far more than the cast-wide cap of 1 ever needs.
const STAKE_VARIANTS = 3;       // SECTOR_STAKE[sector].length
const FRAME_VARIANTS = 2;       // ARCHETYPE_SECRET_FRAME[archetype].length
const AGE_TELL_VARIANTS = 2;    // AGE_TELL[band].length
const GOAL_VARIANTS = 2;        // ARCHETYPE_GOAL[archetype].length
const GOAL_STAKE_VARIANTS = 2;  // GOAL_STAKE[band].length
const WEAK_CORE_VARIANTS = 2;   // ARCHETYPE_WEAKNESS[archetype].length

/**
 * Draw an INDEX into `pool` consuming the rng BYTE-IDENTICALLY to `rng.pick(pool)` (which is
 * `pool[rng.int(pool.length)]`). The `*Picks` phases use this so the split into index-pick + pure-build
 * leaves the rng stream exactly as the original inline `rng.pick(...)` composers did (#850 byte-identity).
 */
function pickIndex(rng: RandomnessSource, pool: readonly unknown[]): number {
  return rng.int(pool.length);
}

// #850 — the conditioned composers are split into a `*Picks` phase (consumes the rng in the EXACT
// same order/count as before, so byte-identity holds when nothing collides) and a pure `build*` phase
// (assembles the string from the chosen indices). The split exists so a cross-cast COLLISION can be
// resolved DETERMINISTICALLY — by rotating the component indices with NO further rng draw (the #853
// surname-dedup discipline) — instead of re-rolling. A non-colliding cast draws zero variants, so its
// composed text is byte-identical to before #850; only a (vanishingly rare) colliding cast diverges,
// which is the fix. All of this is on the ISOLATED narrative stream, so it cannot perturb any outcome.

type SecretPicks = { frameIx: number; stakeIx: number; firstShape: boolean; tellIx: number };

/** Consume the rng EXACTLY as the pre-#850 inline secret composer did (same picks, order, conditional tell). */
function secretPicks(rng: RandomnessSource, f: ConditioningFacets): SecretPicks {
  const frameIx = pickIndex(rng, ARCHETYPE_SECRET_FRAME[f.archetype]);
  const stakeIx = pickIndex(rng, SECTOR_STAKE[sectorOf(f.vocation)]);
  const firstShape = rng.next() < 0.5;
  // The age tell is drawn ONLY in the second shape — preserve that conditional draw exactly.
  const tellIx = firstShape ? 0 : pickIndex(rng, AGE_TELL[f.ageBand]);
  return { frameIx, stakeIx, firstShape, tellIx };
}

/** Pure: build the secret string from chosen indices (no rng). Indices are taken modulo each pool length. */
function buildSecret(p: SecretPicks, f: ConditioningFacets): string {
  const frames = ARCHETYPE_SECRET_FRAME[f.archetype];
  const stakes = SECTOR_STAKE[sectorOf(f.vocation)];
  const frame = frames[p.frameIx % frames.length]!;
  const stake = stakes[p.stakeIx % stakes.length]!;
  if (p.firstShape) return `behind the ${f.vocation} story, ${stake} — and ${frame}`;
  const tells = AGE_TELL[f.ageBand];
  const tell = tells[p.tellIx % tells.length]!;
  return `is a ${f.vocation} ${tell} who ${frame}, carrying ${stake}`;
}

/** The ordered, NO-RNG deterministic variants of one secret pick — rotate stake, then frame, then tell. */
function* secretVariants(base: SecretPicks): Generator<SecretPicks> {
  for (let tell = 0; tell < AGE_TELL_VARIANTS; tell++) {
    for (let frame = 0; frame < FRAME_VARIANTS; frame++) {
      for (let stake = 0; stake < STAKE_VARIANTS; stake++) {
        yield { ...base, stakeIx: base.stakeIx + stake, frameIx: base.frameIx + frame, tellIx: base.tellIx + tell };
      }
    }
  }
}

// A goal's personal STAKE — why THIS person wants the strategic outcome, grounded in their life-stage so
// two same-archetype houseguests' goals still diverge. Composed onto the archetype goal (never bare).
const GOAL_STAKE: Record<AgeBand, readonly string[]> = {
  young: ["to finally be taken seriously", "to prove the doubters back home wrong"],
  established: ["to make the years they put in mean something", "to give the people counting on them a reason to be proud"],
  seasoned: ["to be remembered as more than they were ever credited for", "to get the recognition a lifetime never quite handed them"],
};

type GoalPicks = { goalIx: number; stakeIx: number; firstShape: boolean };

/** Consume the rng EXACTLY as the pre-#850 inline goal composer did (both picks always drawn, then the branch). */
function goalPicks(rng: RandomnessSource, f: ConditioningFacets): GoalPicks {
  const goalIx = pickIndex(rng, ARCHETYPE_GOAL[f.archetype]);
  const stakeIx = pickIndex(rng, GOAL_STAKE[f.ageBand]);
  const firstShape = rng.next() < 0.5;
  return { goalIx, stakeIx, firstShape };
}

/** Pure: build the goal string from chosen indices (no rng). */
function buildGoal(p: GoalPicks, f: ConditioningFacets): string {
  const goals = ARCHETYPE_GOAL[f.archetype];
  const stakes = GOAL_STAKE[f.ageBand];
  const goal = goals[p.goalIx % goals.length]!;
  const stake = stakes[p.stakeIx % stakes.length]!;
  if (p.firstShape) return `${goal} — and walk back into the ${f.vocation} life ${stake}`;
  return `as a ${f.vocation}, ${stake}: ${goal}`;
}

/** The ordered, NO-RNG deterministic variants of one goal pick — rotate stake, then goal. */
function* goalVariants(base: GoalPicks): Generator<GoalPicks> {
  for (let goal = 0; goal < GOAL_VARIANTS; goal++) {
    for (let stake = 0; stake < GOAL_STAKE_VARIANTS; stake++) {
      yield { ...base, stakeIx: base.stakeIx + stake, goalIx: base.goalIx + goal };
    }
  }
}

type WeaknessPicks = { coreIx: number; tellIx: number; firstShape: boolean };

/** Consume the rng EXACTLY as the pre-#850 inline weakness composer did (both picks always drawn, then branch). */
function weaknessPicks(rng: RandomnessSource, f: ConditioningFacets): WeaknessPicks {
  const coreIx = pickIndex(rng, ARCHETYPE_WEAKNESS[f.archetype]);
  const tellIx = pickIndex(rng, AGE_TELL[f.ageBand]);
  const firstShape = rng.next() < 0.5;
  return { coreIx, tellIx, firstShape };
}

/** Pure: build the weakness string from chosen indices (no rng). */
function buildWeakness(p: WeaknessPicks, f: ConditioningFacets): string {
  const cores = ARCHETYPE_WEAKNESS[f.archetype];
  const tells = AGE_TELL[f.ageBand];
  const core = cores[p.coreIx % cores.length]!;
  const tell = tells[p.tellIx % tells.length]!;
  if (p.firstShape) return `${core} — a tell the ${f.vocation} in them never fully shook`;
  return `${core} — the ${f.vocation} ${tell}`;
}

/** The ordered, NO-RNG deterministic variants of one weakness pick — rotate core, then tell. */
function* weaknessVariants(base: WeaknessPicks): Generator<WeaknessPicks> {
  for (let tell = 0; tell < AGE_TELL_VARIANTS; tell++) {
    for (let core = 0; core < WEAK_CORE_VARIANTS; core++) {
      yield { ...base, coreIx: base.coreIx + core, tellIx: base.tellIx + tell };
    }
  }
}

/**
 * Mint a character-CONDITIONED hidden DeepProfile (the P1 coherence path). Every secret, the goal pair,
 * and the weakness are COMPOSED from this houseguest's own archetype/vocation/age — so the hidden life is
 * individual and coherent, not a shared-pool draw. Distinct within the profile (no two identical
 * secrets/goals). Player-independent + deterministic.
 *
 * RNG-ISOLATION (the #392 desync fix — the whole point of this function's two-stream split): the
 * conditioned narrative TEXT is the ONLY thing #392 changed, and it must change NOTHING about game
 * outcomes. The one hidden field that DOES feed outcomes is `dayOnePerception` — it seeds the move-in
 * NPC→player edge (trust/affinity/threat leans) — and the cast-wide perception selection depends on how
 * far the OUTCOME `rng` (the per-NPC `hidRng`) is advanced before the perception roll AND on the shared
 * cap fill. So this function keeps the two roles on SEPARATE streams:
 *   • `rng` (the OUTCOME stream): consumed in the EXACT pre-#392 sequence — `count` int, the legacy
 *     shared-pool draws (their TEXT discarded), then the perception draw — so the perception SELECTION
 *     and the cast-wide `caps` fill are BYTE-IDENTICAL to the old shared-pool floor. The move-in edges,
 *     and every downstream comp/vote/jury outcome, are therefore unchanged by this PR.
 *   • `narrativeRng` (the dedicated NARRATIVE stream): the conditioned, coherent hidden text — fully
 *     isolated, so however many draws the conditioning makes it CANNOT perturb the outcome stream.
 * Net effect: identical OUTCOMES to the old floor, with coherent character-conditioned hidden TEXT. The
 * Day-1 perception still comes from the net-zero-balanced PERCEPTION_POOL (anti-sycophancy: that balance
 * is the juryReach calibration gate).
 */
function generateConditionedDeepProfile(
  rng: RandomnessSource,
  narrativeRng: RandomnessSource,
  facets: ConditioningFacets,
  caps?: CastSpreadCaps,
): DeepProfile {
  // OUTCOME stream (`rng`): replay EXACTLY what the pre-#392 shared-pool floor consumed, so the
  // perception draw lands byte-identically (and the cast-wide perception cap fills as before). The
  // shared-pool TEXT drawn here is discarded — only the rng advancement + the cap fill matter; the
  // conditioned text below replaces it.
  const count = SECRET_RANGE.min + rng.int(SECRET_RANGE.max - SECRET_RANGE.min + 1); // 2..3
  let dayOnePerception: DayOnePerception;
  if (caps) {
    pickDistinctCapped(rng, SECRET_POOL, count, caps.secretUses, MAX_PER_SECRET);
    pickDistinctCapped(rng, TRUE_GOAL_POOL, 2, caps.goalUses, MAX_PER_GOAL);
    pickCapped(rng, WEAKNESS_POOL, caps.weaknessUses, MAX_PER_WEAKNESS);
    dayOnePerception = { ...pickPerceptionCapped(rng, caps.perceptionUses, MAX_PER_PERCEPTION) };
  } else {
    pickDistinct(rng, SECRET_POOL, count);
    pickDistinct(rng, TRUE_GOAL_POOL, 2);
    rng.pick(WEAKNESS_POOL);
    dayOnePerception = { ...PERCEPTION_POOL[rng.int(PERCEPTION_POOL.length)]! };
  }
  // NARRATIVE stream (`narrativeRng`): the conditioned, coherent hidden text — fully isolated from the
  // outcome stream, so its (variable) draw count never shifts a single game outcome. #850: the cast-wide
  // `caps.cond*Uses` tallies de-collide the composed text across the cast — resolved by the no-rng
  // deterministic variant walk, so a non-colliding cast is byte-identical to the pre-#850 floor.
  const secrets = composeDistinctCrossCast(
    narrativeRng, count,
    () => secretPicks(narrativeRng, facets), (p) => buildSecret(p, facets), secretVariants,
    caps?.condSecretUses,
  );
  const trueGoals = composeDistinctCrossCast(
    narrativeRng, 2,
    () => goalPicks(narrativeRng, facets), (p) => buildGoal(p, facets), goalVariants,
    caps?.condGoalUses,
  );
  const weakness = composeCappedCrossCast(
    narrativeRng,
    () => weaknessPicks(narrativeRng, facets), (p) => buildWeakness(p, facets), weaknessVariants,
    caps?.condWeaknessUses,
  );
  return { secrets, trueGoals, weakness, dayOnePerception };
}

// #850 — across the cast, a conditioned secret/goal/weakness string may be shared by at most this many
// houseguests (1 ⇒ verbatim-unique). The conditioning already makes a collision vanishingly rare; this
// is the belt that GUARANTEES it, resolved deterministically.
const MAX_PER_COND = 1;

/**
 * #850 — compose `n` values that are distinct WITHIN this profile AND cast-wide UNIQUE, the #853
 * discipline applied to the isolated narrative stream:
 *   • The base pick consumes the narrative rng EXACTLY as the inline composer did, so a slot with NO
 *     collision yields the base string with ZERO extra draws — byte-identical to the pre-#850 floor.
 *   • On a collision (within-profile OR cast-wide over its cap), we walk the DETERMINISTIC, NO-RNG
 *     component variants (`variants(base)`, which yields the base first) to the first free string. The
 *     narrative rng is therefore never advanced to resolve a collision — only the rare colliding cast's
 *     TEXT changes, and even then its rng stream is untouched (so sibling slots/NPCs stay byte-identical).
 *   • Relaxation (never spin): if every variant is taken, accept the base string anyway.
 * `used` is the cast-wide tally (e.g. `caps.condSecretUses`); pass `undefined` for within-profile-only
 * de-collision (a standalone profile with no cast context).
 */
function composeDistinctCrossCast<P>(
  narrativeRng: RandomnessSource,
  n: number,
  pick: () => P,
  build: (p: P) => string,
  variants: (base: P) => Generator<P>,
  used: Map<string, number> | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const free = (s: string): boolean => !seen.has(s) && (used ? (used.get(s) ?? 0) < MAX_PER_COND : true);
  for (let i = 0; i < n; i++) {
    const base = pick(); // consumes narrativeRng once — identical to the inline composer's draw
    let chosen: string | null = null;
    for (const cand of variants(base)) {       // first yield IS `base` ⇒ no-collision is byte-identical
      const s = build(cand);
      if (free(s)) { chosen = s; break; }
    }
    if (chosen === null) chosen = build(base);  // relaxation — never spin
    seen.add(chosen);
    if (used) used.set(chosen, (used.get(chosen) ?? 0) + 1);
    out.push(chosen);
  }
  return out;
}

/** #850 — compose ONE cast-wide-unique value (the single weakness), same deterministic discipline. */
function composeCappedCrossCast<P>(
  narrativeRng: RandomnessSource,
  pick: () => P,
  build: (p: P) => string,
  variants: (base: P) => Generator<P>,
  used: Map<string, number> | undefined,
): string {
  const base = pick();
  if (used) {
    for (const cand of variants(base)) {
      const s = build(cand);
      if ((used.get(s) ?? 0) < MAX_PER_COND) { used.set(s, (used.get(s) ?? 0) + 1); return s; }
    }
  }
  const s = build(base); // no caps (standalone) ⇒ byte-identical; or relaxation when every variant is taken
  if (used) used.set(s, (used.get(s) ?? 0) + 1);
  return s;
}

// Day-1 reads of the player + their signed leans for the NPC→player edge (never shown).
// BALANCED to net-zero on every axis (∑trust ≈ ∑affinity ≈ ∑threat ≈ 0) — the perception adds
// TEXTURE (some NPCs walk in warm, some wary), never a SYSTEMATIC tilt: a net-positive affinity/trust
// would quietly hand a passive player a friendlier jury and break the "finale wins must be earned"
// calibration gate (juryReach.property). Realistic too — a real cast doesn't uniformly like a stranger.
const PERCEPTION_POOL: ReadonlyArray<DayOnePerception> = [
  { read: "friendly, harmless, and socially useful — not a threat yet", trustLean: 0.3, affinityLean: 0.4, threatLean: -0.2 },
  { read: "warm and genuine beneath the surface — a possible ally", trustLean: 0.4, affinityLean: 0.5, threatLean: -0.1 },
  { read: "a fellow observer who sees too much — to be watched", trustLean: -0.2, affinityLean: 0.0, threatLean: 0.4 },
  { read: "rubbed them the wrong way on day one — wary and cool", trustLean: -0.4, affinityLean: -0.4, threatLean: 0.2 },
  { read: "guarded and hard to read — kept at arm's length", trustLean: -0.3, affinityLean: -0.3, threatLean: 0.1 },
  { read: "a likable rival who will have to go eventually", trustLean: 0.1, affinityLean: 0.2, threatLean: 0.4 },
  { read: "an unknown quantity worth a careful early read", trustLean: 0.0, affinityLean: 0.0, threatLean: 0.0 },
  { read: "cordial but kept at a polite distance — not close", trustLean: 0.0, affinityLean: -0.4, threatLean: -0.4 },
  { read: "easy to overlook — barely on the radar yet", trustLean: 0.0, affinityLean: 0.0, threatLean: -0.4 },
];

/**
 * #854 — every TEMPLATE/POOL STRING the deep-profile composer can interpolate, flattened for the
 * regression sweep. The hazard: a pool string carrying a bare GAME-ROLE id-token word ("player",
 * "hoh", "nominee", …) is mangled when this hidden text is unsealed for the 0048 retrospective and run
 * through `humanizeForRetrospective` → `humanizeIds`, whose whole-token pass replaces a standalone
 * `player` token with the PLAYER'S NAME (the live repro shape: "outlast every <PlayerName> who counted
 * them out"). The A8 boundary protects "players" (a word char follows) but NOT a bare "player". This
 * aggregator lets the test assert NO pool string contains such a bare token, exhaustively — the
 * generated-text sweep alone could miss a rarely-drawn string. Test-facing; not a runtime input.
 */
export const ALL_DEEP_PROFILE_POOL_STRINGS: readonly string[] = [
  ...SECRET_POOL,
  ...TRUE_GOAL_POOL,
  ...WEAKNESS_POOL,
  ...Object.values(ARCHETYPE_SECRET_FRAME).flat(),
  ...Object.values(ARCHETYPE_GOAL).flat(),
  ...Object.values(ARCHETYPE_WEAKNESS).flat(),
  ...Object.values(SECTOR_STAKE).flat(),
  ...Object.values(AGE_TELL).flat(),
  ...Object.values(GOAL_STAKE).flat(),
  ...PERCEPTION_POOL.map((p) => p.read),
];

/** How many secrets each NPC carries (the §3 "2–3 secrets"). */
export const SECRET_RANGE = { min: 2, max: 3 } as const;

// L41 — cast-wide SPREAD CAPS: across the 15-cast, no secret/goal/weakness/Day-1-read may be shared by
// more than this many houseguests. Sized so the pools comfortably satisfy a 15-cast (the relaxation
// path is unreachable in practice but never spins). The same discipline as L28's MAX_PER_BUILD.
export const MAX_PER_SECRET = 2;
export const MAX_PER_GOAL = 3;
export const MAX_PER_WEAKNESS = 2;
export const MAX_PER_PERCEPTION = 3;

/**
 * The mutable usage tallies that enforce the L41 cast-wide spread caps as `generateCastDeepLayer` deals
 * one NPC at a time. Keyed by the drawn string (the perception by its `read`). Pass the SAME object to
 * every NPC's `generateDeepProfile` so a trope used to its cap is no longer offered to later NPCs.
 *
 * The `secret/goal/weakness/perceptionUses` maps tally the LEGACY shared-pool draws (the outcome stream).
 * #850: the `cond*Uses` maps tally the CONDITIONED narrative TEXT cast-wide so two houseguests never share
 * a verbatim composed secret/goal/weakness — resolved DETERMINISTICALLY (no rng) when a collision occurs,
 * on the isolated narrative stream. Keyed by the composed string.
 */
export interface CastSpreadCaps {
  secretUses: Map<string, number>;
  goalUses: Map<string, number>;
  weaknessUses: Map<string, number>;
  perceptionUses: Map<string, number>;
  /** #850 — cast-wide tally of the CONDITIONED composed secret/goal/weakness strings (cross-cast de-collision). */
  condSecretUses: Map<string, number>;
  condGoalUses: Map<string, number>;
  condWeaknessUses: Map<string, number>;
}

export function newCastSpreadCaps(): CastSpreadCaps {
  return {
    secretUses: new Map(), goalUses: new Map(), weaknessUses: new Map(), perceptionUses: new Map(),
    condSecretUses: new Map(), condGoalUses: new Map(), condWeaknessUses: new Map(),
  };
}

/** The character facets the conditioned generator reads (a slice of the byte-stable static Character). */
export type DeepProfileCharacter = Pick<Character, "archetype" | "vocation" | "age">;

/**
 * Mint the full HIDDEN deep profile for one houseguest off a SIDE rng, so the main house stream stays
 * byte-stable. ENGINE-ONLY by construction — the caller seals it into the Vault and never projects it.
 * Deterministic per seed + player-independent (the rng is keyed off the NPC's player-independent name,
 * and the conditioning reads only the NPC's OWN Character — never the player).
 *
 * THE P1 COHERENCE FIX: when a `character` is supplied (the live + cast-wide path), the secrets / true
 * goals / weakness are COMPOSED from that houseguest's own archetype/vocation/age — an individual,
 * coherent hidden life rather than a flat shared-pool draw (which read as a templated, cast-repeating
 * grab-bag). Because the cast carries diverse vocations and the templates interpolate the concrete
 * vocation, two NPCs almost never share a verbatim premise (no shared-pool collision is even possible).
 *
 * Back-compat: with NO `character`, it falls to the legacy shared-pool draw (the bare-rng generators the
 * scheduler/standalone tests still exercise). When `caps` is supplied that legacy path honors the L41
 * spread caps; the conditioned path needs no secret/goal/weakness caps (the conditioning makes verbatim
 * collisions vanishingly rare) but still caps the small Day-1 PERCEPTION pool through `caps.perceptionUses`.
 *
 * RNG-ISOLATION (#392): on the conditioned path the OUTCOME-relevant `dayOnePerception` is still drawn
 * off `rng` byte-identically to the legacy floor (so the move-in NPC→player edge is unchanged), while the
 * narrative TEXT is composed off a DEDICATED sub-stream — derived from `narrativeSeed` when the caller
 * supplies a per-NPC key (the cast-wide/live path), else forked off the facets so a standalone call stays
 * deterministic. See {@link generateConditionedDeepProfile}.
 */
export function generateDeepProfile(
  rng: RandomnessSource,
  caps?: CastSpreadCaps,
  character?: DeepProfileCharacter,
  narrativeSeed?: number,
): DeepProfile {
  // The P1 path: compose from the individual character (coherent, unique). Falls back to the shared
  // pool only when the vocation is unknown (pre-L28 saves) — the conditioning needs a concrete vocation.
  if (character && character.vocation) {
    const facets = { archetype: character.archetype, vocation: character.vocation, ageBand: ageBandOf(character.age) };
    // The dedicated NARRATIVE sub-stream — ISOLATED from the outcome `rng` so its (variable) draw count
    // can never perturb the game stream. Keyed off the caller's per-NPC `narrativeSeed` (the cast path),
    // or forked deterministically off the character facets for a standalone call. Player-independent.
    const narrativeRng = new SeededRandom(
      hashSeed(`deep-narrative:${narrativeSeed ?? `${facets.archetype}:${facets.vocation}:${facets.ageBand}`}`),
    );
    return generateConditionedDeepProfile(rng, narrativeRng, facets, caps);
  }
  const count = SECRET_RANGE.min + rng.int(SECRET_RANGE.max - SECRET_RANGE.min + 1); // 2..3
  if (caps) {
    const secrets = pickDistinctCapped(rng, SECRET_POOL, count, caps.secretUses, MAX_PER_SECRET);
    const trueGoals = pickDistinctCapped(rng, TRUE_GOAL_POOL, 2, caps.goalUses, MAX_PER_GOAL);
    const weakness = pickCapped(rng, WEAKNESS_POOL, caps.weaknessUses, MAX_PER_WEAKNESS);
    const p = pickPerceptionCapped(rng, caps.perceptionUses, MAX_PER_PERCEPTION);
    return { secrets, trueGoals, weakness, dayOnePerception: { ...p } };
  }
  const secrets = pickDistinct(rng, SECRET_POOL, count);
  const trueGoals = pickDistinct(rng, TRUE_GOAL_POOL, 2);
  const weakness = rng.pick(WEAKNESS_POOL);
  const p = PERCEPTION_POOL[rng.int(PERCEPTION_POOL.length)]!;
  return { secrets, trueGoals, weakness, dayOnePerception: { ...p } };
}

function pickDistinct(rng: RandomnessSource, pool: readonly string[], n: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let guard = 0; out.length < n && guard < 200; guard++) {
    const v = rng.pick(pool);
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

/** Draw one value honoring the cast-wide cap; relaxes the cap rather than spinning if it can't be met. */
function pickCapped(rng: RandomnessSource, pool: readonly string[], uses: Map<string, number>, maxEach: number): string {
  for (let g = 0; g < 400; g++) {
    const v = rng.pick(pool);
    if ((uses.get(v) ?? 0) < maxEach) { uses.set(v, (uses.get(v) ?? 0) + 1); return v; }
  }
  const v = rng.pick(pool);
  uses.set(v, (uses.get(v) ?? 0) + 1);
  return v;
}

/** Pick `n` values distinct WITHIN this profile AND honoring the cast-wide cap; relaxes if it must. */
function pickDistinctCapped(rng: RandomnessSource, pool: readonly string[], n: number, uses: Map<string, number>, maxEach: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let guard = 0; out.length < n && guard < 400; guard++) {
    const v = rng.pick(pool);
    if (seen.has(v) || (uses.get(v) ?? 0) >= maxEach) continue;
    seen.add(v); uses.set(v, (uses.get(v) ?? 0) + 1); out.push(v);
  }
  // Relaxation: if the cap-and-distinct constraint could not fill, take distinct-only (never spin).
  for (let guard = 0; out.length < n && guard < 400; guard++) {
    const v = rng.pick(pool);
    if (seen.has(v)) continue;
    seen.add(v); uses.set(v, (uses.get(v) ?? 0) + 1); out.push(v);
  }
  return out;
}

/** Perception is an object pool; cap by its `read`. Keeps the pool's net-zero balance (contents fixed). */
function pickPerceptionCapped(rng: RandomnessSource, uses: Map<string, number>, maxEach: number): DayOnePerception {
  for (let g = 0; g < 400; g++) {
    const p = PERCEPTION_POOL[rng.int(PERCEPTION_POOL.length)]!;
    if ((uses.get(p.read) ?? 0) < maxEach) { uses.set(p.read, (uses.get(p.read) ?? 0) + 1); return p; }
  }
  const p = PERCEPTION_POOL[rng.int(PERCEPTION_POOL.length)]!;
  uses.set(p.read, (uses.get(p.read) ?? 0) + 1);
  return p;
}

// ── Story-thread derivation (0058 §5 / 0060 §3) ───────────────────────────────────────────────────
/** A surfacing pathway is always one of the in-game channels (0002) — never exposition. */
const PATHWAYS = ["witnessed", "told-by-confidant", "overheard", "gossip-diffused"] as const;

/** The thread's SOURCE class — which half of the deep profile minted it (0060 §3 condition mapping). */
export type ThreadSourceClass = "secret" | "weakness" | "goal";

// 0060 §3 — each source class maps to a small set of structured conditions; the prose `trigger` lines
// map cleanly onto these. The scheduler picks one deterministically off the same side rng, so the
// choice is seed-stable and agrees in spirit with the prose line.
const CONDITIONS_BY_CLASS: Record<ThreadSourceClass, readonly TriggerCondition[]> = {
  secret: ["on-block", "cornered-socially", "nominated-twice"],
  weakness: ["cornered-socially", "goal-demands-move"],
  goal: ["house-tightens", "goal-demands-move"],
};

/**
 * 0060 §3 back-compat: the default structured condition for a thread that has none (a pre-0060 save, or
 * a thread whose class can't be re-derived). Inferred from the thread's `premise` prefix (`secret —` /
 * `weakness —` / `true goal —`), so the re-derive on restore is idempotent and seed-free. Deterministic
 * (no rng): a fixed representative per class — the FIRST of that class's list.
 */
export function defaultTriggerConditionFor(thread: Pick<StoryThread, "premise">): TriggerCondition {
  const cls: ThreadSourceClass = thread.premise.startsWith("weakness")
    ? "weakness"
    : thread.premise.startsWith("true goal")
      ? "goal"
      : "secret";
  return CONDITIONS_BY_CLASS[cls][0]!;
}

/**
 * Derive the hidden story threads from one NPC's deep profile (0058 §5). Each secret, the weakness,
 * and the first true goal becomes a `dormant` thread with a prose trigger, a STRUCTURED `triggerCondition`
 * (0060 §3), in-game surfacing pathways, and the hidden-weight interaction it folds on activation.
 * Deterministic per seed.
 */
export function deriveStoryThreads(rng: RandomnessSource, sourceId: EntityId, profile: DeepProfile): StoryThread[] {
  const threads: StoryThread[] = [];
  let n = 0;
  const path = (): string[] => [PATHWAYS[rng.int(PATHWAYS.length)]!];
  const condFor = (cls: ThreadSourceClass): TriggerCondition => {
    const pool = CONDITIONS_BY_CLASS[cls];
    return pool[rng.int(pool.length)]!;
  };
  for (const secret of profile.secrets) {
    threads.push({
      id: `thread:${sourceId}:${n++}`,
      sourceId,
      premise: `secret — ${secret}`,
      trigger: "activates when this houseguest is genuinely threatened on the block or cornered socially",
      triggerCondition: condFor("secret"),
      surfacingPathways: path(),
      weightImpact: rng.next() < 0.5 ? "conflict" : "betrayal",
      status: "dormant",
      lifecycleWeek: 0,
    });
  }
  threads.push({
    id: `thread:${sourceId}:${n++}`,
    sourceId,
    premise: `weakness — ${profile.weakness}`,
    trigger: "fires when the game presents the exact situation this blind spot mishandles",
    triggerCondition: condFor("weakness"),
    surfacingPathways: path(),
    weightImpact: "strategy",
    status: "dormant",
    lifecycleWeek: 0,
  });
  if (profile.trueGoals[0]) {
    threads.push({
      id: `thread:${sourceId}:${n++}`,
      sourceId,
      premise: `true goal — ${profile.trueGoals[0]}`,
      trigger: "escalates as the house tightens and this goal demands a visible move",
      triggerCondition: condFor("goal"),
      surfacingPathways: path(),
      weightImpact: "alliance",
      status: "dormant",
      lifecycleWeek: 0,
    });
  }
  return threads;
}

/**
 * The deterministic, engine-only DEEP layer for the whole cast (Phase 1 floor + offline fallback).
 * Built off the cast's drawn names + seed, so it is seed-stable and player-INDEPENDENT (the names are).
 * Returns, per NPC id: the PUBLIC depth facets (to fold onto the public Character) and the HIDDEN
 * profile + threads (to seal into the Vault). The caller owns the split across the wall.
 */
export interface CastDeepLayer {
  public: Record<EntityId, PublicDepth>;
  hidden: Record<EntityId, DeepProfile>;
  threads: StoryThread[];
}

export function generateCastDeepLayer(seed: number, npcs: readonly Houseguest[]): CastDeepLayer {
  const pub: Record<EntityId, PublicDepth> = {};
  const hidden: Record<EntityId, DeepProfile> = {};
  const threads: StoryThread[] = [];
  // The Day-1 PERCEPTION pool is small, so it still rides the L41 cast-wide cap tally (the secrets/goals/
  // weakness are now CHARACTER-CONDITIONED — composed from each NPC's own archetype/vocation/age — so a
  // verbatim cross-cast collision is vanishingly rare without a cap). Deterministic: the cast iteration
  // order is seed-stable; the conditioning reads only the NPC's OWN Character, so the layer stays
  // player-INDEPENDENT.
  const caps = newCastSpreadCaps();
  // #533: deal the salient look axes (hair/facial/style) CAST-WIDE with spread caps off a dedicated
  // side rng, indexed positionally with the seed-stable cast iteration — so no value piles up across
  // the 15-cast (the repetitive-cast bug), the same L28 discipline skinTone/build/ethnicity already use.
  const physicalSpread = dealCastPhysicalSpread(
    new SeededRandom(hashSeed(`${seed}:deep-physical-spread`)), npcs.length, npcs.map((n) => n.character.presentation),
    npcs.map((n) => n.character.age),
    // ORW-381: the build band leans to the hidden physical stat, picked here (engine-side, creation only) off
    // its own `${seed}:build-band` stream; only the build WORDS reach the public facet.
    dealBuildBands(new SeededRandom(hashSeed(`${seed}:build-band`)), npcs.map((n) => n.character.stats.physical)),
    npcs.map((n) => n.character.genderPresentation), npcs.map((n) => n.character.ethnicity), // ORW-480: the cut follows gender and heritage
  );
  // ORW-381: one casting type per houseguest off its OWN side stream (no existing stream moves), by age only.
  const castingTypes = dealCastingTypes(
    new SeededRandom(hashSeed(`${seed}:casting-type`)), npcs.length, npcs.map((n) => n.character.age),
    // ORW-432: the type is dealt AFTER archetype, strategy style and demeanor exist (the factory sets them first),
    // from the types compatible with them. All three are public card fields; no stat is read here.
    npcs.map((n) => ({ archetype: n.character.archetype, strategyStyle: n.character.strategyStyle, demeanor: n.character.demeanor, genderPresentation: n.character.genderPresentation })), // ORW-467: the type's gender lean and label variant
  );
  let ix = 0;
  for (const hg of npcs) {
    const pubRng = new SeededRandom(hashSeed(`${seed}:deep-public:${hg.name}`));
    const hidRng = new SeededRandom(hashSeed(`${seed}:deep-hidden:${hg.name}`));
    const thrRng = new SeededRandom(hashSeed(`${seed}:deep-thread:${hg.name}`));
    pub[hg.id] = {
      biography: generateBiography(pubRng, hg.character),
      physicalCharacteristics: generatePhysicalCharacteristics(pubRng, hg.character.age, physicalSpread[ix]),
      castingType: castingTypes[ix++]!,
    };
    // The narrative TEXT rides a DEDICATED per-NPC sub-stream (#392 RNG-isolation): the conditioned
    // secrets/goals/weakness draw off this key, NEVER `hidRng` — so the outcome-relevant `dayOnePerception`
    // (drawn off `hidRng`) and the cast-wide cap fill stay byte-identical to the pre-#392 floor, while the
    // hidden text is per-NPC unique and player-independent (keyed off the seeded name, never the player).
    const narrativeSeed = hashSeed(`${seed}:deep-narrative:${hg.name}`);
    const profile = generateDeepProfile(hidRng, caps, hg.character, narrativeSeed);
    hidden[hg.id] = profile;
    threads.push(...deriveStoryThreads(thrRng, hg.id, profile));
  }
  return { public: pub, hidden, threads };
}

// ── Vault sealing helpers (Phase 1: seed, seal, persist) ──────────────────────────────────────────
// Sealed under EXISTING HiddenKind values so the Vault store needs no schema change (the §3 hidden
// profile is a structured hidden attribute; a story thread is a hidden thread).
export const DEEP_PROFILE_KIND = "hidden-attribute" as const;
export const STORY_THREAD_KIND = "hidden-thread" as const;

/** Stable Vault id for one NPC's sealed deep profile (idempotent re-seal on restore). */
export function deepProfileVaultId(sourceId: EntityId): string {
  return `deep-profile:${sourceId}`;
}

/**
 * Serialize a hidden DeepProfile to ONE Vault record content string (engine-only — never projected).
 * The content embeds every secret/goal/weakness/perception so full-fidelity recall (L27b) can read it
 * back. Deterministic, so re-sealing on restore is idempotent.
 */
export function deepProfileToVaultContent(sourceId: EntityId, profile: DeepProfile): string {
  return [
    `deep-profile ${sourceId}`,
    `secrets: ${profile.secrets.join(" | ")}`,
    `true-goals: ${profile.trueGoals.join(" | ")}`,
    `weakness: ${profile.weakness}`,
    `day-1 read of player: ${profile.dayOnePerception.read}`,
  ].join("\n");
}

/** Serialize a story thread to ONE Vault record content string (engine-only). */
export function storyThreadToVaultContent(t: StoryThread): string {
  return [
    `story-thread ${t.id} [${t.status}]`,
    `premise: ${t.premise}`,
    `trigger: ${t.trigger}` + (t.triggerCondition ? ` (${t.triggerCondition})` : ""),
    `surfaces via: ${t.surfacingPathways.join(", ")}`,
  ].join("\n");
}

// ── Post-season retrospective rendering (0048 — the Wall's ONE sanctioned reveal) ──────────────────
// `storyThreadToVaultContent` above is the engine-only AUDIT serialization (machine ids + slugs — fine,
// the Vault is engine-only). It is NOT player-readable, so the 0048 retrospective must NOT show it raw
// (the live repro: "[hidden-thread] story-thread thread:npc:8:0 [dormant] premise: secret — …"). These
// helpers render the SAME thread as plain, name-resolved prose for that post-season unsealing — the
// machine thread id (`thread:npc:N:M`) is dropped entirely (its `npc:N` is resolved to the source's
// NAME), the status / trigger-condition / surfacing-pathway slugs become readable clauses, and the
// premise's `secret —`/`weakness —`/`true goal —` tag becomes a natural lead. Pure / Vault-free.

/** A thread's lifecycle status as a readable post-season clause (or "" for the live `active` middle). */
function threadStatusClause(status: ThreadStatus): string {
  switch (status) {
    case "dormant":
      return "never surfaced";
    case "active":
      return "in play but never broke into the open";
    case "surfaced":
      return "broke into the open";
    case "resolved":
      return "played out";
    case "expired":
      return "passed without ever landing";
    default:
      return "";
  }
}

/** Turn the premise tag (`secret — …` / `weakness — …` / `true goal — …`) into a natural lead. */
function premiseLead(premise: string): string {
  const m = /^(secret|weakness|true goal)\s*—\s*(.*)$/s.exec(premise);
  if (!m) return premise.trim();
  const body = m[2]!.trim();
  // The premise bodies are authored as bare predicates ("is hiding …", "talks too much …", "protect …"),
  // so the lead doubles as the sentence subject's continuation (the source NAME is prepended by the
  // caller): "<Name> — Secretly was hiding …".
  switch (m[1]) {
    case "secret":
      return `Secretly ${body}`;
    case "weakness":
      return `Their blind spot — ${body}`;
    case "true goal":
      return `Their real game — ${body}`;
    default:
      return body;
  }
}

/**
 * Render ONE hidden story thread as readable post-season prose, the source id resolved to a name via
 * `nameOf` (a public roster fact). Contains ZERO raw `npc:N` / `thread:` token by construction — the
 * machine id is never interpolated; only the resolved source NAME and translated clauses are. The
 * premise text (the good part) is preserved verbatim after its tag is naturalized.
 */
export function storyThreadToRetrospectiveProse(t: StoryThread, nameOf: (id: EntityId) => string): string {
  const name = nameOf(t.sourceId);
  const lead = premiseLead(t.premise);
  const status = threadStatusClause(t.status);
  const tail = status ? ` (${status})` : "";
  return `${name} — ${lead}${tail}`;
}

// ── 0060 — the scheduler's PURE support (the season-position predicates + the Vault-safe paraphrase) ─
// All of this is engine-only and Vault-free BY CONSTRUCTION: the predicates read only PUBLIC position
// facts, and the paraphrase is a vague atmospheric gloss keyed by SOURCE CLASS — it never touches the
// thread premise/trigger string, so the §7 leak-sweep stays strict about exact secret text. The
// orchestration (which thread, which roll) lives in `GameSessionAdapter.scheduleStoryThreads`.

/**
 * A Vault-FREE snapshot of the live season position the scheduler evaluates a thread's `triggerCondition`
 * against (0060 §3). Every field is a PUBLIC/engine-internal POSITION fact (who's nominated, the week,
 * the living-cast size, who holds power, the engine's own relationship reads) — never a thread premise.
 * A predicate is a gate on when the world is RIPE, never a content channel.
 */
export interface SeasonPosition {
  /** The current week (1-based once the game is live). */
  week: number;
  /** Living-cast count (player + non-evicted NPCs). */
  livingCount: number;
  /** Currently nominated houseguests. */
  nominees: ReadonlySet<EntityId>;
  /** The current power holders this week (HOH and/or veto holder). */
  powerHolders: ReadonlySet<EntityId>;
  /** Sources whose bond standing is in the bottom quantile of the living house (THREAD.corneredBottomQuantile). */
  cornered: ReadonlySet<EntityId>;
  /** Sources who have been on the block in ≥ THREAD.nominatedWeeksForRivalry distinct weeks. */
  nominatedRepeatedly: ReadonlySet<EntityId>;
  /** Whether the source has been evicted (its trigger window is closed — drives expiry). */
  evicted: ReadonlySet<EntityId>;
}

/**
 * Is a thread's STRUCTURED trigger condition met by the live season position (0060 §3)? Pure; reads only
 * the Vault-free `SeasonPosition`. A thread with no structured condition (pre-0060) is treated as its
 * class default before this is called (the adapter back-fills on restore), so `condition` is required.
 */
export function triggerMet(thread: StoryThread, pos: SeasonPosition): boolean {
  const cond = thread.triggerCondition ?? defaultTriggerConditionFor(thread);
  const src = thread.sourceId;
  switch (cond) {
    case "on-block":
      return pos.nominees.has(src);
    case "nominated-twice":
      return pos.nominatedRepeatedly.has(src);
    case "cornered-socially":
      return pos.cornered.has(src);
    case "house-tightens":
      return pos.livingCount <= THREAD.tightenCastSize;
    case "goal-demands-move":
      return pos.powerHolders.has(src);
    default:
      return false;
  }
}

/** Has a thread's source left the game (its trigger window is closed — drives the 0060 §4.4 expiry)? */
export function sourceWindowClosed(thread: StoryThread, pos: SeasonPosition): boolean {
  return pos.evicted.has(thread.sourceId);
}

// The vague atmospheric gloss a surfacing thread becomes (0060 §4.2 / §7) — keyed by SOURCE CLASS, NEVER
// the premise. This is the thread analogue of gossip's `RUMOR_GLOSS`: a belief-level paraphrase that
// shapes atmosphere, not a fact-on-a-projection and not an exposition line. No secret/trigger text here.
const THREAD_GLOSS: Record<ThreadSourceClass, string> = {
  secret: "is carrying something they're not telling anyone",
  weakness: "has a blind spot the house could play on",
  goal: "is quietly playing a bigger game than they let on",
};

function threadSourceClass(thread: Pick<StoryThread, "premise">): ThreadSourceClass {
  return thread.premise.startsWith("weakness")
    ? "weakness"
    : thread.premise.startsWith("true goal")
      ? "goal"
      : "secret";
}

/**
 * The vague paraphrase a surfacing thread gives rise to (0060 §4.2): a belief about the SOURCE keyed by
 * the thread's class — NEVER the verbatim premise/trigger, so the 0031/0060 §7 leak sweep can stay
 * strict about exact secret strings. `name` is the public name of the source (a public fact). The
 * result reads like a rumor a houseguest could hold with source + confidence.
 */
export function threadRumor(thread: StoryThread, name: string): string {
  return `there's a feeling around the house that ${name} ${THREAD_GLOSS[threadSourceClass(thread)]}`;
}
