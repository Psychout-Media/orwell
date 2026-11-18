import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { STYLE_FAMILY_LABELS } from "../../src/domain/styleFamilies";

// ORW-563: the cast gate re-picks a strong-outlier look. The engine takes the new style family LABEL through recordCastProfile only when it is a
// known family no other houseguest holds; nothing else about the card moves.
describe("ORW-563 recordCastProfile takes a re-picked style family", () => {
  const setup = () => {
    const s = new GameSessionAdapter();
    const house = s.preSeedCast({ seed: 21 }).house; // pre-game: nobody has been introduced yet
    return { s, a: house[0]!, b: house[1]! };
  };

  it("stores a known, free label and reports it as a public field", () => {
    const { s, a, b } = setup();
    const taken = new Set(s.preSeedCast({ seed: 21 }).house.map((h) => h.presentation));
    const free = STYLE_FAMILY_LABELS.find((l) => !taken.has(l))!;
    const res = s.recordCastProfile({ houseguestId: a.id, presentation: free });
    expect(res.accepted).toBe(true);
    expect(res.publicFields).toContain("presentation");
    const after = s.preSeedCast({ seed: 21 }).house;
    expect(after.find((h) => h.id === a.id)!.presentation).toBe(free);
    expect(after.find((h) => h.id === b.id)!.presentation).toBe(b.presentation);
  });

  it("ignores an unknown label and a label another houseguest already holds", () => {
    const { s, a, b } = setup();
    for (const bad of ["not a family at all", b.presentation!]) {
      const res = s.recordCastProfile({ houseguestId: a.id, presentation: bad });
      expect(res.publicFields).not.toContain("presentation");
      expect(s.preSeedCast({ seed: 21 }).house.find((h) => h.id === a.id)!.presentation).toBe(a.presentation);
    }
  });
});
