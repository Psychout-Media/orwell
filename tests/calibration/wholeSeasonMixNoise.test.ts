import { it } from "vitest";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { poolSeason, evaluate } from "../support/wholeSeasonMix";
import type { MixScene } from "../support/houseMixDriver";

/**
 * ORW-944: REPORT, NOT A GATE. How much does the whole-season mix guard's own reading move with NOTHING changed but the game's identity? A game is its seed plus its sandbox name
 * (ORW-852), so replaying the guard's seeds under other sandbox names gives independent plays of the same code: the guard lane's own seed noise. For each replica the guard's
 * pooling (`poolSeason`) and rules (`evaluate`) are applied exactly as in the guard; per rule this prints the mean, the spread and the standard deviation across replicas, and
 * the margin it supports (`RULE_MARGIN` in tests/support/wholeSeasonMix.ts is set from these lines). Replica 0 is the guard's own game (`wf-<seed>`).
 * Skipped unless ORWELL_MIX_NOISE=1. ORWELL_MIX_NOISE_REPLICAS (default 8), ORWELL_MIX_NOISE_PARALLEL (seasons at once, default 12). Counts only, no content.
 */
const RUN = process.env.ORWELL_MIX_NOISE === "1";
// The guard lane's seeds (tests/uat/wholeSeasonMixGuard.test.ts SEEDS; not imported: importing a test file would run the guard here). Override with ORWELL_MIX_NOISE_SEEDS.
const SEEDS = (process.env.ORWELL_MIX_NOISE_SEEDS ?? "1,2,3,6").split(",").map(Number);
const REPLICAS = Number.parseInt(process.env.ORWELL_MIX_NOISE_REPLICAS ?? "8", 10);
const PARALLEL = Number.parseInt(process.env.ORWELL_MIX_NOISE_PARALLEL ?? "12", 10);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
type Out = { seed: number; stopped: string; scenes: Array<[string, number, number]> };

function play(seed: number, sandbox: string): Promise<Out | null> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", join(ROOT, "tests/support/whatFired/seasonScenes.ts"), String(seed), "9000", sandbox], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 2_400_000 }, (err, stdout) => {
      const line = String(stdout).split("\n").find((l) => l.startsWith("SEASONSCENES "));
      resolve(err || !line ? null : (JSON.parse(line.slice("SEASONSCENES ".length)) as Out));
    });
  });
}

async function pool<T>(jobs: Array<() => Promise<T>>, n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => { while (next < jobs.length) { const i = next++; out[i] = await jobs[i]!(); } }));
  return out;
}

it.skipIf(!RUN)("prints the guard lane's per-rule seed noise", async () => {
  const sandboxOf = (seed: number, r: number): string => (r === 0 ? `wf-${seed}` : `wf-${seed}-noise${r}`);
  const jobs = Array.from({ length: REPLICAS }, (_, r) => SEEDS.map((seed) => () => play(seed, sandboxOf(seed, r)))).flat();
  const results = await pool(jobs, PARALLEL);
  const byRule = new Map<string, number[]>();
  for (let r = 0; r < REPLICAS; r++) {
    const outs = results.slice(r * SEEDS.length, (r + 1) * SEEDS.length);
    if (outs.some((o) => !o || o.stopped !== "finished")) { console.log(`NOISE replica ${r}: incomplete (${outs.map((o, i) => `${SEEDS[i]}:${o?.stopped ?? "none"}`).join(" ")}), left out`); continue; }
    const scenes: MixScene[] = outs.flatMap((o) => o!.scenes.map(([type, week, out]) => ({ type, action: "", msg: 0, week, playerOut: out === 1 })));
    const rules = evaluate(poolSeason(scenes).shares);
    console.log(`NOISE replica ${r}: ${rules.map((x) => `${x.id}=${x.value}`).join(" ")}`);
    for (const x of rules) byRule.set(x.id, [...(byRule.get(x.id) ?? []), x.value]);
  }
  for (const [id, vals] of [...byRule].sort()) {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length - 1));
    console.log(`NOISE rule ${id} n=${vals.length} mean=${mean.toFixed(1)} min=${Math.min(...vals).toFixed(1)} max=${Math.max(...vals).toFixed(1)} sd=${sd.toFixed(2)} twoSd=${(2 * sd).toFixed(1)}`);
  }
}, 7_000_000);
