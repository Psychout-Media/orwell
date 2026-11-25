import { describe, it, expect } from "vitest";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { RelationshipModel } from "../../src/engine/relationships";
import type { Stats } from "../../src/engine/season";
import { newLiveSeason, advance, applyDecision, type SeasonCtx, type BeatEvent, type LiveSeasonState } from "../../src/engine/liveSeason";

/**
 * ORW-830 (remainder of ORW-784 item 2): the LAST batch of a staged comp's drops used to be told nowhere (the comp crowned directly when the batch left one player, so no comp-elimination beat named them and the
 * narrator only had "the rest fall away"). The crown beat now carries that batch as `lastDrops`: the same inert comp-elimination event every earlier round is, reached on the SAME advance (no extra step, so no season shifts).
 * Roles only.
 */
function house(size: number, seed: number) {
  const rng = new SeededRandom(seed);
  const active: EntityId[] = [PLAYER, ...Array.from({ length: size - 1 }, (_, i) => npc(i + 1))];
  const stats = new Map<EntityId, Stats>();
  for (const id of active) stats.set(id, { physical: rng.next(), mental: rng.next(), social: rng.next() });
  const rel = new RelationshipModel(0.5);
  return { active, statsOf: (id: EntityId) => stats.get(id)!, rel };
}

function playHohComp(size: number, seed: number) {
  const h = house(size, seed);
  const ctx: SeasonCtx = { player: PLAYER, statsOf: h.statsOf, rel: h.rel };
  const s: LiveSeasonState = newLiveSeason(h.active);
  const rng = new SeededRandom(seed);
  const told: Array<{ beat: string; content: string }> = [];
  let advances = 0, crown: BeatEvent | null = null, dropOrder: EntityId[] | undefined;
  for (let guard = 0; guard < 100 && !crown; guard++) {
    let ev: BeatEvent | null;
    if (s.pending && (s.pending.kind === "comp-round" || s.pending.kind === "comp-intent")) ev = applyDecision(s, { kind: s.pending.kind, intent: "compete" }, ctx, rng);
    else if (s.pending) break;
    else { ev = advance(s, ctx, rng); advances += 1; }
    if (s.competition?.dropOrder && !dropOrder) dropOrder = [...s.competition.dropOrder];
    if (ev?.beat === "comp-elimination") told.push({ beat: ev.beat, content: ev.content });
    if (ev?.beat === "hoh-competition") crown = ev;
  }
  return { crown, told, dropOrder, advances };
}

describe("ORW-830: a staged comp's last batch of drops is told, with no extra step", () => {
  for (const size of [16, 12, 10]) {
    it(`a field of ${size}: the crown carries every drop the earlier rounds did not tell`, () => {
      const r = playHohComp(size, 3);
      expect(r.crown, "the comp crowned").not.toBeNull();
      expect(r.dropOrder, "a staged comp").toBeDefined();
      const last = r.crown!.lastDrops;
      expect(last, "the crown carries its last batch").toBeDefined();
      expect(last!.beat).toBe("comp-elimination");
      const toldIds = new Set<string>();
      for (const t of [...r.told, last!]) for (const id of r.dropOrder!) if (t.content.includes(id)) toldIds.add(id);
      expect([...toldIds].sort(), "every drop is named in some told beat").toEqual([...r.dropOrder!].sort());
    });
  }
  it("the crown's own content is untouched (the trajectory baseline stays byte-identical)", () => {
    const r = playHohComp(12, 3);
    expect(r.crown!.content).toMatch(/^npc:\d+ wins Head of Household$|^player wins Head of Household$/);
  });
});
