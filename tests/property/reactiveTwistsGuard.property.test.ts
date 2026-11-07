import { endHeldNightSync } from "../support/heldNight";
import { describe, it, expect } from "vitest";
import { freshTmpDir } from "../support/freshTmpDir";
import { execFileSync } from "node:child_process";
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
  .split("\n").map((l) => l.trim()).filter(Boolean)
  .map((l) => { if (!/^ORWELL_[A-Z0-9_]+=\S+$/.test(l)) throw new Error(`unexpected line from orwell_optin_env_defaults: ${l}`); return l; })
  .filter((l) => !/^ORWELL_(EMBEDDINGS|EMBED_CACHE)=/.test(l));
if (profile.length < 20) throw new Error(`the deployed flag profile did not load (${profile.length} flags)`);
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

interface SeasonResult { health: { faults: unknown[]; circuitOpen: boolean } | null; seed: number; fired: { kind: string; beat: number }[]; jury: number; finalTwo: number; winner: unknown; evictions: number }

function playSeason(seed: number, integrity = false): SeasonResult {
  const user = `tw${n++}`;
  // production = every commit goes through the orchestrator's fail-closed non-degradation checkpoint (slow: it persists each commit), so only the
  // `integrity` phase pays for it; the wide 50-seed phase drives the bare session
  const runtime = integrity ? composeRuntime({ saveStore: new FileSaveStore(freshTmpDir("orwell-twist-guard-")) }) : null;
  const s = (runtime ? runtime.registry : new GameSessionRegistry()).sandboxFor(user).session;
  s.createCharacter({ playerName: "P", seed });
  let lastHoh: string | undefined;
  for (let i = 0; i < 9000; i++) {
    const v = s.advanceGame();
    if (v.held) endHeldNightSync(s); // ORW-116: a held night is the player's: time passes, then they turn in
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
  const h = runtime ? (runtime.orchestrator.sandboxHealth(user) as { faults: unknown[]; circuitOpen: boolean }) : null;
  return {
    health: h ? { faults: h.faults, circuitOpen: h.circuitOpen } : null,
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
    // AMEND 0025 (Ryne-approved): the firing windows #2037 measured over 50 seeds, pinned PERMANENTLY — none in weeks 1-6; earliest battle-back wk 7, double eviction wk 8,
    // secret veto wk 12. A `>=` floor (never an exact seed pin): a future change that lets a twist fire earlier must be a deliberate, reviewed choice.
    expect(Object.values(byKind).flat().filter((w) => w <= 6).length, "no reactive twist fires in weeks 1-6").toBe(0);
    // A9 flip (2026-11-04, deliberate + reviewed): with the premiere entrances ON (the deployed default, which this lane runs) the first-read fold re-seeds the society, and the earliest secret
    // veto in the 50-seed sample moved from week 12 to week 11 (CI measurement on the flip). The floor is the measured window, never an exact seed pin.
    // ORW-37 flip (2026-11-06, deliberate + reviewed): lasting game philosophies ON re-seed who nominates whom, and the earliest secret veto in the 50-seed sample moved from week 11 to week 9 (CI measurement on the flip). The floor is the measured window, never an exact seed pin; the "no twist in weeks 1-6" rule above is unchanged.
    // ORW-116 (2026-11-06): the clock now runs from the premiere entry and the night is held until the player turns in, which re-seeds the society again; the earliest secret veto in the 50-seed sample moved from week 11 to week 8 (a measurement, not a pin).
    const FLOOR: Record<string, number> = { "battle-back": 7, "double-eviction": 8, "secret-veto": 8 };
    for (const [kind, floor] of Object.entries(FLOOR)) {
      const weeks = byKind[kind] ?? [];
      expect(Math.min(...(weeks.length ? weeks : [floor])), `${kind} never fires before week ${floor}`).toBeGreaterThanOrEqual(floor);
      if (SEEDS >= 50) expect(weeks.length, `the ${SEEDS}-seed sample actually exercises ${kind} (non-vacuous)`).toBeGreaterThan(0);
    }
  }, 600_000);
});

describe("reactive twists ON through the PRODUCTION runtime: the integrity checkpoint never trips", () => {
  it(`seeds ${INTEGRITY_SEEDS_LIST.join(",")}: zero integrity faults, the circuit stays closed, jury 9 (a battle-back that thinned persisted state would be refused every turn)`, () => {
    let withTwist = 0;
    for (const seed of INTEGRITY_SEEDS_LIST) {
      const r = playSeason(seed, true);
      if (r.fired.length) withTwist++;
      expect(r.health, `seed ${seed}: the production runtime ran`).not.toBeNull();
      expect(r.health!.faults, `seed ${seed}: zero integrity faults (fired: ${r.fired.map((f) => f.kind).join(",") || "none"})`).toEqual([]);
      expect(r.health!.circuitOpen, `seed ${seed}: the integrity circuit never opens`).toBe(false);
      expect(r.jury, `seed ${seed}: jury of 9`).toBe(9);
      expect(r.winner, `seed ${seed}: crowned`).toBeTruthy();
    }
    expect(withTwist, "the sample actually exercised twists").toBeGreaterThan(0);
  }, 1_800_000);
});
