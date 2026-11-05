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
