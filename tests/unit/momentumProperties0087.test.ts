import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { PLAYER_ARC_CONSTANTS, TRAJECTORY_CONSTANTS, TRAJECTORY_PLAYER_APPROACH } from "../../src/engine/trajectoryConstants";
import { deriveTrajectory, kindFoldSignal, type Trajectory } from "../../src/engine/trajectory";
import type { ConsequenceDirection } from "../../src/ports/EngineCommands";

/**
 * ORW-336b - Ryne's three rules for NPC->PLAYER momentum, proven on the real session (played game, recordInteraction -> the arc ->
 * the movement pull): BOUNDED (no radicalization), REVERSIBLE (an apology or a deep talk turns it), FLAT (no scenes => back to
 * steady; a mixed stream stays near steady). Roles only; seeded; no model.
 */
type Pull = { target: string; weight: number; avoid: boolean };
type G = {
  trajectoryOf(a: string, b: string): Trajectory;
  movementIntentFor(id: string): Pull[] | null;
  decayUntouchedTrajectories(t: ReadonlySet<string>): void;
  setTrajectoriesEnabled(on: boolean): void;
  livingIds(): string[];
  live: { playedGame?: boolean };
};
function started() {
  const sb = new GameSessionRegistry().sandboxFor(`mp-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as G;
  g.setTrajectoriesEnabled(true); g.live.playedGame = true;
  return { sb, g, npc: g.livingIds().find((i) => i !== PLAYER)! };
}
type Ctx = ReturnType<typeof started>;
let n = 0;
const warm = (c: Ctx, k = 1, kind: string | undefined = undefined) => { for (let i = 0; i < k; i++) c.sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, c.npc], toward: [c.npc], content: `w${n++}`, ...(kind ? { kind: kind as never } : { consequence: { edges: [{ toward: c.npc, direction: "warmer" as ConsequenceDirection }] } }) }); };
const cool = (c: Ctx, k = 1) => { for (let i = 0; i < k; i++) c.sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, c.npc], toward: [c.npc], content: `c${n++}`, consequence: { edges: [{ toward: c.npc, direction: "cooler" as ConsequenceDirection }] } }); };
const betray = (c: Ctx) => c.sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, c.npc], toward: [c.npc], content: `b${n++}`, kind: "betrayal" as never });
const arc = (c: Ctx) => c.g.trajectoryOf(c.npc, PLAYER);
const tilt = (c: Ctx): number => { const t = arc(c); return t.phase === "steady" || t.momentum < TRAJECTORY_PLAYER_APPROACH.minMomentum ? 1 : 1 + TRAJECTORY_PLAYER_APPROACH.gain * t.momentum; };
const ticksToSteady = (c: Ctx): number => { let t = 0; while (arc(c).phase !== "steady" && t < 500) { c.g.decayUntouchedTrajectories(new Set()); t++; } return t; };
const MAX_PLATEAU = 0.5; // "modest": the ordinary-streak ceiling
const rows: string[] = [];

describe("(1) BOUNDED - a long run plateaus at a modest cap, never an extreme", () => {
  for (const [name, feed] of [["cooling", cool], ["warming", warm]] as const) {
    it(`${name}: 4 / 10 / 50 / 200 scenes plateau at the cap; the movement tilt never passes x1.3`, () => {
      const c = started(); let done = 0; const seen: string[] = [];
      for (const target of [4, 10, 50, 200]) {
        feed(c, target - done); done = target;
        const t = arc(c);
        seen.push(`${target}: m=${t.momentum.toFixed(3)} ${t.phase} tilt x${tilt(c).toFixed(3)}`);
        expect(t.momentum).toBeLessThanOrEqual(MAX_PLATEAU + 1e-9);
        expect(t.phase).toBe(name === "cooling" ? "cooling" : "warming"); // a plain cooler/warmer run is never promoted to souring
        expect(tilt(c)).toBeLessThanOrEqual(1 + TRAJECTORY_PLAYER_APPROACH.gain * MAX_PLATEAU + 1e-9);
      }
      rows.push(`${name} -> ${seen.join(" | ")}`);
    });
  }
  it("the arc never moves the underlying bond: it is read by the movement pull only (no edge/threat write)", () => {
    const src = require("node:fs").readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8") as string;
    const reads = src.split("\n").filter((l) => /this\.trajectories\.get\(`\$\{id\}->\$\{PLAYER\}`\)/.test(l));
    expect(reads.length).toBe(1); // the only consumer of an NPC->player arc is applyTrajectoryToPulls
    expect(PLAYER_ARC_CONSTANTS.momentumCap).toBeLessThanOrEqual(MAX_PLATEAU);
  });
});

describe("(2) REVERSIBLE - an apology or a deep talk turns the arc; a betrayal bites but is recoverable", () => {
  it("one warm scene after a long cooling streak visibly cuts the momentum; two or three bring it to steady/warming", () => {
    const c = started(); cool(c, 6);
    const plateau = arc(c).momentum;
    warm(c, 1);
    const afterOne = arc(c);
    expect(afterOne.momentum).toBeLessThan(plateau * 0.6);
    warm(c, 1);
    expect(arc(c).phase).toBe("steady"); // two: back to flat
    warm(c, 1);
    expect(arc(c).phase).toBe("warming"); // three: it turns, and only gently
    expect(arc(c).momentum).toBeLessThan(plateau);
    rows.push(`reverse cooling->warm from m=${plateau.toFixed(3)}: after 1 warm m=${afterOne.momentum.toFixed(3)} ${afterOne.phase}; after 2 steady; after 3 ${arc(c).phase} m=${arc(c).momentum.toFixed(3)}`);
  });
  it("the same the other way: a warm streak turned by cooler scenes", () => {
    const c = started(); warm(c, 6);
    const plateau = arc(c).momentum;
    cool(c, 1); expect(arc(c).momentum).toBeLessThan(plateau * 0.6);
    cool(c, 1); expect(arc(c).phase).toBe("steady");
    cool(c, 1); expect(arc(c).phase).toBe("cooling");
    expect(arc(c).momentum).toBeLessThan(plateau);
  });
  it("a deep warm 'bonding' scene (kind, no descriptor) also reverses", () => {
    const c = started(); cool(c, 6); const plateau = arc(c).momentum;
    warm(c, 2, "bonding");
    expect(arc(c).phase).toBe("steady"); expect(arc(c).momentum).toBeLessThan(plateau);
  });
  it("a betrayal spikes the arc (souring at the spike) yet 3 warm scenes and ~10 quiet ticks make it recoverable", () => {
    const c = started(); betray(c);
    const spike = arc(c);
    expect(spike.phase).toBe("souring"); expect(spike.momentum).toBeCloseTo(TRAJECTORY_CONSTANTS.betrayalSpike, 5);
    warm(c, 4);
    const t = arc(c);
    expect(t.phase).toBe("warming"); expect(t.momentum).toBeLessThanOrEqual(MAX_PLATEAU + 1e-9);
    const q = ticksToSteady(c);
    expect(q).toBeLessThanOrEqual(12);
    rows.push(`betrayal spike m=${spike.momentum.toFixed(2)} souring; 4 warm -> ${t.phase} m=${t.momentum.toFixed(3)}; then ${q} quiet ticks to steady`);
  });
});

describe("(3) FLAT - with no scenes the arc returns to steady; a mixed stream stays near steady", () => {
  it("from the plateau (either direction, and a betrayal spike) an unfed arc is steady within 12 off-screen ticks", () => {
    const out: string[] = [];
    for (const seed of ["cool", "warm", "betray"] as const) {
      const c = started();
      if (seed === "cool") cool(c, 30); else if (seed === "warm") warm(c, 30); else betray(c);
      const m = arc(c).momentum; c.g.decayUntouchedTrajectories(new Set()); // the tick right after a scene is skipped by design
      const t = ticksToSteady(c) + 1;
      expect(t).toBeLessThanOrEqual(12); expect(arc(c).phase).toBe("steady");
      out.push(`${seed} m=${m.toFixed(2)}: ${t} ticks`);
    }
    rows.push(`ticks to steady: ${out.join(", ")}`);
  });
  it("alternating warm/cool scenes stay at steady-ish momentum (<= 0.25); 3 warm : 1 cool settles warming but under the cap", () => {
    const c = started(); let hi = 0; let warmup = 0; let steadyTurns = 0;
    for (let i = 0; i < 60; i++) { (i % 2 ? cool : warm)(c, 1); if (i < 4) warmup = Math.max(warmup, arc(c).momentum); else { hi = Math.max(hi, arc(c).momentum); if (arc(c).phase === "steady") steadyTurns++; } }
    expect(hi).toBeLessThanOrEqual(0.25); expect(steadyTurns).toBe(56); expect(warmup).toBeLessThanOrEqual(0.4);
    const d = started(); let lo = 1; let top = 0;
    for (let i = 0; i < 80; i++) { (i % 4 === 3 ? cool : warm)(d, 1); if (i > 20) { lo = Math.min(lo, d.g.trajectoryOf(d.npc, PLAYER).momentum); top = Math.max(top, d.g.trajectoryOf(d.npc, PLAYER).momentum); } }
    expect(top).toBeLessThanOrEqual(MAX_PLATEAU + 1e-9);
    rows.push(`mixed 1:1 band 0..${hi.toFixed(3)} (steady ${steadyTurns}/56 scenes after the first 4; first-4 transient peak ${warmup.toFixed(3)}); 3:1 band ${lo.toFixed(3)}..${top.toFixed(3)}`);
  });
});

describe("the old constants fail these rules (why the player arcs have their own)", () => {
  it("pure derive with the OFF-SCREEN constants climbs to 1.0 and carries 0.9+ momentum across a flip", () => {
    const f = (b: number) => ({ bondDelta: b, threatDelta: 0, betrayal: false });
    let t: Trajectory | undefined; const folds = [] as ReturnType<typeof f>[];
    for (let i = 0; i < 10; i++) { folds.push(f(-0.105)); t = deriveTrajectory(folds, t, TRAJECTORY_CONSTANTS); }
    expect(t!.momentum).toBe(1);
    for (let i = 0; i < 3; i++) { folds.push(f(0.105)); t = deriveTrajectory(folds, t, TRAJECTORY_CONSTANTS); }
    expect(t!.phase).toBe("warming"); expect(t!.momentum).toBeGreaterThan(0.9);
    expect(kindFoldSignal("bonding").bondDelta).toBeGreaterThan(0);
  });
  it("the off-screen constants are untouched (headless byte-identity): no cap, no flip reset, no damping", () => {
    expect(TRAJECTORY_CONSTANTS.momentumCap).toBeUndefined(); expect(TRAJECTORY_CONSTANTS.flipReset).toBeUndefined(); expect(TRAJECTORY_CONSTANTS.opposeDamp).toBeUndefined();
    expect(TRAJECTORY_CONSTANTS.neglectDecay).toBe(0.05);
  });
  it("prints the table", () => { console.log("MOMENTUM-TABLE\n" + rows.join("\n")); });
});
