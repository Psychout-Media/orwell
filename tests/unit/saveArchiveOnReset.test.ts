import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";

/**
 * ORW-783 - a season restart keeps the dead season: the player door (`createCharacter` + `confirmRestart`) converges on `registry.resetUser`, which moves the user's saves into a dated archive
 * folder (`<dataDir>/save-archive/<hex-user>/<stamp>`) instead of leaving them beside the live dirs, capped per user and pruned oldest first. Real path: a played game, the real restart door, the
 * real files on disk. Per user (a second user's saves are never touched). Roles only.
 */
const hex = (u: string): string => Buffer.from(u, "utf8").toString("hex");
const archiveOf = (dir: string, u: string): string[] => { const p = join(dir, "save-archive", hex(u)); return existsSync(p) ? readdirSync(p).sort() : []; };
const prevCap = process.env.ORWELL_SAVE_ARCHIVE_MAX_MB;
afterEach(() => { if (prevCap === undefined) delete process.env.ORWELL_SAVE_ARCHIVE_MAX_MB; else process.env.ORWELL_SAVE_ARCHIVE_MAX_MB = prevCap; });

async function seasonThenRestart(rt: ReturnType<typeof composeRuntime>, user: string, seed: number, restart: boolean): Promise<void> {
  const mcp = rt.registry.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, ...(restart ? { confirmRestart: true } : {}) });
  for (let i = 0; i < 4; i++) await mcp.callTool("advanceGame", {});
}

describe("a season restart archives the dead season's saves (real restart door, real files)", () => {
  it("the previous save is in the user's dated archive afterwards, readable, and nobody else's dir moved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orwell-783-"));
    const rt = composeRuntime({ saveStore: new FileSaveStore(dir), clock: new FakeClock() });
    await seasonThenRestart(rt, "user-a", 11, false);
    await seasonThenRestart(rt, "user-b", 12, false);
    const aLive = join(dir, hex("user-a"));
    const aFiles = readdirSync(aLive).filter((f) => /^v\d+\.json$/.test(f));
    expect(aFiles.length).toBeGreaterThan(0);
    const aLatest = readFileSync(join(aLive, aFiles.sort().at(-1)!), "utf8");
    const bBefore = readdirSync(join(dir, hex("user-b"))).sort();

    await seasonThenRestart(rt, "user-a", 21, true); // the one restart door

    const kept = archiveOf(dir, "user-a");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // a dated folder
    const archived = readdirSync(join(dir, "save-archive", hex("user-a"), kept[0]!)).filter((f) => /^v\d+\.json$/.test(f)).sort();
    expect(readFileSync(join(dir, "save-archive", hex("user-a"), kept[0]!, archived.at(-1)!), "utf8")).toBe(aLatest); // the dead season's last save, byte for byte
    expect(archiveOf(dir, "user-b")).toEqual([]); // never across users
    expect(readdirSync(join(dir, hex("user-b"))).sort()).toEqual(bBefore); // the other user's live saves untouched
    expect(readdirSync(dir).filter((n) => n.includes(".retired-"))).toEqual([]); // no loose retired dir beside the live ones
    // the archive is not a user: it never shows up as one
    expect(new FileSaveStore(dir).listUsers().sort()).toEqual(["user-a", "user-b"]);
  }, 120_000);

  it("the cap prunes the oldest archived season first and always keeps the newest", async () => {
    process.env.ORWELL_SAVE_ARCHIVE_MAX_MB = "0.001"; // about 1 KB: every season is over it
    const dir = mkdtempSync(join(tmpdir(), "orwell-783-cap-"));
    const rt = composeRuntime({ saveStore: new FileSaveStore(dir), clock: new FakeClock() });
    await seasonThenRestart(rt, "user-a", 11, false);
    await seasonThenRestart(rt, "user-a", 12, true);
    const first = archiveOf(dir, "user-a");
    expect(first).toHaveLength(1);
    await seasonThenRestart(rt, "user-a", 13, true);
    const second = archiveOf(dir, "user-a");
    expect(second).toHaveLength(1); // the cap pruned the older one
    expect(second[0]).not.toBe(first[0]); // and what is left is the newer season
    expect(statSync(join(dir, "save-archive", hex("user-a"), second[0]!)).isDirectory()).toBe(true);
  }, 120_000);

  it("with room under the cap, every restart is kept (oldest first in the listing)", async () => {
    delete process.env.ORWELL_SAVE_ARCHIVE_MAX_MB;
    const dir = mkdtempSync(join(tmpdir(), "orwell-783-room-"));
    const rt = composeRuntime({ saveStore: new FileSaveStore(dir), clock: new FakeClock() });
    await seasonThenRestart(rt, "user-a", 11, false);
    await seasonThenRestart(rt, "user-a", 12, true);
    await seasonThenRestart(rt, "user-a", 13, true);
    const kept = archiveOf(dir, "user-a");
    expect(kept).toHaveLength(2);
    expect([...kept].sort()).toEqual(kept);
  }, 120_000);
});
