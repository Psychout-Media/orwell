import { it, expect } from "vitest";
import { playMixGame, mixShares, type MixScene } from "../support/houseMixDriver";

/**
 * The RUNAWAY guard for the late game (ORW-350 / ORW-353). Ryne, 2026-11-14: the late season SHOULD run more scheming and gossip than week 1 when the house calls for it ("it should depend on what's happening in the house; week 1 should not be the
 * peak"), so this is NOT a parity check against the week-1 mix (that is `tests/uat/houseMixGuard.test.ts`, the 12-season week-1 guard (ORW-551)). It fails only when ONE activity swallows the house, or when the drama has no
 * goal or vote behind it:
 *   - late gossip above 60% (the broken game read 65-81%: every hour went to the strongest goal, which was a get-them-out campaign, and bonding all but vanished),
 *   - late bonding under 10%, or conflict above 30%, or strategy above 75% (nothing but one thing),
 *   - late conflict with NO goal source: the house fights only over chores (A's live week read 16 of 16 conflict scenes as chore fights, none from a goal), checked as at least one `confront` among the late conflict scenes or at least one alliance betrayal.
 * It reads NPC life regardless of the player's status (only 3-5 of 12 seeds still have the player in by the last window, so a played-only window was 3 seeds of noise). 10 seeds x 800 chat-paced messages, deterministic.
 * Thresholds, from the 12-seed data (the per-seed late read ranges bonding 25-64, strategy 10-60, gossip 0-38, conflict 0-14; pooled it reads 32-40 / 37-42 / 13-16 / 9-10, the pre-fix game 17 / 13 / 65-81 / 5): wide enough to pass any healthy
 * season shape, tight enough to be red on the pre-#2627 state.
 */
const SEEDS = [1, 2, 3, 4, 5]; // ORW-518: five seeds at the faster pace read well over the floor (the old ten at the old pace read ~360, from one lucky seed)
const MESSAGES = 450;
const WINDOW = 200;
/** ORW-518: at the week-1 guard's pace (an advance every 12th message) a played week runs ~400 messages, so the late window held scenes only for the one seed whose player was evicted early (a spectator season fast-forwards) and the "enough scenes" floor passed or failed on THAT seed's trajectory. Advancing every 4th message (450 messages, five seeds) lets every seed reach the late weeks in ~1.5 minutes. Thresholds and floor are unchanged. */
const ADVANCE_EVERY = 4;

it("no activity swallows the late-game house, and its conflict has goal or vote sources", async () => {
  const all: MixScene[] = [];
  let betrayals = 0;
  for (const seed of SEEDS) { const g = await playMixGame(seed, MESSAGES, { advanceEvery: ADVANCE_EVERY }); all.push(...g.scenes); betrayals += g.betrayals; }
  const lateScenes = all.filter((s) => s.msg >= MESSAGES - WINDOW);
  const late = mixShares(lateScenes);
  const playedLate = mixShares(lateScenes.filter((s) => !s.playerOut)); // while the player is still in: the window the drift was found in (a spectator's house reads differently: gossip 38 vs 65 in the broken game)
  const confronts = lateScenes.filter((s) => s.type === "conflict" && s.action === "confront").length;
  console.log(`MIXLATE late(${MESSAGES - WINDOW}-${MESSAGES - 1}) all ${JSON.stringify(late)} played ${JSON.stringify(playedLate)} conflict: confront ${confronts}, other ${lateScenes.filter((s) => s.type === "conflict").length - confronts}; betrayals ${betrayals}`);
  expect(late.n, "enough late scenes to read a mix").toBeGreaterThan(300);
  const runaway = (name: string, m: ReturnType<typeof mixShares>): void => {
    expect(m.gossip, `${name} gossip is ${m.gossip.toFixed(1)}%: one activity is swallowing the house (the broken game read 65-81 while the player was in)`).toBeLessThanOrEqual(60);
    expect(m.bonding, `${name} bonding is ${m.bonding.toFixed(1)}%: nobody is just living any more (the broken game read 17)`).toBeGreaterThanOrEqual(10);
    expect(m.strategy, `${name} strategy is ${m.strategy.toFixed(1)}%`).toBeLessThanOrEqual(75);
    expect(m.conflict, `${name} conflict is ${m.conflict.toFixed(1)}%`).toBeLessThanOrEqual(30);
  };
  runaway("late (all NPC life)", late);
  if (playedLate.n >= 100) runaway("late (player still in)", playedLate);
  if (late.conflict > 0) expect(confronts + betrayals, "the late house's conflict has a goal or a vote behind it (a confrontation, or an alliance betrayal), not only chore fights").toBeGreaterThan(0);
}, 900_000);
