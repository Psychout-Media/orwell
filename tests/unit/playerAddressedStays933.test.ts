import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

// ORW-933 (Fable's week-2 run, turns 278-279): the player turned to a houseguest by name ("I find <X> ... Deal?"), the houseguest spoke, and on the very next turn the engine had them in another room.
// The conversation hold keeps the player's partners in the room for a few ticks, but it started only once a scene was RECORDED after the reply, so a houseguest the message itself named was not held.
// Roles only: the houseguest is whoever the seed gives.
type P = { presence: Map<string, string>; presenceBase: Map<string, string> | null; presenceTick(rng: SeededRandom): void; resolvePlayerMove(req: { text: string }): unknown; houseEventInSession(): unknown; setCalmPresenceEnabled(on: boolean): void; nameOf(id: string): string };
const SEEDS = 24, TICKS = 2;

function leavers(textFor: (name: string) => string): { left: number; tried: number } {
  let left = 0, tried = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const sb = new GameSessionRegistry().sandboxFor(`addressed-933-${seed}`);
    sb.session.createCharacter({ playerName: "P", archetype: "floater", seed });
    sb.session.advanceGame(); sb.session.advanceGame();
    const g = sb.session as unknown as P; g.setCalmPresenceEnabled(true);
    const npcs = sb.session.livingIds().filter((i) => i !== PLAYER);
    const target = npcs[seed % npcs.length]!;
    g.presence.set(PLAYER, "living-room"); g.presenceBase?.set(PLAYER, "living-room"); g.presence.set(target, "living-room");
    g.resolvePlayerMove({ text: textFor(g.nameOf(target)) });
    const rng = new SeededRandom(seed * 7919);
    tried++;
    for (let t = 0; t < TICKS; t++) { g.presence.set(PLAYER, "living-room"); g.presenceBase?.set(PLAYER, "living-room"); g.presenceTick(rng); }
    if (g.presence.get(target) !== "living-room") { left++; }
  }
  return { left, tried };
}

describe("ORW-933 a houseguest the player's message names is held in the room for the next ticks", () => {
  it("'I find <X> and put the offer to them': far fewer addressed houseguests walk out within the hold than when the message names nobody (the hold keeps a low chance of leaving: ORW-212)", () => {
    const named = leavers((n) => `I find ${n} and put the offer to them. Deal?`);
    const nobody = leavers(() => "I look around the room and wait.");
    expect(nobody.left, "without a named houseguest several do leave, so the test is not vacuous").toBeGreaterThanOrEqual(4);
    expect(named.left, `${named.left} of ${named.tried} named houseguests left, against ${nobody.left} of ${nobody.tried} with none named`).toBeLessThanOrEqual(2);
  });
});
