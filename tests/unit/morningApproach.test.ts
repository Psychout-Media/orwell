import "../support/pinFlagsOff";
import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";

/**
 * A22 - NPCs may approach the player during the Day-1 social morning AFTER the toast (ORWELL_MORNING_APPROACH, default OFF), never during the entrances or the toast.
 * OFF => the approach gate is the first resolved ceremony beat only (byte-identical). Roles only.
 */
interface Live { hoh?: string; champagneCircle?: string; premiereEntrance?: { stage: string } }
function morning(seed: number, user: string, flag: boolean) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const sb = new GameSessionRegistry().sandboxFor(user);
  const s = sb.session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed });
  s.setPerConversationClockEnabled(true); s.setHangOutEnabled(true); s.setMorningApproachEnabled(flag);
  for (let i = 0; i < 40; i++) {
    const live = s.snapshot().live as unknown as Live;
    const st = s.getGameState() as { pending?: unknown; daySchedule?: { due: boolean } };
    if (live.champagneCircle !== "gathered" && (live as unknown as { timeOfDay?: string }).timeOfDay === "morning" && live.hoh === undefined && !st.pending && st.daySchedule?.due === false) return s;
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
  }
  return null;
}
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

function approachesInMorning(flag: boolean): { parked: number; approaches: number } {
  let parked = 0, approaches = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const s = morning(seed, `ma${flag}-${seed}`, flag);
    if (!s) continue;
    parked += 1;
    for (let i = 0; i < 6; i++) {
      const r = s.hangOut();
      if (r.stopReason === "npc-approach") { approaches += 1; break; }
      if (r.stopReason === "event-due" || r.stopReason === "bedtime") break;
    }
  }
  return { parked, approaches };
}

describe("A22 - NPC approaches in the Day-1 social morning", () => {
  it("OFF (default): no NPC approach before the first ceremony beat, on any seed", () => {
    const r = approachesInMorning(false);
    expect(r.parked, "the morning state was reached").toBeGreaterThan(20);
    expect(r.approaches).toBe(0);
  });
  it("ON: an NPC approach stops a morning hang-out on some seeds (the gate opens after the toast)", () => {
    const r = approachesInMorning(true);
    expect(r.parked).toBeGreaterThan(20);
    expect(r.approaches, "the flag lets approaches through").toBeGreaterThan(0);
  });
  it("the gate is closed during the toast (champagne circle gathered) and open once it is released", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("ma-toast").session as GameSessionAdapter;
    s.createCharacter({ playerName: "P", seed: 3 });
    s.setMorningApproachEnabled(true);
    const open = () => (s as unknown as { premiereSocialOpen(): boolean }).premiereSocialOpen();
    expect((s.snapshot().live as unknown as Live).champagneCircle).toBe("gathered");
    expect(open(), "closed while the whole house is gathered at the toast").toBe(false);
    s.advanceGame();
    s.advanceGame();
    expect((s.snapshot().live as unknown as Live).champagneCircle).not.toBe("gathered");
    expect(open(), "open after the toast is released").toBe(true);
  });
});
