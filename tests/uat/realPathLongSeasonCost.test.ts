import { describe, it, expect } from "vitest";
import { playSeason } from "../support/whatFired/player";

/**
 * ORW-832: a long played season used to slow down faster than it grew. The per-message cost of one season went from about 20 ms to about 800 ms (a forty-fold rise) while the state grew a few-fold: parts of the commit path
 * (the vault-leak sweep of the integrity checkpoint above all, which read the whole player view once per hidden line; a full session copy only for the health record; scans and sorts of the told-ledger on every call) cost
 * hidden lines x view length, so they grew with the SQUARE of the season. After the fix the cost per message follows the size of the state (about linear), which is what a full copy of the state per commit costs.
 * REAL PATH: the season is played through the player channel (nothing hand-set), block by block of 250 messages. The check is a RATIO of the cost per message per stored event in a late block to the same in an early block
 * (no wall-clock absolute), with the same margin on both sides of the measured values (seed 4, 1000 messages, on the runner: 24/85/228/345 ms per message by block and a ratio of 1.46 before the fix; 18/57/123/180 and 1.14 after, so the limit 1.30 sits 0.16 from each): a cost that grows faster than the state fails it, a cost that follows the state does not. HEAVY LANE (tests/uat/**).
 */
describe("ORW-832 REAL PATH: the cost of a message follows the size of the season, not its square", () => {
  it("per message and per stored event, a block late in the season costs about what an early block cost", async () => {
    const BLOCK = 250, rows: Array<{ ms: number; events: number }> = [];
    let blockStart = Date.now();
    const r = await playSeason({ seed: 4, user: "wf-4", maxMessages: 1000, watch: async ({ engine, msg }) => {
      if ((msg + 1) % BLOCK === 0) { const now = Date.now(); rows.push({ ms: (now - blockStart) / BLOCK, events: engine.events.count() }); blockStart = now; }
      return false;
    } });
    expect(r.crashes, "no crash out of a load-bearing tool").toEqual([]);
    expect(rows.length, "four blocks of messages were played").toBe(4);
    const perEvent = (i: number): number => rows[i]!.ms / rows[i]!.events;
    const ratio = perEvent(3) / perEvent(1);
    console.log(`COSTCURVE ms per message by block: ${rows.map((x) => x.ms.toFixed(0)).join("/")}; events at block end: ${rows.map((x) => x.events).join("/")}; late-to-early cost per event ${ratio.toFixed(2)}`);
    expect(ratio, "the cost per message per stored event stays about flat (1.46 before the fix on this seed, 1.14 after)").toBeLessThan(1.3);
  }, 1_500_000);
});
