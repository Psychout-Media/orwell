import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, utimesSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * the per-run temp folder (`orwell-run-*`) of the vitest, cucumber and pytest harnesses. A run that is killed (an agent's command times out, a dropped session, an OOM kill) skips its
 * teardown and strands the folder: one stranded run held 2 to 6 GB, and a dozen agents filled the shared temp volume. Two guards: a sweep at the START of the next run, and a teardown on SIGTERM/SIGINT.
 */
export const RUN_PREFIX = "orwell-run-";
export const STALE_AFTER_MS = 20 * 60_000;

/** Is a live process using `dir` (its TMPDIR/TMP/TEMP points at it, or its working directory is inside it)? Linux /proc only; where /proc cannot be read nothing is swept (never guess). */
export function inUse(dir: string, proc = "/proc"): boolean {
  let pids: string[];
  try { pids = readdirSync(proc).filter((n) => /^\d+$/.test(n)); } catch { return true; }
  for (const pid of pids) {
    try {
      for (const kv of readFileSync(join(proc, pid, "environ"), "utf8").split("\0")) {
        const m = /^(?:TMPDIR|TMP|TEMP)=(.*)$/.exec(kv);
        if (m && m[1] === dir) return true;
      }
    } catch { /* another user's process, or gone */ }
    try {
      const cwd = readlinkSync(join(proc, pid, "cwd"));
      if (cwd === dir || cwd.startsWith(dir + sep)) return true;
    } catch { /* ditto */ }
  }
  return false;
}

/** Remove stranded `orwell-run-*` directories directly under `base`: a real directory (never a symlink), owned by this user, older than `maxAgeMs`, not `keep` (this run's own), and not in use by a live process. Returns what was removed. Never throws. */
export function sweepStaleRunDirs(
  base: string,
  opts: { keep?: string; maxAgeMs?: number; now?: number; uid?: number; inUseFn?: (dir: string) => boolean } = {},
): string[] {
  const removed: string[] = [];
  const now = opts.now ?? Date.now();
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  const maxAge = opts.maxAgeMs ?? STALE_AFTER_MS;
  const busy = opts.inUseFn ?? inUse;
  let names: string[];
  try { names = readdirSync(base); } catch { return removed; }
  for (const n of names) {
    if (!n.startsWith(RUN_PREFIX)) continue;
    const p = join(base, n);
    try {
      const st = lstatSync(p);
      if (!st.isDirectory() || st.uid !== uid || now - st.mtimeMs <= maxAge) continue;
      if (opts.keep !== undefined && p === opts.keep) continue;
      if (busy(p)) continue;
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch { /* best effort */ }
  }
  return removed;
}

/** Remove `run` when the process is told to stop (SIGTERM from `timeout`, SIGINT from ctrl-C), then exit with the signal's usual code. The normal-exit teardown stays the caller's. */
export function removeRunOnSignals(run: string): void {
  // A live run keeps its folder's modification time fresh, so another run's sweep (which cannot see a TMPDIR set after the process started) never mistakes a long quiet stretch for a stranded folder.
  const beat = setInterval(() => { try { const t = new Date(); utimesSync(run, t, t); } catch { /* gone */ } }, 5 * 60_000);
  beat.unref();
  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
    process.once(sig, () => {
      try { rmSync(run, { recursive: true, force: true }); } catch { /* best effort */ }
      process.exit(code);
    });
  }
}
