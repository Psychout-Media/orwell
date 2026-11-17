/**
 * Feature 0174 (Theme 3 slice 13) - triad and swing-vote tunables. ENGINE-ONLY: none of these ever crosses to the player, and nothing here is shown as a number.
 * Every move is small, bounded and keyed; the drift is a nudge on the existing edges through the proven fold, never a new relationship model.
 */
export const TRIADS = {
  /** A holder counts someone as an ENEMY when their threat read is at or above this (the baseline is 0.1)... */
  enemyThreat: 0.45,
  /** ...or when the bond record reports at least this much resentment. */
  enemyResentment: 0.35,
  /** Each holder keeps their strongest few enemies / friends only, so the triples stay few. */
  enemiesPerHolder: 2,
  friendsPerHolder: 3,
  /** A holder counts someone as a FRIEND at or above this tie strength (the house graph's own tie threshold is 0.5). */
  friendBar: 0.45,
  /** Two friends of one person who barely know each other: their mutual tie is below this. */
  strangersBelow: 0.3,
  /** A daily step happens on this keyed roll, per pair. */
  stepProb: 0.5,
  /** At most this many pair nudges per in-game day (the whole house). */
  maxPerDay: 4,
  /** One nudge: affinity (and half as much trust) toward the other, through `applyImpactDirected`. */
  nudge: 0.012,
  /** A pair never drifts more than this in total over the season (kept for good, bounded). */
  driftCap: 0.1,
  /** An unbalanced triad cools the center's affinity toward the one they like less by this much (their bond to the weaker side gives way). */
  strain: 0.012,
} as const;

export const SWING = {
  /** A vote is close when the other voters leave it within this many votes: one ballot can change who leaves. */
  closeMargin: 2,
  /** At most this many swing voters are courted per eviction. */
  maxCourted: 2,
  /** A camp's pitch to a swing voter lands on this keyed roll: base plus this share of how close the pitcher is to them. */
  pitchBase: 0.35,
  pitchBond: 0.6,
  /** What a landed pitch moves in the swing voter's read of the pitcher (before the price): trust and affinity up, threat down. */
  gain: 0.03,
  /** The price a camp pays rises with the rival bidders: this many favors owed per pitcher at one rival, capped. */
  priceCap: 3,
} as const;
