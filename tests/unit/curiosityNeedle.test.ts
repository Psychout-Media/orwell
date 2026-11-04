import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { curiosityNeedle, CURIOSITY_NEEDLES } from "../../src/engine/curiosityNeedle";

/**
 * FEATURE 0111, Pillar 2 (#909) — the curiosity needle is drawn ONLY from the fixed public pool. `curiosityNeedle(seed)` is a
 * pure, seed-only function: it has no parameter through which a Vault/soul/hidden value could reach it, so the BDD no longer
 * pretends to prove that by writing a sentinel the function cannot read (AMEND 0111 item 2). Roles only.
 */
describe("0111 curiosity needle — drawn only from the fixed public pool", () => {
  const SEEDS = [0, 1, 7, 11, 111, 4242, 99991, -5, 2 ** 31 - 1];

  it("every seed draws exactly one line, and that line is a member of the fixed public pool", () => {
    for (const seed of SEEDS) {
      const line = curiosityNeedle(seed);
      expect(typeof line).toBe("string");
      expect(CURIOSITY_NEEDLES).toContain(line);
    }
  });

  it("is deterministic per seed (a pure draw), and takes ONLY a seed (no channel for hidden state)", () => {
    for (const seed of SEEDS) expect(curiosityNeedle(seed)).toBe(curiosityNeedle(seed));
    expect(curiosityNeedle.length).toBe(1);
  });

  it("the pool is genuinely drawn from (different seeds reach more than one line), so 'from the pool' is not vacuous", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 200; seed++) seen.add(curiosityNeedle(seed));
    expect(seen.size).toBeGreaterThan(1);
    for (const line of seen) expect(CURIOSITY_NEEDLES).toContain(line);
  });

  it("no pool line names a raw houseguest id, a relationship number, or a specific secret", () => {
    expect(CURIOSITY_NEEDLES.length).toBeGreaterThan(1);
    for (const line of CURIOSITY_NEEDLES) {
      expect(line).not.toMatch(/npc:\d|\bplayer:/i);
      expect(line).not.toMatch(/\d\.\d/);
      expect(line.trim().length).toBeGreaterThan(20);
    }
  });

  it("the module is Vault-free by construction: it imports nothing but the seed hash", () => {
    const src = readFileSync(join(process.cwd(), "src/engine/curiosityNeedle.ts"), "utf8");
    const imports = [...src.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./characterFactory"]);
    expect(src).not.toMatch(/from "[^"]*(vault|soul|VaultStore)[^"]*"/i);
  });
});
