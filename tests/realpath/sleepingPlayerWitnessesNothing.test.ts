import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { playedGame } from "../support/playedGame";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * ORW-940 (a playtest: "go back to sleep until the house is up" in the early morning, with houseguests around): a sleeping player witnesses nothing that happens in the house while they sleep. REAL PATH: a
 * season is played until the player is up before the house after an early bed; then `turnIn` (the doze back to the wake-up call) with the off-screen turn it commits. Every event recorded from then to the
 * wake-up is checked: none with the player in its witness set carries another houseguest. Roles only.
 */
type Priv = { live: { wakeHour?: number; nightDepth?: number; timeOfDay?: string; playerRetired?: boolean; week: number }; };

function upBeforeTheHouse(seed: number, sandbox: string) {
  const g = playedGame({ seed, user: sandbox });
  const live = () => (g.s as unknown as Priv).live;
  g.playUntil(() => (g.s.getGameState() as { phase: string }).phase !== "premiere" && !g.s.getGameState().pending, 2000, "the premiere over");
  for (let i = 0; i < 300 && live().timeOfDay !== "night"; i++) g.s.noteMessage({ messageId: `night-${i}` });
  if (live().timeOfDay !== "night" || g.s.getGameState().pending) return undefined;
  g.s.turnIn();
  for (let i = 0; i < 6; i++) {
    const l = live();
    if (l.wakeHour !== undefined && l.timeOfDay === "morning" && !l.playerRetired && l.nightDepth !== undefined && l.nightDepth < 8 && !g.s.getGameState().pending) return g;
    g.s.noteMessage({ messageId: `wake-${i}` });
  }
  return undefined;
}

describe("a sleeping player witnesses nothing (played)", () => {
  it("dozing back to the wake-up call records no scene the player saw", () => {
    const f = firstSeedWhereSync((seed, sandbox) => upBeforeTheHouse(seed, sandbox), { from: 1, to: 12, hint: [1, 2], sandbox: (s) => `slp940-${s}`, what: "the player up before the house after an early bed" });
    const g = f.at;
    const live = () => (g.s as unknown as Priv).live;
    const before = new Set(g.sb.engine.events.queryAll().map((e) => e.id));
    const view = g.s.turnIn() as { held?: unknown };
    expect(view.held, "the doze was not held").toBeUndefined();
    expect(live().nightDepth, "asleep until the wake-up call").toBe(8);
    const seen = g.sb.engine.events.queryAll().filter((e) => !before.has(e.id) && e.witnessSet.includes(PLAYER) && e.witnessSet.some((w) => w !== PLAYER));
    expect(seen.map((e) => `${e.type}: ${String(e.content)}`), "scenes the sleeping player witnessed").toEqual([]);
  }, 600_000);

  it("a daytime nap in a busy room records only the others seeing the nap, never a scene the sleeper heard", () => {
    const f = firstSeedWhereSync((seed, sandbox) => {
      const g = playedGame({ seed, user: sandbox });
      const s = g.s as unknown as { presence: Map<string, string>; live: { timeOfDay?: string; hoh?: string; nightDepth?: number } };
      for (let i = 0; i < 4000; i++) {
        const st = g.s.getGameState() as { phase: string; pending?: unknown };
        const here = s.presence?.get(PLAYER);
        const company = here ? [...s.presence].filter(([id, r]) => id !== PLAYER && r === here && /^bedroom/.test(r)).length : 0;
        if (st.phase !== "premiere" && !st.pending && company >= 2 && (s.live.timeOfDay === "morning" || s.live.timeOfDay === "afternoon") && (s.live.nightDepth ?? 0) >= 9) {
          const before = new Set(g.sb.engine.events.queryAll().map((e) => e.id));
          const v = g.s.nap({ hours: 2 }) as { ok: boolean };
          if (v.ok) return { g, before };
        }
        g.turn();
      }
      return undefined;
    }, { from: 1, to: 12, hint: [1, 2], sandbox: (x) => `slp940n-${x}`, what: "a nap taken in a bedroom with company" });
    const { g, before } = f.at;
    const seen = g.sb.engine.events.queryAll().filter((e) => !before.has(e.id) && e.witnessSet.includes(PLAYER) && e.witnessSet.some((w) => w !== PLAYER) && !/was napping in the/.test(String(e.content)));
    expect(seen.map((e) => `${e.type}: ${String(e.content)}`), "scenes the napping player witnessed").toEqual([]);
  }, 600_000);
});
