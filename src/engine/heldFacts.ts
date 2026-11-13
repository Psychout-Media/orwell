import type { EntityId } from "../domain/ids";
import { hashSeed } from "./characterFactory";
import type { KnowledgeFact } from "../domain/knowledge";

/**
 * B10 / B11 slice 2 (design `info-copresence-design.md` S2) - HELD FACTS and the TOLD-TO ledger. A holder "owns" a fact they have not been told by anyone else (first-hand: witnessed, their own
 * secret, or an origin belief with `hops` 0 / no source) or one they hold as hearsay; either way what matters for the choice is whether a given LISTENER already knows it and whether the holder
 * already decided about telling THEM. `ToldLedger` records "holder decided about listener for fact" once per (holder, fact, listener) so a fact is decided exactly once per listener (re-decided only
 * after `reopen`, e.g. when the fact is superseded). Pure state (plain JSON round-trip), no rng, no I/O, no Vault: the ledger holds ids only. Unwired - a later slice runs the decision at scene time
 * behind `ORWELL_GOSSIP_COPRESENCE` (default OFF).
 */
export type Told = "shared" | "slipped" | "held" | "lied";

export interface HeldCandidate { factId: string; content: string; firstHand: boolean; confidence: number; subject?: EntityId }

const lineageOf = (f: KnowledgeFact): string => f.factId ?? f.id;

/**
 * 0129 / E12 (ORW-325) - a vote-DEDUCTION belief ("X believes A turned on them in the eviction vote": the traitors-fury blame seeding, 0110) attributes a SEALED ballot, so it never rides a telling. The
 * jury-house diffusion already spreads it through its own graph; the generic co-presence spread must not pick it up as one more fact to tell. Left in, the flag changed the season for everyone: the extra
 * facts took places among a pair's top candidates and consumed rolls, so the told ledger (and everything downstream of it) diverged between a flag-on and a flag-off season on about 1 seed in 4.
 */
export function isSealedAttribution(f: { pathway?: string; factId?: string }): boolean {
  return (f.pathway ?? "").startsWith("jury-house:blame") || (f.factId ?? "").startsWith("traitors-fury:blame");
}

/** The facts `holder` could tell `listener`: held by the holder, absent from the listener's knowledge (by lineage), most-recent-first-stable. Sealed ballot attributions are never candidates (see isSealedAttribution). */
export function heldCandidates(holderFacts: readonly KnowledgeFact[], listenerFacts: readonly KnowledgeFact[]): HeldCandidate[] {
  const listenerHas = new Set(listenerFacts.map(lineageOf));
  const seen = new Set<string>();
  const out: HeldCandidate[] = [];
  for (const f of holderFacts) {
    if (isSealedAttribution(f as { pathway?: string; factId?: string })) continue;
    const id = lineageOf(f);
    if (listenerHas.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      factId: id,
      content: f.content,
      firstHand: f.source === undefined || (f.hops ?? 0) === 0,
      confidence: f.confidence ?? 1,
      ...(f.subject !== undefined ? { subject: f.subject } : {}),
    });
  }
  // ORW-334: order by what the fact SAYS, not by its counter id (`know:N` comes from a counter shared with every event, so an unrelated record would re-order ties); the id only breaks an exact content tie.
  return out.sort((a, b) => {
    const ka = hashSeed(a.content), kb = hashSeed(b.content);
    return ka !== kb ? ka - kb : a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0;
  });
}

export interface ToldSnapshot { entries: Array<[holder: EntityId, factId: string, listener: EntityId, told: Told]> }

export class ToldLedger {
  private m = new Map<string, Told>();
  private static key(h: EntityId, f: string, l: EntityId): string { return `${h}\u0001${f}\u0001${l}`; }

  /** Has `holder` already decided about telling `listener` this fact? */
  decided(holder: EntityId, factId: string, listener: EntityId): boolean { return this.m.has(ToldLedger.key(holder, factId, listener)); }
  outcome(holder: EntityId, factId: string, listener: EntityId): Told | undefined { return this.m.get(ToldLedger.key(holder, factId, listener)); }
  /** Record the decision. First write wins unless `reopen` ran, so a scene replayed from a retry never double-tells. */
  record(holder: EntityId, factId: string, listener: EntityId, told: Told): boolean {
    const k = ToldLedger.key(holder, factId, listener);
    if (this.m.has(k)) return false;
    this.m.set(k, told);
    return true;
  }
  /** A superseded fact may be decided again for everyone (never deletes other facts). Returns how many were reopened. */
  reopen(holder: EntityId, factId: string): number {
    let n = 0;
    for (const k of [...this.m.keys()]) if (k.startsWith(`${holder}\u0001${factId}\u0001`)) { this.m.delete(k); n++; }
    return n;
  }
  /** Facts to decide this scene: candidates the holder has not yet decided for THIS listener. */
  undecided(holder: EntityId, listener: EntityId, candidates: readonly HeldCandidate[]): HeldCandidate[] {
    return candidates.filter((c) => !this.decided(holder, c.factId, listener));
  }
  get size(): number { return this.m.size; }
  /** How many decisions of `outcome` this holder has recorded (the per-holder lie budget counts "lied"). */
  count(holder: EntityId, outcome: Told): number {
    let n = 0;
    for (const [k, t] of this.m) if (t === outcome && k.startsWith(`${holder}\u0001`)) n++;
    return n;
  }
  /** How many decisions of `outcome` this holder has recorded toward ONE listener (the repetition-to-the-same-ear term of a lie's cost). */
  countTo(holder: EntityId, listener: EntityId, outcome: Told): number {
    let n = 0;
    for (const [k, t] of this.m) if (t === outcome && k.startsWith(`${holder}\u0001`) && k.endsWith(`\u0001${listener}`)) n++;
    return n;
  }
  snapshot(): ToldSnapshot {
    const entries: ToldSnapshot["entries"] = [];
    for (const [k, t] of [...this.m.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const [h, f, l] = k.split("\u0001") as [EntityId, string, EntityId];
      entries.push([h, f, l, t]);
    }
    return { entries };
  }
  static restore(s: ToldSnapshot | undefined): ToldLedger {
    const l = new ToldLedger();
    for (const [h, f, li, t] of s?.entries ?? []) l.m.set(ToldLedger.key(h, f, li), t);
    return l;
  }
}
