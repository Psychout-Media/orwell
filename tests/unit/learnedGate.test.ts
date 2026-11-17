import { describe, it, expect } from "vitest";
import { DealLedger } from "../../src/engine/deals";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { Deal } from "../../src/domain/deal";

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

  // The player in both directions (Coordinator's standing rule, 2026-11-17): the same gate whichever side the player is on.
  it("the player as the breaker: their public act against an NPC is learned at once, exactly as an NPC's is", () => {
    const rel = new RelationshipModel(0.5);
    const ledger = new DealLedger();
    const deal = ledger.make([PLAYER, "w"], "safety", "you are safe with me", undefined, 1);
    const demerits: string[] = [];
    const before = rel.edge("w", PLAYER).trust;
    ledger.reconcile({ actor: PLAYER, kind: "nominate", targets: ["w", "t"] }, { rel, rng: new SeededRandom(7), currentWeek: 1, juryDemerit: (w: string, b: string) => { demerits.push(`${w}<-${b}`); } });
    expect(deal.learned).toBe(true);
    expect(rel.edge("w", PLAYER).trust).toBeLessThan(before);
    expect(demerits).toEqual([`w<-${PLAYER}`]);
  });
  it("the player as the wronged: an NPC's quiet break shows as open to the player until that NPC's own act against them, then as broken", async () => {
    const sb = new GameSessionRegistry().sandboxFor("learned-player");
    sb.session.createCharacter({ playerName: "The Player", seed: 31 });
    const seam = sb.session as unknown as { deals: DealLedger; rel: RelationshipModel; live: { week: number } };
    const [npc, other] = sb.session.livingIds().filter((id) => id !== PLAYER);
    const deal = seam.deals.make([npc!, PLAYER], "safety", "you are safe with me", undefined, seam.live.week) as Deal;
    const sink = { rel: seam.rel, rng: new SeededRandom(9), currentWeek: seam.live.week };
    const view = () => sb.session.getGameState().deals?.find((d) => d.id === deal.id)?.status;
    seam.deals.breakDeliberately(deal, npc!, sink);
    expect(deal.status).toBe("broken");
    expect(view()).toBe("open"); // quiet: the player has not learned of it
    seam.deals.reconcile({ actor: npc!, kind: "nominate", targets: [PLAYER, other!] }, sink);
    expect(deal.learned).toBe(true);
    expect(view()).toBe("broken");
  });
});

describe("ORW-597 follow-up: being told the breaker is coming after you reveals their quiet break", () => {
  it("a wronged houseguest who comes to believe the breaker targets them learns of the break overnight (once)", async () => {
    const { GameSessionRegistry } = await import("../../src/composition/registry");
    const sb = new GameSessionRegistry().sandboxFor("learned-targets-me");
    sb.session.createCharacter({ playerName: "The Player", seed: 37 });
    const g = sb.session as unknown as { deals: DealLedger; rel: RelationshipModel; live: { week: number; beliefs?: Record<string, unknown[]> }; learnBreaksOvernight(): void };
    const [breaker, wronged] = sb.session.livingIds().filter((id) => id !== PLAYER);
    const deal = g.deals.make([breaker!, wronged!], "safety", "you are safe with me", undefined, g.live.week) as Deal;
    g.deals.breakDeliberately(deal, breaker!, { rel: g.rel, rng: new SeededRandom(3), currentWeek: g.live.week });
    expect(deal.learned).toBe(false);
    g.learnBreaksOvernight();
    expect(deal.learned).toBe(false); // nothing held yet
    g.live.beliefs = { ...(g.live.beliefs ?? {}), [wronged!]: [{ id: `${wronged}|targets-me|${breaker}|t`, holder: wronged, kind: "targets-me", subject: breaker, object: wronged, value: true, origin: "told", confidence: 0.7, week: g.live.week }] };
    const before = g.rel.edge(wronged!, breaker!).trust;
    g.learnBreaksOvernight();
    expect(deal.learned).toBe(true);
    expect(g.rel.edge(wronged!, breaker!).trust).toBeLessThan(before);
  });
});
