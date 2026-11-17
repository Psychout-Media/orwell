import { describe, it, expect } from "vitest";
import { DealLedger } from "../../src/engine/deals";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/** ORW-597 (Fable T3-1, design hole 1): the wronged side reacts to a deal break only once they LEARN of it. Roles only: a breaker (b), the wronged (w), a third (t). */
function setup() {
  const rel = new RelationshipModel(0.5);
  const ledger = new DealLedger();
  const deal = ledger.make(["b", "w"], "safety", "you are safe with me", undefined, 1);
  const demerits: string[] = [];
  const sink = { rel, rng: new SeededRandom(7), currentWeek: 1, juryDemerit: (w: string, b: string) => { demerits.push(`${w}<-${b}`); } };
  return { rel, ledger, deal, demerits, sink };
}
const trust = (rel: RelationshipModel) => rel.edge("w", "b").trust;

describe("ORW-597: the learned-of-the-break gate", () => {
  it("a quiet, deliberate break moves nothing on the wronged side until they learn of it", () => {
    const { rel, ledger, deal, demerits, sink } = setup();
    const before = trust(rel);
    ledger.breakDeliberately(deal, "b", sink);
    expect(deal.status).toBe("broken");
    expect(deal.learned).toBe(false);
    expect(trust(rel)).toBe(before);
    expect(demerits).toEqual([]);
  });
  it("the breaker's own public act against them is how they learn - then the shock and the demerit land, once", () => {
    const { rel, ledger, deal, demerits, sink } = setup();
    const before = trust(rel);
    ledger.breakDeliberately(deal, "b", sink);
    ledger.reconcile({ actor: "b", kind: "nominate", targets: ["w", "t"] }, sink);
    expect(deal.learned).toBe(true);
    expect(trust(rel)).toBeLessThan(before);
    expect(demerits).toEqual(["w<-b"]);
    const after = trust(rel);
    expect(ledger.learnOfBreak(deal, sink)).toBe(false); // never twice
    expect(trust(rel)).toBe(after);
  });
  it("someone else's act against them teaches them nothing about this break", () => {
    const { ledger, deal, sink } = setup();
    ledger.breakDeliberately(deal, "b", sink);
    ledger.reconcile({ actor: "t", kind: "nominate", targets: ["w"] }, sink);
    expect(deal.learned).toBe(false);
  });
  it("a break by a public act is learned at once", () => {
    const { rel, ledger, deal, demerits, sink } = setup();
    const before = trust(rel);
    ledger.reconcile({ actor: "b", kind: "nominate", targets: ["w", "t"] }, sink);
    expect(deal.status).toBe("broken");
    expect(deal.learned).toBe(true);
    expect(trust(rel)).toBeLessThan(before);
    expect(demerits).toEqual(["w<-b"]);
  });
  it("a sealed-ballot break is never learned by name", () => {
    const { ledger, deal, sink } = setup();
    ledger.reconcile({ actor: "b", kind: "vote-evict", targets: ["w"] }, { ...sink, sealed: () => true });
    expect(deal.sealedBallot).toBe(true);
    expect(deal.learned).toBe(false);
    expect(ledger.learnOfBreak(deal, sink)).toBe(false);
  });
});
