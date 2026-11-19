import { describe, it, expect } from "vitest";
import { castingStatusOf, emptyIntake, mergeCastingUpdate } from "../../src/engine/castingIntake";
import { renderGameContext } from "../../src/engine/momentPrompts";

// Casting pronoun ask: the producer asks once while none are on file; a recorded answer or skip ends the ask.
const ctx = (status: ReturnType<typeof castingStatusOf>) =>
  renderGameContext({ started: false, player: null, house: [], casting: status } as any);

describe("casting pronoun ask", () => {
  it("fresh interview: the board fact asks once; flag-off carries no ask", () => {
    const st = castingStatusOf(mergeCastingUpdate(emptyIntake(), { playerName: "x" }), [], { askPronouns: true });
    expect(st.askPronouns).toBe(true);
    expect(ctx(st)).toContain("PRONOUNS: not on file");
    const off = castingStatusOf(mergeCastingUpdate(emptyIntake(), { playerName: "x" }));
    expect(off.askPronouns).toBeUndefined();
    expect(ctx(off)).not.toContain("PRONOUNS: not on file");
  });

  it("a stated answer becomes the PRONOUN LOCK and the ask is gone", () => {
    const i = mergeCastingUpdate(emptyIntake(), { playerName: "x", genderPresentation: "nonbinary" });
    const text = ctx(castingStatusOf(i, [], { askPronouns: true }));
    expect(text).toContain("PRONOUN LOCK: the player uses they/them.");
    expect(text).not.toContain("PRONOUNS: not on file");
  });

  it("a skip is recorded as unstated: no more ask, still address as you", () => {
    const i = mergeCastingUpdate(emptyIntake(), { playerName: "x", genderPresentation: "unstated" });
    const st = castingStatusOf(i, [], { askPronouns: true });
    expect(st.askPronouns).toBeUndefined();
    const text = ctx(st);
    expect(text).not.toContain("PRONOUNS: not on file");
    expect(text).toContain("The player's gender is unstated");
  });
});
