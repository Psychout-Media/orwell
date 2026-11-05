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
