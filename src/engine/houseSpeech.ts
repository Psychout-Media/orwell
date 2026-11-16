import type { EntityId } from "../domain/ids";
import { claimsOf, type BeliefClaim, type BeliefStore } from "./beliefStore";
import type { ClaimInput, ClaimIntent, SpokenClaimKind } from "./spokenClaims";

/**
 * Feature 0153 / ORW-330 (theme 2, slice 3) - NPCs SPREAD AND LIE ON PURPOSE. The house-life speech actions that were only labels
 * become real claims (0149) the ENGINE decides, checked against the engine's own truth:
 *  - PLANT: a lie told to someone about the planter's target (a true damaging claim instead, when the planter is being truthful and one exists);
 *  - LEAK: passing on something the speaker BELIEVES about a third houseguest (true or not as the belief happens to be; nothing if they hold no belief);
 *  - CONFIRM: backing up what the listener already believes about someone;
 *  - FISH: asking what someone knows - the LISTENER answers with one of their own beliefs (the claim runs listener -> asker).
 * Pure rules: no I/O, no rng of its own (the caller passes a seeded roll). ENGINE-ONLY.
 */

/** The engine's truth, read from its own records. Each answer is a fact the engine holds, never a belief. */
export interface TruthFacts {
  /** `who` holds an active goal to get `target` out (get-them-out, revenge, or a long con past its stage). */
  goalAgainst(who: EntityId, target: EntityId): boolean;
  /** `voter` voted to evict `evictee` at a recorded eviction. */
  votedToEvict(voter: EntityId, evictee: EntityId): boolean;
  /** `a` and `b` hold a final-two deal. */
  finalTwo(a: EntityId, b: EntityId): boolean;
  /** `a` has told `b` a claim the engine knows was false. */
  liedTo(a: EntityId, b: EntityId): boolean;
  /** `a` has told anyone a claim about `b` (they have been talking about them). */
  talkedAbout(a: EntityId, b: EntityId): boolean;
}

/** Is this claim TRUE by the engine's records? (`listener` is who it is told to; "you" in a kind means the listener.) */
export function truthOf(c: Pick<ClaimInput, "kind" | "listener" | "subject" | "object">, f: TruthFacts): boolean {
  switch (c.kind) {
    case "targets-you": return f.goalAgainst(c.subject, c.listener);
    case "voted-to-evict-you": return f.votedToEvict(c.subject, c.listener);
    case "final-two-with": return c.object !== undefined && f.finalTwo(c.subject, c.object);
    case "going-after": return c.object !== undefined && f.goalAgainst(c.subject, c.object);
    case "talking-about": return c.object !== undefined && f.talkedAbout(c.subject, c.object);
    case "lying-about": return f.liedTo(c.subject, c.object ?? c.listener);
    case "voted-against": return c.object !== undefined && f.votedToEvict(c.subject, c.object);
  }
}

export type SpeechAction = "plant" | "leak" | "confirm" | "fish";
/** Which house-life actions SAY something, and as what: a campaign's "flip a vote" and a "frame" are plants too (a story told to a voter about the target - the misinformation campaign). */
const SPEECH_OF: Readonly<Record<string, SpeechAction>> = { plant: "plant", "flip-a-vote": "plant", frame: "plant", leak: "leak", confirm: "confirm", fish: "fish" };
export function speechActionOf(kind: string): SpeechAction | undefined { return SPEECH_OF[kind]; }

export interface SpeechContext {
  living: readonly EntityId[];
  beliefs: BeliefStore | undefined;
  facts: TruthFacts;
  /** A seeded roll in [0,1) from the caller's own side stream (picks among equally good options). */
  roll: number;
}

/** What a speaker can say from one of their beliefs (the belief re-phrased as a claim to `listener`), or undefined when the belief has no claim form. */
export function claimFromBelief(b: BeliefClaim, speaker: EntityId, listener: EntityId): Pick<ClaimInput, "kind" | "subject" | "object"> | undefined {
  if (!b.value || b.refuted || b.subject === listener || b.subject === speaker) return undefined;
  switch (b.kind) {
    case "targets-me": return { kind: "going-after", subject: b.subject, object: speaker };            // "X is after me"
    case "lied-to-me": return { kind: "lying-about", subject: b.subject, object: speaker };            // "X lied to me"
    case "voted-against-me": return { kind: "voted-against", subject: b.subject, object: speaker };    // "X voted to evict me"
    case "allied-with": return b.object !== undefined && b.object !== b.subject ? { kind: "final-two-with", subject: b.subject, object: b.object } : undefined;
    case "heard-rumor":
      if (b.object === undefined || b.object === b.subject) return undefined;
      if (b.nature === "going-after") return { kind: "going-after", subject: b.subject, object: b.object };
      if (b.nature === "lying") return { kind: "lying-about", subject: b.subject, object: b.object };
      if (b.nature === "talking-about") return { kind: "talking-about", subject: b.subject, object: b.object };
      if (b.nature === "voted-against") return { kind: "voted-against", subject: b.subject, object: b.object };
      return undefined;
    default: return undefined;
  }
}

/** The lies a planter can tell `listener` about `target`, in the order tried (the roll rotates the start so planters vary). */
const PLANT_KINDS: readonly SpokenClaimKind[] = ["targets-you", "lying-about", "talking-about"]; // vote lies are slice 5 ("lying about your vote")

/**
 * The claim one speech action makes, or undefined when it makes none. `truthful` is the house-life roll for this action (the speaker's
 * candor against the scheming boost): a truthful PLANT tells a TRUE damaging claim if one exists, an untruthful one a FALSE claim.
 */
export function planSpeech(action: SpeechAction, actor: EntityId, partner: EntityId, about: EntityId | undefined, truthful: boolean, ctx: SpeechContext): ClaimInput | undefined {
  const inHouse = (id: EntityId | undefined) => id !== undefined && ctx.living.includes(id);
  if (!inHouse(actor) || !inHouse(partner) || actor === partner) return undefined;
  const fromBeliefs = (holder: EntityId, listener: EntityId, intent: ClaimIntent): ClaimInput | undefined => {
    const options = claimsOf(ctx.beliefs, holder)
      .filter((b) => about === undefined || b.subject === about)
      .map((b) => ({ b, c: claimFromBelief(b, holder, listener) }))
      .filter((x): x is { b: BeliefClaim; c: NonNullable<ReturnType<typeof claimFromBelief>> } => x.c !== undefined && inHouse(x.c.subject) && (x.c.object === undefined || inHouse(x.c.object)))
      .sort((x, y) => y.b.confidence - x.b.confidence || x.b.id.localeCompare(y.b.id));
    const top = options[0];
    if (!top) return undefined;
    const claim = { speaker: holder, listener, ...top.c };
    return { ...claim, isTrue: truthOf(claim, ctx.facts), intent };
  };
  switch (action) {
    case "plant": {
      if (!inHouse(about) || about === partner || about === actor) return undefined;
      const start = Math.floor(ctx.roll * PLANT_KINDS.length) % PLANT_KINDS.length;
      for (let i = 0; i < PLANT_KINDS.length; i++) {
        const kind = PLANT_KINDS[(start + i) % PLANT_KINDS.length]!;
        const object = kind === "talking-about" ? partner : undefined; // "they've been talking about you"
        const claim = { speaker: actor, listener: partner, kind, subject: about!, ...(object ? { object } : {}) };
        const isTrue = truthOf(claim, ctx.facts);
        if (isTrue === truthful) return { ...claim, isTrue, intent: truthful ? "warn" : "mislead" };
      }
      return undefined; // a truthful planter with nothing true to say says nothing damaging
    }
    case "leak": return fromBeliefs(actor, partner, "inform");
    case "confirm": {
      // back up what the LISTENER already believes about the target: the speaker re-tells the listener's own belief as theirs
      const theirs = about === undefined ? undefined : claimsOf(ctx.beliefs, partner).find((b) => b.subject === about && b.value && !b.refuted);
      if (!theirs) return undefined;
      const c = claimFromBelief(theirs, partner, partner);
      if (!c) return undefined;
      const claim = { speaker: actor, listener: partner, ...c };
      return { ...claim, isTrue: truthOf(claim, ctx.facts), intent: "recruit" };
    }
    case "fish": return fromBeliefs(partner, actor, "inform"); // the listener answers the asker with what THEY believe
  }
}
