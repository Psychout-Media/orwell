/**
 * ORW-509 - composed floors. A hand list of 4 lines is dealt over and over; a list COMPOSED from independent parts is a product (6 x 8 x 12 = 576
 * from 26 authored pieces). This is the offline/headless floor only: the writer authors the live line from the season's own facts (no menu in its
 * prompt), and these parts are what the engine says when no writer is reachable.
 *
 * Determinism contract (same as the rest of the engine): a composed pick consumes exactly ONE draw from the caller's stream (the draw the old list pick
 * already made), and every other choice is decoded from that one draw by mixed-radix arithmetic, so no other field's stream moves and the main rng's
 * consumption is unchanged. Pure; no I/O.
 */

/** The largest single draw range. rng.int(n) is floor(next() * n) on a double, exact far past this; 2^31 keeps every consumer's arithmetic in int range. */
export const MAX_DRAW = 2 ** 31 - 1;

/** The number of combinations the axes make (capped at MAX_DRAW so one draw can address any of them). */
export function composedSize(axes: ReadonlyArray<ReadonlyArray<unknown>>): number {
  let n = 1;
  for (const a of axes) n = Math.min(MAX_DRAW, n * Math.max(1, a.length));
  return n;
}

/** Decode `index` (0 <= index < size) into one piece per axis, last axis fastest. */
export function composedAt<T>(axes: ReadonlyArray<ReadonlyArray<T>>, index: number): T[] {
  const out: T[] = new Array(axes.length);
  let rest = Math.max(0, Math.floor(index));
  for (let i = axes.length - 1; i >= 0; i--) {
    const axis = axes[i]!;
    out[i] = axis[rest % axis.length]!;
    rest = Math.floor(rest / axis.length);
  }
  return out;
}

/** Every combination as a joined string (materialised once, for a floor that must stay an array, e.g. a pool the old code `pick`ed from). */
export function composeAll(axes: ReadonlyArray<ReadonlyArray<string>>, join: (parts: string[]) => string = (p) => p.join(" ")): string[] {
  const size = composedSize(axes);
  const seen = new Set<string>();
  for (let i = 0; i < size; i++) seen.add(join(composedAt(axes, i)));
  return [...seen];
}

/** One draw from `rng` (the single draw the old list pick made), decoded into the composed line. */
export function pickComposed(
  rng: { int(maxExclusive: number): number },
  axes: ReadonlyArray<ReadonlyArray<string>>,
  join: (parts: string[]) => string = (p) => p.join(" "),
): string {
  return join(composedAt(axes, rng.int(composedSize(axes))));
}

/** Join pieces and tidy whitespace; empty pieces are skipped so an optional axis can carry "". */
export const joinWords = (parts: string[]): string => parts.filter((p) => p !== "").join(" ").replace(/\s+/g, " ").trim();

/**
 * Walk forward from `start` (wrapping) until `ok(line)` accepts, at most `budget` probes; returns the first accepted line, or the start line if the
 * budget runs out (a plain fallback, never a blocked call). `rejected` counts how many probes were refused. Bounded retries, then plain fallback.
 */
export function firstAccepted(
  axes: ReadonlyArray<ReadonlyArray<string>>,
  start: number,
  ok: (line: string) => boolean,
  join: (parts: string[]) => string = joinWords,
  budget = 64,
): { line: string; rejected: number } {
  const size = composedSize(axes);
  let rejected = 0;
  for (let k = 0; k < Math.min(budget, size); k++) {
    const line = join(composedAt(axes, (start + k) % size));
    if (ok(line)) return { line, rejected };
    rejected++;
  }
  return { line: join(composedAt(axes, start % size)), rejected };
}

/** A small deterministic stream for a side key (FNV-1a seeded LCG), independent of any main stream; same shape as the engine's other side streams. */
export function sideStream(key: string): { next(): number; int(n: number): number } {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  let x = h || 1;
  const next = (): number => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    x = (x ^ (x >>> 15)) >>> 0; // spread the LCG's weak low bits before they are read
    return x / 4294967296;
  };
  return { next, int: (n: number) => Math.min(n - 1, Math.floor(next() * n)) };
}

/**
 * ORW-509 season memory for the non-character world lists: what the previous seasons on this install used, as an EXPLICIT input (default empty). The engine
 * never reads a store; the caller hands this in, and the adapter persists it with the season so a restart derives the same skins. Every field is a list of
 * plain strings/ids and none is private. (The character-side ledger, `recentSeasons`, is owned by the ORW-508 branch; this is the world-side slice.)
 */
export interface WorldAvoid {
  /** Competition theme ids used by the previous season(s). */
  compThemes?: string[];
  /** Titles the writer authored for the previous season(s)' competitions. */
  compThemeTitles?: string[];
  /** Alliance names used by the previous season(s). */
  allianceNames?: string[];
  /** Room names of the previous season's house (a new authored house is refused when it reuses too many). */
  houseRoomNames?: string[];
  /** House theme ids of the previous season(s). */
  houseThemes?: string[];
  /** House-event lines (without the week stamp) used by the previous season(s). */
  eventLines?: string[];
}
