import type { MemoryKind } from "./npcMemory";

/**
 * B27 / ORW-130 (flag ORWELL_FORGIVENESS, ON) - FORGIVENESS comes from the HOUSEGUEST and the RELATIONSHIP, not a coin. Ryne (2026-11-06): "this should depend on the houseguests and the relationship more than just
 * random odds". Every weight is HERE so Ryne can retune in one place; the rule below is ASSUMED, pending Ryne (readable on purpose, no randomness at all - a pure function of state).
 *
 * For each (holder, subject) pair the holder either HOLDS A GRUDGE (a real betrayal never reads older than `floorAgeWeeks`) or lets it fade as memory always has. Everyone also lets FAVORS fade `favorFade` times
 * faster unless they hold the grudge. The decision is `holdScore >= holdAt`, where holdScore adds these plain-word terms:
 *  - TEMPERAMENT: how they play and feel. A hard-edged player (aggressive, strategic) holds on; a warm one (loyal, social) lets go (`style` table), and a volatile temperament runs hotter (`volatility`).
 *  - HOW BAD: the worst betrayal on record (`severity`) - the worse it was, the harder to forgive.
 *  - AGAIN: each betrayal beyond the first is a pattern, not an accident (`repeat`, capped).
 *  - FAVORS: a history of kindness from the same person softens it (`favor`, capped).
 *  - CLOSENESS: a close friend's betrayal cuts DEEPER for a hard-edged player and is forgiven EASIER by a warm one: closeness is multiplied by the style's sign (`closeSign`). Closeness is read from the holder's
 *    current bond with the subject, the nearest thing the engine keeps to "how close they were" (ASSUMED proxy: the pre-betrayal bond is not stored).
 */
export const FORGIVENESS = {
  /** Hold the grudge when the score reaches this. */
  holdAt: 0.55,
  /** A held real betrayal never reads older than this many weeks (so it keeps at least severity x 0.5^(floorAgeWeeks / halfLife)). */
  floorAgeWeeks: 3,
  /** Everyone who is NOT holding a grudge lets FAVORS age this many times faster (1 = today). */
  favorFade: 2,
  /** Base term for how the holder plays (0..1): hard-edged hold on, warm let go. Unknown style => `styleDefault`. */
  style: { aggressive: 0.5, strategic: 0.4, "under-the-radar": 0.25, emotional: 0.25, loyal: 0.05, social: 0.0 } as Readonly<Record<string, number>>,
  styleDefault: 0.2,
  /** Added in proportion to the holder's volatility (0..1). */
  volatility: 0.25,
  /** Added in proportion to the worst betrayal's severity (0..1). */
  severity: 0.3,
  /** Added per betrayal beyond the first, up to `repeatMax` of them. */
  repeat: 0.1,
  repeatMax: 3,
  /** Subtracted in proportion to the total favor severity on record, capped at `favorMax` of it. */
  favor: 0.2,
  favorMax: 1.5,
  /** Closeness (0..1) is multiplied by this per style: + a friend's betrayal cuts deeper, - it is forgiven easier. */
  closeness: 0.3,
  closeSign: { aggressive: 1, strategic: 1, "under-the-radar": 1, emotional: 0.5, loyal: -1, social: -1 } as Readonly<Record<string, number>>,
  /** Which memory kinds are a REAL betrayal. */
  betrayalKinds: ["deal-broken", "scene-betrayal"] as readonly MemoryKind[],
  /** Which kinds are favors. */
  favorKinds: ["veto-saved", "deal-kept", "scene-kindness"] as readonly MemoryKind[],
} as const;
