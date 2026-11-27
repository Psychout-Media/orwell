/**
 * ORW-510: how much does the narrator repeat itself? A standing measurement over a corpus of narrated turns (one JSON object with a
 * `text` field per line of a .jsonl file, in the order they aired), pure string work, no model call, no network.
 *
 * Usage: npx tsx scripts/probes/narrationRepetition.ts <corpus.jsonl> [--save <save.json>] [--roster <names.json>] [--show-phrases]
 *   --save    a saved game (house.player / house.npcs names) or --roster a JSON array of names: the houseguest names, for the
 *             per-houseguest gesture and line counts. Without either, the per-houseguest rows read 0 and say so.
 *   --show-phrases  also print the top phrases themselves. OFF by default: a corpus may be private, and the default output is numbers only.
 *
 * Reported (all per 1,000 narrator sentences unless stated):
 *   - repeated sentence frames: sentences whose three-word opening an earlier TURN already used,
 *   - repeated phrases: four-word runs that occur in two or more turns, counted beyond their first turn,
 *   - the share of sentences on the single most repeated opener, and of turns on the single most repeated closer,
 *   - per-houseguest repeated gestures and lines (the record check, `recordNarration`),
 *   - the share of turns whose opening frames overlap the turn before,
 *   - prompt examples copied verbatim: quoted example spans of the CURRENT prompt text found in the corpus,
 *   - ORW-1032 tics and repeats (turn shares, each over the number of turns): delivery tags ("says it flat", "evenly", "plainly"), the word "flat", stock body habits (eyebrows, crossed or folded arms),
 *     the same question asked again inside one turn or in the next five turns, a long quoted line told again in near-identical words, and counted-hours relative times ("four hours ago").
 *   - replay of the live record: how many of the repeats the "ALREADY USED" brief section would have named just before they aired.
 */
import { readFileSync } from "node:fs";
import { BASE_GAME_MASTER_PROMPT, MOMENT_PROMPTS } from "../../src/engine/momentPrompts";
import {
  emptyNarrationUse, extractUse, narrationSeasonLine, narrationUsageSection, openerFrame, recordNarration, repeatsPer1000, sentencesOf,
  type NarrationRoster, type NarrationUse,
} from "../../src/engine/narrationUsage";

export interface RepetitionReport {
  turns: number;
  sentences: number;
  repeatedFramesPer1000: number;
  repeatedPhrasesPer1000: number;
  topOpenerShare: number;
  topCloserShare: number;
  repeatedGesturesPer1000: number;
  repeatedLinesPer1000: number;
  consecutiveTurnFrameShare: number;
  promptExampleSpans: number;
  promptExampleTurnsCopying: number;
  copiedExampleSpans: number;
  replayRepeats: number;
  replayNamedInBrief: number;
  seasonLine: string;
  tics: TicReport;
  topPhrases?: { openers: Array<[string, number]>; closers: Array<[string, number]> };
}

/** ORW-1032: counts of turns carrying each tic; every share is turns-with-the-tic over turns. */
export interface TicReport {
  deliveryTagTurns: number;
  deliveryTagTurnShare: number;
  flatWordTurns: number;
  eyebrowTurns: number;
  armsTurns: number;
  repeatedAsks: number;
  retoldLines: number;
  hoursAgoClaims: number;
}

const DELIVERY_TAG_RE = /\b(?:says?|said|murmurs?|murmured|answers?|answered|replies|replied|states?|stated|delivers?|delivered)\s+(?:it|that|this|them|the (?:words|line))?\s*(?:\w+\s+)?(?:flat(?:ly)?|even(?:ly)?|plain(?:ly)?)\b|\b(?:flat(?:ly)?|even(?:ly)?|plain(?:ly)?)\s*[,.]?\s*(?:and|as)?\s*(?:says?|said)\b|\bin a (?:flat|even|level) (?:voice|tone)\b/i;
const EYEBROW_RE = /\beyebrows?\b|\bbrows?\b/i;
const ARMS_RE = /\barms? (?:crossed|folded)|\b(?:crosses|crossed|folds|folded) (?:her|his|their) arms\b/i;
const HOURS_AGO_RE = /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a couple of|a few) hours? ago\b/i;

/** The quoted question spans of a turn: a quote that ends in a question mark, as its first five words. */
function questionKeys(turn: string): string[] {
  const keys: string[] = [];
  for (const m of turn.matchAll(/["“]([^"”\n]{8,240}\?)["”]/g)) {
    const w = words(m[1]!);
    if (w.length >= 4) keys.push(w.slice(0, 5).join(" "));
  }
  return keys;
}

/** The quoted spans of 12 or more words, as sets of four-word runs. */
function longQuoteGrams(turn: string): Array<Set<string>> {
  const out: Array<Set<string>> = [];
  for (const m of turn.matchAll(/["“]([^"”\n]{40,600})["”]/g)) {
    const w = words(m[1]!);
    if (w.length < 12) continue;
    const g = new Set<string>();
    for (let i = 0; i + 4 <= w.length; i++) g.add(w.slice(i, i + 4).join(" "));
    out.push(g);
  }
  return out;
}

/** ORW-1032: the tic and repeat counters over a corpus, in the order the turns aired. Pure string work. */
export function measureTics(turns: readonly string[]): TicReport {
  let tag = 0, flat = 0, brow = 0, arms = 0, asks = 0, retold = 0, hours = 0;
  const recentAsks: string[][] = [];
  const quotes: Array<Set<string>> = [];
  for (const t of turns) {
    const body = t.replace(/[*_`]+/g, "");
    if (DELIVERY_TAG_RE.test(body)) tag++;
    if (/\bflat(?:ly)?\b/i.test(body)) flat++;
    if (EYEBROW_RE.test(body)) brow++;
    if (ARMS_RE.test(body)) arms++;
    if (HOURS_AGO_RE.test(body)) hours++;
    const keys = questionKeys(body);
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k) || recentAsks.some((r) => r.includes(k))) asks++;
      seen.add(k);
    }
    recentAsks.push(keys);
    if (recentAsks.length > 5) recentAsks.shift();
    for (const g of longQuoteGrams(body)) {
      if (quotes.some((q) => { let hit = 0; for (const x of g) if (q.has(x)) hit++; return hit / Math.max(1, Math.min(g.size, q.size)) >= 0.5; })) retold++;
      quotes.push(g);
    }
  }
  return {
    deliveryTagTurns: tag, deliveryTagTurnShare: turns.length ? Math.round((1000 * tag) / turns.length) / 10 : 0,
    flatWordTurns: flat, eyebrowTurns: brow, armsTurns: arms, repeatedAsks: asks, retoldLines: retold, hoursAgoClaims: hours,
  };
}

const norm = (s: string): string => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string): string[] => norm(s).split(" ").filter(Boolean);

/** Quoted example spans (3 to 14 words) that the current prompt text carries: the lines a writer may copy. */
export function promptExampleSpans(promptText: string): string[] {
  const out = new Set<string>();
  for (const m of promptText.matchAll(/"([^"\n]{12,160})"|'([^'\n]{12,160})'|“([^”\n]{12,160})”/g)) {
    const t = norm(m[1] ?? m[2] ?? m[3] ?? "");
    const n = t.split(" ").length;
    if (n >= 3 && n <= 14) out.add(t);
  }
  return [...out];
}

export function currentPromptText(): string {
  return [BASE_GAME_MASTER_PROMPT, ...Object.values(MOMENT_PROMPTS)].join("\n");
}

export function measure(turns: readonly string[], roster: readonly NarrationRoster[], opts: { showPhrases?: boolean; promptText?: string } = {}): RepetitionReport {
  const names = new Set<string>();
  for (const r of roster) for (const t of words(r.name)) if (t.length > 1) names.add(t);
  let sentences = 0, repFrames = 0;
  const openerTurns = new Map<string, number>(); // frame -> number of turns using it
  const openerCount = new Map<string, number>(); // frame -> sentences using it
  const closerCount = new Map<string, number>();
  const seenFrames = new Set<string>();
  const gramTurns = new Map<string, number>();
  let rec: NarrationUse = emptyNarrationUse();
  let replayRepeats = 0, replayNamed = 0;
  for (const t of turns) {
    const sents = sentencesOf(t);
    sentences += sents.length;
    const turnFrames = new Set<string>();
    for (const s of sents) {
      const f = openerFrame(s, names);
      if (!f) continue;
      openerCount.set(f, (openerCount.get(f) ?? 0) + 1);
      if (seenFrames.has(f)) repFrames++;
      turnFrames.add(f);
    }
    for (const f of turnFrames) { seenFrames.add(f); openerTurns.set(f, (openerTurns.get(f) ?? 0) + 1); }
    const x = extractUse(t, roster);
    if (x.closer) closerCount.set(x.closer, (closerCount.get(x.closer) ?? 0) + 1);
    const grams = new Set<string>();
    for (const s of sents) { const w = words(s); for (let i = 0; i + 4 <= w.length; i++) grams.add(w.slice(i, i + 4).join(" ")); }
    for (const g of grams) gramTurns.set(g, (gramTurns.get(g) ?? 0) + 1);
    // replay the live record: what the brief section would have said just before this turn, and which repeats it names
    const section = narrationUsageSection(rec, Object.keys(rec.guests), (id) => id) ?? "";
    const out = recordNarration(rec, t, roster);
    const before = rec;
    rec = out.record;
    const named = (phrases: readonly string[]): number => phrases.filter((p) => section.includes(`"${p}"`) || section.includes(`"... ${p}"`)).length;
    replayRepeats += out.check.repeated.opener + out.check.repeated.closer + out.check.repeated.gesture + out.check.repeated.line;
    const beforeOpeners = new Set(before.openers);
    replayNamed += named([...new Set(x.openers)].filter((o) => beforeOpeners.has(o)));
    if (x.closer && before.closers.includes(x.closer)) replayNamed += named([x.closer]);
    for (const g of x.gestures) if (before.guests[g.id]?.gestures.includes(g.phrase)) replayNamed += named([g.phrase]);
    for (const l of x.lines) if (before.guests[l.id]?.lines.includes(l.phrase)) replayNamed += named([l.phrase]);
  }
  let repPhrases = 0;
  for (const n of gramTurns.values()) if (n >= 2) repPhrases += n - 1;
  const per1000 = (n: number): number => (sentences ? Math.round((1000 * n) / sentences * 10) / 10 : 0);
  const topO = Math.max(0, ...openerCount.values());
  const topC = Math.max(0, ...closerCount.values());
  const spans = promptExampleSpans(opts.promptText ?? currentPromptText());
  const joined = turns.map(norm);
  let copiedSpans = 0, copyingTurns = 0;
  const copying = new Set<number>();
  for (const sp of spans) {
    let hit = false;
    joined.forEach((t, i) => { if (t.includes(sp)) { hit = true; copying.add(i); } });
    if (hit) copiedSpans++;
  }
  copyingTurns = copying.size;
  const r = rec.repeats;
  const sorted = (m: Map<string, number>): Array<[string, number]> => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8);
  return {
    turns: turns.length,
    sentences,
    repeatedFramesPer1000: per1000(repFrames),
    repeatedPhrasesPer1000: per1000(repPhrases),
    topOpenerShare: sentences ? Math.round((1000 * topO) / sentences) / 10 : 0,
    topCloserShare: turns.length ? Math.round((1000 * topC) / turns.length) / 10 : 0,
    repeatedGesturesPer1000: per1000(r.gesture),
    repeatedLinesPer1000: per1000(r.line),
    consecutiveTurnFrameShare: turns.length > 1 ? Math.round((1000 * rec.sharedFrameTurns) / (turns.length - 1)) / 10 : 0,
    promptExampleSpans: spans.length,
    promptExampleTurnsCopying: copyingTurns,
    copiedExampleSpans: copiedSpans,
    replayRepeats,
    replayNamedInBrief: replayNamed,
    tics: measureTics(turns),
    seasonLine: narrationSeasonLine(rec) + ` (record-check total per 1000: ${repeatsPer1000(rec)})`,
    ...(opts.showPhrases ? { topPhrases: { openers: sorted(openerCount), closers: sorted(closerCount) } } : {}),
  };
}

function rosterFromSave(path: string): NarrationRoster[] {
  const d = JSON.parse(readFileSync(path, "utf8")) as { house?: { player?: { id?: string; name?: string }; npcs?: Array<{ id?: string; name?: string }> } };
  const all = [d.house?.player, ...(d.house?.npcs ?? [])].filter((x): x is { id: string; name: string } => !!x && typeof x.id === "string" && typeof x.name === "string");
  return all.map((x) => ({ id: x.id, name: x.name }));
}

if (process.argv[1] && /narrationRepetition\.ts$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--save" && args[args.indexOf(a) - 1] !== "--roster");
  if (!file) { console.error("usage: narrationRepetition.ts <corpus.jsonl> [--save save.json] [--roster names.json] [--show-phrases]"); process.exit(2); }
  const opt = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  let roster: NarrationRoster[] = [];
  if (opt("--save")) roster = rosterFromSave(opt("--save")!);
  else if (opt("--roster")) roster = (JSON.parse(readFileSync(opt("--roster")!, "utf8")) as string[]).map((n, i) => ({ id: `npc:${i + 1}`, name: n }));
  const turns = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { text?: string }).text ?? "").filter((t) => t.length > 0);
  const rep = measure(turns, roster, { showPhrases: args.includes("--show-phrases") });
  console.log(JSON.stringify({ roster: roster.length, ...rep }, null, 2));
}
