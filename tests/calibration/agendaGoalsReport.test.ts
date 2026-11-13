import { describe, it } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { playSeason } from "../support/agendaSeasonDriver";

/**
 * ORW-314 - REPORT, NOT A GATE (Ryne 2026-11-05/06: "I am not worried about the balance tests. Only CI."). Plays N paired PLAYED seasons (same seeds) with the NPC agendas' pull on decisions
 * ON (the shipped wiring) and ZEROED (the season as it was before decisions read goals) and prints who wins, how far the eviction order moves, and how the player fared.
 * Skipped unless ORWELL_AGENDA_REPORT=1 (it plays ~2N full seasons). `ORWELL_AGENDA_REPORT_SEEDS` sets N (default 24).
 *   ORWELL_AGENDA_REPORT=1 npx vitest run tests/calibration/agendaGoalsReport.test.ts
 */
const RUN = process.env.ORWELL_AGENDA_REPORT === "1";
const N = Number.parseInt(process.env.ORWELL_AGENDA_REPORT_SEEDS ?? "24", 10);
const START = Number.parseInt(process.env.ORWELL_AGENDA_REPORT_START ?? "1", 10);
const proto = GameSessionAdapter.prototype as unknown as Record<string, unknown>;
interface Row { seed: number; winner?: string; order: string[]; finalTwo: string[]; playerOut: number | null; jury: string[]; finished: boolean }
const rowOf = (seed: number): Row => {
  const r = playSeason(seed);
  const l = r.s.snapshot().live as unknown as { winner?: string; evictionOrder: string[]; finalTwo?: string[]; jury?: string[] };
  const idx = l.evictionOrder.indexOf("player");
  return { seed, ...(l.winner ? { winner: l.winner } : {}), order: [...l.evictionOrder], finalTwo: [...(l.finalTwo ?? [])], playerOut: idx >= 0 ? idx + 1 : null, jury: [...(l.jury ?? [])], finished: r.finished };
};
const pct = (k: number, n: number): string => `${((100 * k) / n).toFixed(0)}%`;
function summary(rows: Row[]): string {
  const n = rows.length;
  const wins = rows.filter((r) => r.winner === "player").length;
  const f2 = rows.filter((r) => r.finalTwo.includes("player")).length;
  const jury = rows.filter((r) => r.jury.includes("player") || r.finalTwo.includes("player")).length;
  const firstOut = rows.map((r) => r.order[0]).filter(Boolean);
  const winners = new Set(rows.map((r) => r.winner)).size;
  const meanPlayerOut = rows.filter((r) => r.playerOut !== null).reduce((a, r) => a + r.playerOut!, 0) / Math.max(1, rows.filter((r) => r.playerOut !== null).length);
  return `seasons ${n} finished ${rows.filter((r) => r.finished).length} | player wins ${wins} (${pct(wins, n)}) reach F2 ${f2} (${pct(f2, n)}) reach jury ${jury} (${pct(jury, n)}) | distinct winners ${winners} | distinct first-evictees ${new Set(firstOut).size} | mean player eviction slot ${meanPlayerOut.toFixed(2)}`;
}

describe.skipIf(!RUN)("ORW-314 report: goals driving decisions, paired played seasons (not a gate)", () => {
  it("prints before/after", () => {
    const on: Row[] = [], off: Row[] = [];
    const keep = proto.agendaPullOf;
    for (let seed = START; seed < START + N; seed++) {
      proto.agendaPullOf = () => ({ value: 0 });
      try { off.push(rowOf(seed)); } finally { proto.agendaPullOf = keep; }
      on.push(rowOf(seed));
    }
    // eviction-order spread: per paired seed, how many seats of the order changed, and the mean displacement of a houseguest's slot
    let changedSeasons = 0, changedSeats = 0, seats = 0, displacement = 0, moved = 0, winnerChanged = 0;
    on.forEach((a, i) => {
      const b = off[i]!;
      if (a.winner !== b.winner) winnerChanged++;
      if (JSON.stringify(a.order) !== JSON.stringify(b.order)) changedSeasons++;
      const n = Math.min(a.order.length, b.order.length);
      for (let k = 0; k < n; k++) { seats++; if (a.order[k] !== b.order[k]) changedSeats++; }
      for (const id of a.order) { const j = b.order.indexOf(id); if (j >= 0) { displacement += Math.abs(j - a.order.indexOf(id)); moved++; } }
    });
    // eslint-disable-next-line no-console
    console.log([
      `\n=== ORW-314 REPORT (${N} paired played seasons, seeds ${START}..${START + N - 1}) ===`,
      `BEFORE (agenda pull zeroed): ${summary(off)}`,
      `AFTER  (goals drive decisions): ${summary(on)}`,
      `eviction order: ${changedSeasons}/${N} seasons differ; ${changedSeats}/${seats} seats differ; mean slot displacement ${(displacement / Math.max(1, moved)).toFixed(2)}; winner changed in ${winnerChanged}/${N}`,
    ].join("\n"));
  }, 3_600_000);
});
