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
