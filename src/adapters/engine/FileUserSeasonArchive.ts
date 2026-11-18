import {
  mkdirSync, readFileSync, renameSync, existsSync,
  openSync, writeSync, fsyncSync, closeSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import type { UserSeasonArchive } from "../../ports/UserSeasonArchive";
import type { ArchivedHouseguest } from "../../engine/seasonMemory";

/** Append-only merge: entries for a season already on file are ignored. */
function merge(prior: readonly ArchivedHouseguest[], add: readonly ArchivedHouseguest[]): ArchivedHouseguest[] {
  const have = new Set(prior.map((h) => h.season));
  const out = [...prior];
  const seasons = [...new Set(add.map((h) => h.season))].filter((s) => !have.has(s)).sort((a, b) => a - b);
  for (const s of seasons) out.push(...add.filter((h) => h.season === s));
  return out;
}

/**
 * Disk-backed per-USER `UserSeasonArchive` (feature 0208). One JSON per user under `<dataDir>/season-archive/<hex-user>.json`, in a SEPARATE subtree from the
 * per-season saves (a season restart never touches it) and keyed by a HEX encoding of the user id (no user string becomes a path segment). Atomic + durable write.
 */
export class FileUserSeasonArchive implements UserSeasonArchive {
  private readonly baseDir: string;

  constructor(dataDir?: string) {
    const root = dataDir ?? process.env.ORWELL_DATA_DIR ?? process.env.BBAI_DATA_DIR ?? "./.orwell-data";
    this.baseDir = join(root, "season-archive");
  }

  private fileFor(user: string): string {
    const file = join(this.baseDir, `${Buffer.from(user, "utf8").toString("hex")}.json`);
    const base = resolve(this.baseDir);
    const real = resolve(file);
    if (real !== base && !real.startsWith(base + sep)) throw new Error("FileUserSeasonArchive: refusing a path that escapes the archive dir");
    return file;
  }

  read(user: string): ArchivedHouseguest[] {
    const file = this.fileFor(user);
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as ArchivedHouseguest[]) : [];
    } catch (e) {
      // Quarantine the bad bytes (recoverable) rather than let the next append overwrite the player's whole history; read as no history this season.
      try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* best-effort */ }
      console.error(`[orwell] season archive file for a user was corrupt and has been quarantined (${e instanceof Error ? e.message : String(e)})`);
      return [];
    }
  }

  append(user: string, entries: readonly ArchivedHouseguest[]): void {
    const prior = this.read(user);
    const merged = merge(prior, entries);
    if (merged.length === prior.length) return;
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
    } catch { /* best-effort directory fsync */ }
  }
}

/** In-memory `UserSeasonArchive` (the test adapter + the default when no durable store is composed). Per-user keyed. */
export class InMemoryUserSeasonArchive implements UserSeasonArchive {
  private readonly byUser = new Map<string, ArchivedHouseguest[]>();

  read(user: string): ArchivedHouseguest[] {
    return (this.byUser.get(user) ?? []).map((h) => JSON.parse(JSON.stringify(h)) as ArchivedHouseguest);
  }

  append(user: string, entries: readonly ArchivedHouseguest[]): void {
    this.byUser.set(user, merge(this.byUser.get(user) ?? [], entries.map((h) => JSON.parse(JSON.stringify(h)) as ArchivedHouseguest)));
  }
}
