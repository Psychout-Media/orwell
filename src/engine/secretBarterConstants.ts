/**
 * Feature 0099 (hidden half) — the off-screen NPC↔NPC SECRET-BARTER tunables. The SINGLE tunable home
 * (the `JURY_HOUSE` / `LEGEND` / `GOSSIP` single-tunable-module pattern; the B59 grep gate covers this
 * file like its siblings). Every magnitude the off-screen barter TICK DRIVER
 * (`GameSessionAdapter.secretBarterTick`) reads lives HERE — no magic number at the call site.
 *
 * IMPORTANT — this module bounds only the TICK, not the trade math. The barter REUSES the existing 0099
 * value core verbatim: `tradeValue` in `src/engine/leverage.ts` (the same function `npcBarterStep`
 * wraps), whose value threshold + firing rate + bond fold live in `SECRET_TRADE` (`leverageConstants.ts`,
 * `barterValueFloor` / `barterRate` / `barterBondFold`). This feature adds NO new secrets system and no
 * new value math — it only DRIVES the existing core on a bounded off-screen tick. So the only knobs here
 * are how much of the knowledge economy one tick may churn.
 *
 * Calibration (mandate #3 / ADR 0005): the whole layer is gated by a default-ON flag (`ORWELL_SECRET_BARTER=0` opts out),
 * runs on a DEDICATED, isolated side-rng, and — exactly like `legendTick` — folds NO relationship edge
 * (only the hidden KNOWLEDGE layer changes). So with the flag off NOTHING runs (zero draws ⇒ the seeded
 * competition/vote/jury spine is byte-identical), and even ON the shared stream is never advanced
 * (`tests/unit/secretBarterNeutral.test.ts` is the gate).
 */
import type { MemoryKind } from "./npcMemory";

export const SECRET_BARTER = {
  /**
   * HARD cap on how many secrets change hands per off-screen tick — information is liquid, but the house
   * is not a bourse. Bounded so a single tick can never cascade the whole knowledge layer (the B54/UAT
   * volume lesson: every transfer is a recorded event). Secrets move steadily, a couple at a time.
   */
  maxBartersPerTick: 2,
  /**
   * HARD cap on how many distinct holders the driver scans per tick (deterministic sorted order). A bound
   * on work, not just output: even in a knowledge-rich late game the driver looks at a bounded slice of
   * the house each tick rather than every holder × every held secret. `maxBartersPerTick` still caps the
   * transfers; this caps the scan so a large cast stays cheap and the dedicated draw stream stays short.
   */
  maxHoldersPerTick: 6,
} as const;

/**
 * ORW-688 - the houseguest's own BRAKE on trading (`ORWELL_BARTER_APPETITE`, default ON, played games only). With rumors now carrying who
 * they are about, barter fires about three times as often as it did; the brake brings it back without a fixed cap, by reading what the
 * houseguest has been through. It scales the fire chance AFTER the dedicated stream's draws (so the stream stays byte-identical), by
 * `appetite = 1 / (1 + satietyWeight x sated) x (1 - burnWeight x burn)`, both parts pure reads of recorded state.
 */
export const BARTER_APPETITE = {
  /**
   * How fast the appetite for trading comes back, in off-screen ticks (one per player turn): a houseguest's trading count halves every this
   * many ticks. A secret just spent is a bargaining chip gone; a houseguest trades again once the house has moved on, slowly.
   */
  satietyHalfLifeTicks: 240,
  /** How hard each recent barter weighs: one fresh trade cuts the next fire chance to 1/(1+this) of its rate; two, 1/(1+2x this). */
  satietyWeight: 12,
  /** How much a houseguest who was burned holds back: the most the fire chance drops for a fully salient burn (0..1; a burned houseguest still trades, warily). */
  burnWeight: 0.6,
  /**
   * What counts as being burned: a broken deal, an exposed secret, a betrayal in a scene, a deal made behind their back. Read from the NPC memory
   * ledger (salience fades with the holder's own temperament, so a grudge-holder stays wary longer). A kindness never speeds trading up: the brake only brakes.
   */
  burnKinds: new Set<MemoryKind>(["deal-broken", "secret-exposed", "scene-betrayal", "deal-resented"]),
} as const;

/** The pure appetite (0..1): `sated` is the holder's decayed recent trade count, `burn` the 0..1 salience of what burned them. */
export function barterAppetite(sated: number, burn: number): number {
  const s = Math.max(0, Number.isFinite(sated) ? sated : 0);
  const b = Math.min(1, Math.max(0, Number.isFinite(burn) ? burn : 0));
  return (1 / (1 + BARTER_APPETITE.satietyWeight * s)) * (1 - BARTER_APPETITE.burnWeight * b);
}
