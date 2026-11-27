import { PLAYER, type EntityId } from "../domain/ids";
import { claimsOf, type BeliefClaim, type BeliefStore } from "./beliefStore";
import { ROLES } from "./socialRoles";
import { labelOfNature, type ClaimInput, type ClaimIntent, type SpokenClaimKind } from "./spokenClaims";

/**
 * Feature 0153 / ORW-330 (theme 2, slice 3) - NPCs SPREAD AND LIE ON PURPOSE. The house-life speech actions that were only labels
 * become real claims (0149) the ENGINE decides, checked against the engine's own truth:
 *  - PLANT: a lie told to someone about the planter's target (a damaging thing the planter BELIEVES instead, when they are being truthful; ORW-588);
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
  /** `voter` cast a ballot at a recorded eviction where `nominee` faced the vote, and it was NOT a vote to evict them. */
  votedToKeep(voter: EntityId, nominee: EntityId): boolean;
  /** `a` and `b` hold a final-two deal. */
  finalTwo(a: EntityId, b: EntityId): boolean;
  /** `a` has told `b` a claim the engine knows was false. */
  liedTo(a: EntityId, b: EntityId): boolean;
  /** `a` has told anyone a claim about `b` (they have been talking about them). */
  talkedAbout(a: EntityId, b: EntityId): boolean;
  /** 0184 part 2a: the role the engine reads in `who` from the whole record (every scene, as if seen); undefined = none. Absent = no reputation claim is true. */
  roleOf?(who: EntityId): string | undefined;
}

/** Is this claim TRUE by the engine's records? (`listener` is who it is told to; "you" in a kind means the listener.) */
export function truthOf(c: Pick<ClaimInput, "kind" | "listener" | "subject" | "object" | "label">, f: TruthFacts): boolean {
  switch (c.kind) {
    case "has-reputation": return c.label !== undefined && f.roleOf?.(c.subject) === c.label;
    case "targets-you": return f.goalAgainst(c.subject, c.listener);
    case "voted-to-evict-you": return f.votedToEvict(c.subject, c.listener);
    case "final-two-with": return c.object !== undefined && f.finalTwo(c.subject, c.object);
    case "going-after": return c.object !== undefined && f.goalAgainst(c.subject, c.object);
    case "talking-about": return c.object !== undefined && f.talkedAbout(c.subject, c.object);
    case "lying-about": return f.liedTo(c.subject, c.object ?? c.listener);
    case "voted-against": return c.object !== undefined && f.votedToEvict(c.subject, c.object);
    case "voted-to-keep": return c.object !== undefined && f.votedToKeep(c.subject, c.object);
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
  /** 0184 part 2a: the role `holder` reads in `subject` (`socialRoles`), or undefined. Absent = no role is ever said (byte-identical). */
  roleOf?: (holder: EntityId, subject: EntityId) => string | undefined;
}

/** What a speaker can say from one of their beliefs (the belief re-phrased as a claim to `listener`), or undefined when the belief has no claim form. */
export function claimFromBelief(b: BeliefClaim, speaker: EntityId, listener: EntityId): Pick<ClaimInput, "kind" | "subject" | "object" | "label"> | undefined {
  if (!b.value || b.refuted || b.subject === listener || b.subject === speaker) return undefined;
  switch (b.kind) {
    case "targets-me": return { kind: "going-after", subject: b.subject, object: speaker };            // "X is after me"
    case "lied-to-me": return { kind: "lying-about", subject: b.subject, object: speaker };            // "X lied to me"
    case "voted-against-me": return { kind: "voted-against", subject: b.subject, object: speaker };    // "X voted to evict me"
    case "allied-with": return b.object !== undefined && b.object !== b.subject ? { kind: "final-two-with", subject: b.subject, object: b.object } : undefined;
    case "heard-rumor": {
      const label = labelOfNature(b.nature); // 0184 part 2a: a heard reputation is passed on as one
      if (label !== undefined) return { kind: "has-reputation", subject: b.subject, label };
      if (b.object === undefined || b.object === b.subject) return undefined;
      if (b.nature === "going-after") return { kind: "going-after", subject: b.subject, object: b.object };
      if (b.nature === "lying") return { kind: "lying-about", subject: b.subject, object: b.object };
      if (b.nature === "talking-about") return { kind: "talking-about", subject: b.subject, object: b.object };
      if (b.nature === "voted-against") return { kind: "voted-against", subject: b.subject, object: b.object };
      return undefined;
    }
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
  const roleLeak = (speaker: EntityId = actor, listener: EntityId = partner): ClaimInput | undefined => {
    if (!ctx.roleOf) return undefined;
    const pool = about !== undefined ? [about] : [...ctx.living].sort();
    const start = pool.length ? Math.floor(ctx.roll * pool.length) % pool.length : 0;
    for (let i = 0; i < pool.length; i++) {
      const who = pool[(start + i) % pool.length]!;
      if (who === speaker || !inHouse(who)) continue;
      const label = ctx.roleOf(speaker, who);
      if (label === undefined) continue;
      const claim = { speaker, listener, kind: "has-reputation" as const, subject: who, label };
      return { ...claim, isTrue: truthOf(claim, ctx.facts), intent: "inform" };
    }
    return undefined;
  };
  switch (action) {
    case "plant": {
      if (!inHouse(about) || about === partner || about === actor) return undefined;
      // ORW-588 (Fable T2): the planter chooses from what THEY hold, never from the engine's truth. A truthful plant passes on a damaging thing they BELIEVE about
      // the target (nothing believed: nothing said); an untruthful plant tells a damaging story they do NOT hold. The engine then judges the claim's truth for
      // the record (a lie can turn out true by accident) - it never steers which claim is chosen, so no speaker voices a secret they never learned.
      if (truthful) return fromBeliefs(actor, partner, "warn");
      const held = new Set(claimsOf(ctx.beliefs, actor).filter((b) => b.value && !b.refuted && b.subject === about)
        .map((b) => claimFromBelief(b, actor, partner)).filter((c): c is NonNullable<typeof c> => c !== undefined).map((c) => `${c.kind}|${c.object ?? ""}`));
      const start = Math.floor(ctx.roll * PLANT_KINDS.length) % PLANT_KINDS.length;
      for (let i = 0; i < PLANT_KINDS.length; i++) {
        const kind = PLANT_KINDS[(start + i) % PLANT_KINDS.length]!;
        const object = kind === "talking-about" ? partner : undefined; // "they've been talking about you"
        if (held.has(`${kind === "targets-you" ? "going-after" : kind}|${kind === "targets-you" ? actor : object ?? ""}`)) continue; // they believe this one: it would not be a lie
        const claim = { speaker: actor, listener: partner, kind, subject: about!, ...(object ? { object } : {}) };
        return { ...claim, isTrue: truthOf(claim, ctx.facts), intent: "mislead" };
      }
      return undefined;
    }
    case "leak": return fromBeliefs(actor, partner, "inform"); // 0153: a leak passes on only what the speaker holds (never a role read)
    case "confirm": {
      // back up what the LISTENER already believes about the target: the speaker re-tells the listener's own belief as theirs
      const theirs = about === undefined ? undefined : claimsOf(ctx.beliefs, partner).find((b) => b.subject === about && b.value && !b.refuted);
      if (!theirs) return undefined;
      const c = claimFromBelief(theirs, partner, partner);
      if (!c) return undefined;
      const claim = { speaker: actor, listener: partner, ...c };
      return { ...claim, isTrue: truthOf(claim, ctx.facts), intent: "recruit" };
    }
    case "fish": { // the listener answers the asker with what THEY believe - or, a share of the time, with their read of someone's role (0184 part 2a)
      // ORW-1105: a houseguest fishing the PLAYER asks; the engine never answers for them (ORW-610). Their answer is their own words.
      if (partner === PLAYER) return undefined;
      const role = roleLeak(partner, actor);
      if (role && (ctx.roll * 7919) % 1 < ROLES.voiceShare) return role;
      return fromBeliefs(partner, actor, "inform") ?? role;
    }
  }
}

/** 0160: is what `holder` believes TRUE by the engine's records? (The belief read as the claim it stands for, told to the holder.) Unknown kinds read false. */
export function beliefTruth(b: BeliefClaim, holder: EntityId, f: TruthFacts): boolean {
  switch (b.kind) {
    case "targets-me": return f.goalAgainst(b.subject, holder);
    case "voted-against-me": return f.votedToEvict(b.subject, holder);
    case "lied-to-me": return f.liedTo(b.subject, holder);
    case "allied-with": return b.object !== undefined && f.finalTwo(b.subject, b.object);
    case "heard-rumor":
      if (b.object === undefined) return false;
      if (b.nature === "going-after") return f.goalAgainst(b.subject, b.object);
      if (b.nature === "voted-against") return f.votedToEvict(b.subject, b.object);
      if (b.nature === "voted-to-keep") return f.votedToKeep(b.subject, b.object);
      if (b.nature === "lying") return f.liedTo(b.subject, b.object);
      if (b.nature === "talking-about") return f.talkedAbout(b.subject, b.object);
      return false;
    default: return false;
  }
}
