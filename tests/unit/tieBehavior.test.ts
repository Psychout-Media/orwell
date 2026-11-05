import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TIE_BEHAVIOR, TIE_BEHAVIOR_LIMITS, oldFriendShield, type TieBehavior } from "../../src/engine/tieBehavior";
import { TIE_NATURES } from "../../src/engine/seededRelationships";

/**
 * B41 (design S5, pure only) - per-nature DECISION terms: family shields, rival pushes, ex is ambivalent (scene awkwardness only), old-friend is loyal until pressure flips them, the rest are flavour-only
 * (all zero). Ties NEVER carry a competition term, every term is bounded, and nothing in src calls the table yet. Roles only.
 */
describe("TIE_BEHAVIOR", () => {
  it("covers every tie nature exactly", () => {
    expect(Object.keys(TIE_BEHAVIOR).sort()).toEqual([...TIE_NATURES].sort());
  });
  it("family shields (negative nomination + vote push), rival pushes (positive), ex only adds scene awkwardness, old-friend shields mildly and can flip", () => {
    expect(TIE_BEHAVIOR.family.nominationPush).toBeLessThan(0); expect(TIE_BEHAVIOR.family.votePush).toBeLessThan(0);
    expect(TIE_BEHAVIOR.rival.nominationPush).toBeGreaterThan(0); expect(TIE_BEHAVIOR.rival.votePush).toBeGreaterThan(0);
    expect(TIE_BEHAVIOR.ex).toMatchObject({ nominationPush: 0, votePush: 0 }); expect(TIE_BEHAVIOR.ex.sceneAwkwardness).toBeGreaterThan(0);
    expect(TIE_BEHAVIOR["old-friend"].nominationPush).toBeLessThan(0); expect(TIE_BEHAVIOR["old-friend"].pressureFlipAt).toBeGreaterThan(0);
  });
  it("every other nature is flavour-only: all zero (today's calibration-neutral state)", () => {
    for (const n of TIE_NATURES) if (!["family", "rival", "ex", "old-friend"].includes(n)) expect(TIE_BEHAVIOR[n], n).toEqual({ nominationPush: 0, votePush: 0, sceneAwkwardness: 0, pressureFlipAt: 0 });
  });
  it("every term is within its declared bound", () => {
    for (const n of TIE_NATURES) {
      const b = TIE_BEHAVIOR[n];
      expect(Math.abs(b.nominationPush), n).toBeLessThanOrEqual(TIE_BEHAVIOR_LIMITS.nominationPush);
      expect(Math.abs(b.votePush), n).toBeLessThanOrEqual(TIE_BEHAVIOR_LIMITS.votePush);
      expect(b.sceneAwkwardness, n).toBeGreaterThanOrEqual(0); expect(b.sceneAwkwardness, n).toBeLessThanOrEqual(TIE_BEHAVIOR_LIMITS.sceneAwkwardness);
      expect(b.pressureFlipAt, n).toBeLessThanOrEqual(TIE_BEHAVIOR_LIMITS.maxPressureFlip);
    }
  });
  it("ties never change competition odds: the behaviour has no competition field, and the module touches no competition code", () => {
    const keys = new Set<string>(); for (const n of TIE_NATURES) for (const k of Object.keys(TIE_BEHAVIOR[n])) keys.add(k);
    expect([...keys].sort()).toEqual(["nominationPush", "pressureFlipAt", "sceneAwkwardness", "votePush"]);
    expect([...keys].some((k) => /comp|stat|physical|mental|social|odds|win/i.test(k))).toBe(false);
    const src = readFileSync("src/engine/tieBehavior.ts", "utf8");
    expect(/import[^;]*(competition|resolveCompetition|temperature)/i.test(src)).toBe(false);
  });
  it("oldFriendShield: loyal below the flip point, gone at/after it, and monotone in pressure", () => {
    const base = TIE_BEHAVIOR["old-friend"].nominationPush, at = TIE_BEHAVIOR["old-friend"].pressureFlipAt;
    expect(oldFriendShield(base, 0, at)).toBe(base);
    expect(oldFriendShield(base, at - 1, at)).toBe(base);
    expect(oldFriendShield(base, at, at)).toBe(0);
    expect(oldFriendShield(base, at + 5, at)).toBe(0);
    expect(oldFriendShield(-0.3, 99, 0)).toBe(-0.3); // pressureFlipAt 0 = never flips
  });
});

describe("pure only: nothing in src calls it yet", () => {
  const files = (d: string, out: string[] = []): string[] => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) files(p, out); else if (p.endsWith(".ts")) out.push(p); } return out; };
  it("no src file other than the module imports it", () => {
    const users = files("src").filter((f) => !f.endsWith("/tieBehavior.ts")).filter((f) => /from ["'][./]*\/?(?:\.\/)?tieBehavior["']/.test(readFileSync(f, "utf8")));
    expect(users).toEqual([]);
  });
  it("the type has only decision terms", () => {
    const sample: TieBehavior = { nominationPush: 0, votePush: 0, sceneAwkwardness: 0, pressureFlipAt: 0 };
    expect(Object.keys(sample)).toHaveLength(4);
  });
});
