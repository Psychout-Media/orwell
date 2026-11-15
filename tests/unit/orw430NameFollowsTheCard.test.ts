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

describe("ORW-437 only name-shaped occurrences of a common-word given name are renamed (review of #2748)", () => {
  const swap = (text: string, from: string) => renameGivenNameInProse(text, `${from} Surnamea`, "Nameb Surnamea");
  it("leaves months, nouns and 'in/of/last' uses alone", () => {
    expect(swap("She was born in May and left last May for good.", "May")).toBe("She was born in May and left last May for good.");
    expect(swap("A strong free Will, the Will of the house, her Faith in the Summer.", "Will")).toBe("A strong free Will, the Will of the house, her Faith in the Summer.");
    expect(swap("Every Summer she sails; last Summer, too.", "Summer")).toBe("Every Summer she sails; last Summer, too.");
    expect(swap("A degree in Art and the Art of the deal.", "Art")).toBe("A degree in Art and the Art of the deal.");
  });
  it("still renames sentence-initial, after-verb, possessive and list uses", () => {
    expect(swap("May grew up in Converse. Everyone calls May a force, and May's sister agrees; ask May.", "May"))
      .toBe("Nameb grew up in Converse. Everyone calls Nameb a force, and Nameb's sister agrees; ask Nameb.");
    expect(swap("Grace fixes boats. In Grace’s kitchen, named Grace by her aunt, Grace sings.", "Grace"))
      .toBe("Nameb fixes boats. In Nameb’s kitchen, named Nameb by her aunt, Nameb sings.");
    expect(swap("Mark, Hope and Rose met Mark by the pier.", "Mark")).toBe("Nameb, Hope and Rose met Nameb by the pier.");
  });
  it("renames every capitalised use of an ordinary given name, wherever it sits", () => {
    expect(swap("In Namea's kitchen and last night Namea left, of Namea we say little.", "Namea"))
      .toBe("In Nameb's kitchen and last night Nameb left, of Nameb we say little.");
  });
});
