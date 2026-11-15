/**
 * Image generation budget constants (0051).
 *
 * Generation is the most expensive lever in the game; these constants bound it.
 * Declared here — never inlined — so tuning the budget doesn't require touching
 * logic (the same discipline as `temperatureConstants.ts` and `relationshipConstants.ts`).
 *
 * Move-in portrait generation (auto-fires at season start for every houseguest)
 * is EXEMPT from the per-turn cap — it is a bounded one-time season-start cost,
 * not a player-initiated generation.
 */
export const IMAGE_BUDGET = {
  /** Max image generations per player turn (move-in portrait set is exempt). */
  perTurnCap: 3,
  /** Max image generations per game week. */
  perWeekCap: 10,
  /** The season-start cast portrait set is outside all per-turn / per-week caps. */
  moveInPortraitExempt: true,
} as const;

/**
 * The photorealistic style anchor variants seeded at cast time. One descriptor set is drawn per season; the
 * same seed always draws the same one, so a save keeps the anchor it adopted. ORW-380: the photo brief v3
 * does NOT send the anchor (the prompt carries its own fixed wording); it is still stored and seeded, so the
 * index stays stable and saves are unchanged. Qualitative only: no stat, soul, or hidden content.
 */
export const STYLE_ANCHOR_VARIANTS = [
  "photorealistic cast portrait from a reality TV show, soft flattering light, Orwell house interior",
  "photorealistic portrait from a reality TV series, available window light, Orwell house",
  "photorealistic reality TV cast portrait, soft indoor light, Orwell house",
  "photorealistic portrait captured on a reality TV set, warm practical lighting, Orwell house",
  "photorealistic cast photo from a reality TV show, gentle natural light, Orwell house interior",
] as const;
