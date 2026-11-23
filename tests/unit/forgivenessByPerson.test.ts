import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { holdScore, forgivenessTraitFor, applyForgiveness } from "../../src/engine/forgiveness";
import { FORGIVENESS } from "../../src/engine/forgivenessConstants";
import type { MemoryEntry } from "../../src/engine/npcMemory";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

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

/**
 * ORW-507 (retro review of ORW-130): the helpers above are fed `style`/`volatility`/`closeness` directly, so they cannot catch the SESSION reading the wrong trait or the wrong relationship. Here the
 * session's inputs are controlled (the holder's style, their soul volatility, and the bond to each of two subjects) and the tilt it actually reads is asserted per pair.
 */
type Rig = {
  memoryTiltFor(subject: string, holder: string): number;
  setForgivenessEnabled(on: boolean): void;
  rel: { bondStrength(a: string, b: string): number };
  house: { npcs: { id: string; character: { strategyStyle?: string } }[] };
  soulObj(id: string): { volatility: number } | undefined;
  live: { week: number; npcMemory?: Record<string, Record<string, MemoryEntry[]>> };
};
describe("unit, state set by hand (style, soul and bonds are stubbed; the REAL PATH is tests/realpath/forgivenessByPerson.test.ts, ORW-811): the holder's traits and the bond to EACH subject decide the read", () => {
  function rig(style: string, volatility: number, bonds: { close: number; far: number }) {
    const sb = new GameSessionRegistry().sandboxFor(`forg-person-${style}-${volatility}`);
    sb.session.createCharacter({ playerName: "P", seed: 7 });
    sb.session.advanceGame(); sb.session.advanceGame();
    const g = sb.session as unknown as Rig;
    const [holder, close, far] = sb.session.livingIds().filter((i) => i !== PLAYER);
    g.house.npcs.find((n) => n.id === holder)!.character.strategyStyle = style;
    g.soulObj = () => ({ volatility });
    g.rel = Object.assign(Object.create(Object.getPrototypeOf(g.rel)), g.rel, { bondStrength: (_a: string, b: string) => (b === close ? bonds.close : b === far ? bonds.far : 0.5) }) as Rig["rel"]; // keeps the prototype methods
    g.live.week = 30;
    const record = (): MemoryEntry[] => [{ kind: "scene-betrayal", week: 1, severity: 0.4 }];
    g.live.npcMemory = { [holder!]: { [close!]: record(), [far!]: record() } };
    const tilts = (on: boolean) => { g.setForgivenessEnabled(on); return { close: g.memoryTiltFor(close!, holder!), far: g.memoryTiltFor(far!, holder!) }; };
    return { off: tilts(false), on: tilts(true) };
  }
  it("a hard-edged-ish holder keeps the grudge against the close friend only; the layer off reads both alike", () => {
    const { off, on } = rig("emotional", 0.5, { close: 0.9, far: 0.1 });
    expect(off.close).toBeCloseTo(off.far, 12);
    expect(on.close, "the held grudge still tilts").toBeGreaterThan(on.far + 1e-6);
    expect(on.far, "the far subject's old betrayal has faded").toBeLessThanOrEqual(off.far + 1e-12);
  });
  it("a warm holder forgives the close friend too (the style term and the closeness sign are read)", () => {
    const { on } = rig("social", 0.5, { close: 0.9, far: 0.1 });
    expect(on.close).toBeCloseTo(on.far, 12);
  });
  it("volatility is read from the holder's soul: the same record holds against a volatile holder and fades for a settled one", () => {
    const volatile = rig("emotional", 1, { close: 0.1, far: 0.1 });
    const settled = rig("emotional", 0, { close: 0.1, far: 0.1 });
    expect(volatile.on.far).toBeGreaterThan(settled.on.far + 1e-6);
  });
});
