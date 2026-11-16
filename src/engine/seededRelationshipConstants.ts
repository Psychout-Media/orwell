/**
 * Feature 0059 §5 — the organic SURFACING scheduler tunables for the hidden seeded-relationship layer
 * (pre-game ties + showmances). The single home for every magnitude the per-tick tie scheduler reads,
 * in the sibling-constants pattern (`relationshipConstants` / `threadConstants` / `presenceConstants`):
 * no magic number at a call site, all God-Mode-knobbable later (0016 count-only).
 *
 * SCOPE: these govern only the PRE-GAME-TIE surfacing scheduler (§5). The SHOWMANCE arc
 * (spark→bond→visible) is carried by `SHOWMANCE_BOND_AFFINITY` / `SHOWMANCE_VISIBLE_AFFINITY` in
 * `seededRelationships.ts` and surfaces at `visible` (a PUBLIC house fact) — that half ships in the
 * 0059 core. What was DEFERRED, and lives here, is the tie's organic DISCOVERY: a careful observer
 * notices two houseguests are unusually close / seem to already know each other, recorded as an
 * ordinary 0002 belief — never the sealed `nature`, never a banner.
 *
 * CALIBRATION (sacred — mandate #4): every roll the scheduler makes is on a DEDICATED rng (never the
 * shared society/competition/vote stream), and the whole scheduler is behind a default-ON flag (`=0` opts out)
 * (`ORWELL_SEEDED_TIE_SURFACING`). With the flag off — the default, and the state the seeded juryReach /
 * gradient / UAT sims run in — `advanceSeededTies` returns immediately, drawing nothing and folding
 * nothing, so the off-screen draw count/order and every seeded outcome are BYTE-IDENTICAL to the
 * pre-feature build (`tests/unit/seededTieSurfacing.test.ts` is the neutrality gate). The discovery
 * FOLD (§5 — a discovered tie shifts third-party reads via 0023) moves edges, so it is reachable ONLY
 * behind the flag; it never runs in the calibration baseline.
 */
export interface SeededTieSurfacingConstants {
  /**
   * Per-tick chance the house NOTICES a seeded pre-game tie that has grown OBSERVABLE (the pair's mutual
   * affinity sits at/above `observableAffinity`). Rare — most ticks nothing rises, and a tie that hasn't
   * warmed into the open is never noticed at all. Mirrors `PRIVACY.whisperProb`'s restraint.
   */
  noticeProb: number;
  /**
   * The mutual-affinity floor a pre-game tie must reach before it is OBSERVABLE at all. A seeded tie
   * starts with only the small `TIE_AFFINITY_BIAS` head start (well below this), so the two must have
   * genuinely grown close in the house before any onlooker could read it — never week-one, never from
   * the seed alone. Below it the tie stays fully Vault-sealed (the player may suspect, never know).
   */
  observableAffinity: number;
  /**
   * OF a noticed tie, the chance the observation reaches the PLAYER this tick (vs. staying NPC↔NPC
   * gossip). Surfacing to the player is rarer still (§5.2) — most of the house's noticing stays among
   * the NPCs and the player catches a tie only if a chain terminates at them. Mirrors
   * `THREAD.surfaceToPlayerProb`'s discipline (a minority of surfacings reach the player).
   */
  surfaceToPlayerProb: number;
  /**
   * HARD cap on seeded ties that ever SURFACE TO THE PLAYER in a season — the L40-style restraint (not
   * every hidden tie pays off to the player). Once spent, the house may still whisper among the NPCs,
   * but no further tie crosses to the player this season. Tiny: there are only 0–2 ties to begin with.
   */
  maxPlayerSurfacesPerSeason: number;
  /**
   * The (Vault-free) confidence a tie observation carries when it reaches the player — a read of
   * behavior ("they seem unusually tight"), never a confirmed fact. Below the witnessed-fact ceiling so
   * the player holds it as a soft belief they form paranoia/trust around themselves (0017).
   */
  surfacedConfidence: number;
}

export const SEEDED_TIE_SURFACING: SeededTieSurfacingConstants = {
  noticeProb: 0.2,
  observableAffinity: 0.7,
  surfaceToPlayerProb: 0.35,
  maxPlayerSurfacesPerSeason: 2,
  surfacedConfidence: 0.45,
};
