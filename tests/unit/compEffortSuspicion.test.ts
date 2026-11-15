import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { COMP_EFFORT } from "../../src/engine/relationshipConstants";
import { DealLedger } from "../../src/engine/deals";
import { RelationshipModel } from "../../src/engine/relationships";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { BindingAction } from "../../src/domain/deal";
import { resolvePending } from "../../features/support/answerPending";

/**
 * ORW-269 (Ryne 2026-11-11): on a comp-throw deal the RESULT still dominates (win = broken, lose = kept), but a promisor SEEN fighting hard on most rounds draws a smaller suspicion fold even when they lose;
 * the player mirrors (a player who committed to compete after promising a throw is the one seen fighting hard). Played games only; own side stream; headless identical. No model, roles only.
 */
const PROMISOR = "npc:a", PROMISEE = "npc:b";
const ledger = (): DealLedger => { const l = new DealLedger(); l.make([PROMISOR, PROMISEE], "comp-throw", "I will throw it"); return l; };
const act = (over: Partial<BindingAction>): BindingAction => ({ actor: PROMISOR, kind: "compete", targets: [], outcome: "threw", ...over });

describe("the ledger: a kept throw with visible effort draws suspicion", () => {
  it("kept + seen fighting hard => resolves kept AND raises suspicion once; kept without effort => none; broken (won) => a break, no suspicion", () => {
    for (const [a, wantSusp, wantStatus] of [
      [act({ effortHard: true }), 1, "kept"],
      [act({}), 0, "kept"],
      [act({ effortHard: false }), 0, "kept"],
      [act({ outcome: "won", effortHard: true }), 0, "broken"],
    ] as const) {
      const l = ledger();
      let calls = 0;
      l.reconcile(a, { suspicion: () => { calls += 1; } });
      expect(calls, JSON.stringify(a)).toBe(wantSusp);
      expect(l.all[0]!.status).toBe(wantStatus);
    }
  });
  it("the suspicion fold is a small fraction of a break", () => {
    const rel = (): RelationshipModel => new RelationshipModel(0.5);
    const trustAfter = (a: BindingAction, fold: boolean): number => {
      const r = rel(); const l = ledger(); const rng = new SeededRandom(3);
      const t0 = r.edge(PROMISEE, PROMISOR).trust;
      l.reconcile(a, { rel: r, rng, ...(fold ? { suspicion: (p: string, q: string) => r.applyImpactDirected(q, p, COMP_EFFORT.suspicion, new SeededRandom(9)) } : {}) });
      return r.edge(PROMISEE, PROMISOR).trust - t0;
    };
    const kept = trustAfter(act({}), true);
    const keptHard = trustAfter(act({ effortHard: true }), true);
    const broken = trustAfter(act({ outcome: "won" }), true);
    expect(keptHard).toBeLessThan(kept); // suspicion costs something
    expect(keptHard).toBeGreaterThan(broken); // but far less than a break
    expect(kept - keptHard).toBeLessThan((kept - broken) / 2);
  });
});

type S = {
  live: { playedGame?: boolean; week: number; hoh?: string; outgoingHoh?: string; active: string[]; lastCompEffort?: { comp: string; week: number; effort: Record<string, { rounds: number; hard: number }> } };
  deals: DealLedger;
  rel: RelationshipModel;
  dealDepthEnabled: boolean;
  ctx(): { compEffortFor?: (id: string, comp: "hoh-competition", round: number, approach?: string) => string };
  compEffortSeen(id: string, comp: string, round: number, approach?: string): string;
  bindingActionsFor(ev: { beat: string; content: string; participants: string[] }): BindingAction[];
  reconcileDeals(a: BindingAction): void;
  livingIds(): string[];
  createCharacter(r: unknown): unknown;
  advanceGame(): unknown;
};
function started(): { s: S; a: string; b: string } {
  const s = new GameSessionRegistry().sandboxFor(`ce-${Math.random()}`).session as unknown as S;
  s.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  s.advanceGame(); s.advanceGame();
  const [a, b] = s.livingIds().filter((i) => i !== PLAYER);
  return { s, a: a!, b: b! };
}

describe("the engine: effort is observable, gated, and never changes a result", () => {
  it("headless (not played): no effort hook in the ctx and no effortHard on any action", () => {
    const { s, a, b } = started();
    s.live.playedGame = false; s.dealDepthEnabled = true;
    expect(s.ctx().compEffortFor).toBeUndefined();
    s.live.hoh = b; s.live.outgoingHoh = undefined;
    s.live.lastCompEffort = { comp: "hoh-competition", week: s.live.week, effort: { [a]: { rounds: 4, hard: 4 } } };
    expect(s.bindingActionsFor({ beat: "hoh-competition", content: "", participants: [b] }).some((x) => x.effortHard)).toBe(false);
    s.live.playedGame = true;
    expect(typeof s.ctx().compEffortFor).toBe("function");
    expect(s.bindingActionsFor({ beat: "hoh-competition", content: "", participants: [b] }).find((x) => x.actor === a)?.effortHard).toBe(true);
  });
  it("only a mostly-hard fighter is flagged: a light fighter who lost is not suspicious", () => {
    const { s, a, b } = started();
    s.live.playedGame = true; s.dealDepthEnabled = true; s.live.hoh = b;
    const week = s.live.week;
    s.live.lastCompEffort = { comp: "hoh-competition", week, effort: { [a]: { rounds: 4, hard: 1 } } };
    expect(s.bindingActionsFor({ beat: "hoh-competition", content: "", participants: [b] }).find((x) => x.actor === a)?.effortHard).toBeUndefined();
    s.live.lastCompEffort = { comp: "hoh-competition", week, effort: { [a]: { rounds: 4, hard: 2 } } };
    expect(s.bindingActionsFor({ beat: "hoh-competition", content: "", participants: [b] }).find((x) => x.actor === a)?.effortHard).toBe(true);
    s.live.lastCompEffort = { comp: "hoh-competition", week: week - 1, effort: { [a]: { rounds: 4, hard: 4 } } };
    expect(s.bindingActionsFor({ beat: "hoh-competition", content: "", participants: [b] }).find((x) => x.actor === a)?.effortHard, "a stale comp's tally is ignored").toBeUndefined();
  });
  it("player mirror: committing to compete reads all-out, throwing reads light", () => {
    const { s } = started();
    expect(s.compEffortSeen(PLAYER, "hoh-competition", 1, "compete")).toBe("all-out");
    expect(s.compEffortSeen(PLAYER, "hoh-competition", 1, "throw")).toBe("light");
    expect(s.compEffortSeen(PLAYER, "hoh-competition", 1, "play-safe")).toBe("steady");
  });
  it("a promisor to throw is seen fighting hard less often the closer their bond to the promisee", () => {
    const hardCount = (bond: number): number => {
      const { s, a, b } = started();
      s.deals.make([a, b], "comp-throw", "I will throw it");
      Object.assign(s.rel.edge(a, b), { trust: bond, affinity: bond });
      return Array.from({ length: 60 }, (_, r) => s.compEffortSeen(a, "hoh-competition", r + 1)).filter((x) => x === "all-out").length;
    };
    expect(hardCount(0.95)).toBeLessThan(hardCount(0.05));
  });
  it("an NPC's seen effort is a pure function of the seed and place (own side stream), not the shared rng", () => {
    const { s, a } = started();
    const r1 = [1, 2, 3, 4].map((r) => s.compEffortSeen(a, "hoh-competition", r));
    const r2 = [1, 2, 3, 4].map((r) => s.compEffortSeen(a, "hoh-competition", r));
    expect(r2).toEqual(r1);
  });
  it("end to end on the live adapter: a kept throw seen fighting hard lowers the promisee's trust a little; a break lowers it far more", () => {
    const run = (hard: boolean, won: boolean): number => {
      const { s, a, b } = (() => { const g = started(); return g; })();
      s.live.playedGame = true; s.dealDepthEnabled = true; s.live.hoh = won ? a : b;
      s.deals.make([a, b], "comp-throw", "I will throw it");
      s.live.lastCompEffort = { comp: "hoh-competition", week: s.live.week, effort: { [a]: { rounds: 4, hard: hard ? 4 : 0 } } };
      const t0 = s.rel.edge(b, a).trust;
      for (const act of s.bindingActionsFor({ beat: "hoh-competition", content: "", participants: [s.live.hoh!] }).filter((x) => x.actor === a)) s.reconcileDeals(act);
      return s.rel.edge(b, a).trust - t0;
    };
    const keptEasy = run(false, false), keptHard = run(true, false), broken = run(true, true);
    expect(keptHard).toBeLessThan(keptEasy);
    expect(keptHard).toBeGreaterThan(broken);
    expect(keptEasy - keptHard).toBeLessThan((keptEasy - broken) / 2);
  });
});

describe("the staged comp tally (liveSeason) is played-only and leaves the result untouched", () => {
  type G = S & { advanceGame(): { pending?: unknown }; submitDecision(r: unknown): unknown; setAdvanceGateEnabled(on: boolean): void; setGoalMoodEnabled(on: boolean): void };
  const play = (played: boolean, seed: number): { hohs: string[]; effort: boolean } => {
    const s = new GameSessionRegistry().sandboxFor(`cet-${played}-${seed}`).session as unknown as G;
    s.createCharacter({ playerName: "The Player", seed });
    s.setAdvanceGateEnabled(false); // ORW-97: this test drives raw advances; the schedule hold is not under test here
    s.setGoalMoodEnabled(false); // ORW-317: a played game's settled goals move mood (and so comp odds); this test isolates the comp-effort tally
    const hohs: string[] = [];
    let effort = false;
    for (let i = 0; i < 400 && hohs.length < 4; i++) {
      s.live.playedGame = played;
      const v = s.advanceGame() as { pending?: unknown };
      if (v.pending) resolvePending(v.pending as never, (req) => void s.submitDecision(req));
      if (s.live.lastCompEffort) effort = true;
      const h = s.live.hoh;
      if (h && hohs[hohs.length - 1] !== h) hohs.push(h);
    }
    return { hohs, effort };
  };
  it("played: the tally is kept; not played: none; and the crowned HOH sequence is identical either way", () => {
    let sawTally = false;
    for (const seed of [3, 5, 8]) {
      const p = play(true, seed), h = play(false, seed);
      expect(h.effort, "headless keeps no tally").toBe(false);
      expect(p.hohs).toEqual(h.hohs);
      sawTally ||= p.effort;
    }
    expect(sawTally, "at least one played game kept a tally").toBe(true);
  });
});
