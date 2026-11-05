import type { MemoryKind } from "./npcMemory";

/**
 * B27 (#2017 design 14.5 M6, flag ORWELL_FORGIVENESS, off by default) - the FORGIVENESS trait. Every magnitude is HERE so Ryne can retune in one place. ASSUMED, pending Ryne (design 14.10):
 * about 1 houseguest in 6 is a GRUDGE-KEEPER - a real betrayal never fades below a floor for them; everyone else lets FAVORS fade fast. The trait is seeded per houseguest, hidden, and shown only
 * through behaviour (it never crosses to the player, and is not persisted: it is a pure function of the game seed and the houseguest id).
 */
export const FORGIVENESS = {
  /** The share of houseguests who are grudge-keepers (ASSUMED 1 in 6). */
  grudgeKeeperShare: 1 / 6,
  /** A keeper's REAL betrayals never read older than this many weeks (so they keep at least severity x 0.5^(floorAgeWeeks / halfLife)). */
  floorAgeWeeks: 3,
  /** Everyone else's favors age this many times faster (1 = today). */
  favorFade: 2,
  /** Which memory kinds are a REAL betrayal (the ones a keeper never lets go of). */
  betrayalKinds: ["deal-broken", "scene-betrayal"] as readonly MemoryKind[],
  /** Which kinds are favors (the ones everyone else lets fade fast). */
  favorKinds: ["veto-saved", "deal-kept", "scene-kindness"] as readonly MemoryKind[],
} as const;
