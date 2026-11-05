/**
 * B47 - the shared numeric clamps (pure, no dependencies). Twenty-odd engine/domain files each carried their own `clamp01`; they came in exactly two behaviours, kept apart here so every call site is byte-identical:
 *  - `clamp01`    : NaN -> 0, otherwise clamp to [0, 1]            (the guarded form)
 *  - `clamp01Raw` : NO NaN guard (NaN stays NaN), clamp to [0, 1]  (the bare `Math.max(0, Math.min(1, x))` form)
 * A site must keep the form it had: switching a raw site to the guarded one would turn a NaN into 0.
 */
export const clamp01 = (v: number): number => (Number.isNaN(v) ? 0 : Math.max(0, Math.min(1, v)));
export const clamp01Raw = (v: number): number => Math.max(0, Math.min(1, v));

/** `clamp(x, lo, hi)` with NO NaN guard (a NaN stays NaN), the bare `Math.max(lo, Math.min(hi, x))` form the engine's local copies used. */
export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/** FNV-1a over a string -> unsigned 32-bit (a stable, seed-free string hash). Equivalent to both former copies (jurorProfile, portraitPrompts): `Math.imul` is int32-wrapped, so reducing with `>>> 0` per step or only at the end gives the same bits. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
