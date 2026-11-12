/**
 * ORW-253 slice 2 core (theme 1, NPC minds; design approved by Ryne 2026-11-12, vault "NPC Minds Design Theme 1", section 3).
 *
 * Two pure pieces the decision functions and the narrator seam use:
 *  1. `goalPull` - how much a houseguest's AGENDA pushes them to act against (or to protect) one candidate. FULL STRENGTH: Ryne,
 *     2026-11-12, answer 1 - goals count as much as the houseguest's read on who's a threat. So the pull is on the same 0..1 scale as
 *     a threat read and is NOT capped small like the older tilts (campaign 0.25, memory 0.15, belief 0.18).
 *  2. `explainDecision` - from the REAL reason (which goal, which terms), the reason the houseguest gives OUT LOUD: the truth, part of
 *     it, or a cover story, decided by the engine from their character and how secret the real reason is. The engine knows when the
 *     stated reason is a lie. Only `{ kind, about }` of the stated reason may reach the narrator (under that houseguest's name); the
 *     real reason and the `candor` flag are Vault-class (Ryne's motive rule: no hints point at a motive; the player infers from actions
 *     and words, and the full truth comes out only in the season retrospective).
 *
 * Pure and deterministic (a local hash, no shared rng). Nothing calls this yet; the overseer half of slice 2 wires `goalPull` into the
 * nomination, replacement, veto and vote reads and hands the stated reason to the narrator.
 */
import type { EntityId } from "../domain/ids";
import { clamp01 } from "../domain/num";
import type { Agenda, AgendaBoard, AgendaCharacter, GoalKind } from "./agenda";
import { agendaRoll } from "./agenda";
import { REASONS } from "./agendaConstants";

/** Which way a decision cuts against a candidate: nominate / vote to evict / final-HOH eviction are "against"; a veto save is "for". */
export type DecisionKind = "nominate" | "replacement" | "veto" | "vote" | "final-hoh-evict" | "deal-consent";

export interface GoalPull {
  /** Signed: positive = the agenda wants this candidate OUT; negative = it wants them kept. Same scale as a threat read. */
  value: number;
  /** The goal that pulled hardest (for the real reason), if any. */
  goalId?: string;
  goalKind?: GoalKind;
}

/**
 * How the holder's agenda pulls on `candidate`. `mates` is the holder's alliance mates now (a "last alliance standing" aim protects them).
 * Long con: before its stage the mark is KEPT close (negative); once the stage is reached, the mark is CUT (positive) - the con pays off.
 */
export function goalPull(agenda: Agenda | undefined, candidate: EntityId, board: AgendaBoard, mates: readonly EntityId[] = []): GoalPull {
  if (!agenda || candidate === agenda.owner) return { value: 0 };
  let value = 0;
  let best: { abs: number; id: string; kind: GoalKind } | undefined;
  const note = (v: number, id: string, kind: GoalKind): void => {
    value += v;
    if (!best || Math.abs(v) > best.abs) best = { abs: Math.abs(v), id, kind };
  };
  for (const g of agenda.goals) {
    if (g.status !== "active") continue;
    const w = g.commitment * REASONS.goalWeight;
    if (g.target === candidate) {
      switch (g.kind) {
        case "get-them-out": case "revenge": note(w, g.id, g.kind); break;
        case "keep-them-safe": case "protect-my-person": note(-w, g.id, g.kind); break;
        case "pull-them-in": note(-w * REASONS.recruitShield, g.id, g.kind); break;
        case "long-con": {
          const stageReached = g.test.kind === "cut-later" && (g.test.stage === "jury" ? board.juryStarted : board.finalFive);
          note(stageReached ? w : -w * REASONS.recruitShield, g.id, g.kind);
          break;
        }
        default: break;
      }
    }
    if (g.kind === "last-alliance-standing" && mates.includes(candidate)) note(-w * REASONS.allianceShield, g.id, g.kind);
  }
  return best ? { value, goalId: best.id, goalKind: best.kind } : { value };
}

// --- Reasons -------------------------------------------------------------------------------------------------------------------------

/** One named input to a decision and how much it counted (the decision functions already compute these; ORW-305 records them). */
export interface DecisionTerm { name: "threat" | "goal" | "memory" | "bond" | "alliance" | "deal" | "campaign" | "mood" | "belief" | "pitch" | "style"; value: number }

/** The REAL reason (Vault-class): what was decided, the goal it served, the terms, the tactic. */
export interface RealReason {
  decision: DecisionKind;
  decider: EntityId;
  choice: EntityId;
  goalKind?: GoalKind;
  goalId?: string;
  terms: DecisionTerm[];
  tactic?: "direct" | "pawn" | "backdoor";
}

/** What a houseguest SAYS their reason was. A closed set the narrator voices in the houseguest's own words. */
export type StatedReasonKind =
  | "biggest-threat"      // "you're the biggest threat in this house"
  | "came-after-me"       // "you came after me first"
  | "loyal-to-my-side"    // "I had to protect my people"
  | "pawn-youll-be-fine"  // "you're a pawn, you'll be fine"
  | "kept-my-word"        // "I made a promise and I kept it"
  | "didnt-trust-you"     // "I never knew where you stood"
  | "had-it-planned"      // "this was always the plan"
  | "nothing-personal"    // "it's purely strategic, nothing personal"
  | "house-wants-it";     // "it's what the house wanted"
export type Candor = "truth" | "part-truth" | "cover";
export interface StatedReason { kind: StatedReasonKind; about: EntityId; /** VAULT-CLASS: whether the stated reason is honest. Never sent to the narrator. */ candor: Candor }

/** The honest way to say the real reason. */
export function truthfulKind(real: RealReason): StatedReasonKind {
  if (real.tactic === "pawn") return "pawn-youll-be-fine";
  switch (real.goalKind) {
    case "revenge": return "came-after-me";
    case "long-con": return "had-it-planned";
    case "keep-them-safe": case "protect-my-person": case "last-alliance-standing": return "loyal-to-my-side";
    default: break;
  }
  const top = [...real.terms].sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.name.localeCompare(b.name))[0];
  switch (top?.name) {
    case "memory": return "came-after-me";
    case "alliance": case "bond": return "loyal-to-my-side";
    case "deal": return "kept-my-word";
    case "belief": return "didnt-trust-you";
    case "campaign": case "pitch": return "house-wants-it";
    default: return "biggest-threat";
  }
}

/** Reasons a houseguest would rather not admit (they reveal a plan, a grudge or a secret). */
const SECRETIVE: ReadonlySet<StatedReasonKind> = new Set(["had-it-planned", "came-after-me"]);
/** The softer, partly-true version of each honest reason (drops the personal or plotting part). */
const PART_TRUTH: Readonly<Record<StatedReasonKind, StatedReasonKind>> = {
  "came-after-me": "biggest-threat", "had-it-planned": "biggest-threat", "loyal-to-my-side": "nothing-personal",
  "pawn-youll-be-fine": "pawn-youll-be-fine", "kept-my-word": "kept-my-word", "didnt-trust-you": "biggest-threat",
  "biggest-threat": "biggest-threat", "nothing-personal": "nothing-personal", "house-wants-it": "house-wants-it",
};

/**
 * The reason the decider gives out loud. Candor comes from the decider's character (their archetype's candor, their style) and how
 * secret the real reason is; a seeded roll per (decider, decision, choice, day) picks among truth / part-truth / cover. A cover story
 * is always a reason the house would find plausible ("nothing personal", "the house wanted it"); a pawn line is said whether or not
 * it is true (that is the point of a backdoor). Deterministic.
 */
export function explainDecision(real: RealReason, speaker: AgendaCharacter, seed: number, day: number): StatedReason {
  const honest = truthfulKind(real);
  const roll = agendaRoll(seed, real.decider, `reason:${real.decision}:${real.choice}:d${day}`);
  // A backdoor: the HOH tells the pawns they are pawns and never names the real target (the classic lie).
  if (real.tactic === "backdoor" && real.decision === "nominate") return { kind: "pawn-youll-be-fine", about: real.choice, candor: "cover" };
  let candor = (REASONS.candorByArchetype[speaker.archetype] ?? 0.5) + (REASONS.candorByStyle[speaker.strategyStyle] ?? 0);
  if (SECRETIVE.has(honest)) candor -= REASONS.secretivePenalty;
  candor = clamp01(candor);
  if (roll < candor) return { kind: honest, about: real.choice, candor: "truth" };
  const partial = PART_TRUTH[honest];
  if (partial !== honest && roll < candor + (1 - candor) * REASONS.partTruthShare) return { kind: partial, about: real.choice, candor: "part-truth" };
  const cover: StatedReasonKind = honest === "nothing-personal" ? "house-wants-it" : "nothing-personal";
  return { kind: cover, about: real.choice, candor: "cover" };
}

/** What may cross to the narrator for the decider's voice: the kind and the subject only. Never the candor, the goal or the terms. */
export function voiceableReason(s: StatedReason): { kind: StatedReasonKind; about: EntityId } {
  return { kind: s.kind, about: s.about };
}
