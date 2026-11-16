/**
 * ORW-551 / spec 0162 (slice 1 of the season house culture): a loose, seeded blend of a few "leans" (gossipy, strategic, flirty, catty ...) that, in
 * later slices, will skew the house dials a little. NEVER a label or a fixed script: individual houseguests still vary and can push against it.
 *
 * SLICE 1 IS THE FOUNDATION ONLY: this module draws, stores and (in texture words) describes the blend. NOTHING consumes `dialMult` yet, so the house
 * mix and every seeded sim are byte-identical to before.
 *
 * VAULT-CLASS and ENGINE-ONLY (listed in the dependency-cruiser engine denylist): the lean ids and weights never reach a projection, prompt, tool result,
 * log or debug-safe view. The ONLY outward door is `describeHouseLeans`, called from `GameSessionAdapter.seasonRetrospective()` behind the `finished`
 * crown gate, and it returns texture words only - never an id, a weight or a number.
 *
 * Pure: no I/O. The draw uses its own side stream (`${seed}:culture`), so it cannot shift any shared random stream.
 */
import { SeededRandom } from "../adapters/random/SeededRandom";
import { hashSeed } from "./characterFactory";

export const LEAN_IDS = [
  "gossip-mill", "chess-club", "showmance", "catty", "one-big-family", "paranoid", "floaters", "comp-beasts", "majority-bloc", "duos", "chaos",
  "ride-or-die", "backstabbers", "party-house", "cold-war", "powder-keg", "bedroom-factions", "slow-burn", "honor-code", "liars-season", "puppet-master", "underdogs",
] as const;
export type LeanId = (typeof LEAN_IDS)[number];

export const DIAL_IDS = [
  "bonding", "lying", "gossip", "credulity", "flirting", "conflict", "allianceSize", "loyalty", "paranoia", "compFocus", "meetings",
] as const;
export type DialId = (typeof DIAL_IDS)[number];

/** One tunable block. A blend never exceeds ONE lean's full effect (weights sum to 1), and no dial ever moves more than a factor of `MAX_FACTOR` either way. */
export const HOUSE_LEAN_TUNING = {
  /** log-space strength: a lean with nudge 1 and weight 1 moves a dial by exp(0.3) ~ x1.35 before the clamp. */
  K: 0.3,
  /** the clamp: every multiplier lies in [1/MAX_FACTOR, MAX_FACTOR]. */
  MAX_FACTOR: 1.35,
  MIN_LEANS: 2,
  MAX_LEANS: 3,
  /** raw weight spread before normalising. */
  WEIGHT_MIN: 0.2,
  WEIGHT_MAX: 1,
} as const;

type Nudges = Partial<Record<DialId, number>>;

/** Small log-space nudges in [-1, 1] per dial (positive = more of it). Anything not listed is untouched (0). */
export const LEANS: Record<LeanId, Nudges> = {
  "gossip-mill":      { gossip: 1, lying: 0.4, credulity: 0.4, paranoia: 0.2 },
  "chess-club":       { paranoia: 0.6, allianceSize: 0.6, lying: 0.4, flirting: -0.4, meetings: 0.3 },
  "showmance":        { flirting: 1, bonding: 0.4, conflict: -0.2 },
  "catty":            { conflict: -0.9, gossip: 0.4, bonding: -0.3, loyalty: -0.2 },
  "one-big-family":   { bonding: 0.8, loyalty: 0.5, conflict: 0.5, lying: -0.5, paranoia: -0.5 },
  "paranoid":         { paranoia: 1, credulity: 0.5, bonding: -0.4, loyalty: -0.3 },
  "floaters":         { allianceSize: -0.6, loyalty: -0.5, compFocus: -0.3, meetings: -0.3 },
  "comp-beasts":      { compFocus: 1, conflict: -0.2, gossip: -0.3 },
  "majority-bloc":    { allianceSize: 1, loyalty: 0.5, paranoia: -0.3, meetings: 0.2 },
  "duos":             { allianceSize: -0.8, loyalty: 0.6, bonding: 0.3 },
  "chaos":            { loyalty: -0.5, conflict: -0.5, lying: 0.3, meetings: 0.4, allianceSize: -0.3 },
  "ride-or-die":      { loyalty: 1, allianceSize: -0.3, credulity: -0.3, lying: -0.2 },
  "backstabbers":     { loyalty: -1, lying: 0.6, paranoia: 0.5, bonding: -0.3 },
  "party-house":      { bonding: 0.7, flirting: 0.5, conflict: 0.3, compFocus: -0.3, paranoia: -0.4 },
  "cold-war":         { bonding: -0.7, conflict: 0.4, gossip: -0.3, paranoia: 0.4, meetings: -0.4 },
  "powder-keg":       { conflict: -1, meetings: 0.5, bonding: -0.2, loyalty: -0.2 },
  "bedroom-factions": { flirting: 0.7, allianceSize: -0.4, loyalty: 0.5, gossip: 0.3 },
  "slow-burn":        { bonding: -0.5, flirting: -0.3, conflict: 0.3, loyalty: 0.3, paranoia: -0.2 },
  "honor-code":       { lying: -0.9, loyalty: 0.6, credulity: 0.3, paranoia: -0.4 },
  "liars-season":     { lying: 1, credulity: -0.4, paranoia: 0.4, loyalty: -0.3 },
  "puppet-master":    { allianceSize: -0.5, lying: 0.5, credulity: -0.3, gossip: -0.3, meetings: -0.2 },
  "underdogs":        { compFocus: -0.5, allianceSize: 0.4, loyalty: 0.3, bonding: 0.3, paranoia: 0.2 },
};

/** Plain texture phrases for the post-season retrospective (the ONLY outward form of a lean: words, never an id, label, weight or number). */
export const LEAN_TEXTURE: Record<LeanId, string> = {
  "gossip-mill": "a house that ran on gossip",
  "chess-club": "a house that played like a chess club, everyone thinking three moves ahead",
  "showmance": "a house with romance in the air",
  "catty": "a house with a sharp tongue and a long memory for slights",
  "one-big-family": "a house that leaned toward feeling like one big family",
  "paranoid": "a house that never quite stopped looking over its shoulder",
  "floaters": "a house full of people content to float along",
  "comp-beasts": "a house that lived and died by the competitions",
  "majority-bloc": "a house where a big majority block set the pace",
  "duos": "a house that paired off into twos",
  "chaos": "a house that never held still for long",
  "ride-or-die": "a house that prized loyalty above nearly everything",
  "backstabbers": "a house where promises were cheap and knives were close",
  "party-house": "a house that leaned toward a party",
  "cold-war": "a house that kept its distance and fought in whispers",
  "powder-keg": "a house that was always one argument from blowing up",
  "bedroom-factions": "a house divided along bedroom lines",
  "slow-burn": "a house that took its time to warm up, and then burned slow",
  "honor-code": "a house with something like an honor code",
  "liars-season": "a house where lying was the common language",
  "puppet-master": "a house with a hand quietly working the strings",
  "underdogs": "a house that rooted for the underdog",
};

export interface HouseLean { id: LeanId; w: number }
/** The stored culture: the leans and their weights only (NEVER multipliers). Write-once for the season. */
export interface HouseLeans { leans: HouseLean[] }

/** Draw 2-3 distinct leans with weights from a raw 0.2-1 spread, normalised to sum 1. Own side stream `${seed}:culture`: touches no shared stream. */
export function drawHouseLeans(seed: number | string): HouseLeans {
  const T = HOUSE_LEAN_TUNING;
  const rng = new SeededRandom(hashSeed(`${seed}:culture`));
  const count = T.MIN_LEANS + Math.floor(rng.next() * (T.MAX_LEANS - T.MIN_LEANS + 1));
  const pool = [...LEAN_IDS];
  const picked: LeanId[] = [];
  for (let i = 0; i < count; i++) picked.push(pool.splice(Math.min(pool.length - 1, Math.floor(rng.next() * pool.length)), 1)[0]!);
  const raw = picked.map(() => T.WEIGHT_MIN + rng.next() * (T.WEIGHT_MAX - T.WEIGHT_MIN));
  const sum = raw.reduce((a, b) => a + b, 0);
  return { leans: picked.map((id, i) => ({ id, w: raw[i]! / sum })) };
}

/** The multiplier a culture puts on one house dial: clamp(exp(sum w_i * nudge_i * K), 1/F, F). EXACTLY 1 with no culture. Nothing consumes it in slice 1. */
export function dialMult(culture: HouseLeans | undefined, dial: DialId): number {
  if (!culture || culture.leans.length === 0) return 1;
  const T = HOUSE_LEAN_TUNING;
  let s = 0;
  for (const l of culture.leans) s += l.w * (LEANS[l.id]?.[dial] ?? 0) * T.K;
  return Math.min(T.MAX_FACTOR, Math.max(1 / T.MAX_FACTOR, Math.exp(s)));
}

/** The retrospective's words for a culture: one plain phrase per lean, heaviest first. Never an id, a weight or a number. */
export function describeHouseLeans(culture: HouseLeans | undefined): string[] {
  if (!culture || culture.leans.length === 0) return [];
  return [...culture.leans].sort((a, b) => b.w - a.w || (a.id < b.id ? -1 : 1)).map((l) => LEAN_TEXTURE[l.id]).filter((t): t is string => !!t);
}
