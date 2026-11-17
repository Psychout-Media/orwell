/**
 * Feature 0177 - house graph tunables. Engine-only; none of these ever crosses to the player.
 * Strengths are closeness in [0, 1] as the bond layer reports them (never shown as numbers).
 */
export const HOUSE_GRAPH = {
  /** A pair counts as TIED when their symmetrized closeness is at or above this. */
  tieThreshold: 0.5,
  /** A clique is a maximal group of at least this many mutually tied members. */
  cliqueMinSize: 3,
  /** A hub has at least this many ties, and at least hubShare of the rest of the house. */
  hubMinDegree: 4,
  hubShare: 0.4,
  /** A loner has at most this many ties and sits in no clique. */
  lonerMaxDegree: 1,
  /** A broker needs at least this many ties into each of two cliques that share no one else. */
  brokerMinLinks: 2,
} as const;
