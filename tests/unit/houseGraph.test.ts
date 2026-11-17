import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { deriveHouseGraph, houseGraphFromReader, deriveDailyHouseGraph, type GraphTie, type GraphBondReader } from "../../src/engine/houseGraph";
import { HOUSE_GRAPH } from "../../src/engine/houseGraphConstants";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

const mutual = (a: string, b: string, s = 0.9): GraphTie[] => [{ from: a, to: b, strength: s }, { from: b, to: a, strength: s }];
const group = (m: string[]): GraphTie[] => m.flatMap((a, i) => m.slice(i + 1).flatMap((b) => mutual(a, b)));

describe("feature 0177 house graph", () => {
  const two = [...group(["m1", "m2", "m3"]), ...group(["m4", "m5", "m6"])];
  const members = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];
  it("finds a broker between two cliques", () => {
    const ties = [...two, ...["m1", "m2", "m3", "m4", "m5", "m6"].flatMap((o) => mutual("m7", o))];
    const g = deriveHouseGraph({ members, ties });
    expect(g.brokers).toEqual(["m7"]);
    expect(g.loners).toEqual([]);
  });
  it("a member in one clique with few outside ties is no broker; two bare cliques have none", () => {
    expect(deriveHouseGraph({ members: members.slice(0, 6), ties: two }).brokers).toEqual([]);
    expect(deriveHouseGraph({ members: members.slice(0, 6), ties: two }).cliques).toEqual([["m1", "m2", "m3"], ["m4", "m5", "m6"]]);
  });
  it("finds a loner and a hub", () => {
    const g = deriveHouseGraph({ members: ["m1", "m2", "m3", "m4", "m5", "m6", "m7"], ties: ["m2", "m3", "m4", "m5", "m6"].flatMap((o) => mutual("m1", o)) });
    expect(g.hubs).toEqual(["m1"]);
    expect(g.loners).toContain("m7");
  });
  it("lopsided ties are not ties (min of the two directions)", () => {
    const g = deriveHouseGraph({ members: ["m1", "m2", "m3"], ties: ["m2", "m3"].map((o) => ({ from: "m1", to: o, strength: 1 })).concat(mutual("m2", "m3")) });
    expect(g.cliques).toEqual([]);
  });
  it("is total: empty, unknown ids, self-ties, NaN, out-of-range, garbage", () => {
    expect(deriveHouseGraph({ members: [], ties: [] })).toEqual({ cliques: [], hubs: [], loners: [], brokers: [] });
    expect(deriveHouseGraph({ members: ["m1"], ties: [] }).loners).toEqual(["m1"]);
    const g = deriveHouseGraph({ members: ["m1", "m2", "m3"], ties: [...mutual("m1", "m2", Infinity), ...mutual("m2", "m3", 5), ...mutual("m1", "m3", NaN), { from: "m1", to: "zz", strength: 1 }, { from: "m1", to: "m1", strength: 1 }] });
    expect(g.cliques).toEqual([]);
    expect(() => deriveHouseGraph(undefined as never)).not.toThrow();
    expect(() => deriveHouseGraph({ members: undefined, ties: null } as never)).not.toThrow();
  });
  it("adapter uses the reader's symmetric tie; day cache reuses", () => {
    let calls = 0;
    const reader: GraphBondReader = { living: () => ["m3", "m1", "m2"], tie: () => { calls++; return 0.8; }, day: () => 4 };
    expect(houseGraphFromReader(reader).cliques).toEqual([["m1", "m2", "m3"]]);
    const d = deriveDailyHouseGraph(reader);
    const before = calls;
    expect(deriveDailyHouseGraph(reader, d)).toBe(d);
    expect(calls).toBe(before);
    expect(houseGraphFromReader({ living: () => { throw new Error("x"); }, tie: () => 1 }).cliques).toEqual([]);
  });
  it("the adapter touches only living() and tie() (never an edge-creating API)", () => {
    const seen = new Set<string>();
    const strict = new Proxy({}, { get: (_t, k) => {
      seen.add(String(k));
      if (k === "living") return () => ["m1", "m2", "m3"];
      if (k === "tie") return () => 0.7;
      throw new Error(`forbidden reader call: ${String(k)}`);
    } }) as unknown as GraphBondReader;
    expect(houseGraphFromReader(strict).cliques).toEqual([["m1", "m2", "m3"]]);
    expect([...seen].sort()).toEqual(["living", "tie"]);
  });
  it("properties over 200 seeded graphs of 16", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = new SeededRandom(seed);
      const ms = Array.from({ length: 16 }, (_, i) => `m${String(i).padStart(2, "0")}`);
      const ties: GraphTie[] = [];
      for (const a of ms) for (const b of ms) if (a !== b && r.next() < 0.3) ties.push({ from: a, to: b, strength: r.next() });
      const g = deriveHouseGraph({ members: ms, ties });
      const dir = new Map(ties.map((t) => [`${t.from}|${t.to}`, t.strength]));
      const tied = (a: string, b: string) => Math.min(dir.get(`${a}|${b}`) ?? 0, dir.get(`${b}|${a}`) ?? 0) >= HOUSE_GRAPH.tieThreshold;
      const inC = new Set(g.cliques.flat());
      for (const c of g.cliques) {
        expect(c.length).toBeGreaterThanOrEqual(3);
        for (const a of c) for (const b of c) if (a !== b) expect(tied(a, b)).toBe(true);
      }
      for (const l of g.loners) expect(inC.has(l)).toBe(false);
      for (const b of g.brokers) expect(g.loners).not.toContain(b);
      const shuffled = deriveHouseGraph({ members: [...ms].reverse(), ties: [...ties].reverse() });
      expect(JSON.stringify(shuffled)).toBe(JSON.stringify(g));
      expect(JSON.stringify(deriveHouseGraph({ members: ms, ties }))).toBe(JSON.stringify(g));
    }
  });
  it("is never shown: no surface imports it, output has no numbers, module imports only its constants", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
    for (const dir of ["src/surfaces", "src/adapters/mcp"]) for (const f of walk(dir)) expect(readFileSync(f, "utf8")).not.toMatch(/houseGraph/);
    const src = readFileSync("src/engine/houseGraph.ts", "utf8");
    expect([...src.matchAll(/^import .* from "(.*)"/gm)].map((m) => m[1])).toEqual(["../domain/num", "./houseGraphConstants"]);
    expect(Object.keys(deriveHouseGraph({ members: ["m1"], ties: [] })).sort()).toEqual(["brokers", "cliques", "hubs", "loners"]);
  });
});
