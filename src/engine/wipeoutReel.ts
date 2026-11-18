import type { EntityId } from "../domain/ids";
import type { RandomnessSource } from "../ports/RandomnessSource";
import type { CompetitionFormat } from "./competitionLibrary";
import { moodWord } from "./voice";

/**
 * C1 — THE WIPEOUT REEL (issue #1788, Q8 hybrid-greenlit small+reversible build; idea record
 * `docs/design/2026-07-21-moonshot-round2-divergent-slate.md` §2 Theme C, C1 — consensus 9/9/9, the
 * batch's sole unanimous exceptional).
 *
 * Eliminations in a staged competition (0006 staged-rounds evolution) currently reveal as bare,
 * deliberately INERT drop events — "bare eliminations for the narrator to improvise"
 * (`liveSeason.ts`'s `eliminationContent`). This module attaches a seeded, character-expressive
 * `failureStyle` FACT to each pre-rolled drop — HOW a houseguest loses becomes a stable, recurring comic
 * signature ("here he goes again") instead of a blank the narrator has to invent from nothing.
 *
 * PURE and Vault-free by construction: every input is either a byte-stable genesis `CHARACTER` facet
 * (archetype), an already-Vault-safe derived word (`moodWord`, which the rest of the engine already
 * treats as safe to voice), a public competition format, or a plain integer (a prior-wipeout count) —
 * no hidden state, no VaultStore import, no raw stat/number ever appears in the composed text. The
 * caller (`liveSeason.ts`) owns the ONE load-bearing discipline this module depends on: `rng` MUST be a
 * stream FORKED from the comp's beat rng AFTER the single up-front `resolveCompetition` roll that fixes
 * the crown + drop order — never the parent stream — so nothing here can perturb the outcome axis
 * (`tests/unit/stagedTrajectoryNeutral.test.ts` is the byte-identity guard on that discipline).
 */

/** A single failure-style fact for ONE dropped entrant — ids + composed strings only, no hidden state. */
export interface WipeoutFailureFact {
  /** The composed fact-to-voice sentence: archetype-flavored phrase (+ mood + format + callback). */
  text: string;
  /** The archetype-flavor bank the phrase drew from (`"generic"` for an unknown/legacy archetype). */
  archetype: string;
}

/** A single accumulated wipeout, persisted MONOTONICALLY per houseguest (mandate #4: never lost). */
export interface WipeoutHistoryEntry {
  week: number;
  comp: "hoh-competition" | "veto-competition";
  text: string;
}

/**
 * The archetype-flavor phrase bank — a comic SIGNATURE per genesis `Archetype` (`characterFactory.ts`'s
 * 12-member enum). Two variants each so the same houseguest's repeat wipeouts don't read as a single
 * copy-pasted line, while still drawing from the SAME small bank every time (the "recurs as a comic
 * signature" requirement) — never the full cross-archetype pool.
 */
const ARCHETYPE_FAILURE_STYLES: Readonly<Record<string, readonly string[]>> = {
  "comp-beast": [
    "comes out too hot, blows past the mark, and never notices",
    "muscles through the wrong move with total confidence",
  ],
  mastermind: [
    "overthinks the simple part until it's too late",
    "is still three moves ahead of a competition that already ended",
  ],
  "social-butterfly": [
    "starts narrating the moment out loud instead of finishing it",
    "checks the room for a reaction instead of the clock",
  ],
  floater: [
    "quietly slips out, and half the house doesn't even clock it happened",
    "goes so unnoticed the drop barely registers",
  ],
  villain: [
    "refuses to believe it, and argues with the result on the way out",
    "blames the competition itself, loudly, on the way down",
  ],
  underdog: [
    "gives it absolutely everything and still comes up just short",
    "digs in longer than anyone expected before finally slipping",
  ],
  flirt: [
    "gets distracted mid-round and loses the thread completely",
    "spends the crucial second working the room instead of the round",
  ],
  loyalist: [
    "stops to check on an ally instead of finishing the job",
    "hesitates at the worst possible second, loyal to the end",
  ],
  wildcard: [
    "tries something nobody saw coming, and it backfires spectacularly",
    "improvises a move that exists nowhere in this competition's rules",
  ],
  analyst: [
    "talks themself out of the obvious right answer",
    "recalculates one too many times and runs out of clock",
  ],
  hothead: [
    "gets heated, rushes it, and blows the whole thing",
    "slams through the round and pays for the sloppiness",
  ],
  peacemaker: [
    "can't bring themself to edge out a friend, and pays for it",
    "apologizes mid-round, which is not a competitive strategy",
  ],
};

/** The fallback bank for an unset/legacy/unrecognized archetype — still comic, never bare. */
const GENERIC_FAILURE_STYLES: readonly string[] = [
  "comes up short in a way that is somehow completely on brand",
  "goes out exactly the way the house would have bet",
];

/** ORW-509: tails that sit after any failure style; the pool a drop draws from is each authored style alone, then each style (+ an optional adverb) x tail (2 styles became ~30 per archetype). */
const FAILURE_TAILS: readonly string[] = [
  "and the house winces", "and takes it with a shrug", "while the others pretend not to look", "and the room goes quiet", "to a long, loud groan from the sidelines",
  "and tries to laugh it off", "and nobody quite knows what to say", "with the whole set watching", "and then stares at the floor", "while somebody claps out of pity",
  "and the host lets the silence sit", "as the next player steps up",
];
/** A few extra generic styles for the fallback bank (an unset or legacy archetype), so the fallback is not two lines. */
const GENERIC_EXTRA_STYLES: readonly string[] = [
  "loses the thread at the one moment it mattered", "runs out of steam a step before it would have counted", "goes down swinging, and it still looks like a miss",
  "does everything right except the last thing", "makes it look easy right up until it isn't", "freezes, thaws, and is a beat too late",
];
const FAILURE_ADVERBS: readonly string[] = ["", "again", "as usual", "as ever", "in public", "on camera", "for the cameras", "quietly"];
const widenedCache = new Map<string, readonly string[]>();
function widenedStyles(key: string, base: readonly string[]): readonly string[] {
  let hit = widenedCache.get(key);
  if (!hit) {
    const seeds = key === "generic" ? [...base, ...GENERIC_EXTRA_STYLES] : base;
    hit = [...seeds, ...seeds.flatMap((b) => FAILURE_ADVERBS.flatMap((l) => FAILURE_TAILS.map((t) => `${b}${l ? ` ${l}` : ""}, ${t}`)))];
    widenedCache.set(key, hit);
  }
  return hit;
}

/** Format-appropriate flavor clause (mirrors `ELIMINATION_VERB`'s per-format grammar, COMP-3/BB-9). */
const FORMAT_FAILURE_TAGS: Readonly<Record<CompetitionFormat, string>> = {
  endurance: "before the wall gets the better of them",
  puzzle: "on the exact piece everyone else reads in seconds",
  quiz: "on a question they absolutely knew a minute ago",
  skill: "on the one move they'd been practicing",
  crapshoot: "the instant luck turns",
  social: "reading the room completely wrong",
};

/**
 * A short, COARSE mood qualifier (Q4 spirit: a small fixed vocabulary, never a number in disguise) —
 * reads the existing `moodWord` (already the engine's sanctioned Vault-safe mood projection), never a
 * raw emotional-state value. Empty string for a plain/steady moment (no clause added).
 */
function moodQualifier(word: string): string {
  if (word.includes("shaken")) return "visibly rattled";
  if (word.includes("worn")) return "running on fumes";
  if (word.includes("on edge")) return "jumpy and overcorrecting";
  if (word.includes("at ease") || word.includes("riding high")) return "almost too relaxed about it";
  return "";
}

/** Small fixed ordinal-suffix table — no locale dependency, just enough for a season's wipeout count. */
function ordinal(n: number): string {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]}`;
}

/**
 * The persisted-callback clause (mandate #4 made FELT, per the idea record: "here he goes again") — a
 * plain function of an integer already-recorded count, never a new hidden signal.
 */
function callbackClause(priorWipeouts: number): string {
  if (priorWipeouts <= 0) return "";
  if (priorWipeouts === 1) return " — the second time this season.";
  return ` — the ${ordinal(priorWipeouts + 1)} time this season, and the house is starting to expect it.`;
}

/**
 * The pure, seeded per-drop failure-style fact — archetype × mood × comp-format × callback, exactly the
 * vocabulary axes the idea record specifies. Deterministic given the same `rng` position + inputs.
 *
 * `rng` MUST already be the caller's forked-after-resolution stream (see the module doc); this function
 * only draws from whatever stream it is handed, once, in a fixed order (an archetype-bank pick), so a
 * caller iterating a fixed `dropOrder` gets a fully reproducible, replay-stable result.
 */
export function deriveFailureFact(
  rng: RandomnessSource,
  archetype: string | undefined,
  emotionalState: number | undefined,
  format: CompetitionFormat | undefined,
  priorWipeouts: number,
): WipeoutFailureFact {
  const bank = archetype ? ARCHETYPE_FAILURE_STYLES[archetype] : undefined;
  const key = bank ? archetype! : "generic";
  const phrase = rng.pick(widenedStyles(key, bank ?? GENERIC_FAILURE_STYLES)); // ORW-509: still ONE pick; the bank is the authored styles + styles x tails
  const mood = emotionalState === undefined ? "" : moodQualifier(moodWord(emotionalState, 0.5));
  const formatTag = format ? FORMAT_FAILURE_TAGS[format] : undefined;
  const clauses = [phrase, mood, formatTag].filter((c): c is string => !!c);
  const text = `${clauses.join(", ")}.${callbackClause(priorWipeouts)}`;
  return { text, archetype: key };
}

/** The prior-wipeout COUNT for a houseguest (0 for a fresh season/legacy save with no history yet). */
export function priorWipeoutCount(history: readonly WipeoutHistoryEntry[] | undefined): number {
  return history?.length ?? 0;
}

/**
 * Append ONE revealed wipeout to a houseguest's history — MONOTONIC (mandate #4: appended only, never
 * trimmed, truncated, or overwritten). Mutates `history` in place (the caller owns the persisted map),
 * mirroring the rest of `liveSeason.ts`'s in-place state-mutation style.
 */
export function appendWipeoutHistory(
  history: Record<EntityId, WipeoutHistoryEntry[]>,
  id: EntityId,
  entry: WipeoutHistoryEntry,
): void {
  (history[id] ??= []).push(entry);
}
