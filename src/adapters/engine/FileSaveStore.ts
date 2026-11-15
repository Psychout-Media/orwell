import {
  mkdirSync, readdirSync, readFileSync, renameSync, existsSync, unlinkSync,
  openSync, writeSync, fsyncSync, closeSync,
} from "node:fs";
import { open as openAsync } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { UserSaveStore, SaveDurability } from "../../ports/UserSaveStore";
import type { SessionSnapshot } from "../../engine/sessionSnapshot";
import { stallTimer } from "../stallTiming";

/**
 * Disk-backed, per-user durable `UserSaveStore` (feature 0030). Each save is a NEW
 * versioned file under `<dataDir>/<user>/vNNNNNN.json` (never overwritten in place);
 * `loadLatest` reads the highest version. Survives a process restart: a fresh
 * registry over the same dir recalls the game.
 *
 * Retention is BOUNDED (B58/audit E4): a snapshot is a FULL superset of everything
 * before it (0007's non-degradation lives in the snapshot's content, not in keeping
 * every historical file), and an unbounded file-per-mutation history is O(n²) disk.
 * We keep the newest `RETAIN_RECENT` versions plus the newest `RETAIN_CHECKPOINTS`
 * periodic checkpoints (every `CHECKPOINT_EVERY`th version) and prune the rest.
 *
 * Per-user directories are keyed by a hex encoding of the user id, so one user can
 * never read another's saves and no user-controlled string ever becomes a path
 * segment (no traversal). ENGINE-ONLY (persists souls + the hidden relationship
 * layer).
 */
/** ORW-404: how a save's fsync is paid. `background` (default) moves it off the request path. */
export type SaveFsyncMode = "sync" | "background";

export interface FileSaveStoreOptions {
  /** Default: `ORWELL_SAVE_FSYNC=sync` => "sync", anything else => "background". */
  fsyncMode?: SaveFsyncMode;
  /** Async fsync of a file's content (background mode). Tests inject a controllable one. */
  syncFile?: (path: string) => Promise<void>;
  /** Async fsync of a directory (background mode). */
  syncDir?: (path: string) => Promise<void>;
  /** Blocking fsync of a file (shutdown flush). */
  syncFileSync?: (path: string) => void;
  /** Blocking fsync of a directory (shutdown flush). */
  syncDirSync?: (path: string) => void;
  /** Monotonic-ish ms clock for backlog age and the flush deadline. */
  nowMs?: () => number;
  /** Receives one line per failed background fsync (never throws into a save). */
  onError?: (line: string) => void;
}

/** Per-user-dir durability bookkeeping (in memory only; derived, never persisted). */
interface DirState {
  latest: number;
  /** Newest version whose fsync completed (or that pre-dated this process). */
  durable: number;
  /** Newest version waiting for a sync (coalesced: only the newest is ever synced). */
  pending: number | null;
  inFlight: boolean;
  /** Save times of versions newer than `durable`, oldest first (backlog age). */
  unsynced: { v: number; t: number }[];
  /** A checkpoint rename happened since the last directory fsync. */
  dirDirty: boolean;
}

async function defaultSyncFile(path: string): Promise<void> {
  const fh = await openAsync(path, "r");
  try { await fh.sync(); } finally { await fh.close(); }
}
function defaultSyncFileSync(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export class FileSaveStore implements UserSaveStore {
  /** Newest versions always retained (the working window incl. crash-recovery slack). */
  private static readonly RETAIN_RECENT = 5;
  /** Every Nth version is a periodic checkpoint... */
  private static readonly CHECKPOINT_EVERY = 50;
  /** ...of which only the newest few are retained (the long-tail archive stays bounded). */
  private static readonly RETAIN_CHECKPOINTS = 3;

  private readonly dataDir: string;
  private readonly fsyncMode: SaveFsyncMode;
  private readonly syncFile: (path: string) => Promise<void>;
  private readonly syncDir: (path: string) => Promise<void>;
  private readonly syncFileSync: (path: string) => void;
  private readonly syncDirSync: (path: string) => void;
  private readonly nowMs: () => number;
  private readonly onError: (line: string) => void;
  private readonly states = new Map<string, DirState>();

  constructor(dataDir?: string, opts: FileSaveStoreOptions = {}) {
    this.dataDir =
      dataDir ?? process.env.ORWELL_DATA_DIR ?? process.env.BBAI_DATA_DIR ?? "./.orwell-data";
    // ORW-404 kill switch: ORWELL_SAVE_FSYNC=sync restores the fully synchronous save.
    this.fsyncMode = opts.fsyncMode
      ?? ((process.env.ORWELL_SAVE_FSYNC ?? "").trim().toLowerCase() === "sync" ? "sync" : "background");
    this.syncFile = opts.syncFile ?? defaultSyncFile;
    this.syncDir = opts.syncDir ?? defaultSyncFile;
    this.syncFileSync = opts.syncFileSync ?? defaultSyncFileSync;
    this.syncDirSync = opts.syncDirSync ?? defaultSyncFileSync;
    this.nowMs = opts.nowMs ?? (() => performance.now());
    this.onError = opts.onError ?? ((l) => console.error(l));
  }

  /**
   * Defense-in-depth path containment (issue #1072). Every disk path this store touches is built
   * from a `join()` whose first user-derived segment is a HEX encoding of the user id (`userDir`) and
   * whose leaf is a numeric `vNNNNNN.json` (`fileFor`) — so a user-controlled string can never reach
   * the path verbatim and `..`/`/`/`\` can never appear in a segment. This helper makes that
   * guarantee *structural* rather than incidental: it resolves the candidate against the resolved
   * `dataDir` and throws if the result escapes the base, so even a future caller that fed an attacker
   * string in could not traverse out. It returns the original `join()`-built path UNCHANGED for any
   * legitimate input (the resolve is a containment ASSERTION only, never a path rewrite), so existing
   * saves keep their exact on-disk paths — non-degradation (feature 0007/0030) stays byte-identical.
   */
  private resolveWithin(joined: string): string {
    const base = resolve(this.dataDir);
    const real = resolve(joined);
    if (real !== base && !real.startsWith(base + sep)) {
      throw new Error("FileSaveStore: refusing a path that escapes the data dir");
    }
    return joined;
  }

  private userDir(user: string): string {
    return this.resolveWithin(join(this.dataDir, Buffer.from(user, "utf8").toString("hex")));
  }

  private fileFor(dir: string, version: number): string {
    return this.resolveWithin(join(dir, `v${String(version).padStart(6, "0")}.json`));
  }

  /** Save versions present in `dir`, descending. Quarantined (`.corrupt`) files no longer match. */
  private versionsDescending(dir: string): number[] {
    if (!existsSync(dir)) return [];
    const versions: number[] = [];
    for (const file of readdirSync(dir)) {
      const m = /^v(\d+)\.json$/.exec(file);
      if (m) versions.push(Number(m[1]));
    }
    return versions.sort((a, b) => b - a);
  }

  private latestVersion(dir: string): number {
    return this.versionsDescending(dir)[0] ?? 0;
  }

  saveFor(user: string, snapshot: SessionSnapshot): void {
    const dir = this.userDir(user);
    mkdirSync(dir, { recursive: true });
    const version = this.latestVersion(dir) + 1;
    const file = this.fileFor(dir, version);
    // Atomic + DURABLE write (audit E2 + E8): a crash mid-write must never leave a truncated file as
    // the "latest" version — write a temp, fsync the temp's CONTENT, then rename (atomic on the same
    // filesystem). The content fsync + atomic rename ALONE guarantee a torn/partial file can never be
    // "latest": a power cut either loses the rename entirely (the prior COMPLETE version stays latest)
    // or keeps it (the content was already flushed to disk) — never a truncated winner. That is what
    // protects non-degradation (feature 0007/0030) against a mid-write crash.
    const tmp = `${file}.tmp`;
    const background = this.fsyncMode === "background";
    const t0 = stallTimer.now();
    const json = JSON.stringify(snapshot);
    const t1 = stallTimer.now();
    const fd = openSync(tmp, "w");
    let t2 = t1;
    let t3 = t1;
    try {
      writeSync(fd, json, null, "utf8");
      t2 = stallTimer.now();
      // ORW-404: the content fsync is the step that froze a turn for 32 s on a stalled shared disk.
      // Default (background): skip it here — the file is renamed complete (process-crash safe) and a
      // background fsync hardens it afterwards. `ORWELL_SAVE_FSYNC=sync` keeps today's blocking fsync.
      if (!background) fsyncSync(fd);
      t3 = stallTimer.now();
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    const t4 = stallTimer.now();
    stallTimer.record("save.persist", t4 - t0, { chars: json.length }, {
      serialize: t1 - t0, write: t2 - t1, fsync: t3 - t2, rename: t4 - t3,
    });
    const st = this.stateFor(dir, version);
    st.latest = version;
    const isCheckpoint = version % FileSaveStore.CHECKPOINT_EVERY === 0;
    if (background) {
      // The directory fsync (amortized to checkpoints, F-EN-1 #1562) rides the background sync too.
      if (isCheckpoint) st.dirDirty = true;
      st.unsynced.push({ v: version, t: this.nowMs() });
      st.pending = version; // coalesce: only the newest pending version is ever synced
      this.kick(dir, st);
    } else {
      // F-EN-1 (#1562): the DIRECTORY fsync ONLY hardens the rename's directory ENTRY against a sudden
      // power loss; amortized to the periodic checkpoint cadence (the same CHECKPOINT_EVERY boundary
      // `prune` keeps in the long-tail archive). Content fsync + atomic rename already guarantee a
      // truncated file can NEVER win. Owner-sanctioned in #1562.
      if (isCheckpoint) {
        try {
          const dirFd = openSync(dir, "r");
          try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
        } catch { /* best-effort: some platforms refuse directory fsync — the content fsync above held */ }
      }
      st.durable = version;
      st.unsynced = [];
    }
    // `version` IS the newest on disk after the rename (single-threaded write), so `prune` needs no
    // second readdir to rediscover the latest. The newest DURABLE version is never pruned.
    this.prune(dir, version, st.durable);
  }

  private stateFor(dir: string, version: number): DirState {
    let st = this.states.get(dir);
    if (!st) {
      // Versions already on disk when this process first touches the dir pre-date it (a prior process
      // synced them, or flushed at shutdown): treat them as the durable baseline.
      st = { latest: version - 1, durable: version - 1, pending: null, inFlight: false, unsynced: [], dirDirty: false };
      this.states.set(dir, st);
    }
    return st;
  }

  /** Start a background sync of the newest pending version unless one is already in flight. */
  private kick(dir: string, st: DirState): void {
    if (st.inFlight || st.pending === null) return;
    const v = st.pending;
    st.pending = null;
    st.inFlight = true;
    const file = this.fileFor(dir, v);
    const dirToo = st.dirDirty;
    st.dirDirty = false;
    const t0 = stallTimer.now();
    let p: Promise<void>;
    try {
      p = this.syncFile(file).then(() => (dirToo ? this.syncDir(dir) : undefined));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      () => {
        stallTimer.record("save.fsync", stallTimer.now() - t0, { version: v });
        this.markDurable(st, v);
      },
      (e: unknown) => {
        const code = (e as { code?: string } | null)?.code;
        if (code === "ENOENT") {
          // The file was pruned/rotated while syncing: a newer version supersedes it. Not an error.
          return;
        }
        if (dirToo) st.dirDirty = true;
        stallTimer.record("save.fsync", stallTimer.now() - t0, { version: v, failed: 1 });
        try {
          this.onError(`[orwell] save.fsync failed version=${v} code=${code ?? "unknown"} (retried with the next save)`);
        } catch { /* logging must never break the game */ }
      },
    ).finally(() => {
      st.inFlight = false;
      this.kick(dir, st); // the newest save that landed meanwhile (never one per intermediate save)
    });
  }

  private markDurable(st: DirState, v: number): void {
    if (v > st.durable) st.durable = v;
    st.unsynced = st.unsynced.filter((u) => u.v > st.durable);
  }

  /** Backlog view for `/health` (operational numbers only). Reports the user with the largest backlog. */
  durability(): SaveDurability {
    const now = this.nowMs();
    let latest = 0;
    let durable = 0;
    let worstLag = -1;
    let oldest = 0;
    let unsyncedUsers = 0;
    for (const st of this.states.values()) {
      const lag = st.latest - st.durable;
      if (lag > 0) {
        unsyncedUsers++;
        const first = st.unsynced[0];
        if (first) oldest = Math.max(oldest, Math.max(0, Math.round(now - first.t)));
      }
      if (lag > worstLag || (lag === worstLag && st.latest > latest)) {
        worstLag = lag; latest = st.latest; durable = st.durable;
      }
    }
    return { saveLatestVersion: latest, saveDurableVersion: durable, saveOldestUnsyncedAgeMs: oldest, saveUnsyncedUsers: unsyncedUsers };
  }

  /**
   * Shutdown flush (ORW-404): synchronously fsync the newest version of every user with an un-synced
   * save, so a deploy-time restart is fully durable. Bounded: no NEW sync is started once `timeoutMs`
   * has elapsed (a single in-progress fsync cannot be interrupted). Never throws.
   */
  flushDurable(timeoutMs = 10_000): void {
    const deadline = this.nowMs() + timeoutMs;
    for (const [dir, st] of this.states) {
      if (st.latest <= st.durable && !st.dirDirty) continue;
      if (this.nowMs() >= deadline) {
        try { this.onError("[orwell] save.flush deadline reached; remaining saves not fsynced"); } catch { /* ignore */ }
        return;
      }
      try {
        this.syncFileSync(this.fileFor(dir, st.latest));
        if (st.dirDirty) { try { this.syncDirSync(dir); } catch { /* best-effort */ } st.dirDirty = false; }
        this.markDurable(st, st.latest);
        st.pending = null;
      } catch (e) {
        try { this.onError(`[orwell] save.flush failed code=${(e as { code?: string } | null)?.code ?? "unknown"}`); } catch { /* ignore */ }
      }
    }
  }

  /** Bounded retention (B58/audit E4): keep the recent window + the newest periodic checkpoints. */
  private prune(dir: string, latest: number, durable = latest): void {
    const keep = new Set<number>();
    // ORW-404: never delete the newest version whose fsync completed until a newer one is durable.
    if (durable > 0) keep.add(durable);
    for (let v = latest; v > latest - FileSaveStore.RETAIN_RECENT && v > 0; v--) keep.add(v);
    // PERSIST-11: whenever `latest % CHECKPOINT_EVERY` is small, the FIRST checkpoint candidate
    // (`latest - (latest % CHECKPOINT_EVERY)`) can land INSIDE the recent-retention window already
    // added above — a redundant hit that used to still consume one of the `RETAIN_CHECKPOINTS`
    // slots, leaving the long-tail archive with fewer genuinely-older checkpoints than intended for
    // roughly one save in ten. Skip an already-kept candidate without spending a slot.
    let checkpoints = 0;
    for (let v = latest - (latest % FileSaveStore.CHECKPOINT_EVERY);
      v > 0 && checkpoints < FileSaveStore.RETAIN_CHECKPOINTS;
      v -= FileSaveStore.CHECKPOINT_EVERY) {
      if (keep.has(v)) continue;
      keep.add(v);
      checkpoints++;
    }
    for (const v of this.versionsDescending(dir)) {
      if (!keep.has(v)) {
        try { unlinkSync(this.fileFor(dir, v)); } catch { /* best-effort: already pruned */ }
      }
    }
  }

  hasSave(user: string): boolean {
    return this.latestVersion(this.userDir(user)) > 0;
  }

  /**
   * Season restart (audit E1/R1): ROTATE the user's save dir off the live path — `hasSave` goes
   * false, the new season's `v000001` starts clean, and an engine restart resumes season 2 instead
   * of resurrecting the dead one. The retired dir keeps the old season's record on disk (suffixed,
   * so `listUsers`' hex filter never resumes it); the factory-reset script scrubs the whole tree.
   */
  resetUser(user: string): void {
    const dir = this.userDir(user);
    this.states.delete(dir);
    if (!existsSync(dir)) return;
    let target = `${dir}.retired-${Date.now()}`;
    for (let i = 1; existsSync(target); i++) target = `${dir}.retired-${Date.now()}-${i}`;
    renameSync(dir, target);
  }

  /**
   * PERS-NEW-2 (#592): quarantine the newest save off the live `vNNNNNN.json` path (`.incompatible`)
   * when a resume REJECTED it for an incompatible/future `snapshotVersion`. A future-version save
   * parses fine, so `loadLatest` never `.corrupt`-quarantines it; without this belt the fresh
   * sandbox's later saves would prune the user's own higher-schema save out of retention. Renaming it
   * off the version-matching pattern protects it permanently (and keeps it recoverable on a downgrade).
   */
  quarantineIncompatible(user: string): void {
    const dir = this.userDir(user);
    const latest = this.latestVersion(dir);
    if (latest <= 0) return;
    this.states.delete(dir);
    const file = this.fileFor(dir, latest);
    let target = `${file}.incompatible`;
    for (let i = 1; existsSync(target); i++) target = `${file}.incompatible-${i}`;
    try { renameSync(file, target); } catch { /* best-effort quarantine */ }
  }

  /** The users with at least one durable save (B60/E11) — dir names are hex-encoded user ids. */
  listUsers(): string[] {
    if (!existsSync(this.dataDir)) return [];
    const users: string[] = [];
    for (const entry of readdirSync(this.dataDir)) {
      if (!/^([0-9a-f]{2})+$/i.test(entry)) continue; // not a user dir (e.g. stray files)
      const user = Buffer.from(entry, "hex").toString("utf8");
      if (this.hasSave(user)) users.push(user);
    }
    return users;
  }

  /**
   * The newest READABLE save. A corrupt highest version (e.g. truncated by a crash) is **quarantined**
   * (renamed `.corrupt`, so it can never be "latest" again → no restart crash-loop) and we **step
   * down** to the next-lower version. Returns null only when no version parses (⇒ a fresh sandbox).
   */
  loadLatest(user: string): SessionSnapshot | null {
    const dir = this.userDir(user);
    for (const version of this.versionsDescending(dir)) {
      const file = this.fileFor(dir, version);
      try {
        return JSON.parse(readFileSync(file, "utf8")) as SessionSnapshot;
      } catch {
        this.states.delete(dir);
        try { renameSync(file, `${file}.corrupt`); } catch { /* best-effort quarantine */ }
      }
    }
    return null;
  }
}
