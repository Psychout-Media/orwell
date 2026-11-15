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

describe("ORW-437 follow-up to the common-word rule (review of #2775)", () => {
  const swap = (text: string, from: string) => renameGivenNameInProse(text, `${from} Surnamea`, "Nameb Surnamea");
  it("keeps months and common-word uses", () => {
    expect(swap("In May she moved.", "May")).toBe("In May she moved.");
    expect(swap("May moved to Tulsa in May.", "May")).toBe("Nameb moved to Tulsa in May.");
    expect(swap("The Rose family farms here.", "Rose")).toBe("The Rose family farms here.");
    expect(swap("Her Will to win shows.", "Will")).toBe("Her Will to win shows.");
    expect(swap("She has a Grace under pressure.", "Grace")).toBe("She has a Grace under pressure.");
    expect(swap("Every Mark on the wall is hers.", "Mark")).toBe("Every Mark on the wall is hers.");
    expect(swap("A cousin in June, a friend in May.", "June")).toBe("A cousin in June, a friend in May.");
  });
  it("renames real names the first rule missed", () => {
    expect(swap("Her friend Will brought tea.", "Will")).toBe("Her friend Nameb brought tea.");
    expect(swap("Summer's laugh carries.", "Summer")).toBe("Nameb's laugh carries.");
    expect(swap("The Mark she grew up with left.", "Mark")).toBe("The Nameb she grew up with left.");
    expect(swap("She met a Mark who sells boats.", "Mark")).toBe("She met a Nameb who sells boats.");
    expect(swap("A friend of Grace waits.", "Grace")).toBe("A friend of Nameb waits.");
    expect(swap("The daughter of Hope waits.", "Hope")).toBe("The daughter of Nameb waits.");
    expect(swap("Her rival on Rose's team.", "Rose")).toBe("Her rival on Nameb's team.");
  });
  it("never renames another person's full name that shares the given name", () => {
    expect(renameGivenNameInProse("Her rival Lola Other waits. Lola Lawrence grins. Lola waves.", "Lola Lawrence", "Zorvan Lawrence"))
      .toBe("Her rival Lola Other waits. Zorvan Lawrence grins. Zorvan waves.");
    expect(renameGivenNameInProse("Her rival Namea Other waits.", "Namea Surnamea", "Nameb Surnamea")).toBe("Her rival Namea Other waits.");
  });
});

describe("ORW-437 re-check of #2775: own full name with a possessive, more relations, the May she grew up with", () => {
  const swap = (text: string, from: string) => renameGivenNameInProse(text, `${from} Surnamea`, "Nameb Surnamea");
  it("renames the card's own full name before a possessive and keeps another person's", () => {
    expect(renameGivenNameInProse("Lola Lawrence's sister agrees. Lola Lawrence\u2019s aunt too.", "Lola Lawrence", "Zorvan Lawrence"))
      .toBe("Zorvan Lawrence's sister agrees. Zorvan Lawrence\u2019s aunt too.");
    expect(renameGivenNameInProse("Lola Other's sister agrees.", "Lola Lawrence", "Zorvan Lawrence")).toBe("Lola Other's sister agrees.");
  });
  it("renames person uses after more relations and the determiner + month + pronoun", () => {
    expect(swap("She grew up in the care of Grace.", "Grace")).toBe("She grew up in the care of Nameb.");
    expect(swap("A niece of Rose waits.", "Rose")).toBe("A niece of Nameb waits.");
    expect(swap("An aunt of Mark waits.", "Mark")).toBe("An aunt of Nameb waits.");
    expect(swap("The May she grew up with left.", "May")).toBe("The Nameb she grew up with left.");
  });
  it("keeps months and common-word uses", () => {
    expect(swap("Born in June, she left.", "June")).toBe("Born in June, she left.");
    expect(swap("In May she moved.", "May")).toBe("In May she moved.");
    expect(swap("A Hope for the future.", "Hope")).toBe("A Hope for the future.");
    expect(swap("Free Will matters.", "Will")).toBe("Free Will matters.");
  });
});

describe("review of #2775: hyphenated relations and line breaks", () => {
  const swap = (text: string, from: string) => renameGivenNameInProse(text, `${from} Surnamea`, "Nameb Surnamea");
  it("a hyphenated relation before 'of' marks a person: 'mother-in-law of Grace'", () => {
    expect(swap("Her mother-in-law of Grace waits.", "Grace")).toBe("Her mother-in-law of Nameb waits.");
  });
  it("a capitalised word at the start of the NEXT line is not the surname of a given name that ends a line", () => {
    expect(swap("She was called Grace\nTuesday came.", "Grace")).toBe("She was called Nameb\nTuesday came.");
    expect(renameGivenNameInProse("Her rival Lola Other waits.", "Lola Lawrence", "Nameb Lawrence")).toBe("Her rival Lola Other waits.");
  });
});
