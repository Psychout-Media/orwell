import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { dispositionOf } from "../../src/engine/characterFactory";
import { derivedLoyalty } from "../../src/engine/blocs";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";

/**
 * ORW-33 (B32, ORWELL_DRIFT_FIX): a repeatedly BETRAYED houseguest ends the season hardened (effective disposition clash) where a same-seed CONTROL that was not betrayed keeps its baseline, and the
 * hardening changes what they DO: their derived loyalty (what the lobbying / assurance / bloc decisions read) is lower and their relationship folds run on the clash profile. The scene pattern interleaves
 * kindness (the pattern that cancelled the drift before the negativity bias): without the bias the same scenes do NOT harden. Roles only.
 */
type Internals = {
  soulObj(id: EntityId): { temperamentDrift?: number; emotionalState: number } | undefined;
  rememberPlayerScene(h: readonly EntityId[], k: string): void;
  setDriftFixEnabled(on: boolean): void;
  dispositionReadOf(id: EntityId): "clash" | "bond" | "neutral";
  emotionalReadOf(id: EntityId): number;
  house?: { npcs: Array<{ id: EntityId; character: { archetype: string } }> };
};
const PATTERN = ["betrayal", "bonding", "bonding", "betrayal", "bonding", "bonding", "betrayal"] as const;
function game(on: boolean, seed = 7) {
  const sb = new GameSessionRegistry().sandboxFor(`orw33-${Math.random()}`);
  sb.session.createCharacter({ playerName: "P", archetype: "floater", seed });
  const s = sb.session as unknown as Internals;
  s.setDriftFixEnabled(on);
  const neutral = (s.house?.npcs ?? []).find((n) => dispositionOf(n.character.archetype as never) === "neutral" && n.id !== PLAYER)!;
  return { s, who: neutral.id };
}

describe("a repeatedly betrayed houseguest hardens and acts differently (ORW-33)", () => {
  it("betrayed vs same-seed control: clash vs neutral, lower derived loyalty, harsher fold profile", () => {
    const betrayed = game(true), control = game(true);
    expect(betrayed.who).toBe(control.who);
    for (const k of PATTERN) betrayed.s.rememberPlayerScene([betrayed.who], k);
    expect(betrayed.s.dispositionReadOf(betrayed.who)).toBe("clash");
    expect(control.s.dispositionReadOf(control.who)).toBe("neutral");
    const lb = derivedLoyalty(betrayed.s.dispositionReadOf(betrayed.who), betrayed.s.emotionalReadOf(betrayed.who));
    const lc = derivedLoyalty(control.s.dispositionReadOf(control.who), control.s.emotionalReadOf(control.who));
    expect(lb, "a hardened houseguest is less loyal").toBeLessThan(lc);
    expect(RELATIONSHIP_CONSTANTS.dispositionFactors.clash.adverseScale).toBeGreaterThan(RELATIONSHIP_CONSTANTS.dispositionFactors.neutral.adverseScale);
  });
  it("the negativity bias is what makes the interleaved pattern harden (fix OFF: the kindness cancels it)", () => {
    const off = game(false);
    for (const k of PATTERN) off.s.rememberPlayerScene([off.who], k);
    expect(off.s.dispositionReadOf(off.who)).not.toBe("clash");
  });
  it("hardens on every seed tried (not a single-seed fluke)", () => {
    for (const seed of [1, 2, 3, 4]) {
      const g = game(true, seed);
      for (const k of PATTERN) g.s.rememberPlayerScene([g.who], k);
      expect(g.s.dispositionReadOf(g.who), `seed ${seed}`).toBe("clash");
    }
  });
});
