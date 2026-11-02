import type { RelationshipDisposition } from "./relationshipConstants";

/**
 * Feature 0044 — strategic nomination & vote refinements: the SINGLE tunable module (sibling to
 * `relationshipConstants.ts` / `temperatureConstants.ts`). Every magnitude the enriched
 * `nominationStrategy` (season.ts) and `voteChoice` (liveSeason.ts) read lives HERE — no magic
 * number is hard-coded at a call site (the B59 grep gate covers this file like the others).
 *
 * All terms are BOUNDED nudges layered on the threat-primary relationship read: they bend a
 * decision, they never override the 0005 hard rules (legality binds downstream of every read).
 */

/** The nomination tactic an HOH plays — gated by who they are (their static disposition). */
export type NominationTactic = "direct" | "pawn" | "backdoor";

export const DECISION = {
  nomination: {
    /** How hard a rattled HOH's paranoia bends the read toward whoever they least trust (0041). */
    paranoiaWeight: 0.5,
    /**
     * The week's POLITICAL TEMPERATURE: when the top house-wide threat outruns the median read by
     * more than this, the week is "hot" — there is a runaway threat and every HOH plays DIRECT
     * (the tactical games wait for a quiet week).
     */
    runawaySpread: 0.3,
    /**
     * Floater / duo reads (PO 2026-11-02): a floater read is 1 when the closest bond anyone holds toward
     * them is at the edge baseline, 0 once it reaches baseline + this span. How much each HOH weighs it
     * is their own NOMINATION_STYLE (below).
     */
    floaterBondSpan: 0.35,
    /**
     * Which tactic each disposition favors on a quiet week (the archetype gate): a loyalist (bond)
     * sits a PAWN beside the target and shields their own; a ruthless schemer (clash) plays the
     * BACKDOOR (bait the veto, name the real target as the replacement); everyone else is DIRECT.
     */
    tacticFor: { bond: "pawn", neutral: "direct", clash: "backdoor" } as Record<
      RelationshipDisposition,
      NominationTactic
    >,
  },
  vote: {
    /**
     * Self-protection under stress (0041): a fully-rattled voter's personal threat read is scaled
     * by (1 + this) — their nerves shout down their bloc and their deals; a calm voter is steady.
     */
    moodSelfProtectWeight: 0.5,
    /** The pull of an OPEN deal (0039): a bound voter leans this hard away from evicting the protected party. */
    dealHonorWeight: 0.3,
    /**
     * Light jury management (0014): evicting someone who still TRUSTS you makes a bitter juror, so
     * a voter discounts a nominee by this × the nominee's trust in them. Deliberately small — it
     * shades near-ties, it never outweighs a real threat read.
     */
    juryManagementWeight: 0.1,
    /**
     * Keep your own (D4/E33 calibration, 2026-06-11): a voter protects the nominee THEY are bonded
     * to — real-BB voters keep their people and cut the houseguest nobody is attached to. Without
     * this term the threat-primary read systematically spared the UNATTACHED nominee (a passive
     * player floated to jury in 18/20 measured seasons — an emergent shield, the anti-sycophancy
     * failure inverted). Bounded: it shades the split between two nominees, never outweighs a
     * runaway threat read. Discounts a nominee by this × the voter's own bondStrength toward them.
     */
    bondKeepWeight: 0.35,
    /**
     * The eviction vote is a REFERENDUM ON THE HOH (PO ruling 2026-11-02): a voter aligned with the
     * HOH (bond above baseline, little threat) gives the HOH their target; a voter opposed to the HOH
     * denies it and sends the pawn home instead. Adds this × the voter's HOH alignment to the HOH's
     * target's eviction score. Bounded — it shades, a runaway threat read still dominates.
     */
    hohReferendumWeight: 0.6,
  },
  /**
   * NPC↔NPC deal minting (audit E46): as a week's block goes up, the closest unbound NPC pair may
   * crystallize their scheming into a real, Vault-held pact — which then BINDS them (the 0044 vote
   * lean) and reconciles like any deal (E42): a break lands betrayal-shock, a jury demerit, and a
   * hidden reveal. The player learns of it only by pathway (gossip/overhears), never the ledger.
   */
  npcDeal: {
    /** Chance per nomination ceremony that the house's tightest unbound NPC pair makes a pact. */
    mintProb: 0.35,
    /** The pair's MUTUAL trust must clear this floor — pacts come from real bonds, not noise. */
    mutualTrustMin: 0.5,
    /** Above this mutual trust the pact is a full final-two; below, a week-scoped safety deal. */
    finalTwoTrustMin: 0.72,
  },
  /**
   * 0123 — the NPC-initiated deal OFFER to the PLAYER (the NPC->player counterpart of `makeDeal`). A
   * motivated houseguest floats the player a deal at a lull. Bounded + grounded so it reads as real play,
   * not noise. Only ever acts when the `ORWELL_NPC_DEAL_OFFERS` layer is on ⇒ byte-identical when off.
   */
  playerOffer: {
    /** Chance per eligible LULL advance (no pending, game live, cooldown clear) that an NPC floats an offer. */
    prob: 0.22,
    /** The NPC must have a REAL reason — max(bond, threat) toward the player must clear this floor. */
    motivationMin: 0.45,
    /** Above this BOND toward the player the offer is a final-two/alliance; otherwise a mutual-safety deal. */
    finalTwoBond: 0.6,
    /**
     * PO ruling 2026-11-01 — an offer the player never answers LAPSES at week's end, and how hard the
     * houseguest takes it DEPENDS ON THE NPC: the directed `conflict` cooling is scaled by their hidden
     * volatility, linearly from `scaleMin` (a calm houseguest shrugs) to `scaleMax` (a hothead stews).
     * An explicit decline is scale 1 — ignoring someone can sting a volatile houseguest more than a no.
     */
    lapse: { scaleMin: 0.4, scaleMax: 1.6 },
  },
} as const;

/**
 * E89 (product ruling #5, 2026-06-10): "'___ wants a word with you' must not spawn at the
 * beginning of the game." The approach gate — no NPC approach fires until the season's FIRST
 * ceremony beat (the week-1 HOH result) has resolved, so move-in and the first scenes get room
 * to breathe. STRUCTURAL and engine-side (`socialInitiatives` returns empty until then); the
 * front-end's started-gate is only the belt. The threshold lives HERE, not inline (B59).
 */
export const APPROACH_GATE = {
  /** Approaches stay silent until the first ceremony beat of the season has resolved. */
  requireFirstCeremonyBeat: true,
} as const;

/**
 * Issue #1322 (P2): "one NPC monopolizes approaches" — `rankApproaches` (0012) is deliberately
 * unable to invert a clear relationship gap (0028's bounded per-moment temperature), so the top
 * seeded-affinity NPC was stably rank 1 EVERY stretch, reading as a forced tutorial guide / instant
 * best friend. `APPROACH_COOLDOWN_STRETCHES` is how many STRETCHES (a distinct week:phase — the same
 * unit `socialInitiatives`'s rng key already uses) an NPC sits out the top-3 approach pool after
 * initiating, so the relationship signal still dominates the ordering but can't monopolize every
 * single stretch. Applied ONLY at the player-facing approach PROJECTION
 * (`GameSessionAdapter.socialInitiatives` via `conversation.ts`'s `applyApproachCooldown`) — never
 * inside `rankApproaches` itself, which stays pure/untouched so no seeded off-screen or decision
 * stream that might one day read it is perturbed. The threshold lives HERE, not inline (B59).
 */
export const APPROACH_COOLDOWN_STRETCHES = 2;

/**
 * Per-houseguest NOMINATION STYLE (PO ruling 2026-11-02 — "don't remove NPC agency"). Each NPC reads the
 * block through their own lens, fixed by their archetype for the whole season, so different HOHs make
 * different, learnable calls. Threat, bonds, blocs and grudges still decide first; a style only weights
 * the floater / duo reads that tip close calls. Hidden, engine-only.
 */
export type NominationStyle = "threat-hunter" | "floater-cleaner" | "duo-breaker" | "loyalist";

export interface NominationStyleWeights {
  floaterWeight: number;
  pawnSeatFloaterBonus: number;
  duoWeight: number;
  duoPartnerBonus: number;
}

export const NOMINATION_STYLES: Record<NominationStyle, NominationStyleWeights> = {
  /** Goes after the biggest competitor; barely cares who's floating. */
  "threat-hunter": { floaterWeight: 0.25, pawnSeatFloaterBonus: 0.4, duoWeight: 0.3, duoPartnerBonus: 0.2 },
  /** "You're not doing anything, you're going up." */
  "floater-cleaner": { floaterWeight: 0.9, pawnSeatFloaterBonus: 0.7, duoWeight: 0, duoPartnerBonus: 0 },
  /** Splits up power pairs — puts both halves on the block. */
  "duo-breaker": { floaterWeight: 0.3, pawnSeatFloaterBonus: 0.3, duoWeight: 0.7, duoPartnerBonus: 0.7 },
  /** Protects their people; the pawn is whoever nobody will miss. */
  loyalist: { floaterWeight: 0.4, pawnSeatFloaterBonus: 0.7, duoWeight: 0.1, duoPartnerBonus: 0 },
};

/** Archetype → nomination style. Unknown archetypes (and the player's NPC proxy) read as threat hunters. */
export const NOMINATION_STYLE_BY_ARCHETYPE: Record<string, NominationStyle> = {
  "comp-beast": "threat-hunter",
  hothead: "threat-hunter",
  analyst: "threat-hunter",
  floater: "threat-hunter",
  villain: "floater-cleaner",
  mastermind: "duo-breaker",
  wildcard: "duo-breaker",
  "social-butterfly": "loyalist",
  underdog: "loyalist",
  flirt: "loyalist",
  loyalist: "loyalist",
  peacemaker: "loyalist",
};
