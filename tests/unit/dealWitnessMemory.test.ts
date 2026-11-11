import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import { DEAL_WITNESS } from "../../src/engine/npcMemory";
import type { EntityId } from "../../src/domain/ids";

/**
 * ORW-85 (AMEND 0140 item 5; Ryne 2026-11-10: what NPCs overhear has real impact) - houseguests who witness a deal being made remember it, reading it against their own position:
 * targeted (or an ally targeted) => grudge toward both dealmakers; their ally dealing without them => small hurt; otherwise recall-only. Played games only. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

type Internals = {
  presence: Map<EntityId, string> | null;
  live: { npcMemory?: Record<string, Record<string, { kind: string; severity: number }[]>> };
  rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } };
  setNpcMemoryEnabled(on: boolean): void;
  setDealsWitnessesEnabled(on: boolean): void;
  nameOf(id: string): string;
};

function table(seed = 7, played = true) {
  const sb = new GameSessionRegistry().sandboxFor(`dwm-${seed}-${played}`);
  const s = sb.session;
  s.createCharacter({ playerName: "The Player", seed });
  for (let i = 0; i < 3; i++) s.advanceGame();
  const g = s as unknown as Internals;
  g.setNpcMemoryEnabled(true);
  g.setDealsWitnessesEnabled(true);
  const [partner, w1, w2, w3] = s.livingIds().filter((id) => id !== PLAYER);
  g.presence = new Map<EntityId, string>([[PLAYER, "kitchen"], [partner!, "kitchen"], [w1!, "kitchen"], [w2!, "kitchen"], [w3!, "backyard"]]);
  for (const id of [partner!, w1!, w2!]) for (const o of [PLAYER, partner!, w1!, w2!]) if (id !== o) { const e = g.rel.edge(id, o); e.trust = 0.05; e.affinity = 0.05; }
  { const e = g.rel.edge(partner!, PLAYER); e.trust = 0.9; e.affinity = 0.9; e.threat = 0; } // the partner agrees to deal
  if (played) s.noteMessage({ messageId: "m-0" });
  g.presence = new Map<EntityId, string>([[PLAYER, "kitchen"], [partner!, "kitchen"], [w1!, "kitchen"], [w2!, "kitchen"], [w3!, "backyard"]]); // noteMessage may re-seat
  return { s, g, partner: partner!, w1: w1!, w2: w2!, w3: w3! };
}
const kinds = (g: Internals, holder: string, subject: string): string[] => (g.live.npcMemory?.[holder]?.[subject] ?? []).map((e) => e.kind);

describe("a witnessed deal is remembered", () => {
  it("an unconnected witness keeps a recall-only entry toward both dealmakers; an absent one remembers nothing", () => {
    const t = table();
    t.s.makeDeal({ with: t.partner, kind: "safety", terms: "we keep each other safe this week" });
    expect(kinds(t.g, t.w1, PLAYER)).toEqual(["deal-witnessed"]);
    expect(kinds(t.g, t.w1, t.partner)).toEqual(["deal-witnessed"]);
    expect(kinds(t.g, t.w3, PLAYER)).toEqual([]); // in another room
    expect(kinds(t.g, t.w3, t.partner)).toEqual([]);
  });
  it("a witness the deal names as its target holds a grudge toward both dealmakers", () => {
    const t = table();
    t.s.makeDeal({ with: t.partner, kind: "target-other", terms: `we go after ${t.g.nameOf(t.w1)} together` });
    for (const p of [PLAYER, t.partner]) {
      const m = t.g.live.npcMemory?.[t.w1]?.[p] ?? [];
      expect(m.map((e) => e.kind)).toEqual(["deal-resented"]);
      expect(m[0]!.severity).toBeCloseTo(DEAL_WITNESS.targetedSeverity, 6);
    }
    expect(kinds(t.g, t.w2, PLAYER)).toEqual(["deal-witnessed"]); // not named: just recalls it
  });
  it("a witness whose ally is targeted resents it too", () => {
    const t = table();
    t.g.rel.edge(t.w2, t.w1).trust = 0.9; t.g.rel.edge(t.w2, t.w1).affinity = 0.9;
    t.s.makeDeal({ with: t.partner, kind: "target-other", terms: `we go after ${t.g.nameOf(t.w1)} together` });
    expect(kinds(t.g, t.w2, PLAYER)).toEqual(["deal-resented"]);
  });
  it("a witness whose own ally made the deal without it takes a small hurt toward that ally, smaller than a targeted grudge", () => {
    const t = table();
    t.g.rel.edge(t.w1, t.partner).trust = 0.9; t.g.rel.edge(t.w1, t.partner).affinity = 0.9;
    t.s.makeDeal({ with: t.partner, kind: "safety", terms: "we keep each other safe" });
    const m = t.g.live.npcMemory?.[t.w1]?.[t.partner] ?? [];
    expect(m.map((e) => e.kind)).toEqual(["deal-resented"]);
    expect(m[0]!.severity).toBeCloseTo(DEAL_WITNESS.leftOutSeverity, 6);
    expect(DEAL_WITNESS.leftOutSeverity).toBeLessThan(DEAL_WITNESS.targetedSeverity);
    expect(kinds(t.g, t.w1, PLAYER)).toEqual([]); // the hurt is toward the ally, not the player
  });
  it("writes nothing before a person is playing, or with the witness layer off", () => {
    const headless = table(7, false);
    headless.s.makeDeal({ with: headless.partner, kind: "safety", terms: "safe" });
    expect(kinds(headless.g, headless.w1, PLAYER)).toEqual([]);
    const off = table();
    off.g.setDealsWitnessesEnabled(false);
    off.s.makeDeal({ with: off.partner, kind: "safety", terms: "safe" });
    expect(kinds(off.g, off.w1, PLAYER)).toEqual([]);
  });
  it("the per-pair cap holds and the memory carries no sealed text", () => {
    const t = table();
    for (let i = 0; i < 12; i++) t.s.makeDeal({ with: t.partner, kind: "safety", terms: `a deal ${i}`, idempotencyKey: `k${i}` } as never);
    expect((t.g.live.npcMemory?.[t.w1]?.[PLAYER] ?? []).length).toBeLessThanOrEqual(6);
    expect(JSON.stringify(t.g.live.npcMemory)).not.toMatch(/a deal \d/); // entries hold kind/week/severity only, never the deal's words
  });
});
