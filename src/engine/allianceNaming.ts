/**
 * ORW-566 / spec 0183 (Theme 3 slice 7, part c2) - FORMATION-TIME ALLIANCE NAMING through an ANONYMIZED SEALED-PROMPT DOOR.
 *
 * Every alliance (the ones nobody but its members knows included) gets a name when it forms. The name the members would call themselves is authored
 * live by a model from anonymous shared traits and the house's culture; this module is the pure half of the door that lets the front end do that
 * WITHOUT ever learning who is in any alliance. VAULT-CLASS: the name is hidden engine-only content (it spreads later as a claim; nothing here exposes it).
 *
 * The wall, in four rules (each is a test):
 *  1. Nothing identifying in the prompt: no ids, names, member count, room or day tied to the group. A trait appears only when at least
 *     (members + `floorExtra`) LIVING houseguests share it (a k-anonymity floor), so a trait only a couple of people have is dropped.
 *  2. No timing or count side channel: one FIXED-SIZE batch (`batch` tickets) once per in-game night, real tickets padded with DECOYS built from random
 *     k-anonymous trait sets. Every pick is a keyed `agendaRoll` hash (no shared rng), so a seeded game stays byte-identical.
 *  3. One-way tickets: opaque, single-use; only the engine can map a ticket to an alliance; a write-back answers a bare receipt for real and decoy alike.
 *  4. The engine validates every returned name; a rejected one leaves the floor name in place.
 *
 * The prompt states RULES only: no sample name, no example line, no quoted word list.
 */
import type { EntityId } from "../domain/ids";
import { agendaRoll } from "./agenda";
import { ALLIANCE } from "./alliances";
import { cleanText, AUTHORED, type HouseCulture } from "./npcMindsAuthored";

export const ALLIANCE_NAMING = {
  /**
   * Tickets per night, always. Three covers the busiest night the live society forms (it founds at most one alliance per tick, so one night rarely
   * holds more than a couple) while keeping the nightly utility-call cost small; a fourth pending alliance simply waits for the next night, and the
   * fixed cadence is the cover, so it is never raised or lowered by how many alliances formed.
   */
  batch: 3,
  /** How many anonymous traits every prompt carries at most. The count actually used is `traitCount` below: the same for every ticket of every night regardless of what formed. */
  traitsPerPrompt: 3,
  /** The k-anonymity margin: a trait must be shared by at least (members + this) living houseguests. */
  floorExtra: 2,
  /** A decoy imitates a group of 2 up to the largest an NPC alliance can be (`ALLIANCE.maxNpcSize` plus the culture's one-step allowance) when it picks its trait floor. */
  decoyMinMembers: 2,
  decoyMaxMembers: ALLIANCE.maxNpcSize + 1,
  /** Name bounds (characters, words). The upper character bound is the shared authored-name cap. */
  minChars: 3,
  maxWords: 5,
} as const;

/** One issued ticket: engine-only. `prompt` is the whole text handed to the writer; a decoy and a real ticket are the same shape. */
export interface NameTicket { kind: "real" | "decoy"; allianceId?: string; issuedNight: number; prompt: string }
export type NameTickets = Record<string, NameTicket>;

/** The RULES half of the prompt: states constraints, never a sample. */
export const NAME_RULES =
  "You are naming a private group of reality-show houseguests who have just made a pact. You are given a short list of anonymous traits that people in the group have in common, and the culture of the house they live in. " +
  "Write the one name the members would privately call themselves. " +
  "Rules: the name is two to four plain words. It must grow out of the traits and the house culture given below. " +
  "It must not be a generic label. It must not contain any person's name, any place name, any digit, or any word about votes, secrets or strategy. " +
  "It must read as a name the members chose for themselves, not a description of them. " +
  "Reply with the name only: no quotation marks, no explanation, no extra lines.";

export type TraitTable = ReadonlyMap<EntityId, readonly string[]>;

/** How many living houseguests carry each trait. */
export function traitCounts(table: TraitTable): Map<string, number> {
  const counts = new Map<string, number>();
  for (const traits of table.values()) for (const t of new Set(traits)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return counts;
}

/** Traits every member carries AND at least `members + floorExtra` living houseguests carry (the k-anonymity floor); anything failing the floor is dropped. */
export function sharedAnonymousTraits(members: readonly EntityId[], table: TraitTable, counts: ReadonlyMap<string, number>): string[] {
  if (members.length === 0) return [];
  const floor = members.length + ALLIANCE_NAMING.floorExtra;
  const first = table.get(members[0]!) ?? [];
  return [...new Set(first)].filter((t) => members.every((m) => (table.get(m) ?? []).includes(t)) && (counts.get(t) ?? 0) >= floor).sort();
}

/** Every trait at least `floor` living houseguests carry (the pool a decoy and a padded real prompt draw from). */
export function anonymousPool(counts: ReadonlyMap<string, number>, floor: number): string[] {
  return [...counts.entries()].filter(([, n]) => n >= floor).map(([t]) => t).sort();
}

/**
 * How many traits EVERY prompt of a night carries: the most that even the largest possible group's floor can fill (so a real group of any size and any decoy can
 * always reach it), capped at `traitsPerPrompt`. It depends on who is living, never on what formed, so the read's shape cannot show an alliance.
 */
export function traitCount(counts: ReadonlyMap<string, number>): number {
  return Math.min(ALLIANCE_NAMING.traitsPerPrompt, anonymousPool(counts, ALLIANCE_NAMING.decoyMaxMembers + ALLIANCE_NAMING.floorExtra).length);
}

/** Rank `traits` by a keyed roll (highest first) and keep `n`. Keyed hashing only: never the shared rng. */
function ranked(seed: number, key: string, traits: readonly string[], n: number): string[] {
  return [...traits].sort((a, b) => agendaRoll(seed, key, `nm:${b}`) - agendaRoll(seed, key, `nm:${a}`) || a.localeCompare(b)).slice(0, n);
}

/** The prompt's culture block: the house's own words, the same text in every ticket (so it says nothing about any one group). */
function cultureBlock(culture: HouseCulture | undefined): { spotNicknames: string[]; ritualNames: string[]; runningJoke?: string } {
  return { spotNicknames: (culture?.spots ?? []).map((s) => s.nickname), ritualNames: (culture?.rituals ?? []).map((r) => r.name), ...(culture?.runningJoke ? { runningJoke: culture.runningJoke } : {}) };
}

/** The WHOLE prompt text: rules, then the anonymous traits and the house culture as one JSON line. Identical structure for a real and a decoy ticket. */
export function buildNamePrompt(traits: readonly string[], culture: HouseCulture | undefined): string {
  return `${NAME_RULES}\n${JSON.stringify({ sharedTraits: [...traits], houseCulture: cultureBlock(culture) })}`;
}

export interface PendingAlliance { id: string; members: readonly EntityId[] }

/**
 * Issue one night's FIXED-SIZE batch: up to `batch` real tickets (first come first served) padded with decoys to exactly `batch`. A real ticket's traits are the
 * group's shared anonymous traits, padded with random pool traits to `traitsPerPrompt`; a decoy's are random pool traits at a floor drawn like a real group's.
 * Which slots are real is a keyed shuffle, so a ticket's position and its id say nothing. Pure and deterministic.
 */
export function issueNightBatch(args: { seed: number; night: number; pending: readonly PendingAlliance[]; table: TraitTable; culture: HouseCulture | undefined }): NameTickets {
  const { seed, night, pending, table, culture } = args;
  const N = ALLIANCE_NAMING.batch;
  const counts = traitCounts(table);
  const T = traitCount(counts);
  const reals = pending.slice(0, N);
  const slots = Array.from({ length: N }, (_, i) => i).sort((a, b) => agendaRoll(seed, "name-slot", `${night}:${b}`) - agendaRoll(seed, "name-slot", `${night}:${a}`) || a - b);
  const realSlot = new Map<number, PendingAlliance>();
  reals.forEach((p, i) => realSlot.set(slots[i]!, p));
  const out: NameTickets = {};
  for (let slot = 0; slot < N; slot++) {
    const ticket = `nt-${[0, 1, 2].map((k) => Math.floor(agendaRoll(seed, "name-ticket", `${night}:${slot}:${k}`) * 0xffffffff).toString(16).padStart(8, "0")).join("")}`;
    const real = realSlot.get(slot);
    const key = `${night}:${slot}`;
    let traits: string[];
    if (real) {
      const shared = sharedAnonymousTraits(real.members, table, counts);
      const pool = anonymousPool(counts, real.members.length + ALLIANCE_NAMING.floorExtra).filter((t) => !shared.includes(t));
      const keep = ranked(seed, key, shared, T);
      traits = [...keep, ...ranked(seed, `${key}:pad`, pool, T - keep.length)];
    } else {
      const size = ALLIANCE_NAMING.decoyMinMembers + Math.floor(agendaRoll(seed, "name-decoy-size", key) * (ALLIANCE_NAMING.decoyMaxMembers - ALLIANCE_NAMING.decoyMinMembers + 1));
      traits = ranked(seed, `${key}:decoy`, anonymousPool(counts, size + ALLIANCE_NAMING.floorExtra), T);
    }
    out[ticket] = { kind: real ? "real" : "decoy", ...(real ? { allianceId: real.id } : {}), issuedNight: night, prompt: buildNamePrompt(traits.sort(), culture) };
  }
  return out;
}

/** Lower-case a name to its comparison form (drops a leading article and punctuation), the same shape the alliance store compares. */
export const normName = (t: string): string => t.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();

export interface NameCheck {
  /** Every houseguest's name words (any houseguest, not only the members), lower-cased. */
  peopleWords: ReadonlySet<string>;
  /** The normalised names already taken by any other alliance (shown or sealed) and by the house's avoid list. */
  takenNorm: ReadonlySet<string>;
}

/** Validate the model's name engine-side: cleaned text, bounded, no houseguest's name, no collision. Undefined means refused (the floor stands). */
export function validateAllianceName(raw: unknown, check: NameCheck): string | undefined {
  if (typeof raw !== "string") return undefined;
  const bare = raw.trim().replace(/^["'“‘]+|["'”’.]+$/g, "");
  const name = cleanText(bare, AUTHORED.maxName);
  if (!name || name.length < ALLIANCE_NAMING.minChars || bare.length > AUTHORED.maxName) return undefined;
  if (name.split(/\s+/).length > ALLIANCE_NAMING.maxWords) return undefined;
  const words = name.toLowerCase().replace(/['’]s\b/g, "").split(/[^a-z]+/).filter(Boolean);
  if (words.some((w) => check.peopleWords.has(w))) return undefined;
  if (check.takenNorm.has(normName(name)) || normName(name).length < ALLIANCE_NAMING.minChars) return undefined;
  return name;
}
