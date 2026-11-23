import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASES, poolByPhase, poolSeason, evaluate, ratchet, fmtShare, type PhaseShares } from "../support/wholeSeasonMix";
import type { MixScene } from "../support/houseMixDriver";

/**
 * ORW-702 step 1: the WHOLE-SEASON house-life mix guard. It plays full seasons with the scripted talking player (the nightly report's player), reads the house-life scenes
 * by the game WEEK they happened in (early 1-3, mid 4-8, late 9+), counts only the weeks the player was still in the game, pools the scenes of all seasons per phase, and judges the
 * pooled shares against the agreed bands and hard rules in `tests/support/wholeSeasonMix.ts` (the one constants module; target note: vault "Whole Season Mix Target Proposal").
 * The week-1 guard (houseMixGuard.test.ts) is separate and untouched.
 *
 * It lands as a REPORTING guard: the rules main already meets are asserted; the ones it does not are in KNOWN_RED (a ratchet: a later slice that fixes one must move it out).
 * Heavy lane: `npm run test:heavy:season-mix` (the seasons play at the same time in child processes); prints `MIXWS` lines (counts and shares only, no content).
 * WSMIX_SEEDS='1,2' narrows the seeds for a local run (numbers only, no assertions).
 */
// The seeds that FINISH with the scripted player: 1, 2, 3 and 6 end at the crown in about 1-5 minutes each. Seeds 4, 5, 7, 8 and 9 did not finish in 15-40 minutes on the runner (a season that never ends:
// not a mix finding, a separate card); they are left out until that is fixed, and a hang can no longer wedge the lane because each test has a time limit.
export const SEEDS = [1, 2, 3, 6];
const MIN_SCENES = 100;
const SEASON_TIMEOUT_MS = 900_000; // 15 minutes per season; the slowest finishing seed takes about 5 on a fast machine
const MAX_MESSAGES = 40000; // far past a played season to the crown; a season that does not finish is reported (and fails the finish check)

function seedsToPlay(): { seeds: number[]; narrowed: boolean } {
  const env = process.env.WSMIX_SEEDS?.split(",").map(Number).filter(Number.isFinite);
  return env?.length ? { seeds: env, narrowed: true } : { seeds: SEEDS, narrowed: false };
}

interface SeasonOut { seed: number; stopped: string; week: number; messages: number; playerOutWeek: number | null; seconds: number; scenes: Array<[string, number, number]> }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** One season in a child process (the seeds play at the same time: a season is single-threaded work of up to ~5 minutes). A child that does not finish is killed and fails the test with its seed. */
function playInChild(seed: number): Promise<SeasonOut> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--import", "tsx", join(ROOT, "tests/support/whatFired/seasonScenes.ts"), String(seed), String(MAX_MESSAGES)], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, timeout: SEASON_TIMEOUT_MS }, (err, stdout, stderr) => {
      const line = String(stdout).split("\n").find((l) => l.startsWith("SEASONSCENES "));
      if (err || !line) return reject(new Error(`season ${seed} did not finish (${err?.killed ? `killed after ${SEASON_TIMEOUT_MS / 1000}s` : String(stderr).slice(0, 200) || String(err?.message).slice(0, 120)})`));
      resolve(JSON.parse(line.slice("SEASONSCENES ".length)) as SeasonOut);
    });
  });
}

describe("whole-season house-life mix guard", () => {
  it("plays seasons and judges the pooled per-phase mix", async () => {
    const { seeds, narrowed } = seedsToPlay();
    const all: MixScene[] = [];
    const per: SeasonOut[] = await Promise.all(seeds.map(playInChild));
    for (const r of per) {
      const scenes: MixScene[] = r.scenes.map(([type, week, out]) => ({ type, action: "", msg: 0, week, playerOut: out === 1 }));
      const shares = poolByPhase(scenes); // per seed: player-in scenes only (a seed with a short stay has an empty later phase)
      all.push(...scenes);
      console.log(`MIXWS seed ${r.seed}: ${r.stopped} week ${r.week} messages ${r.messages} playerOut ${r.playerOutWeek ?? "never"} ${r.seconds}s | ${PHASES.map((p) => `${p} ${fmtShare(shares[p])}`).join(" | ")}`);
      expect(r.stopped, `season ${r.seed} reached the crown`).toBe("finished");
    }
    const playerIn = poolByPhase(all);
    console.log(`MIXWS pooled, player in only (${seeds.length} seasons; bonding/strategy/gossip/conflict n): ${PHASES.map((p) => `${p} ${fmtShare(playerIn[p])}`).join(" | ")}`);
    const { shares: pooled, basis } = poolSeason(all);
    console.log(`MIXWS judged (${seeds.length} seasons): ${PHASES.map((p) => `${p} ${fmtShare(pooled[p])} [${basis[p]}]`).join(" | ")}`);
    const results = evaluate(pooled);
    for (const r of results) console.log(`MIXWS rule ${r.pass ? "pass" : "FAIL"} ${r.id} value ${r.value} miss ${r.miss}`);
    if (narrowed) { expect(pooled.early.n).toBeGreaterThan(0); return; }
    for (const p of PHASES) expect(pooled[p].n, `${p} phase has scenes to read (pooled over ${seeds.length} seasons)`).toBeGreaterThan(MIN_SCENES);
    const v = ratchet(results);
    expect(v.regressions, "rules main met that now fail").toEqual([]);
    expect(v.fixed, "KNOWN_RED lines that now pass: move them out").toEqual([]);
    expect(v.worse, "KNOWN_RED lines that got worse").toEqual([]);
  }, 1_200_000);
});
