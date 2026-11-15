import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { holdScore, forgivenessTraitFor, applyForgiveness } from "../../src/engine/forgiveness";
import { FORGIVENESS } from "../../src/engine/forgivenessConstants";
import type { MemoryEntry } from "../../src/engine/npcMemory";

/**
 * ORW-130 (Ryne, 2026-11-06): forgiveness depends on the houseguest and the relationship, not on random odds. The same betrayal is forgiven by some holders and held by others for READABLE reasons; it is
 * a pure function of state (no randomness), engine-only (the module imports nothing but the memory types and its constants). Roles only; the rule is ASSUMED pending Ryne (see forgivenessConstants.ts).
 */
const betray = (severity = 0.7, week = 1): MemoryEntry => ({ kind: "scene-betrayal", week, severity });
const favor = (severity = 0.8): MemoryEntry => ({ kind: "scene-kindness", week: 1, severity });
const who = (style: string, volatility = 0.5, closeness = 0.3) => ({ style, volatility, closeness });

describe("the same betrayal, different holders", () => {
  it("a hard-edged player holds the grudge; a warm one forgives, for the temperament alone", () => {
    const e = [betray(0.8)];
    expect(forgivenessTraitFor(e, who("aggressive"))).toBe("grudge-keeper");
    expect(forgivenessTraitFor(e, who("social"))).toBe("typical");
    expect(holdScore(e, who("aggressive"))).toBeGreaterThan(holdScore(e, who("loyal")));
  });
  it("a volatile temperament holds on harder than a settled one", () => {
    const e = [betray(0.6)];
    expect(holdScore(e, who("emotional", 0.95))).toBeGreaterThan(holdScore(e, who("emotional", 0.05)));
  });
});

describe("the relationship and the record", () => {
  it("a worse betrayal is harder to forgive", () => {
    expect(holdScore([betray(0.9)], who("strategic"))).toBeGreaterThan(holdScore([betray(0.3)], who("strategic")));
  });
  it("a repeat betrayal is a pattern: less forgiveness; a history of favors: more", () => {
    const one = holdScore([betray()], who("emotional"));
    expect(holdScore([betray(), betray(), betray()], who("emotional"))).toBeGreaterThan(one);
    expect(holdScore([betray(), favor()], who("emotional"))).toBeLessThan(one);
  });
  it("a close friend's betrayal cuts DEEPER for a hard-edged player and is forgiven EASIER by a warm one", () => {
    const e = [betray()];
    expect(holdScore(e, who("aggressive", 0.5, 0.9))).toBeGreaterThan(holdScore(e, who("aggressive", 0.5, 0.1)));
    expect(holdScore(e, who("social", 0.5, 0.9))).toBeLessThan(holdScore(e, who("social", 0.5, 0.1)));
  });
  it("no betrayal on record => nothing to hold", () => {
    expect(holdScore([favor()], who("aggressive", 1, 1))).toBe(0);
    expect(holdScore(undefined, who("aggressive"))).toBe(0);
  });
});

describe("determinism, purity and bounds", () => {
  it("is a pure function of state: identical inputs, identical result, no entry mutated", () => {
    const e = [betray(), favor()]; const copy = JSON.stringify(e);
    expect(holdScore(e, who("strategic", 0.4, 0.6))).toBe(holdScore(e, who("strategic", 0.4, 0.6)));
    applyForgiveness(e, forgivenessTraitFor(e, who("strategic")), 20);
    expect(JSON.stringify(e)).toBe(copy);
  });
  it("garbage inputs are bounded (NaN volatility/closeness read as 0)", () => {
    expect(Number.isFinite(holdScore([betray()], { style: "aggressive", volatility: NaN, closeness: NaN }))).toBe(true);
  });
  it("import-pin: the module stays pure (only the memory types and its constants)", () => {
    const src = readFileSync("src/engine/forgiveness.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./forgivenessConstants", "./npcMemory"]);
    expect(src).not.toMatch(/Math\.random|SeededRandom|rng/);
    expect(FORGIVENESS.holdAt).toBeGreaterThan(0);
  });
});
