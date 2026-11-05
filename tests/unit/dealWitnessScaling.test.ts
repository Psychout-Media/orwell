import { describe, it, expect } from "vitest";
import { DealLedger } from "../../src/engine/deals";
import type { ReconcileSink } from "../../src/engine/deals";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";
import { DEAL_DURATION } from "../../src/engine/relationshipConstants";

/** AMEND 0140 — the honoured-deal trust bump scales with the formation audience, is capped, and the
 *  deal-depth streak REPLACES (not stacks on) the audience scale. Roles only. */
const PROMISOR = npc(1);
const PROTECT = npc(2);
const WIT = Array.from({ length: 200 }, (_, i) => npc(10 + i));

function gain(witnessCount: number, flags: { dealsWitnesses?: boolean; dealDepth?: boolean }): number {
  const rel = new RelationshipModel(0.5);
  const s: ReconcileSink = { rel, rng: new SeededRandom(7), juryDemerit: () => {}, reveal: () => "evt:1", ...flags } as ReconcileSink;
  const ledger = new DealLedger();
  const d = ledger.make([PROMISOR, PROTECT], "comp-throw", "throw it", undefined, 1, undefined, WIT.slice(0, witnessCount));
  const before = rel.edge(PROTECT, PROMISOR).trust;
  ledger.reconcile({ actor: PROMISOR, kind: "compete", targets: [], outcome: "threw" }, s);
  expect(d.status).toBe("kept");
  return rel.edge(PROTECT, PROMISOR).trust - before;
}

describe("0140 — publicity-priced promises", () => {
  it("flag ON: the honoured bump grows with audience size", () => {
    expect(gain(0, { dealsWitnesses: true })).toBeGreaterThan(0);
    expect(gain(3, { dealsWitnesses: true })).toBeGreaterThan(gain(0, { dealsWitnesses: true }));
    expect(gain(6, { dealsWitnesses: true })).toBeGreaterThan(gain(3, { dealsWitnesses: true }));
  });
  it("flag ON: the bump is capped at maxScale", () => {
    const need = Math.ceil((DEAL_DURATION.maxScale - 1) / DEAL_DURATION.perWitness);
    expect(gain(need + 50, { dealsWitnesses: true })).toBeCloseTo(gain(need, { dealsWitnesses: true }), 10);
    expect(gain(need, { dealsWitnesses: true })).toBeLessThanOrEqual(gain(0, { dealsWitnesses: true }) * DEAL_DURATION.maxScale + 1e-9);
  });
  it("flag OFF: the audience changes nothing", () => {
    expect(gain(8, { dealsWitnesses: false })).toBeCloseTo(gain(0, { dealsWitnesses: false }), 10);
  });
  it("deal-depth replaces the audience scale (streak mult only)", () => {
    expect(gain(8, { dealsWitnesses: true, dealDepth: true })).toBeCloseTo(gain(0, { dealsWitnesses: true, dealDepth: true }), 10);
  });
});
