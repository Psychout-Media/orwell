import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { composeRuntime } from "../../src/composition/runtime";

/**
 * ORW-921: a season started with an explicit seed (a test or a replay) is fixed by that seed alone. A confirmed restart carries the dead season's cast names, house theme and world picks into the next cast (NAME-1, ORW-466, ORW-509)
 * so a PLAYER's next season differs; a seeded restart on the same stack must not, or the same seed plays a different season after other seasons than it does first. Plays seed N first on a fresh stack, then seed N
 * again after other seeds were restarted through (the same door the front end's new-game uses), and compares the dealt cast, the house theme and the opening state. Roles only: only hashes are compared.
 */
const SEEDS = [5, 3, 8];
const call = (rt: ReturnType<typeof composeRuntime>, user: string, name: string, args: Record<string, unknown>) => rt.registry.resolver()("player", user).callTool(name, args) as Promise<any>;
const fingerprint = async (rt: ReturnType<typeof composeRuntime>, user: string, started: unknown): Promise<string> => {
  const sess: any = rt.registry.sandboxFor(user).session;
  const house = (sess.house?.npcs ?? sess.house ?? []) as unknown;
  const snap = { started, house, theme: sess.live?.houseTheme, state: await call(rt, user, "getGameState", {}) };
  return createHash("sha1").update(JSON.stringify(snap)).digest("hex").slice(0, 16);
};

describe("ORW-921: a seeded season is the same alone as after other seasons on the same stack", () => {
  it("the same seed deals the same season first on a fresh stack and after other seeded restarts", async () => {
    const alone = new Map<number, string>();
    for (const s of SEEDS) {
      const rt = composeRuntime({ seed: s });
      const r = await call(rt, "u", "createCharacter", { playerName: "The Player", seed: s });
      alone.set(s, await fingerprint(rt, "u", r?.started));
    }
    const after = new Map<number, string>();
    for (const s of SEEDS) {
      const rt = composeRuntime({ seed: s });
      let first = true;
      for (const other of SEEDS.filter((x) => x !== s)) {
        await call(rt, "u", "createCharacter", { playerName: "The Player", seed: other, isolateSeason: true, ...(first ? {} : { confirmRestart: true }) });
        first = false;
      }
      const r = await call(rt, "u", "createCharacter", { playerName: "The Player", seed: s, isolateSeason: true, confirmRestart: true });
      after.set(s, await fingerprint(rt, "u", r?.started));
    }
    for (const s of SEEDS) expect(after.get(s), `seed ${s} after other seeded restarts`).toBe(alone.get(s));
  }, 120_000);
});
