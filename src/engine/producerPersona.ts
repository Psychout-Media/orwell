import type { RandomnessSource } from "../ports/RandomnessSource";
import { SeededRandom } from "../adapters/random/SeededRandom";
import { ARCHETYPES, DEMEANORS, hashSeed } from "./characterFactory";
import { GIVEN_NAMES } from "./data/givenNames";

/**
 * The PRODUCER persona (the casting-interview voice).
 *
 * The producer is a REAL generated character — as deep a persona as any houseguest, built by the
 * same `CharacterFactory` machinery (archetypes / demeanors / the real-name corpus) — BUT it is
 * explicitly NOT a houseguest:
 *   · OFF-CAMERA — the unseen producer voice across the casting table. It has NO headshot/portrait
 *     and never appears in "The Cast", the roster, the portrait pipeline, or whereabouts.
 *   · NOT one of the 16 — it is never in `GameHouse.npcs`, never seeded into relationships, never
 *     in the house, never witnessed by anyone in the game.
 *
 * It is a persistent, SEEDED (reproducible) persona with a distinct personality/voice that the
 * casting interview voices CONSISTENTLY (the same seed → the same producer, across turns and a
 * restart). Everything here is PUBLIC voice material (facts to voice, ADR 0003) — the producer is
 * a GM-voice entity, not a houseguest with secret game state, so nothing here is Vault content.
 *
 * The flags below are structural assertions the exclusion tests read: a producer is, by
 * construction, off-camera, portrait-less, and not a houseguest.
 */
export interface Producer {
  /** A real first name (seeded from the same corpus as the cast) — the byline on the casting table. */
  name: string;
  /** The producer's CORE temperament archetype (reused from the cast archetype vocabulary). */
  archetype: string;
  /** Their observable register / voice (reused from the cast demeanor pool) — how they come across. */
  demeanor: string;
  /** Their strategic read on running a casting room — the lens they probe a player through. */
  disposition: string;
  /** Their calculated, strategic WIT style — the kind of dry humor they deploy to disarm/test. */
  wit: string;
  /** A small, distinct quirk that colors their voice consistently all interview. */
  quirk: string;
  /** A one-line backstory: who this producer is and how many seasons they have cast. */
  backstory: string;
  /** STRUCTURAL: the producer is off-camera (the unseen voice) — never on a portrait or in a room. */
  offCamera: true;
  /** STRUCTURAL: the producer has NO headshot — excluded from the portrait pipeline. */
  headshot: false;
  /** STRUCTURAL: the producer is NOT one of the 16 — never in the cast / roster / whereabouts. */
  houseguest: false;
}

// --- The producer's persona vocabularies (seeded draws) -----------------------
// Distinct from a houseguest's: a producer is a VETERAN of casting rooms, not a player. Each pool is
// PUBLIC voice flavor only (no stats, no hidden game state) and carries no Vault vocabulary. Every
// entry is a plain phrase that does NOT contain the stat-key substrings "physical"/"mental"/"social"
// (so it can never serialize into a leak the Vault sentinel sweeps hunt for).

/** How the producer reads a casting room — the strategic lens they run the interview through. */
const PRODUCER_DISPOSITIONS: readonly string[] = [
  "a veteran who has cast a dozen seasons and can smell a fake answer from across the table",
  "a former editor who casts for the story, not the résumé — they want the contradiction, not the highlight reel",
  "a sharp talent scout who plays the long game, banking the tell now to use it on air later",
  "an ice-cool casting director who lets a silence sit until the rehearsed answer cracks",
  "a producer who has seen every archetype walk in and is hunting for the one thing they didn't expect",
  "a quietly ruthless gatekeeper who decides in the first five minutes and spends the rest testing the read",
];

/** The producer's CALCULATED wit — deliberate, strategic humor used to disarm and provoke honesty. */
const PRODUCER_WITS: readonly string[] = [
  "a dry, deadpan aside that lands right before a hard question, to knock them off balance",
  "a wry, knowing needle that disarms the rehearsed answer and dares them to be real",
  "a sly, well-timed bit of gallows humor about how the house chews people up",
  "a flat, faux-innocent question with a hook in it — funny until they realize it was a test",
  "a cool sardonic clip that flatters and traps in the same breath",
  "a low-key teasing jab that makes the player relax just enough to overshare",
];

/** A small distinct quirk that keeps the voice consistent (a verbal habit / tic, never stage directions). */
const PRODUCER_QUIRKS: readonly string[] = [
  "circles back to a thing they said three answers ago, to see if the story holds",
  "repeats the player's own loaded word back to them as a single-word question",
  "frames the dangerous questions as throwaways and the throwaways as if they matter",
  "keeps a running tally out loud of the contradictions, lightly, never unkindly",
  "answers a non-answer with a longer silence than is comfortable",
  "occasionally lets one genuinely warm beat slip, then snaps the frame back to business",
];

/** The producer's years-in-the-room backstory line — who they are and how seasoned. */
const PRODUCER_BACKSTORIES: readonly string[] = [
  "ran the casting desk for years before this and has watched a hundred would-be winners flame out",
  "came up in the edit bay and crossed over to casting because they wanted the story at the source",
  "has cast every kind of player and is bored by the ones who already think they've won",
  "is the producer who fought to put the wild card on the wall and was usually right",
  "treats the casting room like a chess opening — every question is two moves ahead of the answer",
];

// ORW-511: each persona field carries a second clause from its own pool, so the offline floor is the product of two lists (not one list of five or six). The live writer overlay still authors the real persona.
const PRODUCER_DISPOSITION_TAILS: readonly string[] = [
  "and never says what they are really listening for",
  "and keeps the first impression in a notebook they never open in front of anyone",
  "and is more patient than the room expects",
  "and trusts a hesitation more than a speech",
  "and writes the verdict down before the player finishes the sentence",
  "and has been wrong about people exactly as often as they will admit",
  "and treats every confident answer as an opening bid",
  "and likes a person best the moment they stop performing",
];
const PRODUCER_WIT_TAILS: readonly string[] = [
  "delivered with a perfectly straight face",
  "and then waits as if nothing was said",
  "usually at the expense of whatever the player just said",
  "but only when the player least expects the room to be paying attention",
  "and gone before the player can decide whether it was a joke",
  "pitched low enough that it sounds like a confidence",
  "with the timing of someone who has told it before and still enjoys it",
  "always aimed at the answer, never at the person",
];
const PRODUCER_QUIRK_TAILS: readonly string[] = [
  "and taps a pen twice before the question that matters",
  "and never writes down the answers that are true",
  "and says the player's first name only when something is about to change",
  "and lets a cold cup of coffee sit untouched all session",
  "and checks the clock only when the player says something that matters",
  "and goes still whenever the player starts to relax",
  "and hums half a tune when a story is being polished",
  "and glances at the door right before a surprising question",
];
const PRODUCER_BACKSTORY_TAILS: readonly string[] = [
  "after a first season that went wrong in a way nobody on the crew still talks about",
  "and still keeps a note of every contestant they were sure about and were wrong about",
  "having trained under someone who cast by gut and never explained why",
  "and left a steadier career behind because this room was more honest",
  "with a reputation among the crew for remembering everything and repeating nothing",
  "after years of learning that the loudest person in the room is rarely the one who matters",
  "and came back after a long break because nothing else held their attention",
  "having learned to like the players the audience will not",
];

/**
 * Generate the producer persona (feature: producer persona). Reuses the `CharacterFactory` archetype
 * + demeanor vocabularies and the real-name corpus so the producer is a CHARACTER built by the same
 * machinery as the cast — but a producer-flavored one (a veteran caster, not a contestant).
 *
 * SEEDED & reproducible: the same `rng` always yields the same producer. Player-INDEPENDENT (it reads
 * only its rng, never a player field), so a given season seed voices the same producer regardless of
 * who the player turns out to be. Vault-free by construction (every field is public voice flavor).
 */
export function generateProducer(rng: RandomnessSource): Producer {
  const name = rng.pick(GIVEN_NAMES);
  const archetype = rng.pick(ARCHETYPES).archetype;
  const demeanor = rng.pick(DEMEANORS);
  const disposition = rng.pick(PRODUCER_DISPOSITIONS);
  const wit = rng.pick(PRODUCER_WITS);
  const quirk = rng.pick(PRODUCER_QUIRKS);
  const backstory = rng.pick(PRODUCER_BACKSTORIES);
  // ORW-511: the second clauses are drawn AFTER every original draw, so name, archetype, demeanor and the first clause of each field keep their seeded values.
  return {
    name,
    archetype,
    demeanor,
    disposition: `${disposition}, ${rng.pick(PRODUCER_DISPOSITION_TAILS)}`,
    wit: `${wit}, ${rng.pick(PRODUCER_WIT_TAILS)}`,
    quirk: `${quirk}, ${rng.pick(PRODUCER_QUIRK_TAILS)}`,
    backstory: `${backstory}, ${rng.pick(PRODUCER_BACKSTORY_TAILS)}`,
    offCamera: true,
    headshot: false,
    houseguest: false,
  };
}

/**
 * Generate the producer for a season, keyed off the season seed (or any stable pre-game seed). Forked
 * onto a DEDICATED sub-stream (hashed off the seed) so generating the producer never perturbs the
 * house/competition streams — exactly the RNG-isolation precedent the factory uses for hidden elements
 * and backstory facets. Same seed in → same producer out (reproducible across turns and a restart).
 */
export function producerForSeed(seed: number): Producer {
  return generateProducer(new SeededRandom(hashSeed(`${seed}:producer`)));
}

// ── AI-authored DEEPENING overlay (increment 3) ──────────────────────────────────────────────────────
/**
 * An OPTIONAL, FE-driven authored overlay that DEEPENS the seeded producer persona (a richer backstory,
 * a sharper disposition/wit/quirk, a distinct temperament/register) WITHOUT touching the seeded NAME —
 * the byline must stay byte-stable so it never churns. Every field is OPEN-SET public voice PROSE (the
 * `renderProducerVoice` block reads them as facts to voice, ADR 0003), so nothing here is Vault content:
 * there is NO name, NO stat, NO number, and NO hidden game state — structurally unproposable, exactly the
 * `validateCastGenesis` split (identity is open-set, power is closed-set-and-unproposable). A merged
 * producer keeps the seeded floor value for every field the overlay omits (non-degradation — an authored
 * overlay never LOSES seeded detail), so the floor always stands when there is no overlay.
 */
export interface ProducerProfileOverlay {
  /** Core temperament / register (the "Core temperament" line) — how they come across, in the model's words. */
  archetype?: string;
  /** Observable demeanor / voice register. */
  demeanor?: string;
  /** Their strategic read on running a casting room — the lens they probe a player through. */
  disposition?: string;
  /** Their calculated, deliberate WIT style. */
  wit?: string;
  /** A small, distinct verbal quirk that colors the voice consistently. */
  quirk?: string;
  /** A richer backstory: who this producer is and how they came to the casting desk. */
  backstory?: string;
}

/** The open-set overlay fields, in the order the deepening reports them (never includes `name`). */
export const PRODUCER_OVERLAY_FIELDS = [
  "archetype", "demeanor", "disposition", "wit", "quirk", "backstory",
] as const;

/**
 * The Vault-vocabulary the overlay may NEVER carry (mandate #2/#3): the stat-key substrings the Vault
 * sentinel sweeps hunt for, plus `soul`/`stats`. A field containing ANY of these (or a decimal number —
 * a stat/rating shape) is REJECTED wholesale (the seeded floor for that field stands), so no numeric stat
 * or hidden-layer word can ever ride the producer's PUBLIC voice block. Structural, not prompt-worded.
 */
const PRODUCER_FORBIDDEN_SUBSTRINGS: readonly string[] = ["physical", "mental", "social", "soul", "stats"];
const PRODUCER_DECIMAL_RE = /\d\s*\.\s*\d/;
const PRODUCER_BACKSTORY_MAX = 500;
const PRODUCER_FIELD_MAX = 220;

/** Flatten control chars / collapse whitespace / length-cap an FE-authored prose value. Empty ⇒ undefined. */
function neutralizeProducerProse(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const flat = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  return flat.length <= max ? flat : flat.slice(0, max);
}

/** True when a neutralized value carries forbidden Vault vocabulary or a stat/rating-shaped number. */
function violatesProducerVaultVocab(v: string): boolean {
  const low = v.toLowerCase();
  if (PRODUCER_FORBIDDEN_SUBSTRINGS.some((k) => low.includes(k))) return true;
  return PRODUCER_DECIMAL_RE.test(v);
}

/**
 * Validate a proposed producer-deepening payload into a Vault-free overlay (the `validateCastGenesis`
 * envelope pattern, scaled to the producer). PURE. Each open-set field is neutralized + length-capped;
 * a field carrying stat/soul vocabulary (or a decimal number) is REJECTED and left to the seeded floor;
 * an absent/blank field simply keeps the floor (NOT a rejection). `name` and any unknown key are IGNORED
 * — the byline is seeded and immovable. Returns the accepted overlay, the accepted field NAMES, and the
 * rejected field NAMES (for the caller's Vault-free result).
 */
export function validateProducerProfile(raw: Record<string, unknown> | undefined): {
  overlay: ProducerProfileOverlay; fields: string[]; rejected: string[];
} {
  const overlay: ProducerProfileOverlay = {};
  const fields: string[] = [];
  const rejected: string[] = [];
  for (const key of PRODUCER_OVERLAY_FIELDS) {
    const flat = neutralizeProducerProse(raw?.[key], key === "backstory" ? PRODUCER_BACKSTORY_MAX : PRODUCER_FIELD_MAX);
    if (!flat) continue; // absent/blank ⇒ the seeded floor stands (not a rejection)
    if (violatesProducerVaultVocab(flat)) { rejected.push(key); continue; }
    overlay[key] = flat;
    fields.push(key);
  }
  return { overlay, fields, rejected };
}

/**
 * Merge the seeded floor producer with an authored overlay: the overlay wins where present, the seeded
 * floor fills every field the overlay omits, and the NAME + the structural flags ALWAYS come from the
 * seeded floor (the byline never churns; the producer stays off-camera / head-shot-less / not-a-houseguest).
 * No overlay ⇒ the floor is returned unchanged (byte-identical to today). PURE.
 */
export function mergeProducer(floor: Producer, overlay?: ProducerProfileOverlay | null): Producer {
  if (!overlay) return floor;
  return {
    ...floor,
    ...(overlay.archetype ? { archetype: overlay.archetype } : {}),
    ...(overlay.demeanor ? { demeanor: overlay.demeanor } : {}),
    ...(overlay.disposition ? { disposition: overlay.disposition } : {}),
    ...(overlay.wit ? { wit: overlay.wit } : {}),
    ...(overlay.quirk ? { quirk: overlay.quirk } : {}),
    ...(overlay.backstory ? { backstory: overlay.backstory } : {}),
    // The byline + the structural off-camera flags are seeded and immovable (never from the overlay).
    name: floor.name,
    offCamera: true,
    headshot: false,
    houseguest: false,
  };
}

/**
 * The producer's PERSONA block woven into the casting prompt (facts to voice, ADR 0003) — guidance the
 * model voices the producer AS, never a script to recite. Public voice flavor only; carries no secret.
 */
export function renderProducerVoice(producer: Producer): string {
  return [
    "WHO YOU ARE (the producer running this interview — voice THIS persona consistently, it is the same",
    "producer every turn; these are facts to voice, never lines to read):",
    `  - Name: ${producer.name} — the casting producer across the table (off-camera; you never appear in the house).`,
    `  - Core temperament: ${producer.archetype}; you come across as ${producer.demeanor}.`,
    `  - How you read the room: ${producer.disposition}.`,
    `  - Your wit (calculated, never random): ${producer.wit}. You use humor DELIBERATELY — to disarm, to`,
    "    provoke a more honest answer, to test a read, to keep them off balance — never as a comedy bit and",
    "    never to flatter.",
    `  - A tell of your own: you ${producer.quirk}.`,
    `  - Your track record: you ${producer.backstory}.`,
  ].join("\n");
}
