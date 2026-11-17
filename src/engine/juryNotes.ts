import type { EntityId } from "../domain/ids";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { claimsOf, type BeliefStore, type ClaimKind } from "./beliefStore";
import { JURY_LIFE } from "./juryHouseConstants";

/**
 * ORW-618 (0189) - jurors COMPARE NOTES. Pure and engine-only: no I/O, no Vault handle, no text. It plans which belief one juror passes to another over a stretch;
 * the caller writes the listener's belief and moves their feeling. What a juror can pass on is only what they themselves hold (their own played-game knowledge),
 * never the truth, and never anything that came from the sealed ballot: a belief about who voted against whom, a vote the holder deduced, or a vote promise is
 * not shareable at all (E12: per-voter attribution unseals only in the retrospective).
 */

export interface JuryNoteShare {
  from: EntityId;
  to: EntityId;
  /** The belief kind the listener comes to hold. */
  kind: ClaimKind;
  subject: EntityId;
  object?: EntityId;
  nature?: string;
  confidence: number;
  /** The teller's belief this came from. */
  sourceId: string;
  /** True when what was passed on is an adverse read of the subject (it moves the listener's trust). */
  adverse: boolean;
}

const RUMOR_NATURES = new Set(["going-after", "talking-about", "lying"]);

/** What a belief becomes when its holder passes it on, or undefined when it may not be shared (a sealed-ballot read, a deduction, a belief about the listener). */
export function shareable(
  b: { kind: ClaimKind; subject: EntityId; object?: EntityId; nature?: string; origin: string; value: boolean; refuted?: boolean; confidence: number },
  teller: EntityId, listener: EntityId,
): Pick<JuryNoteShare, "kind" | "subject" | "object" | "nature" | "adverse"> | undefined {
  if (b.refuted || !b.value || b.origin === "deduced" || b.confidence < JURY_LIFE.minConfidence) return undefined;
  if (b.subject === listener || b.subject === teller) return undefined;
  switch (b.kind) {
    case "lied-to-me": return { kind: "lied-to-me", subject: b.subject, adverse: true };
    case "targets-me": return { kind: "heard-rumor", subject: b.subject, object: teller, nature: "going-after", adverse: true };
    case "allied-with": return b.object && b.object !== listener ? { kind: "allied-with", subject: b.subject, object: b.object, adverse: false } : undefined;
    case "heard-rumor":
      if (!b.object || b.object === b.subject || !b.nature || !RUMOR_NATURES.has(b.nature)) return undefined;
      return { kind: "heard-rumor", subject: b.subject, object: b.object, nature: b.nature, adverse: b.nature !== "talking-about" };
    default: return undefined; // voted-against-me, assured-me, will-vote, holds-power: the sealed ballot and vote promises are never passed on
  }
}

export interface JuryNotesDeps {
  /** In a stable order. Never the player. */
  jurors: readonly EntityId[];
  beliefs: BeliefStore | undefined;
  /** Whether two jurors spend time together (the jury-house graph edge). */
  talks: (a: EntityId, b: EntityId) => boolean;
  /** The teller's openness toward a subject: a multiplier near 1 (the ORW-582 personality read; keepers low, easygoing high). */
  opennessOf: (teller: EntityId, subject: EntityId) => number;
  rng: RandomnessSource;
}

/**
 * Plan this stretch's note-sharing. Exactly one roll is drawn per ordered pair that talks, whether or not anything is passed on, so the stream is
 * stable. A teller passes the most confident thing they hold that the listener does not already hold; at most `maxSharesPerStretch` land.
 */
export function planJuryNotes(deps: JuryNotesDeps): JuryNoteShare[] {
  const out: JuryNoteShare[] = [];
  const { jurors, beliefs, rng } = deps;
  for (const teller of jurors) {
    for (const listener of jurors) {
      if (teller === listener || !deps.talks(teller, listener)) continue;
      const roll = rng.next();
      if (out.length >= JURY_LIFE.maxSharesPerStretch) continue;
      const held = claimsOf(beliefs, listener);
      let best: { share: ReturnType<typeof shareable> & object; id: string; confidence: number } | undefined;
      for (const b of claimsOf(beliefs, teller)) {
        const s = shareable(b, teller, listener);
        if (!s) continue;
        if (held.some((h) => !h.refuted && h.kind === s.kind && h.subject === s.subject && (h.object ?? null) === (s.object ?? null) && (h.nature ?? null) === (s.nature ?? null))) continue;
        if (out.some((o) => o.to === listener && o.kind === s.kind && o.subject === s.subject && (o.object ?? null) === (s.object ?? null))) continue;
        if (!best || b.confidence > best.confidence) best = { share: s, id: b.id, confidence: b.confidence };
      }
      if (!best) continue;
      const p = Math.min(1, JURY_LIFE.shareProb * Math.max(0, deps.opennessOf(teller, best.share.subject)));
      if (roll >= p) continue;
      out.push({ from: teller, to: listener, ...best.share, confidence: best.confidence * JURY_LIFE.retellDecay, sourceId: best.id });
    }
  }
  return out;
}
