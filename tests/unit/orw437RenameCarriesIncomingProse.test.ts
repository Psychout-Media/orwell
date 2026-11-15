import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

// Review of #2748: a writer profile that renames the houseguest and carries a biography/identity written around the
// OLD given name must not store a card whose story names someone else.
describe("ORW-437 recordCastProfile: the incoming story follows the rename", () => {
  it("review of #2775: a rename that lengthens the identity concept is clipped to 300 code points again", () => {
    const s = new GameSessionAdapter();
    s.preSeedCast({ seed: 7 });
    const npc = s.snapshot().prewarm!.npcs[0]!;
    const oldGiven = npc.name.split(" ")[0]!;
    const surname = npc.name.split(" ").slice(1).join(" ");
    const longGiven = "Namexyzabcde";
    const filler = "x".repeat(Math.max(0, 300 - oldGiven.length * 6 - 6 * 2));
    const concept = `${Array(6).fill(oldGiven).join(", ")}, ${filler}`.slice(0, 300);
    const res = s.recordCastProfile({ houseguestId: npc.id, name: `${longGiven} ${surname}`, identityConcept: concept });
    expect(res.accepted).toBe(true);
    const out = s.snapshot().prewarm!.npcs[0]!.character.identityConcept!;
    expect(out).toContain(longGiven);
    expect(Array.from(out).length).toBeLessThanOrEqual(300);
  });
  it("renames at the name field and the biography and identity that arrive with the old given name use the new one", () => {
    const s = new GameSessionAdapter();
    s.preSeedCast({ seed: 7 }); // pre-game: nobody has been introduced yet, so the name is still free to change
    const warm = () => s.snapshot().prewarm!.npcs[0]!;
    const npc = warm();
    const oldGiven = npc.name.split(" ")[0]!;
    const surname = npc.name.split(" ").slice(1).join(" ");
    const next = `Namex ${surname}`;
    const res = s.recordCastProfile({
      houseguestId: npc.id, name: next,
      biography: `${oldGiven} grew up in Converse and fixes boats. ${oldGiven}'s sister keeps the books.`,
      identityConcept: `${oldGiven} hums through every silence.`,
    });
    expect(res.accepted).toBe(true);
    const live = warm();
    expect(live.name).toBe(next);
    expect(live.character.biography).toBe("Namex grew up in Converse and fixes boats. Namex's sister keeps the books.");
    expect(live.character.identityConcept).toBe("Namex hums through every silence.");
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

  it("before anyone is introduced (pre-game) the same fold still changes the presentation, so the freeze is what holds it", () => {
    const s = new GameSessionAdapter();
    s.preSeedCast({ seed: 7 });
    const cast = s.snapshot().prewarm!.npcs;
    const flips = cast.filter((n) => n.character.genderPresentation === "man" || n.character.genderPresentation === "woman");
    const facets: Record<string, { genderPresentation: "man" | "woman" }> = {};
    for (const n of flips) facets[n.id] = { genderPresentation: n.character.genderPresentation === "man" ? "woman" : "man" };
    const before = new Map(flips.map((n) => [n.id, n.character.genderPresentation]));
    expect(s.recordCastIdentity({ facets }).accepted).toBe(true);
    const changed = s.snapshot().prewarm!.npcs.filter((n) => before.has(n.id) && n.character.genderPresentation !== before.get(n.id));
    expect(changed.length).toBeGreaterThan(0);
  });
});
