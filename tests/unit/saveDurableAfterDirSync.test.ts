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

  it("sync mode: a failed directory fsync does not advance the marker and is retried by the flush (review of #2747)", () => {
    let fail = true;
    const errors: string[] = [];
    const store = new FileSaveStore(tmp(), {
      fsyncMode: "sync", onError: (m: string) => { errors.push(m); },
      syncDirSync: () => { if (fail) throw Object.assign(new Error("EIO"), { code: "EIO" }); },
    });
    store.saveFor("u", snap(1)); // new directory: its entries are owed
    expect(store.durability().saveDurableVersion).toBe(0);
    expect(errors.length).toBeGreaterThan(0);
    fail = false;
    store.flushDurable(1000);
    expect(store.durability().saveDurableVersion).toBe(1);
  });

  it("sync mode: the first save after a restart in an existing directory syncs both entries (review of #2744)", () => {
    const data = tmp();
    new FileSaveStore(data, { fsyncMode: "sync", syncDirSync: () => {} }).saveFor("u", snap(1));
    const calls: string[] = [];
    const restarted = new FileSaveStore(data, { fsyncMode: "sync", syncDirSync: (p: string) => { calls.push(p); } });
    restarted.saveFor("u", snap(2)); // not a checkpoint, directory exists, but first save since boot
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(data);
    calls.length = 0;
    restarted.saveFor("u", snap(3));
    expect(calls).toEqual([]);
  });

  it("the unsynced backlog keeps counting past the tracking cap (review of #2747)", () => {
    const lines: string[] = [];
    let t = 0;
    const store = new FileSaveStore(tmp(), {
      fsyncMode: "background", syncFile: () => new Promise<void>(() => {}), syncDir: async () => {},
      onError: (m: string) => { lines.push(m); }, backlogAlarmMs: 1, nowMs: () => (t += 10),
    });
    for (let i = 1; i <= 1100; i++) store.saveFor("u", snap(i));
    const last = lines.filter((l) => l.includes("save.durability behind")).pop()!;
    expect(Number(/, (\d+) unsynced/.exec(last)![1])).toBeGreaterThan(1050);
  });
});
