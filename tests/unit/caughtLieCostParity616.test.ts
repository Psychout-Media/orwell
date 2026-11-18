import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { BeliefStore } from "../../src/engine/beliefStore";
import { CAUGHT_LIE, caughtLieTrustDrop } from "../../src/engine/caughtLies";

/**
 * ORW-616 ("all 4 equal"): a caught lie costs the same whoever told it. The SAME lie, caught by the SAME catcher on IDENTICAL edges at the SAME evidence confidence (0.8, "told"):
 *  - by a HOUSEGUEST: two contradicting claims to the catcher in one moment (the `catchLie` path);
 *  - by the PLAYER: the same contradiction (the `catchLie` path, the player as speaker);
 *  - by the PLAYER: a believed bluff later caught (the `catchPlayerBluff` path).
 * Each must move the same stores by the same amounts: the catcher->liar edge (every component), the lied-to-me claim (confidence, origin), the jury demerit (none), and the
 * catcher's credibility read of the liar. Roles only (catcher, liar, subject, other).
 */
type Live = { week: number; beliefs?: BeliefStore; mannerByEvictee?: Record<string, Record<string, { betrayed?: boolean }>> };
type Private = { live: Live; recordPlayerBluffBelief(npc: EntityId, subject: EntityId): void; catchPlayerBluff(npc: EntityId, subject: EntityId, c?: number, o?: "witnessed" | "told"): void };
const SEED = 7;
const START = { trust: 0.6, affinity: 0.5, threat: 0.2, alignment: 0.3, confidence: 0.4, reliability: 0.5 };

function season(tag: string) {
  const sb = new GameSessionRegistry().sandboxFor(`orw616-${tag}`);
  const s = sb.session as GameSessionAdapter;
  s.setNpcBeliefsEnabled(true); s.setLiesCaughtEnabled(true); s.setCredibilityEnabled(true);
  s.createCharacter({ playerName: "P", seed: SEED });
  const [catcher, npcLiar, subject, other] = s.livingIds().filter((id) => id !== PLAYER) as EntityId[];
  const p = s as unknown as Private;
  p.live.week = 2;
  const edge = (a: EntityId, b: EntityId) => sb.engine.relationships.edge(a, b);
  for (const liar of [PLAYER, npcLiar!]) Object.assign(edge(catcher!, liar), START); // identical edges toward either liar
  return { s, p, edge, catcher: catcher!, npcLiar: npcLiar!, subject: subject!, other: other! };
}

/** Everything a caught lie may touch, read for (catcher, liar). */
function costOf(t: ReturnType<typeof season>, liar: EntityId) {
  const e = t.edge(t.catcher, liar);
  const delta = Object.fromEntries(Object.entries(START).map(([k, v]) => [k, +((e as unknown as Record<string, number>)[k]! - v).toFixed(12)]));
  const lies = (t.p.live.beliefs?.[t.catcher] ?? []).filter((c) => c.kind === "lied-to-me" && c.subject === liar && !c.refuted).map((c) => ({ confidence: c.confidence, origin: c.origin, value: c.value }));
  const demerit = t.p.live.mannerByEvictee?.[t.catcher]?.[liar]?.betrayed === true;
  const credibility = t.s.credibilityOf(t.catcher, liar);
  return { delta, lies, demerit, credibility };
}

function caughtContradiction(t: ReturnType<typeof season>, liar: EntityId) {
  t.s.tellClaim({ speaker: liar, listener: t.catcher, kind: "final-two-with", subject: t.subject, object: t.other, isTrue: true, intent: "inform" });
  t.s.tellClaim({ speaker: liar, listener: t.catcher, kind: "going-after", subject: t.subject, object: t.other, isTrue: false, intent: "mislead" });
  return costOf(t, liar);
}

function caughtBluff(t: ReturnType<typeof season>) {
  t.p.recordPlayerBluffBelief(t.catcher, t.subject);
  t.p.catchPlayerBluff(t.catcher, t.subject, CAUGHT_LIE.contradiction, "told");
  return costOf(t, PLAYER);
}

describe("ORW-616 a caught lie costs the same whoever told it", () => {
  it("a houseguest's caught lie and the player's (told or bluffed) move the same stores by the same amounts", () => {
    const npcSeason = season("npc");
    const byHouseguest = caughtContradiction(npcSeason, npcSeason.npcLiar);
    const byPlayerTold = caughtContradiction(season("player-told"), PLAYER);
    const byPlayerBluff = caughtBluff(season("player-bluff"));

    // The cost itself (pinned once, so "equal" can never mean "equally nothing").
    expect(byHouseguest.lies).toEqual([{ confidence: CAUGHT_LIE.contradiction, origin: "told", value: true }]);
    expect(byHouseguest.delta).toEqual({ trust: -Number(caughtLieTrustDrop(CAUGHT_LIE.contradiction).toFixed(12)), affinity: 0, threat: 0, alignment: 0, confidence: 0, reliability: 0 });
    expect(byHouseguest.demerit, "a caught lie is not a broken deal: no jury demerit").toBe(false);
    expect(byHouseguest.credibility).toBeLessThan(1);

    // ...and it is the SAME for the player, by either path.
    expect(byPlayerTold).toEqual(byHouseguest);
    expect(byPlayerBluff).toEqual(byHouseguest);
  });

  it("the trust hit applies even with the belief layer off (the cost never depends on who lied)", () => {
    const t = season("bluff-flags-off");
    t.s.setLiesCaughtEnabled(false);
    const c = caughtBluff(t);
    expect(c.delta.trust).toBeCloseTo(-caughtLieTrustDrop(CAUGHT_LIE.contradiction), 12);
    expect(c.lies).toEqual([]);
    expect(c.demerit).toBe(false);
  });

  it("the trust hit scales with the evidence and never drives trust below zero", () => {
    expect(caughtLieTrustDrop(0)).toBe(0);
    expect(caughtLieTrustDrop(1)).toBe(CAUGHT_LIE.trustDrop);
    expect(caughtLieTrustDrop(2)).toBe(CAUGHT_LIE.trustDrop);
    expect(caughtLieTrustDrop(Number.NaN)).toBe(0);
    const t = season("floor");
    t.edge(t.catcher, PLAYER).trust = 0.05;
    t.p.recordPlayerBluffBelief(t.catcher, t.subject);
    t.p.catchPlayerBluff(t.catcher, t.subject, 1, "witnessed");
    expect(t.edge(t.catcher, PLAYER).trust).toBe(0);
  });
});
