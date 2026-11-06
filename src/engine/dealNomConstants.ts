/**
 * ORW-84 / B7 M3 (flag ORWELL_DEAL_NOMS) - how far an OPEN protective deal (safety / final-two) lowers the promisor HOH's nomination score for the person it protects. One number, here only, so Ryne can retune it
 * without a code hunt: the push is NEGATIVE (an HOH who made a deal mostly keeps their word), BOUNDED (a flat amount, never a multiplier), and rng-free. Same scale as the other nomination pushes
 * (campaign / memory / mood / drive / belief / pitch): small enough that a strong threat read can still win, large enough to flip a close call.
 */
export const DEAL_NOMS = { protectivePush: -0.2 } as const;
