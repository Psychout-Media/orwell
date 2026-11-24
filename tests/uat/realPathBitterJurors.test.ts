import { describe, it, expect, beforeAll } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { JURY_GRUDGE } from "../../src/engine/juryConstants";
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
      return r.why.some((w) => r.finalists.some((f) => r.grudge(w.by, f) < 0)) ? { save, on: r } : undefined;
    }, { from: 1, to: 12, hint: 11, sandbox: (s) => (s === 11 ? "bitter-real" : `bitter-real-${s}`), what: "a finale jury holding a grudge against a finalist" });
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
      expect(g).toBeGreaterThanOrEqual(-JURY_GRUDGE.max);
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

  // Blocked, not faked: in the played seeds measured (3 and 11) the natural grudge terms (at most about 0.14) never cross a juror's margin, so the finale votes are the
  // same with grudges on and off. The vote-count claim is proven only by the unit test that sets the grudges by hand (tests/unit/grudgesBitterJurors.test.ts).
  it.todo("real path: a grudge flips finale votes against that finalist across played seasons, blocked by natural grudges too small to cross a juror's margin in a single played season (needs a multi-season measurement, ORW-569)");
});
