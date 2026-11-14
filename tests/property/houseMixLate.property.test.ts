import { it, expect } from "vitest";
import { playMixGame, mixShares, type MixScene } from "../support/houseMixDriver";

/**
 * The house-life mix guard for the LATE game (ORW-350). `houseMixGuard.test.ts` reads only the first 360 messages, so it could not see this class of drift: as goals pile up and their commitments climb past the pull of ordinary life
 * (get-them-out 0.54 early, 0.85+ by week 2), every hour became a goal hour and the house turned into scheming. On 12 chat-paced seeds, played scenes only, by 200-message window the mix went (bonding / strategy / gossip / conflict):
 * 55/25/13/7, 47/30/17/5, 34/42/21/4, then 18/8.5/69/4 in the last window, found by a live week and a manual read, not by any test. After the goal-hour ceiling and the vote-counting steps: 26/22/43/9 there.
 * This plays 10 seeds long and holds the last played window to a floor on bonding and strategy and a ceiling on gossip, loose enough for a small sample, tight enough that the old 18/8.5/69 fails. It also checks the FIRST window of
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
  expect(late.gossip, `late gossip is ${late.gossip.toFixed(1)}% (the broken game read 69%)`).toBeLessThanOrEqual(55);
  expect(late.bonding, `late bonding is ${late.bonding.toFixed(1)}% (the broken game read 18%)`).toBeGreaterThanOrEqual(20);
  expect(late.strategy, `late strategy is ${late.strategy.toFixed(1)}% (the broken game read 8.5%)`).toBeGreaterThanOrEqual(12);
  expect(early.gossip, `early gossip ${early.gossip.toFixed(1)}%`).toBeLessThanOrEqual(30);
  expect(early.bonding, `early bonding ${early.bonding.toFixed(1)}%`).toBeGreaterThanOrEqual(38);
}, 900_000);
