import { describe, it, expect } from "vitest";
import { renameGivenNameInProse } from "../../src/engine/diversity";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

// ORW-430: a given-name re-pick (gender fold, genesis gender cohere, cross-season de-collision) must carry into the
// public prose genesis wrote around the old name.

const BIO = "Namea grew up helping at the family funeral home in Converse. Off the clock Namea sings alto, and her sister Namea-Lee watches.";

describe("ORW-430 renameGivenNameInProse", () => {
  it("swaps the old first name, whole word and possessive, and leaves a different name that merely starts with it", () => {
    expect(renameGivenNameInProse("Namea's mother knew Nameall.", "Namea Surnamea", "Nameb Surnamea")).toBe("Nameb's mother knew Nameall.");
    // ORW-437: the whole renamed text, so a hyphenated different name ("Namea-Lee") can never be rewritten unnoticed
    expect(renameGivenNameInProse(BIO, "Namea Surnamea", "Nameb Surnamea")).toBe(
      "Nameb grew up helping at the family funeral home in Converse. Off the clock Nameb sings alto, and her sister Namea-Lee watches.");
    expect(renameGivenNameInProse("D'Namea met Namea-Lee and Namea.", "Namea Surnamea", "Nameb Surnamea")).toBe("D'Namea met Namea-Lee and Nameb.");
  });
  it("is a no-op when the first name did not change (a surname-only change) or the prose never used it", () => {
    expect(renameGivenNameInProse(BIO, "Namea Surnamea", "Namea Surnameb")).toBe(BIO);
    expect(renameGivenNameInProse("A calm baker.", "Namea Surnamea", "Nameb Surnamea")).toBe("A calm baker.");
  });
});

describe("ORW-430 the adapter's rename carries the prose", () => {
  it("renameHouseguest rewrites the biography and identity concept it holds, and only on a first-name change", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: 7 });
    const npc = (s as unknown as { house: { npcs: { name: string; character: Record<string, unknown> }[] } }).house.npcs[0]!;
    const surname = npc.name.split(" ").slice(1).join(" ");
    npc.name = `Namea ${surname}`;
    npc.character.biography = "Namea grew up in Converse. Namea sings alto.";
    npc.character.identityConcept = "Namea hums through every silence.";
    (s as unknown as { renameHouseguest: (n: unknown, next: string) => void }).renameHouseguest(npc, `Nameb ${surname}`);
    expect(npc.name).toBe(`Nameb ${surname}`);
    expect(npc.character.biography).toBe("Nameb grew up in Converse. Nameb sings alto.");
    expect(npc.character.identityConcept).toBe("Nameb hums through every silence.");
  });
});
