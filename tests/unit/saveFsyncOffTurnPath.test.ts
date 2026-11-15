import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { StallTimer, setStallTimerForTests, stallTimer } from "../../src/adapters/stallTiming";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

/**
 * ORW-404 — the save's fsync runs off the request path. The sync function is injected, so no real
 * slow disk is needed. Roles only.
 */
const snap = (n: number): SessionSnapshot => ({ started: true, week: n, events: [] }) as unknown as SessionSnapshot;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "orw404-")); dirs.push(d); return d; };
const original = stallTimer;
afterEach(() => {
  setStallTimerForTests(original);
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tick = () => new Promise<void>((r) => setImmediate(r));

/** A sync function whose completion the test controls (a "5 second" disk without waiting). */
function controllableSync() {
  const calls: string[] = [];
  const waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const syncFile = (path: string) => new Promise<void>((resolve, reject) => {
    calls.push(path);
    waiters.push({ resolve, reject });
  });
  return { calls, waiters, syncFile };
}

const vfile = (dir: string, v: number) =>
  join(dir, Buffer.from("u", "utf8").toString("hex"), `v${String(v).padStart(6, "0")}.json`);

describe("ORW-404 — background fsync", () => {
  it("save() returns fast while the sync is slow, and the new version is immediately readable", () => {
    const dir = tmp();
    const s = controllableSync(); // never resolves: a stalled disk
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {} });
    const t0 = performance.now();
    store.saveFor("u", snap(1));
    expect(performance.now() - t0).toBeLessThan(50);
    expect((store.loadLatest("u") as unknown as { week: number }).week).toBe(1);
    expect(s.calls).toHaveLength(1);
    expect(store.durability().saveLatestVersion).toBe(1);
    expect(store.durability().saveDurableVersion).toBe(0);
  });

  it("three saves during one slow sync make exactly two sync calls (in-flight, then the newest)", async () => {
    const dir = tmp();
    const s = controllableSync();
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {} });
    store.saveFor("u", snap(1));
    store.saveFor("u", snap(2));
    store.saveFor("u", snap(3));
    expect(s.calls).toEqual([vfile(dir, 1)]);
    s.waiters[0]!.resolve();
    await tick(); await tick();
    expect(s.calls).toEqual([vfile(dir, 1), vfile(dir, 3)]);
    expect(store.durability().saveDurableVersion).toBe(1);
    s.waiters[1]!.resolve();
    await tick(); await tick();
    expect(s.calls).toHaveLength(2);
    const d = store.durability();
    expect(d).toMatchObject({ saveLatestVersion: 3, saveDurableVersion: 3, saveOldestUnsyncedAgeMs: 0 });
  });

  it("pruning keeps the newest durable version while a newer one is not yet durable", async () => {
    const dir = tmp();
    const s = controllableSync();
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {} });
    store.saveFor("u", snap(1));
    s.waiters[0]!.resolve(); // v1 durable
    await tick(); await tick();
    for (let i = 2; i <= 12; i++) store.saveFor("u", snap(i)); // v2 sync stays in flight
    expect(store.durability().saveDurableVersion).toBe(1);
    expect(existsSync(vfile(dir, 1)), "newest durable version must survive pruning").toBe(true);
    expect(existsSync(vfile(dir, 12))).toBe(true);
    expect(existsSync(vfile(dir, 3)), "an ordinary old version is still pruned").toBe(false);
  });

  it("shutdown flush fsyncs the newest version synchronously, bounded by the deadline", () => {
    const dir = tmp();
    const s = controllableSync();
    const synced: string[] = [];
    let clock = 0;
    const store = new FileSaveStore(dir, {
      fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {},
      syncFileSync: (p) => { synced.push(p); clock += 6_000; }, nowMs: () => clock,
      onError: () => {},
    });
    store.saveFor("u", snap(1));
    store.saveFor("u", snap(2));
    store.flushDurable(10_000);
    expect(synced).toEqual([vfile(dir, 2)]);
    expect(store.durability()).toMatchObject({ saveLatestVersion: 2, saveDurableVersion: 2, saveUnsyncedUsers: 0 });

    // Bounded: with two users and each sync costing 6 s, the 10 s budget stops the second.
    store.saveFor("a", snap(1));
    store.saveFor("b", snap(1));
    synced.length = 0;
    store.flushDurable(10_000);
    expect(synced).toHaveLength(2); // first at t=0 (->6s), second at 6s (<10s) runs; budget then spent
    store.saveFor("c", snap(1));
    store.saveFor("d", snap(1));
    store.saveFor("e", snap(1));
    synced.length = 0;
    store.flushDurable(10_000);
    expect(synced.length).toBeLessThan(3);
  });

  it("a failing sync is logged once, never throws into save(), and the next save retries", async () => {
    const dir = tmp();
    const errors: string[] = [];
    let n = 0;
    const calls: string[] = [];
    const store = new FileSaveStore(dir, {
      fsyncMode: "background", syncDir: async () => {}, onError: (l) => errors.push(l),
      syncFile: async (p) => { calls.push(p); if (++n === 1) throw Object.assign(new Error("EIO"), { code: "EIO" }); },
    });
    expect(() => store.saveFor("u", snap(1))).not.toThrow();
    await tick(); await tick();
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain(dir);
    expect(store.durability().saveDurableVersion).toBe(0);
    expect((store.loadLatest("u") as unknown as { week: number }).week).toBe(1);
    store.saveFor("u", snap(2));
    await tick(); await tick();
    expect(calls).toEqual([vfile(dir, 1), vfile(dir, 2)]);
    expect(store.durability()).toMatchObject({ saveDurableVersion: 2, saveOldestUnsyncedAgeMs: 0 });
    expect(errors).toHaveLength(1);
  });

  it("records a slow background fsync as one SLOW line through the stall timer", async () => {
    const dir = tmp();
    const lines: string[] = [];
    let t = 0;
    setStallTimerForTests(new StallTimer((l) => lines.push(l), () => (t += 400), () => 500));
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: async () => { t += 1000; }, syncDir: async () => {} });
    store.saveFor("u", snap(1));
    await tick(); await tick();
    expect(lines.filter((l) => l.includes("step=save.fsync"))).toHaveLength(1);
  });

  it("reports the age of the oldest un-synced save", () => {
    const dir = tmp();
    const s = controllableSync();
    let clock = 1000;
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {}, nowMs: () => clock });
    store.saveFor("u", snap(1));
    clock = 4000;
    expect(store.durability().saveOldestUnsyncedAgeMs).toBe(3000);
  });

  it("ORWELL_SAVE_FSYNC=sync restores the blocking fsync before the rename and starts no background sync", () => {
    const dir = tmp();
    const prev = process.env.ORWELL_SAVE_FSYNC;
    process.env.ORWELL_SAVE_FSYNC = "sync";
    try {
      const s = controllableSync();
      const store = new FileSaveStore(dir, { syncFile: s.syncFile });
      store.saveFor("u", snap(1));
      expect(s.calls).toHaveLength(0);
      expect(store.durability()).toMatchObject({ saveLatestVersion: 1, saveDurableVersion: 1 });
    } finally {
      if (prev === undefined) delete process.env.ORWELL_SAVE_FSYNC; else process.env.ORWELL_SAVE_FSYNC = prev;
    }
  });
});
