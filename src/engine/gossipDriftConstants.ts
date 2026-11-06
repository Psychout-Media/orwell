/**
 * Feature (issue #1397) — CHARACTER-MEDIATED gossip-drift tunables (the single-tunable-home pattern:
 * sibling of `GOSSIP`/`LEGEND` in `gossip.ts`, and of `CONFIDENCE`/`THREAD`/`DRIVE`/`TRIGGER`). One home
 * for every number the drift-mediation reads; no inline magic at the `gossip.ts` call sites (the B59 gate).
 *
 * The base gossip diffusion (0038 / audit SG-6) already DISTORTS a rumor's claimed NATURE as it passes
 * hop to hop — but personality-AGNOSTICALLY (a fixed 50/50 escalate-or-soften severity step, a fixed hedge
 * pool). This module makes that distortion CHARACTER-MEDIATED: the RETELLER's own PUBLIC voice (feature
 * 0084 `VoiceProfile` — register / rhythm / energy / directness / humor, all Vault-free public dials) biases
 * HOW the claim mutates as it passes through THIS mouth:
 *
 *   • a dramatic / high-energy voice AMPLIFIES — biasing the severity step UP the ladder (toward the
 *     alarming end) and embellishing the hedge;
 *   • a blunt / flat voice FLATTENS — biasing the step DOWN (toward the mild end) with a curt hedge;
 *   • a strategic / evasive / low-directness voice shades toward AMBIGUITY — a hedged, non-committal
 *     phrasing (the severity lean stays near the neutral middle).
 *
 * HARD constraints honored here (enforced by `gossip.ts diffuseGossip` + the drift tests):
 *   • PUBLIC personality ONLY — never soul / Vault / relationship-hidden state (mandates #2 / #3). Every
 *     input is a `VoiceProfile` DIAL STRING (the audited closed vocabulary — no digit, no hidden marker).
 *   • OPEN-SET only (ADR 0005) — this re-weights the CONTENT / phrasing of the propagated belief; it never
 *     touches the closed set (factId lineage, confidence / decay math, which edges move, or any seeded
 *     magnitude). No number ever crosses to the player.
 *   • CALIBRATION-NEUTRAL — voice re-weights ONLY the severity-step DIRECTION threshold + the hedge POOL,
 *     each an existing forked-rng draw whose COUNT and POSITION are unchanged; `baseTypeDriftProb` and
 *     `baseSubjectSwapProb` stay VOICE-INDEPENDENT so the subject-swap decision (hence the E44 receipt
 *     fold's parent-rng draw count) is byte-identical whether the layer is off or on. Absent voice ⇒ the
 *     BASE values below ⇒ byte-identical to the pre-feature agnostic drift.
 */
import type { VoiceProfile } from "../domain/voiceProfile";
import { clamp } from "../domain/num";

export const GOSSIP_DRIFT = {
  /** Base chance a hop past the floor nudges the claimed NATURE (the pre-feature `TYPE_DRIFT_PROB`). Held
   *  voice-INDEPENDENT: every voice drifts the nature equally OFTEN — voice sets only the DIRECTION — so the
   *  forked-rng draw sequence (and thus the downstream subject-swap decision + the E44 fold's parent draws)
   *  is byte-identical off vs on. */
  baseTypeDriftProb: 0.3,
  /** Base chance a hop swaps ONE subject (the pre-feature `SUBJECT_SWAP_PROB`). Held voice-INDEPENDENT for
   *  the same neutrality reason: a swap changes the fold's subject set, which must not diverge off vs on. */
  baseSubjectSwapProb: 0.15,
  /** Base escalation bias: 0.5 = the pre-feature 50/50 up-or-down severity step (the neutral middle). */
  baseEscalationBias: 0.5,
  /** How far a voice may pull the escalation bias from 0.5 (kept a NUDGE, then clamped below). */
  escalationSpan: 0.45,
  /** Hard clamps on the mediated escalation bias — never a certainty, always a lean. */
  escalationFloor: 0.08,
  escalationCeil: 0.92,
} as const;

/**
 * Per-dial AMPLIFICATION lean in [-1, +1]: how strongly a PUBLIC dial VALUE pushes a retelling to ESCALATE
 * (+, toward the alarming end of the severity ladder) vs FLATTEN (−, toward the mild end). Keyed by dial →
 * value → weight; an unlisted value contributes 0. PUBLIC dial strings only (no soul, no number crosses).
 */
export const VOICE_AMPLIFICATION: Record<string, Record<string, number>> = {
  energy: { flat: -1.0, even: -0.5, warm: 0.0, buzzy: 0.6, manic: 1.0 },
  humor: { none: -0.2, dry: -0.3, "self-deprecating": 0.0, goofy: 0.4, cutting: 0.7 },
  directness: { blunt: -0.5, candid: -0.1, diplomatic: 0.1, evasive: 0.3 },
  register: { formal: -0.3, polished: -0.2, plainspoken: 0.0, folksy: 0.2, crude: 0.4 },
};


/** The reteller's amplification tendency in [-1, +1] — the mean of its four contributing PUBLIC dials. */
export function amplification(voice: VoiceProfile): number {
  const dials: Array<[keyof typeof VOICE_AMPLIFICATION, string]> = [
    ["energy", voice.energy],
    ["humor", voice.humor],
    ["directness", voice.directness],
    ["register", voice.register],
  ];
  let sum = 0;
  for (const [dial, value] of dials) sum += VOICE_AMPLIFICATION[dial]![value] ?? 0;
  return sum / dials.length;
}

/**
 * The voice-mediated ESCALATION BIAS in [floor, ceil] — the probability a severity step goes UP the ladder
 * (toward "alarming"). 0.5 (base) = the pre-feature 50/50; a dramatic voice reads > 0.5 (amplifies), a
 * blunt / flat voice < 0.5 (flattens). Reads ONLY the public voice dials — never a soul or a number.
 */
export function escalationBias(voice: VoiceProfile): number {
  return clamp(
    GOSSIP_DRIFT.baseEscalationBias + GOSSIP_DRIFT.escalationSpan * amplification(voice),
    GOSSIP_DRIFT.escalationFloor,
    GOSSIP_DRIFT.escalationCeil,
  );
}

/**
 * The hedge-phrasing pools — a cosmetic "how sure are they" marker appended to a retelling (stripped from
 * the live display by `humanize.ts tidyPathwaySlugs`, but recorded in the belief for the 0048 retrospective).
 * The reteller's voice picks the POOL; the existing single `rng.pick` draw chooses within it, so the drift
 * draw COUNT / POSITION is unchanged. PUBLIC phrasing only — no fact, no hidden state.
 */
export const HEDGE_POOLS = {
  /** The pre-feature pool — the OFF / no-voice default (byte-identical to today's `distort`). */
  base: ["roughly", "or so I heard", "supposedly", "more or less", "the way I heard it"],
  /** Dramatic / high-energy — embellished, certain-sounding. */
  embellished: ["I swear", "no joke", "hand to God", "I couldn't make it up", "for real for real"],
  /** Blunt / curt — flat, clipped. */
  curt: ["flat out", "straight up", "no question", "period", "that's it"],
  /** Strategic / evasive — hedged, non-committal (ambiguity). */
  evasive: ["or so they say", "don't quote me", "allegedly", "if you believe it", "the way it's told"],
} as const;

/**
 * Choose the reteller's hedge pool from their PUBLIC voice — the phrasing texture of THIS mouth. Priority:
 * a blunt / clipped voice reads curt; an evasive / diplomatic voice reads ambiguous; a high-energy or biting
 * voice reads embellished; everything else keeps the base pool (byte-identical to the pre-feature hedge).
 */
export function hedgePool(voice: VoiceProfile): readonly string[] {
  if (voice.directness === "blunt" || voice.rhythm === "clipped") return HEDGE_POOLS.curt;
  if (voice.directness === "evasive" || voice.directness === "diplomatic") return HEDGE_POOLS.evasive;
  if (voice.energy === "manic" || voice.energy === "buzzy" || voice.humor === "cutting" || voice.humor === "goofy") {
    return HEDGE_POOLS.embellished;
  }
  return HEDGE_POOLS.base;
}
