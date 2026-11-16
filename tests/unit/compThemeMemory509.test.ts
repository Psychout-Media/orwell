import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

// ORW-509: the writer call that already authors a competition (no extra call) is told which themes were used (this season and the last), and a repeat is refused
// with a counted rejection so the engine's composed skin stands.

function drive(avoidWorld?: { compThemeTitles: string[] }): GameSessionAdapter {
  const session = new GameSessionAdapter();
  session.setGenCompetitionsEnabled(true);
  session.createCharacter({ playerName: "The Player", seed: 4, ...(avoidWorld ? { avoidWorld } : {}) });
  session.advanceGame();
  let adv = session.advanceGame();
  while (adv.event?.beat === "day-break") adv = session.advanceGame();
  if (adv.pending?.kind === "comp-round" || adv.pending?.kind === "comp-intent") session.submitDecision({ kind: "comp-round", intent: "compete" });
  return session;
}
const fiction = (s: GameSessionAdapter, theme: string) => {
  const v = s.competitionStagingView()!;
  return s.recordCompetitionFiction({ comp: v.comp, week: v.week, theme, premise: "A premise.", eliminations: v.dropOrder.map((r) => ({ id: r.id, fiction: `${r.name} drops.` })) });
};

describe("ORW-509 competition theme memory", () => {
  it("hands the previous season's authored titles to the writer and refuses a repeat (counted), then accepts a fresh one", () => {
    const s = drive({ compThemeTitles: ["Lantern Gauntlet"] });
    expect(s.competitionStagingView()!.recentThemes).toContain("Lantern Gauntlet");
    expect(fiction(s, "The Lantern Gauntlet")).toEqual({ accepted: false, reason: "repeat-theme" });
    expect(fiction(s, "Moonlit Orchard Dash").accepted).toBe(true);
    expect(s.worldMemory().compThemeTitles).toEqual(["Moonlit Orchard Dash"]);
  });
  it("with no memory the view carries no recentThemes and the first title is accepted", () => {
    const s = drive();
    expect(s.competitionStagingView()!.recentThemes).toBeUndefined();
    expect(fiction(s, "Any Title").accepted).toBe(true);
  });
});
