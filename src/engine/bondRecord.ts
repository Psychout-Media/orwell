import type { EntityId } from "../domain/ids";
import type { BondKind, Commitment } from "./bonds";

/**
 * Feature 0175 (Theme 3 Core 1, ORW-552) - THE BOND RECORD: what a houseguest carries about each other houseguest beyond today's trust / affinity / threat.
 * One directed record per ordered pair (`holder|other`), lopsided. Folded by the engine from what happened (scenes, deals kept and broken, a veto save), never
 * from narration; read through `BondReader` (bonds.ts). PURE: no I/O, no rng. ENGINE-ONLY (Vault class): never projected, never a number to the player.
 * Non-degradation: a record is never deleted; shared history and the peak of a grudge only grow.
 */
export interface BondRecord {
  /** 0..1 felt closeness, apart from strategy. */
  warmth: number;
  /** -1..1: positive = the other owes the holder, negative = the holder owes the other. */
  debt: number;
  /** 0..1 a grudge. Fades slowly; its peak is kept in `peakResentment`. */
  resentment: number;
  /** 0..1 how frayed the bond is right now. Repairs night by night without new conflict, faster with a warm scene. */
  strain: number;
  /** Shared key moments (scenes together, deals, saves): only grows. */
  history: number;
  /** Romance scenes together (a showmance reads from this). */
  romance: number;
  /** The highest the grudge ever reached (rivals-turned-allies reads from this). */
  peakResentment: number;
  /** The commitment the pair's deals hold right now. */
  commitment: Commitment;
}

export type BondStore = Record<string, BondRecord>;

export const BOND = {
  /** A warm scene together (bonding / alliance talk): warmth up, strain repaired. */
  warmthPerBond: 0.08,
  repairPerBond: 0.05,
  /** A romance scene. */
  warmthPerRomance: 0.12,
  /** Working the game together (strategy) builds a working bond, a little warmth. */
  warmthPerStrategy: 0.03,
  /** A clash: warmth down, a grudge and strain up. */
  warmthPerConflict: -0.06,
  resentPerConflict: 0.1,
  strainPerConflict: 0.12,
  /** A broken deal: the wronged party's grudge and strain; the breaker's own strain (they know what they did). */
  resentPerBreak: 0.35,
  strainPerBreak: 0.35,
  breakerStrain: 0.15,
  /** A kept deal: a shared moment and a little warmth. */
  warmthPerKept: 0.05,
  /** A veto save: the saved one owes the saver. */
  debtPerSave: 0.5,
  /** Each night: strain eases, a grudge fades slower. */
  nightlyRepair: 0.03,
  nightlyResentFade: 0.01,
  /** `strength` = the edge strength, plus warmth, minus resentment (clamped 0..1). */
  warmthWeight: 0.3,
  resentmentWeight: 0.3,
  /** Kinds read from the record (`kindOf`). */
  friendshipAt: 0.3,
  showmanceScenes: 2,
  rivalsPeak: 0.4,
  protectorDebt: 0.4,
  rideOrDieWarmth: 0.6,
  rideOrDieHistory: 6,
  /** The private pecking order ranks the holder's top few. */
  rankTop: 5,
} as const;

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
export const bondKey = (holder: EntityId, other: EntityId): string => `${holder}|${other}`;

export function emptyBond(): BondRecord {
  return { warmth: 0, debt: 0, resentment: 0, strain: 0, history: 0, romance: 0, peakResentment: 0, commitment: "none" };
}

/** The record (never created by a read). */
export function bondOf(store: BondStore | undefined, holder: EntityId, other: EntityId): BondRecord {
  return store?.[bondKey(holder, other)] ?? emptyBond();
}

function touch(store: BondStore, holder: EntityId, other: EntityId): BondRecord {
  return (store[bondKey(holder, other)] ??= emptyBond());
}

/** The scene kinds that fold (a house-life scene's type, or a recorded interaction's). */
export type SceneFold = "bonding" | "alliance" | "showmance" | "strategy" | "conflict";
export const SCENE_FOLDS: ReadonlySet<string> = new Set<SceneFold>(["bonding", "alliance", "showmance", "strategy", "conflict"]);

/** A scene the participants shared: every ordered pair among them folds it (both directions alike: they were all there). */
export function foldScene(store: BondStore, kind: SceneFold, participants: readonly EntityId[]): void {
  const people = [...new Set(participants)];
  for (const a of people) for (const b of people) {
    if (a === b) continue;
    const r = touch(store, a, b);
    r.history += 1;
    if (kind === "bonding" || kind === "alliance") { r.warmth = clamp(r.warmth + BOND.warmthPerBond, 0, 1); r.strain = clamp(r.strain - BOND.repairPerBond, 0, 1); }
    else if (kind === "showmance") { r.warmth = clamp(r.warmth + BOND.warmthPerRomance, 0, 1); r.romance += 1; r.strain = clamp(r.strain - BOND.repairPerBond, 0, 1); }
    else if (kind === "strategy") r.warmth = clamp(r.warmth + BOND.warmthPerStrategy, 0, 1);
    else if (kind === "conflict") {
      r.warmth = clamp(r.warmth + BOND.warmthPerConflict, 0, 1);
      r.resentment = clamp(r.resentment + BOND.resentPerConflict, 0, 1);
      r.peakResentment = Math.max(r.peakResentment, r.resentment);
      r.strain = clamp(r.strain + BOND.strainPerConflict, 0, 1);
    }
  }
}

/** A deal broken by `breaker`: the wronged party's grudge and strain, the breaker's own strain. */
export function foldBreak(store: BondStore, breaker: EntityId, wronged: EntityId): void {
  const w = touch(store, wronged, breaker);
  w.resentment = clamp(w.resentment + BOND.resentPerBreak, 0, 1);
  w.peakResentment = Math.max(w.peakResentment, w.resentment);
  w.strain = clamp(w.strain + BOND.strainPerBreak, 0, 1);
  w.history += 1;
  const b = touch(store, breaker, wronged);
  b.strain = clamp(b.strain + BOND.breakerStrain, 0, 1);
  b.history += 1;
}

/** A deal kept: a shared moment and a little warmth, both ways. */
export function foldKept(store: BondStore, a: EntityId, b: EntityId): void {
  for (const [x, y] of [[a, b], [b, a]] as const) {
    const r = touch(store, x, y);
    r.warmth = clamp(r.warmth + BOND.warmthPerKept, 0, 1);
    r.history += 1;
  }
}

/** A veto save: `saved` owes `saver` (negative from the saved one's side, positive from the saver's). */
export function foldSave(store: BondStore, saver: EntityId, saved: EntityId): void {
  const s = touch(store, saver, saved); s.debt = clamp(s.debt + BOND.debtPerSave, -1, 1); s.history += 1;
  const o = touch(store, saved, saver); o.debt = clamp(o.debt - BOND.debtPerSave, -1, 1); o.history += 1;
}

/** The commitment a pair's OPEN deals hold: a final two is "final-two" (or "ride-or-die" when the bond runs deep), any other open deal is "casual". */
export function commitmentFor(openKinds: readonly string[], rec: BondRecord): Commitment {
  if (openKinds.includes("final-two")) return rec.warmth >= BOND.rideOrDieWarmth && rec.history >= BOND.rideOrDieHistory ? "ride-or-die" : "final-two";
  return openKinds.length > 0 ? "casual" : "none";
}

/** One night passes: strain repairs, a grudge fades a little (its peak stays). */
export function nightPasses(store: BondStore): void {
  for (const r of Object.values(store)) {
    r.strain = clamp(r.strain - BOND.nightlyRepair, 0, 1);
    r.resentment = clamp(r.resentment - BOND.nightlyResentFade, 0, 1);
  }
}

/**
 * The kind of a bond, read from its record (the holder's side). Deterministic, first match wins. "mentor" and "puppet-master" need reads later slices add
 * (age and game experience; who steers whose votes): until then they are never returned.
 */
export function kindOf(rec: BondRecord): BondKind {
  if (rec.romance >= BOND.showmanceScenes && rec.warmth >= BOND.friendshipAt) return "showmance";
  if (rec.peakResentment >= BOND.rivalsPeak && rec.warmth >= BOND.friendshipAt && rec.resentment < BOND.rivalsPeak / 2) return "rivals-turned-allies";
  if (rec.debt >= BOND.protectorDebt) return "protector";
  if (rec.commitment !== "none" && rec.warmth < BOND.friendshipAt) return "business";
  if (rec.warmth >= BOND.friendshipAt) return "friendship";
  return "none";
}

/** The bond's 0..1 strength: the edge's, plus warmth, minus a grudge. */
export function bondStrengthOf(edgeStrength01: number, rec: BondRecord): number {
  return clamp(edgeStrength01 + BOND.warmthWeight * rec.warmth - BOND.resentmentWeight * rec.resentment, 0, 1);
}
