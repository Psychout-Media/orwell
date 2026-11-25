import { describe, it, expect, afterEach } from "vitest";
import { playedGame } from "../support/playedGame";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

/**
 * ORW-920 (Fable's week-1 playtest: the player said goodnight on many evenings, `turnIn` answered `held: bedtime` (ORW-258: no bed before the night), and the narrator wrote the lamp going out anyway, so the
 * player retried nine times). REAL PATH: a season is played through the player's levers to an evening; `turnIn` is called through the real lever and answers `held`; the NARRATOR is told on its next prompt, in
 * the world's terms (bed opens in about so many hours, never a digit or a number of minutes), that they are not asleep, and what to offer until then. The line lasts for that turn and the next, and is absent before
 * the refusal and once the night has come. Roles only. HEAVY LANE (tests/realpath).
 */
describe("a bed the engine held is told to the narrator", () => {
  it("the next prompt says bed is not open yet (no digit), and the line is absent before and after", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const g = playedGame({ seed: 3, user: "wf-3", before: (s) => s.setPerConversationClockEnabled(true) });
    const tod = () => (g.s.snapshot() as unknown as { live?: { timeOfDay?: string } }).live?.timeOfDay;
    const told0 = (): boolean => (g.s.getMomentPrompt({}).systemPrompt as string).includes("BEDTIME NOT YET");
    g.playUntil(() => tod() === "evening" && g.s.messageModeNow() && !told0(), 800, "an evening in a played game with no bed refused lately");
    const before = g.s.getMomentPrompt({}).systemPrompt as string;
    expect(before, "no such line before a refusal").not.toContain("BEDTIME NOT YET");
    const v = g.s.turnIn({});
    expect(v.held?.next, "the engine holds the bed in the evening").toBe("bedtime");
    const told = g.s.getMomentPrompt({}).systemPrompt as string;
    expect(told, "the narrator is told in the same turn").toContain("BEDTIME NOT YET");
    const line = told.split("\n").find((l) => l.includes("BEDTIME NOT YET"))!;
    expect(line).toMatch(/bed opens (within the hour or so|in about [a-z]+ hours)/);
    expect(line).toMatch(/NOT asleep/);
    expect(line, "no number crosses, only the world's words").not.toMatch(/\d/);
    // the line is told for the turn after it and never once the night has come
    g.s.noteMessage({ messageId: "next-turn" });
    const nextTod = tod();
    const next = g.s.getMomentPrompt({}).systemPrompt as string;
    if (nextTod === "evening" || nextTod === "afternoon" || nextTod === "morning") expect(next).toContain("BEDTIME NOT YET");
    else expect(next, "the night is here: bed is open").not.toContain("BEDTIME NOT YET");
    g.s.noteMessage({ messageId: "turn-after" });
    expect(g.s.getMomentPrompt({}).systemPrompt as string, "two turns on it is gone").not.toContain("BEDTIME NOT YET");
  }, 600_000);
});
