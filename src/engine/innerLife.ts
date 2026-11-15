/**
 * ORW-253 slice 4 core - MEMORY WITH CONTENT and MOOD WITH A CAUSE (theme 1, NPC minds; design approved by Ryne 2026-11-12, vault
 * "NPC Minds Design Theme 1", section 4).
 *
 *  1. `memoryLine` - one short engine sentence for each memory kind, in two forms: said TO the person it is about ("you left me on the
 *     block when you held the veto") and said ABOUT them to someone else ("{subject} left me on the block when they held the veto").
 *     `{subject}` is a placeholder the narrator seam fills with the public name; no names live in the engine text. With these, any
 *     houseguest can bring up what ANYONE did, not only what the player did (today only NPC-to-player memory is voiced).
 *  2. `appraiseGoal` - when a goal settles, the feeling it causes (an existing EmotionalEvent, so the soul's bounded arc is unchanged)
 *     and the CAUSE in engine terms ("my plan to get them out fell apart"). Mood stops being only event-to-number.
 *  3. `mayShareCause` - whether the houseguest would SAY why they feel that way to a given listener. Ryne's motive rule (2026-11-12):
 *     no hints point at a motive; the player infers from actions. Saying "I'm gutted my plan fell apart" is an action the houseguest
 *     chooses - so they say it only to people they trust, and an honest houseguest more readily than a guarded one. Everyone can still
 *     SEE the mood (tells); only the cause is guarded.
 *
 * Pure and deterministic. Vault-class (memories and causes are engine-side; only what a houseguest chooses to say reaches the narrator,
 * under that houseguest's name). Nothing calls this yet; slice 4 wiring stores lines on memories and feeds settled goals to the soul.
 */
import type { MemoryKind } from "./npcMemory";
import type { EmotionalEvent } from "./emotionalArc";
import type { Goal, GoalKind } from "./agenda";

// --- Memory sentences --------------------------------------------------------------------------------------------------------------

export interface MemoryLine { toThem: string; aboutThem: string }

const LINES: Readonly<Record<MemoryKind, MemoryLine>> = {
  "deal-broken": { toThem: "you broke the deal we made", aboutThem: "{subject} broke the deal we made" },
  "nominated-by-friend": { toThem: "you put me on the block when I thought we were close", aboutThem: "{subject} put me on the block when I thought we were close" },
  "replaced-by-friend": { toThem: "you named me the replacement when I trusted you", aboutThem: "{subject} named me the replacement when I trusted them" },
  "veto-saved": { toThem: "you used the veto on me", aboutThem: "{subject} used the veto on me" },
  "veto-withheld": { toThem: "you left me on the block when you held the veto", aboutThem: "{subject} left me on the block when they held the veto" },
  "deal-kept": { toThem: "you kept your word to me", aboutThem: "{subject} kept their word to me" },
  "scene-betrayal": { toThem: "you turned on me", aboutThem: "{subject} turned on me" },
  "scene-conflict": { toThem: "we had it out and it got ugly", aboutThem: "{subject} and I had it out and it got ugly" },
  "scene-kindness": { toThem: "you were good to me when I needed it", aboutThem: "{subject} was good to me when I needed it" },
  "secret-exposed": { toThem: "you told everyone what I trusted you with", aboutThem: "{subject} told everyone what I trusted them with" },
  "secret-given": { toThem: "you gave me something I needed to know", aboutThem: "{subject} gave me something I needed to know" },
  "nominated-by-hoh": { toThem: "you put me on the block", aboutThem: "{subject} put me on the block" },
  "deal-witnessed": { toThem: "I saw the deal you made", aboutThem: "I saw {subject} make a deal" },
  "deal-resented": { toThem: "I saw the deal you made behind my back", aboutThem: "{subject} made a deal behind my back" },
};

/** The sentence for a memory. Every memory kind has one (a new kind without a line fails the type check). */
export function memoryLine(kind: MemoryKind): MemoryLine {
  return LINES[kind];
}

/** Fill the `{subject}` placeholder at the narrator seam (the caller passes the PUBLIC name; the engine text never holds names). */
export function fillSubject(line: string, publicName: string): string {
  return line.split("{subject}").join(publicName);
}

// --- Mood with a cause -------------------------------------------------------------------------------------------------------------

export type CauseOutcome = "worked" | "fell-apart" | "gave-up" | "overtaken";
export interface MoodCause {
  goalKind: GoalKind;
  outcome: CauseOutcome;
  about?: string;
  /** Engine words, first person, with `{subject}` for the target when there is one. Vault-class until the houseguest chooses to say it. */
  line: string;
}
export interface Appraisal { event: EmotionalEvent | undefined; cause: MoodCause | undefined }

const WORKED: Partial<Record<GoalKind, [EmotionalEvent, string]>> = {
  "get-them-out": ["comp-win", "I got {subject} out, like I planned"],
  revenge: ["comp-win", "{subject} is gone, and I made sure of it"],
  "stay-safe": ["survived-vote", "I'm still here when they wanted me gone"],
  "pull-them-in": ["bond", "{subject} is with me now"],
  "keep-them-safe": ["survived-vote", "I kept {subject} safe"],
  "win-power": ["comp-win", "I finally have some power in this house"],
  "find-out": ["calm", "now I know what really happened"],
  "long-con": ["comp-win", "{subject} never saw it coming"],
  "reach-jury": ["survived-vote", "I made it to jury"],
  "prove-not-a-floater": ["comp-win", "nobody can call me a floater now"],
  "protect-my-person": ["bond", "{subject} made it to the end with me"],
};
const FELL_APART: Partial<Record<GoalKind, [EmotionalEvent, string]>> = {
  "get-them-out": ["comp-loss", "my plan to get {subject} out fell apart"],
  revenge: ["comp-loss", "{subject} is still here after what they did"],
  "pull-them-in": ["comp-loss", "{subject} wouldn't come over to my side"],
  "keep-them-safe": ["blindside", "I couldn't keep {subject} safe"],
  "win-power": ["comp-loss", "I needed that win and didn't get it"],
  "find-out": ["scheme", "I still don't know what really happened"],
  "long-con": ["betrayed", "my long game with {subject} blew up"],
  "keep-my-secret": ["blindside", "everyone knows my secret now"],
  "protect-my-person": ["blindside", "I lost {subject}"],
  "last-alliance-standing": ["betrayed", "my alliance didn't make it"],
};

/**
 * The feeling and cause when a goal settles. Only goals the holder cared about move their mood: a goal settled at low commitment
 * (below `minCommitment`) passes without a feeling. A "gave up" or "replaced" goal brings no event but keeps a quiet cause.
 */
export function appraiseGoal(g: Goal, minCommitment = 0.35): Appraisal {
  if (g.status === "active") return { event: undefined, cause: undefined };
  const about = g.target;
  const mk = (outcome: CauseOutcome, line: string): MoodCause => ({ goalKind: g.kind, outcome, line, ...(about !== undefined ? { about } : {}) });
  if (g.status === "dropped") return { event: undefined, cause: mk("gave-up", "I let go of something I wanted") };
  if (g.status === "replaced") return { event: undefined, cause: mk("overtaken", "something bigger came up") };
  if (g.commitment < minCommitment) return { event: undefined, cause: undefined };
  const table = g.status === "achieved" ? WORKED : g.status === "failed" ? FELL_APART : undefined;
  const hit = table?.[g.kind];
  if (!hit) return { event: undefined, cause: undefined };
  return { event: hit[0], cause: mk(g.status === "achieved" ? "worked" : "fell-apart", hit[1]) };
}

/**
 * Whether the houseguest would SAY the cause to this listener (the mood itself is visible to all through tells). Closeness and candor
 * both count; a cause that reveals a plan or a grudge (get-them-out, revenge, long-con, keep-my-secret) needs more of both.
 */
export function mayShareCause(cause: MoodCause, listenerAffinity: number, candor: number): boolean {
  const revealing = cause.goalKind === "get-them-out" || cause.goalKind === "revenge" || cause.goalKind === "long-con" || cause.goalKind === "keep-my-secret";
  const bar = revealing ? 1.25 : 0.9;
  return listenerAffinity + candor >= bar;
}
