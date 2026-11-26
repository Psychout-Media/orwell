import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASES, poolByPhase, poolSeason, evaluate, fmtShare, type PhaseShares } from "../support/wholeSeasonMix";
import { socialBroken } from "../support/brokenBounds";
import type { MixScene } from "../support/houseMixDriver";

/**
 * ORW-702 step 1: the WHOLE-SEASON house-life mix guard. It plays full seasons with the scripted talking player (the nightly report's player), reads the house-life scenes
 * by the game WEEK they happened in (early 1-3, mid 4-8, late 9+), counts only the weeks the player was still in the game, pools the scenes of all seasons per phase, and judges the
 * pooled shares against the agreed bands and hard rules in `tests/support/wholeSeasonMix.ts` (the one constants module; target note: vault "Whole Season Mix Target Proposal").
 * The week-1 guard (houseMixGuard.test.ts) is separate and untouched.
 *
 * ORW-991 (Ryne 2026-11-26: social balance is tracked weekly, not held per fix): it fails only when the mix is BROKEN (tests/support/brokenBounds.ts: a kind of scene gone, or one kind
 * over 75% of a phase). The agreed bands (`evaluate`) print as a report on every run and are tracked by the weekly calibration workflow; there is no ratchet.
 * Heavy lane: `npm run test:heavy:season-mix` (the seasons play at the same time in child processes); prints `MIXWS` lines (counts and shares only, no content).
 * WSMIX_SEEDS='1,2' narrows the seeds for a local run (numbers only, no assertions).
 * ORW-986 (the nightly slow-calibration workflow): WSMIX_REPLICAS=3 plays each seed under that many sandbox names (replica 0 is the guard's own game, the others
 * `wf-<seed>-noise<r>`, the same independent plays the ORW-944 noise report uses) and JUDGES the pool: 12 seasons instead of 4, so a late-phase change the 4-season
 * PR lane cannot see (late gossip and strategy swing about +-11 points there) shows. Default 1 = the PR guard, unchanged.
 */
// The seeds that FINISH with the scripted player: 1, 2, 3 and 6 end at the crown in about 1-5 minutes each. Seeds 4, 5, 7, 8 and 9 did not finish in 15-40 minutes on the runner (a season that never ends:
// not a mix finding, a separate card); they are left out until that is fixed, and a hang can no longer wedge the lane because each test has a time limit.
export const SEEDS = [1, 2, 3, 6];
const MIN_SCENES = 100;
// ORW-832: one limit for every season was wrong both ways (a long season with the player still in is slower than a short one, and a season that never ends had no bound but the clock). Each seed has its own time limit
// (the default, or its own entry here when a long played season needs more) and every season has a MESSAGE cap: a season past it is stopped and reported as "cap" (and fails the finish check), whatever the clock says.
const SEASON_TIMEOUT_MS_DEFAULT = 900_000; // 15 minutes; the slowest finishing seed used to take about 5 on a fast machine
const SEASON_TIMEOUT_MS_BY_SEED: Readonly<Record<number, number>> = {};
export const seasonTimeoutMs = (seed: number): number => (SEASON_TIMEOUT_MS_BY_SEED[seed] ?? SEASON_TIMEOUT_MS_DEFAULT) * Math.max(1, Number.parseInt(process.env.WSMIX_REPLICAS ?? "1", 10) || 1); // ORW-986: replicas share the cores
const MAX_MESSAGES = 9000; // a played season to the crown is about 1000 to 3500 messages; past this it is not finishing, and it is reported rather than waited for

function seedsToPlay(): { seeds: number[]; narrowed: boolean } {
  const env = process.env.WSMIX_SEEDS?.split(",").map(Number).filter(Number.isFinite);
  return env?.length ? { seeds: env, narrowed: true } : { seeds: SEEDS, narrowed: false };
}
const REPLICAS = Math.max(1, Number.parseInt(process.env.WSMIX_REPLICAS ?? "1", 10) || 1);
/** The sandbox name of replica `r` of a seed: replica 0 is the guard's own game (the child's default name), the others the ORW-944 noise replicas. */
const sandboxOf = (seed: number, r: number): string | undefined => (r === 0 ? undefined : `wf-${seed}-noise${r}`);

interface SeasonOut { seed: number; stopped: string; week: number; messages: number; playerOutWeek: number | null; seconds: number; msPerMessage?: number[]; scenes: Array<[string, number, number]> }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** One season in a child process (the seeds play at the same time: a season is single-threaded work of up to ~5 minutes). A child that does not finish is killed and fails the test with its seed. */
function playInChild(seed: number, sandbox?: string): Promise<SeasonOut> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--import", "tsx", join(ROOT, "tests/support/whatFired/seasonScenes.ts"), String(seed), String(MAX_MESSAGES), ...(sandbox ? [sandbox] : [])], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, timeout: seasonTimeoutMs(seed) }, (err, stdout, stderr) => {
      const line = String(stdout).split("\n").find((l) => l.startsWith("SEASONSCENES "));
      if (err || !line) return reject(new Error(`season ${seed} did not finish (${err?.killed ? `killed after ${seasonTimeoutMs(seed) / 1000}s` : String(stderr).slice(0, 200) || String(err?.message).slice(0, 120)})`));
      resolve(JSON.parse(line.slice("SEASONSCENES ".length)) as SeasonOut);
    });
  });
}

describe("whole-season house-life mix guard", () => {
  it("plays seasons and judges the pooled per-phase mix", async () => {
    const { seeds, narrowed } = seedsToPlay();
    const all: MixScene[] = [];
    const per: SeasonOut[] = await Promise.all(Array.from({ length: REPLICAS }, (_, r) => seeds.map((seed) => playInChild(seed, sandboxOf(seed, r)))).flat());
    for (const r of per) {
      const scenes: MixScene[] = r.scenes.map(([type, week, out]) => ({ type, action: "", msg: 0, week, playerOut: out === 1 }));
      const shares = poolByPhase(scenes); // per seed: player-in scenes only (a seed with a short stay has an empty later phase)
      all.push(...scenes);
      console.log(`MIXWS seed ${r.seed}: ${r.stopped} week ${r.week} messages ${r.messages} playerOut ${r.playerOutWeek ?? "never"} ${r.seconds}s (ms per message by 500: ${r.msPerMessage?.join("/") ?? "-"}) | ${PHASES.map((p) => `${p} ${fmtShare(shares[p])}`).join(" | ")}`);
      expect(r.stopped, `season ${r.seed} reached the crown`).toBe("finished");
    }
    const playerIn = poolByPhase(all);
    console.log(`MIXWS pooled, player in only (${per.length} seasons; bonding/strategy/gossip/conflict n): ${PHASES.map((p) => `${p} ${fmtShare(playerIn[p])}`).join(" | ")}`);
    const { shares: pooled, basis } = poolSeason(all);
    console.log(`MIXWS judged (${per.length} seasons): ${PHASES.map((p) => `${p} ${fmtShare(pooled[p])} [${basis[p]}]`).join(" | ")}`);
    const results = evaluate(pooled);
    // ORW-991 (Ryne 2026-11-26): the agreed bands are a REPORT (tracked weekly), never a failure; only a broken mix (tests/support/brokenBounds.ts) fails the build.
    for (const r of results) console.log(`MIXWS report ${r.pass ? "in-band" : "out-of-band"} ${r.id} value ${r.value} miss ${r.miss}`);
    if (narrowed) { expect(pooled.early.n).toBeGreaterThan(0); return; }
    for (const p of PHASES) expect(pooled[p].n, `${p} phase has scenes to read (pooled over ${seeds.length} seasons)`).toBeGreaterThan(MIN_SCENES);
    expect(socialBroken(pooled, MIN_SCENES), "the house-life mix is broken").toEqual([]);
  }, 1_200_000 * REPLICAS); // ORW-986: replicas share the cores
});
