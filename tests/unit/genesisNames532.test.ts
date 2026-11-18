import { describe, it, expect } from "vitest";
import { npc, PLAYER } from "../../src/domain/ids";
import { ARCHETYPES } from "../../src/engine/characterFactory";
import { validateCastGenesis, type GenesisContext, type CastGenesisProposal } from "../../src/engine/castGenesis";

// ORW-532: the genesis writer keeps the dealt surname, picks the given name; a name on the recent-seasons memory
// or repeated in the cast is refused and the dealt (floor) name stands.

const FLOOR = ["Dana Whitlock", "Ravi Okafor", "Mina Castellano", "Leon Brandt", "Priya Salgado"];
const ctx = (extra: Partial<GenesisContext> = {}): GenesisContext => ({
  npcs: FLOOR.map((floorName, i) => ({ id: npc(i + 1), floorArchetype: ARCHETYPES[i]!.archetype, floorStats: { ...ARCHETYPES[i]!.bias }, floorName })),
  playerId: PLAYER, ...extra,
});
const propose = (names: string[]): CastGenesisProposal => ({ npcs: names.map((name, i) => ({ id: npc(i + 1), name })) });
const nameOf = (r: ReturnType<typeof validateCastGenesis>, i: number) => r.npcs[i]!.name;
const rules = (r: ReturnType<typeof validateCastGenesis>) => r.violations.filter((v) => v.field === "name").map((v) => v.rule);

describe("ORW-532 genesis names", () => {
  it("keeps the dealt surname when asked: the writer's given name stands, a different surname is replaced and counted", () => {
    const r = validateCastGenesis(propose(["Corinne Whitlock", "Tobias Marlow", "Elena Castellano", "Gus Brandt", "Nila Salgado"]), ctx({ keepDealtSurname: true }));
    expect(r.npcs.map((n) => n.name)).toEqual(["Corinne Whitlock", "Tobias Okafor", "Elena Castellano", "Gus Brandt", "Nila Salgado"]);
    expect(rules(r)).toEqual(["surname is the dealt surname (the writer picks the given name)"]);
    // without the flag the writer's own surname is accepted as before
    expect(nameOf(validateCastGenesis(propose(["Tobias Marlow", "Ravi Okafor"]), ctx()), 0)).toBe("Tobias Marlow");
  });
  it("refuses a name on the recent-seasons memory (full name, given name or surname) and falls back to the dealt name", () => {
    const r = validateCastGenesis(propose(["Corinne Whitlock", "Tobias Okafor", "Elena Castellano", "Gus Brandt", "Nila Salgado"]),
      ctx({ keepDealtSurname: true, avoidNames: ["corinne hale", "Past Brandt", "NILA SALGADO"] }));
    expect(nameOf(r, 0)).toBeUndefined();           // given name Corinne is remembered
    expect(nameOf(r, 3)).toBeUndefined();           // surname Brandt is remembered
    expect(nameOf(r, 4)).toBeUndefined();           // full name remembered
    expect(nameOf(r, 1)).toBe("Tobias Okafor");
    expect(rules(r).filter((x) => x === "on the recent-seasons memory").length).toBe(3);
  });
  it("refuses a given name repeated in the cast", () => {
    const r = validateCastGenesis(propose(["Ruth Whitlock", "Ruth Okafor", "Mina Castellano", "Leon Brandt", "Priya Salgado"]), ctx({ keepDealtSurname: true }));
    expect(nameOf(r, 0)).toBe("Ruth Whitlock");
    expect(nameOf(r, 1)).toBeUndefined();
    expect(rules(r)).toContain("duplicate name within the cast");
  });
});
