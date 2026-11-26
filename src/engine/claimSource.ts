import type { EntityId } from "../domain/ids";
import { PLAYER } from "../domain/ids";
import { SeededRandom } from "../adapters/random/SeededRandom";
import { hashSeed } from "./characterFactory";
import { claimsOf, type BeliefClaim, type BeliefStore } from "./beliefStore";
import type { SpokenClaim, SpokenClaimKind } from "./spokenClaims";

/**
 * Feature 0152 / ORW-330 (theme 2, slice 4b) - "WHO TOLD YOU THAT?". The player asks a houseguest who told them what they just passed on. The
 * ENGINE reads the question (before the narrator, the resolvePlayerMove seam), finds the houseguest's RECORDED source for that belief and decides
 * whether they name it, protect it, or say they saw it themself. The answer is the houseguest's BELIEF: the source they recorded, which can be
 * wrong; the narrator is never told it is mistaken and never given the claim's truth, intent or id.
 *
 * Pure rules: no I/O. The only randomness is one bounded roll on the answer's OWN side stream (`${seed}:claim-source`), keyed on the claim, so the
 * same inputs always give the same answer and no other seeded roll moves (calibration-neutral). ENGINE-ONLY inputs; the one output that leaves is a
 * Vault-free one-line note.
 */

/** The chance a houseguest protects a source before the feelings move it. */
export const PROTECT_BASE = 0.35;
/** How far fondness for the SOURCE (mean of affinity and trust, 0..1, centred on 0.5) moves the protect chance: fond protects more, disliked names more. */
export const PROTECT_SOURCE_WEIGHT = 0.6;
/** How far trust in the PLAYER (centred on 0.5) moves it the other way: a houseguest who trusts the player names more, an unsure one protects more. */
export const PROTECT_PLAYER_WEIGHT = 0.5;
/** The protect chance is always inside this band: never certain either way. */
export const PROTECT_MIN = 0.05;
export const PROTECT_MAX = 0.9;

export type SourceAnswer = "name" | "protect" | "witnessed" | "slip";

/**
 * ORW-685 (T2-14): a liar asked where a lie they planted came from plays it off, and the cover can slip. Plays it off = says they saw it themself, or will not say who; slips = a visible stumble.
 * The slip chance is the actor's: the less cunning they are and the more rattled, the likelier; always inside a band, never certain either way.
 */
export const COVER = { slipBase: 0.3, cunningWeight: 0.5, rattledWeight: 0.3, slipMin: 0.05, slipMax: 0.7, refuseShare: 0.4, foldScale: 0.25 } as const;

export interface CoverInput { seed: number | string; holder: EntityId; claimId: string; cunning: number; volatility: number }

/** The chance a liar's cover slips when asked. Monotone: down in cunning, up in volatility. */
export function slipChance(cunning: number, volatility: number): number {
  const c = Math.max(0, Math.min(1, Number.isFinite(cunning) ? cunning : 0.5));
  const v = Math.max(0, Math.min(1, Number.isFinite(volatility) ? volatility : 0.3));
  return Math.max(COVER.slipMin, Math.min(COVER.slipMax, COVER.slipBase + COVER.cunningWeight * (0.5 - c) + COVER.rattledWeight * (v - 0.3)));
}

/** What a liar does when asked who told them: slip (the cover fails), protect (will not say), or witnessed (says they saw it). One keyed side stream (`${seed}:cover-slip`), so asking again gives the same answer and no other roll moves. */
export function decideCover(i: CoverInput): "slip" | "protect" | "witnessed" {
  const rng = new SeededRandom(hashSeed(`${i.seed}:cover-slip:${i.holder}:${i.claimId}`));
  if (rng.next() < slipChance(i.cunning, i.volatility)) return "slip";
  return rng.next() < COVER.refuseShare ? "protect" : "witnessed";
}

/** The claim the player is asking about: among the houseguest's askable claims (newest first), one whose subject or object the player named; otherwise the newest. Never an older claim just because it is easier to answer. */
export function pickAskedClaim(claims: readonly SpokenClaim[], text: string, nameOf: (id: EntityId) => string): SpokenClaim | undefined {
  const score = (c: SpokenClaim): number => (namedInText(text, nameOf(c.subject)) ? 1 : 0) + (c.object !== undefined && namedInText(text, nameOf(c.object)) ? 1 : 0);
  let best: SpokenClaim | undefined;
  let bestScore = 0;
  for (const c of claims) { const sc = score(c); if (sc > bestScore) { best = c; bestScore = sc; } } // strictly greater: a tie keeps the newer (they are newest first)
  return best ?? claims[0];
}

/** Does the player's message ask where a houseguest got what they just said? Natural variants; unrelated text is false. */
export function parseWhoToldYou(text: string): boolean {
  const t = String(text ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");
  if (t.length === 0 || t.length > 600) return false;
  if (/\b(?:don't|dont|won't|wont|not|never|no need to|wouldn't)\s+(?:even\s+)?(?:ask|wonder|care|say)\b/.test(t)) return false;
  const that = "(?:that|this|it|so|those things|all (?:that|this))";
  const forms = [
    new RegExp(`\\bwho (?:told|tells|said|says|has told|had told|gave|fed|whispered to|mentioned) (?:you|(?:that|this|it) to you)(?: ${that})?\\s*(?:[?.!,]|$)`),
    new RegExp(`\\bwho (?:told|said|mentioned|gave|fed) you ${that}\\b`),
    new RegExp(`\\bwho (?:said|says) ${that}\\b`),
    // ORW-720 (Season 2 playtest): "who told you Camila's coming after you", "who told you there was a name going round", "who told you different", "who told you about Lisa": the question runs on into the claim. Not "who told you to ..." (an instruction).
    /\bwho (?:told|said|mentioned|whispered|gave|fed) you (?!to\b|that\b|this\b|it\b)[a-z']{2,}/,
    new RegExp(`\\bwho (?:did|d|do) you hear ${that}(?: from)?\\b`),
    new RegExp(`\\bwho'?d you hear ${that}(?: from)?\\b`),
    new RegExp(`\\b(?:where|who) did you (?:hear|get|learn) ${that}(?: from)?\\b`),
    new RegExp(`\\bwhere'?d you (?:hear|get|learn) ${that}\\b`),
    new RegExp(`\\bwho (?:is|was|'s) your source\\b`),
    new RegExp(`\\bwho'?s your source\\b`),
    new RegExp(`\\bhow (?:do|did|would|could) you (?:even )?know ${that}\\b`),
    new RegExp(`\\bwhere (?:did|do) you (?:hear|get) (?:that|this|it) from\\b`),
    /\bwho (?:is|was) (?:telling|feeding) you (?:this|that|these things|things)\b/,
    /\bwho(?:'s| is| has been) (?:been )?(?:telling|feeding) you\b/,
    /\bsays who\b/,
  ];
  return forms.some((re) => re.test(t));
}

/** The belief kinds that can stand behind each spoken claim kind (the speaker's own held version of it). */
const HELD_AS: Record<SpokenClaimKind, readonly BeliefClaim["kind"][]> = {
  "targets-you": ["targets-me"],
  "voted-to-evict-you": ["voted-against-me"],
  "final-two-with": ["allied-with"],
  "going-after": ["heard-rumor", "targets-me"], // slice 4a says a held targets-me as going-after, the speaker being the object
  "talking-about": ["heard-rumor"],
  "lying-about": ["lied-to-me", "heard-rumor"],
  "voted-against": ["voted-against-me", "heard-rumor"], // 0153: "X voted to evict me / them"
  "voted-to-keep": ["assured-me", "heard-rumor"],        // 0153: "X voted to keep me / them"
  "has-reputation": ["heard-rumor"],                       // 0184 part 2a: "X has a name as ..." (a heard reputation, `rep:<label>`)
};

/**
 * The speaker's own RECORDED belief behind a claim they told: same subject (and object, where the claim has one, either way round for an
 * alliance), the kind that stands behind it, not refuted. The newest, then the surest, wins (deterministic). Undefined when they hold none.
 */
export function heldBeliefFor(store: BeliefStore | undefined, claim: Pick<SpokenClaim, "speaker" | "kind" | "subject" | "object">): BeliefClaim | undefined {
  const kinds = HELD_AS[claim.kind];
  const matches = claimsOf(store, claim.speaker).filter((b) => {
    if (!kinds.includes(b.kind) || b.refuted || !b.value) return false;
    if (b.subject !== claim.subject) {
      if (!(claim.kind === "final-two-with" && b.subject === claim.object && b.object === claim.subject)) return false;
      return true;
    }
    return claim.object === undefined || b.object === undefined || b.object === claim.object;
  });
  return matches.sort((a, b) => b.week - a.week || b.confidence - a.confidence || (a.id < b.id ? -1 : 1))[0];
}

export interface SourceFeelings {
  /** How the holder feels about their recorded source, both 0..1. */
  sourceAffinity: number; sourceTrust: number;
  /** How much the holder trusts the player, 0..1. */
  playerTrust: number;
}

/** The chance the holder protects a named source: fond of the source and unsure of the player protects more; dislikes the source or trusts the player, less. Bounded. */
export function protectChance(f: SourceFeelings): number {
  const clamp = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0.5));
  const fond = (clamp(f.sourceAffinity) + clamp(f.sourceTrust)) / 2;
  const p = PROTECT_BASE + PROTECT_SOURCE_WEIGHT * (fond - 0.5) - PROTECT_PLAYER_WEIGHT * (clamp(f.playerTrust) - 0.5);
  return Math.max(PROTECT_MIN, Math.min(PROTECT_MAX, p));
}

export interface SourceDecisionInput extends SourceFeelings {
  seed: number | string;
  holder: EntityId;
  claimId: string;
  /** The holder's recorded origin for the belief; `witnessed` is a thing they saw themself. */
  origin: BeliefClaim["origin"];
  source: EntityId | undefined;
}

/**
 * What the houseguest does when asked. A belief they WITNESSED has no person behind it ("witnessed", names no one). Otherwise one bounded seeded
 * roll on `${seed}:claim-source`, keyed on the holder and the claim (so asking again gives the same answer): protect or name. A belief with no
 * recorded source and not witnessed cannot be answered: undefined.
 */
export function decideSourceAnswer(i: SourceDecisionInput): SourceAnswer | undefined {
  if (i.origin === "witnessed") return "witnessed";
  if (i.source === undefined) return undefined;
  const roll = new SeededRandom(hashSeed(`${i.seed}:claim-source:${i.holder}:${i.claimId}`)).next();
  return roll < protectChance(i) ? "protect" : "name";
}

/** The ONE engine-truth line the narrator is handed. Vault-free: no truth, no intent, no claim id, never "mistaken". */
export function sourceNote(answer: SourceAnswer, holderName: string, sourceName?: string): string {
  if (answer === "name" && sourceName) return `the player asked ${holderName} who told them that; ${holderName} names ${sourceName} (engine truth: voice exactly that, as ${holderName}'s own answer)`;
  if (answer === "slip") return `the player asked ${holderName} who told them that; ${holderName}'s account does not hold together as they answer: they stumble, contradict themself or go quiet, and it shows (engine truth: voice a visible stumble in ${holderName}'s own manner; name no one as the source; never say or hint outright that anything is untrue, and never explain it: what the player makes of it is theirs)`;
  if (answer === "protect") return `the player asked ${holderName} who told them that; ${holderName} will not say who (engine truth: voice the refusal, name no one)`;
  return `the player asked ${holderName} who told them that; ${holderName} saw it themself (engine truth: voice that, name no one as the source)`;
}

/** ORW-560: the player asked a houseguest who told them something the engine has no record of them saying to the player (the narration's own words). They name no one. */
export function noRecordNote(holderName: string): string {
  return `the player asked ${holderName} who told them that; the engine has no record of ${holderName} passing anything like it on (engine truth: ${holderName} names no one as a source, in their own words and manner; never invent who)`;
}

/** ORW-560: whether the player's words name this houseguest (full name, or first name as a whole word: "Cara" is not found in "Carla"). */
export function namedInText(text: string, fullName: string): boolean {
  const fold = (x: string): string => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const t = fold(String(text ?? ""));
  const names = [fullName, fullName.split(/\s+/)[0] ?? ""].map((n) => fold(n).trim()).filter((n) => n.length >= 2);
  const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return names.some((n) => new RegExp("(?<![a-z0-9])" + esc(n) + "(?![a-z0-9])").test(t));
}

/** What the player learns when a source is named: a told-by sentence, kept as something the houseguest said. */
export function namedSourceContent(holderName: string, sourceName: string, claimText: string): string {
  return `${holderName} said ${sourceName} told them that ${claimText}`;
}

/** The claim as a plain statement (what was said, never whether it is true). `playerName` is who "you" is in the claim. */
export function claimPhrase(c: Pick<SpokenClaim, "kind" | "subject" | "object" | "label">, nameOf: (id: EntityId) => string, playerName: string): string {
  const subj = nameOf(c.subject);
  const obj = c.object !== undefined ? nameOf(c.object) : undefined;
  switch (c.kind) {
    case "targets-you": return `${subj} is targeting ${playerName}`;
    case "voted-to-evict-you": return `${subj} voted to evict ${playerName}`;
    case "final-two-with": return `${subj} has a final two with ${obj}`;
    case "going-after": return `${subj} is going after ${obj}`;
    case "talking-about": return `${subj} has been talking about ${obj} behind their back`;
    case "voted-against": return `${subj} voted to evict ${obj}`;
    case "voted-to-keep": return `${subj} voted to keep ${obj}`;
    case "lying-about": return `${subj} is lying to ${obj ?? playerName}`;
    case "voted-against": return `${subj} voted to evict ${obj ?? playerName}`;
    case "voted-to-keep": return `${subj} voted to keep ${obj ?? playerName}`;
    case "has-reputation": return `the house has a name for ${subj}`; // Ryne 11-17: no role word is ever shown; the narrator words it from the claim
  }
}

/** The claims told TO the player by someone in `present`, newest first: the candidates for "who told you that?" (a claim not told to the player is never one). */
export function askableClaims(items: readonly SpokenClaim[] | undefined, present: ReadonlySet<EntityId>): SpokenClaim[] {
  return (items ?? []).filter((c) => c.listener === PLAYER && c.speaker !== PLAYER && present.has(c.speaker)).reverse();
}
