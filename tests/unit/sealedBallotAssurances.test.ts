import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { claimsOf, type BeliefStore } from "../../src/engine/beliefStore";

/**
 * ORW-15 / E12 / #1963 - an eviction ballot is SECRET. With ORWELL_ASSURANCES on, resolving an assurance at the vote (broken: voted the assured out; kept: voted the other nominee out) must leave NOTHING that
 * names the voter in what the assured (or a witness) holds: no lied-to-me claim, no witness memory, and the memory / trust fold is SHARED across every voter who could have cast the ballot - the real
 * voter carries exactly the same share as every other suspect. The HOH tie-break is a public act and stays attributed. Roles only.
 */
type Mem = { kind: string; severity: number };
type G = {
  assuranceVotedOut(voter: string, nominee: string, among?: readonly string[]): void;
  assuranceKeptAtVote(voter: string, spared: string, among?: readonly string[]): void;
  recordAssurance(a: unknown): void;
  rel: { edge(a: string, b: string): { trust: number } };
  setNpcBeliefsEnabled(on: boolean): void; setMemoryPromisesEnabled(on: boolean): void;
};
function started() {
  const sb = new GameSessionRegistry().sandboxFor(`sealed-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  sb.session.setAssurancesEnabled(true);
  const g = sb.session as unknown as G;
  g.setNpcBeliefsEnabled(true); g.setMemoryPromisesEnabled(true);
  const npcs = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  const [voter, assured, other1, other2] = npcs as [string, string, string, string];
  return { sb, g, voter, assured, others: [other1, other2], suspects: [voter, other1, other2] };
}
const live = (sb: ReturnType<typeof started>["sb"]) => sb.session.snapshot().live as { beliefs?: BeliefStore; npcMemory?: Record<string, Record<string, Mem[]>> };
const sev = (sb: ReturnType<typeof started>["sb"], holder: string, about: string, kind: string): number =>
  (live(sb).npcMemory?.[holder]?.[about] ?? []).filter((m) => m.kind === kind).reduce((n, m) => n + m.severity, 0);

describe("a SEALED ballot never attributes an assurance outcome to the voter (ORW-15)", () => {
  it("broken: no lied-to-me claim naming the voter, no witness memory, and the assured's memory + trust fold is the SAME share for the voter as for every other suspect", () => {
    const { sb, g, voter, assured, others, suspects } = started();
    g.recordAssurance({ from: voter, to: assured, kind: "safe", sincerity: 1, source: "npc", heardBy: [others[0]] });
    const trustBefore = Object.fromEntries(suspects.map((s) => [s, g.rel.edge(assured, s).trust]));
    g.assuranceVotedOut(voter, assured, suspects);
    expect(claimsOf(live(sb).beliefs ?? {}, assured).filter((c) => c.kind === "lied-to-me"), "no claim naming anyone").toEqual([]);
    const shares = suspects.map((s) => sev(sb, assured, s, "deal-broken"));
    expect(shares[0]!, "the assured remembers a (shared) break").toBeGreaterThan(0);
    for (const x of shares) expect(x, "the voter carries exactly the same share as every other suspect").toBeCloseTo(shares[0]!, 12);
    const drops = suspects.map((s) => trustBefore[s]! - g.rel.edge(assured, s).trust);
    for (const d of drops) expect(d, "the trust fold is identical across suspects").toBeCloseTo(drops[0]!, 12);
    expect(sev(sb, others[0], voter, "deal-broken"), "a witness who heard the promise learns nothing about the ballot").toBe(0);
  });
  it("kept: no rumored-break claim, no witness favor, and the favor is shared identically across the suspects", () => {
    const { sb, g, voter, assured, others, suspects } = started();
    g.recordAssurance({ from: voter, to: assured, kind: "vote", sincerity: 1, source: "npc", heardBy: [others[0]] });
    g.assuranceKeptAtVote(voter, assured, suspects);
    expect(claimsOf(live(sb).beliefs ?? {}, assured), "nothing claims anything about the voter").toEqual([]);
    const shares = suspects.map((s) => sev(sb, assured, s, "deal-kept"));
    expect(shares[0]!).toBeGreaterThan(0);
    for (const x of shares) expect(x).toBeCloseTo(shares[0]!, 12);
    expect(sev(sb, others[0], voter, "deal-kept"), "a witness learns nothing").toBe(0);
  });
  it("the engine truth still resolves: the assurance is BROKEN once, in the ledger (engine-only)", () => {
    const { sb, g, voter, assured, suspects } = started();
    g.recordAssurance({ from: voter, to: assured, kind: "safe", sincerity: 1, source: "npc" });
    g.assuranceVotedOut(voter, assured, suspects); g.assuranceVotedOut(voter, assured, suspects);
    const items = (live(sb) as unknown as { assurances: { items: Array<{ status: string }> } }).assurances.items;
    expect(items.map((a) => a.status)).toEqual(["broken"]);
  });
  it("CONTROL: the HOH tie-break is a public act - without a sealed pool the break stays attributed to the HOH", () => {
    const { sb, g, voter, assured, others } = started();
    g.recordAssurance({ from: voter, to: assured, kind: "safe", sincerity: 1, source: "npc" });
    g.assuranceVotedOut(voter, assured);
    expect(sev(sb, assured, voter, "deal-broken")).toBeGreaterThan(0);
    expect(sev(sb, assured, others[0], "deal-broken")).toBe(0);
    expect(claimsOf(live(sb).beliefs ?? {}, assured).some((c) => c.kind === "lied-to-me" && c.subject === voter)).toBe(true);
  });
  it("the vote count passes the whole voter set to both hooks (source pin) - dropping it re-attributes the ballot", () => {
    const src = readFileSync("src/engine/liveSeason.ts", "utf8");
    expect(src).toMatch(/ctx\.assuranceVotedOut\(v, target, voters\)/);
    expect(src).toMatch(/ctx\.assuranceKeptAtVote\(v, fn\[0\] === target \? fn\[1\] : fn\[0\], voters\)/);
    expect(src).toMatch(/ctx\.assuranceVotedOut\?\.\(s\.hoh!, evictee\)/); // the HOH tie-break stays public
  });
});
