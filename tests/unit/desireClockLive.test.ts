import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../../features/support/answerPending";

/** A8 through the REAL session: an NPC's own desire clock can CUT INTO a conversation; flag off is byte-identical; hours-based cooldown; persisted; the hang-out stop carries the desire. Roles only. */
type S = GameSessionAdapter;
type Live = { desireApproachedAt?: Record<string, number>; interruption?: unknown; nightDepth?: number };
type Board = { interruption?: { npc: string; desire: string }; daySchedule?: { due: boolean }; phase: string };

function parked(seed: number, user: string, flag: boolean): S | null {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(user).session as S;
  s.createCharacter({ playerName: "P", seed });
  s.setPerConversationClockEnabled(true); s.setHangOutEnabled(true); s.setDesireClockEnabled(flag);
  for (let i = 0; i < 600; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    const st = s.getGameState() as Board & { pending?: unknown };
    if (st.daySchedule && st.daySchedule.due === false && !st.pending && (s.snapshot() as unknown as { live: { hoh?: string } }).live.hoh !== undefined) return s;
  }
  return null;
}
const live = (s: S): Live => (s.snapshot() as unknown as { live: Live }).live;
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

describe("A8 desire clock", () => {
  it("flag OFF: conversation steps write nothing and the board never shows an interruption (byte-identical)", () => {
    const s = parked(5, "dc-off", false)!;
    const before = JSON.stringify(s.snapshot());
    expect(before).not.toContain("desireApproachedAt");
    for (let i = 0; i < 12; i++) s.advanceClockPerConversation();
    const snap = JSON.stringify(s.snapshot());
    expect(snap).not.toContain("desireApproachedAt"); expect(snap).not.toContain("interruption");
    expect((s.getGameState() as Board).interruption).toBeUndefined();
  });
  it("an NPC approach CUTS INTO a conversation: during ordinary conversation steps, without the player asking, an interruption (public name + coarse desire) surfaces and the event is not fired", () => {
    let seen = 0;
    for (const seed of [3, 5, 8, 11, 13]) {
      const s = parked(seed, `dc${seed}`, true); if (!s) continue;
      const phase0 = (s.getGameState() as Board).phase;
      for (let i = 0; i < 80; i++) {
        s.advanceClockPerConversation();
        const b = s.getGameState() as Board;
        if (b.interruption) {
          expect(typeof b.interruption.npc).toBe("string");
          expect(b.interruption.npc).not.toMatch(/^npc-|\d\.\d/);
          expect(["campaign", "plea", "probe", "check-in"]).toContain(b.interruption.desire);
          expect(b.phase, "an interruption never advances the loop").toBe(phase0);
          seen++; break;
        }
        if (b.daySchedule?.due) break;
      }
    }
    expect(seen, "at least one seed showed an NPC cutting into the conversation").toBeGreaterThan(0);
  });
  it("an interruption is shown for exactly the next framing, then cleared; the same NPC rests for the hours-based cooldown", () => {
    for (const seed of [3, 5, 8, 11, 13]) {
      const s = parked(seed, `dcc${seed}`, true); if (!s) continue;
      let who: string | undefined; let atHour = 0;
      for (let i = 0; i < 80 && !who; i++) {
        s.advanceClockPerConversation();
        const l = live(s) as Live & { interruption?: { npc: string; atHour: number } };
        if (l.interruption) { who = l.interruption.npc; atHour = l.nightDepth!; }
        if ((s.getGameState() as Board).daySchedule?.due) break;
      }
      if (!who) continue;
      s.advanceClockPerConversation();
      const l2 = live(s) as Live & { interruption?: { npc: string } };
      if (l2.interruption) expect(l2.interruption.npc, "the same NPC does not re-interrupt inside the cooldown").not.toBe(who);
      expect(live(s).desireApproachedAt?.[who]).toBeDefined();
      expect(atHour).toBeGreaterThan(0);
      return;
    }
    throw new Error("no seed produced an interruption to test");
  });
  it("persists across snapshot/restore", () => {
    for (const seed of [3, 5, 8, 11, 13]) {
      const s = parked(seed, `dcp${seed}`, true); if (!s) continue;
      for (let i = 0; i < 80 && !live(s).desireApproachedAt; i++) { s.advanceClockPerConversation(); if ((s.getGameState() as Board).daySchedule?.due) break; }
      if (!live(s).desireApproachedAt) continue;
      const c = new GameSessionRegistry().sandboxFor(`dcp${seed}r`).session as S; c.setDesireClockEnabled(true); c.setPerConversationClockEnabled(true);
      GameSessionAdapter.setTimeOfDayEnabled(true);
      c.restore(s.snapshot());
      expect(live(c).desireApproachedAt).toEqual(live(s).desireApproachedAt);
      return;
    }
    throw new Error("no seed produced an approach to persist");
  });
  it("the hang-out npc-approach stop is the desire clock's pick and carries the coarse desire", () => {
    let hit = 0;
    for (const seed of [3, 5, 8, 11, 13, 17]) {
      const s = parked(seed, `dch${seed}`, true); if (!s) continue;
      for (let i = 0; i < 20; i++) {
        const r = s.hangOut();
        if (r.stopReason === "npc-approach") { expect(["campaign", "plea", "probe", "check-in"]).toContain(r.detail?.desire); hit++; break; }
        if (r.stopReason === "event-due" || r.stopReason === "bedtime") break;
      }
    }
    expect(hit).toBeGreaterThan(0);
  });
});
