import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import type { AdvanceView } from "../../src/ports/GameSession";

/**
 * AMEND secrets wall item 4 (0013 + 0115): the Diary Room has NO in-game pathway to any NPC. The shared same-seed test: the SAME seeded season played twice - once with a player Diary Room
 * entry on file, once without - must produce IDENTICAL public decisions (every nomination, veto, vote and eviction), because the booth informs only the player's own knowledge and the
 * narrator, never NPC behaviour. A diary-tagged fact is also checked to stay out of every NPC's knowledge. Roles only.
 */
const SAME_USER = "dr-noeffect"; // the sandbox NAME seeds outcomes - both arms use the same one

function play(withEntry: boolean, seed: number): { beats: string[]; npcKnowsEntry: boolean } {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(SAME_USER);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const npcs = sb.session.snapshot().house!.npcs.map((n) => n.id);
  const ENTRY = `private booth read ${seed}: ${npcs[0]} is the one to watch`;
  if (withEntry) {
    sb.commands.diaryRoom({ entry: ENTRY, subjectId: npcs[0]! }); // the REAL booth path (ORW-38 sweep #2131: this used to seed knowledge directly, bypassing the production code)
  }
  const beats: string[] = [];
  let v: AdvanceView = sb.session.advanceGame();
  for (let i = 0; i < 400 && !v.finished; i++) {
    if (v.event?.content) beats.push(`${v.event.beat}: ${v.event.content}`);
    v = v.pending ? (resolvePending(v.pending, (req) => sb.session.submitDecision(req)) ?? sb.session.advanceGame()) : sb.session.advanceGame();
  }
  const npcKnowsEntry = npcs.some((id) => sb.engine.knowledge.knownTo(id).some((f) => f.content.includes("private booth read")));
  return { beats, npcKnowsEntry };
}

describe("a Diary Room entry never changes what any NPC decides", () => {
  for (const seed of [3, 7]) {
    it(`seed ${seed}: the full public beat log is identical with vs without an entry, and no NPC ever knows it`, () => {
      const without = play(false, seed);
      const withE = play(true, seed);
      expect(without.beats.length).toBeGreaterThan(10); // a real season was played
      expect(withE.beats).toEqual(without.beats);
      expect(withE.npcKnowsEntry).toBe(false);
    });
  }
});
