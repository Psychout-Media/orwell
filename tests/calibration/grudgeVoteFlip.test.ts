import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { playedGame } from "../support/playedGame";

/**
 * ORW-843 - CALIBRATION REPORT (not a gate): how often does a NATURAL grudge change a finale juror's vote?
 *
 * Each season is played through the player's own levers (tests/support/playedGame.ts: a message per turn, advanceGame, the faithful pending answers, hangOut
 * while the schedule holds, turnIn at night, the real Orchestrator committing each turn), so every grudge a juror holds is one the engine folded from what
 * happened. At the finale the game is SAVED and the save is loaded twice (the persistence path): one copy plays the finale with grudges on (as shipped), the
 * other with them off. Every copy loads under the SAME sandbox name (each in its own registry), so it draws the same numbers; a third copy with grudges on is
 * the control and must match the first exactly. So any juror whose vote differs between the on and off copies is a vote the grudge layer changed. Counted per
 * NPC juror (the player's own juror vote is their choice and is the same in both), with the jurors who hold any grudge against a finalist, and whether the
 * winner changed.
 *
 * Seeds come from GRUDGE_SEEDS (comma-separated; default "11"); the sandbox name is pinned as `gf-<seed>` (ORW-852). Each season prints one `GRUDGE_ROW {json}`
 * line; run several seeds in parallel processes and pool the rows. About one played season per seed (1-10 minutes on a runner).
 *
 * MEASURED 2026-11-24 (main 33bf87e49, seeds 1-18, sandboxes gf-1 .. gf-18, a runner, six seasons at a time):
 *   18 seasons, 147 NPC finale jurors, 144 of them holding a grudge against at least one finalist (the strongest per season between 0.11 and the 0.20 cap).
 *   3 of 147 juror votes changed with grudges on vs off (2.0% per juror; 2.1% per juror who holds a grudge), all 3 AWAY from the finalist the juror held a
 *   grudge against. 2 of 18 seasons had a changed vote (seed 3: one juror; seed 14: two jurors), and in 1 of 18 (seed 14, 5.6%) the winner changed.
 *   The other 16 seasons' finale votes were identical with grudges on and off.
 *   Re-run with every copy under the same sandbox name and the control copy: identical numbers, and the control matched in all 18 seasons.
 *   Reproduce: GRUDGE_SEEDS=<n> npx vitest run tests/calibration/grudgeVoteFlip.test.ts (one process per seed), then pool the GRUDGE_ROW lines.
 */
const SEEDS = (process.env.GRUDGE_SEEDS ?? "11").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
type L = { finale?: { votes?: Record<string, string>; finalists: string[] }; winner?: string; grudges?: Record<string, unknown> };

describe("ORW-843 calibration: grudges and finale votes (a report, not a gate)", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, () => {
      const user = `gf-${seed}`;
      const g = playedGame({ seed, user });
      g.playUntil(() => (g.s.getGameState() as { phase?: string }).phase === "finale", 30_000, "the finale");
      const save = g.s.snapshot();
      const run = (grudges: boolean) => {
        // not as shipped (grudges=false): the off arm of the on/off comparison
        const h = playedGame({ seed, user, from: save, before: (s) => s.setGrudgesEnabled(grudges) });
        h.playToCrown();
        const live = (h.s as unknown as { live: L }).live;
        const finalists = live.finale?.finalists ?? [];
        const votes = live.finale?.votes ?? {};
        const held = Object.fromEntries(Object.keys(votes).map((j) => [j, finalists.map((f) => h.s.juryGrudgeFor(j, f))]));
        return { votes, finalists, winner: live.winner, held };
      };
      const on = run(true), off = run(false), again = run(true); // `again`: a second on copy, the control (must match `on` exactly)
      const jurors = Object.keys(on.votes).filter((j) => j !== PLAYER);
      const flipped = jurors.filter((j) => on.votes[j] !== off.votes[j]);
      const holding = jurors.filter((j) => on.held[j]!.some((x) => x < 0));
      const awayFromGrudge = flipped.filter((j) => { const [g0, g1] = on.held[j]!; const was = off.votes[j]; const lean = on.finalists.indexOf(was!) === 0 ? g0! : g1!; return lean < 0; });
      const control = jurors.filter((j) => on.votes[j] !== again.votes[j]).length;
      const row = { seed, user, control, jurors: jurors.length, holding: holding.length, flipped: flipped.length, flippedAwayFromGrudge: awayFromGrudge.length, winnerOn: on.winner, winnerOff: off.winner, winnerChanged: on.winner !== off.winner, playerJuror: Object.keys(on.votes).includes(PLAYER), playerFinalist: on.finalists.includes(PLAYER), maxGrudge: Math.min(0, ...jurors.flatMap((j) => on.held[j]!)) };
      console.log(`GRUDGE_ROW ${JSON.stringify(row)}`);
      expect(jurors.length).toBeGreaterThan(0);
      expect(control, "two on copies of one save play the same finale").toBe(0);
    }, 3_600_000);
  }
});
