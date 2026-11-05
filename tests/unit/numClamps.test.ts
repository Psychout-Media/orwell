import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clamp01, clamp01Raw } from "../../src/domain/num";
import { clamp01 as viaRelationshipConstants } from "../../src/engine/relationshipConstants";

/** B47 - the shared clamps keep EXACTLY the two behaviours the local copies had, and no new local copy creeps back. */
describe("src/domain/num clamps", () => {
  it("clamp01 is the NaN-guarded form", () => {
    expect([clamp01(-3), clamp01(0), clamp01(0.4), clamp01(1), clamp01(7)]).toEqual([0, 0, 0.4, 1, 1]);
    expect(clamp01(Number.NaN)).toBe(0);
    expect([clamp01(Infinity), clamp01(-Infinity)]).toEqual([1, 0]);
  });
  it("clamp01Raw has NO NaN guard (a NaN stays NaN, as the bare Math.max/min copies did)", () => {
    expect([clamp01Raw(-3), clamp01Raw(0.4), clamp01Raw(7)]).toEqual([0, 0.4, 1]);
    expect(Number.isNaN(clamp01Raw(Number.NaN))).toBe(true);
  });
  it("relationshipConstants re-exports the same function (every existing import keeps working)", () => {
    expect(viaRelationshipConstants).toBe(clamp01);
  });
  it("no engine/domain/adapter file declares its own clamp01 except the documented holdouts", () => {
    const HOLDOUTS = new Set(["liveSeason.ts", "beliefStore.ts", "dealConsent.ts", "npcMemory.ts", "tells.ts", "voteEstimate.ts"]); // other work in flight; convert after it lands
    const walk = (d: string, out: string[] = []): string[] => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p, out) : p.endsWith(".ts") && out.push(p); } return out; };
    const offenders = walk("src").filter((f) => /^\s*(?:export )?const clamp01 = /m.test(readFileSync(f, "utf8")) && !f.endsWith("domain/num.ts") && !HOLDOUTS.has(f.split("/").pop()!));
    expect(offenders, "use src/domain/num instead of a local clamp01").toEqual([]);
  });
});

import { clamp, fnv1a } from "../../src/domain/num";
describe("src/domain/num clamp + fnv1a (B47)", () => {
  it("clamp is the bare form: finite clamps, NaN stays NaN", () => {
    expect([clamp(-5, 0, 10), clamp(5, 0, 10), clamp(50, 0, 10), clamp(2, 3, 3)]).toEqual([0, 5, 10, 3]);
    expect(Number.isNaN(clamp(Number.NaN, 0, 1))).toBe(true);
  });
  it("fnv1a equals BOTH former implementations bit for bit (per-step >>>0 and end-only >>>0)", () => {
    const perStep = (s: string): number => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
    const endOnly = (s: string): number => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
    for (const s of ["", "a", "npc:7|archetype", "0|npc:12|forgiveness", "id|style anchor", "héllo ✓", "x".repeat(500)]) {
      expect(fnv1a(s)).toBe(perStep(s));
      expect(fnv1a(s)).toBe(endOnly(s));
    }
    expect(fnv1a("a")).toBe(0xe40c292c); // the published FNV-1a 32-bit test vector
  });
});
