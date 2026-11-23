import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * ORW-828 (ORW-707 / PT-7 again): the bedtime recap's "your day" and highlights lines rode every player-witnessed event, including the Day-1 public pre-show tie announcement ("it is known in the house:
 * A and B ..."), which is recorded with the whole house as witnesses. On the premiere night the recap therefore named two houseguests the player had never met. Played through the real registry
 * wiring (premiere entrances on the player's messages, no state set by hand). Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

describe("ORW-828 - the bedtime recap's day lines never name a houseguest the player has not met", () => {
  it("across seeds: no stranger's name in any recap line, and the precondition (a public tie naming a stranger) is met at least once", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    let preconditionSeeds = 0;
    for (const seed of [2, 3, 5, 9, 11, 13, 17, 21]) {
      const sb = new GameSessionRegistry().sandboxFor(`recap-scenes-${seed}`);
      const s = sb.session as any;
      s.setPremiereEntrancesEnabled(true);
      s.createCharacter({ playerName: "P", seed });
      s.setPerConversationClockEnabled(true);
      for (let i = 0; i < 400 && !["night", "late-night"].includes(s.gameStatus().timeOfDay); i++) s.noteMessage({ messageId: `m${i}` });
      const strangers = (s.house.npcs as { id: string; name: string }[]).filter((n) => !s.introducedNames.has(n.id));
      const tieNamesStranger = (s.record.events() as any[]).some(
        (e) => e.type === "pre-show-tie" && strangers.some((n) => e.content.includes(n.name)),
      );
      if (tieNamesStranger) preconditionSeeds++;
      const recap = s.turnIn().dailyRecap!;
      const lines = [...recap.highlights, ...(recap.yourDay ?? []), ...recap.surfaced].join(" | ");
      for (const n of strangers) expect(lines, `seed ${seed}: the recap names a houseguest the player has not met`).not.toContain(n.name);
    }
    expect(preconditionSeeds, "precondition: some premiere night had a public tie naming a houseguest not yet met").toBeGreaterThan(0);
  });
});
