import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { cleanOnCamera, cleanPhotoHair, cleanWardrobe, clipCodePoints, PHOTO_HAIR_MAX } from "../../src/domain/physicalCharacteristics";

// Review of #2716: a cap counted in UTF-16 code units can cut an emoji in half and store a lone surrogate.
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const bio = "A quiet organiser who reads a room before speaking up and keeps lists of everything the house does.";

describe("ORW-437 caps never split a surrogate pair", () => {
  it("clipCodePoints cuts whole characters", () => {
    const t = "a".repeat(299) + "\u{1F600}tail";
    const out = clipCodePoints(t, 300);
    expect(LONE.test(out)).toBe(false);
    expect(Array.from(out).length).toBe(300);
    expect(clipCodePoints("short", 300)).toBe("short");
  });
  it("the identity concept the writer records is capped by code points", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: 7 });
    const id = s.snapshot().house!.npcs[0]!.id;
    const res = s.recordCastProfile({ houseguestId: id, biography: bio, identityConcept: "a".repeat(299) + "\u{1F600}" + "tail" });
    expect(res.accepted).toBe(true);
    const stored = s.snapshot().house!.npcs[0]!.character.identityConcept!;
    expect(LONE.test(stored)).toBe(false);
    expect(Array.from(stored).length).toBeLessThanOrEqual(300);
  });
  it("the look lines are capped the same way", () => {
    expect(LONE.test(cleanPhotoHair("a".repeat(PHOTO_HAIR_MAX - 1) + "\u{1F600}x")!)).toBe(false);
    expect(LONE.test(cleanOnCamera("a".repeat(239) + "\u{1F600}x")!)).toBe(false);
    expect(cleanWardrobe(["a".repeat(59) + "\u{1F600}x", "dark jeans"])!.every((x) => !LONE.test(x))).toBe(true);
  });
});
