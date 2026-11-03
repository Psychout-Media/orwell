import { describe, it, expect } from "vitest";
import { RelationshipModel } from "../../src/engine/relationships";
import { newLiveSeason, advance, type SeasonCtx, type LiveSeasonState } from "../../src/engine/liveSeason";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * 0024 WIRING — `npcMemory0024.test.ts` pins the ledger math and the adapter writes; THESE tests fail if the
 * `memoryTiltFor` call sites in `liveSeason.ts` are removed (the NPC HOH's nominations and replacement must read it
 * with the HOH as the holder). The eviction-vote wiring is pinned in `npcMemory0024.test.ts` through `voteChoice`.
 * Roles only — no names.
 */
const hoh = npc(7);
const active = [PLAYER, hoh, npc(1), npc(2), npc(3), npc(4), npc(5), npc(6)];

const rel = (): RelationshipModel => {
  const r = new RelationshipModel(0.5);
  r.edge(hoh, npc(1)).threat = 0.6;
  r.edge(hoh, npc(2)).threat = 0.5;
  r.edge(hoh, npc(3)).threat = 0.4;
  r.edge(hoh, npc(4)).threat = 0.15;
  return r;
};
const ctx = (memory?: (s: EntityId, h: EntityId) => number): SeasonCtx => ({
  player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel: rel(),
  ...(memory ? { memoryTiltFor: memory } : {}),
});

describe("the NPC HOH's nominations and replacement read the memory tilt (holder = the HOH)", () => {
  it("nominations: a grudge held by the HOH toward the lowest read pulls them onto the block; absent, they are not", () => {
    const nominate = (memory?: (s: EntityId, h: EntityId) => number): EntityId[] => {
      const s = newLiveSeason(active);
      s.beat = "nominations";
      s.hoh = hoh;
      expect(advance(s, ctx(memory), new SeededRandom(3))?.beat).toBe("nominations");
      return [...(s.nominees ?? [])];
    };
    expect(nominate()).not.toContain(npc(4));
    // the provider is called as (subject, holder): only a grudge HELD BY THE HOH counts
    expect(nominate((s, h) => (s === npc(4) && h === hoh ? 5 : 0))).toContain(npc(4));
    expect(nominate((s, h) => (s === npc(4) && h !== hoh ? 5 : 0))).not.toContain(npc(4));
  });

  it("replacement: the same tilt steers the replacement nominee", () => {
    const replace = (memory?: (s: EntityId, h: EntityId) => number): EntityId | undefined => {
      const r = rel();
      r.edge(npc(3), npc(1)).trust = 0.95;
      r.edge(npc(3), npc(2)).trust = 0.85;
      const s: LiveSeasonState = newLiveSeason(active);
      s.beat = "veto-ceremony";
      s.hoh = hoh;
      s.nominees = [npc(1), npc(2)];
      s.vetoHolder = npc(3);
      advance(s, { ...ctx(memory), rel: r }, new SeededRandom(5));
      return s.replacement;
    };
    expect(replace()).toBeDefined();
    expect(replace()).not.toBe(npc(5));
    expect(replace((s, h) => (s === npc(5) && h === hoh ? 5 : 0))).toBe(npc(5));
  });
});
