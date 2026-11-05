import "../support/pinFlagsOff";
import { describe, it } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { runJurySequesterScenario } from "../support/jurySequesterScenario";

/**
 * 0129 / PO ruling 2026-11-03 — the jury house is FULLY SEQUESTERED: the player can talk to jurors only if the
 * player is a juror, and jurors mix only with other jurors ("…other than other evicted houseguests who are on the
 * jury"; pre-jury evictees go home). While the player is STILL ACTIVE (a non-juror): (a) no player tool reaches a
 * juror, and (b) once out, a pre-jury evictee appears in no further event and a juror appears only with other
 * jurors (the eviction-night departure beats excepted). This file runs the FLAGS-OFF default profile; the full
 * deployed profile runs in `jurySequester.deployed.test.ts`. The player-as-juror surface is the unbuilt part of 0129.
 */
describe("0129 — the jury house is sequestered from a non-juror player (flags-off)", () => {
  it("no tool reaches a juror, a pre-jury evictee goes home, and jurors mix only with jurors", async () => {
    await runJurySequesterScenario(composeRuntime);
  }, 600_000);
});
