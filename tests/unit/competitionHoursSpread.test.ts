import { describe, it, expect } from "vitest";
import { competitionRoundHours, competitionCrownHours, type LiveSeasonState } from "../../src/engine/liveSeason";

/**
 * ORW-232 slice 3 (Ryne 2026-11-10): "Comps should take several hours. They should never be one message and should always be a full play by play." The engine charged a
 * competition's whole length (3 in-game hours) in ONE jump at the crown, so a competition played out over two player messages still moved the clock by three hours in the
 * last of them. Now each staged round charges its share and the crown charges only what is left: the total is unchanged, the hours are spread. Clock path only. Roles only.
 */
const comp = (fieldSize: number): LiveSeasonState =>
  ({ week: 1, competition: { field: Array.from({ length: fieldSize }, (_, i) => `n${i}`) } } as unknown as LiveSeasonState);

describe("competition hours are spread over the rounds, the total unchanged", () => {
  it("each round costs a share and the crown costs the rest: rounds + crown = the comp's felt hours", () => {
    const s = comp(16); // 15 drops in batches of 3 => 5 rounds
    const shares: number[] = [];
    for (let i = 0; i < 4; i++) shares.push(competitionRoundHours(s, "hoh-competition", 3)!);
    const crown = competitionCrownHours(s, "hoh-competition", 3);
    expect(shares.every((h) => h > 0 && h < 1), "no single round is the whole competition").toBe(true);
    expect(shares.reduce((a, b) => a + b, 0) + crown).toBeCloseTo(3, 9);
    expect(Math.max(...shares), "no message carries more than an hour").toBeLessThanOrEqual(1);
    expect(crown, "the crown is one share, not the whole comp").toBeLessThan(1);
  });
  it("a competition that charged no rounds still costs its full length at the crown (a pre-slice-3 save)", () => {
    expect(competitionCrownHours(comp(16), "veto-competition", 3)).toBe(3);
  });
  it("never charges more than the competition's length, even if extra rounds are asked for", () => {
    const s = comp(6);
    let total = 0;
    for (let i = 0; i < 20; i++) total += competitionRoundHours(s, "hoh-competition", 3) ?? 0;
    total += competitionCrownHours(s, "hoh-competition", 3);
    expect(total).toBeCloseTo(3, 9);
  });
  it("another competition (a different week or beat) starts its own budget", () => {
    const s = comp(16);
    competitionRoundHours(s, "hoh-competition", 3);
    s.week = 2;
    expect(competitionCrownHours(s, "hoh-competition", 3)).toBe(3);
  });
});
