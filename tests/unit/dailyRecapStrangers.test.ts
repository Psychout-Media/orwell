import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-707 (PT-7, a Vault Wall leak from a played game): the bedtime recap told the player a rumor about a houseguest they had never been introduced to. A recap line may only name people the
 * player has met or shared a scene with. Played through the real registry wiring: the premiere entrances run on the player's messages and the night falls before everyone has walked in, then the
 * real knowledge service surfaces rumors to the player. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

describe("ORW-707 - the bedtime recap never names a houseguest the player has not met", () => {
  for (const seed of [3, 11]) {
    it(`seed ${seed}: a rumor about a stranger stays out of the recap; one about a met houseguest rides`, () => {
      GameSessionAdapter.setTimeOfDayEnabled(true);
      const sb = new GameSessionRegistry().sandboxFor(`recap-strangers-${seed}`);
      const s = sb.session as any;
      s.setPremiereEntrancesEnabled(true);
      s.createCharacter({ playerName: "P", seed });
      s.setPerConversationClockEnabled(true);
      for (let i = 0; i < 400 && !["night", "late-night"].includes(s.gameStatus().timeOfDay); i++) s.noteMessage({ messageId: `m${i}` });
      const npcs = s.house.npcs as { id: string; name: string }[];
      const strangers = npcs.filter((n) => !s.introducedNames.has(n.id));
      const friends = npcs.filter((n) => s.introducedNames.has(n.id));
      expect(strangers.length, "precondition: the night fell with houseguests still to meet").toBeGreaterThan(0);
      const tell = (about: { id: string; name: string }, factId: string) => {
        const content = `word around the house is that ${about.name} is carrying something they are not telling anyone`;
        sb.engine.knowledge.seedBelief(friends[0]!.id, { content, factId, subject: about.id }, "witnessed");
        sb.engine.knowledge.surfaceInformationTo(PLAYER, { content, subject: about.id }, `told-by:${friends[0]!.id}`);
      };
      tell(strangers[0]!, "g-stranger");
      tell(friends[1]!, "g-friend");
      const recap = s.turnIn().dailyRecap!;
      expect(JSON.stringify(recap), "no stranger's name in the recap").not.toContain(strangers[0]!.name);
      expect(recap.surfaced.join(" "), "the met houseguest's rumor still rides").toContain(friends[1]!.name);
    });
  }
});
