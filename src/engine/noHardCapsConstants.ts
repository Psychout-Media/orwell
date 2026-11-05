/**
 * B49 / PO ruling card 24 - NO HARD PER-SEASON COUNTS (behind `ORWELL_NO_HARD_CAPS`, default OFF, never-flipped).
 *
 * The old design capped NPC confide lies at 2 (`CONFIDENCE.maxLiesPerSeason`), player exposes at 3 (`LEVERAGE.maxExposesPerSeason`) and player trades at 5 (`SECRET_TRADE.maxTradesPerSeason`):
 * arbitrary, announced numbers. With the flag ON those counts stop being a DESIGN rule. What remains is (a) a HIGH technical safety valve (not a gameplay number: nothing in play should reach it) and
 * (b) a REPETITION COST - each further use by the same actor in the season costs more, so the limit is felt in the relationships, never announced. The other limits already exist and are unchanged:
 * a secret is spent when exposed, a secret is never re-traded to someone who already knows it, a caught lie is a betrayal-grade recoverable hit (and, with `ORWELL_CREDIBILITY_MEMORY`, a
 * credibility loss), and an NPC lies only when its archetype and situation make it the strategic move. The flag-off constants above are untouched (byte-identical).
 */
export const NO_HARD_CAPS = {
  /** The technical safety valve per actor per season (a runaway-loop guard, deliberately far above anything play reaches). */
  safetyValve: 25,
  /** Each PRIOR use by the same actor adds this share of the base backlash to the repetition cost (the first use costs nothing extra). */
  repetitionPerUse: 0.35,
  /** The repetition multiplier saturates here (a habitual abuser is bounded, not infinite). */
  repetitionMax: 3,
  /** The RECIPIENT scale: `floor + span x trust(recipient -> actor)` - the more they trusted the actor, the more the repetition stings (a cold acquaintance shrugs). */
  recipientStingFloor: 0.6,
  recipientStingSpan: 0.8,
  /** An NPC's confide-lie roll shrinks by this factor per lie THAT NPC already told this season (a liar's mark gets wary / the act wears thin). */
  lieRepeatDecay: 0.75,
  /** ...but never below this share of the base lie chance (a manipulator still lies often; it is personality, not a count). */
  lieRepeatFloor: 0.3,
} as const;
