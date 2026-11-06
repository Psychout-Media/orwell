import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * Watch list item 2 (ORW-106): the consequence loop reaches the narrator's hands. A REAL recorded betrayal scene (witnessed by one houseguest) gives THAT houseguest something to say in plain words
 * (npcVoice.rememberedAboutYou; whether and when they bring it up is the seeded once-per-day bringUp, covered by npcMemorySpeech.test.ts), and nobody else: a bystander who was not in the scene, and the same houseguest before the scene, hold nothing to say. A scene kind that carries no grudge (a plain
 * chat) writes nothing. No kind slug, severity or digit crosses to the narrator. Flags set explicitly. Roles only.
 */
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** The voice of `id`, which must exist (a null voice would make every 'holds nothing' check pass for the wrong reason). */
const voiceOf = (s: GameSessionAdapter, id: string): Record<string, unknown> => {
  const v = s.npcVoice(id);
  expect(v, `${id} has a voice view`).toBeTruthy();
  return v as unknown as Record<string, unknown>;
};
function game(seed: number, writers = true) {
  const sb = new GameSessionRegistry().sandboxFor(`scene-mem-${seed}-${writers}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  const s = sb.session as GameSessionAdapter;
  s.setNpcMemoryEnabled(true); s.setNpcMemoryWritersEnabled(writers); s.setNpcMemorySpeechEnabled(true);
  const [a, b] = sb.session.livingIds().filter((i) => i !== PLAYER);
  return { sb, s, a: a!, b: b! };
}
const scene = (sb: ReturnType<typeof game>["sb"], witness: string, kind: string): void => {
  sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, witness], content: `a ${kind} scene`, kind });
};

describe("a recorded scene becomes a memory the houseguest can voice (event -> memory -> speech)", () => {
  it("a witnessed betrayal: the witness can bring it up in plain words; a bystander and the 'before' state hold nothing", () => {
    const { sb, s, a, b } = game(11);
    expect("rememberedAboutYou" in voiceOf(s, a), "before the scene there is nothing to say").toBe(false);
    scene(sb, a, "betrayal");
    const mem = voiceOf(s, a).rememberedAboutYou as string[] | undefined;
    expect(mem, "the witness now remembers the player's act").toBeTruthy();
    expect(mem!.length).toBeGreaterThan(0);
    for (const line of mem!) {
      expect(line, "plain words: no digit, kind slug or severity").not.toMatch(/\d|scene[-_]|severity|"kind"/);
    }
    expect("rememberedAboutYou" in voiceOf(s, b), "a bystander who was not in the scene holds nothing").toBe(false);
  });

  it("a scene kind with no grudge or favor (a plain chat) writes no memory", () => {
    const { sb, s, a, b } = game(11);
    scene(sb, a, "chat");
    expect("rememberedAboutYou" in voiceOf(s, a), "a plain chat leaves nothing to say").toBe(false);
    scene(sb, b, "betrayal"); // positive control in the same setup: the sink is wired, a betrayal DOES write
    expect("rememberedAboutYou" in voiceOf(s, b), "the same setup does remember a betrayal").toBe(true);
    expect("rememberedAboutYou" in voiceOf(s, a), "...and still nothing for the chat-only houseguest").toBe(false);
  });

  it("mutant control: with the memory writers off the same betrayal leaves nothing to voice", () => {
    const { sb, s, a } = game(11, false);
    scene(sb, a, "betrayal");
    expect("rememberedAboutYou" in voiceOf(s, a), "with the writers off nothing is remembered").toBe(false);
  });
});
