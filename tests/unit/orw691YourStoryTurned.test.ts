import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView } from "../../src/ports/GameSession";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";

/** ORW-691 B1-3 (0211 / ORW-648): the story's "turned" shape needs a warm-to-cold crossing, but the weekly samples are raw 0..1 edge values (a baseline edge reads +0.5). UNIT: the season is marked played, the week stepped and the season finished by hand (ORW-813: the played version is tests/uat/realPathYourStoryTurned.test.ts, the heavy lane). Roles only. */
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
  else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
}
type Seam = { live: { playedGame?: boolean; finished?: boolean; week: number }; yourStoryTick(): void; buildYourStoriesView(): { stories: Array<{ name: string; shape: string }> } | undefined; nameOf(id: string): string };
describe("ORW-691 B1-3: a view that goes from warm to cold is told as turned (unit: the week and the crown set by hand)", () => {
  it("a houseguest warmed by real bonding, then argued with by the player over two beats, reads turned in the story", () => {
    const sb = new GameSessionRegistry().sandboxFor("orw691-turned");
    sb.session.createCharacter({ playerName: "The Player", seed: 3 });
    const g = sb.session as unknown as Seam;
    const target = (g as unknown as { house: { npcs: Array<{ id: string }> } }).house.npcs[0]!.id;
    const betray = (): void => { sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, target], content: "we had a sharp argument", kind: "conflict", toward: [target] }); };
    g.live.playedGame = true;
    for (let i = 0; i < 1; i++) sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, target], content: "we talked for hours and got close", kind: "bonding", toward: [target] });
    g.yourStoryTick();
    g.live.week += 1;
    // the fold budget re-opens each beat, so the betrayals are spread across real advanced beats of the season
    for (let beat = 0; beat < 2; beat++) {
      const v = sb.session.advanceGame();
      if (v.pending) resolve(sb.session as GameSessionAdapter, v.pending);
      betray();
    }
    g.yourStoryTick();
    g.live.finished = true;
    const v = g.buildYourStoriesView()!;
    const mine = v.stories.find((s) => s.name === g.nameOf(target))!;
    expect(mine.shape).toBe("turned");
  });
});
