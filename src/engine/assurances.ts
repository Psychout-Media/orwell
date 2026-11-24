import type { EntityId } from "../domain/ids";
import { clampGuarded } from "../domain/num";

/**
 * B4 / #2017 slice 1 (design S2) - CASUAL ASSURANCES ("you're safe with me", "I've got your vote", "I'm with you"). A cheap, separate ledger from the formal DealLedger: no
 * kept/broken verdict machinery, no jury demerit, it DECAYS. Whether the assurer keeps it is self-interested and personality-scaled (`decideKeep`): a loyal, low-aggression houseguest
 * keeps it unless breaking pays a lot; a ruthless one breaks as soon as it pays; an insincere (strategic-lie) one is never kept for its own sake. The engine decides - the model
 * never rules on whether a promise was kept (anti-sycophancy). Pure data + deterministic predicates: no I/O, no rng, no Vault. Wiring (recording, the binding-decision reads, the
 * fold) is slice 2, behind `ORWELL_ASSURANCES` (default ON; `=0` turns it off).
 */
export type AssuranceKind = "safe" | "vote" | "loyal";
export type AssuranceStatus = "open" | "kept" | "broken" | "lapsed";

export interface Assurance {
  id: string;
  from: EntityId;       // the assurer
  to: EntityId;         // the assured
  kind: AssuranceKind;
  week: number;
  /** 0..1 - how sincere the assurer was at utterance (a strategic lie is low). */
  sincerity: number;
  source: "player" | "npc";
  status: AssuranceStatus;
  /** B22 (ORWELL_MEMORY_PROMISES): the houseguests who HEARD it (the scene's other named, awake witnesses). They remember its keeping or breaking too, at a lower weight. Absent => no witnesses (byte-identical). */
  heardBy?: EntityId[];
  /** Set when the assurance was BROKEN at a secret (sealed) eviction ballot: the assured never learned who broke it, so nothing may later name them as its victim (the same rule a secret-ballot deal break follows). Absent => an open break (an old save loads as one). */
  sealed?: true;
}

export const ASSURANCE = {
  /** Open assurances lapse (are no longer binding) after this many weeks. */
  horizonWeeks: 3,
  keepWeightMin: 0.2,
  keepWeightMax: 0.9,
  /** The trust the assured loses in the assurer when it is broken - smaller than a deal break. */
  brokenTrustDrop: 0.12,
  /** The memory severity the assured keeps of a broken assurance (a smaller grudge than a broken deal's). */
  brokenMemorySeverity: 0.3,
  /** The favor the assured keeps of an assurance that was KEPT (B4 slice 8) - weaker than a broken one's grudge, on purpose (negativity bias). */
  keptMemorySeverity: 0.2,
  /** B22: a witness remembers a kept/broken assurance they merely HEARD at this fraction of the assured's own weight. */
  witnessFactor: 0.5,
  /** B39: the chance (from a dedicated seeded roll) that the assured WRONGLY comes to believe a KEPT assurance was broken - a rumor, sometimes wrong by construction. */
  rumoredBreakP: 0.2,
  /** B39: how sure the assured is of the rumored break (a rumor, not a witnessed betrayal). */
  rumoredBreakConfidence: 0.4,
  /** How sure the assured is that the assurer lied, after a witnessed break (the lied-to-me claim's confidence). */
  brokenClaimConfidence: 0.8,
  /** The sincerity of an NPC's strategic-lie assurance (B4 slice 7). */
  liarSincerity: 0.1,
  /**
   * ORW-723 (Ryne: "Depends on the person. For sure."): the PULL of a vote promise comes from the voter's own traits and bond to the nominee. Weights of the pull (they sum to 1):
   * loyalty, honesty (1 - cunning), the voter's own bond to the nominee, and how un-threatening the nominee reads to them.
   */
  pullLoyalty: 0.3,
  pullHonesty: 0.3,
  pullBond: 0.25,
  pullCalm: 0.15,
  /** P(keep) = floor + span * pull (clamped): a pure schemer with no bond still keeps sometimes; a loyal honest friend almost always does. */
  keepChanceFloor: 0.05,
  keepChanceCeil: 0.95,
  /** The keep chance is a logistic of the pull: centre and steepness (steep, so a loyal honest friend usually keeps and a schemer usually breaks; the floor and ceiling keep it off 0 and 1). */
  keepChanceCentre: 0.47,
  keepChanceSteep: 12,
  /** A promise at or above this sincerity is decided by the pull; a lower one was already faked by the faking model and keeps that verdict. */
  sincereAt: 0.5,
  /** The vote term's size scales with the pull: factor = floor + span * pull (a scheming voter's term is weak, a loyal friend's strong). */
  termScaleFloor: 0.5,
  termScaleSpan: 2,
  /** ORW-737: a houseguest who would NOT truly keep the player still SAYS they will with chance `stanceLieScale * (1 - honesty)` (a keyed roll): at most one in this fraction of the dishonest, never most of a house. */
  stanceLieScale: 0.5,
} as const;

const clamp = clampGuarded;

export class AssuranceLedger {
  private items: Assurance[] = [];
  private seq = 0;

  add(a: Omit<Assurance, "id" | "status">): Assurance {
    const item: Assurance = { ...a, id: `asr:${++this.seq}`, sincerity: clamp(a.sincerity, 0, 1), status: "open" };
    this.items.push(item);
    return item;
  }
  openFor(from: EntityId): Assurance[] { return this.items.filter((x) => x.status === "open" && x.from === from); }
  openTo(to: EntityId): Assurance[] { return this.items.filter((x) => x.status === "open" && x.to === to); }
  /** Resolve an OPEN assurance once; a second resolution is refused. */
  resolve(id: string, status: "kept" | "broken", opts: { sealed?: boolean } = {}): boolean {
    const a = this.items.find((x) => x.id === id);
    if (!a || a.status !== "open") return false;
    a.status = status;
    if (status === "broken" && opts.sealed) a.sealed = true;
    return true;
  }
  /** ORW-586: the speaker WITHDREW the promise - lapse (never fold) the open rows matching from/to/kind (and the week when given), so a later board event cannot break it. Returns how many lapsed; none => a no-op. */
  lapseMatching(m: { from: EntityId; to: EntityId; kind: AssuranceKind; week?: number }): number {
    let n = 0;
    for (const a of this.items) if (a.status === "open" && a.from === m.from && a.to === m.to && a.kind === m.kind && (m.week === undefined || a.week === m.week)) { a.status = "lapsed"; n++; }
    return n;
  }
  /** Mark every open assurance older than the horizon as lapsed (never deleted). */
  lapse(currentWeek: number): void {
    for (const a of this.items) if (a.status === "open" && currentWeek - a.week > ASSURANCE.horizonWeeks) a.status = "lapsed";
  }
  get all(): readonly Assurance[] { return this.items; }
  toJSON(): { seq: number; items: Assurance[] } { return { seq: this.seq, items: this.items.map((x) => ({ ...x, ...(x.heardBy ? { heardBy: [...x.heardBy] } : {}) })) }; }
  static fromJSON(j: { seq: number; items: Assurance[] }): AssuranceLedger {
    const l = new AssuranceLedger();
    l.seq = j.seq;
    l.items = j.items.map((x) => ({ ...x, ...(x.heardBy ? { heardBy: [...x.heardBy] } : {}) }));
    return l;
  }
}

/** How much keeping an assurance is worth to this houseguest (the personality-scaled COST of breaking it): loyal + gentle => high, ruthless => low. Bounded. */
export function assuranceKeepWeight(p: { loyalty: number; aggression: number }): number {
  const raw = ASSURANCE.keepWeightMin + (ASSURANCE.keepWeightMax - ASSURANCE.keepWeightMin) * (0.65 * clamp(p.loyalty, 0, 1) + 0.35 * (1 - clamp(p.aggression, 0, 1)));
  return clamp(raw, ASSURANCE.keepWeightMin, ASSURANCE.keepWeightMax);
}

/**
 * Keep it unless the BENEFIT of breaking (0..1, the assurer's own read of what breaking gains) exceeds the personality-scaled cost of breaking (`keepWeight` x `sincerity`).
 * Deterministic and monotone in the benefit; an insincere assurance has no cost to break so is broken whenever breaking pays at all.
 */
export function decideKeep(i: { keepWeight: number; sincerity: number; breakBenefit: number }): boolean {
  const cost = clamp(i.keepWeight, 0, 1) * clamp(i.sincerity, 0, 1);
  return clamp(i.breakBenefit, 0, 1) <= cost && cost > 0;
}

/** B4 slice 5: lapse the live season's open assurances at the week roll (no-op when the ledger was never created, i.e. the flag is off). Mutates `s.assurances` in place. */
export function lapseAssurancesAtRoll(s: { week: number; assurances?: { seq: number; items: Assurance[] } }): void {
  if (!s.assurances) return;
  const l = AssuranceLedger.fromJSON(s.assurances);
  l.lapse(s.week);
  s.assurances = l.toJSON();
}

/**
 * B4 slice 7 - the ENGINE decides whether an NPC's assurance is sincere (the model never does): a loyal houseguest usually means it, a disloyal one often does not. `roll` is a draw in [0,1) from a
 * dedicated seeded stream (never the shared one). Sincere => 1; a strategic lie => `ASSURANCE.liarSincerity` (low, so `decideKeep` breaks it whenever breaking pays). Monotone in loyalty.
 */
export function npcAssuranceSincerity(loyalty: number, roll: number, pFake?: number): number {
  // ORW-601 (Fable T3-5): when the caller passes the shared faking chance (`dealPlans.ts` FAKING / fakingLean: the person, their past promises, the culture), a casual
  // assurance is faked on the SAME model as a deal. Without it, the older loyalty-only rule stands (byte-identical).
  const pSincere = pFake !== undefined ? clamp(1 - pFake, 0, 1) : clamp(0.2 + 0.8 * clamp(loyalty, 0, 1), 0.2, 1);
  return clamp(roll, 0, 1) < pSincere ? 1 : ASSURANCE.liarSincerity;
}

/** B39 - does the assured wrongly come to believe a KEPT assurance was broken? `roll` is a draw in [0,1) from a dedicated seeded stream (never the shared one). Pure, monotone in the roll. */
export function isRumoredBreak(roll: number): boolean {
  return clamp(roll, 0, 1) < ASSURANCE.rumoredBreakP;
}

/** ORW-723: how strongly a voter is pulled to honor a vote promise, 0..1 - monotone UP in loyalty, honesty and bond, DOWN in how threatening the nominee reads. Pure. */
export function assurancePull(i: { loyalty: number; honesty: number; bond: number; threat: number }): number {
  const A = ASSURANCE;
  return clamp(A.pullLoyalty * clamp(i.loyalty, 0, 1) + A.pullHonesty * clamp(i.honesty, 0, 1) + A.pullBond * clamp(i.bond, 0, 1) + A.pullCalm * (1 - clamp(i.threat, 0, 1)), 0, 1);
}
/** ORW-723: the chance a voter keeps the promise given their pull. Monotone in the pull. */
export function assuranceKeepChance(pull: number): number {
  const A = ASSURANCE;
  return clamp(A.keepChanceFloor + (A.keepChanceCeil - A.keepChanceFloor) / (1 + Math.exp(-A.keepChanceSteep * (clamp(pull, 0, 1) - A.keepChanceCentre))), 0, 1);
}
/** ORW-723: keep iff the assurance's own keyed roll (a draw in [0,1)) falls under the keep chance. Monotone in the pull and the roll. */
export function pullKeeps(pull: number, roll: number): boolean { return clamp(roll, 0, 1) < assuranceKeepChance(pull); }
/** ORW-723: the multiplier on the vote term's base weight. Monotone in the pull. */
export function assuranceTermScale(pull: number): number {
  return ASSURANCE.termScaleFloor + ASSURANCE.termScaleSpan * clamp(pull, 0, 1);
}

/**
 * ORW-723: the keep-or-break verdict of ONE open vote promise when the pull is on. A planned betrayal (`plan === true`) always breaks. A SINCERE promise (sincerity >= `sincereAt`, or the plan says honest) is decided by the pull's own
 * keyed roll alone - the old trait-free cost-benefit (`decideKeep`) no longer lowers a loyal voter's keep rate. A faked promise keeps the faking model's verdict (`legacyKeep`, the old `decideKeep`).
 */
export function pullVerdict(i: { plan: boolean | undefined; sincerity: number; legacyKeep: boolean; pull: number; roll: number }): boolean {
  if (i.plan === true) return false;
  const sincerity = i.plan === false ? 1 : i.sincerity;
  return sincerity >= ASSURANCE.sincereAt ? pullKeeps(i.pull, i.roll) : i.legacyKeep;
}

/** ORW-737 - what a houseguest DECLARES to the player about a future vote, nomination or veto. The narrator voices this and nothing else; the private vote never crosses. */
export type DeclaredStance = "will-keep" | "wont-commit";

/**
 * ORW-737 - the ENGINE decides what a houseguest tells the player about keeping them. A standing assurance (recorded, open or kept) is declared again. Otherwise a houseguest whose own pull would keep the
 * player (`pullKeeps`, keyed roll) declares it truthfully; one who would not still declares it when `lieRoll` falls under `stanceLieScale * (1 - honesty)` (a lie, recorded later as a low-sincerity assurance);
 * everyone else declines to commit. Pure: both rolls come from dedicated keyed streams, never the shared one.
 */
export function declaredStance(i: { standing: boolean; pull: number; honesty: number; keepRoll: number; lieRoll: number }): DeclaredStance {
  if (i.standing || pullKeeps(i.pull, i.keepRoll)) return "will-keep";
  return clamp(i.lieRoll, 0, 1) < ASSURANCE.stanceLieScale * (1 - clamp(i.honesty, 0, 1)) ? "will-keep" : "wont-commit";
}
