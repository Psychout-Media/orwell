import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";
import { PLAYER, type EntityId } from "../../src/domain/ids";

/**
 * ORW-1089 (Ryne 2026-11-27): a bare "next" with nothing due fast-forwards, "ending as soon as a new person enters. Or game talk starts, or something similar. Whenever the player is prompted."
 * REAL PATH: a played game held on its schedule, the engine's own lever. Roles only.
 */
interface Inside { presence: Map<EntityId, string> | null; names?: unknown }

describe("ORW-1089: the bare-next fast-forward", () => {
  it("stops only on something that calls for the player, and a newcomer it names really is in the room and was not before", () => {
    const reasons = new Map<string, number>();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const g = playedGame({ seed });
      const inside = g.s as unknown as Inside;
      for (let t = 0; t < 400; t++) {
        const v = g.turn();
        if (v.finished) break;
        if (!(v.held && v.held.reason === "schedule" && !v.pending)) continue;
        if ((g.s.getGameState().daySchedule?.minutesUntil ?? 0) < 90) continue;
        g.s.noteMessage({ messageId: `bare-next-${seed}-${t}` });
        const room = inside.presence!.get(PLAYER)!;
        const before = [...inside.presence!].filter(([, r]) => r === room).map(([id]) => id);
        const r = g.s.hangOut({ bareNext: true });
        if (!r.ok) continue;
        const key = r.stopReason === "observed" ? `observed:${r.detail?.kind}` : String(r.stopReason);
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
        if (key === "max-beats") expect(r.minutes, "a time-out only when the event is more than the ten-hour cap away").toBeGreaterThanOrEqual(590);
        else expect(key, "never a random production pull or a mere passer-by").toMatch(/^(event-due|npc-approach|bedtime|observed:(someone-entered|overheard-whisper|argument))$/);
        if (r.detail?.kind === "someone-entered") {
          const now = [...inside.presence!].filter(([, where]) => where === inside.presence!.get(PLAYER)).map(([id]) => id);
          expect(inside.presence!.get(PLAYER), "the player did not move").toBe(room);
          const newcomers = now.filter((id) => !before.includes(id));
          expect(newcomers.length).toBeGreaterThan(0);
        }
        if ([...reasons.values()].reduce((a, b) => a + b, 0) >= seed * 5) break;
      }
    }
    expect([...reasons.values()].reduce((a, b) => a + b, 0), `stops seen: ${JSON.stringify([...reasons])}`).toBeGreaterThanOrEqual(4);
    expect(reasons.has("observed:someone-entered"), `somebody walks in on at least one seed: ${JSON.stringify([...reasons])}`).toBe(true);
  }, 600_000);
});
