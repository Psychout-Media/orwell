import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore, resetSaveSyncLimiterForTests } from "../../src/adapters/engine/FileSaveStore";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

/**
 * ORW-404 follow-up: a brand-new user's directory entry (and the data dir's entry for it) is fsynced,
 * off the request path in the default mode; the first version file after boot also hardens its
 * directory. The #1562 cadence (every 50th version) is kept for everything else. Roles only.
 */
const snap = (n: number): SessionSnapshot => ({ started: true, week: n, events: [] }) as unknown as SessionSnapshot;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "orw404d-")); dirs.push(d); return d; };
afterEach(() => {
  resetSaveSyncLimiterForTests();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r)); };
const hex = (u: string) => Buffer.from(u, "utf8").toString("hex");

describe("ORW-404 follow-up: new-directory durability (background mode)", () => {
  it("the first save of a new user queues a user-dir sync and a data-dir sync, never on the request path", async () => {
    const data = tmp();
    const dirCalls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const store = new FileSaveStore(data, {
      fsyncMode: "background", syncFile: async () => {},
      syncDir: async (p) => { dirCalls.push(p); await gate; },
      syncDirSync: () => { throw new Error("blocking dir sync on the request path"); },
    });
    expect(() => store.saveFor("a", snap(1))).not.toThrow();
    // saveFor has returned while the directory syncs are still unfinished (gated): nothing blocked on them.
    await settle();
    expect(dirCalls).toEqual([join(data, hex("a"))]); // user dir first; the data dir follows once it completes
    release();
    await settle();
    expect(dirCalls).toEqual([join(data, hex("a")), data]);
  });

  it("a later save in an existing directory (same process) does not re-sync directories off-cadence", async () => {
    const data = tmp();
    const dirCalls: string[] = [];
    const store = new FileSaveStore(data, { fsyncMode: "background", syncFile: async () => {}, syncDir: async (p) => { dirCalls.push(p); } });
    store.saveFor("a", snap(1));
    await settle();
    dirCalls.length = 0;
    for (let i = 2; i <= 10; i++) { store.saveFor("a", snap(i)); await settle(); }
    expect(dirCalls).toEqual([]);
  });

  it("the first version file after boot in an EXISTING directory also syncs the directory (not the data dir)", async () => {
    const data = tmp();
    new FileSaveStore(data, { fsyncMode: "sync" }).saveFor("a", snap(1)); // exists on disk from a previous run
    const dirCalls: string[] = [];
    const store = new FileSaveStore(data, { fsyncMode: "background", syncFile: async () => {}, syncDir: async (p) => { dirCalls.push(p); } });
    store.saveFor("a", snap(2));
    await settle();
    // ORW-404 follow-up 2: the parent is also flagged once per user per boot (a restart between the first save
    // and its parent sync leaves an existing directory the next boot would otherwise never re-harden).
    expect(dirCalls).toEqual([join(data, hex("a")), data]);
    dirCalls.length = 0;
    store.saveFor("a", snap(3));
    await settle();
    expect(dirCalls).toEqual([]); // once per user per boot
  });

  it("a failed new-directory sync is logged and retried with the next save, and never blocks saveFor", async () => {
    const data = tmp();
    const errors: string[] = [];
    const dirCalls: string[] = [];
    let fail = true;
    const store = new FileSaveStore(data, {
      fsyncMode: "background", syncFile: async () => {}, onError: (l) => errors.push(l),
      syncDir: async (p) => { dirCalls.push(p); if (fail) throw Object.assign(new Error("EIO"), { code: "EIO" }); },
    });
    expect(() => store.saveFor("a", snap(1))).not.toThrow();
    await settle();
    expect(errors.some((l) => l.includes("save.dirsync"))).toBe(true);
    expect(errors.every((l) => !l.includes(data))).toBe(true);
    expect(store.durability().saveDurableVersion, "the file itself is durable").toBe(1);
    // Only the user dir was attempted (it failed); the data dir stays owed.
    fail = false;
    dirCalls.length = 0;
    store.saveFor("a", snap(2));
    await settle();
    expect(dirCalls).toEqual([join(data, hex("a")), data]);
  });

  it("a failed data-dir sync is logged separately and retried with the next save", async () => {
    const data = tmp();
    const errors: string[] = [];
    const dirCalls: string[] = [];
    let failParent = true;
    const store = new FileSaveStore(data, {
      fsyncMode: "background", syncFile: async () => {}, onError: (l) => errors.push(l),
      syncDir: async (p) => { dirCalls.push(p); if (p === data && failParent) throw Object.assign(new Error("EIO"), { code: "EIO" }); },
    });
    store.saveFor("a", snap(1));
    await settle();
    expect(errors.some((l) => l.includes("save.parentsync"))).toBe(true);
    failParent = false;
    dirCalls.length = 0;
    store.saveFor("a", snap(2));
    await settle();
    expect(dirCalls).toEqual([data]);
  });

  it("the shutdown flush also hardens a still-owed new-directory entry", async () => {
    const data = tmp();
    const dirCalls: string[] = [];
    const store = new FileSaveStore(data, {
      fsyncMode: "background", syncFile: async () => {}, onError: () => {},
      syncDir: async (p) => { dirCalls.push(p); throw Object.assign(new Error("EIO"), { code: "EIO" }); },
    });
    store.saveFor("a", snap(1));
    await settle();
    dirCalls.length = 0;
    // The flush RETRIES the directories still owed for a user whose background syncs failed.
    await store.flushDurableAsync(1_000);
    expect(dirCalls).toContain(join(data, hex("a")));
    expect(dirCalls).toContain(data);
  });
});

describe("ORW-404 follow-up: new-directory durability (ORWELL_SAVE_FSYNC=sync mode)", () => {
  it("syncs a brand-new user's directory and the data dir synchronously, once", () => {
    const data = tmp();
    const synced: string[] = [];
    const store = new FileSaveStore(data, { fsyncMode: "sync", syncDirSync: (p) => { synced.push(p); } });
    store.saveFor("a", snap(1));
    expect(synced).toEqual([join(data, hex("a")), data]);
    store.saveFor("a", snap(2));
    expect(synced).toHaveLength(2); // an existing directory keeps the #1562 cadence: no extra sync
  });

  it("still syncs the directory at the every-50th-version checkpoint, and a failure never throws", () => {
    const data = tmp();
    const synced: string[] = [];
    const store = new FileSaveStore(data, { fsyncMode: "sync", syncDirSync: (p) => { synced.push(p); if (synced.length > 2) throw new Error("EIO"); } });
    for (let i = 1; i <= 49; i++) store.saveFor("a", snap(i));
    synced.length = 0;
    expect(() => store.saveFor("a", snap(50))).not.toThrow();
    expect(synced).toEqual([join(data, hex("a"))]);
  });
});

describe("ORW-404 follow-up 2: directory sync bookkeeping", () => {
  it("a directory sync still in flight at shutdown is awaited by the flush and its flags stay owed until it succeeds", async () => {
    const data = tmp();
    const dirCalls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const store = new FileSaveStore(data, {
      fsyncMode: "background", syncFile: async () => {}, onError: () => {},
      syncDir: async (p) => { dirCalls.push(p); if (first) { first = false; await gate; throw Object.assign(new Error("EIO"), { code: "EIO" }); } },
    });
    store.saveFor("a", snap(1));
    await settle();
    expect(dirCalls).toEqual([join(data, hex("a"))]); // the user-dir sync is running (gated)
    let flushed = false;
    const flush = store.flushDurableAsync(2_000).then(() => { flushed = true; });
    await settle();
    expect(flushed, "the flush waits for the sync in flight").toBe(false);
    release(); // that sync now FAILS: the flag must still be owed, so the flush re-syncs both directories
    await flush;
    expect(dirCalls.slice(1)).toContain(join(data, hex("a")));
    expect(dirCalls.slice(1)).toContain(data);
  });

  it("a first write that throws after the directory was created still gets the data dir synced once, in the background", async () => {
    const data = tmp();
    const dirCalls: string[] = [];
    const store = new FileSaveStore(data, { fsyncMode: "background", syncFile: async () => {}, syncDir: async (p) => { dirCalls.push(p); } });
    const bad = { toJSON() { throw new Error("boom"); } } as unknown as SessionSnapshot;
    expect(() => store.saveFor("a", bad)).toThrow("boom");
    await settle();
    expect(dirCalls).toEqual([data]);
  });
});
