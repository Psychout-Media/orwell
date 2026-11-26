import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { answerPending } from "../../features/support/answerPending";

/**
 * ORW-942 (leftover of ORW-916, Fable's dev run turn 92): "the HOH winner line was blank when the player was among the last few". It was not reproduced through the real path, so this is the evidence it stays that way:
 * three PLAYED seasons (a message each turn, every decision answered, events advanced when due, bed at night), and at EVERY crown the game hands over (HOH and veto) the line is not blank and names the winner; and when
 * the player is still in the field with three or fewer left at a competition round, the crown that follows is checked the same way (counted: the test says how many such crowns it saw). Nothing is set by hand. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
type Sess = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("a crown line is never blank (played)", () => {
  it("every HOH and veto crown names its winner, including those the player was among the last few for", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    let crowns = 0, playerLate = 0;
    for (const seed of [108, 5, 11]) {
      const s = new GameSessionRegistry().sandboxFor(`crown942-${seed}`).session as Sess;
      s.createCharacter({ playerName: "The Player", seed });
      let m = 0, late = false, seasonCrowns = 0;
      for (let i = 0; i < 5000 && seasonCrowns < 8; i++) {
        s.noteMessage({ messageId: `m${m++}` });
        const g = s.getGameState();
        const comp = g.ceremony?.competition;
        if (comp) {
          const field = (comp.stillIn ?? []) as Array<{ name: string }>;
          if (field.length > 0 && field.length <= 3 && field.some((p) => p.name === g.player?.name)) late = true;
        }
        const check = (ev: { beat?: string; content?: string } | undefined): void => {
          if (!ev || (ev.beat !== "hoh-competition" && ev.beat !== "veto-competition")) return;
          const text = String(ev.content ?? "");
          expect(text.trim().length, `seed ${seed}: the crown line is not blank`).toBeGreaterThan(0);
          expect(text, `seed ${seed}: it names a winner`).toMatch(/ wins (Head of Household|the Power of Veto)/);
          crowns++; seasonCrowns++;
          if (late) playerLate++;
          late = false;
        };
        if (g.pending && g.pending.kind !== "ceremony-step") { const r = answerPending(g.pending); if (r) check(s.submitDecision(r)?.event); continue; }
        if (s.milestoneDue() || g.pending) { const v = s.advanceGame(); check(v.event); if (v.held && ["night", "late-night"].includes(s.snapshot().live.timeOfDay)) s.turnIn(); continue; }
        if (["night", "late-night"].includes(s.snapshot().live.timeOfDay)) s.turnIn();
      }
    }
    expect(crowns, "positive control: crowns were seen").toBeGreaterThanOrEqual(12);
    expect(playerLate, "positive control: the scenario of the card (the player among the last three) was reached").toBeGreaterThan(0);
    console.log(`ORW-942: ${crowns} crowns checked, ${playerLate} with the player among the last three`);
  }, 900_000);
});
