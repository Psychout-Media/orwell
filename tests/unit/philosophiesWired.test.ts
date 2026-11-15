import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { drawPhilosophy, defaultPhilosophyOf, styleOfPhilosophy } from "../../src/engine/philosophy";
import { NOMINATION_STYLE_BY_ARCHETYPE } from "../../src/engine/decisionConstants";

/**
 * ORW-37 / B40 - the lasting game philosophy is WIRED: with ORWELL_PHILOSOPHIES on (default) each NPC's nomination style comes from their seeded philosophy draw (most keep their archetype's default, some play
 * against type); off => the archetype table. Deterministic per (seed, houseguest). Roles only.
 */
type G = { nominationStyleFor(id: string): string; setPhilosophiesEnabled(on: boolean): void; philosophyOf(id: string): string; archetypeReadOf(id: string): string | undefined };

function house(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`phil-${seed}-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  const g = sb.session as unknown as G;
  const ids = sb.session.livingIds().filter((i) => i !== PLAYER);
  return { g, ids };
}
const STYLE_OF = (g: G, id: string): string => styleOfPhilosophy(g.philosophyOf(id) as never);

describe("the philosophy draw decides the nomination style (ORW-37)", () => {
  it("ON: every NPC's style is the style of their philosophy; most match the archetype table, some play against type across many houses", () => {
    let total = 0, match = 0, against = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { g, ids } = house(seed);
      for (const id of ids) {
        const arch = g.archetypeReadOf(id) ?? "";
        const table = NOMINATION_STYLE_BY_ARCHETYPE[arch] ?? "threat-hunter";
        total++;
        if (STYLE_OF(g, id) === table) match++; else against++;
      }
    }
    expect(match / total, "most keep their archetype's default").toBeGreaterThan(0.6);
    expect(against, "some play against type").toBeGreaterThan(0);
  });
  it("is deterministic per (seed, houseguest), and the pure draw keeps the archetype default for most seeds", () => {
    const a = house(5), b = house(5);
    for (const id of a.ids) expect(a.g.philosophyOf(id)).toBe(b.g.philosophyOf(id));
    let kept = 0;
    for (let s = 1; s <= 200; s++) if (drawPhilosophy("floater", s) === defaultPhilosophyOf("floater")) kept++;
    expect(kept / 200).toBeGreaterThan(0.6);
  });
  it("wiring pin: the nomination-style read in the adapter goes through the philosophy when the flag is on, else the archetype table", () => {
    const src = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
    expect(src).toMatch(/this\.philosophiesEnabled \? styleOfPhilosophy\(this\.philosophyOf\(id\)\) : NOMINATION_STYLE_BY_ARCHETYPE/);
  });
});
