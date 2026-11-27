import { describe, it, expect } from "vitest";
import { buildEngineCore } from "../../src/composition/engineRoot";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { PLAYER, npc } from "../../src/domain/ids";
import type { RandomnessSource } from "../../src/ports/RandomnessSource";

/**
 * ORW-1091 (Ryne 2026-11-27: "Yes, both sides"; Coordinator: the meter spends only on a valid fold). The played-game fold meter (ORW-401) shrinks each repeat of a scene
 * inside one window. It now wears BOTH directions of a repeated scene (the houseguest's feeling toward the player AND the player's own edge toward them, plus the edge a
 * backfired pitch lands on), and a proposal the engine rejects spends nothing. Roles only.
 */
function setup(rng?: RandomnessSource) {
  const core = buildEngineCore();
  const cmd = new EngineCommandsAdapter(core.events, core.knowledge, core.relationships, ...(rng ? [rng] : []));
  cmd.setFoldWindowProvider(() => "d1:morning");
  return { core, cmd, rel: core.relationships };
}
const steps = (read: () => number, act: () => void, n: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const a = read(); act(); out.push(read() - a); }
  return out;
};

describe("ORW-1091 the fold meter wears both sides and spends only on a valid fold", () => {
  it("the player's own edge toward a houseguest (the reciprocal fold) shrinks with each repeat in one window", () => {
    const { cmd, rel } = setup();
    const s = steps(() => rel.read(PLAYER, npc(1)).signals.affinity,
      () => cmd.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a friendly chat", kind: "bonding" }), 4);
    expect(s[0]!, "the first scene moves the player's own edge").toBeGreaterThan(0);
    expect(s[3]!, "the fourth repeat moves it far less than the first (metered like the other side)").toBeLessThan(s[0]! * 0.4);
  });

  it("a generative proposal the engine rejects spends no step of the meter", () => {
    const scene = (cmd: EngineCommandsAdapter, direction: string) => cmd.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a chat",
      consequence: { edges: [{ toward: npc(1), direction: direction as "warmer" }] },
    });
    const fresh = setup();
    const f0 = fresh.rel.read(npc(1), PLAYER).signals.affinity; scene(fresh.cmd, "warmer");
    const first = fresh.rel.read(npc(1), PLAYER).signals.affinity - f0;
    expect(first).toBeGreaterThan(0);
    const after = setup();
    scene(after.cmd, "sideways"); scene(after.cmd, "sideways"); // rejected: no such direction
    const a0 = after.rel.read(npc(1), PLAYER).signals.affinity; scene(after.cmd, "warmer");
    expect(after.rel.read(npc(1), PLAYER).signals.affinity - a0, "the valid fold after two rejected ones is still a first step").toBeGreaterThan(first * 0.75);
  });

  it("a third-party pitch the engine rejects spends no step of the meter", () => {
    const pitch = (cmd: EngineCommandsAdapter, direction: string) => cmd.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a word about someone",
      consequence: { aboutEdges: [{ holder: npc(1), about: npc(2), direction: direction as "more-threatened" }] },
    });
    const read = (r: ReturnType<typeof setup>) => r.rel.read(npc(1), npc(2)).signals.threat;
    const mk = () => { const r = setup(); r.rel.edge(npc(1), PLAYER).trust = 0.9; return r; }; // trusted: no backfire gate
    const fresh = mk(); const f0 = read(fresh); pitch(fresh.cmd, "more-threatened"); const first = read(fresh) - f0;
    expect(first).toBeGreaterThan(0);
    // three rejected pitches: the per-beat budget of an edge between two houseguests is 3, so spending on a rejected one would leave nothing for the real pitch
    const after = mk(); pitch(after.cmd, "nonsense"); pitch(after.cmd, "nonsense"); pitch(after.cmd, "nonsense");
    const a0 = read(after); pitch(after.cmd, "more-threatened");
    expect(read(after) - a0, "the valid pitch after three rejected ones still lands in full").toBeGreaterThan(first * 0.75);
  });

  it("a backfired pitch's hit on the player is metered too", () => {
    // A stream whose every draw is 0: the backfire roll always lands (chance > 0) and the jitter is constant, so the shrink is the meter's alone.
    const zero: RandomnessSource = { next: () => 0, int: () => 0, pick: <T>(xs: readonly T[]) => xs[0]!, fork() { return zero; } };
    const { cmd, rel } = setup(zero);
    rel.edge(npc(1), PLAYER).trust = 0.1; // distrusts the player
    rel.edge(npc(1), npc(2)).affinity = 0.9; rel.edge(npc(1), npc(2)).trust = 0.9; // closer to the one being pitched against
    const s = steps(() => rel.read(npc(1), PLAYER).signals.threat, () => cmd.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a word about someone",
      consequence: { aboutEdges: [{ holder: npc(1), about: npc(2), direction: "more-threatened" }] },
    }), 3);
    expect(s[0]!, "the pitch backfires onto the player").toBeGreaterThan(0);
    expect(s[2]!, "the third backfire in one window lands far softer than the first").toBeLessThan(s[0]! * 0.4);
  });
});
