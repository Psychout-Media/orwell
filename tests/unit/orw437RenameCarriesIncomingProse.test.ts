import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

// Review of #2748: a writer profile that renames the houseguest and carries a biography/identity written around the
// OLD given name must not store a card whose story names someone else.
describe("ORW-437 recordCastProfile: the incoming story follows the rename", () => {
  it("renames at the name field and the biography and identity that arrive with the old given name use the new one", () => {
    const s = new GameSessionAdapter();
    s.preSeedCast({ seed: 7 }); // pre-game: nobody has been introduced yet, so the name is still free to change
    const warm = () => s.snapshot().prewarm!.npcs[0]!;
    const npc = warm();
    const oldGiven = npc.name.split(" ")[0]!;
    const surname = npc.name.split(" ").slice(1).join(" ");
    const next = `Zorvan ${surname}`;
    const res = s.recordCastProfile({
      houseguestId: npc.id, name: next,
      biography: `${oldGiven} grew up in Converse and fixes boats. ${oldGiven}'s sister keeps the books.`,
      identityConcept: `${oldGiven} hums through every silence.`,
    });
    expect(res.accepted).toBe(true);
    const live = warm();
    expect(live.name).toBe(next);
    expect(live.character.biography).toBe("Zorvan grew up in Converse and fixes boats. Zorvan's sister keeps the books.");
    expect(live.character.identityConcept).toBe("Zorvan hums through every silence.");
  });
});

describe("ORW-437 recordCastIdentity: an introduced houseguest keeps name and presentation together", () => {
  it("a live fold that proposes the other presentation changes neither the name nor the presentation", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: 7 }); // the premiere introduces everyone
    const cast = s.snapshot().house!.npcs;
    const flips = cast.filter((n) => n.character.genderPresentation === "man" || n.character.genderPresentation === "woman").slice(0, 6);
    expect(flips.length).toBeGreaterThan(0);
    const facets: Record<string, { genderPresentation: "man" | "woman" }> = {};
    for (const n of flips) facets[n.id] = { genderPresentation: n.character.genderPresentation === "man" ? "woman" : "man" };
    const before = new Map(cast.map((n) => [n.id, [n.name, n.character.genderPresentation]]));
    const res = s.recordCastIdentity({ facets });
    expect(res.accepted).toBe(true);
    for (const n of s.snapshot().house!.npcs) expect([n.name, n.character.genderPresentation]).toEqual(before.get(n.id));
  });
});
