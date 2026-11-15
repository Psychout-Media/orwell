/**
 * ORW-381: the casting TYPE list. Each houseguest is cast as one type at character creation: how they read
 * on camera. PRESENTATION ONLY: no mechanic, outcome, stat or hidden field reads it, and it is dealt without
 * looking at any stat or hidden field (ORW-432: it is dealt from the types compatible with the houseguest's
 * public archetype, demeanor and strategy style, see traitConsistency.ts). `label` is gender-neutral; `read` is five to ten camera-visible words (never a
 * motive, secret or number). `minAge` / `maxAge` bound who may be cast as the type. Public and Vault-free.
 */
import { castingCompatible, castingConflict, type FitTraits } from "./traitConsistency";

export interface CastingType {
  readonly id: string;
  readonly label: string;
  readonly read: string;
  readonly minAge?: number;
  readonly maxAge?: number;
}

/** The public card shape: label and read only. */
export interface CastingTypeCard { label: string; read: string }

export const CASTING_TYPES: readonly CastingType[] = [
  { id: "charmer", label: "the charmer", read: "easy smile, relaxed and assured, plays to the camera" },
  { id: "firecracker", label: "the firecracker", read: "quick, bright-eyed, chin up, ready to argue" },
  { id: "jock", label: "the jock", read: "athletic ease, competitive grin" },
  { id: "sweetheart", label: "the sweetheart", read: "open face, warm soft smile" },
  { id: "brain", label: "the brain", read: "observant, composed, a knowing look" },
  { id: "class-clown", label: "the class clown", read: "mischief in the eyes, grin first" },
  { id: "rebel", label: "the rebel", read: "cool stare, shoulders loose, unbothered" },
  { id: "free-spirit", label: "the free spirit", read: "dreamy, loose and sunny" },
  { id: "hustler", label: "the hustler", read: "sharp, forward-leaning, salesman's smile" },
  { id: "quiet-storm", label: "the quiet storm", read: "still, watchful, a small private smile" },
  { id: "diva", label: "the diva", read: "posed, polished, owns the frame" },
  { id: "parent-of-the-house", label: "the parent of the house", read: "steady, kind eyes, arms loosely crossed", minAge: 36 },
  { id: "silver-fox", label: "the silver fox", read: "distinguished, amused, at ease", minAge: 45 },
  { id: "underdog", label: "the underdog", read: "earnest, hopeful, a little shy" },
  { id: "flirt", label: "the flirt", read: "playful eye contact, head tilt" },
  { id: "straight-shooter", label: "the straight shooter", read: "level gaze, no-nonsense half-smile" },
  { id: "dreamer", label: "the dreamer", read: "soft gaze drifting past the lens" },
  { id: "wise-head", label: "the wise head", read: "calm, thoughtful, an easy patient look", maxAge: 30 },
  { id: "wildcard", label: "the wildcard", read: "unpredictable spark, lopsided grin" },
  { id: "mastermind-in-plain-sight", label: "the mastermind in plain sight", read: "pleasant, unreadable, perfectly relaxed" },
  { id: "life-of-the-party", label: "the life of the party", read: "big laugh, animated hands, lit up" },
  { id: "gentle-giant", label: "the gentle giant", read: "solid, easy posture, a soft smile" },
  { id: "competitor", label: "the competitor", read: "focused eyes, set jaw, ready stance" },
  { id: "natural", label: "the natural", read: "unforced, camera-comfortable, effortlessly at home" },
];

/** The public card for a stored type. */
export function castingTypeCard(t: { label: string; read: string }): CastingTypeCard {
  return { label: t.label, read: t.read };
}

/** Counts a deal reports (ORW-432): how many slots found no unused compatible type and took the least-conflicting one. */
export interface CastingDealReport { fallbacks: number }

/**
 * Deal one type per houseguest: exactly ONE `rng.int` each, no rejection loop, drawn up front in slot order
 * (the stream advances exactly as before). Each draw maps onto the types still unused, allowed for that age
 * and (ORW-432) COMPATIBLE with that houseguest's archetype, demeanor and strategy style by the table in
 * `traitConsistency.ts`. Slots with the fewest compatible types choose first, so a hard-to-suit houseguest is
 * not left with what the others did not want. When no unused compatible type is left the slot takes the unused
 * type with the fewest conflicts (counted in `report.fallbacks`); past the list size it reuses (unreachable in
 * a 15-cast). Without `traits` every type is compatible and this is the ORW-381 deal. Pure of every stat,
 * secret and Vault field: only age, the three public traits and the rng stream choose.
 */
export function dealCastingTypes(
  rng: { int(maxExclusive: number): number }, count: number, ages?: readonly number[],
  traits?: readonly FitTraits[], report?: CastingDealReport,
): CastingType[] {
  const draws = Array.from({ length: count }, () => rng.int(1_000_000));
  const ageOk = (t: CastingType, age: number | undefined): boolean =>
    age === undefined || ((t.minAge === undefined || age >= t.minAge) && (t.maxAge === undefined || age <= t.maxAge));
  const fits = (t: CastingType, i: number): boolean => traits?.[i] === undefined || castingCompatible(t.id, traits[i]!);
  const room = (i: number): number => CASTING_TYPES.filter((t) => ageOk(t, ages?.[i]) && fits(t, i)).length;
  const order = Array.from({ length: count }, (_, i) => i);
  if (traits) order.sort((a, b) => room(a) - room(b) || a - b);
  const used = new Set<string>();
  const out: CastingType[] = new Array<CastingType>(count);
  for (const i of order) {
    const unused = CASTING_TYPES.filter((t) => !used.has(t.id));
    const pool = unused.length ? unused : CASTING_TYPES;
    const allowed = pool.filter((t) => ageOk(t, ages?.[i]));
    const base = allowed.length ? allowed : pool;
    let from = base.filter((t) => fits(t, i));
    if (!from.length) {
      const conflict = (t: CastingType): number => castingConflict(t.id, traits![i]!);
      const least = Math.min(...base.map(conflict));
      from = base.filter((t) => conflict(t) === least);
      if (report) report.fallbacks++;
    }
    const t = from[Math.floor((draws[i]! / 1_000_000) * from.length) % from.length]!;
    used.add(t.id);
    out[i] = t;
  }
  return out;
}
