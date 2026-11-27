import { describe, it, expect } from "vitest";
import { measureTics } from "../../scripts/probes/narrationRepetition";

/** ORW-1032: the live repetition measure also counts delivery tags, stock body habits, a question asked again, a long line told again and counted-hours relative times. Roles only. */
describe("narration tic and repeat measures (ORW-1032)", () => {
  it("counts a delivery tag, the word flat, eyebrows, folded arms and an hours-ago claim", () => {
    const r = measureTics([
      'Role A says it flat, eyes on the table. Her eyebrows lift. Role B stands with arms crossed.',
      'Role A answers evenly and moves on. The standoff was four hours ago.',
      'Role C laughs and pours a glass of water for everyone.',
    ]);
    expect(r.deliveryTagTurns).toBe(2);
    expect(r.deliveryTagTurnShare).toBeCloseTo(66.7, 1);
    expect(r.flatWordTurns).toBe(1);
    expect(r.eyebrowTurns).toBe(1);
    expect(r.armsTurns).toBe(1);
    expect(r.hoursAgoClaims).toBe(1);
  });
  it("counts the same question asked again in one turn and in a later turn, not a new one", () => {
    const r = measureTics([
      'Role A leans in. "So what is your verdict on the vote today?" Later: "So what is your verdict on the vote now?"',
      'Role A waits. "So what is your verdict on the vote tonight?"',
      'Role A shrugs. "Do you want anything from the kitchen before the meeting?"',
    ]);
    expect(r.repeatedAsks).toBe(2);
  });
  it("counts a long quoted line told again in near-identical words", () => {
    const story = 'Role A tells it: "Levi pulled me aside by the pool and said he had talked to you about the vote and that he wanted me to keep it quiet."';
    const again = 'Role A tells it: "Levi pulled me aside by the pool and said he had talked to you about the vote and that he wanted it kept quiet."';
    const other = 'Role B says: "The garden crew moved the chairs this morning so the lawn could be cut before the afternoon heat sets in for good."';
    expect(measureTics([story, other, again]).retoldLines).toBe(1);
  });
  it("the ALREADY USED section carries the delivery-tag, retold-story and stock-habit rules, and stays within its cap", async () => {
    const { narrationUsageSection, emptyNarrationUse, recordNarration, NU_SECTION_MAX_CHARS } = await import("../../src/engine/narrationUsage");
    const roster = [{ id: "npc:1", name: "Role A" }];
    const rec = recordNarration(emptyNarrationUse(), "Role A says it flat. Role A looks at the door and waits for an answer from the player.", roster).record;
    const text = narrationUsageSection(rec, ["npc:1"], (id) => id) ?? "";
    expect(text).toContain("never tag a line as said flatly, evenly or plainly");
    expect(text).toContain("no retold story");
    expect(text.length).toBeLessThanOrEqual(NU_SECTION_MAX_CHARS);
  });
});
