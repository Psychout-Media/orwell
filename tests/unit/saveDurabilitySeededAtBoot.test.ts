import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore, resetSaveSyncLimiterForTests } from "../../src/adapters/engine/FileSaveStore";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

/** ORW-1092: after a restart the durability report covers every save on disk, not only the users who have saved since. Roles only. */
const snap = (n: number): SessionSnapshot => ({ started: true, week: n, events: [] }) as unknown as SessionSnapshot;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "orw1092-")); dirs.push(d); return d; };
afterEach(() => {
  resetSaveSyncLimiterForTests();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };
const quiet = { fsyncMode: "background" as const, syncDir: async () => {}, onError: () => {} };

describe("ORW-1092: the save-durability report is seeded from the save dirs at boot", () => {
  it("a restarted store reports the versions on disk, owed until hardened, without any new save", async () => {
    const dir = tmp();
    const before = new FileSaveStore(dir, { ...quiet, syncFile: async () => {} });
    for (let i = 1; i <= 3; i++) before.saveFor("player", snap(i));
    await settle();
    resetSaveSyncLimiterForTests();

    const waiting: Array<() => void> = [];
    const after = new FileSaveStore(dir, { ...quiet, syncFile: () => new Promise<void>((ok) => { waiting.push(ok); }) });
    expect(after.durability().saveLatestVersion, "the blind report: nothing until a save").toBe(0);
    after.seedDurabilityFromDisk();
    expect(after.durability()).toMatchObject({ saveLatestVersion: 3, saveDurableVersion: 0, saveUnsyncedUsers: 1, saveDurabilityPending: true });
    waiting.splice(0).forEach((ok) => ok());
    await settle();
    expect(after.durability()).toMatchObject({ saveLatestVersion: 3, saveDurableVersion: 3, saveUnsyncedUsers: 0, saveDurabilityPending: false });

    after.saveFor("player", snap(4));
    expect(after.durability().saveLatestVersion, "the next save carries on from what is on disk").toBe(4);
  });

  it("ignores what is not a user's save dir, and a data dir that does not exist yet", () => {
    const dir = tmp();
    mkdirSync(join(dir, "season-archive"));
    mkdirSync(join(dir, "abcd")); // a hex-named dir with no versions
    writeFileSync(join(dir, "ef01"), "a stray file with a hex name");
    const store = new FileSaveStore(dir, quiet);
    expect(() => store.seedDurabilityFromDisk()).not.toThrow();
    expect(store.durability()).toMatchObject({ saveLatestVersion: 0, saveUnsyncedUsers: 0 });
    expect(() => new FileSaveStore(join(dir, "not-there"), quiet).seedDurabilityFromDisk()).not.toThrow();
  });
});
