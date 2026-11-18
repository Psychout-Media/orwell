import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { articleFor } from "../../src/engine/characterFactory";

// ORW-508: the public `background` starts as the engine's composed job line, `articleFor(vocation) + " " + vocation`
// (characterFactory). When the cast writer changes the vocation, a background that is exactly that composed line for the
// PRIOR job follows the new job, so a houseguest never reads as two people ("a machinist" on a groundskeeper). Any other
// background, such as an authored sentence, is left untouched. Live examples: groundskeeper / "a machinist", prison
// chaplain / "a dental hygienist", sommelier / "a sales engineer".

const start = (seed: number) => {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "The Player", seed });
  const npc = s.getGameState().house[0]!;
  return { s, npc, prior: npc.vocation! };
};
const card = (s: GameSessionAdapter, id: string) => s.getGameState().house.find((h) => h.id === id)!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const character = (s: GameSessionAdapter, id: string) => (s as any).house.npcs.find((n: { id: string }) => n.id === id).character;

describe("ORW-508: a composed background follows a vocation the writer changes", () => {
  it("recomposes the engine's job line from the new vocation, on the card and on the character the narrator reads", () => {
    const { s, npc, prior } = start(21);
    expect(card(s, npc.id).background).toBe(`${articleFor(prior)} ${prior}`);
    const res = s.recordCastProfile({ houseguestId: npc.id, vocation: "minor-league groundskeeper" });
    expect(res.accepted).toBe(true);
    expect(res.publicFields).toEqual(expect.arrayContaining(["vocation", "background"]));
    expect(card(s, npc.id).background).toBe("a minor-league groundskeeper");
    expect(character(s, npc.id).background).toBe("a minor-league groundskeeper");
    expect(card(s, npc.id).background!.toLowerCase()).not.toContain(prior.toLowerCase());
  });

  it("uses the factory's own article rule", () => {
    const { s, npc } = start(5);
    s.recordCastProfile({ houseguestId: npc.id, vocation: "architect" });
    expect(card(s, npc.id).background).toBe("an architect");
  });

  it("leaves an authored background exactly as it is", () => {
    const { s, npc } = start(7);
    const authored = "a third-generation machinist who learned the lathe at a parent's shop";
    character(s, npc.id).background = authored;
    const res = s.recordCastProfile({ houseguestId: npc.id, vocation: "prison chaplain" });
    expect(res.accepted).toBe(true);
    expect(res.publicFields).not.toContain("background");
    expect(character(s, npc.id).background).toBe(authored);
  });

  it("leaves the background alone when the vocation does not change", () => {
    const { s, npc, prior } = start(9);
    const before = card(s, npc.id).background;
    const res = s.recordCastProfile({ houseguestId: npc.id, vocation: prior });
    expect(res.publicFields).not.toContain("background");
    expect(card(s, npc.id).background).toBe(before);
  });
});
