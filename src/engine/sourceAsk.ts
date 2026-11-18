import type { EntityId } from "../domain/ids";
import { PLAYER } from "../domain/ids";
import { clamp01 } from "../domain/num";
import { SeededRandom } from "../adapters/random/SeededRandom";
import { hashSeed } from "./characterFactory";
import { COVER, namedInText } from "./claimSource";
import type { SpokenClaim, SpokenClaimKind } from "./spokenClaims";

/**
 * ORW-687 (0151/0152 parity, the mirror of ORW-685's cover slip) - A HOUSEGUEST ASKS THE PLAYER "who told you that?". When the player passes a claim on to a houseguest, that houseguest may ask where the player
 * got it. The question is an OPEN approach: the player answers in their own words (or ignores it); the engine never answers for the player. The engine already knows who REALLY told the player (the claim log's
 * told-to-the-player lineage), so the asker's read of the answer is a plain structural comparison with that record - the player's reply is never rolled for. No hidden player stat is invented: the only
 * inputs are who the engine recorded as the teller and which houseguests the player named.
 *
 * Pure rules, no I/O. The one random draw (whether they ask) is a bounded roll on its OWN keyed side stream (`${seed}:asks-source`), so no other seeded roll moves. ENGINE-ONLY inputs; nothing here
 * reaches a narrator except the closed `AnswerRead` word.
 */

/** Whether a houseguest asks: the less they trust the player the likelier, always inside a band, never certain either way. */
export const ASK = { base: 0.25, trustWeight: 0.5, min: 0.05, max: 0.6, dodgeShare: 0.5, matchShare: 0.5 } as const;

export type AnswerRead = "matches" | "dodged" | "contradicted";

/** One open question, append-only: `read` is set once (never cleared, never re-folded). `source` is the engine's own record of who told the player (engine-only; never projected). */
export interface SourceAsk { claimId: string; asker: EntityId; week: number; source: EntityId; read?: AnswerRead }

const YOU_KINDS: Partial<Record<SpokenClaimKind, SpokenClaimKind>> = { "targets-you": "going-after", "voted-to-evict-you": "voted-against" };

/** Is `told` (a claim the player was told) the same story as `passed` (the claim the player passed on)? Same kind (a "you" kind and its third-party form count as one) and subject; objects must agree where both are real. */
export function sameStory(told: Pick<SpokenClaim, "kind" | "subject" | "object">, passed: Pick<SpokenClaim, "kind" | "subject" | "object">): boolean {
  const norm = (k: SpokenClaimKind): SpokenClaimKind => YOU_KINDS[k] ?? k;
  if (norm(told.kind) !== norm(passed.kind) || told.subject !== passed.subject) return false;
  const youForm = YOU_KINDS[told.kind] !== undefined || YOU_KINDS[passed.kind] !== undefined;
  return youForm || told.object === undefined || passed.object === undefined || told.object === passed.object;
}

/** Who the engine recorded as having told the player this story: the newest earlier claim told TO the player with the same story, by a houseguest. Undefined when no recorded teller (nothing to compare against). */
export function trueSourceOf(items: readonly SpokenClaim[] | undefined, passed: SpokenClaim): EntityId | undefined {
  const all = items ?? [];
  const at = all.findIndex((c) => c.id === passed.id);
  const before = at < 0 ? all : all.slice(0, at);
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i]!;
    if (c.listener === PLAYER && c.speaker !== PLAYER && sameStory(c, passed)) return c.speaker;
  }
  return undefined;
}

/** The chance the asker asks: down in trust in the player, inside the band. */
export function askChance(trustInPlayer: number): number {
  return Math.max(ASK.min, Math.min(ASK.max, ASK.base + ASK.trustWeight * (0.5 - clamp01(trustInPlayer))));
}

/** Does this houseguest ask about this claim? One draw on its own keyed side stream, so the same claim always gives the same answer. */
export function decideAsk(seed: number | string, asker: EntityId, claimId: string, trustInPlayer: number): boolean {
  return new SeededRandom(hashSeed(`${seed}:asks-source:${asker}:${claimId}`)).next() < askChance(trustInPlayer);
}

/** Does the player's reply decline to name anyone (will not say, no one told them, saw or worked it out themself)? A parse of their own words; a roster name always wins over it. */
export function parseSourceDodge(text: string): boolean {
  const t = String(text ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");
  if (t.length === 0 || t.length > 600) return false;
  return [
    /\b(?:won't|wont|not going to|am not going to|i'm not gonna|not gonna|can't|cant|rather not|prefer not to|would rather not)\s+(?:to\s+)?(?:say|tell|name|share|go into|get into)\b/,
    /\b(?:keeping|keep)\s+(?:that|it|this|them)\s+to myself\b/,
    /\b(?:nobody|no one|no-one|not anyone)\s+(?:told|said|had to tell)\b/,
    /\b(?:saw|heard|seen|worked out|figured|picked)\b[^.?!]{0,30}\b(?:myself|on my own|with my own)\b/,
    /\bmy own (?:eyes|ears|read|gut)\b/,
    /\bjust (?:know|heard|picked it up)\b/,
    /\bit doesn't matter who\b/,
  ].some((re) => re.test(t));
}

/** Which houseguests (other than the asker) the player's reply names, validated against the roster given. */
export function namedSources(text: string, roster: ReadonlyArray<{ id: EntityId; name: string }>, asker: EntityId): EntityId[] {
  return roster.filter((r) => r.id !== asker && namedInText(text, r.name)).map((r) => r.id);
}

/**
 * The asker's read of the player's answer against the engine's own record. Names exactly the real teller: `matches`. Names one other houseguest (and not the real teller): `contradicted`. Names no one but
 * says plainly they will not say / saw it themself: `dodged`. Anything else (no sign it was an answer, or several names with the real teller among them) is `undefined`: nothing is read and nothing folds.
 */
export function readAnswer(source: EntityId, named: readonly EntityId[], declined: boolean): AnswerRead | undefined {
  const uniq = [...new Set(named)];
  if (uniq.length === 0) return declined ? "dodged" : undefined;
  if (uniq.length === 1) return uniq[0] === source ? "matches" : "contradicted";
  return undefined;
}

/** The bounded step on the asker's read of the player, in the existing cover-slip scale (`COVER.foldScale`): a plain true answer a small warm step, a dodge half the cover-slip step, a false name the full step. */
export function answerFold(read: AnswerRead): { type: "bonding" | "conflict"; scale: number } {
  if (read === "matches") return { type: "bonding", scale: COVER.foldScale * ASK.matchShare };
  if (read === "dodged") return { type: "conflict", scale: COVER.foldScale * ASK.dodgeShare };
  return { type: "conflict", scale: COVER.foldScale };
}

/** Append-only: every earlier question is still there, and a question once read keeps its read. */
export function sourceAsksSuperset(later: readonly SourceAsk[] | undefined, earlier: readonly SourceAsk[] | undefined): boolean {
  const now = new Map((later ?? []).map((a) => [a.claimId, a] as const));
  return (earlier ?? []).every((a) => { const b = now.get(a.claimId); return b !== undefined && b.asker === a.asker && b.source === a.source && (a.read === undefined || b.read === a.read); });
}
