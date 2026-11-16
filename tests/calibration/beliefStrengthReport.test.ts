import { describe, it } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import { BELIEF_RULES, type BeliefStrength } from "../../src/engine/beliefDecisions";
import type { DecisionWhy } from "../../src/engine/decisionWhy";

/**
 * 0150 / ORW-330 slice 2 - REPORT, NOT A GATE (Ryne's question 2: full strength, "measured and reported, never a gate"). Plays N paired PLAYED seasons (same seeds) with
 * beliefs at FULL strength and CAPPED (the behaviour before slice 2) and prints: how the player fared, how far the eviction order moved, how many NPC nominations and votes a
 * belief FLIPPED (without the belief term the runner-up would have won), and how many EVICTIONS beliefs decided (the votes a belief flipped were enough to change who went home).
 * Skipped unless ORWELL_BELIEF_REPORT=1. `ORWELL_BELIEF_REPORT_SEEDS` sets N (default 16).
 *   ORWELL_BELIEF_REPORT=1 npx vitest run tests/calibration/beliefStrengthReport.test.ts
 */
const RUN = process.env.ORWELL_BELIEF_REPORT === "1";
const N = Number.parseInt(process.env.ORWELL_BELIEF_REPORT_SEEDS ?? "16", 10);
const START = Number.parseInt(process.env.ORWELL_BELIEF_REPORT_START ?? "1", 10);

interface Row { seed: number; winner?: string; order: string[]; finalTwo: string[]; jury: string[]; finished: boolean; flippedNoms: number; noms: number; flippedVotes: number; votes: number; beliefEvictions: number; evictions: number }

const beliefOf = (o: DecisionWhy["options"][number]): number => o.terms.filter(([n]) => n === "belief").reduce((a, [, v]) => a + v, 0);
/** A decision a belief flipped: the chosen option beat the runner-up, but without each option's belief term the runner-up would have won (or tied). */
const flipped = (d: DecisionWhy): boolean => {
  const [c, r] = d.options;
  if (!c || !r || c.role !== "chosen" || r.role !== "runner-up" || d.rule) return false;
  return beliefOf(c) !== beliefOf(r) && c.total - beliefOf(c) <= r.total - beliefOf(r);
};

function rowOf(seed: number, strength: BeliefStrength): Row {
  const keep = BELIEF_RULES.strength;
  BELIEF_RULES.strength = strength;
  try {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`belief-report-${seed}-${strength}-${Math.random()}`).session as GameSessionAdapter;
    s.createCharacter({ playerName: "P", seed });
    s.setPerConversationClockEnabled(true);
    type L = { nightDepth?: number; finished?: boolean; timeOfDay?: string; pending?: unknown; winner?: string; evictionOrder: string[]; finalTwo?: string[]; jury?: string[];
      decisionWhy?: DecisionWhy[]; voteRecord?: Array<{ week: number; evictee: string; voteOf: Record<string, string> }> };
    const live = (): L => (s as unknown as { live: L }).live;
    for (let i = 0; i < 80 && live().nightDepth === undefined; i++) s.advanceGame();
    s.noteMessage({ messageId: "belief-report-0" });
    for (let step = 0; step < 40_000 && !live().finished; step++) {
      const l = live();
      const d = (s.getGameState() as { daySchedule?: { due: boolean } }).daySchedule;
      if (d?.due || !d || l.pending) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); }
      else if (l.timeOfDay === "night" || l.timeOfDay === "late-night") { const r = s.turnIn({}) as { held?: unknown } | undefined; if (!r?.held) s.settleOvernight(1); }
      else s.advanceClockPerConversation();
    }
    const l = live();
    const why = l.decisionWhy ?? [];
    const noms = why.filter((d) => d.kind === "nomination-target");
    const votes = why.filter((d) => d.kind === "vote");
    let beliefEvictions = 0;
    for (const rec of l.voteRecord ?? []) {
      const ballots = Object.entries(rec.voteOf);
      const forE = ballots.filter(([, v]) => v === rec.evictee).length;
      const against = ballots.length - forE;
      const flippedForE = votes.filter((d) => d.week === rec.week && rec.voteOf[d.by] === rec.evictee && d.options[0]?.option === rec.evictee && flipped(d)).length;
      if (flippedForE > 0 && forE - 2 * flippedForE <= against) beliefEvictions += 1; // had those voters not acted on the belief, the evictee would not have had the votes
    }
    return { seed, ...(l.winner ? { winner: l.winner } : {}), order: [...l.evictionOrder], finalTwo: [...(l.finalTwo ?? [])], jury: [...(l.jury ?? [])], finished: l.finished === true,
      flippedNoms: noms.filter(flipped).length, noms: noms.length, flippedVotes: votes.filter(flipped).length, votes: votes.length, beliefEvictions, evictions: (l.voteRecord ?? []).length };
  } finally { BELIEF_RULES.strength = keep; }
}

const pct = (k: number, n: number): string => `${n ? ((100 * k) / n).toFixed(0) : 0}%`;
function summary(rows: Row[]): string {
  const n = rows.length, sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
  const wins = rows.filter((r) => r.winner === "player").length, f2 = rows.filter((r) => r.finalTwo.includes("player")).length;
  const jury = rows.filter((r) => r.jury.includes("player") || r.finalTwo.includes("player")).length;
  return `seasons ${n} finished ${rows.filter((r) => r.finished).length} | player wins ${wins} (${pct(wins, n)}) F2 ${f2} (${pct(f2, n)}) jury ${jury} (${pct(jury, n)})`
    + ` | nominations flipped by a belief ${sum((r) => r.flippedNoms)}/${sum((r) => r.noms)} (${pct(sum((r) => r.flippedNoms), sum((r) => r.noms))})`
    + ` | votes flipped ${sum((r) => r.flippedVotes)}/${sum((r) => r.votes)} (${pct(sum((r) => r.flippedVotes), sum((r) => r.votes))})`
    + ` | evictions decided by beliefs ${sum((r) => r.beliefEvictions)}/${sum((r) => r.evictions)} (${pct(sum((r) => r.beliefEvictions), sum((r) => r.evictions))})`;
}

describe.skipIf(!RUN)("0150 report: beliefs at full strength vs capped, paired played seasons (not a gate)", () => {
  it("prints full vs capped", () => {
    const full: Row[] = [], capped: Row[] = [];
    for (let seed = START; seed < START + N; seed++) { capped.push(rowOf(seed, "capped")); full.push(rowOf(seed, "full")); }
    let changedSeasons = 0, winnerChanged = 0;
    for (let i = 0; i < full.length; i++) {
      if (full[i]!.order.join() !== capped[i]!.order.join()) changedSeasons += 1;
      if (full[i]!.winner !== capped[i]!.winner) winnerChanged += 1;
    }
    console.log(`BELIEF-REPORT capped: ${summary(capped)}`);
    console.log(`BELIEF-REPORT full:   ${summary(full)}`);
    console.log(`BELIEF-REPORT paired: eviction order changed in ${changedSeasons}/${full.length} seasons, winner changed in ${winnerChanged}/${full.length}`);
  });
});
