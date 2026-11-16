/**
 * ORW-508 Layer 3(b): a memory of what the last seasons on an install used, so the next cast can avoid it.
 *
 * Pure data and pure functions: no file, no clock, no randomness. The front end stores the ledger (per
 * user, outside any save) and passes the avoid sets to the engine as an explicit input, the way
 * `priorCastNames` already travels. Seeded headless runs and tests never pass one, so they never see it.
 * Same (seed, avoid) gives the same cast.
 */

/** What one finished season used. Every list is optional and bounded. */
export interface SeasonFacts {
  names?: readonly string[];
  hometowns?: readonly string[];
  vocations?: readonly string[];
  marks?: readonly string[];
  /** Wardrobe main pieces, onCamera openers and closers, voice catchphrases: anything the writer favours. */
  phrases?: readonly string[];
}

export interface RecentSeasonsLedger {
  readonly version: 1;
  /** Oldest first, newest last. */
  readonly seasons: readonly SeasonFacts[];
}

export type FactKind = keyof SeasonFacts;
export const FACT_KINDS: readonly FactKind[] = ["names", "hometowns", "vocations", "marks", "phrases"];

/** How many finished seasons are remembered. */
export const LEDGER_WINDOW = 6;
const MAX_ITEMS_PER_KIND = 80;
const MAX_ITEM_CHARS = 120;

export const emptyLedger = (): RecentSeasonsLedger => ({ version: 1, seasons: [] });

const cleanList = (xs: unknown): string[] => {
  if (!Array.isArray(xs)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    if (typeof x !== "string") continue;
    const v = x.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS);
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
    if (out.length >= MAX_ITEMS_PER_KIND) break;
  }
  return out;
};

const cleanSeason = (s: unknown): SeasonFacts => {
  const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  for (const k of FACT_KINDS) { const l = cleanList(o[k]); if (l.length) out[k] = l; }
  return out as SeasonFacts;
};

/** Read a stored ledger. Anything malformed becomes an empty or shorter ledger, never an error. */
export function parseLedger(raw: unknown): RecentSeasonsLedger {
  const o = (raw && typeof raw === "object" ? raw : {}) as { seasons?: unknown };
  const seasons = Array.isArray(o.seasons) ? o.seasons.map(cleanSeason).filter((s) => FACT_KINDS.some((k) => (s[k]?.length ?? 0) > 0)) : [];
  return { version: 1, seasons: seasons.slice(-LEDGER_WINDOW) };
}

/** Add a finished season; the oldest falls off past the window. Returns a new ledger. */
export function recordSeason(ledger: RecentSeasonsLedger, facts: SeasonFacts, window = LEDGER_WINDOW): RecentSeasonsLedger {
  const season = cleanSeason(facts);
  if (!FACT_KINDS.some((k) => (season[k]?.length ?? 0) > 0)) return ledger;
  return { version: 1, seasons: [...ledger.seasons, season].slice(-Math.max(1, window)) };
}

/** The sets the engine avoids: everything the remembered seasons used, lower-cased for comparison. */
export interface AvoidSets {
  readonly names: ReadonlySet<string>;
  readonly hometowns: ReadonlySet<string>;
  readonly vocations: ReadonlySet<string>;
  readonly marks: ReadonlySet<string>;
  readonly phrases: ReadonlySet<string>;
}

export const NO_AVOID: AvoidSets = {
  names: new Set(), hometowns: new Set(), vocations: new Set(), marks: new Set(), phrases: new Set(),
};

/** Avoid sets for the last `lastN` seasons (all remembered ones by default). */
export function avoidSets(ledger: RecentSeasonsLedger, lastN = LEDGER_WINDOW): AvoidSets {
  const take = ledger.seasons.slice(-Math.max(0, lastN));
  const set = (k: FactKind): Set<string> => new Set(take.flatMap((s) => (s[k] ?? []).map((v) => v.toLowerCase())));
  return { names: set("names"), hometowns: set("hometowns"), vocations: set("vocations"), marks: set("marks"), phrases: set("phrases") };
}

/** Facts of a dealt cast, ready for `recordSeason`. Takes plain cards so it has no engine import. */
export function factsOfCast(cards: ReadonlyArray<{ name?: string; vocation?: string; hometown?: string; distinguishingMark?: string }>): SeasonFacts {
  const mark = (m?: string) => (m && !/^none\b/i.test(m) ? m : undefined);
  const pick = (f: (c: (typeof cards)[number]) => string | undefined): string[] => cards.map(f).filter((v): v is string => !!v);
  return {
    names: pick((c) => c.name), hometowns: pick((c) => c.hometown), vocations: pick((c) => c.vocation), marks: pick((c) => mark(c.distinguishingMark)),
  };
}

/** The avoid lists as they cross the front-end/engine boundary: plain string arrays, same keys as `SeasonFacts`. */
export type AvoidWire = { readonly [K in FactKind]?: readonly string[] };

/** Read an avoid input from a tool call. Anything malformed is dropped (never an error); undefined when nothing is left. */
export function avoidFromWire(raw: unknown): AvoidSets | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const set = (k: FactKind): Set<string> => new Set(cleanList(o[k]).map((v) => v.toLowerCase()));
  const out: AvoidSets = { names: set("names"), hometowns: set("hometowns"), vocations: set("vocations"), marks: set("marks"), phrases: set("phrases") };
  return FACT_KINDS.some((k) => out[k].size > 0) ? out : undefined;
}

/** The wire form of a ledger's avoid sets (what the front end sends with preSeedCast and createCharacter). */
export function avoidToWire(a: AvoidSets): AvoidWire {
  return { names: [...a.names], hometowns: [...a.hometowns], vocations: [...a.vocations], marks: [...a.marks], phrases: [...a.phrases] };
}
