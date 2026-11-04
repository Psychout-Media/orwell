import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../../features/support/answerPending";
import { wantScale, DESIRE, WANT_MOVEMENT } from "../../src/engine/desireClock";
import { assignRooms, type MovementIntent } from "../../src/engine/presence";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Occupancy, Room } from "../../src/domain/house";

/** A10: NPC movement from one internal WANT (flag ORWELL_WANT_MOVEMENT, default off). Roles only. */
type S = GameSessionAdapter;
type Pull = { target: string; weight: number; avoid: boolean };
const intentOf = (s: S, id: string): Pull[] | null => (s as unknown as { movementIntentFor(id: string): Pull[] | null }).movementIntentFor(id);

function parked(seed: number, user: string): S | null {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(user).session as S;
  s.createCharacter({ playerName: "P", seed });
  s.setPerConversationClockEnabled(true);
  for (let i = 0; i < 600; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    const st = s.getGameState() as { daySchedule?: { due: boolean }; pending?: unknown; phase: string };
    const live = (s.snapshot() as unknown as { live: { hoh?: string } }).live;
    if (st.daySchedule && !st.daySchedule.due && !st.pending && live.hoh !== undefined) return s;
  }
  return null;
}
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

describe("wantScale (pure)", () => {
  it("is 1 with no urgency, rises monotonically, and tops out at 1 + k at/over the approach threshold", () => {
    expect(wantScale(0)).toBe(1);
    expect(wantScale(-5)).toBe(1);
    expect(wantScale(DESIRE.threshold / 2)).toBeCloseTo(1 + WANT_MOVEMENT.k / 2, 9);
    expect(wantScale(DESIRE.threshold)).toBeCloseTo(1 + WANT_MOVEMENT.k, 9);
    expect(wantScale(DESIRE.threshold * 10)).toBeCloseTo(1 + WANT_MOVEMENT.k, 9);
    expect(wantScale(1)).toBeGreaterThan(wantScale(0.2));
  });
});

describe("want-driven movement through the real session", () => {
  it("flag OFF: intents are exactly today's (the want is never read)", () => {
    const s = parked(5, "wm-off")!;
    const ids = s.getGameState().house.map((h) => h.id);
    const off = JSON.stringify(ids.map((id) => intentOf(s, id)));
    s.setWantMovementEnabled(false);
    expect(JSON.stringify(ids.map((id) => intentOf(s, id)))).toBe(off);
  });
  it("flag ON: a non-HOH's pull toward the HOH is scaled up by its want, the HOH's own intent is unchanged, and an approach spends the want", () => {
    let checked = 0;
    for (const seed of [3, 5, 8, 11]) {
      const s = parked(seed, `wm-on${seed}`); if (!s) continue;
      const live = (s.snapshot() as unknown as { live: { hoh: string; desireApproachedAt?: Record<string, number> } }).live;
      const hoh = live.hoh;
      const ids = s.getGameState().house.map((h) => h.id).filter((id) => id !== hoh);
      const w = (arr: Pull[] | null): number => arr?.find((p) => p.target === hoh)?.weight ?? 0;
      s.setWantMovementEnabled(false);
      const hohIntentOff = JSON.stringify(intentOf(s, hoh));
      const off = new Map(ids.map((id) => [id, w(intentOf(s, id))] as const));
      s.setWantMovementEnabled(true);
      expect(JSON.stringify(intentOf(s, hoh)), "the HOH has no want to pursue").toBe(hohIntentOff);
      let raised = 0;
      for (const id of ids) {
        const on = w(intentOf(s, id));
        expect(on, "a want never lowers an existing pull").toBeGreaterThanOrEqual(off.get(id)! - 1e-12);
        if (on > off.get(id)! + 1e-9) raised++;
      }
      expect(raised, "most of the house now leans toward the HOH").toBeGreaterThan(ids.length / 2);
      // An approach SPENDS the want: set 'just approached now' -> urgency 0 -> scale 1 -> the pull is back to the flag-off value.
      const target = ids.find((id) => w(intentOf(s, id)) > off.get(id)! + 1e-9)!;
      const sn = JSON.parse(JSON.stringify(s.snapshot())) as { live: { desireApproachedAt?: Record<string, number>; nightDepth: number; dayNumber?: number } };
      sn.live.desireApproachedAt = { [target]: ((sn.live.dayNumber ?? 1) - 1) * 24 + sn.live.nightDepth };
      const t = new GameSessionRegistry().sandboxFor(`wm-spent${seed}`).session as S;
      GameSessionAdapter.setTimeOfDayEnabled(true);
      t.setPerConversationClockEnabled(true); t.setWantMovementEnabled(true); t.restore(sn as unknown as Parameters<S["restore"]>[0]);
      // (the relationship edges live in the sandbox, not the session snapshot - compare against the SAME restored session with the flag off)
      t.setWantMovementEnabled(false); const spentOff = w(intentOf(t, target));
      t.setWantMovementEnabled(true);
      expect(w(intentOf(t, target))).toBeCloseTo(spentOff, 9);
      // ...and without the 'just approached' mark the same NPC would have been scaled up (so the mark is what spends it)
      const fresh = JSON.parse(JSON.stringify(sn)) as typeof sn; delete fresh.live.desireApproachedAt;
      const u = new GameSessionRegistry().sandboxFor(`wm-fresh${seed}`).session as S;
      GameSessionAdapter.setTimeOfDayEnabled(true);
      u.setPerConversationClockEnabled(true); u.restore(fresh as unknown as Parameters<S["restore"]>[0]);
      u.setWantMovementEnabled(false); const freshOff = w(intentOf(u, target));
      u.setWantMovementEnabled(true);
      expect(w(intentOf(u, target))).toBeGreaterThanOrEqual(freshOff);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
  it("before the first ceremony the want is never read (flag on = flag off)", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("wm-pre").session as S;
    s.createCharacter({ playerName: "P", seed: 5 });
    s.setPerConversationClockEnabled(true);
    const ids = s.getGameState().house.map((h) => h.id);
    const off = JSON.stringify(ids.map((id) => intentOf(s, id)));
    s.setWantMovementEnabled(true);
    expect(JSON.stringify(ids.map((id) => intentOf(s, id)))).toBe(off);
  });
});

describe("the movement effect (co-presence), at the deployed strength", () => {
  const SUBJECT = npc(1), TARGET = npc(2);
  const share = (weight: number, trials = 200, steps = 20): number => {
    let inRoom = 0;
    for (let s = 0; s < trials; s++) {
      let occ: Occupancy = new Map<EntityId, Room>([[SUBJECT, "hallway"], [TARGET, "lounge"]]);
      const rng = new SeededRandom(9000 + s);
      const intent = (id: EntityId): MovementIntent | null => (id === SUBJECT ? [{ target: TARGET, weight, avoid: false }] : null);
      for (let t = 0; t < steps; t++) {
        occ = assignRooms([SUBJECT], occ, { rng, affinity: () => 0, intent }, new Map<EntityId, Room>([[TARGET, "lounge"]]));
        if (occ.get(SUBJECT) === "lounge") inRoom++;
      }
    }
    return inRoom / (trials * steps);
  };
  it("a want at full urgency (x(1+k)) puts the NPC with its target markedly more than the same NPC with no urgency", () => {
    const calm = share(1), urgent = share(wantScale(DESIRE.threshold));
    // eslint-disable-next-line no-console
    console.log(`[A10] calm ${calm.toFixed(3)} urgent ${urgent.toFixed(3)} multiple x${(urgent / calm).toFixed(2)}`);
    expect(urgent / calm).toBeGreaterThan(1.3);
  });
});
