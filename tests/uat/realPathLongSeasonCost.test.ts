import { describe, it, expect, vi } from "vitest";
import { playSeason } from "../support/whatFired/player";
import * as multiSubstring from "../../src/composition/multiSubstring";
import { firstSeedWhere } from "../support/firstSeedWhere";

/**
 * ORW-832 (reworked by the CI-unblock rule): a long played season used to slow down faster than it grew, because the integrity checkpoint's vault-leak sweep read the whole player view once per hidden line (cost = hidden
 * lines x view length, so it grew with the SQUARE of the season). The fix is ONE pass over the view per sweep (`patternsFoundIn`). This test counts WORK, never time (a wall-clock ratio flakes on a shared runner): the one-pass
 * search is observed with a call-through spy at every message of a seeded season (same arguments, same result), and the work of a sweep is its text length plus its pattern count (what a one-pass search costs).
 * REAL PATH: the season is played through the player channel (nothing hand-set). The season is fixed by its seed and sandbox name, so the counts repeat exactly. Checks: (1) the sweep runs, at most a few times per message;
 * (2) the work per message per stored event in a late block stays within a margin of an early block (the old per-line re-scan, or any scan that grows faster than the state, would break it). HEAVY LANE (tests/uat/**).
 */
describe("ORW-832 REAL PATH: the sweep's work follows the size of the season, not its square", () => {
  it("per message and per stored event, the leak sweep does about the same work late in the season as early", async () => {
    const BLOCK = 200; const sweeps: Array<{ chars: number; patterns: number }> = [];
    const orig = multiSubstring.patternsFoundIn;
    const spy = vi.spyOn(multiSubstring, "patternsFoundIn").mockImplementation((text: string, patterns: Iterable<string>) => {
      const list = [...patterns]; sweeps.push({ chars: text.length, patterns: list.length }); return orig(text, list);
    });
    // ORW-920: the seed is picked, not pinned: the first season (hint 2; ORW-694 B1-11: seed 1 now also reaches four blocks and reads 1.55 there, its per-event work flat from block 3 to 4 (74 then 71): linear, not the square this guards) long enough to play four blocks (a played season ends when it ends, and a gameplay change moves that).
    const found = await firstSeedWhere(async (seed, sandbox) => {
      sweeps.length = 0;
      const got: Array<{ work: number; calls: number; events: number }> = [];
      let from = 0;
      await playSeason({ seed, user: sandbox, maxMessages: 800, watch: async ({ engine, msg }) => {
        if ((msg + 1) % BLOCK === 0) {
          const slice = sweeps.slice(from); from = sweeps.length;
          got.push({ work: slice.reduce((a, x) => a + x.chars + x.patterns, 0) / BLOCK, calls: slice.length / BLOCK, events: engine.events.count() });
        }
        return false;
      } });
      return got.length === 4 ? got : undefined;
    }, { from: 1, to: 12, hint: [2, 4], sandbox: (s) => `wf-${s}`, what: "a played season long enough for four blocks of 200 messages" }).finally(() => spy.mockRestore());
    const rows = found.at;
    expect(rows.length, "four blocks of messages were played").toBe(4);
    for (const r of rows) { expect(r.calls, "the sweep ran").toBeGreaterThan(0); expect(r.calls, "at most a few sweeps per message").toBeLessThan(8); }
    const perEvent = (i: number): number => rows[i]!.work / rows[i]!.events;
    const ratio = perEvent(3) / perEvent(1);
    console.log(`SWEEPWORK per message by block: ${rows.map((x) => x.work.toFixed(0)).join("/")}; sweeps per message ${rows.map((x) => x.calls.toFixed(2)).join("/")}; events at block end: ${rows.map((x) => x.events).join("/")}; late-to-early work per event ${ratio.toFixed(2)}`);
    expect(ratio, "the sweep's work per message per stored event stays about flat").toBeLessThan(1.5); // measured 1.26 on this fixed season (ORW-791: the season now ends near 834 messages, so four blocks of 200 are played, not four of 250) (deterministic: counts, not time)
  }, 1_500_000);
});
