import { describe, it, expect } from "vitest";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { RelationshipModel } from "../../src/engine/relationships";
import type { Stats } from "../../src/engine/season";
import { newLiveSeason, advance, applyDecision, type LiveSeasonState, type SeasonCtx } from "../../src/engine/liveSeason";

/**
 * ORW-784 item 2 — every houseguest a staged competition drops is TOLD to the narrator as a fact before the crown.
 *
 * Season-2 playtest, week-1 HOH: the final batch of drops (up to a whole round's worth) went straight to the crown beat and no `comp-elimination` beat ever named them, so the narrator
 * summarised them as "the rest fall away" and the player never saw those eliminations. Roles only.
 */
function buildHouse(size: number, seed: number): { active: EntityId[]; ctx: SeasonCtx } {
  const rng = new SeededRandom(seed);
  const active: EntityId[] = [PLAYER, ...Array.from({ length: size - 1 }, (_, i) => npc(i + 1))];
  const stats = new Map<EntityId, Stats>();
  for (const id of active) stats.set(id, { physical: rng.next(), mental: rng.next(), social: rng.next() });
  const rel = new RelationshipModel(0.5);
  for (const a of active) for (const b of active) {
    if (a === b) continue;
    const e = rel.edge(a, b);
    e.trust = rng.next(); e.affinity = rng.next(); e.threat = rng.next(); e.confidence = 0.5;
  }
  return { active, ctx: { player: PLAYER, statsOf: (id) => stats.get(id)!, rel } };
}

/** Plays to the first staged competition's crown; returns who the engine dropped and who the comp-elimination beats named. */
function firstCompRun(size: number, seed: number): { dropped: EntityId[]; told: Set<string>; winner: EntityId } {
  const { active, ctx } = buildHouse(size, seed);
  const s: LiveSeasonState = newLiveSeason(active);
  const rng = new SeededRandom(seed);
  const told = new Set<string>();
  let dropped: EntityId[] = [];
  let winner: EntityId | undefined;
  let sawStaged = false;
  let done = false;
  const note = (ev: { beat?: string; content?: string } | null | undefined): void => {
    if (ev?.beat !== "comp-elimination") return;
    for (const id of dropped) if (new RegExp(`(^|[^\\w:])${id.replace(":", "\\:")}(?!\\d)`).test(ev.content ?? "")) told.add(id);
  };
  for (let guard = 0; guard < 5_000 && !s.finished && !done; guard++) {
    if (s.pending) {
      const p = s.pending;
      if (p.kind !== "comp-round" && p.kind !== "comp-intent") break;
      const dec = applyDecision(s, { kind: p.kind, intent: "compete" }, ctx, rng);
      if (s.competition?.dropOrder) { dropped = [...s.competition.dropOrder]; winner = s.competition.winner; sawStaged = true; }
      note(dec);
      if (sawStaged && !s.competition) done = true;
      continue;
    }
    const before = s.competition;
    if (before?.dropOrder) { dropped = [...before.dropOrder]; winner = before.winner; sawStaged = true; }
    const ev = advance(s, ctx, rng);
    note(ev);
    if (sawStaged && !s.competition) done = true;
  }
  return { dropped, told, winner: winner! };
}

describe("ORW-784 item 2 — a staged competition names every drop before its crown", () => {
  for (const [size, seed] of [[16, 1], [16, 7], [12, 3], [10, 5]] as const) {
    it(`size ${size}, seed ${seed}: every dropped entrant is named by a comp-elimination beat`, () => {
      const r = firstCompRun(size, seed);
      expect(r.dropped.length).toBe(size - 1);
      const untold = r.dropped.filter((id) => !r.told.has(id));
      expect(untold, "dropped entrants no beat ever told").toEqual([]);
    });
  }
});
