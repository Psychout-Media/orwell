/**
 * ORW-510 - the LIVE counterpart of season memory: a short, bounded, rolling record of what the narrator has already aired, so the
 * writer is told what is "already used" and every turn is checked against it, counted.
 *
 * What is kept (all of it is text the player already saw; nothing hidden can enter, because the only input is the visible narration):
 *   - the recent sentence OPENINGS (the first three words of each sentence, a houseguest's name folded to a placeholder),
 *   - the recent scene CLOSERS (the last three words of each turn's last sentence),
 *   - per houseguest, the recent GESTURES (the three words that follow their name) and LINES (the first four words of a quoted line).
 *
 * Pure and deterministic: no rng, no clock, no I/O, no Vault handle. Every function returns a NEW record. Bounded by constants
 * (`NU_*`), so the save grows by a fixed amount at most. No model call: extraction is string work, counted not judged.
 */

export const NU_VERSION = 1;
/** Sentence openings kept (newest first). */
export const NU_OPENERS_MAX = 24;
/** Scene closers kept (one per turn, newest first). */
export const NU_CLOSERS_MAX = 6;
/** Houseguests tracked; the least recently narrated is dropped first. */
export const NU_GUESTS_MAX = 24;
export const NU_GESTURES_PER_GUEST = 5;
export const NU_LINES_PER_GUEST = 4;
/** A phrase key is at most this many characters. */
export const NU_PHRASE_MAX = 40;
/** The input text is cut here before any work (a turn is a few hundred words). */
export const NU_TEXT_MAX = 6000;
/** Season-long counted openings: the most repeated frames are kept longest (the lowest count, then the oldest, is dropped first). */
export const NU_FREQ_MAX = 48;
/** A count stops growing here (a frame this worn is as bad as it gets). */
export const NU_FREQ_COUNT_MAX = 99;
/** The brief section lists at most this many items per kind, and this many items per houseguest. */
export const NU_BRIEF_REPEATED = 6;
export const NU_BRIEF_RECENT = 4;
export const NU_BRIEF_CLOSERS = 3;
export const NU_BRIEF_PER_GUEST = 2;
export const NU_BRIEF_GUESTS = 3;
/** HARD cap on the whole "ALREADY USED" section: 800 characters is 196 tokens by the brief's own estimator (chars / 4.1). */
export const NU_SECTION_MAX_CHARS = 800;

export interface NarrationGuestUse { gestures: string[]; lines: string[] }
export interface NarrationRepeats { opener: number; closer: number; gesture: number; line: number }
export interface NarrationUse {
  v: 1;
  /** Turns recorded and sentences read, over the whole season (counters, never thinned). */
  turns: number;
  sentences: number;
  /** Running totals of what the check found repeated against the record at the time: the season line reads these. */
  repeats: NarrationRepeats;
  /** Turns whose opening frames shared one with the turn before (consecutive-turn frame sharing). */
  sharedFrameTurns: number;
  openers: string[];
  /** Season-long use counts of opening frames (bounded to NU_FREQ_MAX entries; insertion order is recency). */
  freq: Record<string, number>;
  closers: string[];
  guests: Record<string, NarrationGuestUse>;
}

export interface NarrationRoster { id: string; name: string }

export interface NarrationCheck {
  sentences: number;
  repeated: NarrationRepeats;
  /** True when at least one opening frame of this turn was also in the turn before. */
  sharedWithPrevious: boolean;
}

export function emptyNarrationUse(): NarrationUse {
  return { v: 1, turns: 0, sentences: 0, repeats: { opener: 0, closer: 0, gesture: 0, line: 0 }, sharedFrameTurns: 0, openers: [], freq: {}, closers: [], guests: {} };
}

const NAME_SLOT = "{n}";
const WORD_RE = /[\p{L}][\p{L}'’-]*/gu;
/** A gesture must start on a verb-ish word, not a connective: these are skipped so "Maya and Sam" is not a gesture. */
const NOT_GESTURE_START = new Set(["and", "or", "but", "is", "was", "are", "were", "has", "had", "the", "a", "an", "of", "to", "in", "on", "at", "with", "for", "from", "who", "that", "s", "'s"]);

/** Words that can sit inside a display name ("The Player", "Jo de la Cruz") but are ordinary words in a sentence: never folded or tracked as a name. */
const NOT_A_NAME = new Set(["the", "a", "an", "of", "and", "de", "la", "le", "van", "von", "der", "den", "da", "del", "di", "el", "al", "bin", "ben", "mc", "player", "you"]);

const clip = (s: string): string => (s.length > NU_PHRASE_MAX ? s.slice(0, NU_PHRASE_MAX).trimEnd() : s);

function cleanText(text: string): string {
  return String(text ?? "").slice(0, NU_TEXT_MAX).replace(/[*_`#>~]+/g, " ").replace(/\(\([^)]*\)\)/g, " ").replace(/[ \t]+/g, " ");
}

/** The sentences of a narration (paragraph breaks and . ! ? … end one; a closing quote stays with its sentence). */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  for (const para of cleanText(text).split(/\n+/)) {
    for (const s of para.split(/(?<=[.!?…]["”’')]*)\s+/u)) {
      const t = s.trim();
      if (/[\p{L}]/u.test(t)) out.push(t);
    }
  }
  return out;
}

const wordsOf = (s: string): string[] => (s.match(WORD_RE) ?? []).map((w) => w.toLowerCase().replace(/’/g, "'"));

/** Name tokens (lowercase) of the roster: every given and family name, mapped to the houseguest id. */
function nameIndex(roster: readonly NarrationRoster[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of roster) {
    for (const tok of wordsOf(r.name)) if (tok.length > 1 && !NOT_A_NAME.has(tok) && !m.has(tok)) m.set(tok, r.id);
  }
  return m;
}

/** Remove quoted spans (straight or curly double quotes); a quote left open runs to the end. */
function outsideQuotes(s: string): string {
  let open = false;
  let out = "";
  for (const ch of s) {
    if (ch === '"' || ch === "“" || ch === "”") { open = ch === "“" ? true : ch === "”" ? false : !open; out += " "; continue; }
    out += open ? " " : ch;
  }
  return out;
}

function quotedSpans(s: string): string[] {
  const spans: string[] = [];
  let open = false;
  let cur = "";
  for (const ch of s) {
    if (ch === '"' || ch === "“" || ch === "”") {
      const opening: boolean = ch === "“" ? true : ch === "”" ? false : !open;
      if (open && !opening) { spans.push(cur); cur = ""; }
      open = opening;
      continue;
    }
    if (open) cur += ch;
  }
  if (open && cur) spans.push(cur);
  return spans;
}

/** The opening frame of a sentence: its first three words, a houseguest name folded to a placeholder. Undefined for a fragment under two words. */
export function openerFrame(sentence: string, names: ReadonlySet<string>): string | undefined {
  const w = wordsOf(sentence.replace(/^["“'‘\s]+/, "")).slice(0, 3).map((x) => (names.has(x) ? NAME_SLOT : x));
  return w.length >= 2 ? clip(w.join(" ")) : undefined;
}

/** The closing frame of a sentence: its last three words. */
export function closerFrame(sentence: string, names: ReadonlySet<string>): string | undefined {
  const w = wordsOf(sentence).slice(-3).map((x) => (names.has(x) ? NAME_SLOT : x));
  return w.length >= 2 ? clip(w.join(" ")) : undefined;
}

export interface ExtractedUse {
  sentences: number;
  openers: string[];
  closer?: string;
  gestures: Array<{ id: string; phrase: string }>;
  lines: Array<{ id: string; phrase: string }>;
}

/** Read one narration into its frames. Deterministic string work; the roster supplies the names. */
export function extractUse(text: string, roster: readonly NarrationRoster[]): ExtractedUse {
  const idx = nameIndex(roster);
  const names = new Set(idx.keys());
  const sents = sentencesOf(text);
  const openers: string[] = [];
  const gestures: ExtractedUse["gestures"] = [];
  const lines: ExtractedUse["lines"] = [];
  let lastNamed: string | undefined;
  for (const s of sents) {
    const o = openerFrame(s, names);
    if (o) openers.push(o);
    const narr = wordsOf(outsideQuotes(s));
    let speaker: string | undefined;
    for (let i = 0; i < narr.length; i++) {
      const id = idx.get(narr[i]!);
      if (!id) continue;
      speaker ??= id;
      const rest: string[] = [];
      for (let j = i + 1; j < narr.length && rest.length < 3 && !idx.has(narr[j]!); j++) rest.push(narr[j]!);
      // "Maya Reyes tucks her hair": the family name directly after a given name belongs to the name, not the gesture.
      while (rest.length && idx.get(rest[0]!) === id) rest.shift();
      if (rest.length >= 2 && !NOT_GESTURE_START.has(rest[0]!)) gestures.push({ id, phrase: clip(rest.join(" ")) });
    }
    for (const q of quotedSpans(s)) {
      const qw = wordsOf(q);
      const who = speaker ?? lastNamed;
      if (who && qw.length >= 3) lines.push({ id: who, phrase: clip(qw.slice(0, 4).join(" ")) });
    }
    if (speaker) lastNamed = speaker;
  }
  const last = sents[sents.length - 1];
  const closer = last ? closerFrame(last, names) : undefined;
  return { sentences: sents.length, openers, ...(closer ? { closer } : {}), gestures, lines };
}

const uniqueFront = (fresh: readonly string[], old: readonly string[], max: number): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...fresh, ...old]) if (!seen.has(x)) { seen.add(x); out.push(x); if (out.length >= max) break; }
  return out;
};

/**
 * Check one narration against the record (counted), then fold it in. Returns the NEW record and what the check found. The check
 * reads the record as it was BEFORE this turn: a frame is "repeated" when an earlier turn already used it. A phrase repeated twice
 * inside the same turn is counted once as new (the record is what earlier turns used).
 */
export function recordNarration(rec: NarrationUse, text: string, roster: readonly NarrationRoster[]): { record: NarrationUse; check: NarrationCheck } {
  const x = extractUse(text, roster);
  const check: NarrationCheck = { sentences: x.sentences, repeated: { opener: 0, closer: 0, gesture: 0, line: 0 }, sharedWithPrevious: false };
  if (x.sentences === 0) return { record: rec, check };

  const prevOpeners = new Set([...rec.openers, ...Object.keys(rec.freq)]);
  const seenO = new Set<string>();
  for (const o of x.openers) if (!seenO.has(o)) { seenO.add(o); if (prevOpeners.has(o)) check.repeated.opener++; }
  if (x.closer && rec.closers.includes(x.closer)) check.repeated.closer++;
  const guests: Record<string, NarrationGuestUse> = {};
  for (const [id, g] of Object.entries(rec.guests)) guests[id] = { gestures: [...g.gestures], lines: [...g.lines] };
  const seenG = new Set<string>();
  for (const g of x.gestures) {
    const k = `${g.id}|${g.phrase}`;
    if (seenG.has(k)) continue;
    seenG.add(k);
    if (guests[g.id]?.gestures.includes(g.phrase)) check.repeated.gesture++;
  }
  const seenL = new Set<string>();
  for (const l of x.lines) {
    const k = `${l.id}|${l.phrase}`;
    if (seenL.has(k)) continue;
    seenL.add(k);
    if (guests[l.id]?.lines.includes(l.phrase)) check.repeated.line++;
  }
  // consecutive-turn sharing: an opening frame of this turn that was also among the newest turn's openers (the front of the list)
  const lastTurnOpeners = new Set(rec.openers.slice(0, Math.max(1, Math.min(rec.openers.length, 12))));
  check.sharedWithPrevious = rec.turns > 0 && x.openers.some((o) => lastTurnOpeners.has(o));

  // fold in: newest first, bounded
  const touched = [...new Set([...x.gestures, ...x.lines].map((e) => e.id))];
  for (const id of touched) {
    const g = guests[id] ?? { gestures: [], lines: [] };
    guests[id] = {
      gestures: uniqueFront(x.gestures.filter((e) => e.id === id).map((e) => e.phrase), g.gestures, NU_GESTURES_PER_GUEST),
      lines: uniqueFront(x.lines.filter((e) => e.id === id).map((e) => e.phrase), g.lines, NU_LINES_PER_GUEST),
    };
  }
  // recency order of guests: the touched ones move to the end; the oldest fall off past the cap
  const order = [...Object.keys(guests).filter((id) => !touched.includes(id)), ...touched];
  const kept: Record<string, NarrationGuestUse> = {};
  for (const id of order.slice(-NU_GUESTS_MAX)) kept[id] = guests[id]!;

  const freq: Record<string, number> = { ...rec.freq };
  for (const o of seenO) {
    const n = Math.min(NU_FREQ_COUNT_MAX, (freq[o] ?? 0) + 1);
    delete freq[o]; // re-inserted last: insertion order is recency
    freq[o] = n;
  }
  const keptFreq: Record<string, number> = {};
  const byKeep = Object.entries(freq).map(([k, n], i) => ({ k, n, i })).sort((a, b) => b.n - a.n || b.i - a.i).slice(0, NU_FREQ_MAX).sort((a, b) => a.i - b.i);
  for (const e of byKeep) keptFreq[e.k] = e.n;

  const record: NarrationUse = {
    v: 1,
    turns: rec.turns + 1,
    sentences: rec.sentences + x.sentences,
    repeats: {
      opener: rec.repeats.opener + check.repeated.opener,
      closer: rec.repeats.closer + check.repeated.closer,
      gesture: rec.repeats.gesture + check.repeated.gesture,
      line: rec.repeats.line + check.repeated.line,
    },
    sharedFrameTurns: rec.sharedFrameTurns + (check.sharedWithPrevious ? 1 : 0),
    openers: uniqueFront(x.openers, rec.openers, NU_OPENERS_MAX),
    freq: keptFreq,
    closers: uniqueFront(x.closer ? [x.closer] : [], rec.closers, NU_CLOSERS_MAX),
    guests: kept,
  };
  return { record, check };
}

/** Repeats of all four kinds per 1,000 narrator sentences, over the season (0 before any sentence). */
export function repeatsPer1000(rec: NarrationUse): number {
  if (rec.sentences <= 0) return 0;
  const r = rec.repeats;
  return Math.round((1000 * (r.opener + r.closer + r.gesture + r.line)) / rec.sentences);
}

/** The standing season line, counts only: one fixed-shape sentence for the logs. */
export function narrationSeasonLine(rec: NarrationUse): string {
  const r = rec.repeats;
  return `[narration-repetition] season line: turns=${rec.turns} sentences=${rec.sentences} repeated-openers=${r.opener} repeated-closers=${r.closer} repeated-gestures=${r.gesture} repeated-lines=${r.line} consecutive-turn-frame-shares=${rec.sharedFrameTurns} repeats-per-1000-sentences=${repeatsPer1000(rec)}`;
}

function restoreFreq(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.length === 0 || k.length > NU_PHRASE_MAX || typeof v !== "number" || !Number.isFinite(v) || v < 1) continue;
    out[k] = Math.min(NU_FREQ_COUNT_MAX, Math.floor(v));
    if (Object.keys(out).length >= NU_FREQ_MAX) break;
  }
  return out;
}

/** Defensive restore of a saved record: wrong shapes become empty, every list is cut to its bound, every phrase to its length. */
export function restoreNarrationUse(raw: unknown): NarrationUse {
  if (typeof raw !== "object" || raw === null || (raw as { v?: unknown }).v !== 1) return emptyNarrationUse();
  const o = raw as Record<string, unknown>;
  const nat = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
  const strs = (x: unknown, max: number): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string" && s.length > 0).map(clip).slice(0, max) : []);
  const rp = (typeof o["repeats"] === "object" && o["repeats"] !== null ? o["repeats"] : {}) as Record<string, unknown>;
  const guests: Record<string, NarrationGuestUse> = {};
  const g = typeof o["guests"] === "object" && o["guests"] !== null && !Array.isArray(o["guests"]) ? (o["guests"] as Record<string, unknown>) : {};
  for (const id of Object.keys(g).slice(-NU_GUESTS_MAX)) {
    const e = g[id] as { gestures?: unknown; lines?: unknown } | null;
    guests[id] = { gestures: strs(e?.gestures, NU_GESTURES_PER_GUEST), lines: strs(e?.lines, NU_LINES_PER_GUEST) };
  }
  return {
    v: 1, turns: nat(o["turns"]), sentences: nat(o["sentences"]),
    repeats: { opener: nat(rp["opener"]), closer: nat(rp["closer"]), gesture: nat(rp["gesture"]), line: nat(rp["line"]) },
    sharedFrameTurns: nat(o["sharedFrameTurns"]),
    openers: strs(o["openers"], NU_OPENERS_MAX), freq: restoreFreq(o["freq"]), closers: strs(o["closers"], NU_CLOSERS_MAX), guests,
  };
}

/** Letters a sentence can open on without strain (no q, x, z, y, u, j). */
const ANCHOR_LETTERS = "abcdefghiklmnoprstvw";

/**
 * A seeded, deterministic anchor for one turn: three distinct starting letters the narrator is told to open its first sentences
 * with, so the openings vary on purpose and not only by avoiding what was used. The same (seed, turn) always gives the same
 * letters; a different turn gives different ones. Pure: an integer hash, no rng stream is touched.
 */
export function narrationAnchor(seed: number, turn: number): string[] {
  let h = (Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((turn | 0) + 0x7f4a7c15, 0xc2b2ae35)) >>> 0;
  const pool = ANCHOR_LETTERS.split("");
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
    out.push(pool.splice(h % pool.length, 1)[0]!.toUpperCase());
  }
  return out;
}

/**
 * The Show Brief section: what the narration already used, as RULES to vary from (never a menu to copy), under a HARD cap of
 * `NU_SECTION_MAX_CHARS` (under 200 tokens). `hereIds` limits the per-houseguest lines to the houseguests the player can see right now;
 * `nameOf` resolves a roster id to a printable name; `anchor` (see `narrationAnchor`) is this turn's seeded starting letters.
 * The most repeated openings come first (the record keeps them for the whole season), then the newest. Items are dropped from the
 * tail (houseguests, then closers, then openings) until the section fits. Undefined while there is nothing to say, so a fresh
 * game's brief is byte-identical to before.
 */
export function narrationUsageSection(rec: NarrationUse, hereIds: readonly string[], nameOf: (id: string) => string, anchor?: readonly string[]): string | undefined {
  if (rec.turns <= 0) return undefined;
  const worn = Object.entries(rec.freq).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, NU_BRIEF_REPEATED).map(([k]) => k);
  const recent = rec.openers.filter((o) => !worn.includes(o)).slice(0, NU_BRIEF_RECENT);
  let openers = [...worn, ...recent];
  let closers = rec.closers.slice(0, NU_BRIEF_CLOSERS);
  const guestLines: string[] = [];
  for (const id of hereIds) {
    const g = rec.guests[id];
    if (!g || (!g.gestures.length && !g.lines.length)) continue;
    if (guestLines.length >= NU_BRIEF_GUESTS) break;
    const bits: string[] = [];
    if (g.gestures.length) bits.push(`did ${g.gestures.slice(0, NU_BRIEF_PER_GUEST).map((x) => `"${x}"`).join(", ")}`);
    if (g.lines.length) bits.push(`began lines ${g.lines.slice(0, 1).map((x) => `"${x}"`).join(", ")}`);
    guestLines.push(`- ${nameOf(id)} ${bits.join("; ")}`);
  }
  const anchorLine = anchor && anchor.length ? `- This turn open your first sentences on words starting ${anchor.join(", ")}.` : undefined;
  const build = (): string => {
    const lines: string[] = ["7. ALREADY USED (vary it; a repeat reads as a tic; never reuse a habit for these people; no retold story, no unanswered question asked twice; never tag a line as said flatly, evenly or plainly; raised eyebrows and folded arms once per person)"];
    if (openers.length) lines.push(`- Openings used: ${openers.map((o) => `"${o}"`).join(", ")} ({n} is a name).`);
    if (closers.length) lines.push(`- Scenes ended: ${closers.map((o) => `"${o}"`).join(", ")}.`);
    if (anchorLine) lines.push(anchorLine);
    lines.push(...guestLines);
    return lines.join("\n");
  };
  let text = build();
  while (text.length > NU_SECTION_MAX_CHARS) {
    if (guestLines.length) guestLines.pop();
    else if (closers.length) closers = closers.slice(0, -1);
    else if (openers.length > 1) openers = openers.slice(0, -1);
    else break;
    text = build();
  }
  return openers.length || closers.length || guestLines.length || anchorLine ? text.slice(0, NU_SECTION_MAX_CHARS) : undefined;
}
