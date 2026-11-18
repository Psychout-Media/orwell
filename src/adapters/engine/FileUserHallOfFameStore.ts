import { mkdirSync, readFileSync, renameSync, existsSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { UserHallOfFameStore } from "../../ports/UserHallOfFameStore";
import { mergeHall, type HallRecord } from "../../engine/hallOfFame";

/**
 * Disk-backed per-USER `UserHallOfFameStore` (0208 B3): one small JSON per user under `<dataDir>/hall-of-fame/<hex-user>.json`, a SEPARATE subtree from the
 * per-season saves (the season-restart rotation never touches it) and from `notoriety/`. Hex-encoded user keys (no traversal, no cross-user read); atomic durable
 * writes (temp, fsync, rename, dir fsync); a corrupt file is quarantined, never overwritten.
 */
export class FileUserHallOfFameStore implements UserHallOfFameStore {
  private readonly baseDir: string;

  constructor(dataDir?: string) {
    const root = dataDir ?? process.env.ORWELL_DATA_DIR ?? process.env.BBAI_DATA_DIR ?? "./.orwell-data";
    this.baseDir = join(root, "hall-of-fame");
  }

  private fileFor(user: string): string {
    const file = join(this.baseDir, `${Buffer.from(user, "utf8").toString("hex")}.json`);
    const base = resolve(this.baseDir);
    const real = resolve(file);
    if (real !== base && !real.startsWith(base + sep)) throw new Error("FileUserHallOfFameStore: refusing a path that escapes the hall-of-fame dir");
    return file;
  }

  read(user: string): HallRecord[] {
    const file = this.fileFor(user);
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as HallRecord[]) : [];
    } catch (e) {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* best-effort quarantine */ }
      console.error(`[orwell] hall-of-fame file for a user was corrupt and has been quarantined (${e instanceof Error ? e.message : String(e)}); that user reads as having no hall this season`);
      return [];
    }
  }

  append(user: string, record: HallRecord): void {
    const merged = mergeHall(this.read(user), [record]);
    mkdirSync(this.baseDir, { recursive: true });
    const file = this.fileFor(user);
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(merged), null, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    try {
      const dirFd = openSync(this.baseDir, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch { /* best-effort: some platforms refuse directory fsync */ }
  }
}

/** In-memory `UserHallOfFameStore` (tests + the default when no durable store is composed). Per-user keyed; monotonic append. */
export class InMemoryUserHallOfFameStore implements UserHallOfFameStore {
  private readonly byUser = new Map<string, HallRecord[]>();
  read(user: string): HallRecord[] { return [...(this.byUser.get(user) ?? [])]; }
  append(user: string, record: HallRecord): void { this.byUser.set(user, mergeHall(this.byUser.get(user) ?? null, [record])); }
}
