/**
 * ORW-381: the casting TYPE list. Each houseguest is cast as one type at character creation: how they read
 * on camera. PRESENTATION ONLY: no mechanic, outcome, stat or hidden field reads it, and it is dealt without
 * looking at any stat or hidden field (ORW-432: it is dealt from the types compatible with the houseguest's
 * public archetype, demeanor and strategy style, see traitConsistency.ts). `label` is the base label and a type may carry gendered variants picked for the person it is dealt to (ORW-467); `read` is five to ten camera-visible words (never a
 * motive, secret or number). `minAge` / `maxAge` bound who may be cast as the type. Public and Vault-free.
 */
import { castingCompatible, castingConflict, type FitTraits } from "./traitConsistency";

/** How a houseguest presents (the one enum every facet shares, see `domain/gender.ts`). */
export type CastingPresentation = "man" | "woman" | "nonbinary";

/**
 * ORW-467: a type's gender LEAN: how much more often it is dealt to each presentation. Weights are positive
 * integers (never zero: a lean is never a rule), 3 each is "no lean". Only the deal reads it.
 */
export type CastingLean = Readonly<Record<CastingPresentation, number>>;

export interface CastingType {
  readonly id: string;
  /** The label for a person with no variant of their own (and the one a pre-ORW-467 save stores). */
  readonly label: string;
  readonly read: string;
  /** Age lean: who may be cast as the type. */
  readonly minAge?: number;
  readonly maxAge?: number;
  /** Gender lean (see CastingLean). Absent means no lean. */
  readonly lean?: CastingLean;
  /** Gendered name variants: the label shown for a person who presents that way. All one type (same id). */
  readonly variants?: Partial<Record<CastingPresentation, string>>;
}

/** The public card shape: label and read only. */
export interface CastingTypeCard { label: string; read: string }

/** The weight of a type for a person: its lean for their presentation, 3 when it has none or the presentation is unknown. */
const NO_LEAN = 3;
const weightOf = (t: CastingType, g: CastingPresentation | undefined): number => (g === undefined ? NO_LEAN : t.lean?.[g] ?? NO_LEAN);

/** One seeded pick from `from` by weight; `u` is a draw in [0, 1). Equal weights reduce to the old uniform `floor(u * n)`. */
function pickWeighted(from: readonly CastingType[], u: number, g: CastingPresentation | undefined): CastingType {
  const total = from.reduce((n, t) => n + weightOf(t, g), 0);
  let x = u * total;
  for (const t of from) { x -= weightOf(t, g); if (x < 0) return t; }
  return from[from.length - 1]!;
}

/** The type as dealt to this person: the same id, read and bounds, with the label picked for them. */
const dealt = (t: CastingType, g: CastingPresentation | undefined): CastingType => ({ ...t, label: castingLabelFor(t, g) });
/** Leans: strong (about 8 in 10 of the type's holders present that way), soft (about 6 in 10 to 7 in 10). */
const W_STRONG: CastingLean = { woman: 6, man: 2, nonbinary: 3 };
const M_STRONG: CastingLean = { woman: 1, man: 7, nonbinary: 3 };
const W_SOFT: CastingLean = { woman: 5, man: 2, nonbinary: 3 };
const M_SOFT: CastingLean = { woman: 2, man: 5, nonbinary: 3 };
const T = (id: string, label: string, read: string, extra: Partial<Pick<CastingType, "minAge" | "maxAge" | "lean" | "variants">> = {}): CastingType =>
  ({ id, label, read, ...extra });

/** The label for the person it is dealt to: their variant when the type has one, else the base label. */
export function castingLabelFor(t: CastingType, presentation?: CastingPresentation): string {
  return (presentation !== undefined ? t.variants?.[presentation] : undefined) ?? t.label;
}

/** Every label a type can wear (base plus variants), for reading a stored label back to its id. */
export function castingLabelsOf(t: CastingType): string[] {
  return [...new Set([t.label, ...Object.values(t.variants ?? {})])];
}

export const CASTING_TYPES: readonly CastingType[] = [
  T("charmer", "the charmer", "easy smile, relaxed and assured, plays to the camera"),
  T("firecracker", "the firecracker", "quick, bright-eyed, chin up, ready to argue", { lean: W_SOFT }),
  T("jock", "the jock", "athletic ease, loose shoulders, competitive grin", { lean: M_SOFT }),
  T("sweetheart", "the sweetheart", "open face, warm soft smile", { lean: W_SOFT }),
  T("brain", "the brain", "observant, composed, a knowing look"),
  T("class-clown", "the class clown", "mischief in the eyes, grin first", { lean: M_SOFT }),
  T("rebel", "the rebel", "cool stare, shoulders loose, unbothered"),
  T("free-spirit", "the free spirit", "dreamy, loose, sunny, easy in the shoulders"),
  T("hustler", "the hustler", "sharp, forward-leaning, ready with a salesman's smile", { lean: M_SOFT }),
  T("quiet-storm", "the quiet storm", "still, watchful, a small private smile"),
  // The old gendered names are back (ORW-467). The diva leans towards women (about 8 in 10) and stays "the diva" for anyone.
  T("diva", "the diva", "posed, polished, owns the frame", { lean: W_STRONG }),
  T("parent-of-the-house", "the parent of the house", "steady, kind eyes, arms loosely crossed",
    { minAge: 36, lean: W_SOFT, variants: { woman: "the mom of the house", man: "the dad of the house" } }),
  T("silver-fox", "the silver fox", "distinguished, amused, entirely at ease in the room",
    { minAge: 45, lean: M_SOFT, variants: { woman: "the silver vixen" } }),
  T("underdog", "the underdog", "earnest, hopeful, a little shy"),
  T("flirt", "the flirt", "playful eye contact, head tilt"),
  T("straight-shooter", "the straight shooter", "level gaze, steady brow, no-nonsense half-smile"),
  T("dreamer", "the dreamer", "soft gaze drifting past the lens"),
  T("wise-head", "the wise head", "calm, thoughtful, an easy patient look", { maxAge: 30 }),
  T("wildcard", "the wildcard", "unpredictable spark, restless eyes, lopsided grin"),
  T("mastermind-in-plain-sight", "the mastermind in plain sight", "pleasant, unreadable, perfectly relaxed, gives nothing away"),
  T("life-of-the-party", "the life of the party", "big laugh, animated hands, lit up"),
  T("gentle-giant", "the gentle giant", "solid, easy posture, a soft smile", { lean: M_SOFT }),
  T("competitor", "the competitor", "focused eyes, set jaw, ready stance"),
  T("natural", "the natural", "unforced, camera-comfortable, effortlessly at home"),
  // ORW-467: the wider run of television types.
  T("villain", "the villain", "slow smile, hooded eyes, enjoys being the threat", { lean: { woman: 3, man: 4, nonbinary: 3 } }),
  T("floater", "the floater", "relaxed, agreeable, drifting along, never in the way"),
  T("superfan", "the superfan", "wide-eyed delight, knows every rule, barely contained"),
  T("showmance-seeker", "the showmance seeker", "glances held a beat long, hopeful and openly smitten"),
  T("schemer", "the schemer", "eyes everywhere, a ready smile, always a step ahead", { lean: { woman: 3, man: 4, nonbinary: 3 } }),
  T("hothead", "the hothead", "tight jaw, bristling, one comment from erupting", { lean: M_SOFT }),
  T("wallflower", "the wallflower", "hangs back at the frame's edge, shy and watchful", { lean: { woman: 4, man: 3, nonbinary: 4 } }),
  T("comp-beast", "the comp beast", "built for challenges, stretching out, locked in, intense", { lean: M_SOFT }),
  T("old-school-player", "the old-school player", "seen every season, dry knowing look, slow nod", { minAge: 38, lean: M_SOFT }),
  T("influencer", "the influencer", "camera-ready angles, phone-ready smile, always mid-pose", { maxAge: 34, lean: W_SOFT }),
  T("country-kid", "the country kid", "open-faced, easygoing, small-town warmth in the smile",
    { maxAge: 36, variants: { woman: "the country girl", man: "the country boy" } }),
  T("know-it-all", "the know-it-all", "chin up, ready to correct you, certain of everything", { lean: M_SOFT }),
  T("bombshell", "the stunner", "model-ready looks, knows it, holds the frame",
    { maxAge: 40, variants: { woman: "the bombshell", man: "the hunk" } }),
  T("queen-bee", "the ringleader", "holds court, everyone angled toward them, effortlessly in charge",
    { variants: { woman: "the queen bee", man: "the top dog" } }),
  T("heartbreaker", "the heartbreaker", "lazy half-smile, unhurried eye contact, plays it cool", { lean: M_SOFT }),
  T("good-sport", "the good sport", "easy banter, friendly shoulder-bump, fits in anywhere",
    { variants: { woman: "the girls' girl", man: "the guys' guy" } }),
  T("cool-relative", "the cool relative", "laid-back warmth, a knowing wink, tells good stories",
    { minAge: 33, variants: { woman: "the cool aunt", man: "the cool uncle" } }),
  T("drama-magnet", "the drama magnet", "eyes wide, always mid-story, trouble nearby", { lean: W_SOFT }),
  T("tough-nut", "the tough nut", "guarded stare, folded arms, hard to crack", { lean: M_SOFT }),
  T("puzzle-head", "the puzzle head", "bright curious eyes, mind visibly working, a little awkward", { lean: M_SOFT }),
  T("hopeless-romantic", "the hopeless romantic", "soft-eyed, wears feelings openly, sentimental half-smile", { lean: W_SOFT }),
  T("trash-talker", "the trash talker", "smirk, pointed finger, talks big and means it", { lean: M_STRONG }),
  T("cheerleader", "the cheerleader", "bright smile, thumbs up, hyping everyone around", { lean: W_SOFT }),
  T("sleeper", "the sleeper", "mild and unassuming, eyes quietly taking inventory"),
  T("gym-rat", "the gym rat", "pumped up, flexing without trying, mirror-ready", { maxAge: 45, lean: M_STRONG }),
  T("sophisticate", "the sophisticate", "polished, poised, unhurried, expensive calm", { minAge: 30, lean: W_SOFT }),
  T("sidekick", "the sidekick", "half a step behind a friend, loyal, grinning"),
  T("loose-cannon", "the loose cannon", "wild eyes, can't sit still, anything could happen", { lean: M_SOFT }),
  T("grinder", "the grinder", "sleeves up, steady, dependable, earns every inch"),
  T("fan-favorite", "the fan favorite", "instantly likable, warm grin, the room leans in"),
  T("enigma", "the enigma", "faraway look, strange and magnetic, hard to place"),
  T("baby-of-the-house", "the baby of the house", "wide eyes, youthful, a bit overwhelmed, eager", { maxAge: 24 }),
  T("elder-statesperson", "the elder statesperson", "commanding calm, decades of presence, unhurried and gracious",
    { minAge: 52, variants: { woman: "the grande dame", man: "the elder statesman" } }),
  T("loudmouth", "the loudmouth", "booming laugh, talks over everyone, takes the whole room", { lean: M_SOFT }),
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
 * a 15-cast). ORW-467: when a houseguest's `genderPresentation` is given, each type's gender lean weights the draw
 * (never to zero: any type can be dealt to anyone) and the label is the variant for that person. Without `traits` every type is compatible and this is the ORW-381 deal. Pure of every stat,
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
  if (traits && traits.length > 0) order.sort((a, b) => room(a) - room(b) || a - b);
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
    const g = traits?.[i]?.genderPresentation;
    const t = pickWeighted(from, draws[i]! / 1_000_000, g);
    used.add(t.id);
    out[i] = dealt(t, g);
  }
  return out;
}

/**
 * ORW-432: re-check a cast's casting types after a later step (genesis, identity, authoring) changed a houseguest's
 * archetype, demeanor or strategy style. Houseguests whose type still fits keep it. The rest are re-picked from the
 * unused compatible types (else the least-conflicting unused one), using the SAME `${seed}:casting-type` draws as the
 * original deal (one `rng.int` per slot, in slot order), so the same final traits and seed give the same result on
 * replay. Idempotent: a cast that already fits comes back unchanged. Returns the new type per slot (the old one
 * where it was kept) and how many slots changed.
 */
export function recohereCastingTypes(
  rng: { int(maxExclusive: number): number }, current: readonly (CastingType | undefined)[],
  ages: readonly number[] | undefined, traits: readonly FitTraits[], report?: CastingDealReport,
): { types: CastingType[]; changed: number } {
  const count = current.length;
  const draws = Array.from({ length: count }, () => rng.int(1_000_000));
  const ageOk = (t: CastingType, age: number | undefined): boolean =>
    age === undefined || ((t.minAge === undefined || age >= t.minAge) && (t.maxAge === undefined || age <= t.maxAge));
  const out: CastingType[] = new Array<CastingType>(count);
  const used = new Set<string>();
  const redo: number[] = [];
  for (let i = 0; i < count; i++) {
    const c = current[i];
    const full = c === undefined ? undefined : CASTING_TYPES.find((t) => t.id === c.id);
    if (full && castingCompatible(full.id, traits[i]!) && ageOk(full, ages?.[i]) && !used.has(full.id)) { out[i] = dealt(full, traits[i]!.genderPresentation); used.add(full.id); }
    else redo.push(i);
  }
  const fitsSlot = (t: CastingType, i: number): boolean => ageOk(t, ages?.[i]) && castingCompatible(t.id, traits[i]!);
  // Who holds each type now. A slot that needs a type tries unused compatible types first (rotated by its draw); if
  // none is free it may take a type from a holder who can move to another compatible one (an augmenting path), so a
  // houseguest who fits nothing unused is not left with a wrong type while others hold types they could swap out of.
  // Everything is before the cast is shown, and a function of the final traits and the seed only.
  const owner = new Map<string, number>();
  out.forEach((t, i) => { if (t) owner.set(t.id, i); });
  const candidates = (i: number): CastingType[] => {
    const fit = CASTING_TYPES.filter((t) => fitsSlot(t, i));
    if (!fit.length) return [];
    const start = Math.floor((draws[i]! / 1_000_000) * fit.length) % fit.length;
    const rotated = [...fit.slice(start), ...fit.slice(0, start)];
    const free = rotated.filter((t) => !owner.has(t.id));
    // ORW-467: the first choice is the seeded weighted pick (the gender lean) among the free compatible types.
    const head = free.length ? pickWeighted(free, draws[i]! / 1_000_000, traits[i]!.genderPresentation) : undefined;
    return [...(head ? [head] : []), ...free.filter((t) => t !== head), ...rotated.filter((t) => owner.has(t.id))];
  };
  const place = (i: number, seen: Set<string>): boolean => {
    for (const t of candidates(i)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const holder = owner.get(t.id);
      if (holder === undefined || (holder !== i && place(holder, seen))) { owner.set(t.id, i); out[i] = t; return true; }
    }
    return false;
  };
  const room = (i: number): number => CASTING_TYPES.filter((t) => !owner.has(t.id) && fitsSlot(t, i)).length;
  redo.sort((a, b) => room(a) - room(b) || a - b);
  const stuck: number[] = [];
  for (const i of redo) if (!place(i, new Set())) stuck.push(i);
  for (const i of stuck) {
    const free = CASTING_TYPES.filter((t) => !owner.has(t.id));
    const pool = free.length ? free : CASTING_TYPES;
    const allowed = pool.filter((t) => ageOk(t, ages?.[i]));
    const base = allowed.length ? allowed : pool;
    const conflict = (t: CastingType): number => castingConflict(t.id, traits[i]!);
    const least = Math.min(...base.map(conflict));
    const from = base.filter((t) => conflict(t) === least);
    if (report) report.fallbacks++;
    const t = pickWeighted(from, draws[i]! / 1_000_000, traits[i]!.genderPresentation);
    owner.set(t.id, i);
    out[i] = t;
  }
  const changed = out.filter((t, i) => t.id !== current[i]?.id).length;
  // ORW-467: whichever type a slot ends with wears the label for the person (pre-game only; a saved season is never re-run).
  return { types: out.map((t, i) => dealt(t, traits[i]!.genderPresentation)), changed };
}
