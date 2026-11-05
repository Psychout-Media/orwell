import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { ASSURANCE, isRumoredBreak } from "../../src/engine/assurances";
import { claimsOf, type BeliefStore } from "../../src/engine/beliefStore";

/**
 * B39 (design S1's "a rumored break") - sometimes the assured WRONGLY believes a KEPT assurance was broken: the engine's truth stays "kept", the assured holds a low-confidence `lied-to-me` claim (and not
 * the favor), from a dedicated seeded roll. Needs the belief layer; same game + same inputs => same outcome; the rate is the configured one over many pairs. Roles only.
 */
describe("isRumoredBreak", () => {
  it("is a threshold on the roll at the configured rate", () => {
    expect(isRumoredBreak(0)).toBe(true);
    expect(isRumoredBreak(ASSURANCE.rumoredBreakP - 1e-9)).toBe(true);
    expect(isRumoredBreak(ASSURANCE.rumoredBreakP)).toBe(false);
    expect(isRumoredBreak(0.99)).toBe(false);
  });
});

type G = { recordAssurance(a: unknown): void; setAssurancesEnabled(on: boolean): void; setNpcBeliefsEnabled(on: boolean): void; assuranceKeptAtTally(fn: string[]): void };
function started(seed: number, beliefs: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(`asrrum-${seed}-${beliefs}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as G;
  g.setAssurancesEnabled(true); g.setNpcBeliefsEnabled(beliefs);
  return { sb, g, npcs: [...sb.session.livingIds()].filter((i) => i !== PLAYER) };
}
type Live = { assurances?: { items: { status: string }[] }; beliefs?: BeliefStore; npcMemory?: Record<string, Record<string, { kind: string }[]>> };
const live = (sb: { session: { snapshot(): { live?: unknown } } }) => sb.session.snapshot().live as Live;

/** Keep every (holder -> each other NPC) pair once; return how many assured ended up with a rumored-break claim. */
function run(seed: number, beliefs: boolean) {
  const { sb, g, npcs } = started(seed, beliefs);
  const holder = npcs[0]!;
  const assureds = npcs.slice(1);
  for (const to of assureds) g.recordAssurance({ from: holder, to, kind: "safe", sincerity: 1, source: "npc" });
  g.assuranceKeptAtTally([]); // the nominees are final and the assured are not on the block: every 'safe' was kept
  const l = live(sb);
  const rumored = assureds.filter((to) => claimsOf(l.beliefs ?? {}, to).some((c) => c.kind === "lied-to-me" && c.subject === holder && c.nature === "rumored-break"));
  const favored = assureds.filter((to) => (l.npcMemory?.[to]?.[holder] ?? []).some((e) => e.kind === "deal-kept"));
  return { l, assureds, rumored, favored };
}

describe("a rumored break after a kept assurance (B39)", () => {
  it("the truth stays 'kept'; each assured holds EITHER the false claim OR the favor, never both", () => {
    const r = run(7, true);
    expect(r.l.assurances!.items.every((i) => i.status === "kept")).toBe(true);
    for (const to of r.assureds) expect(r.rumored.includes(to) && r.favored.includes(to), `${to} has both`).toBe(false);
    expect(r.rumored.length + r.favored.length).toBe(r.assureds.length);
  });
  it("is deterministic, and over many games hits roughly the configured rate", () => {
    const a = run(7, true), b = run(7, true);
    expect(b.rumored).toEqual(a.rumored);
    let total = 0, hit = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) { const r = run(seed, true); total += r.assureds.length; hit += r.rumored.length; }
    expect(total).toBeGreaterThan(100);
    expect(hit / total).toBeGreaterThan(ASSURANCE.rumoredBreakP * 0.4);
    expect(hit / total).toBeLessThan(ASSURANCE.rumoredBreakP * 1.8);
  });
  it("belief layer off (the same-seed control): no claim is ever written and everyone keeps the favor", () => {
    const r = run(7, false);
    expect(r.rumored).toEqual([]);
    expect(r.favored.length).toBe(r.assureds.length);
    expect(r.l.beliefs).toBeUndefined();
  });
});
