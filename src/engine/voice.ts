/**
 * Character VOICE & grounded MOOD (feature 0084). Two halves of "sixteen mouths, not one":
 *
 *  • VOICE — a byte-stable PUBLIC fingerprint on the static `CHARACTER` (how a houseguest TALKS:
 *    register, rhythm, energy, directness, humor, and what their voice does under stress, plus a
 *    prose signature + a light habitual lexicon). Generated once at cast time, seeded + archetype-
 *    correlated but independently varied, so two of an archetype still sound different. It is identity
 *    and NEVER drifts (owner ruling 2026-06-25) — all the turn-to-turn dynamism lives in `mood`.
 *
 *  • MOOD — a Vault-safe, observable AFFECT WORD derived live from the soul. It runs on TWO timescales:
 *    the ACUTE state (`emotionalState`, which spikes on a beat and mean-reverts within a few turns) and
 *    the MARINATED baseline (the trend of `emotionalHistory` — the set-point the ~3-month season has
 *    dragged them to). Someone ground down over weeks reads as worn even on a calm day; a long safe run
 *    reads as lasting ease. Never a number, never the hidden CAUSE — only the carriage.
 *
 * Pure + deterministic (seeded). No I/O, no Vault: voice is public, mood is an observable word.
 */
import type { RandomnessSource } from "../ports/RandomnessSource";
import type { VoiceProfile } from "../domain/voiceProfile";
import { clamp01Raw as clamp01 } from "../domain/num";

export type { VoiceProfile } from "../domain/voiceProfile";

/** The option pools per dial. Order is canonical; generation picks one (archetype-biased). */
export const VOICE_DIALS = {
  register: ["formal", "polished", "plainspoken", "folksy", "crude"],
  rhythm: ["clipped", "staccato", "measured", "rambling"],
  energy: ["flat", "even", "warm", "buzzy", "manic"],
  directness: ["evasive", "diplomatic", "candid", "blunt"],
  humor: ["none", "dry", "self-deprecating", "goofy", "cutting"],
  stressTell: ["goes quiet", "gets clipped", "over-explains", "talks faster", "deflects with a joke"],
} as const;

type Dial = keyof typeof VOICE_DIALS;

/** A prose-signature pool (one is chosen per houseguest) — texture, not a bit. */
export const VOICE_SIGNATURES: readonly string[] = [
  "talks with their hands and trails off mid-thought",
  "answers a question with a question",
  "lands every point like it's the last word",
  "narrates their own feelings out loud as they happen",
  "keeps it short and lets the silence do the work",
  "circles a topic three times before landing on it",
  "undercuts anything sincere with a quick joke",
  "leans in close and drops their voice for the real talk",
  "states opinions as settled facts",
  "softens everything with a qualifier before the point",
  "thinks out loud, revising the sentence as they go",
  "delivers warmth and a read in the same breath",
];

/** A light habitual-filler pool — a houseguest gets one or two, sprinkled, never a punchline. */
export const VOICE_LEXICON_POOL: readonly string[] = [
  "honestly", "I mean", "like", "for real", "low-key", "100%", "listen", "right?",
  "okay so", "to be fair", "no but", "literally",
];

/**
 * 0090 — PER-ARCHETYPE signature pools. 0084 dealt every houseguest a signature from ONE flat pool, so a
 * villain and a peacemaker could draw the same line and read alike. Each archetype now gets its OWN small
 * pool whose diction + cadence fit that archetype — the texture the reader actually feels. An archetype
 * with no pool falls back to the flat `VOICE_SIGNATURES` (additive, byte-identical for it).
 */
export const VOICE_ARCHETYPE_SIGNATURES: Record<string, readonly string[]> = {
  "comp-beast": ["cuts straight to the scoreboard", "talks in challenges won and lost", "states the play and moves on", "sizes everyone up like a bracket", "no wasted words — all business"],
  "mastermind": ["lays out the board three moves ahead", "chooses each word, slowly", "frames everything as a calculation", "lets a silence sit before the real point", "speaks in contingencies and angles"],
  "social-butterfly": ["bounces between five thoughts and circles back", "narrates the whole room's vibe", "turns every read into a story", "talks with their whole body, warm and loud", "folds everyone into the conversation"],
  "floater": ["agrees with whoever spoke last", "keeps every answer pleasantly vague", "deflects the hard question with a shrug", "never quite lands on a side", "smiles and says little of substance"],
  "villain": ["delivers a read like a verdict", "smiles while twisting the knife", "states the cruel thing plainly", "makes a threat sound like small talk", "owns every scheme without flinching"],
  "underdog": ["undercuts themselves before anyone else can", "over-explains the simple thing", "laughs at their own odds", "downplays every win", "wears the long shot on their sleeve"],
  "flirt": ["turns every line into a little dare", "holds eye contact a beat too long", "wraps a real read in a wink", "teases the answer out of you", "makes scheming sound like flirting"],
  "loyalist": ["says the loyal thing and means it", "puts the alliance before the read", "talks in promises and 'we'", "wears their heart in every answer", "vouches for their people unprompted"],
};

/** 0090 — PER-ARCHETYPE habitual fillers (same fallback rule as the signatures). */
export const VOICE_ARCHETYPE_LEXICON: Record<string, readonly string[]> = {
  "comp-beast": ["bottom line", "straight up", "let's go", "easy", "for sure", "done"],
  "mastermind": ["the way I see it", "in theory", "arguably", "precisely", "consider", "to be fair"],
  "social-butterfly": ["okay so", "I love that", "wait", "literally", "you know?", "oh my gosh"],
  "floater": ["I mean", "kind of", "we'll see", "maybe", "I guess", "either way"],
  "villain": ["let's be honest", "obviously", "please", "cute", "bless", "darling"],
  "underdog": ["I know, I know", "honestly", "somehow", "no way", "for real", "lucky me"],
  "flirt": ["oh?", "c'mon", "tell me", "interesting", "mmhm", "you"],
  "loyalist": ["honestly", "100%", "ride or die", "my people", "for real", "no question"],
};

/**
 * Per-archetype dial leanings — the value an archetype TENDS toward (applied with `BIAS_STRENGTH`),
 * so a `comp-beast` skews blunt/clipped and a `social-butterfly` warm/rambling, WITHOUT collapsing
 * the cast onto one voice (every other dial is still free, and the lean itself only sometimes wins).
 * Keyed by archetype string to keep this a leaf module (no import cycle with characterFactory).
 */
export const VOICE_ARCHETYPE_BIAS: Record<string, Partial<Record<Dial, string>>> = {
  "comp-beast": { directness: "blunt", rhythm: "clipped", energy: "buzzy", stressTell: "gets clipped" },
  "mastermind": { directness: "diplomatic", register: "polished", humor: "dry", stressTell: "goes quiet" },
  "social-butterfly": { energy: "warm", rhythm: "rambling", humor: "goofy", directness: "candid" },
  "floater": { directness: "evasive", energy: "even", stressTell: "deflects with a joke" },
  "villain": { directness: "blunt", humor: "cutting", register: "polished", stressTell: "talks faster" },
  "underdog": { humor: "self-deprecating", energy: "warm", stressTell: "over-explains" },
  "flirt": { energy: "warm", humor: "goofy", directness: "candid", rhythm: "rambling" },
  "loyalist": { directness: "candid", energy: "warm", stressTell: "over-explains" },
};

// 0090: anchor the archetype's CORE dials harder so an archetype reads distinctly (a comp-beast reliably
// blunt/clipped), while every UN-biased dial stays a free pick so two of an archetype still differ. The
// draw count is unchanged (one roll per dial), and voice rides a dedicated side rng, so this never
// perturbs the calibration spine.
const BIAS_STRENGTH = 0.8; // chance the archetype's lean wins a biased (core) dial (else a free pick)

function pick<T>(rng: RandomnessSource, options: readonly T[]): T {
  return options[rng.int(options.length)]!;
}

/** Pick a dial value: with `BIAS_STRENGTH` take the archetype's lean (if any), else a free pick. */
function pickDial(rng: RandomnessSource, dial: Dial, lean?: string): string {
  const roll = rng.next(); // ALWAYS draw, so the per-NPC draw count is stable with or without a lean
  if (lean !== undefined && roll < BIAS_STRENGTH) return lean;
  return pick(rng, VOICE_DIALS[dial]);
}

/**
 * Generate a houseguest's voice fingerprint — seeded + archetype-biased, independently varied. The
 * draw count is FIXED (one roll per dial + signature + two lexicon picks) regardless of archetype, so
 * a caller's seeded stream advances identically for every houseguest.
 */
export function generateVoice(rng: RandomnessSource, archetype: string): VoiceProfile {
  const lean = VOICE_ARCHETYPE_BIAS[archetype] ?? {};
  const register = pickDial(rng, "register", lean.register);
  const rhythm = pickDial(rng, "rhythm", lean.rhythm);
  const energy = pickDial(rng, "energy", lean.energy);
  const directness = pickDial(rng, "directness", lean.directness);
  const humor = pickDial(rng, "humor", lean.humor);
  const stressTell = pickDial(rng, "stressTell", lean.stressTell);
  // 0090: draw the signature + fillers from the archetype's OWN pool when it has one (fallback = the flat
  // pool, byte-identical for an un-pooled archetype). Same fixed draw count — one signature + two fillers.
  const signature = pick(rng, VOICE_ARCHETYPE_SIGNATURES[archetype] ?? VOICE_SIGNATURES);
  const lexPool = VOICE_ARCHETYPE_LEXICON[archetype] ?? VOICE_LEXICON_POOL;
  const a = pick(rng, lexPool);
  const b = pick(rng, lexPool);
  const lexicon = a === b ? [a] : [a, b];
  return { register, rhythm, energy, directness, humor, stressTell, signature, lexicon };
}

/**
 * I6 distinct-voices fix (NARR-15 / PROMPT-2, 2026-07-05): a COMPACT, PLAYER-SURFACE-SAFE text clause
 * describing HOW a houseguest talks, for the always-present roster the narrator reads every turn.
 *
 * DELIBERATELY built ONLY from the controlled DIAL vocabulary (register/rhythm/energy/directness/humor
 * + the stress tell) — never the free-text `signature` or `lexicon`. Those free fields are legitimate
 * PUBLIC persona, but they are UNCONTROLLED prose: the archetype signature pool contains e.g. "makes a
 * threat sound like small talk" and the lexicon pool contains "100%", so putting the raw `VoiceProfile`
 * object on the Vault-free `GameStateView` tripped the coarse Vault-Wall scan (`/trust|threat|affinity|
 * soul/` + digits). The dial vocab is a closed, audited set with none of those substrings and no digit,
 * so this clause is provably safe to serialize onto a player-facing projection while still giving the
 * narrator a distinct cadence per houseguest without an `npcVoice` call. `npcVoice` still carries the
 * FULL fingerprint (signature + lexicon) for a deep scene — it is not a player-scanned surface.
 *
 * Pure, deterministic, no I/O — a plain projection of already-public dial words.
 */
export function voiceFingerprint(voice: VoiceProfile): string {
  return `talks in a ${voice.register}, ${voice.rhythm}, ${voice.directness} voice — ${voice.energy}, ${voice.humor} humor; under pressure ${voice.stressTell}`;
}

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0.5);

/**
 * The carriage word for a blended soul level (0..1). RECALIBRATED (post-0085 diagnostic): a real
 * season keeps souls in ~0.3–0.74, so the old wide bands collapsed the whole house onto "even"/
 * "settled". These finer bands give the mid-range its own gradations (muted → even → steady → settled)
 * while keeping the extremes reachable, so sixteen houseguests read as sixteen moods, not one.
 */
function carriageWord(v: number): string {
  if (v < 0.22) return "hollowed out";
  if (v < 0.33) return "worn down";
  if (v < 0.42) return "subdued";
  if (v < 0.49) return "muted";
  if (v < 0.55) return "even";
  if (v < 0.62) return "steady";
  if (v < 0.70) return "settled";
  if (v < 0.80) return "at ease";
  return "riding high";
}

/** The ACUTE state carries the real per-moment spread, so it leads the blend; the baseline pulls it. */
const ACUTE_WEIGHT = 0.62;
const DISTRESS = 0.22; // an acute crisis always shows, over everything
const LOW_BASELINE = 0.34; // a season-long set-point below this reads as chronically "worn"
const HIGH_BASELINE = 0.7; // …above this, as lasting "at ease"
// Volatility runs chronically high in a live season (diag: avg ~0.89), so "on edge" only means
// something near the top of the range — otherwise it's universal noise. (The deeper fix — souls that
// actually settle — lives in emotionalArc and is calibration-gated; this is the read-side bar.)
const VOLATILE = 0.92;

/**
 * The Vault-safe MOOD word for the voicer. BLENDS the ACUTE state (`emotionalState`, which carries the
 * real per-moment spread) with the MARINATED baseline (the trend of `emotionalHistory` — what the
 * season has done to them), so the moment drives the word while the long arc flavors it: a houseguest
 * worn down over weeks reads "worn but …" even on a lift; a long safe run reads "at ease but …" on a
 * dip; a fresh crash always shows as "shaken". Never a number, never the cause. `emotionalHistory`
 * defaults to the acute value (a fresh soul has no arc yet).
 */
export function moodWord(emotionalState: number, volatility: number, emotionalHistory: readonly number[] = []): string {
  const acute = clamp01(emotionalState);
  const marinated = emotionalHistory.length ? clamp01(mean(emotionalHistory)) : acute;
  const effective = clamp01(ACUTE_WEIGHT * acute + (1 - ACUTE_WEIGHT) * marinated);

  let word = carriageWord(effective);
  // The marinade as a lasting FLAVOR layered on the moment (the season's set-point):
  if (marinated < LOW_BASELINE && acute > marinated + 0.1) word = `worn but ${word}`;
  else if (marinated > HIGH_BASELINE && acute < marinated - 0.08) word = `at ease but ${word}`;
  // An acute crisis overrides the flavor entirely.
  if (acute < DISTRESS) word = `shaken, ${carriageWord(effective)}`;

  if (clamp01(volatility) > VOLATILE) word = `${word}, on edge`;
  return word;
}
