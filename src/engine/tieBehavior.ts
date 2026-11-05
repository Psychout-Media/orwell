import type { TieNature } from "./seededRelationships";

/**
 * B41 (#2017 design S5, PURE ONLY - NOT wired into any decision) - how a pre-game tie's NATURE shapes DECISIONS. Every term is a bounded decision term (nomination, eviction vote, scenes);
 * there is deliberately NO competition term, so a tie can never change competition odds (the PO rule; `TieBehavior` has no such field and the test pins it). The default for a nature with no
 * dedicated behaviour is all-zero ("flavour only", today's calibration-neutral state). Using this table WILL move balance, so wiring it needs Ryne's separate balance call (the #1909 note) and its own
 * flag; this item only lands the table, its bounds and its tests. All magnitudes are in `TIE_BEHAVIOR_LIMITS` / the table below (one module). Values are ASSUMED starting points, pending Ryne.
 */
export interface TieBehavior {
  /** Added to the HOH's nomination score of the tie partner (negative = shield). Applies only where the HOH KNOWS the tie. */
  nominationPush: number;
  /** Added to the eviction-vote score against the partner (negative = keep). */
  votePush: number;
  /** Awkwardness added to a scene the pair shares (a scene/presence effect, never a vote effect). */
  sceneAwkwardness: number;
  /** For an old friend: how many aimed-at-the-friend moves by believed allies flip them; 0 = never flips. */
  pressureFlipAt: number;
}

export const TIE_BEHAVIOR_LIMITS = { nominationPush: 0.3, votePush: 0.3, sceneAwkwardness: 0.5, maxPressureFlip: 5 } as const;

const NONE: TieBehavior = { nominationPush: 0, votePush: 0, sceneAwkwardness: 0, pressureFlipAt: 0 };

export const TIE_BEHAVIOR: Readonly<Record<TieNature, TieBehavior>> = {
  "casting-callback": NONE, "mutual-friend": NONE, "shared-hometown": NONE, "old-acquaintance": NONE, "prior-romance": NONE,
  "former-teammate": NONE, "online-acquaintance": NONE,
  /** Family: a protective shield in nominations and a high vote-keep. */
  family: { nominationPush: -0.3, votePush: -0.3, sceneAwkwardness: 0, pressureFlipAt: 0 },
  /** Rival: a targeting push and a referendum-style vote penalty. */
  rival: { nominationPush: 0.25, votePush: 0.25, sceneAwkwardness: 0, pressureFlipAt: 0 },
  /** Ex: ambivalence - neither targets nor protects; the effect is awkwardness in scenes. */
  ex: { nominationPush: 0, votePush: 0, sceneAwkwardness: 0.4, pressureFlipAt: 0 },
  /** Old friend: loyal (a mild shield) until enough moves aimed at the friend by believed allies pile up, then they flip. */
  "old-friend": { nominationPush: -0.15, votePush: -0.15, sceneAwkwardness: 0, pressureFlipAt: 3 },
};

/** The shield/push an old friend actually applies: loyal until `pressure` (aimed-at-the-friend moves by believed allies) reaches the flip point, then 0 (the shield is gone). Pure, monotone in pressure. */
export function oldFriendShield(base: number, pressure: number, pressureFlipAt: number): number {
  if (pressureFlipAt <= 0) return base;
  return pressure >= pressureFlipAt ? 0 : base;
}
