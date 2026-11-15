import { GOSSIP } from "./gossip";

/**
 * Feature 0100 — the JURY-HOUSE grudge magnitudes (the SINGLE tunable for the sequestered second
 * society, mirroring `juryConstants.ts` / `gossip.ts`'s `GOSSIP` / `offscreen.ts`'s `SOCIETY`).
 * **Every number the jury-house stretch + the grudge fold use lives here** (the B59 grep gate: each
 * constant has a real consumer in `juryHouse.ts` / the adapter's `juryHouseTick`).
 *
 * Sizing discipline (the 0086 ruling-#1 lesson): the bounded grudge adjustment is sized *under* the
 * eviction-MANNER lean it deepens — a fully-SATURATED grudge moves a juror's finale lean by strictly
 * less than a single recorded grievance manner (`MANNER_LEAN.betrayed × JURY_WEIGHTS.manner`). So the
 * jury house SHARPENS an already-bitter jury and pays off a clean exit; it never becomes a second flat
 * knob that swamps how the game actually went. The player never sees any of these (mandate #2 / 0020).
 *
 * The grudge is BOUNDED + MONOTONIC + SATURATED so it can never run away over a long sequester
 * (mandate #4 — it accumulates and deepens, but caps): each diffusion hop that reaches a juror adds a
 * confidence-scaled increment, the per-juror total is clamped to `adjustmentCap`, and it persists with
 * the season so a restored game resumes with the accumulated bitterness intact (never re-rolled).
 */
export const JURY_HOUSE = {
  /**
   * Hidden juror↔juror scenes per sequestered off-screen tick — the default for direct callers of
   * `runJuryHouseStretch`. The live adapter instead runs ONE stretch per new juror arrival with
   * `scenesPerArrival` scenes (below).
   */
  scenesPerTick: 2,
  /**
   * Owner ruling 2026-11-02 (#1922): the jury house is a FAST-FORWARD LIMBO, like the show — not a focus
   * of the game and never a drag on it. It advances once each time a new juror enters (about once a
   * week), with 1–3 hidden juror scenes, instead of on every off-screen tick. Inclusive bounds.
   */
  scenesPerArrival: { min: 1, max: 3 },
  /**
   * Grievance retelling rounds in one arrival stretch. A stretch now stands in for about a week of
   * sequester (it used to run every off-screen tick at `rounds` per tick), so the word spreads further
   * per stretch. The grudge each juror takes is still once per stretch and saturates at `adjustmentCap`.
   */
  roundsPerArrival: 6,
  /**
   * The grudge DIFFUSION transmit/decay over the jury-house affinity graph — reuse `GOSSIP`'s proven
   * shape (open-question §2 default) so a grievance spreads with the SAME low per-edge transmission,
   * decaying confidence, and bounded hop count main-house gossip uses. A grievance one juror carries
   * out can reach a second along their bond, but distorted and lower-confidence with each retelling.
   */
  transmitProb: GOSSIP.transmitProb,
  decay: GOSSIP.decay,
  rounds: GOSSIP.rounds,
  /** Affinity above this makes a jury-house social-graph edge (who talks to whom) — same as `GOSSIP`. */
  affinityEdge: GOSSIP.affinityEdge,
  /**
   * The PER-HOP grudge increment when a grievance belief about the player REACHES a juror, BEFORE the
   * confidence scale. A high-confidence (close-source) grievance lands near this; a fifth-hand whisper
   * barely registers (× its decayed confidence). Sized so several hops are needed to approach the cap —
   * the bitterness compounds over sequester, it does not arrive in one telling.
   */
  grudgePerHop: 0.06,
  /**
   * The bounded per-juror grudge-adjustment CAP (saturation) — a juror's accumulated jury-house grudge
   * can never lower their finale read of the responsible finalist by more than this. Sized strictly
   * UNDER a single recorded grievance manner so it DEEPENS the eviction-manner baseline, never swamps
   * it. The `juryHouse.test.ts` sizing-discipline gate pins `adjustmentCap < |MANNER_LEAN.betrayed|`.
   */
  adjustmentCap: 0.18,
} as const;


/**
 * #1790 — the JUROR-BEARING tier thresholds (the B59 rule: every jury-house number is defined here).
 * Maps a grudge value on the bounded grudge scale (0..`adjustmentCap`) to a bearing word via an
 * ordered threshold table. Each tier has a lower bound (inclusive) so the mapper reads
 * "first highest threshold whose min <= clamped value".
 *
 * Grudge scale (0..0.18, cap `adjustmentCap:0.18`):
 *   settled: < 0.02 (includes negative/zero — clamp input to 0)
 *   cold:    0.02–0.07
 *   warm:    0.07–0.13
 *   burning: >= 0.13
 */
export const BEARING_THRESHOLDS = [
  { min: 0,    word: 'settled' },   // [0, 0.02)
  { min: 0.02, word: 'cold' },      // [0.02, 0.07)
  { min: 0.07, word: 'warm' },      // [0.07, 0.13)
  { min: 0.13, word: 'burning' },   // [0.13, ∞)
] as const;

/** The upper bound for the last tier (adjustment cap — grudge never exceeds this). */
export const BEARING_MAX = 0.18;

/**
 * ORW-110: how a juror's recorded MANNER toward a finalist (how they were treated on the way out) sets a floor on the finale "bearing" word. The jury-house grudge never carries the juror who took the
 * grievance out of the house, so the manner is read too and the LARGER of the two wins. Values sit on the BEARING_THRESHOLDS tiers (0.07 = "warm" anger, 0.13 = "burning"). ASSUMED, pending Ryne.
 */
export const MANNER_GRUDGE = { disrespected: 0.07, wronged: 0.13 } as const;
