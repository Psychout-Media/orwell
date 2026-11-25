/**
 * Feature 0063 — casting diversity floor: the single tunable constants module (the sibling of
 * `decisionConstants.ts` / `relationshipConstants.ts` / `temperatureConstants.ts`). Every threshold
 * and pool that the diversity floor reasons over lives HERE — no magnitude is hard-coded at a call
 * site (the existing grep gate covers it).
 *
 * The owner's LOCKED decisions (2026-06-19; AMENDED 2026-06-23), baked in:
 *  1. The cast reflects the REAL UNITED STATES, not a quota cast. Each identity axis (race/ethnicity,
 *     gender, sexuality, age) is dealt to APPROXIMATE U.S. POPULATION RATES via population WEIGHTS
 *     (`EthnicityIdentity.weight`, consumed by `diversity.ts`'s weighted deal), with a light FLOOR as a
 *     small-cast safety net so a 15-person cast still visibly reflects the country. The weighted deal —
 *     not the floor — sets the EXPECTED mix (~40% BIPOC, the U.S. figure); the floor only catches an
 *     unlucky tail. (Earlier this was a flat BIPOC ≥ 8 floor over a BIPOC-heavy pool dealt UNIFORMLY,
 *     which skewed casts to ~70% BIPOC — unrealistic; the weights fix the distribution at its source.)
 *     Validated/repaired like L28's CAPS.
 *  2. Ethnicity is a FIRST-CLASS identity attribute (heritage / cultural identity — an authentic facet
 *     of a full character, never a stereotype kit). It grounds 0058's `physicalCharacteristics.skinTone`
 *     so the text and the portrait agree.
 *  3. Orientation is seeded per houseguest; disclosure is character-driven — some publicly out (a public
 *     facet), some PRIVATE (Vault-sealed, surfacing only via a 0002 pathway). Eligibility-only gating of
 *     0059 showmances.
 *  4. Gender is balanced + inclusive — roughly balanced men/women, with nonbinary possible and counted
 *     toward the LGBTQ+ floor.
 *
 * THE DIGNITY DISCIPLINE (§2/§6): identity is the DEPTH of a full character, never a reductive single
 * word. Every pool entry below is an authentic, plain-English facet of a real person — heritage as
 * lived background, not a caricature kit. No surface ever reduces a houseguest to their ethnicity or
 * orientation; these are ONE true facet woven into a §3-deep profile (0058).
 *
 * NO-LEAK DISCIPLINE (CRITICAL, mirrors L28/0058): every PUBLIC facet string is plain English with NO
 * competition-stat-key substring ("physical"/"mental"/"social") and NO bare float, so it can never
 * serialize into the `"physical":`-style key form or the float form the Vault leak-scans hunt for.
 * These attributes are DESCRIPTIVE ONLY — they never feed a competition, a vote, or any outcome.
 */

// ── §3 — the four engine-guaranteed floors (over the 15 NPCs) ──────────────────────────────────────

/**
 * BIPOC representation FLOOR — a small-cast safety net, NOT the target. The expected BIPOC share is set
 * by the population WEIGHTS below (~40%, the U.S. figure ⇒ ~6 of 15); this floor only repairs an unlucky
 * tail UP so a 15-person cast never deals near-monochrome. Sized BELOW the weighted expectation so the
 * realism comes from the deal, not from constant up-repair (owner amendment 2026-06-23: realistic-per-US).
 */
export const MIN_BIPOC = 4;

/**
 * LGBTQ+ representation floor: at least this many houseguests with a non-straight orientation (owner: ≥ 2).
 * ≈13% of a 15-cast — realistic for a young-skewing reality cast (Gallup: ~7% of U.S. adults overall, but
 * ~20%+ among the Gen-Z/Millennial ages a BB cast draws from), and the minimum the §4/§5 disclosure
 * scenarios need (BOTH an out and a private queer houseguest). Kept at 2 under the 2026-06-23 amendment.
 */
export const MIN_QUEER = 2;

/**
 * Gender-balance floor: neither men nor women may fall below this many of the 15-cast (owner: "roughly
 * balanced"). With 6/6 as the per-binary minimum, the remaining 3 slots are free — including for any
 * nonbinary houseguests — so a 6-men/6-women/3-other split satisfies it, as does a 7/8 or 8/7 split.
 */
export const MIN_PER_BINARY_GENDER = 6;

/**
 * Age-spread floor: each defined age band must carry at least this many houseguests, so the cast SPANS
 * generations instead of clustering in the 20s. The bands sit on top of the L18c `age ≥ 21` floor.
 */
export const MIN_PER_AGE_BAND = 2;

/**
 * The L28-style CAP on the age bands — no single band may exceed this share of the cast, so the cast
 * never collapses back into one generation even though the underlying age draw skews young. Sized to
 * coexist with the spread floor (3 bands × ≥2 floor, with the 20s allowed to hold the bulk up to this).
 */
export const MAX_PER_AGE_BAND = 11;

/**
 * The age bands (inclusive lower bound; the next band's lower bound is the exclusive upper). Sized so a
 * 15-cast with ≥2 per band still skews young-and-realistic: a genuine handful in the 30s and 40s+ rather
 * than one generation of near-twins. The eligibility floor (L18c) is the lower edge of the first band.
 */
export const AGE_ELIGIBILITY_FLOOR = 21;
export const AGE_BANDS: ReadonlyArray<{ id: string; min: number; maxExclusive: number }> = [
  { id: "20s", min: 21, maxExclusive: 30 },
  { id: "30s", min: 30, maxExclusive: 40 },
  { id: "40plus", min: 40, maxExclusive: 999 },
];

/** The age band id an age falls into (for the spread floor + the repair). */
export function ageBandOf(age: number): string {
  for (const b of AGE_BANDS) if (age >= b.min && age < b.maxExclusive) return b.id;
  return AGE_BANDS[0]!.id; // below the floor is repaired up; never lands here in practice
}

// ── §3.2 — ethnicity: a FIRST-CLASS identity attribute (heritage / cultural identity) ──────────────
// An authentic, dignified heritage facet — lived background, NOT a stereotype kit. `bipoc` marks which
// count toward the BIPOC floor; `skinTone` GROUNDS 0058's `physicalCharacteristics.skinTone` so the text
// and the portrait agree (owner decision #2). The labels read as real people's backgrounds; the skin-tone
// cue is a plain, gender-neutral complexion phrase (the same vocabulary 0058 already uses). The pool is
// deliberately broad so the cast reads as a genuine, country-reflecting crew — never a checklist of types.
export interface EthnicityIdentity {
  /** The heritage/cultural-identity label — a lived facet of a full character (e.g. "Black American"). */
  heritage: string;
  /** Whether this heritage counts toward the BIPOC representation floor. */
  bipoc: boolean;
  /** The grounded complexion cue feeding 0058's physicalCharacteristics.skinTone (plain English). */
  skinTone: string;
  /**
   * Relative U.S.-population WEIGHT for the seeded deal (owner amendment 2026-06-23). The weighted draw
   * in `diversity.ts` makes a cast approximate real U.S. demographics rather than the old uniform draw
   * over a BIPOC-heavy pool (which skewed ~70% BIPOC). The numbers are RELATIVE shares (the deal
   * normalizes them) chosen so non-BIPOC ≈ 60% and BIPOC ≈ 40% of the mass — the U.S. figure — with the
   * within-group split tracking real ancestry order (German/Irish lead the white share; Hispanic then
   * Black lead the BIPOC share). The per-heritage cap (MAX_PER_ETHNICITY) flattens the high-weight
   * heritages so no single one dominates while the group totals stay realistic.
   */
  weight: number;
}

/**
 * BIPOC heritages with U.S.-population weights (BIPOC mass ≈ 40 of the ~100 total). Authentic, not
 * reductive. Hispanic leads, then Black, then Asian, with Native/Middle-Eastern/multiracial sparse —
 * the real ancestry order. The weighted deal centers a cast near the U.S. ~40% BIPOC figure.
 */
export const BIPOC_ETHNICITIES: readonly EthnicityIdentity[] = [
  { heritage: "Black American", bipoc: true, skinTone: "deep brown skin", weight: 9 },
  { heritage: "Nigerian American", bipoc: true, skinTone: "rich dark complexion", weight: 1.5 },
  { heritage: "Caribbean American", bipoc: true, skinTone: "warm brown skin", weight: 2 },
  { heritage: "Mexican American", bipoc: true, skinTone: "warm tan complexion", weight: 13 },
  { heritage: "Puerto Rican", bipoc: true, skinTone: "golden-brown skin", weight: 3 },
  { heritage: "Dominican American", bipoc: true, skinTone: "medium brown skin", weight: 2 },
  { heritage: "Chinese American", bipoc: true, skinTone: "light tan complexion", weight: 1.5 },
  { heritage: "Filipino American", bipoc: true, skinTone: "warm tan complexion", weight: 1.3 },
  { heritage: "Korean American", bipoc: true, skinTone: "fair warm complexion", weight: 0.8 },
  { heritage: "South Asian American", bipoc: true, skinTone: "deep amber-toned skin", weight: 1.3 },
  { heritage: "Vietnamese American", bipoc: true, skinTone: "light golden complexion", weight: 0.7 },
  { heritage: "Native American", bipoc: true, skinTone: "warm reddish-brown skin", weight: 1 },
  { heritage: "Middle Eastern American", bipoc: true, skinTone: "olive complexion", weight: 0.7 },
  { heritage: "multiracial", bipoc: true, skinTone: "warm medium-brown skin", weight: 2.5 },
];

/**
 * Non-BIPOC heritages with U.S.-population weights (white mass ≈ 60 of the ~100 total) — the cast still
 * reflects the whole country. German/Irish/Italian lead, tracking real U.S. ancestry order.
 */
export const NON_BIPOC_ETHNICITIES: readonly EthnicityIdentity[] = [
  { heritage: "Irish American", bipoc: false, skinTone: "fair freckled skin", weight: 13 },
  { heritage: "Italian American", bipoc: false, skinTone: "light olive complexion", weight: 12 },
  { heritage: "Polish American", bipoc: false, skinTone: "pale rosy complexion", weight: 8 },
  { heritage: "German American", bipoc: false, skinTone: "fair skin", weight: 16 },
  { heritage: "Greek American", bipoc: false, skinTone: "olive complexion", weight: 5 },
  { heritage: "Scandinavian American", bipoc: false, skinTone: "pale fair skin", weight: 6 },
];

export const ALL_ETHNICITIES: readonly EthnicityIdentity[] = [...BIPOC_ETHNICITIES, ...NON_BIPOC_ETHNICITIES];

/** No single heritage may pile up beyond this across the 15-cast (a SPREAD cap, the L28 sibling). */
export const MAX_PER_ETHNICITY = 2;

// ── §3.3 — gender presentation (balanced + inclusive) ──────────────────────────────────────────────
// A descriptive PUBLIC facet (how the houseguest presents), never a competition input. Nonbinary is a
// first-class value and counts toward the LGBTQ+ floor (owner decision #4). The labels are plain words.
export type GenderPresentation = "man" | "woman" | "nonbinary";
export const GENDER_PRESENTATIONS: readonly GenderPresentation[] = ["man", "woman", "nonbinary"];

/**
 * Nonbinary is sparse + realistic — at most this many across the 15-cast (still counts toward MIN_QUEER).
 * Owner amendment 2026-06-23: capped at 1 (≈7% of a 15-cast already exceeds the U.S. nonbinary rate; the
 * realistic figure for a young-skewing cast is 0–1).
 */
export const MAX_NONBINARY = 1;

// ── §4 — the orientation model (organic, character-driven, Vault-walled) ───────────────────────────
// Every houseguest has a seeded orientation. `queer` marks which count toward the LGBTQ+ floor. Plain
// English, descriptive only — NEVER a stat, never a competition input, never telegraphed by a banner.
export type Orientation = "straight" | "gay" | "lesbian" | "bisexual" | "queer" | "pansexual";
export interface OrientationSpec {
  orientation: Orientation;
  /** Whether this orientation counts toward the LGBTQ+ representation floor. */
  queer: boolean;
}
export const ORIENTATIONS: readonly OrientationSpec[] = [
  { orientation: "straight", queer: false },
  { orientation: "gay", queer: true },
  { orientation: "lesbian", queer: true },
  { orientation: "bisexual", queer: true },
  { orientation: "queer", queer: true },
  { orientation: "pansexual", queer: true },
];

/**
 * ORW-893: how an orientation is DRAWN. The labels above are only the closed set the result is validated against; nobody is dealt a label. Each houseguest gets independent, continuous attractions, and the
 * label is read off them against the houseguest's own gender presentation (an orientation is a relation to one's own presentation: "lesbian" is a woman attracted to women, "gay" a man attracted to men):
 *  - `sameAttraction` u^`sameExponent` (a share of attraction directed at the same gender: most of the mass near 0, a thin tail up to 1) and `otherAttraction` 1 - u^`otherExponent` (most near 1),
 *    so about a tenth of a cast has a meaningful same-gender attraction, the realistic young-cast figure (the LGBTQ+ floor of MIN_QUEER still repairs an unlucky small cast up);
 *  - attraction counts at `attractionThreshold`; both present = open to both (bisexual, or pansexual when the independent `genderBlind` draw reaches `pansexualFrom`, or the self-label "queer" when the
 *    independent `selfLabel` draw reaches `queerLabelFrom`); same only = gay (men) / lesbian (women) / queer (nonbinary or the self-label); other only or neither = straight.
 */
export const ORIENTATION_DRAW = {
  sameExponent: 10,
  otherExponent: 5,
  attractionThreshold: 0.35,
  pansexualFrom: 0.7,
  queerLabelFrom: 0.85,
} as const;

/** The queer (non-straight) orientations the floor draws from when it must repair UP to MIN_QUEER. */
export const QUEER_ORIENTATIONS: readonly OrientationSpec[] = ORIENTATIONS.filter((o) => o.queer);

/**
 * DISCLOSURE is character-driven (§4): of the queer houseguests, roughly this fraction are PUBLICLY OUT
 * (a public facet the house knows); the rest hold it PRIVATELY (a Vault-sealed attribute reaching the
 * player only via a 0002 pathway). A seeded per-houseguest roll against this probability decides, so it
 * is NOT a uniform rule — some out, some private, exactly as real people differ. Tuned so a season
 * reliably carries BOTH an out houseguest and (often) a private one, satisfying the §4/§5 scenarios.
 */
export const PUBLICLY_OUT_PROB = 0.6;

/**
 * SATISFIABILITY MARGIN (documented, the L28 precedent's "12 builds / ≤2 each covers 15" note):
 *  • BIPOC: the WEIGHTED deal centers a 15-cast near the U.S. ~40% figure (~6 BIPOC); MIN_BIPOC(4) is a
 *    tail safety net, not the target. 14 BIPOC heritages × ≤2 each = 28 ≫ 4, and the ~60% white mass is
 *    comfortably filled (6 heritages × ≤2 = 12 ≥ the ~9 white slots). Floor ≤ deal expectation ⇒ repair
 *    is rare, so the realism comes from the WEIGHTS, not from constant up-repair.
 *  • Gender: MIN_PER_BINARY_GENDER(6)+6 = 12 ≤ 15, leaving 3 free (incl. ≤MAX_NONBINARY(1) nonbinary).
 *  • Age: 3 bands × MIN_PER_AGE_BAND(2) = 6 ≤ 15 — the remaining 9 skew young as before.
 *  • LGBTQ+: MIN_QUEER(2) ≤ 15 trivially; 5 queer orientations give variety.
 * The weighted deal, the floors, and L28's caps are JOINTLY satisfiable on a 15-cast with margin to spare.
 */
export const SATISFIABILITY_NOTE = "weighted deal + floors + caps jointly satisfiable on a 15-cast with margin (see SATISFIABILITY_MARGIN)";
