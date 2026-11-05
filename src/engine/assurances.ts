import type { EntityId } from "../domain/ids";

/**
 * B4 / #2017 slice 1 (design S2) - CASUAL ASSURANCES ("you're safe with me", "I've got your vote", "I'm with you"). A cheap, separate ledger from the formal DealLedger: no
 * kept/broken verdict machinery, no jury demerit, it DECAYS. Whether the assurer keeps it is self-interested and personality-scaled (`decideKeep`): a loyal, low-aggression houseguest
 * keeps it unless breaking pays a lot; a ruthless one breaks as soon as it pays; an insincere (strategic-lie) one is never kept for its own sake. The engine decides - the model
 * never rules on whether a promise was kept (anti-sycophancy). Pure data + deterministic predicates: no I/O, no rng, no Vault. Wiring (recording, the binding-decision reads, the
 * fold) is slice 2, behind a default-OFF flag.
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
  /** The sincerity of an NPC's strategic-lie assurance (B4 slice 7). */
  liarSincerity: 0.1,
} as const;

const clamp = (x: number, lo: number, hi: number): number => (Number.isNaN(x) ? lo : Math.max(lo, Math.min(hi, x)));

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
  resolve(id: string, status: "kept" | "broken"): boolean {
    const a = this.items.find((x) => x.id === id);
    if (!a || a.status !== "open") return false;
    a.status = status;
    return true;
  }
  /** Mark every open assurance older than the horizon as lapsed (never deleted). */
  lapse(currentWeek: number): void {
    for (const a of this.items) if (a.status === "open" && currentWeek - a.week > ASSURANCE.horizonWeeks) a.status = "lapsed";
  }
  get all(): readonly Assurance[] { return this.items; }
  toJSON(): { seq: number; items: Assurance[] } { return { seq: this.seq, items: this.items.map((x) => ({ ...x })) }; }
  static fromJSON(j: { seq: number; items: Assurance[] }): AssuranceLedger {
    const l = new AssuranceLedger();
    l.seq = j.seq;
    l.items = j.items.map((x) => ({ ...x }));
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
export function npcAssuranceSincerity(loyalty: number, roll: number): number {
  const pSincere = clamp(0.2 + 0.8 * clamp(loyalty, 0, 1), 0.2, 1);
  return clamp(roll, 0, 1) < pSincere ? 1 : ASSURANCE.liarSincerity;
}
