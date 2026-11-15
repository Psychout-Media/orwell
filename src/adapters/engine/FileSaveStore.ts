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
  /** Blocking fsync of a directory (`ORWELL_SAVE_FSYNC=sync` mode only). */
  syncDirSync?: (path: string) => void;
  /** Monotonic-ish ms clock for backlog age and the flush deadline. */
  nowMs?: () => number;
  /** Receives one line per failed background fsync (never throws into a save). */
  onError?: (line: string) => void;
  /** Alarm (one onError line, at most once per `backlogAlarmMs` per user) when the oldest unsynced save is older than this. Default 60 000. */
  backlogAlarmMs?: number;
}

/** Per-user-dir durability bookkeeping (in memory only; derived, never persisted). */
interface DirState {
  latest: number;
  /** Newest version whose fsync completed AND whose file still exists (0 = none known yet). */
  durable: number;
  /** Newest version waiting for a sync (coalesced: only the newest is ever synced). */
  pending: number | null;
  /** The version whose fsync is running right now (never pruned while it runs). */
  inFlight: number | null;
  /** Waiting in the module-level sync queue. */
  queued: boolean;
  /**
   * Versions that were already on disk when this process first touched the dir. They are NOT known
   * durable (a kill, a crash or a timed-out flush can leave an unsynced tail), so none of them is
   * pruned until one fsync has completed; then this is cleared and the normal rule applies.
   */
  bootVersions: Set<number> | null;
  /** Save times of versions newer than `durable`, oldest first (backlog age). */
  unsynced: { v: number; t: number }[];
  /** A directory entry in this user's dir is not yet fsynced (a checkpoint rename, or the first save after boot). */
  dirDirty: boolean;
  /** This user's directory was created by this process: the PARENT (data dir) entry for it is not yet fsynced. */
  parentDirty: boolean;
  /** Bumped every time a dir/parent flag is (re)set; a sync clears its flag only if no newer mark arrived meanwhile. */
  dirSeq: number;
  parentSeq: number;
  /** The running background sync (file + directory syncs), so the shutdown flush can await it. */
  syncing: Promise<void> | null;
  /** Last time the backlog alarm fired for this user (null = never). */
  lastAlarmAt: number | null;
  /** The no-synced-save cap warning was already logged for this user. */
  capWarned: boolean;
}

async function defaultSyncFile(path: string): Promise<void> {
  const fh = await openAsync(path, "r");
  try { await fh.sync(); } finally { await fh.close(); }
}
/**
 * Module-level cap on concurrent BACKGROUND fsyncs across every store and user: each one occupies a
 * libuv pool thread (4 by default), and a stalled disk must not starve DNS and outbound calls. Waiting
 * users sit in one FIFO, each at most once (the newest pending version per user wins).
 */
const MAX_CONCURRENT_SYNCS = 2;
/**
 * One EXTRA slot used only for a never-synced user's first fsync (a user with no durable version yet
 * must not wait behind stalled syncs of users who already have one). Such jobs also sit at the front.
 */
const FIRST_SYNC_EXTRA_SLOTS = 1;
interface SyncJob { st: DirState; first: boolean; run: (epoch: number, extra: boolean) => void }
const limiter = { epoch: 0, active: 0, extraActive: 0, queue: [] as SyncJob[] };

function drainSyncQueue(): void {
  while (limiter.queue.length > 0) {
    const head = limiter.queue[0]!; // never-synced jobs are kept at the front
    let extra = false;
    if (limiter.active >= MAX_CONCURRENT_SYNCS) {
      if (!head.first || limiter.extraActive >= FIRST_SYNC_EXTRA_SLOTS) return;
      extra = true;
    }
    limiter.queue.shift();
    head.st.queued = false;
    if (extra) limiter.extraActive++; else limiter.active++;
    head.run(limiter.epoch, extra);
  }
}

/** Test hook: forget every running/queued sync slot (a test that stalls a sync on purpose). */
export function resetSaveSyncLimiterForTests(): void {
  limiter.epoch++;
  limiter.active = 0;
  limiter.extraActive = 0;
  limiter.queue.length = 0;
}

function defaultSyncDirSync(path: string): void {
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
  /** While a user has no durable version yet, keep every file up to this many (never below). */
  private static readonly UNSYNCED_KEEP_CAP = 200;

  private readonly dataDir: string;
  private readonly fsyncMode: SaveFsyncMode;
  private readonly syncFile: (path: string) => Promise<void>;
  private readonly syncDir: (path: string) => Promise<void>;
  private readonly syncDirSync: (path: string) => void;
  private readonly nowMs: () => number;
  private readonly onError: (line: string) => void;
  private readonly backlogAlarmMs: number;
  private readonly states = new Map<string, DirState>();

  constructor(dataDir?: string, opts: FileSaveStoreOptions = {}) {
    this.dataDir =
      dataDir ?? process.env.ORWELL_DATA_DIR ?? process.env.BBAI_DATA_DIR ?? "./.orwell-data";
    // ORW-404 kill switch: ORWELL_SAVE_FSYNC=sync restores the fully synchronous save.
    this.fsyncMode = opts.fsyncMode
      ?? ((process.env.ORWELL_SAVE_FSYNC ?? "").trim().toLowerCase() === "sync" ? "sync" : "background");
    this.syncFile = opts.syncFile ?? defaultSyncFile;
    this.syncDir = opts.syncDir ?? defaultSyncFile;
    this.syncDirSync = opts.syncDirSync ?? defaultSyncDirSync;
    this.nowMs = opts.nowMs ?? (() => performance.now());
    this.onError = opts.onError ?? ((l) => console.error(l));
    this.backlogAlarmMs = opts.backlogAlarmMs ?? 60_000;
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
    return this.versionsPresent(dir);
  }

  /** Same, for a directory the caller knows exists (the save path just created it): no existence stat. */
  private versionsPresent(dir: string): number[] {
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
    // existsSync only the first time this process sees the directory: later saves skip the extra stat.
    const firstSaveSinceBoot = !this.states.has(dir);
    const dirIsNew = firstSaveSinceBoot && !existsSync(dir);
    mkdirSync(dir, { recursive: true });
    const existing = this.versionsPresent(dir);
    const version = (existing[0] ?? 0) + 1;
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
    let json: string;
    try {
      json = JSON.stringify(snapshot);
    } catch (e) {
      this.firstWriteFailed(dir, dirIsNew, background);
      throw e;
    }
    const t1 = stallTimer.now();
    let fd: number;
    try {
      fd = openSync(tmp, "w");
    } catch (e) {
      this.firstWriteFailed(dir, dirIsNew, background);
      throw e;
    }
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
    try {
      renameSync(tmp, file);
    } catch (e) {
      this.firstWriteFailed(dir, dirIsNew, background);
      throw e;
    }
    const t4 = stallTimer.now();
    stallTimer.record("save.persist", t4 - t0, { chars: json.length }, {
      serialize: t1 - t0, write: t2 - t1, fsync: t3 - t2, rename: t4 - t3,
    });
    const st = this.stateFor(dir, existing, background);
    st.latest = version;
    const isCheckpoint = version % FileSaveStore.CHECKPOINT_EVERY === 0;
    if (background) {
      // The directory fsync (amortized to checkpoints, F-EN-1 #1562) rides the background sync too.
      // ORW-404 follow-up: a cadence is only acceptable for a directory that already exists durably. The
      // first version file this process writes in a directory, and a brand-new user directory (whose own
      // entry in the data dir is also unsynced), are hardened here too, off the request path.
      if (isCheckpoint || firstSaveSinceBoot) this.markDirDirty(st);
      // The parent entry for a user directory is flagged once per user per boot (not only when THIS process
      // created it): a restart between the first save and its parent sync leaves an existing directory that
      // the next boot would otherwise never re-harden.
      if (dirIsNew || firstSaveSinceBoot) this.markParentDirty(st);
      st.unsynced.push({ v: version, t: this.nowMs() });
      this.checkBacklogAlarm(dir, st);
      st.pending = version; // coalesce: only the newest pending version is ever synced
      this.kick(dir, st);
    } else {
      // F-EN-1 (#1562): the DIRECTORY fsync ONLY hardens the rename's directory ENTRY against a sudden
      // power loss; amortized to the periodic checkpoint cadence (the same CHECKPOINT_EVERY boundary
      // `prune` keeps in the long-tail archive). Content fsync + atomic rename already guarantee a
      // truncated file can NEVER win. Owner-sanctioned in #1562.
      // ORW-404 follow-up: a brand-new user directory also syncs its own entry and the data dir's entry
      // for it, synchronously (this mode's contract), so a new game's folder survives a power cut.
      const dirsToSync: string[] = [];
      if (isCheckpoint || dirIsNew) dirsToSync.push(dir);
      if (dirIsNew) dirsToSync.push(this.dataDir);
      for (const d of dirsToSync) {
        try { this.syncDirSync(d); } catch { /* best-effort: some platforms refuse directory fsync — the content fsync above held */ }
      }
      st.durable = version;
      st.unsynced = [];
      st.bootVersions = null;
    }
    // `version` IS the newest on disk after the rename (single-threaded write). Prune never deletes a
    // version whose fsync is in flight, the highest existing version <= durable, or (until one fsync
    // has completed since boot) anything that was on disk at boot.
    this.prune(dir, version, st);
  }

  private markDirDirty(st: DirState): void { st.dirDirty = true; st.dirSeq++; }
  private markParentDirty(st: DirState): void { st.parentDirty = true; st.parentSeq++; }

  /**
   * A first write threw after the directory was created: its entry in the data dir is still unsynced and no
   * save will ever follow to carry it. Flag the parent and sync it once in the background (best-effort).
   */
  private firstWriteFailed(dir: string, dirIsNew: boolean, background: boolean): void {
    if (!dirIsNew || !background) return;
    const st = this.stateFor(dir, [], background);
    this.markParentDirty(st);
    const seq = st.parentSeq;
    void this.syncDir(this.dataDir)
      .then(() => { if (st.parentSeq === seq) st.parentDirty = false; })
      .catch(() => { /* stays flagged for the shutdown flush / next save */ });
  }

  private stateFor(dir: string, existing: number[], background: boolean): DirState {
    let st = this.states.get(dir);
    if (!st) {
      st = {
        latest: existing[0] ?? 0, durable: 0, pending: null, inFlight: null, queued: false,
        unsynced: [], dirDirty: false, parentDirty: false, dirSeq: 0, parentSeq: 0, syncing: null, bootVersions: null, lastAlarmAt: null, capWarned: false,
      };
      this.states.set(dir, st);
      if (existing.length > 0 && background) {
        // Versions on disk at first use are NOT assumed durable: harden the newest one now and keep
        // everything that existed at boot until one fsync has completed.
        st.bootVersions = new Set(existing);
        st.unsynced.push({ v: existing[0]!, t: this.nowMs() });
        st.pending = existing[0]!;
        this.kick(dir, st);
      }
    }
    return st;
  }

  /** Queue a background sync of the newest pending version (global cap, fair per-user FIFO). */
  private kick(dir: string, st: DirState): void {
    if (st.inFlight !== null || st.queued || st.pending === null) return;
    st.queued = true;
    const first = st.durable === 0;
    const job: SyncJob = { st, first, run: (epoch, extra) => this.runSync(dir, st, epoch, extra) };
    if (first) {
      // never-synced users go ahead of everyone with a durable version (FIFO among themselves)
      let i = 0;
      while (i < limiter.queue.length && limiter.queue[i]!.first) i++;
      limiter.queue.splice(i, 0, job);
    } else {
      limiter.queue.push(job);
    }
    drainSyncQueue();
  }

  private releaseSlot(epoch: number, extra: boolean): void {
    if (epoch !== limiter.epoch) return;
    if (extra) limiter.extraActive--; else limiter.active--;
  }

  private runSync(dir: string, st: DirState, epoch: number, extra: boolean): void {
    const v = st.pending;
    if (v === null) {
      this.releaseSlot(epoch, extra);
      return;
    }
    st.pending = null;
    st.inFlight = v;
    // The flags stay SET while the sync runs: they are cleared only once the directory/parent sync has
    // succeeded (and no newer mark arrived), so a shutdown mid-sync still sees them owed.
    const dirToo = st.dirDirty;
    const parentToo = st.parentDirty;
    st.syncing = this.syncOne(dir, st, v, dirToo, parentToo, st.dirSeq, st.parentSeq)
      .catch((e: unknown) => this.reportFailure(v, e))
      .finally(() => {
        st.inFlight = null;
        st.syncing = null;
        this.releaseSlot(epoch, extra);
        this.kick(dir, st); // the newest save that landed meanwhile, behind other waiting users
        drainSyncQueue();
      })
      .catch(() => { /* terminal: nothing here may become an unhandled rejection */ });
  }

  private async syncOne(dir: string, st: DirState, v: number, dirToo: boolean, parentToo: boolean, dirSeq: number, parentSeq: number): Promise<void> {
    const t0 = stallTimer.now();
    try {
      await this.syncFile(this.fileFor(dir, v));
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code === "ENOENT") return; // the file is gone (rotated/quarantined): not an error
      try { stallTimer.record("save.fsync", stallTimer.now() - t0, { version: v, failed: 1 }); } catch { /* ignore */ }
      try {
        this.onError(`[orwell] save.fsync failed version=${v} code=${code ?? "unknown"} (retried with the next save)`);
      } catch { /* logging must never break the game */ }
      return;
    }
    // The FILE is durable now; the directory entry is tracked separately and retried with the next save.
    this.markDurable(dir, st, v);
    stallTimer.record("save.fsync", stallTimer.now() - t0, { version: v });
    if (dirToo) {
      try {
        await this.syncDir(dir);
        if (st.dirSeq === dirSeq) st.dirDirty = false;
      } catch (e) {
        try {
          this.onError(`[orwell] save.dirsync failed version=${v} code=${(e as { code?: string } | null)?.code ?? "unknown"} (retried with the next save)`);
        } catch { /* ignore */ }
      }
    }
    // The new directory's own entry lives in the data dir: sync that after the directory itself.
    if (parentToo) {
      try {
        await this.syncDir(this.dataDir);
        if (st.parentSeq === parentSeq) st.parentDirty = false;
      } catch (e) {
        try {
          this.onError(`[orwell] save.parentsync failed version=${v} code=${(e as { code?: string } | null)?.code ?? "unknown"} (retried with the next save)`);
        } catch { /* ignore */ }
      }
    }
  }

  /** Last-resort recorder for a failure inside the sync handlers themselves. Never throws. */
  private reportFailure(v: number, e: unknown): void {
    try { stallTimer.record("save.fsync", 0, { version: v, failed: 1, handler: 1 }); } catch { /* ignore */ }
    try {
      this.onError(`[orwell] save.fsync handler failed version=${v} code=${(e as { code?: string } | null)?.code ?? "unknown"}`);
    } catch { /* ignore */ }
  }

  /** Advance the durable marker ONLY onto a file that still exists (a pruned file is not a save). */
  private markDurable(dir: string, st: DirState, v: number): void {
    if (!existsSync(this.fileFor(dir, v))) return;
    if (v > st.durable) st.durable = v;
    st.bootVersions = null; // one fsync has completed since boot: the normal rule applies
    st.unsynced = st.unsynced.filter((u) => u.v > st.durable);
  }

  /** Unsynced backlog size: versions behind the marker, or the saves awaiting their first fsync. */
  private backlogOf(st: DirState): number {
    return st.durable > 0 ? st.latest - st.durable : st.unsynced.length;
  }

  /**
   * One alarm line (through `onError`) when the oldest unsynced save is older than `backlogAlarmMs`;
   * at most once per `backlogAlarmMs` per user. No ids in the line. Never throws.
   */
  private checkBacklogAlarm(_dir: string, st: DirState): void {
    const first = st.unsynced[0];
    if (!first) return;
    const now = this.nowMs();
    const age = now - first.t;
    if (age < this.backlogAlarmMs) return;
    if (st.lastAlarmAt !== null && now - st.lastAlarmAt < this.backlogAlarmMs) return;
    st.lastAlarmAt = now;
    try {
      this.onError(`[orwell] save.durability behind: oldest unsynced save is ${Math.round(age / 1000)}s old, ${st.unsynced.length} unsynced version(s)`);
    } catch { /* logging must never break the game */ }
  }

  /** Backlog view for `/health` (operational numbers only). Reports the user with the largest backlog. */
  durability(): SaveDurability {
    const now = this.nowMs();
    let latest = 0;
    let durable = 0;
    let worstLag = -1;
    let oldest = 0;
    let unsyncedUsers = 0;
    let pendingBoot = false;
    for (const [dir, st] of this.states) {
      const lag = this.backlogOf(st);
      if (lag > 0) {
        unsyncedUsers++;
        const first = st.unsynced[0];
        if (first) oldest = Math.max(oldest, Math.max(0, Math.round(now - first.t)));
        this.checkBacklogAlarm(dir, st);
        if (st.durable === 0) pendingBoot = true;
      }
      if (lag > worstLag || (lag === worstLag && st.latest > latest)) {
        worstLag = lag; latest = st.latest; durable = st.durable;
      }
    }
    // A marker of 0 means "nothing synced yet since boot", not "lag == version": say so explicitly.
    return {
      saveLatestVersion: latest, saveDurableVersion: durable, saveOldestUnsyncedAgeMs: oldest,
      saveUnsyncedUsers: unsyncedUsers, saveDurabilityPending: pendingBoot && durable === 0,
    };
  }

  /**
   * Non-blocking shutdown flush: fsync (async) the newest version of every user with a backlog,
   * largest backlog first, up to 3 at a time, and resolve by `timeoutMs` even if a sync never settles
   * (a blocking fsyncSync cannot be interrupted and also blocks the hard-exit timer). Never rejects.
   */
  async flushDurableAsync(timeoutMs = 10_000): Promise<void> {
    const todo = [...this.states.entries()]
      .filter(([, st]) => st.syncing !== null || (st.latest > 0 && (st.latest > st.durable || st.dirDirty || st.parentDirty)))
      .sort((x, y) => this.backlogOf(y[1]) - this.backlogOf(x[1]));
    if (todo.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((res) => {
      timer = setTimeout(() => res("deadline"), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < todo.length) {
        const [dir, st] = todo[next++]!;
        try {
          // A background sync already running for this user is awaited at the end (the overall deadline
          // bounds it). The dir/parent flags stay set until a directory sync SUCCEEDS, so whatever that
          // sync has not finished is still owed here and is done now, concurrently with it.
          const running = st.syncing;
          if (st.latest <= 0) {
            if (st.parentDirty) { const sq = st.parentSeq; await this.syncDir(this.dataDir); if (st.parentSeq === sq) st.parentDirty = false; }
            if (running) { try { await running; } catch { /* handled inside */ } }
            continue;
          }
          if (st.latest <= st.durable && !st.dirDirty && !st.parentDirty) {
            if (running) { try { await running; } catch { /* handled inside */ } }
            continue;
          }
          await this.syncFile(this.fileFor(dir, st.latest));
          if (st.dirDirty) { const sq = st.dirSeq; try { await this.syncDir(dir); if (st.dirSeq === sq) st.dirDirty = false; } catch { /* best-effort */ } }
          if (st.parentDirty) { const sq = st.parentSeq; try { await this.syncDir(this.dataDir); if (st.parentSeq === sq) st.parentDirty = false; } catch { /* best-effort */ } }
          this.markDurable(dir, st, st.latest);
          if (running) { try { await running; } catch { /* handled inside */ } }
        } catch (e) {
          try { this.onError(`[orwell] save.flush failed code=${(e as { code?: string } | null)?.code ?? "unknown"}`); } catch { /* ignore */ }
        }
      }
    };
    const all = Promise.all([worker(), worker(), worker()]).then(() => "done" as const);
    const r = await Promise.race([all, deadline]);
    if (timer) clearTimeout(timer);
    if (r === "deadline") {
      try { this.onError("[orwell] save.flush deadline reached; remaining saves not fsynced"); } catch { /* ignore */ }
    }
  }

  /** Bounded retention (B58/audit E4): keep the recent window + the newest periodic checkpoints. */
  private prune(dir: string, latest: number, st: DirState): void {
    const keep = new Set<number>();
    const existing = this.versionsPresent(dir);
    // ORW-404: always keep the highest EXISTING version <= durable (the newest fully synced save),
    // never delete a version whose fsync is in flight, and keep everything that was on disk at boot
    // until one fsync has completed.
    if (st.durable === 0) {
      // No fsynced version is known for this user: every file may be unsynced, so keep them all up to
      // a generous cap (never prune a never-synced user down to a few unsynced files).
      const cap = FileSaveStore.UNSYNCED_KEEP_CAP;
      if (existing.length <= cap) return;
      for (const v of existing.slice(0, cap)) keep.add(v);
      if (!st.capWarned) {
        st.capWarned = true;
        try { this.onError(`[orwell] save.prune running without a synced save: ${existing.length} unsynced versions, oldest being pruned`); } catch { /* ignore */ }
      }
    }
    const synced = existing.find((v) => v <= st.durable);
    if (synced !== undefined && st.durable > 0) keep.add(synced);
    if (st.inFlight !== null) keep.add(st.inFlight);
    if (st.bootVersions) for (const v of st.bootVersions) keep.add(v);
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
    for (const v of existing) {
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
