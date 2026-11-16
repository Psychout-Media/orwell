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
    // the renamed story is longer than the cap (each of the six names grew), so the clip lands exactly on 300 code points: a smaller cap would fail here (review of #2794)
    expect(oldGiven.length).toBeLessThan(longGiven.length);
    expect(Array.from(out).length).toBe(300);
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

// ORW-463: the three known limits of the rename (review of #2775)
import { renameGivenNameInProse } from "../../src/engine/diversity";

describe("ORW-463 renameGivenNameInProse: a sentence word after the given name is not a surname", () => {
  it.each([
    ["Lola Monday mornings are slow.", "Zorvan Monday mornings are slow."],
    ["She waits. Lola Now sings softly.", "She waits. Zorvan Now sings softly."],
    ["Lola She says nothing.", "Zorvan She says nothing."],
    ["Lola Texas born and raised.", "Zorvan Texas born and raised."],
  ])("%s", (text, want) => {
    expect(renameGivenNameInProse(text, "Lola Lawrence", "Zorvan Lawrence")).toBe(want);
  });
  it("another person's full name is still left alone, at a sentence start or not", () => {
    expect(renameGivenNameInProse("Her rival Lola Other never lets up.", "Lola Lawrence", "Zorvan Lawrence")).toBe("Her rival Lola Other never lets up.");
    expect(renameGivenNameInProse("Lola Other never lets up.", "Lola Lawrence", "Zorvan Lawrence")).toBe("Lola Other never lets up.");
    expect(renameGivenNameInProse("Lola Monday, the neighbour, waves.", "Lola Lawrence", "Zorvan Lawrence")).toBe("Lola Monday, the neighbour, waves.");   // a capitalised word that does not continue into lower-case text stays a name
    expect(renameGivenNameInProse("Her rival Lola Monday mornings.", "Lola Lawrence", "Zorvan Lawrence")).toBe("Her rival Lola Monday mornings.");           // not at a sentence start: unchanged behaviour
  });
});

describe("ORW-463 recordCastProfile: a rename an EARLIER call made still reaches the biography that arrives later", () => {
  it("the name-only call renames; the later biography written around the old given name follows it, and the memory ends with the biography", () => {
    const s = new GameSessionAdapter();
    s.preSeedCast({ seed: 7 });
    const warm = () => s.snapshot().prewarm!.npcs[0]!;
    const npc = warm();
    const oldGiven = npc.name.split(" ")[0]!;
    const surname = npc.name.split(" ").slice(1).join(" ");
    expect(s.recordCastProfile({ houseguestId: npc.id, name: `Namex ${surname}` }).accepted).toBe(true);
    const res = s.recordCastProfile({ houseguestId: npc.id, biography: `${oldGiven} grew up in Converse. ${oldGiven} fixes boats.`, identityConcept: `${oldGiven} hums through every silence.` });
    expect(res.accepted).toBe(true);
    expect(warm().character.biography).toBe("Namex grew up in Converse. Namex fixes boats.");
    expect(warm().character.identityConcept).toBe("Namex hums through every silence.");
    // the biography has landed: a LATER re-authoring around the old name is left as the writer wrote it (the memory is gone)
    expect(s.recordCastProfile({ houseguestId: npc.id, biography: `${oldGiven} again.` }).accepted).toBe(true);
    expect(warm().character.biography).toBe(`${oldGiven} again.`);
  });
  it("a second houseguest who really has the old given name keeps it when the profile of the renamed one is written in the same call", () => {
    const s = new GameSessionAdapter();
    s.preSeedCast({ seed: 7 });
    const [a, b] = s.snapshot().prewarm!.npcs;
    const oldGiven = a!.name.split(" ")[0]!;
    const surnameA = a!.name.split(" ").slice(1).join(" ");
    const rivalSurname = "Zzother";
    // B really is "<oldGiven> Zzother": A's biography mentions that full name
    const res = s.recordCastProfile({ houseguestId: a!.id, name: `Namex ${surnameA}`, biography: `${oldGiven} fixes boats. Her rival ${oldGiven} ${rivalSurname} never lets up.` });
    expect(res.accepted).toBe(true);
    expect(s.snapshot().prewarm!.npcs[0]!.character.biography).toBe(`Namex fixes boats. Her rival ${oldGiven} ${rivalSurname} never lets up.`);
    expect(b).toBeDefined();
  });
});

describe("ORW-463 the rename memory belongs to one season", () => {
  it("a re-warmed cast on the same adapter does not inherit the last cast's old names", () => {
    const s = new GameSessionAdapter();
    s.preSeedCast({ seed: 7 });
    const first = s.snapshot().prewarm!.npcs[0]!;
    const oldGiven = first.name.split(" ")[0]!;
    expect(s.recordCastProfile({ houseguestId: first.id, name: `Bexo ${first.name.split(" ").slice(1).join(" ")}` }).accepted).toBe(true);
    s.snapshot(); // (a snapshot read must not disturb the memory either way)
    // a new cast (another seed) on the same adapter: the houseguest in the same slot is a different person now
    s.preSeedCast({ seed: 99 });
    const second = s.snapshot().prewarm!.npcs[0]!;
    expect(second.id).toBe(first.id);
    const newGiven = second.name.split(" ")[0]!;
    const res = s.recordCastProfile({ houseguestId: second.id, biography: `Her friend ${oldGiven} Zed is loud. ${oldGiven} knows people.` });
    expect(res.accepted).toBe(true);
    // the old given name belonged to the previous cast: nothing in the new houseguest's story is rewritten to the new given name
    expect(s.snapshot().prewarm!.npcs[0]!.character.biography).toBe(`Her friend ${oldGiven} Zed is loud. ${oldGiven} knows people.`);
    expect(newGiven).not.toBe("");
  });
});
