import { mixShares, MIX_KINDS, type MixScene } from "./houseMixDriver";

/**
 * ORW-702: the WHOLE-SEASON house-life mix target and the machinery that measures a played season against it. ONE module: the band numbers and the hard rules live only
 * here (the guard test, the weekly report and the unit tests all read it). ORW-991 (Ryne 2026-11-26): they are a REPORT, tracked weekly; the KNOWN_RED ratchet is gone and a
 * build fails only on a broken mix (tests/support/brokenBounds.ts).
 *
 * The target is the PO-agreed one of 2026-11-20 (vault note "Memory/Whole Season Mix Target Proposal.md"; card ORW-702). Shares are of house-life scenes (bonding / strategy /
 * gossip / conflict) while the player is still in the game, by season PHASE taken from the game WEEK the scene happened in (never from a message count).
 * Changing a band needs a new PO ruling.
 * The week-1 guard (tests/uat/houseMixGuard.test.ts, its own REFERENCE) is a separate, untouched guard.
 */
export type Kind = (typeof MIX_KINDS)[number];
export type Phase = "early" | "mid" | "late";
export const PHASES: readonly Phase[] = ["early", "mid", "late"];

/** Early = weeks 1-3, mid = weeks 4-8, late = week 9 on. */
export function phaseOfWeek(week: number): Phase { return week <= 3 ? "early" : week <= 8 ? "mid" : "late"; }

/** The agreed bands, percent of scenes: [low, high] per kind per phase. */
export const BANDS: Record<Phase, Record<Kind, readonly [number, number]>> = {
  early: { bonding: [32, 42], strategy: [24, 32], gossip: [22, 32], conflict: [4, 9] },
  mid: { bonding: [24, 34], strategy: [26, 34], gossip: [26, 36], conflict: [7, 13] },
  late: { bonding: [20, 30], strategy: [28, 38], gossip: [24, 34], conflict: [10, 16] },
};
/** Hard rules, in every phase (floors apply from mid on). */
export const HARD = { strategyBelow: 50, anyActivityAtMost: 45, gossipAtLeastFromMid: 22, strategyAtLeastFromMid: 24, conflictAtMost: 16 } as const;

export interface Share { n: number; bonding: number; strategy: number; gossip: number; conflict: number }
export type PhaseShares = Record<Phase, Share>;

/** Pool scenes (from any number of seasons) per phase: one pooled count per phase, so a season with few scenes in a phase weighs less. Only scenes while the player was in. */
export function poolByPhase(scenes: readonly MixScene[]): PhaseShares {
  const out = {} as PhaseShares;
  for (const p of PHASES) out[p] = mixShares(scenes.filter((s) => !s.playerOut && phaseOfWeek(s.week) === p));
  return out;
}

/** Fewer player-in scenes than this in a phase and that phase is read from every scene of the house instead (see poolSeason). */
export const MIN_PLAYER_IN_SCENES = 100;
export interface SeasonPool { shares: PhaseShares; /** per phase: which scenes were read */ basis: Record<Phase, "player-in" | "house-after-player-left"> }
/**
 * The whole-season reading. The scripted talking player is voted out in the early-mid weeks (weeks 4-5 in the measured seasons), so the late weeks (9 on) are played by the house
 * alone: a phase with fewer than MIN_PLAYER_IN_SCENES player-in scenes is read from ALL the house's scenes instead, and the basis is printed beside it. (The house's own
 * life does not depend on the player watching; a spectator-era house is the closest reading of the late game this player reaches.)
 */
export function poolSeason(scenes: readonly MixScene[], minPlayerIn = MIN_PLAYER_IN_SCENES): SeasonPool {
  const inGame = poolByPhase(scenes), everyone = poolByPhase(scenes.map((x) => ({ ...x, playerOut: false })));
  const shares = {} as PhaseShares, basis = {} as SeasonPool["basis"];
  for (const p of PHASES) { const spectator = inGame[p].n < minPlayerIn && everyone[p].n > inGame[p].n; shares[p] = spectator ? everyone[p] : inGame[p]; basis[p] = spectator ? "house-after-player-left" : "player-in"; }
  return { shares, basis };
}

export interface RuleResult { id: string; phase: Phase; pass: boolean; value: number; /** how far outside the limit (0 when it passes) */ miss: number; /** how far inside the limit when it passes (0 when it fails) */ room: number; what: string }

const r1 = (x: number): number => +x.toFixed(1);
/** Every band and hard rule for one phase, evaluated on the pooled shares. A phase with no scenes is not evaluated (the guard asserts the scene count separately). */
export function evaluate(shares: PhaseShares): RuleResult[] {
  const out: RuleResult[] = [];
  for (const phase of PHASES) {
    const s = shares[phase];
    if (s.n === 0) continue;
    const add = (id: string, value: number, lo: number, hi: number, what: string): void => {
      const miss = value < lo ? lo - value : value > hi ? value - hi : 0;
      out.push({ id: `${phase}:${id}`, phase, pass: miss === 0, value: r1(value), miss: r1(miss), room: miss === 0 ? r1(Math.min(value - lo, hi - value)) : 0, what });
    };
    for (const k of MIX_KINDS) add(`band-${k}`, s[k], BANDS[phase][k][0], BANDS[phase][k][1], `${k} share within its ${phase} band ${BANDS[phase][k][0]}-${BANDS[phase][k][1]}`);
    add("strategy-below-50", s.strategy, -Infinity, HARD.strategyBelow - 0.05, "strategy (game talk) under 50%");
    add("no-activity-above-45", Math.max(s.bonding, s.strategy, s.gossip, s.conflict), -Infinity, HARD.anyActivityAtMost, "no single activity above 45%");
    add("conflict-at-most-16", s.conflict, -Infinity, HARD.conflictAtMost, "conflict at most 16%");
    if (phase !== "early") {
      add("gossip-at-least-22", s.gossip, HARD.gossipAtLeastFromMid, Infinity, "gossip at least 22% from mid on");
      add("strategy-at-least-24", s.strategy, HARD.strategyAtLeastFromMid, Infinity, "strategy at least 24% from mid on");
    }
  }
  return out;
}


/** In or out of its band, for the nightly table: "ok" or "OUT". */
export function inBand(phase: Phase, kind: Kind, value: number): boolean { const [lo, hi] = BANDS[phase][kind]; return value >= lo && value <= hi; }
export const fmtShare = (s: Share): string => `${s.bonding.toFixed(1)}/${s.strategy.toFixed(1)}/${s.gossip.toFixed(1)}/${s.conflict.toFixed(1)} n${s.n}`;
