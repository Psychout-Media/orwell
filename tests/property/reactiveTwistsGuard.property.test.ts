import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePending } from "../../features/support/answerPending";

/**
 * Reactive twists ON (PO ruling 2026-11-03: "I want to know if this breaks the game") under the FULL deployed flag profile — the full-season
 * multi-seed guard. His invariant: THE JURY OF 9 NEVER CHANGES UNDER ANY TWIST. Per seed (the auto-player answers every card the engine raises):
 * one winner among a Final 2, a jury of exactly 9, the cast conserved with nobody evicted twice, the outgoing HOH never wins the next HOH, the
 * veto holder is never their own replacement, and no twist fires twice. Also tallies WHEN each twist fires (week) across the seeds — the data behind
 * "how likely is a twist in week 1". Roles only.
 */
const profile = execFileSync("bash", ["-c", 'source "$1" && orwell_optin_env_defaults "$2"', "_", "deploy/orwell-env-defaults.sh", "/nonexistent/orwell-data"], { encoding: "utf8" })
  .split("\n").map((l) => l.trim()).filter((l) => /^ORWELL_[A-Z0-9_]+=\S+$/.test(l)).filter((l) => !/^ORWELL_(EMBEDDINGS|EMBED_CACHE)=/.test(l));
for (const line of profile) { const i = line.indexOf("="); process.env[line.slice(0, i)] = line.slice(i + 1); }
process.env.ORWELL_REACTIVE_TWISTS = "1";
const { GameSessionRegistry } = await import("../../src/composition/registry");
const { composeRuntime } = await import("../../src/composition/runtime");
const { FileSaveStore } = await import("../../src/adapters/engine/FileSaveStore");
type Live = NonNullable<ReturnType<InstanceType<typeof GameSessionRegistry>["sandboxFor"]>["session"]["snapshot"] extends () => infer R ? R : never>["live"];

const SEEDS = Number(process.env.ORWELL_TWIST_GUARD_SEEDS ?? 50);
// seed 9 fires a battle-back AND a double eviction (the case that tripped the integrity circuit before the juryHouseArrivals fix); 1 and 2 fire neither/one
const INTEGRITY_SEEDS_LIST = (process.env.ORWELL_TWIST_INTEGRITY_SEEDS ?? "1,2,9").split(",").map(Number);
const CAST = 16;
let n = 0;

interface SeasonResult { health: { faults: unknown[]; circuitOpen: boolean }; seed: number; fired: { kind: string; beat: number }[]; jury: number; finalTwo: number; winner: unknown; evictions: number }

function playSeason(seed: number, integrity = false): SeasonResult {
  const user = `tw${n++}`;
  // production = every commit goes through the orchestrator's fail-closed non-degradation checkpoint (slow: it persists each commit), so only the
  // `integrity` phase pays for it; the wide 50-seed phase drives the bare session
  const runtime = integrity ? composeRuntime({ saveStore: new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-twist-guard-"))) }) : null;
  const s = (runtime ? runtime.registry : new GameSessionRegistry()).sandboxFor(user).session;
  s.createCharacter({ playerName: "P", seed });
  let lastHoh: string | undefined;
  for (let i = 0; i < 9000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    const live = s.snapshot().live as NonNullable<Live>;
    // cast conserved; nobody in two places
    expect(live.active.length + live.evictionOrder.length, `seed ${seed}: the cast is conserved`).toBe(CAST);
    expect(new Set([...live.active, ...live.evictionOrder]).size, `seed ${seed}: nobody is both active and evicted, or evicted twice`).toBe(CAST);
    // HOH eligibility: a NEW HOH is never the outgoing HOH; veto holder is never their own replacement
    if (live.hoh && live.hoh !== lastHoh) {
      if (lastHoh !== undefined) expect(live.hoh, `seed ${seed}: the outgoing HOH cannot win the next HOH`).not.toBe(lastHoh);
      lastHoh = live.hoh;
    }
    if (live.replacement && live.vetoHolder) expect(live.replacement, `seed ${seed}: the veto holder cannot be the replacement nominee`).not.toBe(live.vetoHolder);
    if (v.finished) break;
  }
  const live = s.snapshot().live as NonNullable<Live>;
  const h = runtime ? (runtime.orchestrator.sandboxHealth(user) as { faults: unknown[]; circuitOpen: boolean }) : { faults: [], circuitOpen: false };
  return {
    health: { faults: h.faults, circuitOpen: h.circuitOpen },
    seed, fired: (live.firedTwists ?? []).map((t) => ({ kind: t.kind, beat: t.beat })), jury: (live.jury ?? []).length,
    finalTwo: (live.finalTwo ?? []).length, winner: live.winner, evictions: live.evictionOrder.length,
  };
}

describe(`reactive twists ON under the deployed profile: ${SEEDS}-seed full-season guard`, () => {
  it("every season has one winner, a Final 2, a jury of EXACTLY 9, no twist twice; and reports when twists fire", () => {
    const results: SeasonResult[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = playSeason(seed);
      results.push(r);
      expect(r.health.faults, `seed ${seed}: zero integrity faults through the production commit checkpoint (fired: ${r.fired.map((f) => f.kind).join(",") || "none"})`).toEqual([]);
      expect(r.health.circuitOpen, `seed ${seed}: the integrity circuit never opens`).toBe(false);
      expect(r.winner, `seed ${seed}: a winner is crowned`).toBeTruthy();
      expect(r.finalTwo, `seed ${seed}: a Final 2`).toBe(2);
      expect(r.jury, `seed ${seed}: the jury of 9 never changes under any twist (fired: ${r.fired.map((f) => f.kind).join(",") || "none"})`).toBe(9);
      const kinds = r.fired.map((f) => f.kind);
      expect(new Set(kinds).size, `seed ${seed}: no twist fires twice`).toBe(kinds.length);
    }
    const byKind: Record<string, number[]> = {};
    for (const r of results) for (const f of r.fired) (byKind[f.kind] ??= []).push(f.beat);
    const summary = Object.fromEntries(Object.entries(byKind).map(([k, w]) => [k, { seasons: w.length, earliestWeek: Math.min(...w), weeks: w.sort((a, b) => a - b) }]));
    // eslint-disable-next-line no-console
    console.log(`TWIST FIRING over ${SEEDS} seeds: ${JSON.stringify(summary)}; seasons with any twist: ${results.filter((r) => r.fired.length).length}`);
    expect(Object.values(byKind).flat().filter((w) => w <= 1).length, "no twist can fire in week 1 (no trigger can be earned that early)").toBe(0);
  }, 600_000);
});

describe("reactive twists ON through the PRODUCTION runtime: the integrity checkpoint never trips", () => {
  it(`seeds ${INTEGRITY_SEEDS_LIST.join(",")}: zero integrity faults, the circuit stays closed, jury 9 (a battle-back that thinned persisted state would be refused every turn)`, () => {
    let withTwist = 0;
    for (const seed of INTEGRITY_SEEDS_LIST) {
      const r = playSeason(seed, true);
      if (r.fired.length) withTwist++;
      expect(r.health.faults, `seed ${seed}: zero integrity faults (fired: ${r.fired.map((f) => f.kind).join(",") || "none"})`).toEqual([]);
      expect(r.health.circuitOpen, `seed ${seed}: the integrity circuit never opens`).toBe(false);
      expect(r.jury, `seed ${seed}: jury of 9`).toBe(9);
      expect(r.winner, `seed ${seed}: crowned`).toBeTruthy();
    }
    expect(withTwist, "the sample actually exercised twists").toBeGreaterThan(0);
  }, 1_800_000);
});
