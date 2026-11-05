import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";
import { decideConfidence, type ConfidenceSignals } from "../../src/engine/confidence";
import { confideToDisclosure, dripToDisclosure } from "../../src/engine/disclosureRoute";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { RelationshipModel } from "../../src/engine/relationships";
import type { GameHouse } from "../../src/engine/characterFactory";

/**
 * B33 (design 16.5 D1, lite) - `confide` and the 0092 drip report into ONE closed-set vocabulary (confirm / slip / deflect) without changing any decision: the mapping is a pure function of the existing
 * result; the adapter keeps the latest event per NPC for the current player turn / beat only; the tiers stay monotone in the motive; the lever takes no wording (so 6 phrasings of one press are one decision).
 * Roles only.
 */
const sig = (w: number): ConfidenceSignals => ({ npcTrust: w, npcAffinity: w, npcThreat: 0.1, playerTrust: w, playerAffinity: w, goodwill: w, archetype: "floater" });

describe("confideToDisclosure (pure)", () => {
  it("a disclosed confidence is `confirm` (tier + truthfulness kept); an undisclosed press is `deflect`; the drip is `slip`", () => {
    expect(confideToDisclosure({ disclosed: true, tier: "full", truthful: true })).toEqual({ outcome: "confirm", via: "confide", tier: "full", truthful: true });
    expect(confideToDisclosure({ disclosed: true, tier: "partial", truthful: false })).toMatchObject({ outcome: "confirm", truthful: false });
    expect(confideToDisclosure({ disclosed: false, tier: "none", truthful: true })).toEqual({ outcome: "deflect", via: "confide", truthful: true });
    expect(dripToDisclosure()).toEqual({ outcome: "slip", via: "drip", truthful: true });
  });
  it("the decision itself is untouched and the tier is monotone in the signals (more warmth never lowers it)", () => {
    const rank = { none: 0, tease: 1, partial: 2, full: 3 } as const;
    let prev = 0;
    for (const w of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const d = decideConfidence(sig(w), new SeededRandom(5), { liesRemaining: 2 });
      expect(rank[d.tier]).toBeGreaterThanOrEqual(prev); prev = rank[d.tier];
      expect(confideToDisclosure(d).outcome).toBe(d.disclosed ? "confirm" : "deflect");
    }
  });
  it("wording is not an input: the same signals + the same seed give the same decision however many times (six presses, one decision)", () => {
    const ds = Array.from({ length: 6 }, () => decideConfidence(sig(0.7), new SeededRandom(11), { liesRemaining: 2 }));
    for (const d of ds) expect(d).toEqual(ds[0]);
  });
});

describe("through the real session", () => {
  function started() {
    const sb = buildSandbox(7);
    const session = new GameSessionAdapter();
    session.setOnConfide(() => true);
    session.createCharacter({ playerName: "The Player", seed: 7 });
    const house = (session as unknown as { house: GameHouse }).house;
    const npc = house.npcs.find((n) => (n.character.hiddenElements ?? []).length > 0)!;
    const presence = (session as unknown as { presence?: Map<string, string> }).presence;
    if (presence) { presence.set(PLAYER, "kitchen"); presence.set(npc.id, "kitchen"); }
    return { session, npc: npc.id, rel: (session as unknown as { rel: RelationshipModel }).rel, sb };
  }
  it("a pressed confidence is recorded as `confirm`, a cold press as `deflect`, only for the current turn; nothing is recorded when the engine rolled nothing", () => {
    const warm = started();
    expect(warm.session.disclosureThisBeat(warm.npc)).toBeUndefined();
    for (const [a, b] of [[warm.npc, PLAYER], [PLAYER, warm.npc]] as const) { const e = warm.rel.edge(a, b); e.trust = 0.95; e.affinity = 0.95; e.threat = 0.05; }
    for (let i = 0; i < 3; i++) warm.session.makeDeal({ with: warm.npc, kind: "final-two", terms: "ride or die" });
    const r = warm.session.confide(warm.npc)!;
    expect(r.disclosed).toBe(true);
    expect(warm.session.disclosureThisBeat(warm.npc)).toMatchObject({ outcome: "confirm", via: "confide" });
    warm.session.noteMessage({ messageId: "next-turn" }); // a new player turn ends the window
    expect(warm.session.disclosureThisBeat(warm.npc)).toBeUndefined();

    const cold = started();
    for (const [a, b] of [[cold.npc, PLAYER], [PLAYER, cold.npc]] as const) { const e = cold.rel.edge(a, b); e.trust = 0; e.affinity = 0; e.threat = 0; }
    const none = cold.session.confide(cold.npc)!;
    expect(none.disclosed).toBe(false);
    expect(cold.session.disclosureThisBeat(cold.npc)).toMatchObject({ outcome: "deflect", via: "confide" });
    cold.session.advanceGame(); // an advance ends the beat's window too
    expect(cold.session.disclosureThisBeat(cold.npc)).toBeUndefined();
  });
});
