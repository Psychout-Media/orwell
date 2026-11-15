import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { hangOutStopLine } from "../../src/engine/hangOut";
import type { HangOutStopReason } from "../../src/engine/hangOut";
import { resolvePending } from "../../features/support/answerPending";
import { PLAYER } from "../../src/domain/ids";

/** ORW-22: every hang-out stop kind carries a player-facing, Vault-free line (and the recorded ones leave exactly one witnessed event). Roles only. */

const KINDS: HangOutStopReason[] = ["event-due", "pulled", "npc-approach", "observed", "bedtime", "max-beats"];

describe("hangOutStopLine (pure)", () => {
  it("every stop kind has a non-empty line", () => {
    for (const k of KINDS) {
      const line = hangOutStopLine({ stopReason: k, detail: { npc: "Role", by: "diary-room", kind: "argument", who: ["A", "B"] } });
      expect(line.length, k).toBeGreaterThan(10);
    }
  });
  it("names only the public detail, never the desire", () => {
    const line = hangOutStopLine({ stopReason: "npc-approach", detail: { npc: "Role", desire: "SENTINEL-DESIRE" } });
    expect(line).toContain("Role");
    expect(line).not.toContain("SENTINEL-DESIRE");
  });
  it("pulled distinguishes the Diary Room from production, observed reads the kind", () => {
    expect(hangOutStopLine({ stopReason: "pulled", detail: { by: "diary-room" } })).toContain("Diary Room");
    expect(hangOutStopLine({ stopReason: "pulled", detail: { by: "production" } })).toContain("Production");
    expect(hangOutStopLine({ stopReason: "observed", detail: { kind: "overheard-whisper", who: ["A", "B"] } })).toContain("A and B");
    expect(hangOutStopLine({ stopReason: "observed", detail: { kind: "someone-moved", who: ["A"] } })).toContain("A is crossing");
  });
});

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

describe("hangOut on a live session", () => {
  it("every stop returns a stopLine; approach/pulled/bedtime each add exactly one public, player-witnessed event equal to it", () => {
    const recorded = new Set<string>();
    const lined = new Set<string>();
    for (let seed = 1; seed <= 120 && recorded.size < 3; seed++) {
      const g = parked(seed, `sl${seed}`); if (!g) continue;
      for (let i = 0; i < 14; i++) {
        const before = g.sb.engine.events.queryAll().length;
        const r = g.s.hangOut();
        if (!r.ok) break;
        expect(r.stopLine, `stopLine for ${r.stopReason}`).toBeTruthy();
        lined.add(r.stopReason!);
        if (r.stopReason === "npc-approach" || r.stopReason === "pulled" || r.stopReason === "bedtime") {
          const added = g.sb.engine.events.queryAll().slice(before);
          expect(added.filter((e) => e.content === r.stopLine).length, `one event for ${r.stopReason}`).toBe(1);
          const ev = added.find((e) => e.content === r.stopLine)!;
          expect(ev.witnessSet).toEqual([PLAYER]);
          expect(ev.hidden).toBe(false);
          expect(ev.content).not.toMatch(/npc:\d|\d\.\d/);
          recorded.add(r.stopReason);
        }
        if (r.stopReason === "event-due" || r.stopReason === "bedtime") break;
      }
    }
    expect(lined.size, "several stop kinds were reached").toBeGreaterThanOrEqual(2);
    expect(recorded.size, "at least one recorded kind was reached").toBeGreaterThanOrEqual(1);
  });
});
