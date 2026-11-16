import { it } from "vitest";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { dealMarksSpread, dealCastPhysicalSpread, HAIR_DESC } from "../../src/engine/deepProfile";
it("stat", () => {
  const marks = new Map<string, number>(), faces = new Map<string, number>(), hairs = new Map<string, number>(); let carriers = 0;
  for (let s = 0; s < 200; s++) {
    const c = dealMarksSpread(new SeededRandom(1000 + s), 15, 1).filter((m) => !/^none/i.test(m)); carriers += c.length;
    for (const m of c) marks.set(m, (marks.get(m) ?? 0) + 1);
    for (const p of dealCastPhysicalSpread(new SeededRandom(5000 + s), 15, undefined, Array(15).fill(30))) { faces.set(p.facial, (faces.get(p.facial) ?? 0) + 1); hairs.set(p.hair, (hairs.get(p.hair) ?? 0) + 1); }
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k}=${(v / 2).toFixed(1)}%`);
  console.log("STAT marks: carriers/cast", carriers / 200, "distinct", marks.size, "mean% per mark", (carriers / 200 / marks.size * 100).toFixed(1), "max", top(marks));
  console.log("STAT faces: distinct", faces.size, "max", top(faces), "hair: distinct", hairs.size, "max", top(hairs));
});
