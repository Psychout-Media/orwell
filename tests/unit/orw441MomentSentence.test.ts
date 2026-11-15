import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildPortraitPrompt } from "../../src/engine/portraitPrompts";

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
      expect(sentence, l.onCamera).toMatch(/^(?:He|She|They|His|Her|Their) |[,;.\u2014] (?:he|she|they|his|her|their) [a-z]+/i);
    }
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
