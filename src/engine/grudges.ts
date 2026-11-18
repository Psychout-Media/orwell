import type { EntityId } from "../domain/ids";

/**
 * Theme 3 slice 5 (ORW-569, feature 0182) - THE GRUDGE BOOK. PR 1: a pure, engine-only record of who holds a grudge against whom and why, with a memory that
 * fades but is never zero. NOTHING DECIDES FROM IT YET: it feeds no agenda, vote, nomination or jury term (later PRs read `grudgeOf`).
 *
 * One row per DIRECTED pair `holder|subject`. Monotone (non-degradation): severity, peak and eased only ever grow; a row is never deleted. ENGINE-ONLY (Vault class):
 * never projected, never text. Pure: no I/O, no rng, deterministic.
 */

/** What kind of wrong the grudge remembers. A closed engine enum: never shown, never fed to a pick. */
export type GrudgeKind = "cut-by-ally" | "deal-broken" | "vote-against" | "lied-to" | "blindsided";

export interface GrudgeRow {
  kind: GrudgeKind;
  /** The week and in-game day of the strongest or most recent wrong. */
  week: number;
  day: number;
  /** 0..1, the strongest wrong held (only grows). */
  severity: number;
  /** 0..1, the highest severity ever held (only grows; the floor of the memory reads it). */
  peak: number;
  /** How much of the grudge repair has eased, 0..EASE_CAP x peak (only grows). */
  eased: number;
  /** Which record the row was last noted from (an engine key, never text). */
  refKey: string;
}

export type GrudgeBook = Record<string, GrudgeRow>;

export const GRUDGES = {
  /** The share of the peak severity a grudge never drops below: the house never fully forgets. */
  FLOOR_SHARE: 0.15,
  /** Weeks for the fading part of a grudge to halve, for a neutral holder in a neutral house. */
  HALF_LIFE_WEEKS: 7,
  /** Repair can ease at most this share of the peak ("partly, never fully"). */
  EASE_CAP: 0.6,
  /** A holder who keeps grudges remembers longer by this factor. */
  KEEPER_HALF_LIFE_MULT: 1.5,
  /** The exponent a culture's paranoia dial gets in the half-life (small by design). */
  PARANOIA_EXPONENT: 0.25,
  /** Severity of a deal broken, from the deal ledger alone (the same as a break's bond strain). */
  DEAL_BREAK_SEVERITY: 0.35,
  /** Culture dials are held to this band even if a caller hands in more (mirrors the culture bound). */
  MAX_FACTOR: 1.35,
  /** PR 2: how much of a fresh grudge's weight (freshness x severity) the revenge read takes, combined with the memory ledger's salience (never added on top). */
  revengeWeight: 0.5,
} as const;

/** PR 2: the base size of each repair source (before the holder's nature and the house's loyalty scale it). Engine-only; the book's EASE_CAP bounds the total per pair. */
export const REPAIR = {
  /** A promise the breaker later kept to the wronged. */
  kept: 0.10,
  /** The wrongdoer's own bonding scene with the wronged, soon after the wrong (once per pair and week). */
  scene: 0.06,
  /** A third person both hold a grudge against (once per pair, third and week). */
  enemy: 0.04,
  /** In-game days after the wrong inside which a bonding scene by the wrongdoer reads as an apology. */
  sceneDays: 4,
  /** A grudge-keeper forgives this share as fast. */
  keeperMult: 0.5,
} as const;

/** Revenge salience: the memory ledger's own read and the book's weight combined as a probabilistic-or (never summed), the book part scaled by the weight and the culture dial (already banded). Pure. */
export function combineSalience(sal: number, bookWeight: number, dial = 1): number {
  const w = unit(GRUDGES.revengeWeight * band(dial) * unit(bookWeight));
  return 1 - (1 - unit(sal)) * (1 - w);
}

/** A repair's size for one holder: the holder's nature (a keeper forgives slower) and the house's loyalty (a loyal house forgives slower). Pure; exactly `base` for a typical holder in a neutral house. */
export function repairAmount(base: number, who: { keeper?: boolean; loyalty?: number } = {}): number {
  return Math.max(0, base) * (who.keeper ? REPAIR.keeperMult : 1) / band(who.loyalty);
}

export const grudgeKey = (holder: EntityId, subject: EntityId): string => `${holder}|${subject}`;

const unit = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const band = (x: number | undefined): number => {
  const v = x === undefined || !Number.isFinite(x) ? 1 : x;
  return Math.min(GRUDGES.MAX_FACTOR, Math.max(1 / GRUDGES.MAX_FACTOR, v));
};

/**
 * Note a wrong. Keeps the strongest or most recent: a stronger or newer-or-equal wrong replaces kind, time and ref; severity and peak are the max of what was
 * held and what is new; eased is untouched. Returns whether the row changed. The holder never equals the subject.
 */
export function noteGrudge(book: GrudgeBook, holder: EntityId, subject: EntityId, kind: GrudgeKind, severity: number, week: number, day: number, refKey: string): boolean {
  const sev = unit(severity);
  if (holder === subject || !(sev > 0)) return false;
  const key = grudgeKey(holder, subject);
  const row = book[key];
  if (!row) { book[key] = { kind, week, day, severity: sev, peak: sev, eased: 0, refKey }; return true; }
  const newer = week > row.week || (week === row.week && day >= row.day);
  let changed = false;
  // ORW-605: a smaller wrong never resets an older, larger grudge's clock (week, day, kind). Only a wrong at least as severe (and newer, or strictly graver) takes over the row.
  if (sev > row.severity || (sev === row.severity && newer)) {
    if (row.kind !== kind || row.week !== week || row.day !== day || row.refKey !== refKey) changed = true;
    row.kind = kind; row.week = week; row.day = day; row.refKey = refKey;
  }
  if (sev > row.severity) { row.severity = sev; changed = true; }
  if (sev > row.peak) { row.peak = sev; changed = true; }
  return changed;
}

/** The half-life in weeks for one holder: loyalty lengthens it, paranoia a little, a grudge-keeper more. Each dial is exactly 1 with no culture. */
export function halfLifeFor(dials: { loyalty?: number; paranoia?: number; keeper?: boolean } = {}): number {
  return GRUDGES.HALF_LIFE_WEEKS * band(dials.loyalty) * Math.pow(band(dials.paranoia), GRUDGES.PARANOIA_EXPONENT) * (dials.keeper ? GRUDGES.KEEPER_HALF_LIFE_MULT : 1);
}

/** The share of a grudge's peak that repair has eased, 0..EASE_CAP. The ONE place the eased share is read (the freshness curve and the revenge fold both use it). */
export function easedShareOf(row: GrudgeRow): number {
  return row.peak > 0 ? Math.min(GRUDGES.EASE_CAP, row.eased / row.peak) : 0;
}

/**
 * How sharply the holder still remembers, in (0, 1]: floor + (1 - floor) x 0.5^(age / halfLife), the floor being a share of the PEAK severity so it is never 0.
 * Repair lowers it by the eased share of the peak but never below that floor. THE shared freshness curve for a wrong: every consumer reads it (via `wrongWeight`).
 */
export function freshness(row: GrudgeRow, week: number, halfLife: number = GRUDGES.HALF_LIFE_WEEKS): number {
  const floor = GRUDGES.FLOOR_SHARE * unit(row.peak);
  const age = Math.max(0, week - row.week);
  const raw = floor + (1 - floor) * Math.pow(0.5, age / Math.max(0.01, halfLife));
  return Math.max(floor, raw * (1 - easedShareOf(row)));
}

/**
 * ORW-607 (wrongs, step 1): the ONE weight a wrong carries now, freshness x severity, in (0, 1]. `dials` are the holder's own (loyalty, paranoia, keeper) and an optional `ease`
 * divisor on the half-life (a jury-eased pair); none given means the neutral half-life. Every reader of a grudge (the revenge fold, the bitter juror, the HOH-room visit) calls this, so
 * none keeps a half-life of its own. Pure, never 0 for a held wrong.
 */
export function wrongWeight(row: GrudgeRow, week: number, dials: { loyalty?: number; paranoia?: number; keeper?: boolean; ease?: number } = {}): number {
  const life = halfLifeFor(dials) / (dials.ease ?? 1);
  return freshness(row, week, life) * row.severity;
}

/** Ease a grudge (a repair). Bounded: the total eased never passes EASE_CAP x peak. Returns the amount actually eased. */
export function easeGrudge(row: GrudgeRow, amount: number): number {
  const room = Math.max(0, GRUDGES.EASE_CAP * row.peak - row.eased);
  const eased = Math.min(room, Math.max(0, Number.isFinite(amount) ? amount : 0));
  row.eased += eased;
  return eased;
}
