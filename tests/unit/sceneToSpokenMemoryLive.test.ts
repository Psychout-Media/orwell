import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * Watch list item 2 (ORW-106): the consequence loop reaches the narrator's hands. A REAL recorded betrayal scene (witnessed by one houseguest) makes THAT houseguest able to bring it up in plain words
 * (npcVoice.rememberedAboutYou), and nobody else: a bystander who was not in the scene, and the same houseguest before the scene, hold nothing to say. A scene kind that carries no grudge (a plain
 * chat) writes nothing. No kind slug, severity or digit crosses to the narrator. Flags set explicitly. Roles only.
 */
type V = { rememberedAboutYou?: string[]; bringUp?: true };
type S = { npcVoice(id: string): V | null; setNpcMemoryEnabled(on: boolean): void; setNpcMemoryWritersEnabled(on: boolean): void; setNpcMemorySpeechEnabled(on: boolean): void };
function game(seed: number, writers = true) {
  const sb = new GameSessionRegistry().sandboxFor(`scene-mem-${seed}-${writers}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  const s = sb.session as unknown as S;
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
    expect("rememberedAboutYou" in (s.npcVoice(a) ?? {}), "before the scene there is nothing to say").toBe(false);
    scene(sb, a, "betrayal");
    const mem = s.npcVoice(a)?.rememberedAboutYou;
    expect(mem, "the witness now remembers the player's act").toBeTruthy();
    expect(mem!.length).toBeGreaterThan(0);
    for (const line of mem!) {
      expect(line, "plain words: no digit, kind slug or severity").not.toMatch(/\d|scene-|severity|betrayal"/);
    }
    expect("rememberedAboutYou" in (s.npcVoice(b) ?? {}), "a bystander who was not in the scene holds nothing").toBe(false);
  });

  it("a scene kind with no grudge or favor (a plain chat) writes no memory", () => {
    const { sb, s, a } = game(11);
    scene(sb, a, "chat");
    expect("rememberedAboutYou" in (s.npcVoice(a) ?? {})).toBe(false);
  });

  it("mutant control: with the memory writers off the same betrayal leaves nothing to voice", () => {
    const { sb, s, a } = game(11, false);
    scene(sb, a, "betrayal");
    expect("rememberedAboutYou" in (s.npcVoice(a) ?? {})).toBe(false);
  });
});
