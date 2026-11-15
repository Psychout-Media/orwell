import type { RandomnessSource } from "../ports/RandomnessSource";
import type { EntityId } from "../domain/ids";
import type { Houseguest } from "./characterFactory";

/**
 * Hidden seeded relationships (feature 0059) — pre-game ties (L35) + showmances (L40).
 *
 * A real season carries a few relationships the cameras don't explain on day one: two houseguests who
 * KNEW each other before the show, and one or two genuine showmances that develop over weeks. This
 * module seeds a SMALL, hidden layer of those at cast time. Like the reserve twists (0025) — whose
 * governance this inherits verbatim — the choices are Vault content (engine-only): this module only
 * COMPUTES them, never surfaces them.
 *
 *  1. Vault-sealed from the player AND the admin (the caller seals; nothing here projects).
 *  2. SPARSE — 0–2 ties + 0–2 showmances per season, each slot only ~50% loaded (often none). This
 *     sparseness is the direct fix for L40's "everyone romanced everyone" saturation.
 *  3. Non-structural — a tie is a small standing affinity BIAS the caller folds between the pair, never
 *     a deterministic edge that overrides legitimate play or a hard rule (0005).
 *  4. Organic surfacing only — discovered through in-game pathways (0002), never exposition.
 *
 * PURE + seed-deterministic, player-INDEPENDENT (keys off the cast names): same seed ⇒ same layer.
 */

/**
 * Why two houseguests already know each other (flavor only — never a deterministic advantage). `prior-romance` is a
 * pre-show romantic SPARK or fling (owner casting-craft upgrade — lets a romance nucleus seed); it was named `showmance`
 * until #1909, which collided with the in-house `Showmance` ARC (`spark → bond → visible → resolved`), so the arc keeps the
 * word and the preexisting-romance NATURE got its own (`LEGACY_TIE_NATURE_ALIASES` maps old saves/prompts). The hidden game
 * weight/magnitude of any tie stays engine-seeded (Vault Wall) and is IDENTICAL for every nature (see `TIE_AFFINITY_BIAS`) —
 * the nature is only the PUBLIC texture, so no nature is a competition or vote input. PO ruling 2026-11-03 (#1909): family
 * (siblings/cousins), exes, old friends and rivals/bad blood are all allowed, plus a few more plausible-for-a-BB-cast ones.
 */
export type TieNature =
  | "casting-callback" | "mutual-friend" | "shared-hometown" | "old-acquaintance" | "prior-romance"
  | "family" | "ex" | "old-friend" | "rival" | "former-teammate" | "online-acquaintance";
/** A showmance's arc, advancing only as the live relationship genuinely develops (never instant). */
export type ShowmanceStage = "spark" | "bond" | "visible" | "resolved";

/**
 * Feature 0095 — a pre-game tie's EXPOSURE state (the only new sealed state this feature adds; see
 * `docs/features/0095-pre-show-ties-reveal.md`). `sealed` (the 0059 default, invisible to player AND
 * admin) → `surfaced-to-house` (a pathway has carried it to SOME houseguests; it may have reached the
 * player as a low-confidence rumor) → `public` (a settled house fact — the narrator may now name the
 * pair openly, exactly like a `visible` showmance). Monotonic — never regresses on restore or re-derive.
 */
export type TieExposure = "sealed" | "surfaced-to-house" | "public";

/** ORW-132 - whether a tie starts SECRET (sealed, spreads only by the normal rules) or PUBLIC (a house fact from Day 1). Decided once at season start. Absent on a pre-ORW-132 save => treated as `secret`. */
export type TieVisibility = "secret" | "public";

export interface PreGameTie {
  a: EntityId;
  b: EntityId;
  nature: TieNature;
  /** ORW-132 - the visibility mark decided at season start (see `markTieVisibility`). */
  visibility?: TieVisibility;
  /** 0095 — absent (⇒ `sealed`) on a pre-0095 save; use `tieExposureOf` to read it defensively. */
  exposure?: TieExposure;
}

/** Read a tie's exposure, defaulting a pre-0095 (or freshly-seeded) tie to `sealed`. */
export function tieExposureOf(t: Pick<PreGameTie, "exposure">): TieExposure {
  return t.exposure ?? "sealed";
}

/**
 * 0095 — promote a tie's exposure ONE step for a firing pathway event, never regressing. An `accusation`
 * that lands is a witnessed, public confrontation — it jumps straight to `public` regardless of the
 * current state (mirrors a real "wait, you two DO know each other?!" room reaction). An `overhear`/`slip`
 * pathway (off-screen, NPC↔NPC) promotes one step at a time: `sealed` → `surfaced-to-house` on the first
 * spark, `surfaced-to-house` → `public` on a SECOND real spark (sustained spread, never a single tell).
 * Pure; `"none"` (or an already-`public` tie) is a no-op.
 */
export function nextTieExposure(current: TieExposure, event: "none" | "overhear" | "slip" | "accusation"): TieExposure {
  if (current === "public" || event === "none") return current;
  if (event === "accusation") return "public";
  if (current === "sealed") return "surfaced-to-house";
  return "public"; // already surfaced-to-house ⇒ a second spark goes public
}
export interface Showmance {
  a: EntityId;
  b: EntityId;
  /** Seeded at `spark`; the deferred scheduler advances it as mutual affinity is sustained over weeks. */
  stage: ShowmanceStage;
}
export interface SeededRelationships {
  ties: PreGameTie[];
  showmances: Showmance[];
}

export const TIE_NATURES: readonly TieNature[] = [
  "casting-callback", "mutual-friend", "shared-hometown", "old-acquaintance", "prior-romance",
  "family", "ex", "old-friend", "rival", "former-teammate", "online-acquaintance",
];

/** Pre-#1909 spellings of a tie nature → today's (persisted saves, earlier cast-genesis prompts/outputs). */
export const LEGACY_TIE_NATURE_ALIASES: Readonly<Record<string, TieNature>> = { showmance: "prior-romance" };

/** Read any stored/authored nature string as a `TieNature`: today's names pass, legacy spellings alias, else `undefined`. */
export function normalizeTieNature(raw: unknown): TieNature | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  if ((TIE_NATURES as readonly string[]).includes(v)) return v as TieNature;
  return Object.hasOwn(LEGACY_TIE_NATURE_ALIASES, v) ? LEGACY_TIE_NATURE_ALIASES[v] : undefined; // own keys only: `constructor` etc. are not aliases
}

/**
 * Load-time migration (0007/0030 non-degradation): a persisted layer carries tie natures by string, so a pre-#1909 `showmance`
 * tie is re-read as `prior-romance` (same prose, same effect). Any other unknown nature falls back to `old-acquaintance` rather
 * than leaving an unreadable tie. Returns a NEW layer; showmances (the arc) are untouched.
 */
export function migrateSeededRelationships(sr: SeededRelationships): SeededRelationships {
  return {
    ...sr,
    ties: sr.ties.map((t) => ({ ...t, nature: normalizeTieNature(t.nature) ?? "old-acquaintance" })),
  };
}
/** Chance an enabled tie/showmance slot is actually loaded (often none, even when budgeted). */
export const SEED_LOAD_PROB = 0.5;
/** ORW-132 (ASSUMED 0.25, pending Ryne): the chance a budgeted TIE slot actually loads - a huge minority (reserve twists load at 0.5 per slot). Showmance slots keep `SEED_LOAD_PROB`. */
export const TIE_LOAD_PROB = 0.25;
/** The small standing affinity bias a pre-game tie folds between the pair (each direction). Never large. */
export const TIE_AFFINITY_BIAS = 0.14;
/** A showmance's initial standing affinity bias at `spark` — a touch warmer than a plain tie, still small. */
export const SHOWMANCE_SPARK_BIAS = 0.18;

/** The default per-season budget (admin may override the COUNT like the twist budget, 0016 — never content). */
export const DEFAULT_TIE_BUDGET = 2;
export const DEFAULT_SHOWMANCE_BUDGET = 2;

/**
 * Seed the hidden relationship layer: ≤`tieBudget` pre-game ties + ≤`showmanceBudget` showmances, each
 * slot only ~50% loaded, over DISTINCT houseguests (no NPC sits in two seeded pairs, so the layer never
 * clusters on one person). Deterministic per seed + player-independent.
 */
export function loadSeededRelationships(
  npcs: readonly Houseguest[],
  tieBudget: number,
  showmanceBudget: number,
  rng: RandomnessSource,
  /**
   * 0063 (owner decision #3) — orientation-aware showmance ELIGIBILITY. When supplied, a showmance pair
   * is only drawn if `showmanceEligible(a, b)` holds (plausible pairings only — a QUEER showmance is a
   * first-class possible seed, never special-cased). Omitted ⇒ any pair is eligible (pre-0063 behavior).
   * It NEVER forces a showmance — the sparseness/earned discipline above still dominates; this only gates
   * WHO is eligible. Pre-game TIES are not romantic, so they are NOT gated by it.
   */
  showmanceEligible?: (a: EntityId, b: EntityId) => boolean,
): SeededRelationships {
  const ids = npcs.map((n) => n.id);
  const used = new Set<EntityId>();
  const ties: PreGameTie[] = [];
  const showmances: Showmance[] = [];

  const drawPair = (): [EntityId, EntityId] | null => {
    const free = ids.filter((id) => !used.has(id));
    if (free.length < 2) return null;
    const a = free[rng.int(free.length)]!;
    const rest = free.filter((id) => id !== a);
    const b = rest[rng.int(rest.length)]!;
    used.add(a); used.add(b);
    return [a, b];
  };

  // Draw a pair where the romance is PLAUSIBLE (eligibility gate). Consumes the same draws whether or not
  // a candidate is eligible (the eligibility test never re-rolls), so the stream stays seed-deterministic;
  // an ineligible draw is simply released back to the free pool and the slot is skipped.
  const drawEligiblePair = (): [EntityId, EntityId] | null => {
    const free = ids.filter((id) => !used.has(id));
    if (free.length < 2) return null;
    const a = free[rng.int(free.length)]!;
    const rest = free.filter((id) => id !== a);
    const b = rest[rng.int(rest.length)]!;
    if (showmanceEligible && !showmanceEligible(a, b)) return null; // skip this slot, release the pair
    used.add(a); used.add(b);
    return [a, b];
  };

  const tieSlots = Math.max(0, Math.min(tieBudget, Math.floor(ids.length / 2)));
  for (let i = 0; i < tieSlots; i++) {
    if (rng.next() < 1 - TIE_LOAD_PROB) continue; // ORW-132: a huge minority - most seasons have no pre-show tie at all
    const pair = drawPair();
    if (!pair) break;
    ties.push({ a: pair[0], b: pair[1], nature: TIE_NATURES[rng.int(TIE_NATURES.length)]! });
  }

  const showSlots = Math.max(0, Math.min(showmanceBudget, Math.floor(ids.length / 2)));
  for (let i = 0; i < showSlots; i++) {
    if (rng.next() < 1 - SEED_LOAD_PROB) continue;
    const pair = drawEligiblePair();
    if (!pair) continue; // ineligible / exhausted — skip this slot (never force an implausible romance)
    showmances.push({ a: pair[0], b: pair[1], stage: "spark" }); // never week-one visible
  }

  return { ties, showmances };
}

/** Serialize one pre-game tie to a single engine-only Vault record content string (never projected). */
export function preGameTieToVaultContent(t: PreGameTie): string {
  return `pre-game-tie ${t.a} <-> ${t.b}: ${t.nature} (hidden — surfaces only via a pathway)`;
}
/** Serialize one showmance to a single engine-only Vault record content string (never projected). */
export function showmanceToVaultContent(s: Showmance): string {
  return `showmance ${s.a} <-> ${s.b} [${s.stage}] (hidden — develops over weeks, never telegraphed)`;
}

// ── Post-season retrospective rendering (0048 — the Wall's ONE sanctioned reveal) ──────────────────
// The `…ToVaultContent` serializers above are the engine-only AUDIT format (raw ids + slugs — fine, the
// Vault is engine-only). They are NOT player-readable, so the 0048 retrospective must NOT show them raw
// (the live repro: "[seeded-relationship] pre-game-tie Emilio Shepard <-> npc:3: old-acquaintance …" —
// note the bare `npc:3`: a tie can be written with one party as a name and the other as a raw id). These
// helpers render the SAME tie/showmance as plain prose with BOTH parties resolved to names. Pure / Vault-free.

const TIE_NATURE_PROSE: Record<TieNature, string> = {
  "casting-callback": "crossed paths in casting before the show",
  "mutual-friend": "shared a mutual friend coming in",
  "shared-hometown": "are from the same hometown",
  "old-acquaintance": "already knew each other before the show",
  "prior-romance": "came in with a pre-show romantic spark",
  "family": "are family — related by blood or marriage",
  "ex": "used to date before the show",
  "old-friend": "go back years as friends",
  "rival": "have bad blood from before the show",
  "former-teammate": "used to play on the same team",
  "online-acquaintance": "know each other from online, long before the show",
};

/** 0095 — the Vault-free prose of WHY a tied pair knew each other, for a reveal's diffused content. */
export function tieNatureProse(nature: TieNature): string {
  return TIE_NATURE_PROSE[nature];
}

const SHOWMANCE_STAGE_PROSE: Record<ShowmanceStage, string> = {
  spark: "an early spark that never went public",
  bond: "a quiet bond that stayed under the radar",
  visible: "a showmance the house came to see",
  resolved: "a showmance that ran its course",
};

/**
 * Render one pre-game tie as readable post-season prose, both ids resolved to names. No raw token.
 * 0095 — an EXPOSED tie (the pair's connection came out mid-game) reads distinctly from one that stayed
 * sealed all season; the reveal itself is a highlight the retrospective is precisely for.
 */
export function preGameTieToRetrospectiveProse(t: PreGameTie, nameOf: (id: EntityId) => string): string {
  const fate = tieExposureOf(t) === "sealed"
    ? "it stayed hidden unless it came out in the house."
    : "it came out in the house — and blew up how the two were read for the rest of the season.";
  return `${nameOf(t.a)} and ${nameOf(t.b)} ${TIE_NATURE_PROSE[t.nature]} — ${fate}`;
}

/**
 * 0095 — the Vault-FREE public projection: names a pair ONLY once their tie has reached `public` (the
 * `visibleShowmances`-style sibling). Never surfaces a `sealed` or merely `surfaced-to-house` tie — those
 * stay off every player/admin surface by construction.
 */
export function exposedTies(ties: readonly PreGameTie[]): Array<{ a: EntityId; b: EntityId }> {
  return ties.filter((t) => tieExposureOf(t) === "public").map((t) => ({ a: t.a, b: t.b }));
}

/** Render one showmance as readable post-season prose, both ids resolved to names. No raw token. */
export function showmanceToRetrospectiveProse(s: Showmance, nameOf: (id: EntityId) => string): string {
  return `${nameOf(s.a)} and ${nameOf(s.b)}: ${SHOWMANCE_STAGE_PROSE[s.stage]}.`;
}

// ── Organic surfacing (L40) — a showmance advances ONLY as the live relationship genuinely develops ──
// Sustained mutual affinity carries the arc spark → bond → visible → resolved. The bias gives the
// seeded pair a head start, but they must still grow into it over weeks (never instant). Tuned so a
// seeded pair does not trip straight past `bond` from the spark bias alone.
export const SHOWMANCE_BOND_AFFINITY = 0.70;
export const SHOWMANCE_VISIBLE_AFFINITY = 0.82;

/**
 * The next stage for a showmance given the pair's CURRENT mutual affinity (pure; advances one step at a
 * time, never skips `visible`, never regresses). `visible` is the PUBLIC moment — only then may the
 * narrator voice it. `resolved` is set by the caller when one of the pair leaves.
 */
export function nextShowmanceStage(stage: ShowmanceStage, mutualAffinity: number): ShowmanceStage {
  if (stage === "spark" && mutualAffinity >= SHOWMANCE_BOND_AFFINITY) return "bond";
  if (stage === "bond" && mutualAffinity >= SHOWMANCE_VISIBLE_AFFINITY) return "visible";
  return stage;
}
