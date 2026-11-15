import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore, resetSaveSyncLimiterForTests } from "../../src/adapters/engine/FileSaveStore";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

/** Review of #2747 (P1): the durable marker moves only AFTER the directory fsync succeeded. */
const snap = (n: number): SessionSnapshot => ({ started: true, week: n, events: [] }) as unknown as SessionSnapshot;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "orw-durdir-")); dirs.push(d); return d; };
afterEach(() => { resetSaveSyncLimiterForTests(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r)); };

describe("background save: the durable marker waits for the directory fsync", () => {
  it("a directory fsync still in flight leaves the save not durable; completing it makes it durable", async () => {
    const releases: Array<() => void> = [];
    const store = new FileSaveStore(tmp(), {
      fsyncMode: "background", syncFile: async () => {}, onError: () => {},
      syncDir: () => new Promise<void>((r) => { releases.push(r); }),
    });
    store.saveFor("u", snap(1)); // first save: directory + parent entries owed
    await settle();
    expect(releases.length).toBeGreaterThan(0);
    expect(store.durability().saveDurableVersion).toBe(0);
    while (releases.length) { releases.shift()!(); await settle(); }
    expect(store.durability().saveDurableVersion).toBe(1);
  });

  it("a failed directory fsync never reports the save durable", async () => {
    const errors: string[] = [];
    const store = new FileSaveStore(tmp(), {
      fsyncMode: "background", syncFile: async () => {}, onError: (m: string) => { errors.push(m); },
      syncDir: async () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); },
    });
    store.saveFor("u", snap(1));
    await settle();
    expect(errors.some((m) => m.includes("dirsync") || m.includes("parentsync"))).toBe(true);
    expect(store.durability().saveDurableVersion).toBe(0);
    // the data is still on disk and loads
    expect(store.loadLatest("u")).toBeTruthy();
  });
});
