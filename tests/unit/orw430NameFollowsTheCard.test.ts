import { describe, it, expect } from "vitest";
import { renameGivenNameInProse } from "../../src/engine/diversity";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

// ORW-430: a given-name re-pick (gender fold, genesis gender cohere, cross-season de-collision) must carry into the
// public prose genesis wrote around the old name.

const BIO = "Nia grew up helping at the family funeral home in Converse. Off the clock Nia sings alto, and her sister Nia-Lee watches.";

describe("ORW-430 renameGivenNameInProse", () => {
  it("swaps the old first name, whole word and possessive, and leaves a different name that merely starts with it", () => {
    expect(renameGivenNameInProse("Nia's mother knew Niall.", "Nia Nesbitt", "Samir Nesbitt")).toBe("Samir's mother knew Niall.");
    // ORW-437: the whole renamed text, so a hyphenated different name ("Nia-Lee") can never be rewritten unnoticed
    expect(renameGivenNameInProse(BIO, "Nia Nesbitt", "Samir Nesbitt")).toBe(
      "Samir grew up helping at the family funeral home in Converse. Off the clock Samir sings alto, and her sister Nia-Lee watches.");
    expect(renameGivenNameInProse("D'Nia met Nia-Lee and Nia.", "Nia Nesbitt", "Samir Nesbitt")).toBe("D'Nia met Nia-Lee and Samir.");
  });
  it("is a no-op when the first name did not change (a surname-only change) or the prose never used it", () => {
    expect(renameGivenNameInProse(BIO, "Nia Nesbitt", "Nia Brandt")).toBe(BIO);
    expect(renameGivenNameInProse("A calm baker.", "Nia Nesbitt", "Samir Nesbitt")).toBe("A calm baker.");
  });
});

describe("ORW-430 the adapter's rename carries the prose", () => {
  it("renameHouseguest rewrites the biography and identity concept it holds, and only on a first-name change", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: 7 });
    const npc = (s as unknown as { house: { npcs: { name: string; character: Record<string, unknown> }[] } }).house.npcs[0]!;
    const surname = npc.name.split(" ").slice(1).join(" ");
    npc.name = `Nia ${surname}`;
    npc.character.biography = "Nia grew up in Converse. Nia sings alto.";
    npc.character.identityConcept = "Nia hums through every silence.";
    (s as unknown as { renameHouseguest: (n: unknown, next: string) => void }).renameHouseguest(npc, `Samir ${surname}`);
    expect(npc.name).toBe(`Samir ${surname}`);
    expect(npc.character.biography).toBe("Samir grew up in Converse. Samir sings alto.");
    expect(npc.character.identityConcept).toBe("Samir hums through every silence.");
  });
});
