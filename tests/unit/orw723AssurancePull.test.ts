import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { playMixGame } from "../support/houseMixDriver";
import { voteChoice, type SeasonCtx } from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import { PLAYER } from "../../src/domain/ids";
import { assurancePull, assuranceKeepChance, pullKeeps, assuranceTermScale, pullVerdict, decideKeep } from "../../src/engine/assurances";

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
    const rolls = [0.5, 0.6, 0.7];
    for (const r of rolls) { expect(pullKeeps(loyal, r)).toBe(true); expect(pullKeeps(schemer, r)).toBe(false); }
  });
});

type Live = { assurances?: { items: Array<{ id: string; from: string; to: string; kind: string; status: string; source: string }> }; beliefs?: Record<string, Array<{ kind: string; subject: string; value: boolean }>> };
type Sess = { assuranceBindFor(v: string, fn: readonly [string, string]): string | undefined; live?: Live & { hoh?: string; finalNominees?: [string, string] }; assurancePullOf(v: string, n: string): number; assuranceVoteFor(n: string, v: string): number; setAssurancePullEnabled(on: boolean): void };

async function play(seed: number, off: boolean) {
  const kept: number[] = [], broke: number[] = [], shields = new Set<number>();
  const decided = new Map<string, { pull: number; shield: number }>();
  let brokenSeen = 0, claimOnceOk = true, illegal = 0, bindsSeen = 0;
  const bound = new Set<string>(), finalStatus = new Map<string, string>();
  const was = process.env.ORWELL_ASSURANCE_PULL;
  if (off) process.env.ORWELL_ASSURANCE_PULL = "0"; else delete process.env.ORWELL_ASSURANCE_PULL;
  try {
    await playMixGame(seed, 2500, { advanceEvery: 6, stopAtWeek: 5, onStep: (s) => {
      const sess = s as Sess;
      const fnn = sess.live?.finalNominees;
      for (const a of sess.live?.assurances?.items ?? []) {
        finalStatus.set(a.id, a.status);
        if (a.status === "open" && fnn && fnn.length === 2) {
          const sp = sess.assuranceBindFor(a.from, fnn);
          if (sp === a.to) { bound.add(a.id); bindsSeen++; if (a.from === sess.live?.hoh || fnn.includes(a.from) || a.from === "player" || sess.assuranceVoteFor(a.to, a.from) === 0) illegal++; } else bound.delete(a.id); // ORW-1159: the pull moves with the bond and threat in the days before the vote; a bind the engine itself withdrew (the verdict turned to break) is no longer a bound voter at the ballot
        }
      }
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
  const boundBroken = [...bound].filter((id) => finalStatus.get(id) === "broken").length;
  return { kept, broke, shields, brokenSeen, claimOnceOk, illegal, bindsSeen, boundBroken };
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

describe("ORW-723 the pull DECIDES a sincere promise (it is not an extra gate on decideKeep)", () => {
  const ROLLS = Array.from({ length: 2000 }, (_, i) => (i + 0.5) / 2000);
  const loyal = assurancePull({ loyalty: 0.85, honesty: 0.85, bond: 0.5, threat: 0.2 });
  const schemer = assurancePull({ loyalty: 0.15, honesty: 0.15, bond: 0.2, threat: 0.5 });
  const rate = (f: (r: number) => boolean) => ROLLS.filter(f).length / ROLLS.length;
  it("a loyal voter keeps a sincere promise usually even where the old cost-benefit said break; a scheming one breaks it usually even where it said keep", () => {
    const legacyBreak = decideKeep({ keepWeight: 0.2, sincerity: 1, breakBenefit: 0.6 }), legacyKeep = decideKeep({ keepWeight: 0.9, sincerity: 1, breakBenefit: 0.0 });
    expect(legacyBreak).toBe(false); expect(legacyKeep).toBe(true);
    expect(rate((r) => pullVerdict({ plan: undefined, sincerity: 1, legacyKeep: legacyBreak, pull: loyal, roll: r }))).toBeGreaterThanOrEqual(0.7);
    expect(rate((r) => pullVerdict({ plan: undefined, sincerity: 1, legacyKeep: legacyKeep, pull: schemer, roll: r }))).toBeLessThanOrEqual(0.35);
    // the control: the old AND-gate design (legacy && pullKeeps) cannot lift a loyal voter's keep rate above the legacy verdict
    expect(rate((r) => legacyBreak && pullKeeps(loyal, r))).toBe(0);
  });
  it("a planned betrayal always breaks; a faked promise keeps the faking model's verdict", () => {
    expect(rate((r) => pullVerdict({ plan: true, sincerity: 1, legacyKeep: true, pull: loyal, roll: r }))).toBe(0);
    expect(pullVerdict({ plan: undefined, sincerity: 0.1, legacyKeep: true, pull: schemer, roll: 0.99 })).toBe(true);
    expect(pullVerdict({ plan: undefined, sincerity: 0.1, legacyKeep: false, pull: loyal, roll: 0.01 })).toBe(false);
  });
});

describe("ORW-723 a kept sincere promise BINDS the vote (red-first: the soft term never decided one)", () => {
  const ctxOf = (extra: Partial<SeasonCtx> = {}, trust = 0.5): SeasonCtx => ({ rel: new RelationshipModel(trust), player: PLAYER, ...extra } as unknown as SeasonCtx);
  it("a bound voter never evicts the assured, whatever the rest of the read says; no hook or a hook naming a non-nominee changes nothing", () => {
    for (let k = 0; k < 40; k++) {
      const fn: [string, string] = k % 2 ? ["npc:2", "npc:3"] : ["npc:3", "npc:2"];
      const ctx = (extra: Partial<SeasonCtx> = {}) => { const c = ctxOf(extra, (k % 10) / 10); c.rel.edge("npc:1", "npc:2").threat = (k % 7) / 7; c.rel.edge("npc:1", "npc:3").threat = ((k * 3) % 7) / 7; return c; };
      expect(voteChoice("npc:1", fn, ctx({ assuranceBindsVoteFor: () => "npc:2" }))).toBe("npc:3");
      expect(voteChoice("npc:1", fn, ctx({ assuranceBindsVoteFor: () => "npc:3" }))).toBe("npc:2");
      const free = voteChoice("npc:1", fn, ctx());
      expect(voteChoice("npc:1", fn, ctx({ assuranceBindsVoteFor: () => undefined }))).toBe(free);
      expect(voteChoice("npc:1", fn, ctx({ assuranceBindsVoteFor: () => "npc:9" }))).toBe(free);
    }
  });
});

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
    expect(all.reduce((x, a) => x + a.bindsSeen, 0)).toBeGreaterThan(0); // a kept promise binds in real play
    expect(all.reduce((x, a) => x + a.illegal, 0)).toBe(0); // never the HOH, a nominee, the player, or a promise whose verdict is break
    expect(all.reduce((x, a) => x + a.boundBroken, 0)).toBe(0); // a bound voter did not vote the assured out, so it was never broken
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
