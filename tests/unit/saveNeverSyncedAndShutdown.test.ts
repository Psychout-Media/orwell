import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore, resetSaveSyncLimiterForTests } from "../../src/adapters/engine/FileSaveStore";
import { createShutdown } from "../../src/composition/shutdown";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

/** ORW-404 review round 3: never-synced users, bounded shutdown, backlog alarm. Roles only. */
const snap = (n: number): SessionSnapshot => ({ started: true, week: n, events: [] }) as unknown as SessionSnapshot;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "orw404c-")); dirs.push(d); return d; };
afterEach(() => {
  resetSaveSyncLimiterForTests();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };
const hex = (u: string) => Buffer.from(u, "utf8").toString("hex");
const versionsOf = (dir: string, u: string) =>
  readdirSync(join(dir, hex(u))).filter((f) => /^v\d+\.json$/.test(f)).map((f) => Number(/\d+/.exec(f)![0])).sort((a, b) => a - b);

/** A sync whose every call stalls until the test settles it, per call. */
function stalled() {
  const calls: string[] = [];
  const waiters: { ok: () => void; fail: () => void; path: string }[] = [];
  const syncFile = (path: string) => new Promise<void>((resolve, reject) => {
    calls.push(path);
    waiters.push({ path, ok: resolve, fail: () => reject(Object.assign(new Error("EIO"), { code: "EIO" })) });
  });
  return { calls, waiters, syncFile };
}

describe("ORW-404 — a never-synced user keeps its files and gets a background slot", () => {
  /** Two users with a durable version, then both re-save and their syncs stall (hold both normal slots). */
  function holdNormalSlots(store: FileSaveStore, s: ReturnType<typeof stalled>) {
    for (const u of ["x", "y"]) store.saveFor(u, snap(1));
    // the first fsyncs of x and y are in flight: complete them so both have a durable version
    s.waiters.splice(0).forEach((w) => w.ok());
    return settle().then(() => {
      for (const u of ["x", "y"]) store.saveFor(u, snap(2));
      expect(s.waiters).toHaveLength(2); // both normal slots now stalled
    });
  }

  it("trace (e): both normal slots stalled by users with a durable version; a new user still gets a first fsync and keeps every file", async () => {
    const dir = tmp();
    const s = stalled();
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {}, onError: () => {} });
    await holdNormalSlots(store, s);
    for (let i = 1; i <= 8; i++) store.saveFor("n", snap(i));
    expect(s.calls.some((c) => c.includes(hex("n")))).toBe(true); // its first fsync is not stuck behind x and y
    expect(versionsOf(dir, "n")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    s.waiters.forEach((w) => w.ok());
    await settle(); s.waiters.forEach((w) => w.ok()); await settle();
    const left = versionsOf(dir, "n");
    expect(left).toContain(8);
    expect(store.durability().saveUnsyncedUsers).toBe(0);
  });

  it("trace (e) with the extra slot also taken: the queued new user keeps all files and, once synced, a synced version", async () => {
    const dir = tmp();
    const s = stalled();
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {}, onError: () => {} });
    await holdNormalSlots(store, s);
    store.saveFor("first1", snap(1)); // takes the extra slot and stalls
    expect(s.waiters).toHaveLength(3);
    for (let i = 1; i <= 8; i++) store.saveFor("n", snap(i)); // queued, never in flight
    expect(s.calls.some((c) => c.includes(hex("n")))).toBe(false);
    expect(versionsOf(dir, "n")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // nothing pruned: no synced file yet
    for (let k = 0; k < 6; k++) { s.waiters.splice(0).forEach((w) => w.ok()); await settle(); }
    expect(versionsOf(dir, "n")).toContain(8);
    expect(store.durability().saveUnsyncedUsers).toBe(0);
  });

  it("trace (b): the first fsync fails; later versions never leave the user without a synced or an existing version", async () => {
    const dir = tmp();
    const s = stalled();
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {}, onError: () => {} });
    store.saveFor("n", snap(1));
    s.waiters.shift()!.fail();
    await settle();
    for (let i = 2; i <= 8; i++) store.saveFor("n", snap(i));
    expect(versionsOf(dir, "n")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    s.waiters.splice(0).forEach((w) => w.fail());
    await settle();
    expect(versionsOf(dir, "n")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // still all there after the failure
    for (let k = 0; k < 4; k++) { s.waiters.splice(0).forEach((w) => w.ok()); await settle(); }
    store.saveFor("n", snap(9));
    expect(versionsOf(dir, "n")).toContain(8);
  });

  it("above the cap the oldest are pruned and one line says the store runs without a synced save", () => {
    const dir = tmp();
    const s = stalled();
    const errors: string[] = [];
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {}, onError: (l) => errors.push(l) });
    for (let i = 1; i <= 205; i++) store.saveFor("n", snap(i));
    const v = versionsOf(dir, "n");
    expect(v.length).toBeLessThanOrEqual(201);
    expect(v.length).toBeGreaterThanOrEqual(200);
    expect(v).toContain(205);
    expect(errors.filter((e) => e.includes("without a synced save"))).toHaveLength(1);
  });
});

describe("ORW-404 — shutdown cannot hang on a stalled disk", () => {
  it("flushDurableAsync resolves within its deadline when a sync never settles", async () => {
    const dir = tmp();
    const s = stalled();
    const errors: string[] = [];
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {}, onError: (l) => errors.push(l) });
    store.saveFor("a", snap(1));
    const t0 = performance.now();
    await store.flushDurableAsync(60);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(errors.some((e) => e.includes("deadline"))).toBe(true);
  });

  it("flushDurableAsync syncs the newest version, largest backlog first, and marks it durable", async () => {
    const dir = tmp();
    const order: string[] = [];
    let flushing = false;
    const store = new FileSaveStore(dir, {
      fsyncMode: "background", syncDir: async () => {}, onError: () => {},
      syncFile: (p) => {
        if (!flushing) return new Promise<void>(() => {}); // background syncs stall
        order.push(p); return Promise.resolve();
      },
    });
    store.saveFor("small", snap(1));
    for (let i = 1; i <= 4; i++) store.saveFor("big", snap(i));
    flushing = true;
    await store.flushDurableAsync(1_000);
    expect(order).toEqual([join(dir, hex("big"), "v000004.json"), join(dir, hex("small"), "v000001.json")]);
    expect(store.durability().saveUnsyncedUsers).toBe(0);
  });

  it("the shutdown path exits by the hard deadline when the flush never settles", async () => {
    let code: number | null = null;
    const shutdown = createShutdown({ flush: () => new Promise<void>(() => {}), exit: (c) => { code = c; }, hardExitMs: 40 });
    void shutdown();
    expect(code).toBeNull();
    await new Promise((r) => setTimeout(r, 120));
    expect(code).toBe(0);
  });

  it("the shutdown path exits right after a flush that settles, once, even on a second signal", async () => {
    const exits: number[] = [];
    let flushes = 0;
    const shutdown = createShutdown({ flush: async () => { flushes++; }, exit: (c) => { exits.push(c); }, hardExitMs: 5_000 });
    await Promise.all([shutdown(), shutdown()]);
    expect(flushes).toBe(1);
    expect(exits).toEqual([0]);
  });
});

describe("ORW-404 — durability backlog alarm and /health shape", () => {
  it("logs one line when the oldest unsynced save is older than the threshold, at most once per minute per user", () => {
    const dir = tmp();
    const s = stalled();
    let clock = 0;
    const errors: string[] = [];
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {}, nowMs: () => clock, onError: (l) => errors.push(l) });
    store.saveFor("a", snap(1));
    clock = 59_000; store.durability();
    expect(errors).toHaveLength(0);
    clock = 61_000; store.durability(); store.durability();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("behind");
    expect(errors[0]).not.toContain(dir);
    clock = 100_000; store.saveFor("a", snap(2)); store.durability();
    expect(errors).toHaveLength(1); // throttled
    clock = 125_000; store.durability();
    expect(errors).toHaveLength(2);
  });

  it("the threshold is configurable", () => {
    const dir = tmp();
    const s = stalled();
    let clock = 0;
    const errors: string[] = [];
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {}, nowMs: () => clock, onError: (l) => errors.push(l), backlogAlarmMs: 1_000 });
    store.saveFor("a", snap(1));
    clock = 1_500; store.durability();
    expect(errors).toHaveLength(1);
  });

  it("right after boot (marker 0, nothing synced yet) health reports pending, not a lag equal to the version", async () => {
    const dir = tmp();
    const s = stalled();
    const seed = new FileSaveStore(dir, { fsyncMode: "sync" });
    for (let i = 1; i <= 7; i++) seed.saveFor("a", snap(i));
    const store = new FileSaveStore(dir, { fsyncMode: "background", syncFile: s.syncFile, syncDir: async () => {}, onError: () => {} });
    store.saveFor("a", snap(8));
    const h = store.durability();
    expect(h.saveDurableVersion).toBe(0);
    expect(h.saveDurabilityPending).toBe(true);
    for (let k = 0; k < 3; k++) { s.waiters.splice(0).forEach((w) => w.ok()); await settle(); }
    expect(store.durability()).toMatchObject({ saveDurableVersion: 8, saveDurabilityPending: false });
  });
});

describe("review of #2732 — a checkpoint is not durable until its directory fsync succeeded", () => {
  const CP = 50;
  const mk = (extra: Record<string, unknown>) => {
    const dir = tmp();
    const store = new FileSaveStore(dir, {
      fsyncMode: "background", syncFile: async () => {}, syncFileSync: () => {}, onError: () => {}, ...extra,
    } as never);
    return { dir, store };
  };

  it("flushDurable: a failing directory fsync leaves the checkpoint un-durable and retries", async () => {
    let dirFail = true;
    const dirCalls: number[] = [];
    const { store } = mk({
      syncFile: () => new Promise<void>(() => {}), // the background fsync never settles: only the flush can make it durable
      syncDir: async () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); },
      syncDirSync: () => { dirCalls.push(1); if (dirFail) throw Object.assign(new Error("EIO"), { code: "EIO" }); },
    });
    for (let i = 1; i <= CP; i++) store.saveFor("u", snap(i));
    await settle();
    store.flushDurable();
    expect(dirCalls.length).toBe(1);
    expect(store.durability().saveDurableVersion).toBeLessThan(CP);
    dirFail = false;
    store.flushDurable();
    expect(dirCalls.length).toBe(2); // dirDirty survived the failure
    expect(store.durability().saveDurableVersion).toBe(CP);
  });

  it("flushDurable still syncs the directory while a background directory fsync is in flight", async () => {
    let release: () => void = () => {};
    const dirCallsSync: number[] = [];
    const { store } = mk({
      syncDir: () => new Promise<void>((res) => { release = res; }),
      syncDirSync: () => { dirCallsSync.push(1); },
    });
    for (let i = 1; i <= CP; i++) store.saveFor("u", snap(i));
    await settle(); // background sync reached its (stalled) directory fsync
    store.flushDurable();
    expect(dirCallsSync.length).toBe(1);
    release();
  });
});

describe("review of #2732 — shutdown quiesces before it flushes", () => {
  it("quiesce completes before flush starts, and a throwing quiesce still flushes and exits", async () => {
    const order: string[] = [];
    const sd = createShutdown({
      quiesce: async () => { order.push("quiesce"); await settle(); order.push("quiesced"); },
      flush: async () => { order.push("flush"); },
      exit: () => { order.push("exit"); },
    });
    await sd();
    expect(order).toEqual(["quiesce", "quiesced", "flush", "exit"]);
    const o2: string[] = [];
    await createShutdown({ quiesce: () => { throw new Error("x"); }, flush: async () => { o2.push("flush"); }, exit: () => { o2.push("exit"); } })();
    expect(o2).toEqual(["flush", "exit"]);
  });
});

describe("review of #2732 — a failing directory fsync for one user never stops the flush of the others", () => {
  it("sync and async flush both continue to the next user, report the failure, and never throw", async () => {
    for (const mode of ["sync", "async"] as const) {
      const dir = tmp();
      const errors: string[] = [];
      const synced: string[] = [];
      const store = new FileSaveStore(dir, {
        fsyncMode: "background", syncFile: (p: string) => new Promise<void>(() => { void p; }), syncFileSync: (p: string) => { synced.push(p); },
        syncDir: async (p: string) => { if (p.includes(hex("bad"))) throw Object.assign(new Error("EIO"), { code: "EIO" }); },
        syncDirSync: (p: string) => { if (p.includes(hex("bad"))) throw Object.assign(new Error("EIO"), { code: "EIO" }); },
        onError: (m: string) => errors.push(m),
        ...(mode === "async" ? { syncFile: async (p: string) => { synced.push(p); } } : {}),
      } as never);
      for (let i = 1; i <= 50; i++) store.saveFor("bad", snap(i));
      for (let i = 1; i <= 50; i++) store.saveFor("good", snap(i));
      if (mode === "sync") store.flushDurable(); else { await settle(); store.flushDurable(); await store.flushDurableAsync(1000); }
      expect(synced.some((p) => p.includes(hex("good")))).toBe(true); // the other user was still flushed
      expect(errors.some((m) => m.includes("save.flush failed") || m.includes("dirsync failed"))).toBe(true);
      resetSaveSyncLimiterForTests();
    }
  });
});
