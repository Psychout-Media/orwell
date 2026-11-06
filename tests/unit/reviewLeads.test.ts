import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RelationshipModel } from "../../src/engine/relationships";
import { rankApproaches, APPROACH_MEMORY_MAX, APPROACH_BIAS_FULL_AGENDA, APPROACH_OWED } from "../../src/engine/conversation";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";

/** Review leads on the memory / assurance code (1, 2, 5, 7). Roles only. Each is either a demonstrated defect (fixed; this is its regression) or a pin. */
type G = {
  approachMemoryFor(n: string, p: string): number; setApproachMemoryEnabled(on: boolean): void; setAssurancesEnabled(on: boolean): void; setMoodApproachEnabled?(on: boolean): void;
  recordAssurance(a: unknown): void; remember(h: string, s: string, k: string, sev: number): void; approachBiasHook(p: string): ((n: string) => number) | undefined;
  snapshot(): { live?: { assurances?: { items: Array<{ from: string; to: string; kind: string; sincerity: number }> } } };
};
function started(tag: string) {
  const sb = new GameSessionRegistry().sandboxFor(`rl-${tag}-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const [holder] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  return { sb, g: sb.session as unknown as G, holder: holder! };
}

describe("lead 7 - the memory bias cannot promote an NPC with no bond over bonded ones", () => {
  const A = npc(1), B = npc(2);
  const rel = (): RelationshipModel => {
    const r = new RelationshipModel(0.5);
    for (const e of [r.edge(A, PLAYER), r.edge(B, PLAYER)]) { e.trust = 0; e.affinity = 0; e.threat = 0; }
    r.edge(B, PLAYER).trust = 0.1; r.edge(B, PLAYER).affinity = 0.1; // B: a faint bond (agenda 0.1)
    return r;
  };
  it("a favor memory on a zero-agenda NPC no longer outranks a (faintly) bonded one", () => {
    const base = rankApproaches(PLAYER, [A, B], rel(), new SeededRandom(3));
    expect(base[0]!.npc).toBe(B);
    const biased = rankApproaches(PLAYER, [A, B], rel(), new SeededRandom(3), undefined, (n) => (n === A ? 1 : 0));
    expect(biased[0]!.npc, "the bias scales with the NPC's own agenda; zero agenda => zero bias").toBe(B);
    expect(biased.find((x) => x.npc === A)!.drive).toBeCloseTo(0, 9);
  });
  it("full-strength bias from the full-agenda point up (existing behaviour unchanged for bonded NPCs)", () => {
    const r = new RelationshipModel(0.5); r.edge(A, PLAYER).trust = 0.6; r.edge(A, PLAYER).affinity = 0.6; r.edge(A, PLAYER).threat = 0;
    expect(APPROACH_BIAS_FULL_AGENDA).toBeLessThanOrEqual(0.6);
    const a = rankApproaches(PLAYER, [A], r, new SeededRandom(3))[0]!.drive;
    const b = rankApproaches(PLAYER, [A], r, new SeededRandom(3), undefined, () => 1)[0]!.drive;
    expect(b - a).toBeCloseTo(APPROACH_MEMORY_MAX, 9);
  });
});

describe("lead 2 - a real grudge dominates the cheap owed-promise pull", () => {
  it("a grudge plus an open assurance the NPC owes the player stays negative (it used to net positive)", () => {
    const { g, holder } = started("grudge");
    g.setApproachMemoryEnabled(true); g.setAssurancesEnabled(true);
    g.remember(holder, PLAYER, "deal-broken", 0.15);
    const grudgeOnly = g.approachMemoryFor(holder, PLAYER);
    expect(grudgeOnly, "the holder holds a grudge").toBeLessThan(0);
    g.recordAssurance({ from: holder, to: PLAYER, kind: "safe", sincerity: 1, source: "npc" });
    expect(g.approachMemoryFor(holder, PLAYER), "the owed assurance must not cancel the grudge").toBeLessThan(0);
  });
  it("with no grudge the owed assurance still draws them in", () => {
    const { g, holder } = started("owed");
    g.setApproachMemoryEnabled(true); g.setAssurancesEnabled(true);
    g.recordAssurance({ from: holder, to: PLAYER, kind: "safe", sincerity: 1, source: "npc" });
    expect(g.approachMemoryFor(holder, PLAYER)).toBeCloseTo(APPROACH_OWED.bonus, 9);
  });
});

describe("lead 5 - repeat same-kind assurances do not share one roll", () => {
  it("two same-kind assurances from one NPC to one target in a week roll independently; the first keeps its exact seed", () => {
    const one = started("rep-a");
    one.g.setAssurancesEnabled(true);
    one.g.recordAssurance({ from: one.holder, to: PLAYER, kind: "safe", sincerity: 1, source: "npc" });
    const first = one.g.snapshot().live!.assurances!.items[0]!.sincerity;
    one.g.recordAssurance({ from: one.holder, to: PLAYER, kind: "safe", sincerity: 1, source: "npc" });
    const items = one.g.snapshot().live!.assurances!.items.filter((x) => x.kind === "safe" && x.from === one.holder);
    expect(items[0]!.sincerity).toBe(first);
    // across several NPCs/targets the second roll differs from the first at least once (it was identical by construction before the salt)
    let differs = items[1]!.sincerity !== items[0]!.sincerity;
    for (const kind of ["vote", "loyal"] as const) {
      one.g.recordAssurance({ from: one.holder, to: PLAYER, kind, sincerity: 1, source: "npc" });
      one.g.recordAssurance({ from: one.holder, to: PLAYER, kind, sincerity: 1, source: "npc" });
      const it2 = one.g.snapshot().live!.assurances!.items.filter((x) => x.kind === kind && x.from === one.holder);
      if (it2[1]!.sincerity !== it2[0]!.sincerity) differs = true;
    }
    expect(differs, "a repeat assurance gets its own roll").toBe(true);
  });
});

describe("lead 1 - every place the NPCs' drive to seek the player is ranked reads the same memory/mood bias", () => {
  it("source pin: no rankApproaches call in the adapter omits the bias hook", () => {
    const src = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
    const calls = src.split("\n").filter((l) => /rankApproaches\(/.test(l) && !/^\s*(\/\/|\*|import)/.test(l) && !/`rankApproaches`/.test(l));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const l of calls) expect(l, "a rankApproaches call without the shared bias hook").toMatch(/approachBiasHook/);
  });
  it("the shared hook is undefined with both layers off (byte-identical) and defined with approach memory on", () => {
    const { g } = started("hook");
    g.setApproachMemoryEnabled(false); g.setMoodApproachEnabled?.(false);
    expect(g.approachBiasHook(PLAYER)).toBeUndefined();
    g.setApproachMemoryEnabled(true);
    expect(typeof g.approachBiasHook(PLAYER)).toBe("function");
  });
});
