import { PLAYER, type EntityId } from "../domain/ids";
import { clamp } from "../domain/num";

/** The kinds and commitment levels of a bond (engine-only enums; `bonds.ts` re-exports them). */
export type BondKind = "none" | "friendship" | "showmance" | "mentor" | "business" | "rivals-turned-allies" | "protector" | "puppet-master";
export type Commitment = "none" | "casual" | "final-two" | "ride-or-die";
/**
 * ORW-622 (Ryne approved 2026-11-17, Fable idea #17): MIXED RELATIONSHIPS. A bond carries several strands at once, each with its own weight 0..1, so behaviour can
 * split: a showmance and a final-two pact can protect someone at the vote while a grudge makes the holder snap at them over dinner. `kind` stays the dominant one.
 */
export type Strand = "friendship" | "romance" | "pact" | "owed" | "owing" | "rivalry";

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
  /** ORW-1079: strategy scenes together (working the game; a mentor bond reads from this). Only grows. Absent on older saves (= 0). */
  strategy?: number;
  /** The commitment the pair's deals hold right now. */
  commitment: Commitment;
}

export type BondStore = Record<string, BondRecord>;

/** ORW-606: the non-degradation check for the bond record: no pair's record is ever lost and its shared history and peak grudge only grow. */
export function bondStoreSuperset(later: BondStore | undefined, earlier: BondStore | undefined): boolean {
  for (const [k, e] of Object.entries(earlier ?? {})) {
    const l = later?.[k];
    if (!l || l.history < e.history || l.peakResentment < e.peakResentment || (l.strategy ?? 0) < (e.strategy ?? 0)) return false;
  }
  return true;
}

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
  /** THEME A / A3 (0207): a showmance that ends in the house is the worst rupture - deeper than a broken deal on every count. The wronged side's strain and warmth lost, the leaver's own. */
  breakupStrain: 0.55,
  breakupWarmthLoss: 0.45,
  breakerBreakupStrain: 0.3,
  breakerWarmthLoss: 0.2,
  /** A kept deal: a shared moment and a little warmth. */
  warmthPerKept: 0.05,
  /** A veto save: the saved one owes the saver. */
  debtPerSave: 0.5,
  /** A repair (an apology, a kept promise toward a wronged party; Theme 3 slice 5): resentment eases by this share of what strain eases. */
  repairResentShare: 0.5,
  /** ORW-598: who started a scene. The recipient's view of the starter moves by the scene's full weight; the starter's view of the recipient by this smaller share. */
  initiatorShare: 0.6,
  /** ORW-598: a bystander (in the room, not in the scene) moves only their own view of each principal, by this small share of the scene's weight; the principals' pair is untouched. */
  bystanderShare: 0.15,
  /** ORW-605: how far a person, a pair and the house can lean one scene's weight. Bounded; 1 with no traits, no pair and no dial. */
  sceneLeanTrait: 0.3,
  sceneFamiliarityMax: 6,
  scenePairSpan: 0.3,
  sceneJitter: 0.1,
  sceneScaleMin: 0.6,
  sceneScaleMax: 1.5,
  sceneDialBand: 1.35,
  /** Each night: strain eases, a grudge fades slower. */
  nightlyRepair: 0.03,
  nightlyResentFade: 0.01,
  /** `strength` = the edge strength, plus warmth, minus resentment (clamped 0..1). */
  warmthWeight: 0.3,
  resentmentWeight: 0.3,
  /** ORW-607 part 2: how much of the grudge book's `wrongWeight` (and its peak) counts as the wrong half of a grievance in a played game. 1 = the book's curve exactly; the one dial if the measurement says to turn the wrongs down. */
  wrongShare: 1,
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

/** The scene's effect on one directed record, at `scale` of its full weight (1 = exactly the old fold). `moment` = it counts as a shared key moment (a bystander's does not). */
export type SceneScaleKind = "warming" | "souring";

/**
 * ORW-605: how much one scene weighs for ONE holder toward ONE other, bounded to [sceneScaleMin, sceneScaleMax]. Pure, no rng: `lean` -1..1 is the holder's own warmth-proneness (a guarded
 * holder is negative: slower to warm, quicker to sour), `pair` is the holder's existing record of the other (a new pair moves more per scene, a deep one less), `dial` the house's bonding
 * lean (warming x dial, souring / dial, clamped to 1/1.35..1.35), `jitter` a keyed 0..1 roll supplied by the caller (0.5 = none). All absent => exactly 1.
 */
export function sceneScale(kind: SceneScaleKind, who: { lean?: number; pair?: { history: number }; dial?: number; jitter?: number } = {}): number {
  const lean = clamp(who.lean ?? 0, -1, 1);
  const trait = 1 + (kind === "warming" ? 1 : -1) * BOND.sceneLeanTrait * lean;
  const familiarity = who.pair ? clamp(who.pair.history / BOND.sceneFamiliarityMax, 0, 1) : 0.5;
  const pair = 1 + BOND.scenePairSpan * (0.5 - familiarity);
  const d = clamp(who.dial ?? 1, 1 / BOND.sceneDialBand, BOND.sceneDialBand);
  const dial = kind === "warming" ? d : 1 / d;
  const jitter = 1 + BOND.sceneJitter * 2 * ((who.jitter ?? 0.5) - 0.5);
  return clamp(trait * pair * dial * jitter, BOND.sceneScaleMin, BOND.sceneScaleMax);
}

function applyScene(r: BondRecord, kind: SceneFold, scale: number, moment: boolean): void {
  if (moment) r.history += 1;
  if (kind === "bonding" || kind === "alliance") { r.warmth = clamp(r.warmth + BOND.warmthPerBond * scale, 0, 1); r.strain = clamp(r.strain - BOND.repairPerBond * scale, 0, 1); }
  else if (kind === "showmance") { r.warmth = clamp(r.warmth + BOND.warmthPerRomance * scale, 0, 1); if (moment) r.romance += 1; r.strain = clamp(r.strain - BOND.repairPerBond * scale, 0, 1); }
  else if (kind === "strategy") { r.warmth = clamp(r.warmth + BOND.warmthPerStrategy * scale, 0, 1); if (moment) r.strategy = (r.strategy ?? 0) + 1; }
  else if (kind === "conflict") {
    r.warmth = clamp(r.warmth + BOND.warmthPerConflict * scale, 0, 1);
    r.resentment = clamp(r.resentment + BOND.resentPerConflict * scale, 0, 1);
    r.peakResentment = Math.max(r.peakResentment, r.resentment);
    r.strain = clamp(r.strain + BOND.strainPerConflict * scale, 0, 1);
  }
}

/** Who a non-house-life scene was between: the initiator and their partner (the event's pair convention); anyone else in its witness set only watched. House-life scenes name only their participants. */
export function sceneRoles(initiator: EntityId, witnessSet: readonly EntityId[], houseLife: boolean): { principals: EntityId[]; bystanders: EntityId[] } {
  const all = [...new Set(witnessSet)];
  if (houseLife) return { principals: all, bystanders: [] };
  const first = all.includes(initiator) ? initiator : all[0];
  const partner = all.find((x) => x !== first);
  const principals = [first, partner].filter((x): x is EntityId => x !== undefined);
  return { principals, bystanders: all.filter((x) => !principals.includes(x)) };
}

/**
 * ORW-609: who is who in a RECORDED player scene (the player is always a witness). The actor is the event's initiator when that houseguest is in the scene, else the player.
 * A houseguest who acted does it TO the player; when the player acted, the recipient is the first houseguest the scene names. Everyone else only watched.
 */
export function recordedSceneRoles(initiator: EntityId, witnessSet: readonly EntityId[]): { actor: EntityId; recipient: EntityId | undefined; bystanders: EntityId[] } {
  const all = [...new Set(witnessSet)];
  const actor = initiator !== PLAYER && all.includes(initiator) ? initiator : PLAYER;
  const recipient = actor === PLAYER ? all.find((x) => x !== PLAYER) : PLAYER;
  return { actor, recipient, bystanders: all.filter((x) => x !== actor && x !== recipient) };
}

/**
 * A scene the participants shared: every ordered pair among them folds it. With no `who`, both directions alike (they were all there: the original fold, byte-identical).
 * ORW-598: with `who.initiator`, the recipient's view of the initiator moves by the full weight and the initiator's view of the recipient by `initiatorShare` of it;
 * `who.bystanders` (watchers, not in the scene) move only their own view of each participant, by `bystanderShare`, never the participants' pair.
 */
export function foldScene(store: BondStore, kind: SceneFold, participants: readonly EntityId[], who?: { initiator?: EntityId; bystanders?: readonly EntityId[]; /** ORW-605: a per-holder multiplier on the scene's weight (absent => the old flat fold, byte-identical) */ scaleFor?: (holder: EntityId, other: EntityId, kind: SceneFold) => number }): void {
  const k = (h: EntityId, o: EntityId): number => who?.scaleFor?.(h, o, kind) ?? 1;
  const people = [...new Set(participants)];
  for (const a of people) for (const b of people) {
    if (a === b) continue;
    applyScene(touch(store, a, b), kind, (who?.initiator !== undefined && a === who.initiator ? BOND.initiatorShare : 1) * k(a, b), true);
  }
  for (const w of new Set(who?.bystanders ?? [])) {
    if (people.includes(w)) continue;
    for (const p of people) applyScene(touch(store, w, p), kind, BOND.bystanderShare * k(w, p), false);
  }
}

/**
 * A deal broken by `breaker`: the wronged party's grudge and strain, the breaker's own strain.
 * ORW-607 part 2: with `bookHoldsWrong` (a played game whose grudge book records this wrong) the GRUDGE is not written here - the wrong lives in the book on its curve and
 * `grievanceOf` reads it from there; the record keeps the strain and the history. Absent / false => the old fold, byte-identical.
 */
export function foldBreak(store: BondStore, breaker: EntityId, wronged: EntityId, opts: { bookHoldsWrong?: boolean } = {}): void {
  const w = touch(store, wronged, breaker);
  if (opts.bookHoldsWrong !== true) {
    w.resentment = clamp(w.resentment + BOND.resentPerBreak, 0, 1);
    w.peakResentment = Math.max(w.peakResentment, w.resentment);
  }
  w.strain = clamp(w.strain + BOND.strainPerBreak, 0, 1);
  w.history += 1;
  const b = touch(store, breaker, wronged);
  b.strain = clamp(b.strain + BOND.breakerStrain, 0, 1);
  b.history += 1;
}

/**
 * THEME A / A3 (0207): a showmance ended in the house. The wronged side's view of the leaver takes the heaviest strain the record carries and loses most of its warmth (so the romance strand
 * and the showmance kind fall away through the readers that already read them); the leaver strains and cools less. As with a broken deal (ORW-607 part 2), with `bookHoldsWrong` the GRUDGE is
 * the book's (a `heartbreak` row) and is not written here; without it the record carries the resentment too. Both views keep their history and romance count (non-degradation).
 */
export function foldBreakup(store: BondStore, leaver: EntityId, wronged: EntityId, opts: { bookHoldsWrong?: boolean } = {}): void {
  const w = touch(store, wronged, leaver);
  if (opts.bookHoldsWrong !== true) {
    w.resentment = clamp(w.resentment + BOND.resentPerBreak * 2, 0, 1);
    w.peakResentment = Math.max(w.peakResentment, w.resentment);
  }
  w.strain = clamp(w.strain + BOND.breakupStrain, 0, 1);
  w.warmth = clamp(w.warmth - BOND.breakupWarmthLoss, 0, 1);
  w.history += 1;
  const l = touch(store, leaver, wronged);
  l.strain = clamp(l.strain + BOND.breakerBreakupStrain, 0, 1);
  l.warmth = clamp(l.warmth - BOND.breakerWarmthLoss, 0, 1);
  l.history += 1;
}

/** THEME A / A3 (0207): a decision where heart and game pulled apart leaves strain on the holder's own view of the tie that lost. Directed; only the holder's side moves. */
export function foldShaken(store: BondStore, holder: EntityId, other: EntityId, amount: number): void {
  const r = touch(store, holder, other);
  r.strain = clamp(r.strain + Math.max(0, amount), 0, 1);
  r.history += 1;
}

/** A deal kept: a shared moment and a little warmth, both ways. */
export function foldKept(store: BondStore, a: EntityId, b: EntityId): void {
  for (const [x, y] of [[a, b], [b, a]] as const) {
    const r = touch(store, x, y);
    r.warmth = clamp(r.warmth + BOND.warmthPerKept, 0, 1);
    r.history += 1;
  }
}

/**
 * A repair (Theme 3 slice 5, ORW-569): `holder` - the wronged side - eases toward `other`. Directed: only the holder's side moves. Strain eases by `amount`,
 * the grudge by `amount x repairResentShare`; the worst of the grudge (`peakResentment`) stays, so the memory stays. A shared moment.
 */
export function foldRepair(store: BondStore, holder: EntityId, other: EntityId, amount: number): void {
  const r = touch(store, holder, other);
  const a = Math.max(0, amount);
  r.strain = clamp(r.strain - a, 0, 1);
  r.resentment = clamp(r.resentment - a * BOND.repairResentShare, 0, 1);
  r.history += 1;
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
 * The kind of a bond, read from its record (the holder's side). Deterministic, first match wins. "mentor" and "puppet-master" (ORW-1079) need reads beyond the record
 * (age and game experience; who steers whose votes): the caller passes them in `steer` (`mentorPuppet.ts`); without it they are never returned.
 */
/** ORW-622: how much each commitment level binds, as the pact strand (an engine table over the closed commitment enum; not a pick). */
const PACT_STRAND: Readonly<Record<Commitment, number>> = { none: 0, casual: 0.35, "final-two": 0.7, "ride-or-die": 1 };

/**
 * ORW-622: every strand the bond carries right now, with its weight (only those above 0). Several at once is the point: friendship is warmth; romance is the romance
 * scenes (full at a showmance) scaled by warmth; the pact is the commitment the pair's deals hold; owed / owing is the debt either way; rivalry is the grudge.
 */
export function strandsOf(rec: BondRecord): Partial<Record<Strand, number>> {
  const out: Partial<Record<Strand, number>> = {};
  const put = (k: Strand, v: number): void => { const c = clamp(v, 0, 1); if (c > 0) out[k] = c; };
  put("friendship", rec.warmth);
  put("romance", (Math.min(rec.romance, BOND.showmanceScenes) / BOND.showmanceScenes) * clamp(rec.warmth * 2, 0, 1));
  put("pact", PACT_STRAND[rec.commitment]);
  put("owed", rec.debt);
  put("owing", -rec.debt);
  put("rivalry", rec.resentment);
  return out;
}

export function kindOf(rec: BondRecord, steer?: { mentor?: boolean; puppetMaster?: boolean }): BondKind {
  if (rec.romance >= BOND.showmanceScenes && rec.warmth >= BOND.friendshipAt) return "showmance";
  if (rec.peakResentment >= BOND.rivalsPeak && rec.warmth >= BOND.friendshipAt && rec.resentment < BOND.rivalsPeak / 2) return "rivals-turned-allies";
  if (rec.debt >= BOND.protectorDebt) return "protector";
  // ORW-1079: the reads `mentorPuppet.ts` adds (age and game experience; who steers whose votes), supplied by the caller. Absent => never returned (as before).
  if (steer?.puppetMaster) return "puppet-master";
  if (steer?.mentor) return "mentor";
  if (rec.commitment !== "none" && rec.warmth < BOND.friendshipAt) return "business";
  if (rec.warmth >= BOND.friendshipAt) return "friendship";
  return "none";
}

/** What the grudge book holds for one directed pair: its `wrongWeight` now and the row's peak severity (both 0..1). */
export interface BookWrong { weight: number; peak: number }

/**
 * ORW-607 part 2: the ONE grievance a holder carries toward another in a played game: the book's wrong (on its own curve) plus the record's friction resentment, summed once, 0..1.
 * With no book (headless, flag off, no row) it is exactly the record's resentment.
 */
export function grievanceOf(rec: BondRecord, book?: BookWrong): number {
  return clamp(rec.resentment + BOND.wrongShare * clamp(book?.weight ?? 0, 0, 1), 0, 1);
}

/** The worst grievance the pair ever reached: the record's friction peak plus the book's peak severity, summed once, 0..1. */
export function peakGrievanceOf(rec: BondRecord, book?: BookWrong): number {
  return clamp(rec.peakResentment + BOND.wrongShare * clamp(book?.peak ?? 0, 0, 1), 0, 1);
}

/** The record as every reader should see it: its resentment and peak are the grievance (identity when there is no book wrong). */
export function withGrievance(rec: BondRecord, book?: BookWrong): BondRecord {
  if (!book) return rec;
  return { ...rec, resentment: grievanceOf(rec, book), peakResentment: peakGrievanceOf(rec, book) };
}

/** The bond's 0..1 strength: the edge's, plus warmth, minus a grudge. */
export function bondStrengthOf(edgeStrength01: number, rec: BondRecord): number {
  return clamp(edgeStrength01 + BOND.warmthWeight * rec.warmth - BOND.resentmentWeight * rec.resentment, 0, 1);
}
