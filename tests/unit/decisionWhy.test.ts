import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { RelationshipModel } from "../../src/engine/relationships";
import { generateHouse } from "../../src/engine/characterFactory";
import { newLiveSeason, advance, applyDecision, autoDecision, type SeasonCtx, type LiveSeasonState } from "../../src/engine/liveSeason";
import { sumTerms, type DecisionWhy } from "../../src/engine/decisionWhy";
import { decideDealConsent, type DealConsentInputs } from "../../src/engine/dealConsent";
import { finalHohChoice } from "../../src/engine/juryMinds";
import { nominationPlan, replacementPick } from "../../src/engine/season";
import { PLAYER } from "../../src/domain/ids";
import { autoResolve } from "../uat/fullGameUatHarness";
import { endHeldNight } from "../support/heldNight";

/**
 * ORW-305 - every NPC decision records WHY as a hidden, engine-only breakdown of named terms (a RECORD, never an input).
 * Roles only. The byte-identical-outcomes half is proven by the headless / played digests in the ORW-305 report and by the whole existing seeded suite.
 */
function season(seed: number): { s: LiveSeasonState; why: DecisionWhy[]; checks: string[] } {
  const { npcs } = generateHouse(new SeededRandom(seed));
  const ids = [PLAYER, ...npcs.map((n) => n.id)];
  const rng = new SeededRandom(seed);
  const rel = new RelationshipModel(0.5);
  for (const a of ids) for (const b of ids) if (a !== b) { const e = rel.edge(a, b); e.trust = rng.next(); e.affinity = rng.next(); e.threat = rng.next(); e.confidence = 0.5; }
  const ctx: SeasonCtx = { player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel };
  const s = newLiveSeason(ids);
  const checks: string[] = [];
  for (let g = 0; g < 10_000 && !s.finished; g++) {
    const ev = s.pending ? applyDecision(s, autoDecision(s, ctx, rng), ctx, rng) : advance(s, ctx, rng);
    // The recorded decision IS the decision made: the nomination target and each NPC ballot match the record.
    if (ev?.beat === "nominations" && s.hoh !== PLAYER) {
      const last = [...(s.decisionWhy ?? [])].reverse().find((w) => w.kind === "nomination-target" && w.by === s.hoh && w.week === s.week);
      if (last?.options[0]!.option !== s.nominationTarget) checks.push(`nomination target mismatch wk${s.week}`);
    }
  }
  for (const rec of s.voteRecord ?? []) {
    for (const [voter, vote] of Object.entries(rec.voteOf)) {
      if (voter === PLAYER) continue;
      const w = (s.decisionWhy ?? []).find((x) => x.kind === "vote" && x.by === voter && x.week === rec.week);
      if (!w) checks.push(`no vote why for ${voter} wk${rec.week}`);
      else if (w.options[0]!.option !== vote) checks.push(`vote mismatch ${voter} wk${rec.week}`);
    }
  }
  return { s, why: s.decisionWhy ?? [], checks };
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const all = SEEDS.map(season);
const records = all.flatMap((x) => x.why);

describe("ORW-305 decision WHY breakdowns", () => {
  it("every decision kind a headless season makes is recorded", () => {
    const kinds = new Set(records.map((r) => r.kind));
    for (const k of ["nomination-target", "nomination-seat", "replacement", "vote", "veto", "final-hoh-eviction"] as const) expect(kinds.has(k), k).toBe(true);
  });

  it("the recorded decision is the decision made (nomination target, every NPC ballot)", () => {
    expect(all.flatMap((x) => x.checks)).toEqual([]);
  });

  it("the sum of the recorded terms reproduces the chosen option's score and ranks it first", () => {
    expect(records.length).toBeGreaterThan(100);
    for (const r of records) {
      const [chosen, ru] = r.options;
      expect(chosen!.role).toBe("chosen");
      expect(sumTerms(chosen!.terms) === chosen!.total, `${r.kind} chosen sum`).toBe(true);
      if (ru) {
        expect(ru.role).toBe("runner-up");
        expect(sumTerms(ru.terms) === ru.total, `${r.kind} runner-up sum`).toBe(true);
        expect(chosen!.total >= ru.total, `${r.kind}: chosen ranks first`).toBe(true);
      }
      for (const o of r.options) for (const [name, size] of o.terms) { expect(name.length).toBeGreaterThan(0); expect(Number.isFinite(size)).toBe(true); }
    }
  });

  it("mutation: dropping the largest term from any breakdown breaks the sum", () => {
    let mutated = 0;
    for (const r of records) {
      const c = r.options[0]!;
      if (c.terms.length < 2) continue;
      let big = 0;
      c.terms.forEach((t, i) => { if (Math.abs(t[1]) > Math.abs(c.terms[big]![1])) big = i; });
      const dropped = c.terms.filter((_, i) => i !== big);
      expect(sumTerms(dropped) === c.total, `${r.kind}: a dropped term must show`).toBe(false);
      mutated++;
    }
    expect(mutated).toBeGreaterThan(50);
  });

  it("vote terms carry the named reads (threat, bloc, memory, bond-keep, ...)", () => {
    const names = new Set(records.filter((r) => r.kind === "vote").flatMap((r) => r.options.flatMap((o) => o.terms.map((t) => t[0]))));
    for (const n of ["threat", "jury-management", "bond-keep"]) expect(names.has(n), n).toBe(true);
    const nom = new Set(records.filter((r) => r.kind === "nomination-target").flatMap((r) => r.options.flatMap((o) => o.terms.map((t) => t[0]))));
    expect(nom.has("threat")).toBe(true);
  });

  it("the tactic (target / pawn / backdoor / direct) rides the nomination records", () => {
    const tactics = new Set(records.filter((r) => r.kind === "nomination-target").map((r) => r.tactic));
    expect([...tactics].every((t) => typeof t === "string")).toBe(true);
    expect(records.filter((r) => r.kind === "replacement").every((r) => r.tactic === "pawn" || r.tactic === "target")).toBe(true);
  });

  it("the WHY is JSON-safe and a record only: absent sink => same nominees", () => {
    for (const r of records) expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    const { npcs } = generateHouse(new SeededRandom(3));
    const ids = [PLAYER, ...npcs.map((n) => n.id)];
    const rel = new RelationshipModel(0.5);
    const rng = new SeededRandom(3);
    for (const a of ids) for (const b of ids) if (a !== b) { const e = rel.edge(a, b); e.trust = rng.next(); e.affinity = rng.next(); e.threat = rng.next(); }
    const sunk: unknown[] = [];
    const a = nominationPlan(ids[1]!, ids, rel, { mood: 0.2 });
    const b = nominationPlan(ids[1]!, ids, rel, { mood: 0.2, why: (w) => sunk.push(w) });
    expect(b).toEqual(a);
    expect(sunk.length).toBeGreaterThanOrEqual(2);
    // a rattled HOH (mood 0.2): the paranoia term is live, named, and the breakdown still reproduces each score
    for (const w of sunk as Array<Omit<DecisionWhy, "by" | "week">>) for (const o of w.options) expect(sumTerms(o.terms) === o.total).toBe(true);
    const nt = (sunk as Array<Omit<DecisionWhy, "by" | "week">>).find((w) => w.kind === "nomination-target")!;
    expect(nt.options[0]!.terms.map((t) => t[0])).toContain("paranoia");
    const rp1 = replacementPick(ids[1]!, ids[2]!, ids.slice(3, 8), ids, rel, { mood: 0.2 });
    const rp2 = replacementPick(ids[1]!, ids[2]!, ids.slice(3, 8), ids, rel, { mood: 0.2, why: (w) => sunk.push(w) });
    expect(rp2).toBe(rp1);
  });

  const baseDeal: DealConsentInputs = { kind: "safety", trust: 0.8, affinity: 0.7, threat: 0.2, grudge: 0, favor: 0.1, targetsMe: 0, jitter: 0.01, mood: 0.02 };
  it.each([["accepts", baseDeal], ["refuses", { ...baseDeal, trust: 0.1, affinity: 0.1, threat: 0.9, grudge: 0.2 }]] as const)("deal consent %s: terms sum to the score the decision used", (_n, inp) => {
    const got: Array<Omit<DecisionWhy, "by" | "week">> = [];
    const d = decideDealConsent(inp, (w) => got.push(w));
    expect(decideDealConsent(inp)).toEqual(d); // a record only
    const w = got[0]!;
    expect(w.kind).toBe("deal-consent");
    expect(w.options[0]!.option).toBe(d.accept ? "accept" : "refuse");
    for (const o of w.options) expect(sumTerms(o.terms) === o.total).toBe(true);
    expect(w.options[0]!.total >= w.options[1]!.total).toBe(true);
    const acc = w.options.find((o) => o.option === "accept")!;
    expect(acc.terms.map((t) => t[0])).toContain("trust");
  });

  it("the NPC Final HOH's character choice records jury-odds / threat / bond", () => {
    const got: Array<Omit<DecisionWhy, "by" | "week">> = [];
    const me = { archetype: "strategist", strategyStyle: "schemer", secretKinds: [] } as never;
    const opts = [
      { evict: "a", keep: "b", myJuryShareVsKeep: 0.7, threatOfEvict: 0.4, bondWithEvict: 0.3 },
      { evict: "b", keep: "a", myJuryShareVsKeep: 0.4, threatOfEvict: 0.6, bondWithEvict: 0.2 },
    ];
    const d = finalHohChoice(me, opts, (w) => got.push(w));
    expect(finalHohChoice(me, opts)).toEqual(d);
    const w = got[0]!;
    expect(w.options[0]!.option).toBe(d.evict);
    for (const o of w.options) expect(sumTerms(o.terms) === o.total).toBe(true);
    expect(w.options[0]!.total >= w.options[1]!.total).toBe(true);
  });

  it("survives save and restore, and the record only ever grows (append-only)", async () => {
    process.env.ORWELL_BEDTIME_GATE = "0";
    const d = mkdtempSync(join(tmpdir(), "orwell-305-"));
    const reg = new GameSessionRegistry(new FileSaveStore(d));
    const sb = reg.sandboxFor("u");
    const srv = reg.resolver()("player", "u");
    const call = async (n: string, a: Record<string, unknown>) => (await srv.callTool(n, a)) as any;
    await call("createCharacter", { playerName: "P", seed: 7 });
    type S = { live: LiveSeasonState; snapshot(): { live?: LiveSeasonState } };
    const sess = sb.session as unknown as S;
    let prev = 0;
    for (let i = 0; i < 600 && (sess.live?.decisionWhy?.length ?? 0) < 40; i++) {
      const v = await call("advanceGame", {});
      if (v.held) { await endHeldNight(call, "w", undefined, { direct: true }); continue; }
      if (v.pending) await call("submitDecision", autoResolve(v.pending, "never-use-veto"));
      const n = sess.live?.decisionWhy?.length ?? 0;
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
    expect((sess.live.decisionWhy?.length ?? 0)).toBeGreaterThan(10);
    const before = sess.snapshot().live?.decisionWhy;
    reg.saveUser("u");
    const after = (new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as S).snapshot().live?.decisionWhy;
    expect(after).toEqual(before);
    // and it never rides any player-facing result of this game
    expect(JSON.stringify(await call("getGameState", {}))).not.toContain("decisionWhy");
  });
});
