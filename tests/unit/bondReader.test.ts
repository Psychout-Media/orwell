import { describe, it, expect } from "vitest";
import { RelationshipModel } from "../../src/engine/relationships";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";
import { DECISION } from "../../src/engine/decisionConstants";
import { edgeBondReader, edgeStrength } from "../../src/engine/bonds";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { PLAYER_TOOLS, ADMIN_TOOLS, DEBUG_VAULT_TOOLS } from "../../src/surfaces/tools/registry";

/** Theme 3 Core 1 (ORW-552): the bond read API the house graph consumes. Roles only: a holder, others. */
const BASE = (RELATIONSHIP_CONSTANTS.baseline.trust + RELATIONSHIP_CONSTANTS.baseline.affinity) / 2;
const SPAN = DECISION.nomination.floaterBondSpan;

function house() {
  const rel = new RelationshipModel(0.5);
  const living = ["h", "a", "b", "c"];
  const set = (x: string, y: string, v: number) => Object.assign(rel.edge(x, y), { trust: v, affinity: v, reliability: RELATIONSHIP_CONSTANTS.baseline.reliability });
  return { rel, living, set, reader: edgeBondReader(rel, () => living, () => 4) };
}

describe("the bond read API (bonds.ts)", () => {
  it("strength is 0 at the edge baseline and 1 a full floater span above it, clamped", () => {
    const { set, reader } = house();
    set("h", "a", BASE + SPAN); set("h", "b", BASE + SPAN / 2); set("h", "c", BASE - 0.2);
    expect(reader.strength("h", "a")).toBeCloseTo(1, 9);
    expect(reader.strength("h", "b")).toBeCloseTo(0.5, 9);
    expect(reader.strength("h", "c")).toBe(0);
  });
  it("bonds are directed and lopsided; a tie is the weaker of the two", () => {
    const { set, reader } = house();
    set("h", "a", BASE + SPAN); set("a", "h", BASE + SPAN / 4);
    expect(reader.bond("h", "a").strength).not.toBe(reader.bond("a", "h").strength);
    expect(reader.tie("h", "a")).toBeCloseTo(0.25, 9);
    expect(reader.tie("a", "h")).toBe(reader.tie("h", "a"));
  });
  it("ties list everyone else living, strongest first, then by id", () => {
    const { set, reader } = house();
    set("h", "b", BASE + SPAN / 2); set("h", "c", BASE + SPAN / 2); set("h", "a", BASE + SPAN);
    expect(reader.ties("h").map((t) => t.other)).toEqual(["a", "b", "c"]);
    expect(reader.ties("h").some((t) => t.other === "h")).toBe(false);
  });
  it("a read never creates an edge (read-only: the saved relationship layer is unchanged)", () => {
    const { rel, reader } = house();
    const before = JSON.stringify(rel.serialize());
    for (const x of ["h", "a", "b", "c"]) { reader.ties(x); for (const y of ["h", "a", "b", "c"]) if (x !== y) { reader.bond(x, y); reader.tie(x, y); } }
    expect(JSON.stringify(rel.serialize())).toBe(before);
  });
  it("the edge-only strength agrees with bondStrength on a stored edge", () => {
    const { rel, set } = house();
    set("h", "a", 0.47);
    expect(edgeStrength(rel, "h", "a")).toBeCloseTo(Math.max(0, Math.min(1, (rel.bondStrength("h", "a") - BASE) / SPAN)), 12);
  });
  it("the Theme 3 fields read neutral until the bond record (0175) lands", () => {
    const { reader } = house();
    const v = reader.bond("h", "a");
    expect({ debt: v.debt, resentment: v.resentment, strain: v.strain, history: v.history, kind: v.kind, commitment: v.commitment, rank: v.rank })
      .toEqual({ debt: 0, resentment: 0, strain: 0, history: 0, kind: "none", commitment: "none", rank: null });
  });
  it("the live adapter offers it engine-side only: no player or admin tool is named for it", () => {
    const sb = new GameSessionRegistry().sandboxFor(`bond-reader-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", seed: 3 });
    const r = sb.session.bondReader();
    expect(r.living()).toContain(PLAYER);
    expect(r.ties(PLAYER).length).toBe(r.living().length - 1);
    const names = [...PLAYER_TOOLS, ...ADMIN_TOOLS, ...DEBUG_VAULT_TOOLS].map((t) => t.name);
    expect(names.some((n) => /bond/i.test(n))).toBe(false);
  });
  it("a second debt source (the favor ledger) adds to the record's debt, clamped -1..1", async () => {
    const { recordBondReader } = await import("../../src/engine/bonds");
    const rel = new RelationshipModel(0.5);
    const store = { "h|a": { warmth: 0, debt: 0.5, resentment: 0, strain: 0, history: 1, romance: 0, peakResentment: 0, commitment: "none" as const } };
    const r = recordBondReader(rel, () => store, () => ["h", "a"], () => 1, { favorDebt: (h, o) => (h === "h" && o === "a" ? 0.8 : -0.2) });
    expect(r.bond("h", "a").debt).toBe(1);
    expect(r.bond("a", "h").debt).toBeCloseTo(-0.2, 12);
  });
});
