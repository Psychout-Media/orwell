import { defineConfig } from "vitest/config";

/**
 * The heavy, end-to-end SIMULATION files — full live seasons played to completion.
 * They are intentional calibration/UAT guarantees (anti-sycophancy #3) and they dominate
 * wall-clock (each plays many full seasons). CI keeps them in the FUNCTIONAL gate but runs
 * them in a dedicated, PARALLEL job (`test:heavy`) so the main unit job returns fast, and
 * EXCLUDES them from the COVERAGE run only: under v8 instrumentation they re-execute the whole
 * live loop a second, slower time yet add no BRANCH coverage in the gated dirs that the rest of
 * the live-loop suite (restartSpine, liveProgression, liveSeason, advanceToFinale, playerEviction,
 * liveSentinel, liveFairness, …) does not already cover. The per-directory branch thresholds
 * below still hold with these excluded (re-measured; ratchet UP only).
 *
 * Single source of truth: `test:heavy` runs exactly this set; `test:unit:fast` and the coverage
 * run exclude exactly this set. Keep the three in lockstep (the npm scripts reference these globs).
 *
 * The full-game UAT is split across three files (fullGameUat.{12seed,5seed,decisions}.test.ts —
 * fanned out across separate CI heavy-sims runners; their shared driver lives in the non-test
 * fullGameUatHarness.ts, which `include: tests/**\/*.test.ts` never picks up). The `tests/uat/**`
 * glob below covers all of them, so this exclusion set stays a single source of truth without
 * needing to enumerate each split file.
 */
export const HEAVY_SIM_FILES = [
  "tests/uat/**",
  "tests/property/juryReach.property.test.ts",
  // The jury-reach AGGREGATE consumes shard artifacts (no live play of its own) but rides the
  // heavy lane next to the shards it recombines — excluded from the fast/coverage runs alongside them.
  "tests/property/juryReachAggregate.property.test.ts",
  "tests/property/calibrationGradient.property.test.ts",
  // The gradient AGGREGATE consumes shard artifacts (no live play of its own) but rides the heavy
  // lane next to the shards it recombines — excluded from the fast/coverage runs alongside them.
  "tests/property/calibrationGradientAggregate.property.test.ts",
  // The calibration data INSTRUMENT (not a gate — it plays 2×N full live seasons and only EMITS
  // a data artifact, asserts no band). Excluded from the fast gate + coverage like the heavy sims;
  // run it on demand: `npx vitest run tests/calibration/calibrationInstrument.test.ts`.
  "tests/calibration/**",
];

/**
 * ORW-229 nightly split: the slowest SEASON-REPLAYING unit/property files. They still run on EVERY push, un-instrumented, in the `test-unit`
 * legs; only their second, v8-instrumented run in the per-push `coverage-shard` legs is skipped (vitest.shard.config.ts), because it costs the
 * most coverage time and adds no gated-dir branch coverage the rest of the suite lacks (COVERAGE_MEASUREMENT_PLACEHOLDER). The nightly run
 * (`ORWELL_COVERAGE_FULL=1`, ci-nightly.yml) measures coverage over every file with the same floors. Re-measure before adding a file (docs/CI.md).
 */
export const COVERAGE_NIGHTLY_ONLY = [
  // a glob, so the list stays right if the sweep is split into several files (as #2240 proposes)
  "tests/property/vaultSentinelAnnouncements*.property.test.ts",
  "tests/unit/earlyEviction.test.ts",
  "tests/unit/contestedEvictionIntegrity.test.ts",
  "tests/unit/spectatorReraise.test.ts",
  "tests/property/reactiveTwistsGuard.property.test.ts",
  "tests/unit/evictedModePrompt.test.ts",
  "tests/property/reactiveTwistsPlayerPaths.property.test.ts",
  "tests/unit/showrunnerReweight.test.ts",
  "tests/unit/copresenceRumorClaims.test.ts",
  "tests/unit/socialFatigueNeutral.test.ts",
  "tests/property/movementStreamIsolation.property.test.ts",
  "tests/unit/beatAnnouncementBoundary.test.ts",
  "tests/unit/beliefProvenance.test.ts",
];

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // A9 flip: pin the premiere-entrances flag per test file (unit lane OFF; property/uat/calibration lanes run the deployed default). See the file.
    setupFiles: ["tests/support/premiereTestDefault.ts"],
    // One private, auto-removed TMPDIR per run (the ~95 mkdtemp sites leaked ~8 GB into the RAM-backed /tmp). Guard: tests/unit/tmpRunIsolation.test.ts.
    globalSetup: ["tests/support/tmpRunGlobalSetup.ts"],
    // The architecture test shells out to dependency-cruiser, which can take a
    // moment on a cold cache; give the whole suite generous headroom.
    testTimeout: 30_000,
    // ORW-229 flaky-test rule (docs/CI.md): on GitHub Actions, also list every test that needed CI's automatic retry (`--retry=1` in ci.yml) in the
    // job summary, so a flake is counted, not hidden (tests/support/flakyReporter.ts). A lane that passes its own `--reporter` (the coverage-shard
    // blobs) replaces this list; the `coverage` merge job reads those blobs back and reports their retries.
    reporters: process.env.GITHUB_ACTIONS === "true" ? ["default", "./tests/support/flakyReporter.ts"] : ["default"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/ports/**", "src/main.ts"],
      // Coverage thresholds (B70/audit C8): CI runs `test:cov`, so coverage can no longer
      // silently regress. Per-directory BRANCH floors sit just under today's measured levels
      // (engine 92.7 · composition 90 · adapters/engine ~86 after the C9 fail-closed tests) —
      // the audit's ≥90 target is met for engine/composition; adapters/engine is ratcheted from
      // its real level and should only move UP. Re-measured with HEAVY_SIM_FILES excluded from
      // the coverage run: every per-directory branch floor still passes (the heavy sims add no
      // gated-dir branch coverage the rest of the live-loop suite doesn't already provide).
      thresholds: {
        branches: 80,
        "src/engine/**": { branches: 90 },
        "src/composition/**": { branches: 88 },
        "src/adapters/engine/**": { branches: 82 },
      },
    },
  },
});
