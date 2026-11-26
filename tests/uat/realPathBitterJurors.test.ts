import { describe, it, expect, beforeAll } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { JURY_GRUDGE_PERSONALITY } from "../../src/engine/juryConstants";
import type { DecisionWhy } from "../../src/engine/decisionWhy";
import { playedGame } from "../support/playedGame";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * Feature 0182 (ORW-569) BITTER JURORS, REAL PATH. One season is played through the player's levers to the finale, so every grudge a juror holds is one the engine
 * folded from what happened in the house. The game is saved there and the save is loaded twice (the persistence path): one copy plays the finale with grudges on,
 * the other with them off (a flag). The finale draws the same numbers in both, so the engine's own hidden record of each juror's vote (the decision WHY) shows the
 * grudge's whole effect: a juror's grudge against a finalist enters their vote for that finalist as a "grudge" term that leans AWAY (never toward), bounded by the cap;
 * a finalist they hold nothing against gets no such term; with grudges off there is no grudge term, and the relationship, game-respect, finale-performance and
 * finale-swing parts of every vote are the same to the bit (the grudge book also shapes the juror's memory read, ORW-607, so that part may move).
 * The seed is scanned from 11 (ORW-880): the first whose finale jury holds a grudge against a finalist (the precondition). The player is never a grudge holder.
 * HEAVY LANE (tests/uat/realPath*, the `real-path` leg): one played season, about 1-3 minutes.
 */
type Why = DecisionWhy;
type Run = { why: Why[]; votes: Record<string, string>; grudge: (j: string, f: string) => number; finalists: string[]; book: Record<string, unknown> };

describe("0182 REAL PATH: a juror's grudge leans their finale vote away from that finalist", () => {
  let on: Run, off: Run;
  beforeAll(() => {
    const run = (seed: number, save: unknown, grudges: boolean): Run => {
      const h = playedGame({ seed, user: `bitter-real-${grudges}`, from: save, before: (s) => s.setGrudgesEnabled(grudges) });
      h.playToCrown();
      const L = (h.s as unknown as { live: { decisionWhy?: Why[]; finale?: { votes?: Record<string, string>; finalists: string[] }; grudges?: Record<string, unknown> } }).live;
      return { why: (L.decisionWhy ?? []).filter((w) => w.kind === "jury-vote"), votes: L.finale?.votes ?? {}, grudge: (j, f) => h.s.juryGrudgeFor(j, f), finalists: L.finale?.finalists ?? [], book: L.grudges ?? {} };
    };
    const found = firstSeedWhereSync((seed, sandbox) => {
      const g = playedGame({ seed, user: sandbox });
      g.playUntil(() => (g.s.getGameState() as { phase?: string }).phase === "finale", 20_000, "the finale");
      const save = g.s.snapshot();
      const r = run(seed, save, true);
      // the precondition is what the claims read: a juror holding a grudge against a finalist whose vote carries it as a term (a personality can scale a small grudge to nothing)
      return r.why.some((w) => w.options.some((o) => r.grudge(w.by, o.option) < 0 && o.terms.some(([n, v]) => n === "grudge" && v < 0))) ? { save, on: r } : undefined;
    }, { from: 1, to: 12, hint: [1, 11], sandbox: (s) => (s === 11 ? "bitter-real" : `bitter-real-${s}`), what: "a finale jury holding a grudge against a finalist" });
    on = found.at.on; off = run(found.seed, found.at.save, false);
  }, 900_000);

  const term = (o: Why["options"][number], name: string): number => o.terms.filter(([n]) => n === name).reduce((a, [, v]) => a + v, 0);

  it("the jury holds real grudges against the finalists, and the player holds none", () => {
    const held = on.why.flatMap((w) => on.finalists.map((f) => on.grudge(w.by, f))).filter((x) => x < 0);
    expect(held.length, "jurors hold grudges the engine folded").toBeGreaterThan(0);
    expect(Object.keys(on.book).some((k) => k.startsWith(`${PLAYER}|`))).toBe(false);
  });

  it("on: a held grudge is a negative grudge term in the vote for that finalist, bounded; no grudge, no term", () => {
    expect(on.why.length).toBeGreaterThan(0);
    let leaned = 0;
    for (const w of on.why) for (const o of w.options) {
      const g = term(o, "grudge");
      expect(g).toBeLessThanOrEqual(0);
      expect(g).toBeGreaterThanOrEqual(-JURY_GRUDGE_PERSONALITY.ceiling); // ORW-943: a juror's personality scales the grudge, held to the ceiling (under the manner term)
      if (on.grudge(w.by, o.option) === 0) expect(g).toBe(0);
      if (g < 0) leaned++;
    }
    expect(leaned, "some juror's vote carries a grudge term").toBeGreaterThan(0);
  });

  it("off: no grudge term, and every other part of every juror's vote is the same to the bit (only the grudge book's own reads move)", () => {
    expect(off.why.length).toBe(on.why.length);
    for (const w of off.why) for (const o of w.options) expect(term(o, "grudge")).toBe(0);
    const same = ["bond-manner-reliability", "game-respect", "finale-performance", "finale-swing"];
    for (const w of on.why) {
      const twin = off.why.find((x) => x.by === w.by)!;
      for (const o of w.options) {
        const t = twin.options.find((x) => x.option === o.option)!;
        for (const n of same) expect(term(t, n), `${n} is untouched by the grudge layer`).toBeCloseTo(term(o, n), 12);
      }
    }
  });
});

/**
 * ORW-843: a natural grudge FLIPS finale votes. The calibration report (tests/calibration/grudgeVoteFlip.test.ts) measured a few NPC juror votes in a hundred
 * changed (on main at 2026-11-24: seeds 2, 3 and 14 of 1-18, four votes, no winner changed; the earlier main also changed seed 14's winner). Same method: a season played to the finale, saved, and the save played under the SAME
 * sandbox name (each copy in its own registry, so every copy draws the same numbers) with grudges on (as shipped), off, and on again (the control).
 * PRECONDITION (the scan, hint 10, sandboxes gf-<seed>): some NPC juror votes differently with grudges on and off. CLAIMS: the control copy plays the same finale as the on copy,
 * and every juror whose vote changed moved AWAY from a finalist they hold a grudge against.
 */
type Fin = { votes: Record<string, string>; finalists: string[]; winner?: string; grudge: (j: string, f: string) => number };
describe("ORW-843 REAL PATH: a natural grudge changes finale votes", () => {
  let on: Fin, off: Fin, again: Fin;
  beforeAll(() => {
    const copy = (seed: number, sandbox: string, save: unknown, grudges: boolean): Fin => {
      // not as shipped (grudges=false): the off arm of the on/off comparison
      const h = playedGame({ seed, user: sandbox, from: save, before: (s) => s.setGrudgesEnabled(grudges) });
      h.playToCrown();
      const L = (h.s as unknown as { live: { finale?: { votes?: Record<string, string>; finalists: string[] }; winner?: string } }).live;
      return { votes: L.finale?.votes ?? {}, finalists: L.finale?.finalists ?? [], ...(L.winner ? { winner: L.winner } : {}), grudge: (j, f) => h.s.juryGrudgeFor(j, f) };
    };
    const found = firstSeedWhereSync((seed, sandbox) => {
      const g = playedGame({ seed, user: sandbox });
      g.playUntil(() => (g.s.getGameState() as { phase?: string }).phase === "finale", 30_000, "the finale");
      const save = g.s.snapshot();
      const a = copy(seed, sandbox, save, true), b = copy(seed, sandbox, save, false);
      return Object.keys(a.votes).some((j) => j !== PLAYER && a.votes[j] !== b.votes[j]) ? { save, a, b } : undefined;
    }, { from: 1, to: 18, hint: [3, 10, 1, 14], sandbox: (s) => `gf-${s}`, what: "a finale where some juror votes differently with grudges on and off" });
    on = found.at.a; off = found.at.b; again = copy(found.seed, found.sandbox, found.at.save, true);
  }, 1_800_000);

  it("the control copy plays the same finale; every changed vote moves away from a finalist the juror holds a grudge against", () => {
    expect(again.votes, "two on copies of one save play the same finale").toEqual(on.votes);
    expect(again.winner).toBe(on.winner);
    const changed = Object.keys(on.votes).filter((j) => j !== PLAYER && on.votes[j] !== off.votes[j]);
    expect(changed.length, "a grudge changed some juror's vote").toBeGreaterThan(0);
    for (const j of changed) expect(on.grudge(j, off.votes[j]!), "the juror leaves the finalist they hold a grudge against").toBeLessThan(0);
    expect(on.finalists).toEqual(off.finalists);
  });
});
