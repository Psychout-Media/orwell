import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import base, { COVERAGE_NIGHTLY_ONLY } from "./vitest.config";

/**
 * ORW-39 (faster release pipeline) - the config the SHARDED coverage legs use.
 *
 * Each coverage-shard leg runs a disjoint slice of the SAME unit suite under v8 and emits a blob; one `coverage` merge job (`vitest --merge-reports --coverage`, the ORIGINAL
 * vitest.config.ts) recombines the blobs and enforces the thresholds exactly ONCE on the merged measurement. A shard sees only part of the tests, so it must not enforce the
 * floors itself (it would fail on its partial slice) - this config zeroes them for the shard legs only. The floors in vitest.config.ts are untouched and are the only ones enforced.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      // ORW-229: per push the coverage legs skip COVERAGE_NIGHTLY_ONLY (those files still run in test-unit on every push); the nightly call sets
      // ORWELL_COVERAGE_FULL=1 so its coverage covers every file. The floors are unchanged and still enforced once, on the merged blobs.
      exclude: process.env.ORWELL_COVERAGE_FULL === "1" ? configDefaults.exclude : [...configDefaults.exclude, ...COVERAGE_NIGHTLY_ONLY],
      coverage: {
        thresholds: {
          branches: 0,
          "src/engine/**": { branches: 0 },
          "src/composition/**": { branches: 0 },
          "src/adapters/engine/**": { branches: 0 },
        },
      },
    },
  }),
);
