/**
 * Feature 0104 — the single tunable home for season-over-season NOTORIETY (a reputation that
 * precedes the returning player into a new cast). The sibling-constants pattern
 * (`relationshipConstants` / `seededRelationshipConstants` / `threadConstants` / `juryConstants`):
 * every magnitude the derivation + the day-one bias read lives HERE, never inlined at a call site
 * (the B59 grep gate covers it), all God-Mode-knobbable later (0016 count-only).
 *
 * CALIBRATION (sacred — mandates #3 + #4). Notoriety is OPT-IN and DIEGETIC (R4): a summary is
 * derived + folded ONLY when the player chooses to return as the SAME character (the existing 0056
 * `keepCharacter` door). A NEW character / no prior season / `weight = 0` ⇒ NO summary, NO bias, so
 * `seedFirstImpressions` is BYTE-IDENTICAL and the seeded juryReach / gradient / UAT spine is unmoved
 * (`tests/unit/notorietyOutcomeNeutral.test.ts` is the neutrality gate). The bias is a BOUNDED, signed
 * DIRECTION inside the existing `MOVE_IN.spread` scatter envelope — it tilts the new cast's day-one
 * NPC→player move-in distribution, it NEVER sets a raw number, never seeds the player's own edges, and
 * NEVER touches a competition / vote / jury roll. The engine still owns every outcome magnitude (R2).
 */
export interface NotorietyConstants {
  /**
   * The day-one bias WEIGHT — the bounded coefficient on the signed notoriety lean, in the SAME
   * units `MOVE_IN.spread` already multiplies `dayOnePerception` by. Kept comfortably UNDER the
   * scatter envelope so the biased edge stays inside the existing move-in band (a tilt, never a
   * jump). Set to 0 (or leave the feature off) ⇒ every bias term is exactly 0 ⇒ byte-identical.
   */
  weight: number;
  /**
   * How strongly an archetype SHADES the bias it reads. The base bias is the reputation facet; an
   * archetype that cares about the facet (a paranoid villain reading a known assassin, a fan-of-the-game
   * reading a past winner) reads it MORE, a flat archetype reads it less. Bounded so the shading can
   * only scale the bias within `[1 - shadeSpread, 1 + shadeSpread]` — it never flips the sign and never
   * pushes past the weight bound.
   */
  shadeSpread: number;
  /**
   * The per-NPC RECOGNITION envelope (R2 refinement). Not everyone in the new cast has "heard about"
   * the player equally: each NPC draws a recognition level in `[recognitionFloor, 1]` on the existing
   * move-in seeded scatter, and the bias is MULTIPLIED by it — so a low-recognition NPC barely reads
   * the reputation at all (reputation matters, but never RIGIDLY overrides fresh discovery), while a
   * high-recognition NPC reads it in full. The floor keeps even the least-aware NPC from a literal
   * zero so the reputation is never wholly absent for anyone, only faint.
   */
  recognitionFloor: number;
  /**
   * The chance, per NPC, that their recognition is DISTORTED (R2 / reuse of the 0094 gossip-distortion
   * idea): they "heard wrong". A distorted read scales the bias by `distortionScale` and may flip its
   * sign (a loyalist mis-remembered as a snake) — so some of the house holds a WRONG version of the
   * reputation. Bounded and rare; most of the cast reads the reputation true, a minority garbled.
   */
  distortionProb: number;
  /**
   * The magnitude scale a DISTORTED recognition applies (alongside the possible sign flip). A distortion
   * is a fuzzy half-memory, so it reads the reputation WEAKER (and sometimes inverted), never amplified —
   * a misremembered reputation is a softer, less reliable signal than a clear one.
   */
  distortionScale: number;
  /** 0208 B2: see the value below. */
  brokenWordKnownAt: number;
  /** HARD cap on `legendBeats` carried in the summary — a reputation gist, never a transcript. */
  maxLegendBeats: number;
  /**
   * The derivation weights that turn the finished season's OPEN-SET outcome record into the four
   * bounded reputation facets in [-1,1]. Each is a small coefficient; the derivation clamps the
   * result. Placement is normalized to [0,1] (1 = winner) before these apply.
   */
  derive: {
    /** Placement → competitor/social respect (a deep run reads as "knows how to play"). */
    placementRespect: number;
    /** Each recorded comp win → competitor. */
    compWin: number;
    /** Each kept deal / had-their-back beat → loyalty. */
    loyaltyBeat: number;
    /** Each blindside / betrayal beat → treachery. */
    treacheryBeat: number;
    /** Jury respect (share of jury votes / a deep, respected run) → social + a touch of competitor. */
    juryRespect: number;
    /** 0208 B2: the house's heard record of the player's broken word (mean share of standing lost across the cast, 0..1) -> treachery. Zero when absent. */
    brokenWord: number;
  };
}

export const NOTORIETY: NotorietyConstants = {
  weight: 0.18,
  shadeSpread: 0.5,
  recognitionFloor: 0.25,
  distortionProb: 0.22,
  distortionScale: 0.5,
  maxLegendBeats: 4,
  /** 0208 B2: the heard-wrong mean at or above which the returning player is known to have a name for breaking their word. */
  brokenWordKnownAt: 0.15,
  derive: {
    placementRespect: 0.45,
    compWin: 0.18,
    loyaltyBeat: 0.3,
    treacheryBeat: 0.34,
    juryRespect: 0.5,
    brokenWord: 1.2,
  },
};
