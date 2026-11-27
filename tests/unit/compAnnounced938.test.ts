import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";

/** ORW-938: in a played game the staging view says the house already heard the engine's game, so the authored exits are written for it. Roles only. */
describe("ORW-938: the staging view marks an already-announced game", () => {
  it("a competition staged without fiction is announced, and its library scaffold is the preview the house got", () => {
    const g = playedGame({ seed: 5 });
    g.s.setGenCompetitionsEnabled(true);
    g.playUntil(() => g.s.competitionStagingView() !== null, 4000, "a staging competition");
    const view = g.s.competitionStagingView()!;
    expect(view.announced).toBe(true);
    expect(view.library.premise.length).toBeGreaterThan(0);
    const preview = g.s.runCompetition({}) as unknown as { narrative?: { premise: string } };
    expect(preview.narrative?.premise).toBe(view.library.premise);
  });
});
