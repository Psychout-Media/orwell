import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../../features/support/answerPending";
import { buildSandbox } from "../support/sandbox";
import { seekTargets, SEEK } from "../../src/engine/copresenceSpread";
import { ToldLedger } from "../../src/engine/heldFacts";
import { assignRooms, type MovementIntent } from "../../src/engine/presence";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Occupancy, Room } from "../../src/domain/house";

/**
 * B35 (seeking, design B10 S4; flag ORWELL_GOSSIP_COPRESENCE, off by default) - a houseguest holding a high-motive fact they have not yet decided to tell someone leans their MOVEMENT toward that
 * listener, through the same pull channel as the A10 want, so the right audience is likelier to be in the room when the spread runs. Pure read, no rng, never lowers a pull; off => today's intent. Roles only.
 */
const H = npc(1), L = npc(2), O = npc(3);

describe("seekTargets (pure)", () => {
  function setup(affinity = 0.95) {
    const sb = buildSandbox(7);
    sb.engine.knowledge.seedBelief(H, { content: "a fact", originalContent: "a fact", factId: "f1", confidence: 1, hops: 0, distortion: 0, source: H }, "origin");
    const told = new ToldLedger();
    return { k: sb.engine.knowledge, told, deps: { knowledge: sb.engine.knowledge, told, affinity: () => affinity, threat: () => 0 } };
  }
  it("names a listener who lacks the fact, with a motive from affinity and the fact's confidence", () => {
    const { deps } = setup();
    const r = seekTargets(H, [L, O], deps);
    expect(r.map((x) => x.listener).sort()).toEqual([L, O].sort());
    expect(r[0]!.motive).toBeCloseTo(0.5 * 0.95 + 0.1, 9);
  });
  it("skips a listener who already knows it, and one the holder has already decided about", () => {
    const { k, told, deps } = setup();
    k.seedBelief(L, { content: "a fact", originalContent: "a fact", factId: "f1", confidence: 1, hops: 0, distortion: 0, source: H }, "told-by:x");
    told.record(H, "f1", O, "held");
    expect(seekTargets(H, [L, O], deps)).toEqual([]);
  });
  it("is deterministic and performs no writes", () => {
    const { k, told, deps } = setup();
    const before = JSON.stringify([k.knownTo(H), k.knownTo(L), told.snapshot()]);
    expect(seekTargets(H, [L, O], deps)).toEqual(seekTargets(H, [L, O], deps));
    expect(JSON.stringify([k.knownTo(H), k.knownTo(L), told.snapshot()])).toBe(before);
  });
});

type S = GameSessionAdapter;
type Pull = { target: string; weight: number; avoid: boolean };
const intentOf = (s: S, id: string): Pull[] | null => (s as unknown as { movementIntentFor(id: string): Pull[] | null }).movementIntentFor(id);
function parked(seed: number, user: string) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const sb = new GameSessionRegistry().sandboxFor(user);
  const s = sb.session as S;
  s.createCharacter({ playerName: "P", seed });
  s.setPerConversationClockEnabled(true);
  for (let i = 0; i < 600; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    const st = s.getGameState() as { daySchedule?: { due: boolean }; pending?: unknown };
    const live = (s.snapshot() as unknown as { live: { hoh?: string } }).live;
    if (st.daySchedule && !st.daySchedule.due && !st.pending && live.hoh !== undefined) return { sb, s };
  }
  return null;
}
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

describe("seeking through the real session", () => {
  function plant(seed: number) {
    const g = parked(seed, `seek-${seed}`); if (!g) return null;
    const ids = g.s.getGameState().house.map((h) => h.id);
    const [holder, listener] = ids.filter((i) => i !== "player");
    g.sb.engine.knowledge.seedBelief(holder!, { content: "a held fact", originalContent: "a held fact", factId: `seek:${seed}`, confidence: 1, hops: 0, distortion: 0, source: holder! }, "origin");
    g.sb.engine.relationships.edge(holder!, listener!).affinity = 0.95;
    return { ...g, holder: holder!, listener: listener!, fact: `seek:${seed}` };
  }
  const w = (arr: Pull[] | null, t: string): number => arr?.find((p) => p.target === t)?.weight ?? 0;
  it("layer OFF: the holder's intent is exactly today's; ON: the pull toward the listener rises and no pull is lowered", () => {
    let checked = 0;
    for (const seed of [3, 5, 8, 11]) {
      const g = plant(seed); if (!g) continue;
      g.s.setCopresenceEnabled(false);
      const off = intentOf(g.s, g.holder);
      g.s.setCopresenceEnabled(true);
      const on = intentOf(g.s, g.holder);
      expect(w(on, g.listener)).toBeGreaterThan(w(off, g.listener));
      for (const p of off ?? []) expect(w(on, p.target), "a held fact never lowers a pull").toBeGreaterThanOrEqual(p.weight - 1e-12);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
  it("a telling the holder has already decided about no longer pulls", () => {
    const g = plant(5)!;
    g.s.setCopresenceEnabled(true);
    const before = w(intentOf(g.s, g.holder), g.listener);
    g.s.copresenceToldLedger().record(g.holder, g.fact, g.listener, "held");
    expect(w(intentOf(g.s, g.holder), g.listener)).toBeLessThan(before);
  });
  it("the player is never a seek target (off-screen spreads exclude them)", () => {
    const g = plant(5)!;
    g.s.setCopresenceEnabled(true);
    expect(w(intentOf(g.s, g.holder), "player")).toBe(w((g.s.setCopresenceEnabled(false), intentOf(g.s, g.holder)), "player"));
  });
});

describe("the movement effect: the motive-holder is with the listener more often than a same-seed control", () => {
  it("over N ticks, a seeking pull puts the holder in the listener's room markedly more than no pull", () => {
    const share = (weight: number, trials = 200, steps = 20): number => {
      let inRoom = 0;
      for (let s = 0; s < trials; s++) {
        let occ: Occupancy = new Map<EntityId, Room>([[H, "hallway"], [L, "lounge"]]);
        const rng = new SeededRandom(7000 + s);
        const intent = (id: EntityId): MovementIntent | null => (id === H && weight > 0 ? [{ target: L, weight, avoid: false }] : null);
        for (let t = 0; t < steps; t++) {
          occ = assignRooms([H], occ, { rng, affinity: () => 0, intent }, new Map<EntityId, Room>([[L, "lounge"]]));
          if (occ.get(H) === "lounge") inRoom++;
        }
      }
      return inRoom / (trials * steps);
    };
    const motive = 0.5 * 0.95 + 0.1;
    const control = share(0), seeking = share(0.5 * (1 + SEEK.k * motive)); // 0.5 = a minimal existing pull, scaled by the seeking multiplier
    expect(seeking).toBeGreaterThan(control * 1.15);
  });
});
