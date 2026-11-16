import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildPortraitPrompt, pluralVerb } from "../../src/engine/portraitPrompts";

// Review of #2781: the new on-camera openings (spot, hands, gaze, expression) must reach the image prompt as a sentence with a
// subject, and the card's own first name must never reach the image provider. Lines are the 28 live ones (names tokenised).
const LINES = JSON.parse(readFileSync(new URL("../fixtures/orw441_oncamera_lines.json", import.meta.url), "utf8")) as { gender: "man" | "woman" | "nonbinary"; onCamera: string }[];
const moment = (gender: string, cam: string, name = "Namea Surnamea"): string => {
  const p = buildPortraitPrompt("hg:7", name, { age: 30, genderPresentation: gender, presentation: "plain",
    physicalCharacteristics: { heightBuild: "average", skinTone: "fair", hair: "short hair", facialFeatures: "square jaw", distinguishingMark: "none notable", ageLook: "thirties", style: "plain", wardrobe: ["grey tee", "dark jeans"], onCamera: cam } } as never, "anchor").prompt;
  const i = p.indexOf("Setting:");
  const before = p.slice(0, i);
  return before.slice(before.indexOf("Wearing"));
};

describe("ORW-441 momentSentence", () => {
  it("every one of the 28 live lines becomes a sentence with a subject and no first name", () => {
    expect(LINES.length).toBe(28);
    for (const l of LINES) {
      const m = moment(l.gender, l.onCamera);
      expect(m, l.onCamera).not.toMatch(/Namea/);
      // the moment sentence is the last one before the Setting line
      const sentence = m.split(/\.\s+/).filter((x) => x !== "").pop()!;
      expect(sentence, l.onCamera).toMatch(/^(?:He|She|They|His|Her|Their) |[,;.\u2014] (?:he|she|they) [a-z]+|[,;.\u2014] (?:his|her|their) [a-z]+ (?:[a-z]+s|is|are|was|were|has|have|stay|rest|stand)\b/i);
      // review of #2781: the authored details themselves reach the prompt (a generic subject-bearing sentence would not pass this)
      const norm = (x: string): string => x.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
      const tail = norm(l.onCamera).split(" ").slice(-4).join(" ");
      expect(norm(m), l.onCamera).toContain(tail);
    }
  });
  it("review of #2781: a possessive noun phrase is not a subject: 'hands loose in his pockets' still gets 'He is photographed with'", () => {
    const m = moment("man", "Gaze level and unhurried from the backyard, hands loose in his pockets, a small private smile.");
    expect(m).toContain("He is photographed with gaze level");
  });
  it("fragments get a subject, names become pronouns", () => {
    expect(moment("woman", "Gaze straight into the lens from the living room sofa, the one who keeps score.")).toContain("She is photographed with gaze straight into the lens");
    expect(moment("man", "Hands loose at his sides in the backyard, chin lifted.")).toContain("He is photographed with hands loose at his sides");
    expect(moment("woman", "With a knowing half-smile, Namea stands in the backyard, hands in her vest pockets.")).toContain("With a knowing half-smile, she stands in the backyard");
    expect(moment("woman", "Namea's gaze stays level, one hand on a mug in the kitchen.")).toContain("Her gaze stays level");
    expect(moment("woman", "Backyard, perched on the arm of a patio chair.")).toContain("She is in the backyard, perched");
  });
  it("lines that already worked are unchanged", () => {
    expect(moment("man", "He leans on the counter in the kitchen.")).toContain("He leans on the counter in the kitchen.");
    expect(moment("man", "Leaning on the counter in the kitchen.")).toContain("He is leaning on the counter in the kitchen.");
  });
});

describe("ORW-441 a they/them card: the verb after the pronoun agrees (review of #2781)", () => {
  const nb = (cam: string): string => moment("nonbinary", cam);
  it("the live nonbinary line and five more conjugate or fall back safely", () => {
    expect(nb("Namea stands in the kitchen, one hand flat on the counter, the one who misses nothing.")).toContain("They stand in the kitchen");
    expect(nb("With a slow grin, Namea leans on the counter in the kitchen.")).toContain("they lean on the counter");
    expect(nb("Namea is in the backyard, hands in pockets.")).toContain("They are in the backyard");
    expect(nb("Namea quietly watches the room from the lounge, chin lifted.")).toContain("They quietly watch the room");
    expect(nb("Namea carries a mug into the kitchen, gaze level.")).toContain("They carry a mug");
    expect(nb("Namea has a mug in hand at the kitchen island.")).toContain("They have a mug");
    expect(nb("Namea's gaze stays level, one hand on a mug in the kitchen.")).toContain("Their gaze stays level");
  });
  it("falls back to 'the houseguest' when the verb cannot be conjugated safely", () => {
    const t = nb("Namea, arms folded, in the kitchen, gaze level on the lens.");
    expect(t).not.toMatch(/\bThey (?:is|stands|grins|leans)\b/);
    const u = nb("Namea sat at the kitchen island, chin lifted.");
    expect(u).toContain("The houseguest sat at the kitchen island");
  });
  it("he and she cards are unchanged by the plural handling", () => {
    expect(moment("man", "Namea stands in the kitchen, arms folded.")).toContain("He stands in the kitchen");
    expect(moment("woman", "With a grin, Namea leans on the counter in the kitchen.")).toContain("she leans on the counter");
  });
});

describe("ORW-441 they/them guard: -s adverbs and a comma after the name (follow-up)", () => {
  const nb = (cam: string): string => moment("nonbinary", cam);
  it("an adverb ending in -s keeps its s and the verb after it is conjugated", () => {
    expect(nb("Namea always stands in the kitchen, arms folded.")).toContain("They always stand in the kitchen");
    expect(nb("Namea sometimes leans on the counter in the kitchen.")).toContain("They sometimes lean on the counter");
    expect(nb("Namea perhaps grins in the lounge.")).toContain("They perhaps grin in the lounge");
    expect(nb("Namea nevertheless stands in the lounge.")).toContain("The houseguest nevertheless stands in the lounge");
  });
  it("a comma straight after the name uses 'The houseguest' (the verb is not next)", () => {
    expect(nb("Namea, arms folded, stands in the lounge.")).toContain("The houseguest, arms folded, stands in the lounge");
    expect(nb("Hands loose, Namea, arms folded, stands in the lounge.")).toContain("the houseguest, arms folded, stands");
  });
});

describe("review of #2781: name scrub and conjugation edge cases", () => {
  const nb = (cam: string): string => moment("nonbinary", cam);
  it("a case-variant of the card's own name never reaches the prompt", () => {
    expect(moment("woman", "namea stands in the kitchen, chin lifted.")).not.toMatch(/namea/i);
    expect(moment("woman", "NAMEA stands in the kitchen, chin lifted.")).not.toMatch(/namea/i);
  });
  it("an everyday-word given name keeps its case rule: 'may' the verb is untouched", () => {
    expect(moment("woman", "She may lean on the counter while May stands by the door.", "May Surnamea")).toContain("She may lean on the counter while she stands by the door");
  });
  it("the name after a verb or preposition becomes 'the houseguest', never a subject pronoun", () => {
    const m = moment("woman", "In the kitchen, the camera catches Namea by the counter, chin lifted.");
    expect(m).toContain("catches the houseguest by the counter");
    expect(m).not.toContain("catches she");
    expect(nb("In the kitchen, the camera catches Namea by the counter, chin lifted.")).toContain("catches the houseguest");
  });
  it("lies, ties, dies, vies conjugate to lie, tie, die, vie; -uses verbs fall back to 'the houseguest'", () => {
    expect(pluralVerb("lies")).toBe("lie"); expect(pluralVerb("ties")).toBe("tie"); expect(pluralVerb("dies")).toBe("die"); expect(pluralVerb("vies")).toBe("vie");
    expect(pluralVerb("tries")).toBe("try");
    expect(nb("Namea lies back on the sofa, hands folded.")).toContain("They lie back");
    expect(nb("Namea focuses on the lens from the kitchen, chin lifted.")).toContain("The houseguest focuses");
    expect(nb("Namea focuses on the lens from the kitchen, chin lifted.")).not.toMatch(/focuse\b/);
  });
});
