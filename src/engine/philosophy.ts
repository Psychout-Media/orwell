import {
  DEFAULT_PHILOSOPHY_BY_ARCHETYPE, FALLBACK_PHILOSOPHY, PHILOSOPHIES, PHILOSOPHY_DRAW, STYLE_OF_PHILOSOPHY, type GamePhilosophy,
} from "./philosophyConstants";
import type { NominationStyle } from "./decisionConstants";

/**
 * B40 - the PURE philosophy layer (design S4). No I/O, no shared rng, no Vault, and NOT called from any decision yet. A houseguest's philosophy is a deterministic function of (archetype, integer seed):
 * the seed is the caller's own per-houseguest value (e.g. a hash of the game seed and the houseguest id), turned into two independent unit rolls by a local hash - so drawing one never touches, or
 * advances, any shared random stream.
 */
const strHash = (str: string): number => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
// `seed` is an INTEGER (the caller's per-houseguest value); it is reduced with `>>> 0`, so a non-integer or >2^32 seed is folded, never silently differing between runs. The archetype is folded into the salt so
// two archetypes drawn with the SAME seed are independent (they do not all keep, or all deviate, together).
const mix = (seed: number, salt: number): number => {
  let h = (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** The modal philosophy of an archetype (unknown => the fallback). */
export function defaultPhilosophyOf(archetype: string): GamePhilosophy {
  return DEFAULT_PHILOSOPHY_BY_ARCHETYPE[archetype] ?? FALLBACK_PHILOSOPHY;
}

/** The nomination style a philosophy plays. */
export function styleOfPhilosophy(p: GamePhilosophy): NominationStyle {
  return STYLE_OF_PHILOSOPHY[p];
}

/** Seeded draw conditioned on archetype: keeps the default with probability `keepDefault`, otherwise one of the OTHER philosophies by weight. Deterministic in (archetype, seed). */
export function drawPhilosophy(archetype: string, seed: number): GamePhilosophy {
  const def = defaultPhilosophyOf(archetype);
  const a = strHash(archetype);
  if (mix(seed, 1 ^ a) < PHILOSOPHY_DRAW.keepDefault) return def;
  const others = PHILOSOPHIES.filter((p) => p !== def);
  const total = others.reduce((s, p) => s + PHILOSOPHY_DRAW.alternativeWeight[p], 0);
  let t = mix(seed, 2 ^ a) * total;
  for (const p of others) { t -= PHILOSOPHY_DRAW.alternativeWeight[p]; if (t < 0) return p; }
  return others[others.length - 1]!;
}
