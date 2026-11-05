import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NOMINATION_STYLE_BY_ARCHETYPE } from "../../src/engine/decisionConstants";
import { defaultPhilosophyOf, drawPhilosophy, styleOfPhilosophy } from "../../src/engine/philosophy";
import { PHILOSOPHIES, PHILOSOPHY_DRAW, DEFAULT_PHILOSOPHY_BY_ARCHETYPE } from "../../src/engine/philosophyConstants";

/**
 * B40 (design S4, pure only) - the default mapping archetype -> philosophy -> style IS today's NOMINATION_STYLE_BY_ARCHETYPE (so wiring it later is byte-identical for the default draw); the draw is a
 * deterministic function of (archetype, seed) conditioned on the archetype; and nothing in the engine calls it yet. Roles only.
 */
describe("the default mapping reproduces today's nomination styles", () => {
  it("every known archetype: style(default philosophy) == NOMINATION_STYLE_BY_ARCHETYPE[archetype]", () => {
    for (const [arch, style] of Object.entries(NOMINATION_STYLE_BY_ARCHETYPE)) expect(styleOfPhilosophy(defaultPhilosophyOf(arch)), arch).toBe(style);
  });
  it("the philosophy table covers exactly the archetypes the style table covers; an unknown archetype reads as today's threat-hunter fallback", () => {
    expect(Object.keys(DEFAULT_PHILOSOPHY_BY_ARCHETYPE).sort()).toEqual(Object.keys(NOMINATION_STYLE_BY_ARCHETYPE).sort());
    expect(styleOfPhilosophy(defaultPhilosophyOf("no-such-archetype"))).toBe("threat-hunter");
  });
});

describe("the seeded draw", () => {
  it("is deterministic in (archetype, seed) and always a known philosophy", () => {
    for (let s = 0; s < 200; s++) {
      const a = drawPhilosophy("mastermind", s);
      expect(drawPhilosophy("mastermind", s)).toBe(a);
      expect(PHILOSOPHIES).toContain(a);
    }
  });
  it("is conditioned on the archetype: the default share is ~keepDefault, and the rest are OTHER philosophies", () => {
    const N = 4000;
    for (const arch of ["mastermind", "comp-beast", "peacemaker"]) {
      const def = defaultPhilosophyOf(arch);
      let kept = 0; const seen = new Set<string>();
      for (let s = 1; s <= N; s++) { const p = drawPhilosophy(arch, s); if (p === def) kept++; else seen.add(p); }
      expect(kept / N, arch).toBeGreaterThan(PHILOSOPHY_DRAW.keepDefault - 0.04);
      expect(kept / N, arch).toBeLessThan(PHILOSOPHY_DRAW.keepDefault + 0.04);
      expect(seen.size, `${arch}: every other philosophy occurs`).toBe(PHILOSOPHIES.length - 1);
    }
  });
  it("two archetypes drawn with the SAME seed are independent (they do not all keep, or all deviate, together)", () => {
    let agree = 0, both = 0;
    for (let s = 1; s <= 3000; s++) {
      const a = drawPhilosophy("mastermind", s) === defaultPhilosophyOf("mastermind"), b = drawPhilosophy("comp-beast", s) === defaultPhilosophyOf("comp-beast");
      if (a === b) agree++; if (!a && !b) both++;
    }
    // independent keep-default draws agree ~ p^2 + (1-p)^2 = 0.625; fully correlated would be 1.0
    expect(agree / 3000).toBeLessThan(0.7);
    expect(both).toBeGreaterThan(0);
  });
  it("different archetypes with the same seed can differ (it is not a constant)", () => {
    let differ = 0;
    for (let s = 1; s <= 100; s++) if (drawPhilosophy("mastermind", s) !== drawPhilosophy("comp-beast", s)) differ++;
    expect(differ).toBeGreaterThan(20);
  });
});

describe("pure only: nothing in src calls it yet", () => {
  const files = (d: string, out: string[] = []): string[] => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) files(p, out); else if (p.endsWith(".ts")) out.push(p); } return out; };
  // Any import/export-from or dynamic import whose specifier ENDS in /philosophy or /philosophyConstants (any depth: ./x, ../engine/x, ../../engine/x).
  const IMPORT = /(?:from|import)\s*\(?\s*["'][^"']*\/philosophy(?:Constants)?["']/;
  const users = (): string[] => files("src").filter((f) => !/\/philosophy(Constants)?\.ts$/.test(f)).filter((f) => IMPORT.test(readFileSync(f, "utf8")));
  it("no src file other than the philosophy modules imports them", () => { expect(users()).toEqual([]); });
  it("the pin recognises every import shape (a mutant that wires it from an adapter would be caught)", () => {
    for (const line of ['import { x } from "../engine/philosophy";', "import { x } from '../../engine/philosophyConstants';", 'import { x } from "./philosophy";', 'import("../engine/philosophy");', 'export * from "../engine/philosophy";']) expect(IMPORT.test(line), line).toBe(true);
    for (const line of ['import { x } from "../engine/philosophyOther";', 'import { x } from "../engine/notphilosophy2";']) expect(IMPORT.test(line), line).toBe(false);
  });
});
