import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { playMixGame } from "../support/houseMixDriver";
import { assurancePull, assuranceKeepChance, pullKeeps, assuranceTermScale } from "../../src/engine/assurances";

/**
 * ORW-723 (Ryne: "Depends on the person. For sure."): a vote promise's pull comes from the voter's own loyalty, honesty and bond to the nominee. Pure shape tests, then
 * real seeded games (the house-mix driver, no state injected): both outcomes occur, the pull of the keepers is higher than the pull of the breakers, a break folds once and
 * leaves the assured with the existing lied-to-me claim, and `ORWELL_ASSURANCE_PULL=0` is the old fixed weight.
 */
describe("ORW-723 the pull is monotone in the person", () => {
  const base = { loyalty: 0.5, honesty: 0.5, bond: 0.5, threat: 0.3 };
  it("rises with loyalty, honesty and bond and falls with threat", () => {
    for (const k of ["loyalty", "honesty", "bond"] as const) {
      let prev = -1;
      for (let x = 0; x <= 1.0001; x += 0.1) { const p = assurancePull({ ...base, [k]: x }); expect(p).toBeGreaterThanOrEqual(prev); prev = p; }
      expect(assurancePull({ ...base, [k]: 1 })).toBeGreaterThan(assurancePull({ ...base, [k]: 0 }));
    }
    expect(assurancePull({ ...base, threat: 0 })).toBeGreaterThan(assurancePull({ ...base, threat: 1 }));
  });
  it("is bounded and the keep chance and term scale follow it", () => {
    expect(assurancePull({ loyalty: 9, honesty: 9, bond: 9, threat: -9 })).toBeLessThanOrEqual(1);
    expect(assurancePull({ loyalty: -9, honesty: -9, bond: -9, threat: 9 })).toBeGreaterThanOrEqual(0);
    expect(assuranceKeepChance(0.9)).toBeGreaterThan(assuranceKeepChance(0.2));
    expect(assuranceTermScale(0.9)).toBeGreaterThan(assuranceTermScale(0.2));
  });
  it("at the same roll a loyal, honest, bonded voter keeps and a scheming, unbonded one breaks", () => {
    const loyal = assurancePull({ loyalty: 0.9, honesty: 0.9, bond: 0.8, threat: 0.1 });
    const schemer = assurancePull({ loyalty: 0.1, honesty: 0.1, bond: 0.1, threat: 0.7 });
    const rolls = [0.45, 0.55, 0.65];
    for (const r of rolls) { expect(pullKeeps(loyal, r)).toBe(true); expect(pullKeeps(schemer, r)).toBe(false); }
  });
});

type Live = { assurances?: { items: Array<{ id: string; from: string; to: string; kind: string; status: string; source: string }> }; beliefs?: Record<string, Array<{ kind: string; subject: string; value: boolean }>> };
type Sess = { live?: Live; assurancePullOf(v: string, n: string): number; assuranceVoteFor(n: string, v: string): number; setAssurancePullEnabled(on: boolean): void };

async function play(seed: number, off: boolean) {
  const kept: number[] = [], broke: number[] = [], shields = new Set<number>();
  const decided = new Map<string, { pull: number; shield: number }>();
  let brokenSeen = 0, claimOnceOk = true;
  const was = process.env.ORWELL_ASSURANCE_PULL;
  if (off) process.env.ORWELL_ASSURANCE_PULL = "0"; else delete process.env.ORWELL_ASSURANCE_PULL;
  try {
    await playMixGame(seed, 2500, { advanceEvery: 6, stopAtWeek: 5, onStep: (s) => {
      const sess = s as Sess;
      for (const a of sess.live?.assurances?.items ?? []) {
        if (a.source !== "npc" || a.from === "player" || a.to === "player" || a.kind !== "vote") continue;
        if (a.status === "open") { const sh = sess.assuranceVoteFor(a.to, a.from); shields.add(Math.round(sh * 1000)); decided.set(a.id, { pull: sess.assurancePullOf(a.from, a.to), shield: sh }); }
        else if (a.status === "broken" && decided.has(a.id) && !decided.has(`seen:${a.id}`)) {
          decided.set(`seen:${a.id}`, { pull: 0, shield: 0 }); brokenSeen++;
          const claims = (sess.live?.beliefs?.[a.to] ?? []).filter((c) => c.kind === "lied-to-me" && c.subject === a.from && c.value);
          if (claims.length > 1) claimOnceOk = false;
        }
      }
    } });
    for (const [id, d] of decided) if (!id.startsWith("seen:")) (d.shield > 0 ? kept : broke).push(d.pull);
  } finally { if (was === undefined) delete process.env.ORWELL_ASSURANCE_PULL; else process.env.ORWELL_ASSURANCE_PULL = was; }
  return { kept, broke, shields, brokenSeen, claimOnceOk };
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

describe("ORW-723 in real play", () => {
  it("ON: both outcomes occur, keepers carry a higher pull than breakers, shields vary by person", async () => {
    const all = [];
    for (const seed of [1, 2, 3, 4]) all.push(await play(seed, false));
    const kept = all.flatMap((a) => a.kept), broke = all.flatMap((a) => a.broke);
    expect(kept.length).toBeGreaterThan(0);
    expect(broke.length).toBeGreaterThan(0);
    expect(mean(kept)).toBeGreaterThan(mean(broke));
    expect(new Set(all.flatMap((a) => [...a.shields])).size).toBeGreaterThan(2); // not one fixed weight
    expect(all.every((a) => a.claimOnceOk)).toBe(true);
  }, 1_800_000);
  it("OFF: the shield is the one fixed weight (or none)", async () => {
    const off = await play(1, true);
    expect(off.shields.size).toBeLessThanOrEqual(2);
    expect([...off.shields].every((x) => x === 0 || x === 150)).toBe(true);
  }, 1_800_000);
});

describe("ORW-723 wall sentinel", () => {
  it("no port, surface or MCP adapter names the pull or its trait reads, so no number reaches the player, narrator or admin", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
    for (const f of [...walk("src/ports"), ...walk("src/surfaces"), ...walk("src/adapters/mcp")]) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/assurancePullOf|assuranceTraitsOf|assurancePull\b|assuranceKeepChance|assuranceTermScale/);
    }
  });
});
