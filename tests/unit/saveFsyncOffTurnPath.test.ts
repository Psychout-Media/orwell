import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, truncateSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore, resetSaveSyncLimiterForTests } from "../../src/adapters/engine/FileSaveStore";
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
  resetSaveSyncLimiterForTests();
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

  it("shutdown flush (async) fsyncs the newest version of every user and marks it durable", async () => {
    const dir = tmp();
    const s = controllableSync();
    const store = new FileSaveStore(dir, {
      fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {}, onError: () => {},
    });
    store.saveFor("u", snap(1));
    store.saveFor("u", snap(2)); // v1's sync is in flight, v2 is pending behind it
    store.saveFor("a", snap(1));
    store.saveFor("b", snap(1));
    s.calls.length = 0;
    const flushed = store.flushDurableAsync(10_000);
    await tick();
    // The flush asks for the NEWEST version of each user with a backlog, never an older one.
    expect(s.calls).toContain(vfile(dir, 2));
    expect(s.calls).not.toContain(vfile(dir, 1));
    for (let i = 0; i < 20; i++) { while (s.waiters.length) s.waiters.shift()!.resolve(); await tick(); }
    await flushed;
    expect(store.durability()).toMatchObject({ saveLatestVersion: 2, saveDurableVersion: 2, saveUnsyncedUsers: 0 });
  });

  it("shutdown flush is bounded: it resolves by its deadline even when no sync settles", async () => {
    const dir = tmp();
    const errors: string[] = [];
    const s = controllableSync(); // never settles
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {}, onError: (l) => errors.push(l) });
    store.saveFor("u", snap(1));
    const t0 = performance.now();
    await store.flushDurableAsync(60);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(errors.some((l) => l.includes("deadline"))).toBe(true);
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

const udir = (dir: string, user = "u") => join(dir, Buffer.from(user, "utf8").toString("hex"));
const onDisk = (dir: string, user = "u") =>
  readdirSync(udir(dir, user)).filter((f) => /^v\d+\.json$/.test(f)).map((f) => Number(f.slice(1, 7))).sort((a, b) => a - b);
/** Invariant at every step: the marker names a file that exists (so a fully synced save is on disk). */
function expectSyncedSaveOnDisk(store: FileSaveStore, dir: string, label: string) {
  const d = store.durability().saveDurableVersion;
  expect(d, `${label}: a durable version is known`).toBeGreaterThan(0);
  expect(existsSync(vfile(dir, d)), `${label}: durable marker v${d} must name an existing file`).toBe(true);
}
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };

describe("ORW-404 — the durable marker never names a pruned save", () => {
  it("a stalled sync that completes after many later saves never leaves the marker on a pruned file", async () => {
    const dir = tmp();
    const s = controllableSync();
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {} });
    store.saveFor("u", snap(1));
    s.waiters[0]!.resolve(); // v1 is the durable baseline
    await settle();
    expect(store.durability().saveDurableVersion).toBe(1);
    for (let i = 2; i <= 14; i++) { // v2's sync stalls; 12 later saves land
      store.saveFor("u", snap(i));
      expectSyncedSaveOnDisk(store, dir, `save ${i}`);
      expect(existsSync(vfile(dir, 1)), "the previously durable file stays until a newer one is durable").toBe(true);
    }
    expect(existsSync(vfile(dir, 2)), "a version whose fsync is in flight is never pruned").toBe(true);
    s.waiters[1]!.resolve(); // the stalled sync of v2 completes late
    await settle();
    expectSyncedSaveOnDisk(store, dir, "after the stalled sync completed");
    expect(store.durability().saveDurableVersion).toBe(2);
    store.saveFor("u", snap(15));
    expectSyncedSaveOnDisk(store, dir, "next prune");
    expect(existsSync(vfile(dir, 2)), "highest existing version <= durable is kept").toBe(true);
    s.waiters[s.waiters.length - 1]!.resolve();
    await settle();
    store.saveFor("u", snap(16));
    expectSyncedSaveOnDisk(store, dir, "after the newest synced");
    expect(store.durability().saveDurableVersion).toBeGreaterThan(2);
  });

  it("20 saves during one 30 s stalled sync, then it completes, then more saves", async () => {
    const dir = tmp();
    const s = controllableSync();
    let clock = 0;
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {}, nowMs: () => clock });
    store.saveFor("u", snap(1));
    s.waiters[0]!.resolve();
    await settle();
    store.saveFor("u", snap(2)); // this sync stalls for 30 s
    for (let i = 3; i <= 22; i++) {
      clock += 1500;
      store.saveFor("u", snap(i));
      expectSyncedSaveOnDisk(store, dir, `stall save ${i}`);
    }
    expect(store.durability().saveOldestUnsyncedAgeMs).toBeGreaterThanOrEqual(30_000);
    s.waiters[1]!.resolve(); // 30 s later
    await settle();
    expectSyncedSaveOnDisk(store, dir, "stall ended");
    for (let i = 23; i <= 30; i++) {
      store.saveFor("u", snap(i));
      expectSyncedSaveOnDisk(store, dir, `after save ${i}`);
      s.waiters[s.waiters.length - 1]!.resolve();
      await settle();
      expectSyncedSaveOnDisk(store, dir, `after sync ${i}`);
    }
    // A power loss now: everything newer than the marker may be torn; the marker's file is whole.
    const d = store.durability().saveDurableVersion;
    for (const v of onDisk(dir)) if (v > d) truncateSync(vfile(dir, v), 0);
    expect((new FileSaveStore(dir).loadLatest("u") as unknown as { week: number }).week).toBeGreaterThanOrEqual(d);
  });
});

describe("ORW-404 — boot does not assume the on-disk tail is durable", () => {
  it("kicks a sync of the newest on-disk version and prunes nothing from boot until one fsync completed", async () => {
    const dir = tmp();
    const first = new FileSaveStore(dir, { fsyncMode: "sync" });
    for (let i = 1; i <= 3; i++) first.saveFor("u", snap(i));
    const s = controllableSync();
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {} });
    store.saveFor("u", snap(4));
    expect(s.calls[0], "the newest version on disk at boot is synced first").toBe(vfile(dir, 3));
    expect(store.durability().saveDurableVersion).toBe(0);
    for (let i = 5; i <= 14; i++) store.saveFor("u", snap(i));
    for (const v of [1, 2, 3]) expect(existsSync(vfile(dir, v)), `boot version v${v} kept while nothing is known durable`).toBe(true);
    s.waiters[0]!.resolve();
    await settle();
    expect(store.durability().saveDurableVersion).toBe(3);
    store.saveFor("u", snap(15));
    expect(existsSync(vfile(dir, 3)), "the synced boot version is the kept synced save").toBe(true);
    expect(existsSync(vfile(dir, 1)), "after one fsync completed the normal rule applies").toBe(false);
  });
});

describe("ORW-404 — global cap on background fsyncs", () => {
  it("never runs more than 2 at once across users with a durable version; newest version per user wins; queue is fair", async () => {
    const dir = tmp();
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    const waiters: (() => void)[] = [];
    const syncFile = (path: string) => new Promise<void>((resolve) => {
      calls.push(path); active++; maxActive = Math.max(maxActive, active);
      waiters.push(() => { active--; resolve(); });
    });
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile, syncDir: async () => {} });
    const users = ["a", "b", "c", "d", "e"];
    // Prime: every user gets a durable v1 (a never-synced user may use one extra slot; see the
    // never-synced tests), so the cap below is the plain cap of 2.
    for (const u of users) store.saveFor(u, snap(1));
    for (let i = 0; i < 20; i++) { waiters.splice(0).forEach((w) => w()); await settle(); }
    calls.length = 0; maxActive = 0;
    for (const u of users) store.saveFor(u, snap(2));
    store.saveFor("a", snap(3));
    store.saveFor("a", snap(4)); // a's pending coalesces to the newest
    expect(calls).toHaveLength(2);
    const vf = (u: string, v: number) => join(udir(dir, u), `v${String(v).padStart(6, "0")}.json`);
    expect(calls).toEqual([vf("a", 2), vf("b", 2)]);
    waiters.shift()!(); await settle(); // a finishes: c (waiting longer) goes before a's newest
    expect(calls[2]).toBe(vf("c", 2));
    waiters.shift()!(); await settle();
    expect(calls[3]).toBe(vf("d", 2));
    for (let i = 0; i < 20; i++) { waiters.splice(0).forEach((w) => w()); await settle(); }
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(calls.filter((c) => c.startsWith(udir(dir, "a")))).toEqual([vf("a", 2), vf("a", 4)]);
    for (const u of users) expect(existsSync(vf(u, u === "a" ? 4 : 2))).toBe(true);
    expect(store.durability().saveUnsyncedUsers).toBe(0);
  });
});

describe("ORW-404 — failures inside the sync handlers", () => {
  it("a throwing stall-timer sink never becomes an unhandled rejection and later saves still sync", async () => {
    const dir = tmp();
    const seen: unknown[] = [];
    const onRej = (e: unknown) => { seen.push(e); };
    process.on("unhandledRejection", onRej);
    try {
      const real = new StallTimer(() => {});
      setStallTimerForTests({
        now: () => real.now(),
        record: (name: string, ...rest: unknown[]) => {
          if (name === "save.fsync") throw new Error("sink exploded");
          (real.record as (...a: unknown[]) => void)(name, ...rest);
        },
        snapshot: () => real.snapshot(),
      } as unknown as StallTimer);
      const errors: string[] = [];
      const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: async () => {}, syncDir: async () => {}, onError: (l) => errors.push(l) });
      expect(() => store.saveFor("u", snap(1))).not.toThrow();
      await settle();
      store.saveFor("u", snap(2));
      await settle();
      expect(seen).toEqual([]);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(store.durability().saveDurableVersion).toBe(2);
    } finally { process.off("unhandledRejection", onRej); }
  });

  it("a directory fsync failure still marks the file durable and the directory sync is retried with the next save", async () => {
    const dir = tmp();
    const errors: string[] = [];
    const dirCalls: string[] = [];
    let failDir = false; // the new-directory syncs of the first save are not under test here
    const store = new FileSaveStore(dir, {
      fsyncMode: "background", syncFile: async () => {}, onError: (l) => errors.push(l),
      syncDir: async (p) => { dirCalls.push(p); if (failDir) { failDir = false; throw Object.assign(new Error("EIO"), { code: "EIO" }); } },
    });
    for (let i = 1; i <= 49; i++) { store.saveFor("u", snap(i)); await settle(); }
    dirCalls.length = 0;
    failDir = true;
    store.saveFor("u", snap(50)); // checkpoint: file sync then directory sync
    await settle();
    expect(dirCalls).toHaveLength(1);
    expect(store.durability().saveDurableVersion, "the file is durable even though the directory sync failed").toBe(50);
    expect(errors.some((l) => l.includes("save.dirsync"))).toBe(true);
    store.saveFor("u", snap(51));
    await settle();
    expect(dirCalls, "retried with the next save").toHaveLength(2);
  });
});

describe("ORW-404 — default (background) mode power-loss safety", () => {
  const reboot = (dir: string) => new FileSaveStore(dir, { fsyncMode: "sync" });
  const weekOf = (x: unknown) => (x as { week: number }).week;

  it("power loss after the rename but before the fsync: load finds the previous good version", async () => {
    const dir = tmp();
    const s = controllableSync();
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {} });
    store.saveFor("u", snap(1));
    store.saveFor("u", snap(2)); // pending
    s.waiters[0]!.resolve();
    await settle();
    s.waiters[1]!.resolve();
    await settle();
    store.saveFor("u", snap(3)); // renamed, its fsync never happens (stalled)
    writeFileSync(vfile(dir, 3), ""); // power loss: the unsynced rename target is empty on disk
    const after = reboot(dir);
    expect(weekOf(after.loadLatest("u"))).toBe(2);
    expect(onDisk(dir).includes(3)).toBe(false); // quarantined, never "latest" again
  });

  it("power loss mid-stall with several unsynced versions: the unsynced tail is torn, a synced save loads", async () => {
    const dir = tmp();
    const s = controllableSync();
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {} });
    store.saveFor("u", snap(1));
    s.waiters[0]!.resolve();
    await settle();
    for (let i = 2; i <= 9; i++) store.saveFor("u", snap(i)); // all unsynced, sync stalled
    const durable = store.durability().saveDurableVersion;
    expect(durable).toBe(1);
    let n = 0;
    for (const v of onDisk(dir)) {
      if (v <= durable) continue;
      if (n++ % 2 === 0) truncateSync(vfile(dir, v), 0);
      else writeFileSync(vfile(dir, v), readFileSync(vfile(dir, v), "utf8").slice(0, 7)); // torn half-write
    }
    const after = reboot(dir);
    const loaded = after.loadLatest("u");
    expect(loaded).not.toBeNull();
    expect(weekOf(loaded)).toBe(1);
  });
});
