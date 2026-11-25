import { describe, it, expect, vi } from "vitest";
import { playSeason } from "../support/whatFired/player";
import * as multiSubstring from "../../src/composition/multiSubstring";
import { firstSeedWhere } from "../support/firstSeedWhere";

/**
 * ORW-832 (reworked by the CI-unblock rule): a long played season used to slow down faster than it grew, because the integrity checkpoint's vault-leak sweep read the whole player view once per hidden line (cost = hidden
 * lines x view length, so it grew with the SQUARE of the season). The fix is ONE pass over the view per sweep (`patternsFoundIn`). This test counts WORK, never time (a wall-clock ratio flakes on a shared runner): the one-pass
 * search is observed with a call-through spy at every message of a seeded season (same arguments, same result), and the work of a sweep is its text length plus its pattern count (what a one-pass search costs).
 * REAL PATH: the season is played through the player channel (nothing hand-set). The season is fixed by its seed and sandbox name, so the counts repeat exactly; the seed is the first from 4 whose
 * season lasts the four blocks (ORW-702: a rebalanced house can end seed 4's season early, and a short season measures nothing late). Checks: (1) the sweep runs, at most a few times per message;
 * (2) the work per message per stored event in a late block stays within a margin of an early block (the old per-line re-scan, or any scan that grows faster than the state, would break it). HEAVY LANE (tests/uat/**).
 */
describe("ORW-832 REAL PATH: the sweep's work follows the size of the season, not its square", () => {
  it("per message and per stored event, the leak sweep does about the same work late in the season as early", async () => {
    const BLOCK = 250;
    // the precondition: a season that lasts four blocks of messages (the sweep's work is then compared early against late)
    const { at: rows } = await firstSeedWhere(async (seed, sandbox) => {
      const sweeps: Array<{ chars: number; patterns: number }> = [];
      const orig = multiSubstring.patternsFoundIn;
      const spy = vi.spyOn(multiSubstring, "patternsFoundIn").mockImplementation((text: string, patterns: Iterable<string>) => {
        const list = [...patterns]; sweeps.push({ chars: text.length, patterns: list.length }); return orig(text, list);
      });
      const rows: Array<{ work: number; calls: number; events: number }> = [];
      let from = 0;
      try {
        await playSeason({ seed, user: sandbox, maxMessages: 1000, watch: async ({ engine, msg }) => {
          if ((msg + 1) % BLOCK === 0) {
            const slice = sweeps.slice(from); from = sweeps.length;
            rows.push({ work: slice.reduce((a, x) => a + x.chars + x.patterns, 0) / BLOCK, calls: slice.length / BLOCK, events: engine.events.count() });
          }
          return false;
        } });
      } finally { spy.mockRestore(); }
      return rows.length === 4 ? rows : undefined;
    }, { from: 1, to: 12, hint: [1, 4], sandbox: (s) => `wf-${s}`, what: "a season that lasts four blocks of messages" });
    expect(rows.length, "four blocks of messages were played").toBe(4);
    for (const r of rows) { expect(r.calls, "the sweep ran").toBeGreaterThan(0); expect(r.calls, "at most a few sweeps per message").toBeLessThan(8); }
    const perEvent = (i: number): number => rows[i]!.work / rows[i]!.events;
    const ratio = perEvent(3) / perEvent(1);
    console.log(`SWEEPWORK per message by block: ${rows.map((x) => x.work.toFixed(0)).join("/")}; sweeps per message ${rows.map((x) => x.calls.toFixed(2)).join("/")}; events at block end: ${rows.map((x) => x.events).join("/")}; late-to-early work per event ${ratio.toFixed(2)}`);
    expect(ratio, "the sweep's work per message per stored event stays about flat").toBeLessThan(1.5); // measured 1.26 on this fixed season (ORW-791: the season now ends near 834 messages, so four blocks of 200 are played, not four of 250) (deterministic: counts, not time)
  }, 1_500_000);
});
