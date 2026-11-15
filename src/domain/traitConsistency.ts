/**
 * ORW-432: which seeded traits may share one houseguest's card. The engine deals casting type, build,
 * demeanor, strategy and the six voice dials each on its own stream; this table is the single place that
 * says which combinations contradict (data, not branches), shared by the deals and by the pure card check
 * `traitContradictions` that the end-of-creation gate calls. PUBLIC fields only: it reads archetype,
 * strategy style, demeanor, casting-type label, heightBuild and the `voice` line, all already on the card.
 * It reads no stat, secret or Vault field (ADR 0001 stays as amended: the build-to-stat hint is not widened).
 */

/** How a demeanor comes across, read from its words (seeded or authored). */
export type Temper = "loud" | "quiet" | "warm" | "hard";

/** Keyword tests per temper. One text may carry several tempers ("bubbly but cutting" is loud, warm and hard). */
export const TEMPER_WORDS: Readonly<Record<Temper, RegExp>> = {
  loud: /\b(loud|bouncy|booming|theatrical|explosive|brash|bubbly|chaotic|confrontational|grandiose|boisterous|flamboyant|effusive|animated|wired|buzzing|brassy)\b/i,
  quiet: /\b(quiet|soft-spoken|shy|stoic|unbothered|unhurried|serene|reserved|clipped|cool|deadpan|buttoned-up|muted|hushed|watchful|guarded|terse|subdued)\b/i,
  warm: /\b(warm|sweet|tender|tender-hearted|kind|maternal|earnest|jolly|gentle|friendly|bubbly|cheerful|genial)\b/i,
  hard: /\b(abrasive|blunt|cutting|cocky|brash|confrontational|explosive|intense|defiant|sarcastic|cynical|combative|blowup|aggressive|scrappy)\b/i,
};

export const TEMPERS: readonly Temper[] = ["loud", "quiet", "warm", "hard"];

/** The tempers a demeanor text carries. */
export function tempersOf(demeanor: string | undefined | null): Temper[] {
  const t = typeof demeanor === "string" ? demeanor : "";
  return TEMPERS.filter((k) => TEMPER_WORDS[k].test(t));
}

/** One casting type's compatibility: the archetypes it suits, and what it must never sit beside. */
export interface TypeFit {
  /** Archetypes this type may be cast on. */
  readonly archetypes: readonly string[];
  /** Demeanor tempers this type contradicts. */
  readonly forbidTempers: readonly Temper[];
  /** Strategy styles this type contradicts. */
  readonly forbidStyles: readonly string[];
}

const ALL_ARCH = [
  "comp-beast", "mastermind", "social-butterfly", "floater", "villain", "underdog", "flirt", "loyalist",
  "wildcard", "analyst", "hothead", "peacemaker",
];
const F = (archetypes: readonly string[], forbidTempers: readonly Temper[] = [], forbidStyles: readonly string[] = []): TypeFit =>
  ({ archetypes, forbidTempers, forbidStyles });

/**
 * Casting type id -> fit. A type is COMPATIBLE with a houseguest when their archetype is listed, none of
 * their demeanor's tempers is forbidden, and their strategy style is not forbidden. CONFLICT (the fallback
 * measure when no unused compatible type is left) is the count of those three tests that fail.
 */
export const CASTING_TYPE_FIT: Readonly<Record<string, TypeFit>> = {
  "charmer": F(["social-butterfly", "flirt", "villain", "mastermind", "floater", "loyalist", "wildcard"], ["hard"]),
  "firecracker": F(["hothead", "wildcard", "comp-beast", "underdog", "flirt", "villain", "social-butterfly"], ["quiet"]),
  "jock": F(["comp-beast", "hothead", "wildcard", "loyalist", "floater", "villain", "peacemaker"], ["quiet"]),
  "sweetheart": F(["peacemaker", "loyalist", "underdog", "social-butterfly", "floater", "flirt"], ["hard"], ["aggressive"]),
  "brain": F(["analyst", "mastermind", "underdog", "floater", "villain", "peacemaker", "loyalist"], ["loud"]),
  "class-clown": F(["social-butterfly", "floater", "underdog", "wildcard", "flirt", "peacemaker", "loyalist"], ["quiet"]),
  "rebel": F(["wildcard", "hothead", "comp-beast", "villain", "underdog", "floater"], ["warm"]),
  "free-spirit": F(["floater", "wildcard", "flirt", "social-butterfly", "underdog", "peacemaker"], ["hard"], ["aggressive"]),
  "hustler": F(["villain", "mastermind", "comp-beast", "social-butterfly", "flirt", "wildcard", "analyst", "floater"]),
  "quiet-storm": F(["mastermind", "analyst", "villain", "underdog", "comp-beast", "floater", "loyalist"], ["loud"]),
  "diva": F(["villain", "flirt", "social-butterfly", "hothead", "wildcard", "mastermind"], ["quiet"]),
  "parent-of-the-house": F(["peacemaker", "loyalist", "underdog", "social-butterfly", "floater", "analyst"], ["hard"], ["aggressive"]),
  "silver-fox": F(["mastermind", "flirt", "villain", "analyst", "comp-beast", "floater", "peacemaker"], ["loud"]),
  "underdog": F(["underdog", "floater", "loyalist", "peacemaker", "analyst", "social-butterfly", "flirt"], ["loud", "hard"]),
  "flirt": F(["flirt", "social-butterfly", "villain", "mastermind", "floater", "wildcard", "underdog"], ["hard"]),
  "straight-shooter": F(["comp-beast", "loyalist", "peacemaker", "analyst", "hothead", "villain", "underdog", "floater"]),
  "dreamer": F(["floater", "underdog", "analyst", "peacemaker", "flirt", "loyalist", "social-butterfly"], ["hard", "loud"], ["aggressive"]),
  "wise-head": F(["peacemaker", "analyst", "mastermind", "loyalist", "underdog", "floater"], ["loud", "hard"]),
  "wildcard": F(["wildcard", "hothead", "floater", "flirt", "social-butterfly", "underdog", "villain", "comp-beast"]),
  "mastermind-in-plain-sight": F(["mastermind", "analyst", "villain", "floater", "loyalist", "peacemaker"], ["loud", "hard"]),
  "life-of-the-party": F(["social-butterfly", "flirt", "wildcard", "floater", "underdog", "peacemaker", "hothead"], ["quiet"]),
  "gentle-giant": F(["peacemaker", "loyalist", "underdog", "comp-beast", "floater", "analyst"], ["loud", "hard"], ["aggressive"]),
  "competitor": F(["comp-beast", "hothead", "villain", "wildcard", "mastermind", "analyst", "loyalist"]),
  "natural": F(ALL_ARCH),
};

/** What a houseguest presents, for the fit test. Any field may be absent (then it cannot conflict). */
export interface FitTraits { archetype?: string; strategyStyle?: string; demeanor?: string }

/** How many of the three tests (archetype, demeanor temper, strategy style) a type fails for these traits. */
export function castingConflict(typeId: string, t: FitTraits): number {
  const fit = Object.hasOwn(CASTING_TYPE_FIT, typeId) ? CASTING_TYPE_FIT[typeId] : undefined;
  if (fit === undefined) return 0;
  let n = 0;
  if (t.archetype !== undefined && t.archetype !== "" && !fit.archetypes.includes(t.archetype)) n++;
  if (tempersOf(t.demeanor).some((k) => fit.forbidTempers.includes(k))) n++;
  if (t.strategyStyle !== undefined && fit.forbidStyles.includes(t.strategyStyle)) n++;
  return n;
}

/** Compatible means no conflict at all. */
export const castingCompatible = (typeId: string, t: FitTraits): boolean => castingConflict(typeId, t) === 0;

// ── heightBuild ───────────────────────────────────────────────────────────────────────────────────────
/** Words that state HEIGHT. "compact", "lanky", "slight" and the like are build words, not height. */
const HEIGHT_WORD_RE = /\b(tall|short|petite|towering|average height|medium height|medium-height|mid-height|of average height|of medium height|average-height)\b/gi;

/** The distinct height statements in a heightBuild text (an "average height" and a "short" are two). */
export function heightWordsIn(text: string): string[] {
  const found = (text.match(HEIGHT_WORD_RE) ?? []).map((w) => w.toLowerCase().replace(/^of /, "").replace(/-/g, " ").replace(/^medium height$/, "average height"));
  return [...new Set(found)];
}

const TALL_BUILD_OPPOSITE: readonly [RegExp, RegExp][] = [[/\btall\b/i, /\bpetite\b/i]];

/** True when a heightBuild text states two different heights, or a height against an opposite (tall + petite). */
export function heightBuildContradicts(text: string): boolean {
  if (heightWordsIn(text).length > 1) return true;
  return TALL_BUILD_OPPOSITE.some(([a, b]) => a.test(text) && b.test(text));
}

// ── voice ─────────────────────────────────────────────────────────────────────────────────────────────
/** One side of a voice rule: the dial value, and the words that show it in a rendered or authored line. */
export interface VoiceSide { readonly dial: string; readonly value: string; readonly words: RegExp }

/** Pairs of voice traits that cannot coexist on one person. `change` names the side the deal re-picks. */
export const VOICE_CONFLICTS: readonly { readonly a: VoiceSide; readonly b: VoiceSide; readonly change: "a" | "b" }[] = [
  { a: { dial: "humor", value: "none", words: /\bno humor\b|\bnone humor\b/i }, b: { dial: "stressTell", value: "deflects with a joke", words: /deflects with a joke|cracks a joke|jokes (?:it|things) off/i }, change: "a" },
  { a: { dial: "rhythm", value: "measured", words: /\bmeasured\b/i }, b: { dial: "energy", value: "manic", words: /\bmanic\b/i }, change: "b" },
  { a: { dial: "rhythm", value: "measured", words: /\bmeasured\b/i }, b: { dial: "energy", value: "buzzy", words: /\bbuzzy\b/i }, change: "b" },
  { a: { dial: "rhythm", value: "measured", words: /\bmeasured\b/i }, b: { dial: "stressTell", value: "talks faster", words: /talks faster|faster and faster/i }, change: "b" },
  { a: { dial: "rhythm", value: "staccato", words: /\bstaccato\b/i }, b: { dial: "stressTell", value: "over-explains", words: /over-explains/i }, change: "b" },
  { a: { dial: "energy", value: "flat", words: /\bflat\b/i }, b: { dial: "energy", value: "manic", words: /\bmanic\b/i }, change: "b" },
  { a: { dial: "directness", value: "evasive", words: /\bevasive\b/i }, b: { dial: "directness", value: "blunt", words: /\bblunt\b/i }, change: "b" },
];

/** A voice trait against a demeanor temper (the same how-they-come-across family): soft demeanors never blunt or manic. */
export const VOICE_TEMPER_CONFLICTS: readonly { readonly temper: Temper; readonly side: VoiceSide; readonly change: "dial" }[] = [
  { temper: "quiet", side: { dial: "directness", value: "blunt", words: /\bblunt\b/i }, change: "dial" },
  { temper: "quiet", side: { dial: "energy", value: "manic", words: /\bmanic\b/i }, change: "dial" },
  { temper: "quiet", side: { dial: "energy", value: "buzzy", words: /\bbuzzy\b/i }, change: "dial" },
  { temper: "loud", side: { dial: "energy", value: "flat", words: /\bflat\b/i }, change: "dial" },
];

/**
 * The voice-line templates. `voiceFingerprint` renders one per houseguest (picked by a stable hash of the
 * dials, so the line never changes for the season) so the cast does not read as one sentence shape. Every
 * template carries all six dials and is exactly invertible (the front end parses them back).
 */
export const VOICE_LINE_TEMPLATES: readonly string[] = [
  "talks in {a:register}, {rhythm}, {directness} voice — {energy}, {humor} humor; under pressure {stressTell}",
  "{energy} and {directness}, with {a:register} way of putting things and {a:rhythm} rhythm; {humor} humor; when pressed, {stressTell}",
  "{register} and {rhythm} on a good day, {directness} on a bad one; {energy} energy, {humor} humor; if it gets tense, {stressTell}",
  "{a:directness} talker, {register} and {rhythm}, {energy} in the room, {humor} humor; at the first sign of pressure {stressTell}",
  // ORW-464: four more shapes, so the first shape opens about one card in eight instead of one in four. The first four stay at the
  // same positions, so a card whose hash lands on 0-3 of 8 keeps its line; the others move to the new shapes.
  "{directness} and {register}, {rhythm} in rhythm and {energy} in energy; {humor} humor; under pressure {stressTell}",
  "sounds {register} and {rhythm}, {directness} when it counts; {energy}, {humor} humor; when it gets hard, {stressTell}",
  "{rhythm} delivery, {register} word choice, {directness} when asked; {energy} presence, {humor} humor; at the limit {stressTell}",
  "known for {a:energy}, {directness} manner, {register} and {rhythm}; {humor} humor; when cornered, {stressTell}",
];

/** A voice-trait vs demeanor rule applies unless the demeanor also carries the opposite temper (loud with quiet is ambiguous). */
export function temperRuleApplies(rule: { readonly temper: Temper }, tempers: readonly Temper[]): boolean {
  const opposite = rule.temper === "loud" ? "quiet" : rule.temper === "quiet" ? "loud" : undefined;
  return tempers.includes(rule.temper) && (opposite === undefined || !tempers.includes(opposite));
}

/** The first voice rule a line trips: its label, the side to change, and the other side. Undefined when none. */
export function voiceLineConflictDetail(line: string, demeanor?: string): { label: string; change: VoiceSide; other: VoiceSide } | undefined {
  for (const r of VOICE_CONFLICTS) {
    if (r.a.words.test(line) && r.b.words.test(line)) {
      return { label: `${r.a.value}+${r.b.value}`, change: r.change === "a" ? r.a : r.b, other: r.change === "a" ? r.b : r.a };
    }
  }
  const tempers = tempersOf(demeanor);
  for (const r of VOICE_TEMPER_CONFLICTS) {
    if (temperRuleApplies(r, tempers) && r.side.words.test(line)) return { label: `${r.temper}+${r.side.value}`, change: r.side, other: r.side };
  }
  return undefined;
}

/** Whether a rendered or authored voice line trips a rule. Returns the first conflict description, or undefined. */
export function voiceLineConflict(line: string, demeanor?: string): string | undefined {
  return voiceLineConflictDetail(line, demeanor)?.label;
}

/** Rewrite a heightBuild that names two heights (or tall with petite) to its FIRST height word plus the rest, dropping the later height words. */
export function repairHeightBuild(text: string): string {
  let seen = false;
  const kept = text.replace(HEIGHT_WORD_RE, (m) => { if (!seen) { seen = true; return m; } return ""; });
  const noPetiteWithTall = /\btall\b/i.test(kept) ? kept.replace(/\bpetite\b/gi, "") : kept;
  return noPetiteWithTall.replace(/\s{2,}/g, " ").replace(/\s+,/g, ",").replace(/,(\s*,)+/g, ",").replace(/^[\s,]+|[\s,]+$/g, "").replace(/\b(and|with)\s*$/i, "").replace(/[\s,]+$/g, "").trim();
}

// ── the card check ────────────────────────────────────────────────────────────────────────────────────
export type TraitReason = "trait-casting-type" | "trait-height-build" | "trait-voice";

/** The public card fields the check reads. All optional: a missing field cannot contradict. */
export interface CardTraits {
  archetype?: string;
  strategyStyle?: string;
  demeanor?: string;
  castingType?: { label?: string; read?: string } | undefined;
  physicalCharacteristics?: { heightBuild?: string } | undefined;
  voice?: string;
}

/** Gender-neutral labels (review of #2666) whose id kept its old name, so a saved card's id and seeded deals do not move. */
const LABEL_TO_ID: Readonly<Record<string, string>> = { "showstopper": "diva", "distinguished-one": "silver-fox" };

const idOfLabel = (label: string): string | undefined => {
  const norm = label.trim().toLowerCase().replace(/^the\s+/, "").replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
  if (Object.hasOwn(LABEL_TO_ID, norm)) return LABEL_TO_ID[norm];
  return Object.hasOwn(CASTING_TYPE_FIT, norm) ? norm : undefined;
};

/**
 * The reason codes a card's public traits trip ([] when clean). Pure, public fields only, no randomness.
 * `trait-casting-type`: the casting type contradicts the archetype, demeanor or strategy style.
 * `trait-height-build`: two heights (or tall with petite) in one heightBuild.
 * `trait-voice`: the voice line pairs traits that cannot coexist, or clashes with the demeanor.
 */
export function traitContradictions(card: CardTraits): TraitReason[] {
  const out: TraitReason[] = [];
  const id = card.castingType?.label ? idOfLabel(card.castingType.label) : undefined;
  if (id !== undefined && castingConflict(id, card) > 0) out.push("trait-casting-type");
  const hb = card.physicalCharacteristics?.heightBuild;
  if (typeof hb === "string" && heightBuildContradicts(hb)) out.push("trait-height-build");
  if (typeof card.voice === "string" && voiceLineConflict(card.voice, card.demeanor) !== undefined) out.push("trait-voice");
  return out;
}
