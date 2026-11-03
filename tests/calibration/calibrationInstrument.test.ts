import { describe, it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { hashSeed } from "../../src/engine/characterFactory";

/**
 * CALIBRATION INSTRUMENT — data-gathering only (calibration revisit lane, 2026-06-19).
 *
 * The known game-feel concern: "passive players coast to Final 2 in ~half of seasons and then lose
 * there." The owner's decided approach is to INSTRUMENT AND GATHER DATA FIRST — quantify what is
 * actually happening before touching any tuning constant. This file is that instrument.
 *
 * It is NOT a gate. It changes NO calibration constant. It plays a configurable number of seeded
 * seasons under MULTIPLE player strategies (a PASSIVE coaster and an ACTIVE/strategic player) over
 * the SAME runtime composition `main.ts` uses (composeRuntime → registry → orchestrator commit
 * spine, pure turn-driven) and records structured per-season metrics:
 *   - the ladder reach (jury / F5 / F4 / F3 / F2 / win), read from the PUBLIC 0046 seat;
 *   - the player's PUBLIC competition wins (their visible resume);
 *   - the week the player's game was effectively decided (their eviction week, or the final week if
 *     they sat the Final 2);
 *   - the jury-vote margin at the finale (and by how much the player lost when they lost at F2);
 *   - how often the player BOTH reaches F2 AND loses there (the exact concern).
 *
 * It emits a machine-readable JSON artifact (`docs/audits/data/2026-06-19-calibration-data.json`)
 * plus feeds the written markdown analysis (`docs/audits/2026-06-19-calibration-data.md`).
 *
 * DETERMINISM: the two arms run over the SAME seeds, so any gap is a real, attributable effect of
 * play — never noise. The optional strategy-variation RNG draws from a DEDICATED hashSeed-forked
 * sub-stream (see `strategyRng`), so the engine's competition/vote RNG stream stays byte-identical
 * and the juryReach / gradient gates stay green (this isolation was the root cause of a prior
 * calibration regression — it is respected here).
 *
 * VAULT WALL: the instrument is engine-internal and reads ONLY Vault-free public projections
 * (`getGameState` / `advanceGame`). The artifact it writes is a dev/calibration doc — it is NOT
 * wired into any runtime player/admin surface. Roles only — no houseguest names in the metrics.
 *
 * Run it as a SINGLE bounded vitest file (never the heavy matrix):
 *   npx vitest run tests/calibration/calibrationInstrument.test.ts
 */

import { playSeason, summarize, type Arm, type SeasonMetrics, type ArmSummary, type Resolver } from "./calibrationArms";
const SEEDS = Number.parseInt(process.env.ORWELL_CALIB_SEEDS ?? "30", 10); // modest; a single run finishes in a few minutes
const SEED_START = Number.parseInt(process.env.ORWELL_CALIB_SEED_START ?? "1", 10); // shard offset for parallel runs
// `npm test` must NOT rewrite tracked files under docs/audits/data/. The artifact is only written on an
// explicit opt-in: ORWELL_CALIB_WRITE=1 (to the default tracked location) or an explicit ORWELL_CALIB_OUT dir.
const WRITE_ARTIFACTS = process.env.ORWELL_CALIB_WRITE === "1" || process.env.ORWELL_CALIB_OUT !== undefined;
const pct = (k: number, n: number): string => (n ? `${((100 * k) / n).toFixed(0)}%` : "—");

describe("calibration instrument — passive vs active reach/win data (no tuning changes)", () => {
  it(
    `plays ${SEEDS} seeded seasons per strategy and emits the calibration data artifact`,
    async () => {
      const runtime = composeRuntime({
        clock: new FakeClock(),
        seed: 1,
      });
      const resolver = runtime.registry.resolver();

      // A dedicated, FORKED strategy sub-stream — proves the isolation discipline even though the two
      // fixed policies here are deterministic. Any future randomized strategy MUST draw from THIS
      // stream so the engine's competition/vote RNG stays byte-identical (the prior-regression guard).
      const strategyRng = new SeededRandom(hashSeed("calibration-strategy-substream"));
      void strategyRng; // reserved for future randomized policies; touched so the import is load-bearing

      const passive: SeasonMetrics[] = [];
      const solid: SeasonMetrics[] = [];
      const reckless: SeasonMetrics[] = [];
      for (let seed = SEED_START; seed < SEED_START + SEEDS; seed++) {
        passive.push(await playSeason(resolver, seed, "passive"));
        solid.push(await playSeason(resolver, seed, "solid"));
        reckless.push(await playSeason(resolver, seed, "reckless"));
      }

      const passiveSummary = summarize("passive", passive);
      const solidSummary = summarize("solid", solid);
      const recklessSummary = summarize("reckless", reckless);

      const artifact = {
        generatedAt: "2026-06-19",
        note:
          "Calibration data-gathering instrument. Read-only over Vault-free public projections; no tuning constant was changed. " +
          "Same seeds for both arms (any gap is a real effect of play). Roles only — no houseguest names.",
        seeds: SEEDS,
        summary: { passive: passiveSummary, solid: solidSummary, reckless: recklessSummary },
        seasons: { passive, solid, reckless },
      };

      // A sharded run (SEED_START ≠ 1) without an explicit ORWELL_CALIB_OUT writes to its own subfolder, so
      // concurrent shards never overwrite each other's artifact.
      const outDir = process.env.ORWELL_CALIB_OUT ?? (SEED_START === 1
        ? resolve(__dirname, "../../docs/audits/data")
        : resolve(__dirname, "../../docs/audits/data", `seeds-${SEED_START}-${SEED_START + SEEDS - 1}`));
      const outPath = resolve(outDir, "2026-06-19-calibration-data.json");

      // A machine-GENERATED markdown summary companion (regenerated each run; distinct from the
      // hand-written analysis at docs/audits/2026-06-19-calibration-data.md). Calibration record
      // only — NOT a player/admin surface. Roles only.
      const mdRow = (s: ArmSummary): string =>
        `| ${s.arm} | ${s.seasons} | ${s.reachedJury} (${pct(s.reachedJury, s.seasons)}) ` +
        `| ${s.reachedF2} (${pct(s.reachedF2, s.seasons)}) | ${s.wins} (${pct(s.wins, s.seasons)}) ` +
        `| ${s.reachedF2AndLost} (${pct(s.reachedF2AndLost, s.seasons)}) | ${s.f2Wins}/${s.f2Losses} ` +
        `| ${s.meanCompWins.toFixed(2)} | ${s.meanCompWinsAtF2.toFixed(2)} ` +
        `| ${s.meanLossMargin === null ? "—" : s.meanLossMargin.toFixed(1)} |`;
      const md =
        `# Calibration data — passive vs solid vs reckless (generated)\n\n` +
        `> Auto-generated by \`tests/calibration/calibrationInstrument.test.ts\` (${SEEDS} seeds/arm, ` +
        `same seeds both arms). Read-only over Vault-free public projections; **no tuning constant changed**. ` +
        `Companion machine-readable data: \`data/2026-06-19-calibration-data.json\`. ` +
        `Narrative analysis + tuning recommendations: \`2026-06-19-calibration-data.md\`.\n\n` +
        `| arm | seasons | reached jury | reached F2 | won | **F2-and-lost** | F2 W/L | mean comp wins | mean comp wins @F2 | mean loss margin |\n` +
        `|---|---|---|---|---|---|---|---|---|---|\n` +
        `${mdRow(passiveSummary)}\n${mdRow(solidSummary)}\n${mdRow(recklessSummary)}\n`;
      const mdPath = resolve(outDir, "2026-06-19-calibration-data-summary.md");
      if (WRITE_ARTIFACTS) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
        writeFileSync(mdPath, md, "utf8");
      }

      // Console-summary so the run is legible in CI/log output (and for the markdown write-up).
      const line = (s: ArmSummary): string =>
        `${s.arm.padEnd(7)} | jury ${s.reachedJury}/${s.seasons} (${pct(s.reachedJury, s.seasons)}) ` +
        `F5 ${s.reachedF5} F4 ${s.reachedF4} F3 ${s.reachedF3} F2 ${s.reachedF2} (${pct(s.reachedF2, s.seasons)}) ` +
        `| wins ${s.wins} | F2-and-lost ${s.reachedF2AndLost} (${pct(s.reachedF2AndLost, s.seasons)}) ` +
        `| F2 W/L ${s.f2Wins}/${s.f2Losses} | meanComp ${s.meanCompWins.toFixed(2)} (atF2 ${s.meanCompWinsAtF2.toFixed(2)}) ` +
        `| meanLossMargin ${s.meanLossMargin === null ? "—" : s.meanLossMargin.toFixed(1)}`;
      // eslint-disable-next-line no-console
      console.log(`\n=== CALIBRATION DATA (${SEEDS} seeds/arm) ===\n${line(passiveSummary)}\n${line(solidSummary)}\n${line(recklessSummary)}\n${WRITE_ARTIFACTS ? `json: ${outPath}\nmd:   ${mdPath}` : "(artifacts not written — set ORWELL_CALIB_WRITE=1 or ORWELL_CALIB_OUT to persist)"}\n`);
    },
    { timeout: Number(process.env.ORWELL_CALIB_TIMEOUT_MS ?? 1_200_000) }, // 3 × SEEDS full live seasons; generous for loaded hosts
  );
});
