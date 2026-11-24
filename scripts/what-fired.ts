/**
 * ORW-729 (Automation 1): the nightly "what fired" report. A DEVELOPER TOOL: it plays full seasons in-process with a scripted talking player (no model calls, seeded) and writes
 * one markdown report. It is not an MCP/HTTP tool and no surface imports it. Usage (see docs/WHAT-FIRED.md or `--help`):
 *
 *   tsx scripts/what-fired.ts run      [--seeds 1,2,3] [--restarts 1] [--restart-seeds 1] [--no-determinism] [--ablate-seeds 1] [--ablate-max N] [--shard i/n] [--out DIR] [--previous summary.json] [--date YYYY-MM-DD]
 *   tsx scripts/what-fired.ts baseline [--seeds ...] [--restarts K] --out DIR                  (the played seasons, the determinism check, the restart runs)
 *   tsx scripts/what-fired.ts ablate   --trace-dir DIR [--ablate-seeds ...] [--shard i/n] [--ablate-max N] --out DIR   (the flag ablations, one child process per flag and seed)
 *   tsx scripts/what-fired.ts report   --in DIR[,DIR...] --out DIR [--previous summary.json] [--date ...]      (merge, render, diff)
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const mode = argv[0] && !argv[0].startsWith("--") ? argv[0] : "run";
const arg = (k: string, d?: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const nums = (s: string | undefined, d: number[]): number[] => (s ? s.split(",").map(Number).filter(Number.isFinite) : d);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const today = (): string => new Date().toISOString().slice(0, 10);

// A season is saved and reloaded through a throw-away folder; the engine's own stores must never touch the repository's data dir.
const scratch = mkdtempSync(join(tmpdir(), "what-fired-"));
process.env["ORWELL_DATA_DIR"] = join(scratch, "data");
delete process.env["ORWELL_FLAGS_OFF"];
if (mode === "ablate-one") { // the toggled flag is read when the engine module loads, so the env is set BEFORE any engine import (each ablation is its own process)
  process.env[arg("flag")!] = arg("to")!;
}
const cleanup = (): void => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } };
process.on("exit", cleanup);

const writeJson = (p: string, v: unknown): void => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v)); };
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;
const shardOf = <T>(xs: T[], spec: string | undefined): T[] => { if (!spec) return xs; const [i, n] = spec.split("/").map(Number) as [number, number]; return xs.filter((_, k) => k % n === i); };

async function baseline(out: string): Promise<void> {
  const { playSeason } = await import("../tests/support/whatFired/player");
  const { firstDifference, restartPoints, restartVerdict } = await import("../tests/support/whatFired/compare");
  const seeds = nums(arg("seeds"), [1, 2, 3]);
  const maxMessages = Number(arg("max-messages", "40000"));
  const restartsPer = Number(arg("restarts", "1"));
  const restarts: unknown[] = [], determinism: unknown[] = [];
  for (const [n, seed] of seeds.entries()) {
    const t0 = Date.now();
    const r = await playSeason({ seed, maxMessages, survive: true });
    const { trace, ...rest } = r;
    writeJson(join(out, `season-${seed}.json`), rest); writeJson(join(out, `trace-${seed}.json`), trace);
    console.log(`[what-fired] seed ${seed}: ${r.stopped} at message ${r.messages}, week ${r.week}, player out ${r.playerOutWeek ?? "never"}, ${r.scenes.filter((x) => x.week >= 9 && !x.playerOut).length} late-phase (week 9+) player-in scenes of ${r.scenes.filter((x) => x.week >= 9).length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    if (n === 0 && argv.includes("--determinism")) { const again = await playSeason({ seed, maxMessages, survive: true }); determinism.push({ seed, difference: firstDifference(trace, again.trace) }); }
    const restartSeeds = nums(arg("restart-seeds"), seeds);
    for (const point of restartSeeds.includes(seed) ? restartPoints(seed, restartsPer, r.messages) : []) {
      mkdirSync(scratch, { recursive: true }); // a runner that sweeps its temp folder between jobs must not take the scratch folder from under a run
      const dir = mkdtempSync(join(scratch, "save-"));
      const run = await playSeason({ seed, maxMessages, survive: true, restartAt: point, saveDir: dir });
      const difference = firstDifference(trace, run.trace);
      restarts.push({ seed, point, difference, verdict: restartVerdict(point, difference, run.trace), finished: run.finished });
      rmSync(dir, { recursive: true, force: true });
      console.log(`[what-fired] seed ${seed}: restart at ${point}: ${(restarts[restarts.length - 1] as { verdict: string }).verdict}`);
    }
  }
  writeJson(join(out, "restart.json"), restarts); writeJson(join(out, "determinism.json"), determinism);
}

async function ablateOne(): Promise<void> {
  const { playSeason } = await import("../tests/support/whatFired/player");
  const seed = Number(arg("seed"));
  const against = readJson<import("../tests/support/whatFired/player").TraceRow[]>(join(arg("trace-dir")!, `trace-${seed}.json`));
  const r = await playSeason({ seed, maxMessages: Number(arg("max-messages", "40000")), survive: true, against });
  writeJson(arg("result")!, { envKey: arg("flag"), seed, fired: r.stopped === "diverged", divergedAt: r.divergedAt ?? null, stopped: r.stopped, messages: r.messages });
}

async function ablate(out: string): Promise<void> {
  const { discoverFlags } = await import("../tests/support/whatFired/discover");
  const flags = shardOf(discoverFlags(), arg("shard"));
  const max = arg("ablate-max") ? Number(arg("ablate-max")) : flags.length;
  const seeds = nums(arg("ablate-seeds"), [1]);
  const traceDir = arg("trace-dir")!;
  const results: unknown[] = [];
  for (const f of flags.slice(0, max)) for (const seed of seeds) {
    const res = join(scratch, `abl-${f.envKey}-${seed}.json`);
    const p = spawnSync(process.execPath, ["--import", "tsx", join(HERE, "what-fired.ts"), "ablate-one", "--flag", f.envKey, "--to", f.ablateTo, "--seed", String(seed), "--trace-dir", traceDir, "--result", res, "--max-messages", arg("max-messages", "40000")!], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env } });
    if (p.status === 0 && existsSync(res)) { const r = readJson<{ fired: boolean; divergedAt: number | null }>(res); results.push(r); console.log(`[what-fired] ${f.envKey} seed ${seed}: ${r.fired ? `fires (first at message ${r.divergedAt})` : "ZERO"}`); }
    else console.log(`[what-fired] ${f.envKey} seed ${seed}: ablation child failed (status ${p.status}); not measured`);
  }
  writeJson(join(out, `ablate-${(arg("shard") ?? "0/1").replace("/", "of")}.json`), results);
}

async function report(dirs: string[], out: string): Promise<void> {
  const { discoverFlags, discoverFeatures } = await import("../tests/support/whatFired/discover");
  const { buildSummary, diffSummaries, renderMarkdown, assertClean } = await import("../tests/support/whatFired/report");
  const seasons: any[] = [], ablations: any[] = [], restarts: any[] = [], determinism: any[] = [];
  for (const d of dirs) for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (/^season-\d+\.json$/.test(f)) seasons.push(readJson(p));
    else if (/^ablate-.*\.json$/.test(f)) ablations.push(...readJson<any[]>(p));
    else if (f === "restart.json") restarts.push(...readJson<any[]>(p));
    else if (f === "determinism.json") determinism.push(...readJson<any[]>(p));
  }
  seasons.sort((a, b) => a.seed - b.seed);
  const date = arg("date", today())!;
  const s = buildSummary({ date, seasons, ablations, restarts, determinism, flags: discoverFlags(), features: discoverFeatures() });
  const prevPath = arg("previous");
  const prev = prevPath && existsSync(prevPath) ? readJson<import("../tests/support/whatFired/report").Summary>(prevPath) : null;
  const md = renderMarkdown(s, diffSummaries(prev, s));
  assertClean(md);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${date}.md`), md); writeJson(join(out, "summary.json"), s);
  console.log(md.split("\n").slice(0, Number(arg("head", "60"))).join("\n"));
  console.log(`[what-fired] report: ${join(out, `${date}.md`)}`);
}

(async () => {
  const out = resolve(ROOT, arg("out", join("tmp", "what-fired", arg("date", today())!))!);
  if (mode === "ablate-one") return ablateOne();
  if (mode === "baseline") return baseline(out);
  if (mode === "ablate") return ablate(out);
  if (mode === "report") return report((arg("in") ?? out).split(",").map((d) => resolve(ROOT, d)), out);
  if (mode === "run") { mkdirSync(out, { recursive: true }); if (!argv.includes("--no-determinism")) argv.push("--determinism"); await baseline(out); argv.push("--trace-dir", out); await ablate(out); return report([out], out); }
  console.error("usage: what-fired.ts run|baseline|ablate|report (see the header of this file)"); process.exit(2);
})().catch((e) => { console.error(e); process.exit(1); });
