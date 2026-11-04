import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../../features/support/answerPending";
import { PLAYER } from "../../src/domain/ids";

/** A12: the hang-out 'observed' stop is a RECORDED, witnessed event (not just a stop reason). Roles only. */
function parked(seed: number, user: string) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const sb = new GameSessionRegistry().sandboxFor(user);
  const s = sb.session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed });
  s.setPerConversationClockEnabled(true); s.setHangOutEnabled(true);
  for (let i = 0; i < 600; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    const st = s.getGameState() as { daySchedule?: { due: boolean }; pending?: unknown };
    if (st.daySchedule && st.daySchedule.due === false && !st.pending && (s.snapshot().live as unknown as { hoh?: string }).hoh !== undefined) return { sb, s };
  }
  return null;
}
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

describe("hang-out observed stop leaves a recorded, witnessed trace", () => {
  it("each observed stop adds exactly one player-witnessed event naming who was seen, with those houseguests as witnesses", () => {
    let seen = 0;
    for (let seed = 1; seed <= 200 && seen < 3; seed++) {
      const g = parked(seed, `obs${seed}`); if (!g) continue;
      for (let i = 0; i < 12; i++) {
        const before = g.sb.engine.events.queryAll().length;
        const r = g.s.hangOut();
        if (r.stopReason === "observed") {
          const after = g.sb.engine.events.queryAll();
          const added = after.slice(before);
          expect(added.length, "exactly one new event for the observed stop").toBe(1);
          const ev = added[0]!;
          expect(ev.witnessSet).toContain(PLAYER);
          expect(ev.hidden, "player-witnessed is never hidden").toBe(false);
          for (const name of r.detail!.who!) expect(ev.content, "names the houseguests seen").toContain(name);
          expect(ev.content).not.toMatch(/npc:\d|\d\.\d/);
          expect(ev.witnessSet.length, "witnesses = the player + who was seen").toBe(1 + r.detail!.who!.length);
          seen++; break;
        }
        if (r.stopReason === "event-due" || r.stopReason === "bedtime") break;
        // any non-observed stop adds no such event
        expect(g.sb.engine.events.queryAll().length).toBe(before);
      }
    }
    expect(seen, "an observed stop was reached on screen-able seeds").toBeGreaterThan(0);
  });
});
