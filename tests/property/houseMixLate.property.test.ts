import { it, expect } from "vitest";
import { playMixGame, mixShares, type MixScene } from "../support/houseMixDriver";

/**
 * The house-life mix guard for the LATE game (ORW-350). `houseMixGuard.test.ts` reads only the first 360 messages, so it could not see this class of drift: as goals pile up and their commitments climb past the pull of ordinary life
 * (get-them-out 0.54 early, 0.85+ by week 2), every hour became a goal hour and the house turned into scheming. On 12 chat-paced seeds, played scenes only, by 200-message window the mix went (bonding / strategy / gossip / conflict):
 * 55/25/13/7, 47/30/17/5, 34/42/21/4, then 18/8.5/69/4 in the last window, found by a live week and a manual read, not by any test. After the goal-hour ceiling and the vote-counting steps: 26/22/43/9 there.
 * This plays 10 seeds long and holds the last played window to a floor on bonding and strategy and a ceiling on gossip and conflict, ratcheted to the measured level (see the thresholds), so the old 18/8.5/69 fails and so does the first fix's 25% late gossip. It also checks the FIRST window of
 * the long game is unchanged in kind (the early game must not have been traded away to fix the late one).
 */
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const MESSAGES = 800;
const WINDOW = 200;

it("the played late-game house-life mix keeps its bonding and strategy and does not turn into gossip", async () => {
  const all: MixScene[] = [];
  for (const seed of SEEDS) all.push(...(await playMixGame(seed, MESSAGES)).filter((s) => !s.playerOut));
  const late = mixShares(all.filter((s) => s.msg >= MESSAGES - WINDOW));
  const early = mixShares(all.filter((s) => s.msg >= 200 && s.msg < 400));
  console.log(`MIXLATE early(200-399) n=${early.n} ${JSON.stringify(early)}  late(${MESSAGES - WINDOW}-${MESSAGES - 1}) n=${late.n} ${JSON.stringify(late)}`);
  expect(late.n, "enough played late scenes to read a mix").toBeGreaterThan(100);
  // Ratcheted to the level measured after ORW-350 step 2 (seeds 1-10, deterministic: late 56 / 29 / 13 / 2, early 51 / 25 / 19 / 4.5, against the agreed 48 / 29 / 17 / 4), each with a margin that absorbs a seeded
  // reshuffle but not a return of the drift: the first fix alone read late 48 / 18 / 25 / 9, the broken game 17 / 13 / 65 / 5. Tighten again, never loosen, when a step lands.
  expect(late.gossip, `late gossip is ${late.gossip.toFixed(1)}% (agreed 17; the broken game read 65-69)`).toBeLessThanOrEqual(22);
  expect(late.bonding, `late bonding is ${late.bonding.toFixed(1)}% (agreed 48; the broken game read 17)`).toBeGreaterThanOrEqual(45);
  expect(late.strategy, `late strategy is ${late.strategy.toFixed(1)}% (agreed 29; the broken game read 9-13)`).toBeGreaterThanOrEqual(20);
  expect(late.conflict, `late conflict is ${late.conflict.toFixed(1)}% (agreed 4)`).toBeLessThanOrEqual(8);
  expect(early.gossip, `early gossip ${early.gossip.toFixed(1)}%`).toBeLessThanOrEqual(24);
  expect(early.bonding, `early bonding ${early.bonding.toFixed(1)}%`).toBeGreaterThanOrEqual(44);
  expect(early.strategy, `early strategy ${early.strategy.toFixed(1)}%`).toBeGreaterThanOrEqual(19);
}, 900_000);
