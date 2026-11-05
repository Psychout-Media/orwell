import { describe, it, expect } from "vitest";
import { heldCandidates, ToldLedger } from "../../src/engine/heldFacts";
import type { KnowledgeFact } from "../../src/domain/knowledge";
import { npc } from "../../src/domain/ids";

/** B11 / B10 slice 2 - held facts + the told-to ledger. Roles only. */
const H = npc(1), L1 = npc(2), L2 = npc(3);
const fact = (id: string, o: Partial<KnowledgeFact> = {}): KnowledgeFact => ({ id, content: `c-${id}`, pathway: "witnessed", ts: 1, ...o } as KnowledgeFact);

describe("B10 S2 - heldCandidates", () => {
  it("lists only facts the listener lacks, by lineage (factId beats id)", () => {
    const holder = [fact("a"), fact("b", { factId: "lin-b" }), fact("c")];
    const listener = [fact("x", { factId: "lin-b" }), fact("c")];
    expect(heldCandidates(holder, listener).map((c) => c.factId)).toEqual(["a"]);
  });
  it("is stable regardless of input order and de-duplicates a lineage", () => {
    const a = [fact("z"), fact("m"), fact("m")];
    expect(heldCandidates(a, []).map((c) => c.factId)).toEqual(["m", "z"]);
    expect(heldCandidates([...a].reverse(), []).map((c) => c.factId)).toEqual(["m", "z"]);
  });
  it("marks first-hand vs hearsay and carries the held confidence", () => {
    const c = heldCandidates([fact("own"), fact("rumor", { source: L1, hops: 2, confidence: 0.4 })], []);
    expect(c.find((x) => x.factId === "own")!.firstHand).toBe(true);
    const r = c.find((x) => x.factId === "rumor")!;
    expect(r.firstHand).toBe(false);
    expect(r.confidence).toBe(0.4);
  });
});

describe("B10 S2 - ToldLedger", () => {
  it("decides a fact once per listener (first write wins)", () => {
    const t = new ToldLedger();
    expect(t.record(H, "f", L1, "held")).toBe(true);
    expect(t.record(H, "f", L1, "shared")).toBe(false);
    expect(t.outcome(H, "f", L1)).toBe("held");
    expect(t.decided(H, "f", L2)).toBe(false);
  });
  it("undecided drops what the holder already decided for THIS listener only", () => {
    const t = new ToldLedger();
    t.record(H, "a", L1, "shared");
    const cands = heldCandidates([fact("a"), fact("b")], []);
    expect(t.undecided(H, L1, cands).map((c) => c.factId)).toEqual(["b"]);
    expect(t.undecided(H, L2, cands).map((c) => c.factId)).toEqual(["a", "b"]);
  });
  it("reopen clears one fact for everyone, nothing else", () => {
    const t = new ToldLedger();
    t.record(H, "a", L1, "held"); t.record(H, "a", L2, "held"); t.record(H, "b", L1, "held");
    expect(t.reopen(H, "a")).toBe(2);
    expect(t.decided(H, "a", L1)).toBe(false);
    expect(t.decided(H, "b", L1)).toBe(true);
  });
  it("snapshot/restore is lossless, deterministic and JSON-plain", () => {
    const t = new ToldLedger();
    t.record(H, "b", L2, "slipped"); t.record(H, "a", L1, "shared");
    const s = t.snapshot();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    const r = ToldLedger.restore(s);
    expect(r.snapshot()).toEqual(s);
    expect(r.outcome(H, "b", L2)).toBe("slipped");
    expect(ToldLedger.restore(undefined).size).toBe(0);
  });
});
