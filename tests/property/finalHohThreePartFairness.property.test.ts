import { describe, it, expect } from "vitest";
import { playSeason } from "../../src/engine/calibration";
import type { SeasonHouseguest } from "../../src/engine/season";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * A20 (from A18's gap) - the no-favor proof for the THREE-PART Final HOH (0128), through the live loop (`playSeason` drives `advance`, with `finalHohThreePart` on).
 * At identical stats + souls the three finalists are exchangeable, so whoever the player's finalist slot is, the player crowns the Final HOH about 1/3 of the time they reach it - never more
 * (a hidden bonus anywhere in Part 1 / 2 / 3 or in the part-field construction would show as a skewed share). Roles only.
 */
const flat = (v: number) => ({ physical: v, mental: v, social: v });
const roster = (playerStat: number): SeasonHouseguest[] => [
  { id: PLAYER, stats: flat(playerStat) },
  ...Array.from({ length: 15 }, (_, i) => ({ id: npc(i + 1), stats: flat(0.5) })),
];

function finalHohShare(playerStat: number, seeds: number, threePart: boolean): { reached: number; crowned: number } {
  let reached = 0, crowned = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const o = playSeason({ seed, houseguests: roster(playerStat), finalHohThreePart: threePart });
    const f3 = o.weeks[o.weeks.length - 1]!; // the Final-3 week: no veto, the Final HOH evicts directly
    if (f3.vetoHolder !== undefined) continue;
    const three = [f3.hoh, ...f3.nominees];
    if (!three.includes(PLAYER)) continue;
    reached += 1;
    if (f3.hoh === PLAYER) crowned += 1;
  }
  return { reached, crowned };
}

const EVEN = finalHohShare(0.5, 500, true); // measured once, shared by the fairness check and the control

describe("three-part Final HOH: no hidden favor (A20)", () => {
  it("the three-part path really is a different tournament from the single comp (the flag takes effect in this driver)", () => {
    let differs = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const a = playSeason({ seed, houseguests: roster(0.5), finalHohThreePart: true });
      const b = playSeason({ seed, houseguests: roster(0.5), finalHohThreePart: false });
      if (a.weeks[a.weeks.length - 1]!.hoh !== b.weeks[b.weeks.length - 1]!.hoh) differs += 1;
    }
    expect(differs).toBeGreaterThan(0);
  });

  it("at identical stats the player crowns the three-part Final HOH about 1/3 of the time they reach the Final 3", () => {
    const { reached, crowned } = EVEN;
    expect(reached).toBeGreaterThan(80);
    const share = crowned / reached;
    expect(share, `player Final HOH share ${share.toFixed(3)} over ${reached} Final-3 appearances`).toBeGreaterThan(1 / 3 - 0.14);
    expect(share).toBeLessThan(1 / 3 + 0.14);
  });

  it("control: a player with a real stat edge DOES crown it more often (the check can fail)", () => {
    const edge = finalHohShare(0.75, 500, true);
    expect(edge.crowned / edge.reached).toBeGreaterThan(EVEN.crowned / EVEN.reached + 0.1);
  });
});
