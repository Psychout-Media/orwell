/**
 * Feature 0095 — the single tunable module for the pre-show-tie REVEAL pathways (the `GOSSIP` /
 * `CONFIDENCE` / `SEEDED_TIE_SURFACING` sibling — the B59 grep gate covers it). Every gate + the
 * per-season exposure cap the reveal pathways read live here; no magic number at a call site.
 *
 * SCOPE: this governs the pre-show-TIE reveal (0095) — a SEPARATE, distinct gate/rng stream from 0059
 * §5's `SEEDED_TIE_SURFACING` (`seededRelationshipConstants.ts`), which deliberately produces only
 * AMBIENT "these two seem close" suspicion and never confirms the sealed connection or folds a
 * betrayal-grade consequence. 0095 is the reveal that actually lets the sealed fact come out and pay
 * off — a new, separate pathway, not a mode of §5's scheduler.
 *
 * CALIBRATION (sacred — mandate #4): every roll is on a DEDICATED rng (never the shared society/
 * competition/vote stream), and the whole pathway is behind a default-ON flag (`=0` opts out)
 * (`ORWELL_TIE_REVEAL`). Off (the default, and the state the seeded juryReach/gradient/UAT sims run
 * in) ⇒ zero draws, zero folds, zero exposures — byte-identical to the pre-feature build.
 */
export interface TieRevealConstants {
  /**
   * Per-tick chance the OVERHEAR pathway fires for a tie whose pair is conspicuously holed up together
   * (mirrors `PRIVACY.whisperProb` / `SEEDED_TIE_SURFACING.noticeProb`'s restraint) — rare; most ticks
   * nothing rises even when a pair is observably close.
   */
  overhearProb: number;
  /**
   * The mutual-affinity floor a tie's pair must reach before they are conspicuous enough to be OVERHEARD
   * at all (mirrors `SEEDED_TIE_SURFACING.observableAffinity`) — a tie that hasn't warmed into the open
   * is never a candidate, never week-one, never from the seed alone.
   */
  conspicuousAffinity: number;
  /** HARD per-season cap on ties that are ever EXPOSED (promoted past `sealed`) by ANY pathway. */
  maxExposuresPerSeason: number;
  /**
   * The (Vault-free) confidence the DIRECT witness (an onlooker who overheard, or an accuser who landed
   * a hit) holds — near-certain, since they saw or confirmed it themselves. Diffused hops decay from
   * here via the existing `GOSSIP.decay`.
   */
  directWitnessConfidence: number;
}

export const TIE_REVEAL: TieRevealConstants = {
  overhearProb: 0.06,
  conspicuousAffinity: 0.7,
  maxExposuresPerSeason: 2,
  directWitnessConfidence: 0.85,
};
