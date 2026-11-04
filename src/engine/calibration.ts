import type { EntityId } from "../domain/ids";
import { PLAYER } from "../domain/ids";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { SeededRandom } from "../adapters/random/SeededRandom";
import { RelationshipModel } from "./relationships";
import type { SeasonHouseguest } from "./season";
import {
  newLiveSeason, advance, applyDecision, autoDecision,
  type LiveSeasonState, type SeasonCtx,
} from "./liveSeason";

/**
 * The calibration driver (B55/audit D12) — `playSeason` is now a DRIVER OVER THE LIVE LOOP, not a
 * parallel implementation. The old `season.ts` sim diverged in rules from the game the player
 * actually plays (no Houseguest's-Choice chip, different comp types, no manner/appeals, duplicate
 * decision helpers), so the 0011/0006 suites verified mechanics the player never met. This module
 * runs `newLiveSeason`/`advance` — the SAME functions the live adapter runs — auto-answering every
 * player pending with the loop's own NPC policy (`autoDecision`). One weekly-loop rulebook; zero drift.
 *
 * Pure + seed-deterministic, calibration/tests-only (no production callers — the live game drives
 * the loop through `GameSessionAdapter`).
 */
export interface WeekRecord {
  week: number;
  hoh: EntityId;
  nominees: [EntityId, EntityId];
  /** Absent for the Final-3 week (0045): the final HOH evicts directly — no veto that week. */
  vetoHolder?: EntityId;
  vetoUsed: boolean;
  replacement?: EntityId;
  finalNominees: [EntityId, EntityId];
  evictee: EntityId;
}

export interface SeasonOutcome {
  winner: EntityId;
  finalTwo: [EntityId, EntityId];
  evictionOrder: EntityId[];
  jury: EntityId[];
  preJury: EntityId[];
  weeks: WeekRecord[];
}

/** Uniform seeded edges — abstract calibration input (the LIVE move-in seeding is the adapter's). */
function seedRelationships(ids: EntityId[], rng: RandomnessSource): RelationshipModel {
  const rel = new RelationshipModel(0.5);
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      const e = rel.edge(a, b);
      e.trust = rng.next();
      e.affinity = rng.next();
      e.threat = rng.next();
      e.confidence = 0.5;
    }
  }
  return rel;
}

/** Record the week that just resolved an eviction (the staged weekly cycle). */
function stagedWeekRecord(s: LiveSeasonState): WeekRecord {
  const e = s.eviction!;
  return {
    week: s.week,
    hoh: s.hoh!,
    nominees: s.nominees ? [s.nominees[0], s.nominees[1]] : [e.nominees[0], e.nominees[1]],
    vetoHolder: s.vetoHolder,
    vetoUsed: s.vetoUsed,
    ...(s.replacement ? { replacement: s.replacement } : {}),
    finalNominees: [e.nominees[0], e.nominees[1]],
    evictee: e.evictee!,
  };
}

export function playSeason(opts: { seed: number; houseguests: SeasonHouseguest[]; player?: EntityId; finalHohThreePart?: boolean }): SeasonOutcome {
  const rng = new SeededRandom(opts.seed);
  const player = opts.player ?? PLAYER;
  const statsOf = new Map(opts.houseguests.map((h) => [h.id, h.stats]));
  const ids = opts.houseguests.map((h) => h.id);
  const ctx: SeasonCtx = { player, statsOf: (id) => statsOf.get(id)!, rel: seedRelationships(ids, rng), ...(opts.finalHohThreePart ? { finalHohThreePart: true } : {}) };

  const s = newLiveSeason(ids);
  const weeks: WeekRecord[] = [];
  for (let guard = 0; guard < 10_000 && !s.finished; guard++) {
    const ev = s.pending
      ? applyDecision(s, autoDecision(s, ctx, rng), ctx, rng)
      : advance(s, ctx, rng);
    // The staged weekly eviction: the evictee is known while the week's ceremony state is intact.
    if (ev?.beat === "eviction") weeks.push(stagedWeekRecord(s));
    // Final 3 (0045): the final HOH evicts directly — the rivals were the de-facto final nominees.
    if (ev?.beat === "final-eviction") {
      const [hoh, evictee] = [ev.participants[0]!, ev.participants[1]!];
      const survivor = s.active.find((h) => h !== hoh)!;
      weeks.push({
        week: weeks.length + 1, hoh, nominees: [evictee, survivor],
        vetoUsed: false, finalNominees: [evictee, survivor], evictee,
      });
    }
  }
  if (!s.finished || !s.winner || !s.finalTwo) throw new Error("the calibration season did not finish");

  const evictionOrder = [...s.evictionOrder];
  const jury = evictionOrder.slice(-9);
  const preJury = evictionOrder.slice(0, Math.max(0, evictionOrder.length - 9));
  return { winner: s.winner, finalTwo: s.finalTwo, evictionOrder, jury, preJury, weeks };
}
