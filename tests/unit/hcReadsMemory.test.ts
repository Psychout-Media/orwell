import { describe, it, expect } from "vitest";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";
import { DECISION_SOURCES } from "../../src/engine/memorySources";

/**
 * B7 M4b (approved tie-in #6) - an NPC Houseguest's-Choice holder's sixth-player pick reads what they remember / believe / owe beside the bond: a favor (or a promise they owe) raises a candidate, a grudge
 * lowers them. The picker takes an optional additive bias and draws NO extra rng, so absent => byte-identical; ORWELL_HC_MEMORY is flag-off. Roles only.
 */
const cands = [npc(2), npc(3), npc(4)];
const rel = (): RelationshipModel => {
  const r = new RelationshipModel(0.5);
  for (const [i, c] of cands.entries()) { r.edge(npc(1), c).trust = 0.5 + i * 0.1; r.edge(npc(1), c).affinity = 0.5 + i * 0.1; }
  return r;
};
const pick = (bias?: (c: string) => number) => rel().chooseStrongestBond(npc(1), [...cands], new SeededRandom(9), undefined, bias);

describe("chooseStrongestBond memory bias", () => {
  it("absent or zero hook is byte-identical", () => {
    expect(pick(() => 0)).toBe(pick());
  });
  it("a strong favor flips the pick to the favored candidate; a grudge sinks the front-runner", () => {
    const base = pick();
    const other = cands.find((c) => c !== base)!;
    expect(pick((c) => (c === other ? 5 : 0))).toBe(other);
    expect(pick((c) => (c === base ? -5 : 0))).not.toBe(base);
  });
});

type G = { hcMemoryFor(c: string, h: string): number; setHcMemoryEnabled(on: boolean): void };
function started() {
  const sb = new GameSessionRegistry().sandboxFor(`hcm-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const [h, c] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  return { g: sb.session as unknown as G, holder: h!, cand: c! };
}
describe("the adapter's HC memory bias (ORWELL_HC_MEMORY)", () => {
  it("flag off => 0; on => bounded, and the player holder is never biased", () => {
    const { g, holder, cand } = started();
    expect(g.hcMemoryFor(cand, holder)).toBe(0);
    g.setHcMemoryEnabled(true);
    expect(Math.abs(g.hcMemoryFor(cand, holder))).toBeLessThanOrEqual(1);
    expect(g.hcMemoryFor(cand, PLAYER)).toBe(0);
  });
});

describe("the decision x source table", () => {
  it("lists the Houseguest's Choice decision and its provider", () => {
    expect(DECISION_SOURCES.houseguestsChoice).toEqual(["hcMemoryFor", "hcStrategyFor"]);
  });
});
