import { mixShares, MIX_KINDS, type MixScene } from "./houseMixDriver";

/**
 * ORW-702: the WHOLE-SEASON house-life mix target and the machinery that measures a played season against it. ONE module: the band numbers, the hard rules and the
 * KNOWN_RED ratchet live only here (the guard test, the nightly report and the unit tests all read it).
 *
 * The target is the PO-agreed one of 2026-11-20 (vault note "Memory/Whole Season Mix Target Proposal.md"; card ORW-702). Shares are of house-life scenes (bonding / strategy /
 * gossip / conflict) while the player is still in the game, by season PHASE taken from the game WEEK the scene happened in (never from a message count).
 * Changing a band needs a new PO ruling; the ratchet only ever tightens (a rule leaves KNOWN_RED when it passes; it never comes back in).
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

/**
 * THE RATCHET. Every rule or band that main failed when this guard landed is listed here with the value measured then and the card that is to fix it. The guard asserts:
 *  - a rule in this table must STILL be failing (once a slice fixes it, the test fails and says to delete the line, which turns the rule into a hard assertion: never loosen);
 *  - a failing rule NOT in this table fails the test (a regression);
 *  - a listed rule must not get worse than the measured value by more than RATCHET_SLACK points.
 * The values are the pooled measurement of the seed set in tests/uat/wholeSeasonMixGuard.test.ts.
 */
export interface KnownRed { value: number; card: string }
export const KNOWN_RED: Readonly<Record<string, KnownRed>> = {
  // ORW-702 slice 1: one line left. The ten lines the surviving player's reading left red (early bonding and gossip, mid bonding, gossip and the 45 % ceiling, late bonding, strategy, gossip, conflict and the
  // 45 % ceiling) all pass now, with the friction ramp (drama builds over the season) and the gossip/strategy keep chances. Measured on the GitHub runner, 2026-11-25 (seeds 1, 2, 3, 6, player in, head f218288bb), pooled
  // bonding/strategy/gossip/conflict: early 32.4/30.9/29.3/7.5, mid 25.3/35.8/29.6/9.4, late 23.2/37.9/28.4/10.5. Mid strategy is 1.8 over its cap of 34 (Coordinator ruling 2026-11-25: land with exactly this one line);
  // the slice that removes it is ORW-702 slice 2 (the combined retune on the new casts of ORW-893 and the attraction flirts of ORW-892).
  "mid:band-strategy": { value: 35.8, card: "ORW-702 slice 2 retune" }, // band 26-34 (35.8 measured at f218288bb; 34.9 on the head that added the two lines below)
  // 2026-11-25, head 55a146399 (GitHub runner, seeds 1, 2, 3, 6, player in): pooled early 32.7/30.9/29.1/7.3, mid 26.8/34.9/28.7/9.6, late 20.6/42.4/27.8/9.3. The scripted player now plays on to the END on seeds 2 and 3 (out "never";
  // before it was out in weeks 10 and 6), so the late phase reads the endgame (finale, jury votes), which is strategy-heavy (45-47 % on those seeds): a different reading, not the rebalance misfiring (Coordinator ruling 2026-11-25).
  // ORW-702 slice 2 re-tunes on the new casts (ORW-893) and attraction flirts (ORW-892), and notes that the late band may itself need re-agreeing for a player-in endgame.
  "late:band-strategy": { value: 42.4, card: "ORW-702 slice 2 retune" }, // band 28-38
  "late:band-conflict": { value: 9.3, card: "ORW-702 slice 2 retune" }, // band 10-16
};
/** Hysteresis (Coordinator ruling 2026-11-25): a KNOWN_RED line is asked to be deleted only once its rule passes by at least this many points, so a rule that flips at its boundary from run to run does not redden unrelated PRs. The same margin applies the other way: a rule main meets (not listed) is a regression only when it misses its limit by MORE than this (Coordinator ruling 2026-11-25: 45.3 against a cap of 45 is run-to-run noise). Drift of a still-red line is already tolerated up to RATCHET_SLACK. Bands and tolerances are unchanged. */
export const RATCHET_FIXED_MARGIN = 1.0;
export const RATCHET_SLACK = 6; // points of drift past the measured value that is still noise at this many seasons; tighten as the seed set grows

export interface Verdict { regressions: string[]; fixed: string[]; worse: string[]; red: string[] }
/** Compare the evaluated rules to the table. `regressions`: failing and not listed. `fixed`: listed and now passing (move the line out). `worse`: listed, still failing, but further out than measured + slack. */
export function ratchet(results: readonly RuleResult[], known: Readonly<Record<string, KnownRed>> = KNOWN_RED, slack = RATCHET_SLACK, fixedMargin = RATCHET_FIXED_MARGIN): Verdict {
  const v: Verdict = { regressions: [], fixed: [], worse: [], red: [] };
  const byId = new Map(results.map((r) => [r.id, r]));
  for (const r of results) {
    const k = known[r.id];
    if (!r.pass && !k && r.miss > RATCHET_FIXED_MARGIN) v.regressions.push(`${r.id}: ${r.what}, measured ${r.value}`);
    if (!r.pass && k) { v.red.push(r.id); if (r.miss > missOf(r.id, k.value) + slack) v.worse.push(`${r.id}: measured ${r.value}, was ${k.value} when listed (${k.card})`); }
    if (r.pass && k && r.room >= fixedMargin) v.fixed.push(`${r.id} now passes (${r.value}): delete it from KNOWN_RED so it is asserted from now on`);
  }
  for (const id of Object.keys(known)) if (!byId.has(id)) v.fixed.push(`${id} is not evaluated (no scenes in that phase)`);
  return v;
}
/** How far a recorded value was outside the rule's limit. */
function missOf(id: string, value: number): number {
  const [phaseS, rule] = id.split(":") as [Phase, string];
  const m = /^band-(\w+)$/.exec(rule!);
  if (m) { const [lo, hi] = BANDS[phaseS][m[1] as Kind]; return value < lo ? lo - value : value > hi ? value - hi : 0; }
  if (rule === "strategy-below-50") return Math.max(0, value - HARD.strategyBelow);
  if (rule === "no-activity-above-45") return Math.max(0, value - HARD.anyActivityAtMost);
  if (rule === "conflict-at-most-16") return Math.max(0, value - HARD.conflictAtMost);
  if (rule === "gossip-at-least-22") return Math.max(0, HARD.gossipAtLeastFromMid - value);
  if (rule === "strategy-at-least-24") return Math.max(0, HARD.strategyAtLeastFromMid - value);
  return 0;
}

/** In or out of its band, for the nightly table: "ok" or "OUT". */
export function inBand(phase: Phase, kind: Kind, value: number): boolean { const [lo, hi] = BANDS[phase][kind]; return value >= lo && value <= hi; }
export const fmtShare = (s: Share): string => `${s.bonding.toFixed(1)}/${s.strategy.toFixed(1)}/${s.gossip.toFixed(1)}/${s.conflict.toFixed(1)} n${s.n}`;
