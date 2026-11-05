/**
 * B47 - the shared numeric clamps (pure, no dependencies). Twenty-odd engine/domain files each carried their own `clamp01`; they came in exactly two behaviours, kept apart here so every call site is byte-identical:
 *  - `clamp01`    : NaN -> 0, otherwise clamp to [0, 1]            (the guarded form)
 *  - `clamp01Raw` : NO NaN guard (NaN stays NaN), clamp to [0, 1]  (the bare `Math.max(0, Math.min(1, x))` form)
 * A site must keep the form it had: switching a raw site to the guarded one would turn a NaN into 0.
 */
export const clamp01 = (v: number): number => (Number.isNaN(v) ? 0 : Math.max(0, Math.min(1, v)));
export const clamp01Raw = (v: number): number => Math.max(0, Math.min(1, v));
