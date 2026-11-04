# Coverage job runtime - proposal (S4; proposal only, nothing changed)

**Problem.** `coverage` (`npm run test:cov`: `vitest run --coverage` over the whole unit tree minus the heavy sims) takes ~14-15 min on `ubuntu-latest` and was being cancelled by its own 15-min timeout (#2050, #2053); the ceiling was raised to 25 (#2056). The unit tree keeps growing (~3,850 tests), so the ceiling will be hit again. It is the longest *required* leg in the ci-gate critical path.

**What was already tried (Coordinator, 2026-11-04).** `vitest --shard=i/N --reporter=blob` still enforces the per-directory branch thresholds *per shard* (each shard alone fails them), and `--merge-reports` only works with a single `--coverage` flag.

**Proposal (ranked).**
1. **Shard + merge, thresholds enforced once.** Run N=3 shards with `--coverage.thresholds.autoUpdate=false --coverage.reportOnFailure --coverage.thresholds.100=false` equivalent: set the thresholds OFF for shard runs via a config switch (`ORWELL_COV_SHARD=1` => `thresholds: undefined` in `vitest.config.ts`), have each shard upload its `coverage/.tmp` + blob report as an artifact, then a small `coverage-merge` job downloads them, runs `vitest --merge-reports --coverage` (single flag) and **that** job enforces the existing thresholds (engine 90 / composition 88 / adapters-engine 82 - unchanged). Wall-clock ~ max(shard) + ~1 min merge (est. 6-7 min); `ci-gate` needs `coverage-merge`.
2. **Cut instrumented work that adds no gated-dir branches.** The v8 run already excludes the heavy sims. Next candidates (measure first with `--coverage.reporter=json-summary` before/after): the large seeded-season unit files that re-play full seasons (`showrunnerReweight`, `noResultFlood`, the `calibration*Neutral` byte-identity twins) - they add runtime, almost no new branch coverage in `src/engine|composition|adapters/engine`. Move them to the plain (non-instrumented) `test` job only. Expected saving: 3-5 min; zero threshold risk if the post-change branch % in the three gated dirs is >= today's.
3. **Run coverage on the self-hosted .98 runner (3 slots) for PRs, keep ubuntu-latest for main.** Not recommended unless 1-2 are insufficient (adds a dependency on the runner box).

**Ratchet safety.** None of the above changes a threshold or drops a test: (1) keeps every test + the same thresholds (enforced on the merged report); (2) is guarded by a before/after `json-summary` diff of the three gated directories (must not fall).

**Recommendation.** Do (1) first (it removes the structural limit); do (2) only if (1)'s merge job is itself slow. Needs: one `vitest.config.ts` env switch, a matrix in `ci.yml`, a `coverage-merge` job, and `ci-gate.needs` updated. Not started - owner decision.
