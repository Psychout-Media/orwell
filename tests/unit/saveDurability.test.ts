import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Lane 8 / audit E8 — save-write durability. The atomic temp+rename (B35/E2) protects against a
 * CRASH; a truncated file must never be "latest". The load-bearing guarantee is fsync(the file's
 * CONTENT) BEFORE the rename: a power cut then either loses the rename (the prior COMPLETE version
 * stays latest) or keeps it (the content was already flushed) — never a truncated winner. That
 * ordering is the contract — pinned here by instrumenting the real fs calls the store makes (the
 * writes still hit the real filesystem).
 *
 * F-EN-1 (#1562): the SECOND fsync — the DIRECTORY fsync AFTER the rename — only hardens the rename's
 * directory ENTRY against a sudden power loss (natural page-cache writeback makes it durable within
 * seconds anyway), and it is a blocking fsync on the single Node thread on the hot per-turn commit
 * path that stalls every concurrent user. Because a truncated file can never win (content fsync
 * above), it is AMORTIZED to the periodic checkpoint cadence (every CHECKPOINT_EVERY-th version):
 * a per-turn save no longer pays it, the long-lived checkpoint renames still get the hard power-loss
 * guarantee, and a power cut loses at most the recent un-hardened tail. Pinned below.
 *
 * Roles only — no names.
 */

/** Mirrors `FileSaveStore.CHECKPOINT_EVERY` (a private static). If that constant changes, this test
 *  fails loudly — which is the intended signal that the amortization cadence moved. */
const CHECKPOINT_EVERY = 50;

const calls: string[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      calls.push(`open:${String(args[0])}`);
      return real.openSync(...args);
    },
    fsyncSync: (fd: number) => {
      calls.push("fsync");
      return real.fsyncSync(fd);
    },
    renameSync: (...args: Parameters<typeof real.renameSync>) => {
      calls.push(`rename:${String(args[1])}`);
      return real.renameSync(...args);
    },
  };
});

// Import AFTER the mock so the store binds the instrumented functions.
const { FileSaveStore } = await import("../../src/adapters/engine/FileSaveStore");
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

const snap = (phase: string): SessionSnapshot =>
  ({ started: true, week: 1, phase, ceremony: { nominees: [], vetoUsed: false }, house: null, events: [], relationships: [] }) as SessionSnapshot;

describe("E8 — saves are fsynced, in the durable order", () => {
  it("fsyncs the temp file's CONTENT before the rename (the torn-file guarantee) on every save", () => {
    const dir = mkdtempSync(join(tmpdir(), "orwell-e8-"));
    const store = new FileSaveStore(dir, { fsyncMode: "sync" });
    calls.length = 0;

    store.saveFor("u", snap("a")); // a per-turn (non-checkpoint) save

    const firstFsync = calls.indexOf("fsync");
    const rename = calls.findIndex((c) => c.startsWith("rename:") && c.endsWith("v000001.json"));
    expect(firstFsync, "the temp file's content must be fsynced").toBeGreaterThanOrEqual(0);
    expect(rename, "the content fsync must come BEFORE the atomic rename").toBeGreaterThan(firstFsync);
  });

  it("does NOT pay a second (directory) fsync on an ordinary per-turn save (F-EN-1 #1562)", () => {
    const dir = mkdtempSync(join(tmpdir(), "orwell-e8-"));
    const store = new FileSaveStore(dir, { fsyncMode: "sync" });
    calls.length = 0;

    store.saveFor("u", snap("a")); // v1 — not a checkpoint boundary

    const rename = calls.findIndex((c) => c.startsWith("rename:") && c.endsWith("v000001.json"));
    const fsyncsAfterRename = calls.slice(rename + 1).filter((c) => c === "fsync");
    // Exactly ONE fsync total (the content one, before the rename); the redundant directory fsync
    // that used to block the hot commit path on EVERY save is gone off the per-turn path.
    expect(calls.filter((c) => c === "fsync")).toHaveLength(1);
    expect(fsyncsAfterRename, "no directory fsync after the rename on a non-checkpoint save").toEqual([]);
  });

  it("STILL fsyncs the directory after the rename on a periodic checkpoint save (bounded power-loss window)", () => {
    const dir = mkdtempSync(join(tmpdir(), "orwell-e8-"));
    const store = new FileSaveStore(dir, { fsyncMode: "sync" });
    // Drive up to the checkpoint boundary; instrument only the checkpoint save itself.
    for (let v = 1; v < CHECKPOINT_EVERY; v++) store.saveFor("u", snap(`v${v}`));
    calls.length = 0;
    store.saveFor("u", snap("checkpoint")); // the CHECKPOINT_EVERY-th version

    const checkpointFile = `v${String(CHECKPOINT_EVERY).padStart(6, "0")}.json`;
    const rename = calls.findIndex((c) => c.startsWith("rename:") && c.endsWith(checkpointFile));
    const lastFsync = calls.lastIndexOf("fsync");
    expect(rename, "the atomic rename must still happen").toBeGreaterThanOrEqual(0);
    expect(lastFsync, "the DIRECTORY is fsynced after the rename ON the checkpoint (so its rename survives power loss)").toBeGreaterThan(rename);
  });

  it("the durable write still round-trips and leaves no temp file (B35 intact)", () => {
    const dir = mkdtempSync(join(tmpdir(), "orwell-e8-"));
    const store = new FileSaveStore(dir, { fsyncMode: "sync" });
    store.saveFor("u", snap("a"));
    store.saveFor("u", snap("b"));
    expect(store.loadLatest("u")!.phase).toBe("b");
    const userDir = join(dir, Buffer.from("u", "utf8").toString("hex"));
    expect(readdirSync(userDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
