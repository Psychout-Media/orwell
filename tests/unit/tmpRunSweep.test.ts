import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, existsSync, symlinkSync, utimesSync, writeFileSync, readFileSync, lstatSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inUse, sweepStaleRunDirs, RUN_PREFIX } from "../support/tmpRunSweep";

/** stranded per-run temp folders are swept at the start of the next run under guards, and a SIGTERM removes the run's own folder. Roles only. */
const old = (p: string, ageMs = 60 * 60_000): void => { const t = (Date.now() - ageMs) / 1000; utimesSync(p, t, t); };
const mk = (base: string, name: string, ageMs?: number): string => {
  const p = join(base, name); mkdirSync(p); writeFileSync(join(p, "save.json"), "x".repeat(100)); if (ageMs !== undefined) old(p, ageMs); return p;
};
const base = (): string => mkdtempSync(join(tmpdir(), "sweep-base-"));

describe("sweepStaleRunDirs", () => {
  it("removes a stale folder of this user and leaves a fresh one, another prefix, this run's own and one in use", () => {
    const b = base();
    const stale = mk(b, `${RUN_PREFIX}aaaa`, 60 * 60_000);
    const fresh = mk(b, `${RUN_PREFIX}bbbb`, 60_000);
    const other = mk(b, "something-else", 60 * 60_000);
    const mine = mk(b, `${RUN_PREFIX}cccc`, 60 * 60_000);
    const busy = mk(b, `${RUN_PREFIX}dddd`, 60 * 60_000);
    const got = sweepStaleRunDirs(b, { keep: mine, inUseFn: (d) => d === busy });
    expect(got).toEqual([stale]);
    expect([stale, fresh, other, mine, busy].map(existsSync)).toEqual([false, true, true, true, true]);
  });

  it("the age threshold is minutes, not hours", () => {
    const b = base();
    const p = mk(b, `${RUN_PREFIX}eeee`, 25 * 60_000);
    expect(sweepStaleRunDirs(b, { inUseFn: () => false })).toEqual([p]);
    const q = mk(b, `${RUN_PREFIX}ffff`, 10 * 60_000);
    expect(sweepStaleRunDirs(b, { inUseFn: () => false })).toEqual([]);
    expect(existsSync(q)).toBe(true);
  });

  it("never touches a folder of another owner", () => {
    const b = base();
    const p = mk(b, `${RUN_PREFIX}gggg`, 60 * 60_000);
    expect(sweepStaleRunDirs(b, { uid: (process.getuid?.() ?? 0) + 1, inUseFn: () => false })).toEqual([]);
    expect(existsSync(p)).toBe(true);
  });

  it("never follows or removes a symlink, and a link inside a swept folder loses only the link", () => {
    const b = base();
    const victim = mkdtempSync(join(tmpdir(), "sweep-victim-"));
    writeFileSync(join(victim, "keep.txt"), "precious");
    symlinkSync(victim, join(b, `${RUN_PREFIX}hhhh`));
    old(victim);
    expect(sweepStaleRunDirs(b, { inUseFn: () => false })).toEqual([]);
    expect(lstatSync(join(b, `${RUN_PREFIX}hhhh`)).isSymbolicLink()).toBe(true);
    const stale = mk(b, `${RUN_PREFIX}iiii`, 60 * 60_000);
    symlinkSync(victim, join(stale, "inner"));
    old(stale);
    expect(sweepStaleRunDirs(b, { inUseFn: () => false })).toEqual([stale]);
    expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("precious");
  });

  it("a folder a live process uses (its TMPDIR) is in use; once the process is gone it is not", async () => {
    if (process.platform !== "linux") return;
    const b = base();
    const p = mk(b, `${RUN_PREFIX}jjjj`, 60 * 60_000);
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], { env: { ...process.env, TMPDIR: p }, cwd: "/", stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(inUse(p)).toBe(true);
      expect(sweepStaleRunDirs(b)).toEqual([]);
    } finally {
      child.kill();
      await new Promise((r) => child.once("exit", r));
    }
    expect(inUse(p)).toBe(false);
    expect(sweepStaleRunDirs(b)).toEqual([p]);
  });
});

describe("removeRunOnSignals", () => {
  it.each(["SIGTERM", "SIGINT"])("%s removes the run folder and the process still ends", (sig) => {
    const run = mkdtempSync(join(tmpdir(), "sig-run-"));
    writeFileSync(join(run, "big"), "x");
    const mod = fileURLToPath(new URL("../support/tmpRunSweep.ts", import.meta.url));
    const code = `import { removeRunOnSignals } from ${JSON.stringify(mod)}; removeRunOnSignals(${JSON.stringify(run)}); process.kill(process.pid, ${JSON.stringify(sig)}); setTimeout(() => {}, 5000);`;
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 30_000 });
    expect(existsSync(run), r.stderr).toBe(false);
    expect(r.status).toBe(sig === "SIGTERM" ? 143 : 130);
  });
});
