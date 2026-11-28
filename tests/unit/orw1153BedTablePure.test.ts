import { describe, it, expect } from "vitest";
import { bedTable } from "../../src/engine/beds";

/** ORW-1153: the pure per-bed table. */
describe("ORW-1153: the per-bed table (pure)", () => {
  const inHouse = new Set(["a", "b", "c"]);
  const t = bedTable({ owner: { a: "bedroom-a#d1:1", b: "bedroom-a#s1", c: "bedroom-c#d1:2" }, claims: [] }, inHouse, (r) => `<${r}>`, (w) => w);
  it("lists each double half on its own, owner or free, with the house-wide free count", () => {
    expect(t.total).toBe(16);
    expect(t.free).toBe(13);
    expect(t.rooms[0]).toContain("single 1: b");
    expect(t.rooms[0]).toContain("double 1 half 1: a; double 1 half 2: free");
    expect(t.rooms[2]).toContain("double 1 half 1: free; double 1 half 2: c");
    expect(t.freeByRoom["bedroom-c"]).toEqual(["single 1", "single 2", "single 3", "double 1 half 1"]);
  });
  it("an evicted owner's spot reads free", () => {
    const e = bedTable({ owner: { a: "bedroom-a#s1", gone: "bedroom-a#s2" }, claims: [] }, new Set(["a"]), (r) => r, (w) => w);
    expect(e.rooms[0]).toContain("single 2: free");
    expect(e.free).toBe(15);
  });
});

