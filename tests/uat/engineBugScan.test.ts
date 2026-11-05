import { describe, it, expect } from "vitest";
import { startUatHarness, runFullGameDirect, resolveUatSeedShard, type RunResult } from "./fullGameUatHarness";

/**
 * B21 (#1934 engine bug scan) - a RUNNER-ONLY scan, skipped unless `ORWELL_BUG_SCAN=<N>`: plays N full games (seeds 1..N, never-use-veto) on the CURRENT DEFAULT FLAGS (the deployed set: beliefs, belief
 * noms, memory + writers, premiere, hang-out, deal consent... ON; `ORWELL_FLAGS_OFF` must be UNSET) and asserts 0 rule violations (the harness's anomaly checks: unfinished game, no winner, illegal state,
 * Vault leak, stale loop, daily-event gap...) and DETERMINISM (the first `ORWELL_BUG_SCAN_DET` seeds, default 20, are played a SECOND time in a fresh runtime and must match: winner, weeks, decision counts,
 * anomaly count). Prints one summary line with the counts and any violating seed. Seed-shardable via UAT12_SHARDS/UAT12_SHARD. Never part of CI. Roles only.
 */
const N = Number(process.env["ORWELL_BUG_SCAN"] ?? 0);
const DET = Number(process.env["ORWELL_BUG_SCAN_DET"] ?? 20);
const { seeds, label } = resolveUatSeedShard(Array.from({ length: N }, (_, i) => i + 1));
const digest = (r: RunResult) => JSON.stringify({ w: r.winner?.id ?? null, k: r.weeksPlayed, d: r.decisionCounts, a: r.anomalies.length, f: r.finished });

describe.skipIf(!N)(`engine bug scan - ${N} games on default flags - ${label}`, () => {
  it("0 rule violations, every game finishes with a winner, and the first seeds replay identically", async () => {
    expect(process.env["ORWELL_FLAGS_OFF"], "the scan must run on the DEFAULT flags").toBeUndefined();
    const h1 = await startUatHarness();
    const runs: RunResult[] = [];
    try { for (const s of seeds) runs.push(await runFullGameDirect(h1.directResolver, s, "never-use-veto")); } finally { await h1.close(); }
    const h2 = await startUatHarness();
    const replay: RunResult[] = [];
    try { for (const s of seeds.slice(0, DET)) replay.push(await runFullGameDirect(h2.directResolver, s, "never-use-veto")); } finally { await h2.close(); }

    const bad = runs.filter((r) => r.anomalies.length > 0 || !r.finished || !r.winner);
    const nondeterministic = replay.filter((r, i) => digest(r) !== digest(runs[i]!)).map((r) => r.seed);
    const kinds: Record<string, number> = {};
    for (const a of runs.flatMap((r) => r.anomalies)) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
    console.log(`BUGSCAN ${label} games=${runs.length} violating=${bad.length} violatingSeeds=${JSON.stringify(bad.map((r) => r.seed))} anomalyKinds=${JSON.stringify(kinds)} replayed=${replay.length} nondeterministic=${JSON.stringify(nondeterministic)}`);
    for (const r of bad.slice(0, 5)) console.log(`BUGSCAN seed ${r.seed}: ${r.anomalies.slice(0, 3).map((a) => `[${a.kind}] w${a.week} ${a.beat}: ${a.detail}`).join(" | ") || "(unfinished / no winner)"}`);
    expect(bad.map((r) => r.seed), "violating seeds").toEqual([]);
    expect(nondeterministic, "seeds that did not replay identically").toEqual([]);
  }, 3_600_000);
});
