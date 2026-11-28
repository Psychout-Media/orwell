import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

// ORW-1135 / ORW-1136: the act-first search commit. A cap on the legs, a target already in the player's room is a success ("right here"), and a houseguest whose own bed is in
// the player's room is not looked for through the house.

type Priv = { presence: Map<string, string>; house: { player: { id: string } }; live: { champagneCircle?: unknown; beds?: { owner: Record<string, string>; claims: unknown[] } }; livingIds(): string[]; nameOf(id: string): string };

function start(seed: number) {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "P", seed });
  const p = s as unknown as Priv;
  p.live.champagneCircle = undefined;
  const others = p.livingIds().filter((id) => id !== p.house.player.id);
  const x = others[0]!;
  others.forEach((id) => p.presence.set(id, "landing"));
  return { s, p, x, first: p.nameOf(x).split(" ")[0]! };
}

describe("ORW-1135/1136 act-first search commit", () => {
  it("maxLegs caps the legs of a search committed from the player's words", () => {
    const t = start(21);
    t.s.movePlayer("living-room");
    t.p.presence.set(t.x, "storage-room");
    const r = t.s.resolvePlayerMove({ text: `I look for ${t.first}.`, maxLegs: 2 });
    expect(r.search?.legs.length).toBe(2);
    expect(r.search?.outcome).toBe("stopped");
  });

  it("a target already in the player's room is found 'right here': a search result, no legs, no move, no clock", () => {
    const t = start(22);
    t.s.movePlayer("bedroom-c");
    t.p.presence.set(t.x, "bedroom-c");
    const r = t.s.resolvePlayerMove({ text: `I look for ${t.first}.`, maxLegs: 3 });
    expect(r.search?.outcome).toBe("found");
    expect(r.search?.legs).toEqual([]);
    expect(r.search?.reason).toMatch(/right here/);
    expect(r.search?.minutes).toBe(0);
    expect(r.playerMove).toBeNull();
    expect(t.s.whereabouts()!.room).toBe("bedroom-c");
  });

  it("a houseguest whose own bed is in this room is not walked to: the search ends with no leg and the player stays", () => {
    const t = start(23);
    t.s.movePlayer("bedroom-c");
    t.p.live.beds = { owner: { ...(t.p.live.beds?.owner ?? {}), [t.x]: "bedroom-c#s1" }, claims: t.p.live.beds?.claims ?? [] };
    t.p.presence.set(t.x, "kitchen");
    const r = t.s.resolvePlayerMove({ text: `I look for ${t.first}.`, maxLegs: 3 });
    expect(r.search?.legs).toEqual([]);
    expect(r.search?.reason).toMatch(/bed is in this room/);
    expect(r.playerMove).toBeNull();
    expect(t.s.whereabouts()!.room).toBe("bedroom-c");
  });

  it("an ordinary caller (no maxLegs) keeps the old behaviour for a person who is here: no search result", () => {
    const t = start(24);
    t.s.movePlayer("bedroom-c");
    t.p.presence.set(t.x, "bedroom-c");
    expect(t.s.resolvePlayerMove({ text: `I look for ${t.first}.` }).search).toBeUndefined();
  });
});
