import { describe, it, expect } from "vitest";
import { chooseTellReaction, addExploit, decayExploit, TELL_REACTION, type ReactionInput } from "../../src/engine/tellReactions";

const base = (o: Partial<ReactionInput> = {}): ReactionInput => ({ tell: { kind: "withdrawn", band: "strong" }, bond: 0.8, style: "social", disposition: "bond", roll: 0.01, ...o });

describe("B29 chooseTellReaction (pure)", () => {
  it("only a visibly RATTLED tell invites a reaction (never giddy / warm-open / guarded / restless)", () => {
    for (const kind of ["giddy", "warm-open", "guarded", "restless"] as const) expect(chooseTellReaction(base({ tell: { kind, band: "strong" } }))).toBeNull();
    for (const kind of ["withdrawn", "tearful", "snapping", "brittle-calm"] as const) expect(chooseTellReaction(base({ tell: { kind, band: "strong" } }))).not.toBeNull();
  });
  it("a warm bond comforts; cunning without a warm bond exploits; a cold bond avoids a snapping tell; otherwise nothing", () => {
    expect(chooseTellReaction(base({ bond: 0.9 }))).toBe("comfort");
    expect(chooseTellReaction(base({ bond: 0.4, style: "strategic", disposition: "clash" }))).toBe("exploit");
    expect(chooseTellReaction(base({ bond: 0.1, style: "loyal", tell: { kind: "snapping", band: "strong" } }))).toBe("avoid");
    expect(chooseTellReaction(base({ bond: 0.1, style: "loyal", tell: { kind: "withdrawn", band: "strong" } }))).toBeNull();
    expect(chooseTellReaction(base({ bond: 0.5, style: "social" }))).toBe("comfort");
  });
  it("the observer's PERSONALITY, not the bond alone, decides: same cool bond, cunning exploits and tender comforts", () => {
    expect(chooseTellReaction(base({ bond: 0.5, style: "strategic", disposition: "neutral" }))).toBe("exploit");
    expect(chooseTellReaction(base({ bond: 0.5, style: "emotional", disposition: "neutral" }))).toBe("comfort");
  });
  it("seeded and band-scaled: a stronger tell is reacted to at a higher roll; monotone in the roll", () => {
    const at = (band: "faint" | "clear" | "strong", roll: number) => chooseTellReaction(base({ tell: { kind: "withdrawn", band }, roll }));
    expect(at("faint", 0.2)).toBeNull();
    expect(at("strong", 0.2)).toBe("comfort");
    expect(at("strong", TELL_REACTION.pByBand.strong)).toBeNull();
    let seen = false;
    for (let r = 0; r < 1; r += 0.01) { const x = at("clear", r); if (x) expect(seen).toBe(false); else seen = true; }
  });
  it("exploit tilt is bounded and decays to zero", () => {
    let t = 0;
    for (let i = 0; i < 20; i++) t = addExploit(t);
    expect(t).toBe(TELL_REACTION.exploitCap);
    for (let i = 0; i < 30; i++) t = decayExploit(t);
    expect(t).toBe(0);
  });
});
