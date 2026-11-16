import { describe, it, expect } from "vitest";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { dealMarksSpread, dealCastPhysicalSpread, MAX_PER_MARK } from "../../src/engine/deepProfile";
import { tagKind } from "../../src/domain/castRealism";

// ORW-480 (Kevin: "so many people with tooth gaps"): a mark is a signature; no single mark may turn up in most seasons.
describe("ORW-480 mark and face recurrence over 200 seeded casts", () => {
  const casts = Array.from({ length: 200 }, (_, s) => dealMarksSpread(new SeededRandom(1000 + s), 15, MAX_PER_MARK));
  it("about 3 or 4 of 15 carry a mark and no single mark is in more than about one cast in seven", () => {
    const named = casts.map((c) => c.filter((m) => !/^none/i.test(m)));
    for (const n of named) expect(n.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...named.map((n) => n.length))).toBeLessThanOrEqual(5);
    const perMark = new Map<string, number>();
    for (const n of named) for (const m of new Set(n)) perMark.set(m, (perMark.get(m) ?? 0) + 1);
    expect(perMark.size).toBeGreaterThanOrEqual(40); // the whole pool is reachable
    expect(Math.max(...perMark.values()) / 200).toBeLessThanOrEqual(0.16); // about 9 percent on average (4 marks from 44); the most frequent of 44 marks over 200 casts sits a little above that by chance
    for (const m of perMark.keys()) expect(m, "no flaw as a mark").not.toMatch(/gap|tooth|scar|birthmark|smile|eyebrows$/i);
  });
  it("no mark category is on more than two cards of a cast", () => {
    for (const c of casts) {
      const cat = new Map<string, number>();
      for (const m of c.filter((x) => !/^none/i.test(x))) {
        const k = tagKind("mark", { distinguishingMark: m } as never)[0] ?? "other";
        cat.set(k, (cat.get(k) ?? 0) + 1);
      }
      expect(Math.max(0, ...cat.values())).toBeLessThanOrEqual(2);
    }
  });
  it("the face descriptions: each at most once per cast, and how often one turns up across casts", () => {
    const facial = (s: number): string[] => dealCastPhysicalSpread(new SeededRandom(5000 + s), 15).map((p) => p.facial);
    const perFace = new Map<string, number>();
    for (let s = 0; s < 200; s++) {
      const f = facial(s);
      expect(new Set(f).size).toBe(15);
      for (const x of f) perFace.set(x, (perFace.get(x) ?? 0) + 1);
    }
    expect(perFace.size).toBeGreaterThanOrEqual(38);
    expect(Math.max(...perFace.values()) / 200).toBeLessThanOrEqual(0.5); // 15 of 40 per cast: about 37 percent
  });
});
