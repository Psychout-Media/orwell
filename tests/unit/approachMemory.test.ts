import { describe, it, expect } from "vitest";
import { RelationshipModel } from "../../src/engine/relationships";
import { rankApproaches, APPROACH_MEMORY_MAX } from "../../src/engine/conversation";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";
import { DECISION_SOURCES } from "../../src/engine/memorySources";

/**
 * B7 M1b (approved tie-in #2) - who approaches the player reads what the NPC REMEMBERS about them: a favor (or a promise the NPC owes the player) draws them in, a grudge keeps them away. The ranker takes an
 * optional bounded additive bias and draws NO extra rng, so absent => byte-identical; ORWELL_APPROACH_MEMORY is flag-off. Roles only.
 */
const ids = [npc(1), npc(2), npc(3), npc(4)];
const rel = (): RelationshipModel => {
  const r = new RelationshipModel(0.5);
  for (const [i, id] of ids.entries()) { r.edge(id, PLAYER).trust = 0.5; r.edge(id, PLAYER).affinity = 0.5 + i * 0.01; r.edge(id, PLAYER).threat = 0.1; }
  return r;
};
const order = (bias?: (n: string) => number) => rankApproaches(PLAYER, ids, rel(), new SeededRandom(5), undefined, bias).map((a) => a.npc);

describe("rankApproaches memory bias", () => {
  it("absent hook is byte-identical (same order and drives), and a zero hook changes nothing", () => {
    const a = rankApproaches(PLAYER, ids, rel(), new SeededRandom(5));
    const b = rankApproaches(PLAYER, ids, rel(), new SeededRandom(5), undefined, () => 0);
    expect(b).toEqual(a);
  });
  it("a favor lifts an NPC to lead; a grudge sinks the leader", () => {
    const base = order();
    const last = base[base.length - 1]!;
    expect(order((n) => (n === last ? 1 : 0))[0]).toBe(last);
    expect(order((n) => (n === base[0] ? -1 : 0))[0]).not.toBe(base[0]);
  });
  it("the bias is clamped: it moves a drive by at most APPROACH_MEMORY_MAX whatever the provider returns", () => {
    const a = rankApproaches(PLAYER, ids, rel(), new SeededRandom(5));
    const b = rankApproaches(PLAYER, ids, rel(), new SeededRandom(5), undefined, () => 99);
    for (const x of a) expect(b.find((y) => y.npc === x.npc)!.drive - x.drive).toBeCloseTo(APPROACH_MEMORY_MAX, 9);
  });
});

type G = { approachMemoryFor(n: string, p: string): number; setApproachMemoryEnabled(on: boolean): void; recordAssurance(a: unknown): void; setAssurancesEnabled(on: boolean): void };
function started() {
  const sb = new GameSessionRegistry().sandboxFor(`apm-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const [holder] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  return { sb, g: sb.session as unknown as G, holder: holder! };
}
describe("the adapter's approach memory bias (ORWELL_APPROACH_MEMORY)", () => {
  it("flag off => 0 for everyone", () => {
    const { g, holder } = started();
    g.setApproachMemoryEnabled(false); // B54 flip: explicit OFF (the layer now defaults ON)
    g.setAssurancesEnabled(true);
    g.recordAssurance({ from: holder, to: PLAYER, kind: "safe", sincerity: 1, source: "npc" });
    expect(g.approachMemoryFor(holder, PLAYER)).toBe(0);
  });
  it("on: a promise the NPC made the player draws them in; none => no pull; bounded", () => {
    const { g, holder } = started();
    g.setApproachMemoryEnabled(true); g.setAssurancesEnabled(true);
    const before = g.approachMemoryFor(holder, PLAYER);
    g.recordAssurance({ from: holder, to: PLAYER, kind: "safe", sincerity: 1, source: "npc" });
    const after = g.approachMemoryFor(holder, PLAYER);
    expect(after).toBeGreaterThan(before);
    expect(Math.abs(after)).toBeLessThanOrEqual(1);
  });
});

describe("the decision x source table", () => {
  it("lists the approach decision and its provider", () => {
    expect(DECISION_SOURCES.approaches).toEqual(["approachMemoryFor", "moodApproachFor"]); // B30 added the mood term
  });
});
