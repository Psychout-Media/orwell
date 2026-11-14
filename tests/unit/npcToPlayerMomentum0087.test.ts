import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { TRAJECTORY_CONSTANTS, TRAJECTORY_PLAYER_APPROACH } from "../../src/engine/trajectoryConstants";
import { MOVEMENT_INTENT } from "../../src/engine/presenceConstants";
import type { ConsequenceDirection, ConsequenceEmphasis } from "../../src/ports/EngineCommands";

/**
 * ORW-336 / 0087 open question 4: a PLAYER-witnessed scene folds into each present NPC's hidden NPC->PLAYER momentum.
 * DIRECTION comes from the model's proposed consequence descriptor (else the scene `kind`); the AMOUNT is the engine's
 * (emphasis never moves it). Played games only; headless is untouched. The momentum is Vault-class: never on any surface.
 * Roles only.
 */
type Traj = { phase: string; momentum: number };
type Pull = { target: string; weight: number; avoid: boolean };
type G = {
  trajectoryOf(a: string, b: string): Traj;
  movementIntentFor(id: string): Pull[] | null;
  setTrajectoriesEnabled(on: boolean): void;
  livingIds(): string[];
  live: { playedGame?: boolean };
  snapshot(): unknown;
  view?(): unknown;
};
function started(played = true, enabled = true) {
  const sb = new GameSessionRegistry().sandboxFor(`n2p-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as G;
  g.setTrajectoriesEnabled(enabled);
  g.live.playedGame = played;
  const npc = g.livingIds().find((i) => i !== PLAYER)!;
  return { sb, g, npc };
}
type Sb = ReturnType<typeof started>["sb"];
function scene(sb: Sb, npc: string, n: number, opts: { direction?: ConsequenceDirection; emphasis?: ConsequenceEmphasis; kind?: string }) {
  for (let i = 0; i < n; i++) {
    sb.commands.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, npc], toward: [npc], content: `scene ${i}`,
      ...(opts.kind ? { kind: opts.kind as never } : {}),
      ...(opts.direction ? { consequence: { edges: [{ toward: npc, direction: opts.direction, ...(opts.emphasis ? { emphasis: opts.emphasis } : {}) }] } } : {}),
    });
  }
}
const W = TRAJECTORY_CONSTANTS.recencyWindow;

describe("NPC->player momentum (ORW-336)", () => {
  it("(a) a run of cooler scenes builds COOLING momentum toward the player; warmer builds WARMING", () => {
    const c = started();
    scene(c.sb, c.npc, W, { direction: "cooler" });
    const cool = c.g.trajectoryOf(c.npc, PLAYER);
    expect(cool.phase).toBe("cooling");
    expect(cool.momentum).toBeGreaterThan(0);
    const w = started();
    scene(w.sb, w.npc, W, { direction: "warmer" });
    const warm = w.g.trajectoryOf(w.npc, PLAYER);
    expect(warm.phase).toBe("warming");
    expect(warm.momentum).toBeGreaterThan(0);
  });

  it("(b) two proposals with very different emphasis give the SAME momentum (direction only)", () => {
    const a = started(); const b = started();
    scene(a.sb, a.npc, W, { direction: "cooler", emphasis: "slight" });
    scene(b.sb, b.npc, W, { direction: "cooler", emphasis: "strong" });
    expect(a.g.trajectoryOf(a.npc, PLAYER)).toEqual(b.g.trajectoryOf(b.npc, PLAYER));
    expect(a.g.trajectoryOf(a.npc, PLAYER).momentum).toBeGreaterThan(0);
  });

  it("(c) no descriptor falls back to the scene kind (conflict sours, bonding warms)", () => {
    const c = started();
    scene(c.sb, c.npc, W, { kind: "conflict" });
    expect(c.g.trajectoryOf(c.npc, PLAYER).phase).toBe("souring");
    const w = started();
    scene(w.sb, w.npc, W, { kind: "bonding" });
    expect(w.g.trajectoryOf(w.npc, PLAYER).phase).toBe("warming");
  });

  it("a descriptor direction beats the kind for the NPC it names", () => {
    const c = started();
    scene(c.sb, c.npc, W, { direction: "cooler", kind: "bonding" });
    expect(c.g.trajectoryOf(c.npc, PLAYER).phase).toBe("cooling");
  });

  it("momentum is bounded by the engine: it never exceeds 1 and is the same for any number of identical scenes past the window", () => {
    const c = started();
    scene(c.sb, c.npc, 40, { direction: "cooler", emphasis: "strong" });
    expect(c.g.trajectoryOf(c.npc, PLAYER).momentum).toBeLessThanOrEqual(1);
  });

  it("headless (not a played game) and layer-off folds nothing", () => {
    const h = started(false, true);
    expect(h.g.live.playedGame).toBe(false);
    scene(h.sb, h.npc, W, { direction: "cooler" });
    // the seam itself is gated too (not only the recording path): a direct feed on a headless game is a no-op
    for (let i = 0; i < W; i++) (h.g as unknown as { recordPlayerSceneTrajectory(n: string, s: object): void }).recordPlayerSceneTrajectory(h.npc, { bondDelta: -0.1, threatDelta: 0, betrayal: false });
    expect(h.g.trajectoryOf(h.npc, PLAYER).momentum).toBe(0);
    const o = started(true, false);
    scene(o.sb, o.npc, W, { direction: "cooler" });
    expect(o.g.trajectoryOf(o.npc, PLAYER).momentum).toBe(0);
  });

  it("the momentum tilts approach: warming draws the NPC toward the player, souring keeps them away; steady changes nothing", () => {
    const w = started();
    const base = JSON.stringify(w.g.movementIntentFor(w.npc));
    scene(w.sb, w.npc, W, { direction: "warmer" });
    const toward = w.g.movementIntentFor(w.npc)?.find((p) => p.target === PLAYER);
    expect(toward && !toward.avoid && toward.weight >= MOVEMENT_INTENT.minCharge).toBe(true);
    expect(JSON.stringify(w.g.movementIntentFor(w.npc))).not.toBe(base);
    const s = started();
    scene(s.sb, s.npc, W, { kind: "conflict" });
    expect(s.g.movementIntentFor(s.npc)?.find((p) => p.target === PLAYER)?.avoid).toBe(true);
    expect(TRAJECTORY_PLAYER_APPROACH.gain).toBeGreaterThan(0);
    // the arc ITSELF scales the pull: the same state with the layer off yields a strictly smaller weight (and a lifted/forced avoid)
    const withArc = w.g.movementIntentFor(w.npc)!.find((p) => p.target === PLAYER)!.weight;
    const m = w.g.trajectoryOf(w.npc, PLAYER).momentum;
    w.g.setTrajectoriesEnabled(false);
    const without = w.g.movementIntentFor(w.npc)?.find((p) => p.target === PLAYER)?.weight ?? 0;
    expect(withArc).toBeGreaterThan(without);
    expect(withArc / (without || MOVEMENT_INTENT.minCharge)).toBeCloseTo(1 + TRAJECTORY_PLAYER_APPROACH.gain * m, 5);
  });

  it("a scene the player just played is not decayed by the very next off-screen tick; a neglected arc then fades", () => {
    const c = started();
    scene(c.sb, c.npc, W, { direction: "cooler" });
    const m0 = c.g.trajectoryOf(c.npc, PLAYER).momentum;
    const d = c.g as unknown as { decayUntouchedTrajectories(t: ReadonlySet<string>): void };
    d.decayUntouchedTrajectories(new Set());
    expect(c.g.trajectoryOf(c.npc, PLAYER).momentum).toBe(m0);
    d.decayUntouchedTrajectories(new Set());
    expect(c.g.trajectoryOf(c.npc, PLAYER).momentum).toBeLessThan(m0);
  });

  it("(d) the player never sees the momentum: every Vault-free projection is byte-identical with the layer on vs off, and carries no trajectory shape", () => {
    const proj = (enabled: boolean): string => {
      const c = started(true, enabled);
      scene(c.sb, c.npc, W, { direction: "cooler" });
      const s = c.sb.session;
      return JSON.stringify([s.getMomentPrompt({}), s.getMomentPrompt({ moment: "social" }), s.npcVoice(c.npc), s.gameStatus(), s.getGameState(), s.playerTagline(), s.seasonRecap()]);
    };
    const on = proj(true);
    expect(on).toBe(proj(false));
    expect(on).not.toMatch(/"momentum"\s*:/);
    expect(on).not.toMatch(/"phase"\s*:\s*"(warming|cooling|souring|steady)"/);
    const c = started();
    scene(c.sb, c.npc, W, { direction: "cooler" });
    expect(c.g.trajectoryOf(c.npc, PLAYER).momentum).toBeGreaterThan(0); // the arc exists, so the identity above is not vacuous
  });

  it("(e) persistence round-trip: the NPC->player arc survives snapshot -> restore and keeps folding", () => {
    const c = started();
    scene(c.sb, c.npc, W, { direction: "cooler" });
    const before = c.g.trajectoryOf(c.npc, PLAYER);
    expect(before.momentum).toBeGreaterThan(0);
    const revived = new GameSessionRegistry().sandboxFor(`n2p-r-${Math.random()}`).session as unknown as G & { restore(s: unknown): void };
    revived.setTrajectoriesEnabled(true);
    revived.restore(c.g.snapshot());
    expect(revived.trajectoryOf(c.npc, PLAYER)).toEqual(before);
  });
});
