import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/**
 * ORW-101 / spec 0005 PO expansion - the NPC Houseguest's-Choice holder picks the strongest STRATEGIC sixth veto player for their game, not merely the strongest bond.
 * The strategy read is a deterministic, rng-free bias from the hidden edges + competition stats. Roles only.
 */
type G = {
  hcStrategyFor(c: string, h: string): number;
  setHcStrategyEnabled(on: boolean): void;
  live: { hoh?: string; nominees?: [string, string] };
  rel: RelationshipModel;
  house: { npcs: { id: string; character: { stats: { physical: number; mental: number; social: number } } }[] };
};
function started() {
  const sb = new GameSessionRegistry().sandboxFor(`hcs-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as G;
  const [a, b, c, d, e] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  g.live.nominees = [b!, c!]; g.live.hoh = a!;
  return { g, hoh: a!, n1: b!, n2: c!, x: d!, y: e! };
}
const setStats = (g: G, id: string, v: number) => { const n = g.house.npcs.find((q) => q.id === id)!; n.character.stats = { physical: v, mental: v, social: 0.5 }; };

describe("hcStrategyFor", () => {
  it("is 0 when off, for the player holder, and with no nominees", () => {
    const s = started();
    s.g.setHcStrategyEnabled(false);
    expect(s.g.hcStrategyFor(s.x, s.n1)).toBe(0);
    s.g.setHcStrategyEnabled(true);
    expect(s.g.hcStrategyFor(s.x, PLAYER)).toBe(0);
    s.g.live.nominees = undefined;
    expect(s.g.hcStrategyFor(s.x, s.n1)).toBe(0);
  });
  it("a nominee holder prefers the strong player who trusts them over a weak one who does not, deterministically and bounded", () => {
    const s = started();
    setStats(s.g, s.x, 0.95); setStats(s.g, s.y, 0.05);
    s.g.rel.edge(s.x, s.n1).trust = 0.9; s.g.rel.edge(s.y, s.n1).trust = 0.1;
    const strongAlly = s.g.hcStrategyFor(s.x, s.n1), weakStranger = s.g.hcStrategyFor(s.y, s.n1);
    expect(strongAlly).toBeGreaterThan(weakStranger);
    expect(s.g.hcStrategyFor(s.x, s.n1)).toBe(strongAlly);
    expect(Math.abs(strongAlly)).toBeLessThanOrEqual(1);
  });
  it("the HOH holder avoids a candidate who would rescue a nominee", () => {
    const s = started();
    for (const k of ["trust", "affinity"] as const) {
      s.g.rel.edge(s.x, s.n1)[k] = 0.95;
      s.g.rel.edge(s.y, s.n1)[k] = 0; s.g.rel.edge(s.y, s.n2)[k] = 0;
    }
    expect(s.g.hcStrategyFor(s.y, s.hoh)).toBeGreaterThan(s.g.hcStrategyFor(s.x, s.hoh));
  });
  it("strategy outweighs a slightly stronger bond when they diverge, via the bounded bias", () => {
    const rel = new RelationshipModel(0.5);
    for (const k of ["trust", "affinity"] as const) { rel.edge("h", "beloved")[k] = 0.7; rel.edge("h", "useful")[k] = 0.6; }
    const pick = (bias?: (c: string) => number) => rel.chooseStrongestBond("h", ["beloved", "useful"], new SeededRandom(3), 0, bias);
    expect(pick()).toBe("beloved");
    expect(pick((c) => (c === "useful" ? 0.4 : -0.2))).toBe("useful");
  });
});
