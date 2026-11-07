import type { EntityId } from "../domain/ids";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { SeededRandom } from "../adapters/random/SeededRandom";
import { resolveCompetition, eliminationOrder, CompetitionIntents } from "../domain/competitionOutcome";
import { deduceEvictionVoters, deductionSeed } from "./voteDeduction";
import { recordClaim, DEDUCED_CLAIM_CONFIDENCE, type BeliefStore } from "./beliefStore";
import { lapseAssurancesAtRoll } from "./assurances";
import type { CompetitionType, Intent, Competitor, CompetitionResult } from "../domain/competitionOutcome";

/** The competition intents the player may declare (Bible: compete / throw / play-safe), 0006/0034. */
export const COMP_INTENTS: readonly Intent[] = ["compete", "throw", "play-safe"];

/**
 * 0006b — the tunable thresholds for an NPC's derived competition intent (compete / throw / play-safe).
 * Deliberately conservative so throwing/playing-safe stays OCCASIONAL and strategic (a nominee always
 * fights; a high-aggression houseguest always competes). The magnitudes bracket the `ARCHETYPE_AGGRESSION`
 * scale (floater 0.25 / peacemaker 0.3 are the natural throwers; villain/mastermind 0.8+ never lay low)
 * and the `bondStrength` / edge-`threat` reads (baseline ~0.5).
 */
export const COMP_INTENT_THRESHOLDS = {
  /** Below this archetype aggression, a houseguest is a candidate to THROW to a close ally. */
  layLowAggression: 0.4,
  /** …and only when a bond THIS strong to another competitor is in the field (hand THEM the power). */
  throwToAllyBond: 0.72,
  /** Below this aggression, a houseguest is a candidate to PLAY SAFE when read as a target. */
  cautiousAggression: 0.55,
  /** …and only when another competitor holds a threat read on them at least this high (avoid the heat). */
  playSafeThreat: 0.62,
} as const;

/**
 * 0006b — the PURE competition-intent decision for an NPC (compete / throw / play-safe). Kept pure +
 * exported so it is unit-testable in isolation; the live adapter gathers the board/relationship inputs and
 * calls it. OCCASIONAL and strategic by construction (a nominee always fights; a high-aggression houseguest
 * always competes; throwing/playing-safe needs BOTH a lay-low/cautious archetype AND a real board reason).
 */
export function deriveNpcCompIntent(
  p: {
    /** Archetype aggression 0..1 (villain 0.85 ≫ floater 0.25). */
    aggression: number;
    /** On the block this week ⇒ always compete. */
    nominee: boolean;
    /** The strongest bond this NPC holds to ANOTHER competitor in the field. */
    bestAllyBond: number;
    /** The highest threat read ANOTHER competitor holds toward this NPC. */
    maxThreatOnMe: number;
    /** Whether the field holds any other competitor (a lone competitor just competes). */
    hasOthers: boolean;
  },
  t: typeof COMP_INTENT_THRESHOLDS = COMP_INTENT_THRESHOLDS,
): Intent {
  if (p.nominee || !p.hasOthers) return "compete";
  // THROW: a lay-low houseguest hands a very close ally the power and keeps their own head down.
  if (p.aggression < t.layLowAggression && p.bestAllyBond > t.throwToAllyBond) return "throw";
  // PLAY-SAFE: a cautious houseguest a competitor already reads as a real threat avoids painting a bigger target.
  if (p.aggression < t.cautiousAggression && p.maxThreatOnMe > t.playSafeThreat) return "play-safe";
  return "compete";
}
import {
  eligibleForHOH, vetoParticipants, selectableReplacements, evictionVoters,
} from "../domain/eligibility";
import type { WeekState } from "../domain/eligibility";
import type { Stats } from "./season";
import { nominationStrategy, nominationPlan, nominationScore, replacementPick, tallyJury } from "./season";
import type { NpcMemoryLedger } from "./npcMemory";
import { detectBlocs, blocTerm } from "./blocs";
import type { Bloc } from "./blocs";
import { DECISION } from "./decisionConstants";
import type { NominationStyle } from "./decisionConstants";
import type { Deal, DealKind } from "../domain/deal";
import type { RelationshipDisposition } from "./relationshipConstants";
import type { RelationshipModel } from "./relationships";
import {
  runFinale as buildFinaleScript, castJuryVote, juryLean, appealEffect, bestAppeal, gameRespectTerm, JURY_WEIGHTS,
  FINALE_APPEALS, type EvictionManner, type FinaleAppeal, type FinaleScript, type JuryRel,
} from "./jury";
import { MANNER_THRESHOLDS, MANNER_GRADING, MEND_TRACE } from "./juryConstants";
import { RELATIONSHIP_CONSTANTS } from "./relationshipConstants";
import { maybeFireTwist, triggeredTwist } from "./reserveTwists";
import type { ReserveTwist, TwistEvent, TwistKind, TwistPlan, TwistSignals } from "./reserveTwists";
import { jurorProfile, profiledLean, profiledWeights } from "./jurorProfile";
import { drawCompetition, competitionById, COMPETITION_LIBRARY, COMPETITION_LIBRARY_PLUS } from "./competitionLibrary";
import type { CompetitionDef, CompetitionFormat, CompetitionPhase } from "./competitionLibrary";
import { GEN_COMPETITION_BOUNDS } from "./genCompetitionConstants";
import {
  deriveFailureFact, priorWipeoutCount, appendWipeoutHistory,
  type WipeoutFailureFact, type WipeoutHistoryEntry,
} from "./wipeoutReel";
import {
  phaseForHour, bedtimeDepthFor, restDeficitForDepth, emergentBedtimeHour, wakeHourAfterBed, DAY_START, WAKE_HOUR, DAY_END_HOUR, type TimeOfDay,
} from "./timeOfDay";
import { CLOCK } from "./sleepConstants";

/**
 * The LIVE weekly loop (feature 0011, wired into the running game). Unlike
 * `playSeason` — a one-shot pure simulation used for outcome tests — this advances
 * the season ONE beat at a time so the player can live inside it, and PAUSES at the
 * player's own decision points (nominate, use the veto, name a replacement, cast an
 * eviction vote). It is pure and seed-deterministic: NPC choices are
 * relationship-driven (threat/trust), competitions are engine-decided (the player
 * is never protected — anti-sycophancy), and the legality rules (0005) are reused
 * verbatim from `domain/eligibility`. The Vault never enters here.
 */
export type Beat =
  | "hoh-competition" | "nominations" | "veto-competition"
  | "veto-ceremony" | "eviction" | "final-eviction" | "finale" | "complete"
  // the witnessed veto chip-draw ceremony (E35) — emitted on BeatEvent only; the structural
  // beat stays `veto-competition` (the draw is its first stage, the comp its second).
  | "veto-draw"
  // 0128 - the end of Part 1 or Part 2 of the THREE-PART Final HOH (flag-gated): emitted on BeatEvent only; the structural beat stays `hoh-competition` until
  // Part 3 crowns the Final HOH (that crown keeps the `hoh-competition` key, so the HOH win still folds its consequence).
  | "final-hoh-part"
  // a single STAGED elimination round (0006 staged-rounds evolution) — emitted on BeatEvent only; the
  // structural beat stays `hoh-competition`/`veto-competition`. The CROWN event keeps the comp beat key
  // (so the HOH/veto win still folds its consequence); only the per-round drops carry this distinct key.
  | "comp-elimination"
  // a sealed reserve twist firing (0025/B53): the production reveal that opens a twist night.
  | "twist-reveal"
  // the reactive battle-back (0025 redesign): recently-evicted jurors compete; one re-enters the game.
  | "battle-back"
  // finale sub-loop events (0037) — emitted on BeatEvent only; never a structural `s.beat`.
  | "finale-reveal" | "finale-result"
  // eviction sub-loop events (0047) — emitted on BeatEvent only; the staged reveal/goodbye/result.
  | "eviction-reveal" | "eviction-goodbye" | "eviction-result"
  // the evictee's exit interview (0130) — emitted on BeatEvent only; a presentation/retrospective beat
  // that draws NO rng and mutates NO seeded state (the NPC stance is a read of the already-fixed manner;
  // the record feeds only the 0048 retrospective), so it never perturbs the seeded trajectory.
  | "exit-interview"
  // 0133 — the early-evicted player's spectator choice and finale-night interview: presentation/record-only
  // beats (no rng, no fold, no clock tick) — see INERT_BEATS.
  | "spectator-choice" | "finale-interview"
  // the player's voluntary walk-out (0061) — a recorded, witnessed, non-hidden exit event; emitted
  // on BeatEvent only (the structural transition is the player's removal + the terminal `selfEvicted`).
  | "self-eviction"
  // the HOH→nominations night-gate (#1320, ADR 0006 pacing): a diegetic "the house turns in; a new
  // day dawns" beat inserted BETWEEN the HOH crown and the nominations, so nominations land the NEXT
  // in-fiction day (the canonical Day-1-HOH → Day-2-noms cadence) instead of the same moment. Emitted
  // on BeatEvent only (the structural beat stays `nominations`); INERT — it crosses the clock itself
  // (see `crossToNextDay`) and carries no rng/fold/soul inflection. GATED behind the clock pacing, so
  // it never fires in the calibration harness / a clock-off game ⇒ byte-identical.
  | "day-break";

/**
 * The INERT, presentation-only beats (0006 staged-rounds): a per-round staged-competition DROP. It
 * carries NO rng, NO consequence fold, NO soul inflection (it falls through every commit side-effect
 * switch) — pure re-telling of an already-fixed outcome (see `advanceCompetition` /
 * `stagedTrajectoryNeutral`). The crown keeps its comp beat key (so its consequence still folds) and
 * is NOT inert. Callers that gate substantive side-effects (e.g. the ADR-0006 clock, #537) consult this
 * so an inert reveal can never perturb game state the same way it can never perturb the seeded stream.
 *
 * `exit-interview` (0130) joins the set: it is a presentation-only producer sit-down (no rng, no fold —
 * the NPC stance is a read of the already-fixed manner, the record feeds only the 0048 retrospective), so
 * it must NOT advance the ADR-0006 clock either — an extra eviction-night tick would shift fatigue/rest
 * into later competitions when time-of-day is enabled, contradicting the feature's no-seeded-state contract.
 */
const INERT_BEATS: ReadonlySet<Beat> = new Set<Beat>(
  ["comp-elimination", "day-break", "exit-interview", "spectator-choice", "finale-interview"]);

/** Whether a beat is an inert, presentation-only staged reveal (no rng / no fold / no clock advance). */
export function isInertBeat(beat: Beat): boolean {
  return INERT_BEATS.has(beat);
}

/** A player decision the live loop is blocked on until `applyDecision` resolves it. */
export type PendingDecision =
  | { kind: "nominations"; by: EntityId; options: EntityId[]; pick: 2 }
  | { kind: "veto-decision"; by: EntityId; nominees: [EntityId, EntityId]; saveable: EntityId[] }
  // --- competition intent (B46/audit B5): the player declares compete/throw/play-safe before a comp ---
  | { kind: "comp-intent"; by: EntityId; comp: "hoh-competition" | "veto-competition" }
  // --- STAGED competition round (0006 staged-rounds evolution): the player declares their approach for
  // THIS elimination round, seeing who is still in. Committed BEFORE the round resolves (anti-sycophancy);
  // once the round resolves it is locked — adaptation happens forward (the next round), never backward. ---
  | { kind: "comp-round"; by: EntityId; comp: "hoh-competition" | "veto-competition"; round: number; stillIn: EntityId[]; binding: boolean }
  // --- "Houseguest's Choice" (0046/B45): the player drew the chip and picks the sixth veto player ---
  | { kind: "houseguests-choice"; by: EntityId; options: EntityId[] }
  | { kind: "replacement"; by: EntityId; saved: EntityId; options: EntityId[] }
  | { kind: "eviction-vote"; by: EntityId; nominees: [EntityId, EntityId] }
  // --- player-HOH tie-break (0046/B44): the player breaks a tied eviction vote ---
  | { kind: "tie-break"; by: EntityId; nominees: [EntityId, EntityId] }
  // --- Final 3 (0045): the final HOH personally evicts one of the other two ---
  | { kind: "final-eviction"; by: EntityId; options: [EntityId, EntityId] }
  // --- eviction night (0047/E34): the player's own goodbye message to the evictee ---
  | { kind: "goodbye-message"; by: EntityId; evictee: EntityId; tones: GoodbyeTone[] }
  // --- exit interview (0130): the player, as the EVICTEE, answers the producers in their own words/posture ---
  | { kind: "exit-interview"; by: EntityId; evictee: EntityId; stances: ExitStance[] }
  // --- early eviction (0133): the pre-jury evictee chooses to skip to the finale or keep watching ---
  | { kind: "spectator-choice"; by: EntityId; modes: SpectatorMode[]; /** E-1: a re-raised card (watch → skip) — its card text differs so the FE's per-card idempotency key can never replay the first answer. */ again?: true }
  // --- early eviction (0133): the pre-jury evictee's finale-night interview (posture + optional words) ---
  | { kind: "finale-interview"; by: EntityId; stances: ExitStance[] }
  // --- finale (0037) ---
  | { kind: "finale-statement"; by: EntityId }
  | { kind: "finale-answer"; by: EntityId; juror: EntityId; appeals: FinaleAppeal[] }
  // --- finale (0037/E37): the player-JUROR's own question to a finalist (scoreless free text) ---
  | { kind: "juror-question"; by: EntityId; finalist: EntityId }
  | { kind: "juror-vote"; by: EntityId; finalists: [EntityId, EntityId] }
  // --- self-eviction (0061): the player-level/OOC confirmation to voluntarily walk out / quit. It is
  // raised by an intent-to-leave and lives ALONGSIDE (never overriding) a ceremony pending, so it is
  // legal at any beat and corrupts no in-flight ceremony. Only an explicit confirm resolves it. ---
  | { kind: "self-evict"; by: EntityId }
  // --- secret veto (0025 reactive redesign): the player secretly holds a one-time SAFETY and is on
  // the block this week — their choice to play it (pull themselves off) or hold it. Player-agency only;
  // an NPC holder is resolved by the engine. ---
  | { kind: "secret-veto"; by: EntityId; nominee: EntityId };

/** Which stage of the live finale sub-loop (0037) we are advancing. */
export type FinaleStage = "statements" | "questions" | "vote" | "reveal";

/**
 * The live finale sub-state machine (0037). Carries the engine's script plus the per-step
 * cursor and the recorded appeals, so the finale can pause for player decisions, resume after
 * a restart (0030), and reveal votes one at a time in agreement with a precomputed tally.
 * Vault-free by construction (ids only — no leans/tallies until reveal).
 */
export interface FinaleProgress {
  stage: FinaleStage;
  finalists: [EntityId, EntityId];
  jury: EntityId[];
  script: FinaleScript;
  /** Cursor into `script.statements` (statements stage). */
  statementIx: number;
  /** Cursor into `script.questions` (questions stage). */
  questionIx: number;
  /** The appeal each finalist made to each juror: appeals[finalist][juror]. */
  appeals: Record<EntityId, Record<EntityId, FinaleAppeal>>;
  /** Precomputed votes (juror → finalist) — set once at the start of the vote stage. */
  votes?: Record<EntityId, EntityId>;
  /** Cursor into `script.revealOrder` (reveal stage). */
  revealIx: number;
}

/** Which stage of the live eviction sub-loop (0047) we are advancing. */
export type EvictionStage = "votes" | "goodbye" | "exit-interview" | "result";

/**
 * The evictee's own public posture on the way out (0130 exit interviews): DERIVED for an NPC from the
 * manner of their eviction (0037 §4.2), the PLAYER's own choice. A grounded reaction — a betrayed
 * houseguest leaves bitter, a blindsided one defiant, a clean exit gracious.
 */
export type ExitStance = "gracious" | "defiant" | "bitter";

/** The legal exit-interview stances offered to the player-evictee (their own words, their own posture). */
export const EXIT_STANCES: readonly ExitStance[] = ["gracious", "defiant", "bitter"];

/** 0133 — how a pre-jury-evicted player follows the rest of the season: skip to the finale or watch the skeleton. */
export type SpectatorMode = "watch" | "skip";
export const SPECTATOR_MODES: readonly SpectatorMode[] = ["watch", "skip"];

/**
 * 0133 — ONE public line per completed week, built at the week's roll from PUBLIC ceremony facts only (HOH,
 * nominees, veto holder/use, who left, jury size so far). Recorded on every season (no rng, no fold) so a
 * spectating player's "watch" is the engine's own condensed record — nothing is told that is not recorded.
 */
export interface WeekDigest {
  week: number;
  hoh: EntityId | null;
  nominees: EntityId[];
  vetoHolder: EntityId | null;
  vetoUsed: boolean;
  evictee: EntityId | null;
  juryCount: number;
}

/** The first `castSize − 11` evictions are pre-jury; the next 9 form the jury (cast size is conserved). */
export function preJuryEvictionCount(s: { evictionOrder: EntityId[]; active: EntityId[] }): number {
  return Math.max(0, s.evictionOrder.length + s.active.length - 2 - 9);
}

/** Is `id` out of the game BEFORE the jury formed (a pre-jury evictee)? Self-eviction is judged by the caller. */
export function isPreJuryEvictee(s: { evictionOrder: EntityId[]; active: EntityId[] }, id: EntityId): boolean {
  const idx = s.evictionOrder.indexOf(id);
  return idx >= 0 && idx < preJuryEvictionCount(s);
}

/**
 * The live eviction sub-state machine (0047): the weekly eviction staged like the finale (0037) —
 * the votes are revealed ONE AT A TIME in a seeded order (revealed-only tally), then an evictee
 * goodbye + goodbye messages whose tone folds into the evictee's manner (jury management, 0014).
 * The engine already decided the tally; this only choreographs the reveal. Vault-free by construction
 * (ids only; the evictee is not named until the last vote lands). Persisted + restart-safe (0030).
 */
export interface EvictionProgress {
  stage: EvictionStage;
  nominees: [EntityId, EntityId];
  /** The voters in the seeded order their votes are read. */
  revealOrder: EntityId[];
  /** Each voter's already-decided vote (voter → the nominee they voted to evict). */
  voteOf: Record<EntityId, EntityId>;
  /** Cursor into `revealOrder` (votes stage). */
  revealIx: number;
  /** The evicted houseguest — set only once the LAST vote is read (the tally + any HOH tie-break). */
  evictee?: EntityId;
  /** The seeded houseguests who leave a goodbye message, in order. */
  goodbyeFrom: EntityId[];
  /** Cursor into `goodbyeFrom` (goodbye stage). */
  goodbyeIx: number;
  /**
   * 0130 — set once the evictee's exit interview has been given (the single beat in the exit-interview
   * stage). Prevents re-emitting it on the advance that transitions the stage to `result`.
   */
  exitInterviewDone?: boolean;
}

/**
 * The live STAGED competition sub-state machine (0006 staged-rounds evolution). An endurance-style
 * comp is a sequence of ELIMINATION rounds over the still-in field until one remains (the winner).
 * Each round, if the player is still in, the loop PAUSES for their per-round approach
 * (compete/play-safe/throw) — committed BEFORE the round resolves, then locked (anti-sycophancy:
 * adaptation is forward-only, never a retroactive re-label). The engine resolves each round from the
 * structured selection (never prose), eliminates the lowest-scoring houseguest, and re-asks as the
 * field narrows. NPCs choose their per-round approach by soul motivation (relationship-driven, as
 * comp decisions already are; for now: always compete). Persisted + restart-safe (0030). Vault-free
 * by construction (ids only; no score, lean, or hidden number is ever stored here).
 */
export interface CompetitionProgress {
  /** Which competition this stages — for the resume after a per-round pause + the right beat transition. */
  comp: "hoh-competition" | "veto-competition";
  /** The competition type (0006/0042) — the resolution math's governing aptitude. */
  type: CompetitionType;
  /** The FULL original field that began the comp — surfaced on the crown event so the existing
   *  comp-loss inflection (the contested field) is preserved (engine bookkeeping; public ceremony fact). */
  field: EntityId[];
  /** Who is STILL IN (the field this round competes over). Shrinks by one each resolved round. */
  stillIn: EntityId[];
  /** 1-based round counter — drives the per-round seeded rng fork (restart-stable) + the decision surfaced. */
  round: number;
  /** The houseguests eliminated so far, in drop order (engine bookkeeping; never crosses the wall). */
  eliminated: EntityId[];
  /**
   * The CALIBRATED winner of this competition (anti-sycophancy, the 0006 single-outcome authority).
   * The outcome is decided ONCE, up front, by the EXACT pre-staging single-shot resolution: the comp
   * def is drawn and `resolveCompetition` rolls over the FULL field directly on the fresh per-beat rng,
   * with the player's committed approach — BYTE-IDENTICAL to the non-staged model for the same seed,
   * so the full game trajectory (every winner, eviction, jury reach) is unchanged. The staged rounds
   * are a RE-TELLING of this outcome; they can never overturn it. Set the moment the comp resolves.
   */
  winner?: EntityId;
  /**
   * The pre-computed VISIBLE ELIMINATION ORDER of the LOSERS (everyone but `winner`), the drop drama —
   * derived PURELY from the single roll's scores (`eliminationOrder`, consuming ZERO randomness), so it
   * can never perturb the winner OR any downstream seeded roll. The per-round loop reveals one entry at a
   * time; `winner` is never in this list, so the crown survives every round by construction. Empty until
   * the outcome is decided.
   */
  dropOrder?: EntityId[];
  /**
   * C1 (#1788, Q8 hybrid greenlight) — the Wipeout Reel: a seeded, archetype-flavored `failureStyle`
   * fact per DROPPED entrant in `dropOrder` (never the winner), computed ONCE at `beginStaged` from a
   * stream FORKED after the single up-front outcome-fixing roll — PRESENTATION ONLY, so `dropOrder`/
   * `winner`/every downstream seeded draw stay byte-identical (`stagedTrajectoryNeutral.test.ts`).
   * Vault-free by construction (ids + composed strings only). Present only when `ORWELL_WIPEOUT_REEL`
   * is on; absent ⇒ the pre-feature `comp-elimination` content stands untouched.
   */
  failureStyles?: Record<EntityId, WipeoutFailureFact>;
  /**
   * L-F4 (#1743) — the theme's live-varying INPUTS, FROZEN at draw/stage time. The 0125 seeded-theme
   * skin the adapter lays over the library floor is a pure function of (gameSeed, phase, week, cycle);
   * `week` is stable across a comp, but the twist `cycle` (0, or 1 while a double-eviction twist is
   * "running") can flip MID-comp, which would silently re-skin an in-progress competition round to round
   * (the L-F4 finding's twist-phase variant). Freezing both here pins the resolved name/premise for the
   * comp's whole duration — the adapter reads these instead of the live `week`/`twist`. Absent on a legacy
   * save (or when themes are off) ⇒ the adapter falls back to live resolution (back-compat, byte-identical
   * when the twist never changes). Seed-NEUTRAL projection inputs — no rng, no fold. Vault-free.
   */
  themeWeek?: number;
  themeCycle?: number;
  /**
   * L-F4 (#1743) — the presentation SOURCE decision, FROZEN at draw. #1400 model fiction is authored a
   * turn or more AFTER the roll stages (the model dresses a decided result), so a first-fiction write-back
   * that lands mid-comp would otherwise flip the name/premise from the seeded theme to the authored one
   * PART-WAY through the comp — the same flip-flop this feature prevents. This pins the choice at draw:
   * `true` only if VALIDATED fiction already existed when the comp staged (in practice only after a reload
   * of a comp whose fiction was authored before the save); `false` ⇒ the comp is committed to the frozen
   * seeded theme for its whole duration and a LATE fiction is still stored (its per-drop lines ride the
   * `comp-elimination` beats) but never re-skins the active comp's name/premise. Absent on a legacy save ⇒
   * live resolution (back-compat). Seed-NEUTRAL. Vault-free.
   */
  themeAuthored?: boolean;
}

/**
 * Feature #1400 — GENERATIVE COMPETITION DESIGN. The MODEL-AUTHORED presentation for the current
 * staged competition, validated against the engine's ALREADY-FIXED `dropOrder` and stored so it can
 * be re-told round by round. This is PRESENTATION ONLY — it dresses a decided result and can never
 * touch it: the winner + drop order were fixed up front by the single calibrated `resolveCompetition`
 * roll (`beginStaged`), and every id in `eliminations` is validated to equal `dropOrder` EXACTLY
 * (`validateCompetitionFiction`) before this is ever stored. Absent ⇒ the deterministic 0042 library
 * floor stands, byte-identical to the pre-feature model. Cleared when the comp crowns. Vault-free by
 * construction (ids + public flavor only; no score/lean/number). Persisted with the season (0030).
 */
export interface CompetitionFiction {
  /** Which staged comp this dresses (matched against `s.competition.comp` at render time). */
  comp: "hoh-competition" | "veto-competition";
  /** The week it was authored for (a staleness guard so a late write-back never dresses the wrong comp). */
  week: number;
  /** The invented competition theme/name (e.g. "The Gauntlet of Whispers"). */
  theme: string;
  /** The staging premise — how the comp is set up + played (overrides the 0042 library premise). */
  premise: string;
  /** Optional "how a win reads" line (overrides the library's `winReads`). */
  winReads?: string;
  /**
   * The per-elimination fiction, ORDERED, one entry per `dropOrder` entry — validated to name the SAME
   * ids in the SAME order as the engine's fixed drop order. The reveal loop looks each dropped id up
   * here (by id) to compose that round's `comp-elimination` content; a batched round joins its lines.
   */
  eliminations: Array<{ id: EntityId; fiction: string }>;
}

export interface LiveSeasonState {
  week: number;                 // 1-based HOH reign
  beat: Beat;                   // the next beat to resolve
  active: EntityId[];
  /** 0128 (flag-gated, persisted 0030): the THREE-PART Final HOH's live-or-next part (1|2|3), and the Part 1 / Part 2 winners once decided. Absent everywhere else. */
  finalHohPart?: 1 | 2 | 3;
  p1Winner?: EntityId;
  p2Winner?: EntityId;
  /**
   * FEATURE 0111 — THE CHAMPAGNE CIRCLE (the premiere's opening GATHERED set-piece). Reuses the 0106
   * whole-house-event machinery: `"gathered"` = the game has convened the whole house in the living
   * room for the champagne toast, so `houseEventInSession()` reports a `champagne-circle` event — the
   * player is PINNED (movePlayer no-ops) and `whereabouts()` shows the whole house co-present, so the
   * narrator cannot stage the toast elsewhere and cannot fire it while the player is away. `"done"` =
   * the toast has resolved (the model's first `advanceGame`); the player un-pins into free-roam premiere
   * (bedroom pick, settling in) — it does NOT auto-advance to the first HOH. Cleared once the premiere
   * ends. Seed-NEUTRAL (a projection flag only — no rng, no fold), so all calibration is byte-identical;
   * absent on a pre-0111 save / outside the premiere ⇒ byte-identical to the pre-feature flow. Persisted
   * with the live state (0030), so a reload mid-toast resumes gathered.
   */
  champagneCircle?: "gathered" | "done";
  /**
   * A9 (`ORWELL_PREMIERE_ENTRANCES`, default ON; `=0` opts out) - the premiere staged as sixteen INDIVIDUAL entrances then the toast.
   * `order` is a seeded side-stream permutation of all 16 ids; `arrived` counts those entered (incl. the player); `spoke`
   * the toast speakers released ("host" or an id). Persisted (0030); ABSENT when the flag is off (byte-identical).
   * Premiere-scoped: cleared the instant the phase leaves "premiere".
   */
  premiereEntrance?: { order: string[]; playerPos: number; arrived: number; stage: "entrances" | "toast" | "done"; spoke: string[] };
  /** The player's declared intent for the upcoming competition (B46); consumed when it resolves. */
  compIntent?: Intent;
  hoh?: EntityId;
  nominees?: [EntityId, EntityId];
  /**
   * #1948 — the NPC HOH's actual TARGET from nominations (the top strategic read; OFF the block on a
   * backdoor). `replacementPick` branches on this identity instead of inferring pawn-vs-target from scores.
   * Absent for a human HOH's nominations and on a pre-#1948 save ⇒ the score inference, as before. Engine-only,
   * no rng; cleared at the week roll. Persisted with the live state.
   */
  nominationTarget?: EntityId;
  /**
   * 0024 — the NPC MEMORY ledger (`holder → subject → entries`), written only while `ORWELL_NPC_MEMORY` is on (absent
   * otherwise ⇒ flags-off saves are byte-identical). Engine-only; persisted with the live state; never projected.
   */
  npcMemory?: NpcMemoryLedger;
  vetoField?: EntityId[];
  vetoHolder?: EntityId;
  vetoUsed: boolean;
  saved?: EntityId;
  replacement?: EntityId;
  finalNominees?: [EntityId, EntityId];
  outgoingHoh?: EntityId;
  evictionOrder: EntityId[];
  evictee?: EntityId;
  finished: boolean;
  winner?: EntityId;
  finalTwo?: [EntityId, EntityId];
  jury?: EntityId[];
  pending?: PendingDecision;
  /**
   * Self-eviction (0061). `selfEvictPending` = the OOC confirmation is raised and awaiting the
   * player's explicit confirm/cancel — it changes NO game state and lives ALONGSIDE any ceremony
   * `pending` (it never overrides one, so it is legal at any beat and corrupts no ceremony, §4.6).
   * `selfEvicted` = a confirmed walk-out resolved: the player forfeits and EXITS ENTIRELY (owner
   * decision #1 — terminal, never a juror's seat), so the seat read is forced to "evicted" by phase.
   * Both persist with the season (0030). ENGINE-ONLY booleans — no number/hidden state, Vault-free.
   */
  selfEvictPending?: boolean;
  selfEvicted?: boolean;
  /**
   * 0123 — an NPC-initiated deal offer awaiting the player's accept/decline. Lives ALONGSIDE any ceremony
   * `pending` but is only ever RAISED at a lull (no ceremony pending), so it never preempts a ceremony.
   * Vault-free: who floated it, the deal `kind`, a Vault-safe `terms` paraphrase, and the week it anchors
   * to (the deal's horizon on accept). `lastDealOfferWeek` caps offers to at most one per in-game week.
   * Both persist with the season (0030). Absent unless the `ORWELL_NPC_DEAL_OFFERS` layer is on ⇒
   * byte-identical when off.
   */
  dealOffer?: { id: string; from: EntityId; kind: DealKind; terms: string; madeWeek: number };
  lastDealOfferWeek?: number;
  /**
   * How each evictee read the manner of their eviction toward each responsible houseguest
   * (0037): mannerByEvictee[evictee][responsible]. Recorded live at each eviction so jury
   * management has genuine effect at the finale. ENGINE-ONLY: never crosses the wall.
   */
  mannerByEvictee?: Record<EntityId, Record<EntityId, EvictionManner>>;
  /**
   * The accumulated JURY-HOUSE grudge adjustment (feature 0100): juryGrudge[juror][finalist] is the
   * BOUNDED (0..`JURY_HOUSE.adjustmentCap`), MONOTONIC amount the sequestered jury house has hardened
   * this juror's hidden read of the responsible finalist — what a grievance, spread juror-to-juror in
   * the room the player can't enter, did to it AFTER the snapshot frozen at eviction. Consumed at the
   * finale by `edgeAsJuryRel` ALONGSIDE the recorded manner: it lowers the juror's bond read of that
   * finalist, sized UNDER the manner lean so it DEEPENS (never swamps) jury management. ENGINE-ONLY:
   * never crosses the wall — the player feels it only as a colder juror and a vote that breaks. Absent
   * unless `ORWELL_JURY_HOUSE` is enabled and a grievance diffused ⇒ byte-identical to the pre-feature
   * vote (the grudge is computed on a DEDICATED rng; off ⇒ no draw, no grudge). Persisted with the
   * season (rides on this `live` state), so a restored mid-jury game resumes with the bitterness intact.
   */
  juryGrudge?: Record<EntityId, Record<EntityId, number>>;
  /**
   * #1790 — engine-only per evictee, the POSSIBLY-WRONG voters they deduced (0110). Stored at each
   * eviction by commitStagedEviction so the jury-house blame-diffusion pass (AC1) can seed a
   * named-blame belief into that juror's knowledge. NEVER projected to any surface — no player-visible
   * change, not even behind the flag (the flag OFF path skips the whole jury-house blame pass, and the
   * field itself is absent unless commit 2 stores it).
   */
  deducedCulprits?: Record<EntityId, EntityId[]>;
  /** A62 (ORWELL_JUROR_PROFILES + vote deduction, engine-only, never projected): per evictee, the houseguests they WRONGLY blame (believed to have voted against them, but did not). */
  mistakenBlame?: Record<EntityId, EntityId[]>;
  /**
   * #2017 S0a — the NPC belief store (`beliefStore.ts`): per-holder typed claims with origin + confidence. ENGINE-ONLY, never projected, read
   * by NOTHING yet (data model + plumbing), no rng. Created ONLY when `ORWELL_NPC_BELIEFS` is on (absent ⇒ byte-identical season state). Rides on
   * this `live` state, so it is persisted and restored with the season exactly like `juryGrudge`.
   */
  beliefs?: BeliefStore;
  /** B4: the casual-assurance ledger (`assurances.ts` toJSON shape). Created ONLY when ORWELL_ASSURANCES is on (absent => byte-identical season state); persisted with the season. */
  assurances?: { seq: number; items: import("./assurances").Assurance[] };
  /**
   * The per-week eviction ballot record (E12): who voted to evict whom, kept ENGINE-ONLY for
   * manner/deal reconciliation and for the 0048 retrospective UNSEALING. Eviction votes are
   * secret ballots in Big Brother — no projection attributes a weekly vote to its voter while
   * the season lives; the attribution surfaces only through the post-season retrospective.
   */
  voteRecord?: Array<{ week: number; evictee: EntityId; voteOf: Record<EntityId, EntityId> }>;
  /**
   * 0130 — each evictee's exit interview, week by week: their public posture on the way out (a `stance`
   * DERIVED from their manner for an NPC, or the PLAYER's own chosen stance + words). Recorded as the
   * exit-interview beat resolves; resurfaced in the 0048 retrospective as first-person exit accounts.
   * Expressive/retrospective ONLY — it feeds no seeded decision, so it never perturbs the game trajectory.
   */
  exitInterviews?: Array<{ week: number; evictee: EntityId; stance: ExitStance; message?: string }>;
  /**
   * 0133 — early eviction. `spectator` is the pre-jury-evicted player's chosen way to follow the rest of the
   * season (set when they answer the `spectator-choice` card); `spectatorOffered` marks the one-time offer;
   * `weekDigests` is the public one-line-per-week record; `finaleInterview` is the evicted player's finale-night
   * interview (posture + words). All ENGINE state, no rng, no number; the interview feeds no vote or winner.
   */
  spectator?: { mode: SpectatorMode; sinceWeek: number };
  spectatorOffered?: boolean;
  weekDigests?: WeekDigest[];
  finaleInterview?: { stance: ExitStance; message?: string };
  /**
   * The in-progress STAGED competition sub-loop (0006 staged-rounds evolution); set while an
   * endurance-style HOH/veto comp plays out its elimination rounds, cleared when a winner remains.
   */
  competition?: CompetitionProgress;
  /**
   * Feature #1400 — the MODEL-AUTHORED presentation for the CURRENT staged competition (theme +
   * premise + per-round elimination fiction), validated against the fixed `dropOrder` before storage
   * and cleared when the comp crowns. PRESENTATION ONLY: dresses the decided result, never touches it.
   * Absent (the default; the flag is OFF, or no fiction was authored/validated) ⇒ the deterministic
   * 0042 library floor stands, byte-identical to the pre-feature model. Persisted with the season (0030).
   */
  competitionFiction?: CompetitionFiction;
  /** The in-progress live finale sub-loop (0037); set when the finale begins. */
  finale?: FinaleProgress;
  /** The in-progress live eviction sub-loop (0047); set while a weekly eviction stages its reveal. */
  eviction?: EvictionProgress;
  /**
   * PO ruling 2026-11-01 — the in-game hours already charged to the current multi-step EVENT (an
   * eviction night or the finale), so the whole event costs ~2h of the day however many presentation
   * steps it stages (it used to charge +3h per reveal batch / goodbye / Q&A — days of in-game time).
   * `key` names the event (`eviction:w<week>` / `finale`). Clock-only bookkeeping: read and written only
   * on the time-of-day path (calibration never touches it). Absent ⇒ no event charged yet.
   */
  eventClock?: { key: string; spent: number };
  /**
   * The SEALED reserve twists (0025/B53): what may fire and at which week. ENGINE-ONLY Vault
   * content carried in the loop state so it persists with the season (0030) — no projection
   * ever selects it, and the Vault store holds the audit copy. Often empty (rare by construction).
   */
  reserve?: ReserveTwist[];
  /**
   * The active twist night: `pending` = sealed for THIS week's eviction (still invisible);
   * `running` = the compressed second cycle is live (revealed). Cleared when the night completes.
   */
  twist?: { kind: TwistKind; phase: "pending" | "running" };
  /** Twists that actually fired (exactly-once bookkeeping + the 0048 unsealing payoff). */
  firedTwists?: TwistEvent[];
  /**
   * The REACTIVE per-season twist plan (0025 redesign): the sealed, seeded thresholds that decide
   * WHEN each pooled twist fires + whether each is armed this season. Present ⇒ the reactive path is
   * live (set at setup when ORWELL_REACTIVE_TWISTS is on); absent ⇒ the legacy pre-scheduled `reserve`
   * path. ENGINE-ONLY Vault content, carried on the loop state so it persists with the season (0030).
   */
  twistPlan?: TwistPlan;
  /** Non-player jurors a battle-back has pulled out of the eviction record (0025). The jury-house arrivals target is `jurors now + juryReturns`, so the persisted monotonic arrivals counter never has to be lowered. */
  juryReturns?: number;
  /**
   * A granted-but-unplayed SECRET VETO (0025 redesign): the sealed one-time safety and who secretly
   * holds it. Granted when the secret-veto trigger fires (invisible), consumed when the holder plays
   * it off the block (the reveal). ENGINE-ONLY until played — no projection selects it.
   */
  secretVeto?: { holder: EntityId; used: boolean; declinedWeek?: number };
  /**
   * The running lopsided-eviction streak (0025 redesign) — consecutive near-unanimous evictions, the
   * "the house is steamrolling" signal the secret-veto trigger reads. Reset by a close vote. Vault-free
   * bookkeeping (a count of already-public margins); persisted with the season.
   */
  lopsidedStreak?: number;
  /** The drawn competitions so far, per phase (0042) — feeds the no-immediate-repeat draw; persisted (0030). */
  compHistory?: { hoh: string[]; veto: string[] };
  /**
   * Each houseguest's GAME RESUME — a public-facts tally (HOH reigns + veto wins) the finale jury
   * weighs as "who played harder" (the gameRespect term, ruling 2026-06-11). Engine-internal
   * bookkeeping of already-broadcast events; persisted (0030); legacy saves default to empty.
   */
  resume?: Record<EntityId, number>;
  /** This week's drawn veto comp (def id) — held across a Houseguest's-Choice pause so the resume runs the SAME comp. */
  vetoComp?: string;
  /**
   * The in-game TIME OF DAY (ADR 0006). OPTIONAL by design: the pure seeded sims + legacy saves omit
   * it, and when absent the clock simply isn't running — every outcome is BYTE-IDENTICAL (the golden
   * calibration spine never reads it). Advanced by PLAY on the live turn path; reset to morning when a
   * new day begins. Public, Vault-free.
   */
  timeOfDay?: TimeOfDay;
  /**
   * Sleep bookkeeping (ADR 0006), ENGINE-ONLY (no number crosses the wall). `playerRetired` = the
   * player chose to turn in for the night (NEVER auto-set — §Principle 6), cleared at the new day.
   * `lastSleepPhase` = (legacy field name; now the clock-HOUR the player was last awake to last night) —
   * kept for save round-trip + the adapter's rest-cue read. Persist with the season (0030).
   */
  playerRetired?: boolean;
  /** P4d: the hour the player woke at when they bedded early (< the 8am wake); absent => the normal 8am wake. Cleared at the next day boundary. */
  wakeHour?: number;
  lastSleepPhase?: number;
  /**
   * The 24-hour clock (0066, the #1125 model; gated). `nightDepth` is the legacy field NAME but carries the
   * clock-HOUR (8..32) the public `timeOfDay` is PROJECTED from (`phaseForHour`): 8 = the 8am wake, 32 = the
   * next 8am. It advances by PLAY and clamps at the bitter end (never wraps without an 8am wake or `turnIn`).
   * `lastSleepDepth` = the clock-HOUR the player was last awake to last night (drives the GRADED sleep
   * deficit + their rest cue). Absent ⇒ the clock isn't running ⇒ byte-identical to the pre-feature model.
   * Persist with the season (0030).
   */
  nightDepth?: number;
  lastSleepDepth?: number;
  /**
   * "Hang out until X": how many hang-out calls have run (the side-stream salt), the in-game day the player was last
   * PULLED during a hang-out (at most once a day), and the recorded stop of every call. Written ONLY by the flag-gated
   * `hangOut` lever => absent when off => byte-identical. Persisted with the season.
   */
  /**
   * A8 (desire clock, `ORWELL_DESIRE_CLOCK`): the absolute in-game hour each NPC last approached the player (hours-based cooldown), and the one NPC interruption currently standing
   * (set when an NPC's urge crosses its threshold during a conversation step; shown for exactly the next framing, then cleared). Written ONLY by the flag-gated path => absent
   * when off => byte-identical. Persisted with the season.
   */
  desireApproachedAt?: Record<string, number>;
  interruption?: { npc: string; desire: string; atHour: number };
  hangOutCount?: number;
  hangOutPulledDay?: number;
  hangOutLog?: Array<{ n: number; day: number; hour: number; beats: number; minutes: number; stopReason: string; detail?: Record<string, unknown> }>;
  /**
   * #1320 night-gate one-shot: set once the pre-nominations day-break has fired for the CURRENT HOH reign,
   * so the "a new day dawns" beat is inserted exactly once between the HOH crown and the nominations
   * (cleared each reign by `rollWeek`). Written ONLY when the clock-pacing night-gate is active
   * (`SeasonCtx.nightGate`), so a clock-off / calibration game never sets it ⇒ absent ⇒ byte-identical.
   * Persisted with the season like the rest of the clock state (0030).
   */
  preNomsNightPassed?: boolean;
  /** P4b — set once the one-shot day-1 `day-break` (the premiere exit that starts the first morning WITHOUT staging the HOH comp) has fired. Clock-live only; absent ⇒ byte-identical. */
  firstMorningPassed?: boolean;
  /** ORW-116 (a): set once the first NIGHT (premiere evening -> first morning) has been crossed, so the first HOH can be due that afternoon. Clock-live only; absent => byte-identical. */
  firstNightPassed?: boolean;
  /** ORW-116 (b): true once a PLAYER conversation has ticked the clock. The night-hold only protects a night the player is actually playing; a headless driver that never talks keeps the pre-hold day-breaks. Serialization-neutral (undefined). */
  clockInteractive?: boolean;
  /**
   * Phase 3a — the same one-shot day-break gate, extended to the REST of the weekly cadence so every
   * major beat lands on its OWN in-fiction day (day order WEEKLY_CADENCE.dayOf, within-day slot DAY_SCHEDULE: Day 1 HOH → 2 noms → 3 veto → 4 veto
   * ceremony → 5 eviction), never two ceremonies in one day. Each is set the first time its beat resolves
   * for the current reign and cleared per reign by `rollWeek`. Written ONLY under the clock-pacing
   * night-gate (`SeasonCtx.nightGate`) ⇒ a clock-off / calibration game never sets them ⇒ byte-identical.
   */
  preVetoNightPassed?: boolean;
  preVetoCeremonyNightPassed?: boolean;
  preEvictionNightPassed?: boolean;
  /** 0066 Phase-2: the COMPOUNDING multi-night fatigue meter (0..1) — an EMA of nightly deficits, so a
   *  STRING of late nights wears a houseguest down beyond the single-night cost. Persisted (0007/0030 —
   *  non-degradation); absent ⇒ 0 ⇒ byte-identical when the clock is off. `npcFatigue` is keyed by id. */
  playerFatigue?: number;
  npcFatigue?: Record<EntityId, number>;
  /**
   * 0102 (PO review 2026-06-27 redesign, #884) — the daily "day in review" bookkeeping, dormant unless
   * the clock (`timeOfDay`) is running. `dayNumber` is the 1-based in-game day counter (bumped each
   * `turnIn`, ADR 0006's bedtime lever). `dailyRecapEventCursor`/`dailyRecapKnowledgeCursor` are the
   * event-log / player-knowledge array LENGTHS already folded into a materialized recap, so the next
   * `turnIn` slices only the tail that closed TODAY (never re-scans, never double-counts). `lastDailyRecap`
   * is the MATERIALIZED digest for the day that most recently closed — computed once, at `turnIn`, and
   * served back verbatim by `dailyRecap()`/`AdvanceView.dailyRecap` so a re-read (a fresh context, a
   * restore) reproduces the exact same recap for that day (determinism/non-degradation). Absent on a
   * pre-0102 save or whenever the clock has never rolled a day ⇒ no recap, byte-identical to today.
   */
  dayNumber?: number;
  dailyRecapEventCursor?: number;
  dailyRecapKnowledgeCursor?: number;
  lastDailyRecap?: DailyRecapEntry;
  /**
   * C1 (#1788) — the season-spanning, MONOTONIC Wipeout Reel history per houseguest (mandate #4:
   * appended only, never trimmed or overwritten). Fed by each REVEALED staged-comp drop's failure-style
   * fact so the SAME houseguest's later wipeouts can call back to earlier ones ("the third time this
   * season..."). Absent unless `ORWELL_WIPEOUT_REEL` has fired at least once; persisted with the season
   * (0030), plain JSON (ids + strings only) so save/restore round-trips losslessly.
   */
  wipeoutHistory?: Record<EntityId, WipeoutHistoryEntry[]>;
}

/** 0102 — the non-committal cliffhanger a `DailyRecapEntry` may carry (see `DailyRecapHook` in the port). */
export interface DailyRecapHook {
  thread: string;
  framing: string;
}

/** 0102 — the pure-data shape of a materialized daily recap (mirrors the port's `DailyRecapView`). */
export interface DailyRecapEntry {
  day: number;
  highlights: string[];
  surfaced: string[];
  hook?: DailyRecapHook;
}

/** What the live loop reads about the house — kept narrow so the core stays pure/testable. */
export interface SeasonCtx {
  player: EntityId;
  statsOf: (id: EntityId) => Stats;
  rel: RelationshipModel;
  /**
   * The houseguest's LIVE soul emotional state (0041): 0..1, 0.5 = calm baseline. Drives the
   * competition emotional modifier (0006/0028) and the rattled-HOH nomination leaning. Optional so
   * pure tests can omit it (a calm 0.5 default leaves outcomes byte-stable). ENGINE-ONLY — a number
   * that never crosses the wall.
   */
  emotionalOf?: (id: EntityId) => number;
  /**
   * The houseguest's hidden REST deficit (0..1) entering a competition (ADR 0006): staying up into
   * late-night the night before a comp dulls performance — the social game pays for its scheming, the
   * comp-focused protect their sleep. Optional — omitted ⇒ 0, so the outcome (and the whole seeded
   * calibration spine) is BYTE-IDENTICAL to the pre-feature model. ENGINE-ONLY: never crosses the wall.
   */
  restOf?: (id: EntityId) => number;
  /**
   * The houseguest's derived LOYALTY (0043: disposition × soul state). When present, decisions
   * gain the emergent BLOC term — bloc-mates shield each other and vote together, scaled by the
   * bloc's loyalty strength. Optional: pure tests omit it and the loop stays byte-stable. The
   * blocs themselves are recomputed every read and NEVER stored (decision 0002).
   */
  loyaltyOf?: (id: EntityId) => number;
  /**
   * 0107 — the NAMED-ALLIANCE cement fed into bloc detection: a bounded boost to a pair's mutual bond
   * when they share a named alliance. Optional: omitted ⇒ 0 for every pair ⇒ the bloc read (and the
   * votes it bends) is BYTE-IDENTICAL — the calibration spine holds when no alliances exist.
   */
  allianceTie?: (a: EntityId, b: EntityId) => number;
  /**
   * The houseguest's static relationship DISPOSITION (0044): gates WHICH nomination tactic an HOH
   * plays (a loyalist sits a pawn; a schemer backdoors; neutral plays direct). Optional: pure
   * tests omit it and every HOH plays the direct, threat-primary read — byte-stable.
   */
  dispositionOf?: (id: EntityId) => RelationshipDisposition;
  /**
   * PO 2026-11-02 — the houseguest's own NOMINATION STYLE (threat hunter / floater cleaner / duo breaker /
   * loyalist), fixed by archetype. Optional: absent ⇒ every HOH reads as a threat hunter.
   */
  nominationStyleOf?: (id: EntityId) => NominationStyle;
  /**
   * #1320 — the HOH→nominations NIGHT-GATE is live for this turn. When true, the advance that would
   * resolve the nominations first crosses the night to the next morning as its own diegetic `day-break`
   * beat, so nominations land the NEXT in-fiction day (Day-1-HOH → Day-2-noms) instead of the same
   * moment as the crown. The adapter sets it to `perConversationClockEnabled && timeOfDayEnabled` — the
   * clock-pacing pair — so it is the "deeper half" of the fast-forward pacing fix and rides the SAME
   * gate the per-conversation clock does. Optional/absent (pure tests, calibration harness, a clock-off
   * game) ⇒ the gate is fully inert ⇒ BYTE-IDENTICAL to the pre-feature model.
   */
  nightGate?: boolean;
  /** ORW-116 (b): with the clock live, a night-gate day-break only runs once the NIGHT IS OVER (the player turned in, or the clock reached the next 8am). Unset (calibration, spectator, admin fast-forward) => the day-breaks run as before. */
  nightHold?: boolean;
  /**
   * The OPEN deals binding a houseguest (0039 → 0044): an eviction vote leans away from evicting
   * a party the voter promised to protect — and breaking that lean anyway is a real betrayal the
   * ledger reconciles downstream. Optional: omitted ⇒ no deal term.
   */
  dealsOf?: (id: EntityId) => readonly Deal[];
  /**
   * 0085 — the per-listener CAMPAIGN tilt: the summed, CHARACTER-mediated push (`campaignTilt` =
   * persuasiveness(owner) × susceptibility(voter) × trust × progress) from campaigns to EVICT `target`
   * that `voter` is AWARE of (on a pathway — the symmetric-perspective spine). A sustained, well-pitched
   * campaign raises its target's eviction odds; the engine TALLIES it, narration only voices it
   * (anti-sycophancy). Optional: omitted ⇒ 0, so the seeded vote — and the whole `juryReach` calibration
   * spine — is BYTE-IDENTICAL to the pre-feature model. ENGINE-ONLY (a bounded number; never crosses the
   * wall). Wired only by the LIVE adapter (Phase B2); the calibration/UAT harness leaves it unset, so
   * campaigns never shift the baseline gates.
   */
  campaignTiltFor?: (target: EntityId, voter: EntityId) => number;
  /**
   * #1937 — the signed, bounded campaign PUSH on `target` as seen by `decider` (the NPC HOH naming nominees, the NPC
   * veto holder): evict adds, protect subtracts, aware campaigns only (`campaignPushFor`). Feeds the nomination /
   * replacement scores and the veto-save read. Omitted ⇒ 0, so flags-off stays BYTE-IDENTICAL. Returns 0 for the
   * PLAYER as decider. ENGINE-ONLY — never crosses the wall.
   */
  campaignPushFor?: (target: EntityId, decider: EntityId) => number;
  /** B51 (ORWELL_DRIVE_DECISIONS): the decider's OWN drive toward `target` as a nomination / veto-save push (positive = toward evicting). */
  drivePushFor?: (target: EntityId, decider: EntityId) => number;
  /**
   * 0024 — the signed, bounded RESIDUAL memory tilt of `holder` toward acting AGAINST `subject` (`+grudge − favor`,
   * net of what the relationship edge still carries): a broken deal, a trusted friend who nominated/replaced them,
   * a veto save. Feeds the NPC eviction vote and the NPC HOH's nomination / replacement scores. Omitted ⇒ 0, so
   * flags-off stays BYTE-IDENTICAL. 0 for the PLAYER as holder. ENGINE-ONLY — never crosses the wall.
   */
  memoryTiltFor?: (subject: EntityId, holder: EntityId) => number;
  /** B29 (ORWELL_TELL_REACTIONS): the holder's small, decaying exploit tilt toward `subject`, whom they saw visibly rattled. Absent => 0, byte-identical. */
  moodTiltFor?: (subject: EntityId, holder: EntityId) => number;
  /** B3 / #2017 — the holder's belief that `subject` is targeting them, as a nomination tilt (`ORWELL_NPC_BELIEF_NOMS`, default ON; `=0` opts out). Absent ⇒ byte-identical. */
  beliefTiltFor?: (subject: EntityId, holder: EntityId) => number;
  /** B6 slice 2 (ORWELL_LOBBYING): the nomination-score tilt from the pitches other houseguests made to `holder` about `subject`. Absent => byte-identical. */
  pitchTiltFor?: (subject: EntityId, holder: EntityId) => number;
  /** B4 slice 3 (ORWELL_ASSURANCES): does `holder` hold a casual assurance toward `target` that they decided to KEEP? Absent => no protection (byte-identical). */
  assuranceProtects?: (target: EntityId, holder: EntityId) => boolean;
  /** B7 M1 (ORWELL_VETO_MEMORY): how much MORE worth saving `nominee` is to the veto `holder` from what the holder remembers / believes / owes (signed: grudge or 'they target me' lowers, favor or an owed deal raises). Absent => +0, byte-identical. */
  vetoMemoryFor?: (nominee: EntityId, holder: EntityId) => number;
  /** B30 (ORWELL_MOOD_VETO): how the veto holder's visible emotional state shifts how worth saving `nominee` is (a rattled holder rescues the people they are close to; a snapping one is less forgiving). Absent => 0, byte-identical. */
  moodVetoFor?: (nominee: EntityId, holder: EntityId) => number;
  /** B7 M4b (ORWELL_HC_MEMORY, approved tie-in #6): how much more (+) or less (-) an NPC Houseguest's-Choice holder wants `candidate` as the sixth veto player, from what they remember / believe / owe. Absent => +0, byte-identical. */
  hcMemoryFor?: (candidate: EntityId, holder: EntityId) => number;
  /** B7 M3 (ORWELL_DEAL_NOMS): the nomination-score push from the HOH's open protective deals with `target` (<= 0). Absent => byte-identical. */
  dealNomPushFor?: (target: EntityId, holder: EntityId) => number;
  /** ORW-37 half 2 (B41, ORWELL_TIE_BEHAVIOR): the HOH's nomination-score push from a pre-show tie they themselves hold with `target` (family shield, rival push). Absent => 0 => byte-identical. */
  tieNomPushFor?: (target: EntityId, holder: EntityId) => number;
  /** ORW-37 half 2 (B41): the eviction-vote push from a pre-show tie `voter` holds with `nominee` (positive evicts, negative keeps). Absent => 0 => byte-identical. */
  tieVotePushFor?: (nominee: EntityId, voter: EntityId) => number;
  /** B4 slice 4 (ORWELL_ASSURANCES): the bounded shield a KEPT 'vote'/'safe' assurance `voter` made to nominee `n` adds against evicting `n`. Absent => 0, byte-identical. */
  assuranceVoteFor?: (nominee: EntityId, voter: EntityId) => number;
  /** B4 slice 4: `voter` actually voted `nominee` out - any open assurance they made to `nominee` is broken (resolved + folded by the adapter). */
  assuranceVotedOut?: (voter: EntityId, nominee: EntityId, sealedAmong?: readonly EntityId[]) => void;
  /** B4 slice 3: the HOH actually nominated `nominee` - any open assurance the HOH made to them is broken (resolved + folded by the adapter). */
  assuranceNominated?: (holder: EntityId, nominee: EntityId) => void;
  /** B4 slice 8: the HOH's nominations are final and did NOT include the houseguests they had assured 'safe'/'loyal' - those assurances were KEPT (resolved + the assured remembers a favor, by the adapter). */
  assuranceKeptAtNominations?: (holder: EntityId, nominees: readonly EntityId[]) => void;
  /** B4 slice 8: `voter` voted the OTHER nominee out and so spared `spared` - an open 'vote'/'safe' assurance they made to `spared` was KEPT. */
  assuranceKeptAtVote?: (voter: EntityId, spared: EntityId, sealedAmong?: readonly EntityId[]) => void;
  /** B4 slice 8: the eviction nominees are final (after the veto and any replacement) - every open 'safe' assurance whose assured is NOT on the block was kept. */
  assuranceKeptAtTally?: (finalNominees: readonly EntityId[]) => void;
  /**
   * 0006b (PO review 2026-06-28) — the NPC's declared COMPETITION INTENT (compete / throw / play-safe)
   * for a comp over `field`. Like the player, an NPC now has an intent, derived from their game (a nominee
   * fights; a lay-low houseguest with a strong ally in the field may throw to hand them the power; a
   * cautious houseguest reading a real threat may play safe). Optional: omitted ⇒ every NPC "compete"s
   * (the pre-feature path), so the seeded competition — and the whole juryReach/UAT calibration spine — is
   * BYTE-IDENTICAL. ENGINE-ONLY (never crosses the wall). Wired only by the LIVE adapter behind
   * `ORWELL_COMP_INTENT`; the calibration/UAT harness leaves it unset.
   */
  compIntentOf?: (id: EntityId, field: readonly EntityId[]) => Intent;
  /**
   * 0110 (PO review 2026-06-28) — when true, the eviction jury grudge folds on WHO THE EVICTEE DEDUCES
   * voted against them (process of elimination over the public count + their reads), not the true secret
   * ballot. Absent/false ⇒ the grudge folds the true `votesToEvict` exactly as before ⇒ BYTE-IDENTICAL
   * (no deduction runs, no sub-rng is drawn) — the seeded jury spine is unmoved. Wired live behind
   * `ORWELL_VOTE_DEDUCTION`; the calibration/UAT harness leaves it off.
   */
  voteDeduction?: boolean;
  /** #2017 S0a — record belief claims (data model + plumbing only; nothing reads them). Default ON (`ORWELL_NPC_BELIEFS`; `=0` opts out). */
  npcBeliefs?: boolean;
  /**
   * 0126 — fold the expanded mechanic pool (9 HOH + 9 veto extra) into the competition draw. Absent/false
   * ⇒ the bare base 12, byte-identical (the seeded spine is unmoved). Wired live behind
   * `ORWELL_COMP_MECHANICS_PLUS`; the calibration/UAT/golden harness leaves it off.
   */
  expandedComps?: boolean;
  /**
   * 0127 — blend a hybrid comp's SECONDARY aptitude into its outcome (a physical-with-a-puzzle-element
   * veto rewards the well-rounded houseguest). Absent/false ⇒ the pure single stat, byte-identical (the
   * seeded spine is unmoved). Wired live behind `ORWELL_COMP_MIXED`; the calibration/UAT/golden harness
   * leaves it off.
   */
  mixedComps?: boolean;
  /**
   * 0128 - the Final 3 HOH is the real show's THREE-PART tournament (endurance for all three -> a physical+mental hybrid between the two Part-1 losers -> a quiz
   * between the two part-winners) instead of ONE competition. Absent/false => the single-comp 0045 path, byte-identical (the seeded spine is unmoved). Wired
   * live behind `ORWELL_FINAL_HOH_THREE_PART` (default ON; `=0` opts out); the calibration/UAT harness leaves it off.
   */
  finalHohThreePart?: boolean;
  /**
   * A2 (design §13, `ORWELL_JUROR_PROFILES`, default OFF) - each juror votes by their OWN profile (archetype weights + friend-forgives) instead of the one global weight
   * vector. Absent/false => the global ballot, byte-identical (the seeded spine is unmoved). `jurorProfileSalt` (the game seed) keeps profiles stable per game.
   */
  /** B26 (ORWELL_JURY_MEMORY): a juror's signed MEMORY lean toward a finalist (+ favors them, - holds a grudge), bounded. Absent => +0, byte-identical. */
  juryMemoryFor?: (juror: EntityId, finalist: EntityId) => number;
  jurorProfiles?: boolean;
  jurorProfileSalt?: string | number;
  /**
   * C1 (#1788, Q8 hybrid-greenlit) — the WIPEOUT REEL layer is live for this turn
   * (`ORWELL_WIPEOUT_REEL`). Off/absent ⇒ `beginStaged` computes no `failureStyle` fact for any staged-
   * comp drop ⇒ the `comp-elimination` content is BYTE-IDENTICAL to the pre-feature template/authored-
   * fiction path (`tests/unit/stagedTrajectoryNeutral.test.ts` covers the OUTCOME axis regardless — this
   * layer never touches rng, `dropOrder`, or the winner, only presentation).
   */
  wipeoutReelEnabled?: boolean;
  /**
   * C1 — the houseguest's byte-stable genesis `CHARACTER` archetype (`characterFactory.ts`'s 12-member
   * enum), read ONLY to pick which failure-style phrase bank a Wipeout Reel drop draws from (a comic
   * SIGNATURE, per houseguest). Optional: omitted ⇒ every drop draws from the generic pool — still
   * byte-identical on the outcome axis (presentation only; no rng/fold/dropOrder touched either way).
   */
  archetypeOf?: (id: EntityId) => string | undefined;
  /**
   * #1790 — when true, the finale vote REVEAL sequence is regrouped for drama (clustering by
   * bearing/finalist instead of simple juror order). The tally (`tallyJury`) and winner are
   * UNCHANGED — this flag gates ONLY the presentation-time `f.script.revealOrder` reordering.
   * Absent/false ⇒ `f.script.revealOrder` is used as-is ⇒ byte-identical with the pre-feature path
   * (no additional rng draws, no vote perturbation).
   */
  traitorsFury?: boolean;
}

/** A meaningful, player-witnessed beat event (daily-event invariant, 0008). */
export interface BeatEvent {
  beat: Beat;
  content: string;
  participants: EntityId[];
}

export type DecisionInput =
  | { kind: "nominations"; choice: [EntityId, EntityId] }
  | { kind: "veto-decision"; use: boolean; save?: EntityId }
  | { kind: "comp-intent"; intent: Intent }
  // --- STAGED competition round (0006 staged-rounds evolution): the player's approach for THIS round ---
  | { kind: "comp-round"; intent: Intent }
  | { kind: "houseguests-choice"; pick: EntityId }
  | { kind: "replacement"; replacement: EntityId }
  | { kind: "eviction-vote"; vote: EntityId }
  | { kind: "tie-break"; evict: EntityId }
  | { kind: "final-eviction"; evict: EntityId }
  // --- eviction night (E34): the tone is the player's CHOICE; the prose is the model's to voice ---
  | { kind: "goodbye-message"; tone: GoodbyeTone; message?: string }
  | { kind: "exit-interview"; stance: ExitStance; message?: string }
  | { kind: "spectator-choice"; mode: SpectatorMode }
  | { kind: "finale-interview"; stance: ExitStance; message?: string }
  // --- finale (0037) ---
  | { kind: "finale-statement"; statement: string }
  | { kind: "finale-answer"; appeal: FinaleAppeal }
  // --- finale (E37): scoreless free text — the juror's moment, never a tally input ---
  | { kind: "juror-question"; question?: string }
  | { kind: "juror-vote"; vote: EntityId }
  // --- self-eviction (0061): ONLY `confirmed:true` executes the irreversible walk-out (§4.2) ---
  | { kind: "self-evict"; confirmed: boolean }
  // --- secret veto (0025 reactive redesign): the player, on the block and secretly holding the
  // one-time safety, chooses to play it (pull off the block) or hold it for later ---
  | { kind: "secret-veto"; use: boolean };

/** Draw this week's competition from the curated library (0042) — seeded, no immediate repeats.
 *  `ctx.expandedComps` (0126) folds in the extra mechanic pool; off ⇒ the base 12 (byte-identical). */
const drawFor = (s: LiveSeasonState, phase: CompetitionPhase, rng: RandomnessSource, ctx: SeasonCtx): CompetitionDef =>
  drawCompetition(phase, s.week, rng, s.compHistory?.[phase] ?? [], ctx.expandedComps);

/** Record a resolved draw into the persisted history (0030) — what the NEXT draw must avoid. */
function recordDraw(s: LiveSeasonState, phase: CompetitionPhase, def: CompetitionDef): void {
  (s.compHistory ??= { hoh: [], veto: [] })[phase].push(def.id);
}

/** The eligible HOH field (Final 3 lifts the outgoing-HOH restriction — everyone plays). */
function hohField(s: LiveSeasonState, ctx: SeasonCtx): EntityId[] {
  const finalThree = s.active.length === 3;
  return eligibleForHOH(weekState(s, ctx), finalThree ? { specialAllowsOutgoingHoh: true } : undefined);
}

/**
 * Resolve a competition with the EXACT pre-staging single-shot RNG consumption — the def is drawn
 * (one rng draw) then `resolveCompetition` rolls over the full field DIRECTLY on the beat rng. This
 * is BYTE-IDENTICAL to the non-staged model for the same seed/field, so the crown (and therefore the
 * whole downstream game trajectory) is unchanged: the staged rounds are pure presentation over it.
 *
 * Returns the drawn def, the field (original order), and the full `CompetitionResult` (winner +
 * scores) — the scores feed the PURE, zero-rng `eliminationOrder` that drives the visible drop drama.
 */
function resolveComp(
  field: EntityId[], def: CompetitionDef, ctx: SeasonCtx, rng: RandomnessSource, playerApproach: Intent, forceSecondary = false,
): CompetitionResult {
  // 0127: a hybrid comp (def carries a `secondary`) blends that secondary aptitude into the score ONLY
  // when `ctx.mixedComps` is on; off ⇒ undefined ⇒ the pure single stat ⇒ byte-identical.
  const secondaryStat = (ctx.mixedComps || forceSecondary) ? def.secondary : undefined; // 0128 Part 2 passes the blend directly (no 0127 flag dependency)
  return resolveCompetition(
    competitorsOf(field, ctx), def.type, roundIntents(field, ctx, playerApproach), rng, undefined, secondaryStat,
  );
}

/**
 * The HOH competition outcome, NON-mutating — the eligible field + the engine-decided winner, drawn
 * with the baseline RNG pattern (def draw then resolve). `peekCompetition`/`runCompetition` reuse this
 * to PREVIEW the same crown the loop commits (single authority, B37), with the player competing (the
 * preview default; the committed approach is folded into the live crown when the comp resolves).
 */
function resolveHoh(s: LiveSeasonState, ctx: SeasonCtx, rng: RandomnessSource, playerApproach: Intent = "compete"): { def: CompetitionDef; field: EntityId[]; result: CompetitionResult } {
  const def = drawFor(s, "hoh", rng, ctx);
  const field = hohField(s, ctx);
  return { def, field, result: resolveComp(field, def, ctx, rng, playerApproach) };
}

/**
 * Resolve the HOH competition beat — a STAGED elimination (0006 staged-rounds evolution) that is a
 * PRESENTATION-ONLY re-telling of the single calibrated outcome. The comp is resolved ONCE (the moment
 * the player commits their approach, or immediately when they aren't in the field) with the baseline
 * RNG consumption, then the field narrows one houseguest at a time until the crowned winner stands.
 * Pauses for the player's per-round approach (`comp-round`) BEFORE the staged outcome resolves; that
 * first approach is the binding intent the single roll honors (anti-sycophancy, committed-before).
 */
/** 0128 - the field for a part of the three-part Final HOH: Part 1 all three; Part 2 the two Part-1 losers; Part 3 the two part-winners. */
function finalHohPartField(s: LiveSeasonState, ctx: SeasonCtx, part: 1 | 2 | 3): EntityId[] {
  if (part === 1) return hohField(s, ctx);
  if (part === 2) return s.active.filter((id) => id !== s.p1Winner);
  return [s.p1Winner!, s.p2Winner!];
}

/** 0128 - the competition for a part: endurance (physical) / physical+mental hybrid / quiz (mental), drawn (one rng draw) from the HOH library. */
export function finalHohPartDef(part: 1 | 2 | 3, rng: RandomnessSource): CompetitionDef {
  const matches = (d: CompetitionDef): boolean =>
    d.phase === "hoh" && (part === 1 ? d.type === "endurance" : part === 2 ? (d.governing === "physical" && d.secondary === "mental") : d.type === "quiz");
  const pool = [...COMPETITION_LIBRARY, ...COMPETITION_LIBRARY_PLUS].filter(matches);
  return pool[rng.int(pool.length)]!;
}

function resolveHohBeat(s: LiveSeasonState, ctx: SeasonCtx, rng: RandomnessSource): BeatEvent | null {
  const threePart = !!ctx.finalHohThreePart && s.active.length === 3;
  const part: 1 | 2 | 3 = threePart ? (s.finalHohPart ?? 1) : 1;
  if (!s.competition) {
    const field = threePart ? finalHohPartField(s, ctx, part) : hohField(s, ctx);
    // Anti-sycophancy: the player commits their approach BEFORE the comp resolves. If they are in the
    // field and have not committed one, pause for round 1 (no rng consumed — exactly the baseline pause).
    if (field.includes(ctx.player) && s.compIntent === undefined) {
      s.pending = { kind: "comp-round", by: ctx.player, comp: "hoh-competition", round: 1, stillIn: [...field], binding: true };
      return null;
    }
    // Resolve ONCE with the baseline RNG pattern (byte-identical crown), then stage the reveals. The
    // committed `s.compIntent` (round 1's approach) is NOT cleared here — `advanceCompetition` consumes
    // it as round 1's expression and reveals the first drop, so round 1 is asked exactly once.
    const def = threePart ? finalHohPartDef(part, rng) : drawFor(s, "hoh", rng, ctx);
    const result = resolveComp(field, def, ctx, rng, s.compIntent ?? "compete", threePart && part === 2);
    if (threePart) s.finalHohPart = part; // 0128: the live part (crownCompetition advances it); persisted so a restart resumes
    else recordDraw(s, "hoh", def); // committed for the week — the next hoh draw avoids it (0042)
    s.vetoComp = undefined;
    s.competition = beginStaged(s, ctx, rng, "hoh-competition", def, field, result);
    freezeCompTheme(s); // L-F4 (#1743): pin the theme inputs at draw so the presentation can't flip mid-comp
  }
  return advanceCompetition(s, ctx);
}

/**
 * L-F4 (#1743) — freeze the 0125 theme's live-varying inputs (week + twist cycle) at DRAW/STAGE time,
 * onto the just-created staged-comp state. The adapter's `themedScaffold` reads these frozen inputs for
 * an in-progress comp instead of the live `week`/`twist`, so the surfaced name/premise stays byte-
 * identical across every round even if the twist flips to "running" mid-comp (a double-eviction night).
 * Presentation-only: pure projection inputs — no rng, no fold, byte-identical to before when the twist
 * never changes (the common case) and off entirely when themes are off.
 */
function freezeCompTheme(s: LiveSeasonState): void {
  if (!s.competition) return;
  s.competition.themeWeek = s.week;
  s.competition.themeCycle = s.twist?.phase === "running" ? 1 : 0;
  // Pin the presentation SOURCE too: whether this comp is dressed by authored #1400 fiction or the frozen
  // seeded theme is decided NOW. In normal play no fiction exists yet at draw ⇒ false ⇒ the comp is
  // committed to the seeded theme, and a late first-fiction write-back cannot re-skin it mid-comp.
  const f = s.competitionFiction;
  s.competition.themeAuthored = !!(f && f.comp === s.competition.comp && f.week === s.week);
}

/**
 * L-F4 (#1743) — LAZY-FREEZE for a LEGACY save. An in-progress staged comp loaded from a pre-#1743 save
 * carries no frozen theme fields, so every read would fall back to MUTABLE live state (a twist-phase
 * change or a late fiction write-back could then re-skin its remaining rounds — the flip this feature
 * closes). Freeze them ONCE, at the FIRST read, from the current live state, and persist onto the comp,
 * so from that point the presentation is pinned for the comp's remaining rounds. STRICTLY idempotent: a
 * comp that already carries the fields is NEVER re-frozen (a later live twist/week change must not shift
 * an already-pinned comp), and a pre-stage / no-comp state is left to live resolution. Presentation-only
 * (freezeCompTheme consumes no rng, folds nothing) — the frozen values equal what a fresh draw would have
 * pinned, so nothing calibration-relevant changes. Called at the top of every presentation read.
 */
export function ensureCompThemeFrozen(s: LiveSeasonState): void {
  const c = s.competition;
  if (!c || c.themeWeek !== undefined) return; // no staged comp, or already frozen ⇒ never re-freeze
  freezeCompTheme(s);
}

/**
 * Resolve the veto competition beat — STAGED exactly like the HOH beat (the chip-draw ceremony, E35,
 * still precedes it). Presentation-only over the single calibrated outcome; crowns the Power of Veto.
 */
function resolveVetoComp(s: LiveSeasonState, ctx: SeasonCtx, rng: RandomnessSource): BeatEvent | null {
  if (!s.competition) {
    const field = s.vetoField!;
    if (field.includes(ctx.player) && s.compIntent === undefined) {
      s.pending = { kind: "comp-round", by: ctx.player, comp: "veto-competition", round: 1, stillIn: [...field], binding: true };
      return null;
    }
    // The SAME comp drawn at stage A (0042) — looked up, never re-drawn (restart-safe, 0030).
    const def = (s.vetoComp ? competitionById(s.vetoComp) : undefined) ?? drawFor(s, "veto", rng, ctx);
    const result = resolveComp(field, def, ctx, rng, s.compIntent ?? "compete");
    recordDraw(s, "veto", def); // committed for the week — the next veto draw avoids it (0042)
    // `s.compIntent` (round 1's approach) carries into advanceCompetition as round 1's expression.
    s.competition = beginStaged(s, ctx, rng, "veto-competition", def, field, result);
    freezeCompTheme(s); // L-F4 (#1743): pin the theme inputs at draw so the presentation can't flip mid-comp
  }
  return advanceCompetition(s, ctx);
}

/**
 * Build the staged sub-state from the ALREADY-RESOLVED outcome: winner fixed, drop order derived
 * PURELY from the roll's scores (zero rng), so the reveals can never perturb anything (PR #395).
 *
 * C1 (#1788): when `ctx.wipeoutReelEnabled`, ALSO precomputes each dropped entrant's `failureStyle`
 * fact from a stream FORKED off `rng` right here — AFTER `resolveComp` already fixed the crown/scores,
 * and BEFORE anything downstream draws from `rng` again. `RandomnessSource.fork` derives its child
 * purely from the parent's CURRENT internal position + a label — it never calls the parent's `next()`
 * — so this consumes ZERO draws from `rng` itself; the outcome axis (winner, `dropOrder`, every later
 * seeded roll) is untouched whether the flag is on or off (`stagedTrajectoryNeutral.test.ts`).
 */
function beginStaged(
  s: LiveSeasonState, ctx: SeasonCtx, rng: RandomnessSource,
  comp: "hoh-competition" | "veto-competition", def: CompetitionDef, field: EntityId[], result: CompetitionResult,
): CompetitionProgress {
  const dropOrder = eliminationOrder(field, result);
  const progress: CompetitionProgress = {
    comp, type: def.type, field: [...field], stillIn: [...field], round: 1, eliminated: [],
    winner: result.winner, dropOrder,
  };
  if (ctx.wipeoutReelEnabled && dropOrder.length > 0) {
    const wipeoutRng = rng.fork(`wipeout-reel:${comp}:${s.week}`);
    const facts: Record<EntityId, WipeoutFailureFact> = {};
    for (const id of dropOrder) {
      facts[id] = deriveFailureFact(
        wipeoutRng, ctx.archetypeOf?.(id), ctx.emotionalOf?.(id), def.format,
        priorWipeoutCount(s.wipeoutHistory?.[id]),
      );
    }
    progress.failureStyles = facts;
  }
  return progress;
}

/**
 * Staged-competition pacing (audit 2026-06-20, owner ruling): an endurance comp reveals its drops in
 * FEWER, BIGGER rounds — roughly this many rounds total regardless of field size — instead of one drop
 * per round (which made a 15-player HOH a ~14-round slog, repeated for the veto every week). The batch
 * size is sized so the round count lands near this target; small fields (a six-player veto) stay near
 * one drop per round, which is already inside the 4-8 band. Tunable.
 */
const STAGED_TARGET_ROUNDS = 5;

/** Drops to reveal per staged round so a comp resolves in ~STAGED_TARGET_ROUNDS rounds (≥1). */
function stagedBatchSize(fieldSize: number): number {
  return Math.max(1, Math.ceil((fieldSize - 1) / STAGED_TARGET_ROUNDS));
}

/**
 * Staged-eviction-reveal pacing (live-verify 2026-06-27, mirrors the staged-comp ruling above): a
 * 14-voter eviction read one ballot per `advanceGame` is a ~14-advance slog of mostly-empty
 * "producers deliberating" beats — and that flood of inert beats lets the narration model race ahead
 * of the engine and pre-announce the result. Instead the votes are revealed in FEWER, BIGGER batches —
 * roughly this many rounds total — so a big eviction lands in ~4-8 reveal beats. A small ballot set (a
 * Final-3/4 two-or-three-vote eviction) stays at one ballot per round, already inside the band. Like the
 * comp staging this is PRESENTATION ONLY: the same seeded reveal ORDER, the same precomputed tally, the
 * same evictee on the same last ballot, and ZERO randomness consumed — only how many ballots a single
 * advance reveals changes. Tunable.
 */
// PO ruling (Ryne, 2026-11-04): the eviction-night vote reveal is ALL IN ONE TURN. Once the player has voted (their card confirmed) every anonymized
// ballot is read in ONE reveal beat (the narrator reads them all in one suspenseful message), then the result beat. The 5-round drip made eviction night a
// ~10-turn slog and let the narrator voice the finished eviction while the engine was still reading ballots (the dominant scene-cut class in the 2026-11-04
// A/B). Still PRESENTATION ONLY: same seeded reveal order, same precomputed tally, same evictee, ZERO randomness; still anonymized (never the voter).
const STAGED_EVICTION_TARGET_ROUNDS = 1;

/** Ballots to reveal per staged eviction round so the votes stage resolves in ~target rounds (≥1). */
function stagedEvictionBatchSize(voteCount: number): number {
  return Math.max(1, Math.ceil(voteCount / STAGED_EVICTION_TARGET_ROUNDS));
}

/**
 * The anonymized summary of the ballots read in ONE batched reveal round (E12: names the nominee a
 * ballot evicts, NEVER the voter, and never a cumulative tally or the evictee). Each ballot in the
 * batch reads individually, IN REVEAL ORDER — "a vote to evict X. a vote to evict Y. a vote to evict
 * X." — rather than pre-summed into "N votes to evict X" (BB-11, audit 2026-07-03): a live vote reveal
 * is read one card at a time, building suspense as the count grows; a pre-aggregated clump reads like
 * a raffle result and invited the narrator to just recap the total instead of playing the reveal.
 */
function batchedRevealContent(e: EvictionProgress, from: number, to: number): string {
  const parts: string[] = [];
  for (let i = from; i < to; i++) {
    const votedFor = e.voteOf[e.revealOrder[i]!]!;
    parts.push(`a vote to evict ${votedFor}.`);
  }
  return parts.join(" ");
}

/**
 * Advance the staged competition ONE step (0006 staged-rounds evolution) — PRESENTATION ONLY. The
 * outcome (winner + drop order) is already fixed; this reveals a batch of eliminations at a time,
 * narrowing the field, WITHOUT pausing the player. The binding approach was declared ONCE up front
 * (round 1, in resolveHohBeat/resolveVetoComp); the later reveals are drama over an already-decided
 * result, so re-asking each round was removed (PO review 2026-06-28 — it was non-binding flavor). The
 * engine beat/RNG stream is byte-identical to the non-staged model (it consumes NO randomness here).
 * When one houseguest remains, crown them (HOH / veto holder) and transition the beat.
 */
/**
 * Format-appropriate elimination-round vocabulary (COMP-3/BB-9, audit 2026-07-03): every staged comp
 * previously described its drops with the SAME wall-endurance grammar ("X is eliminated") regardless
 * of the drawn def's format — a race, a scavenger hunt, and a trivia buzzer all read identically even
 * though `CompetitionFormat` was already carried on every def. PRESENTATION ONLY: only the verb
 * changes; the drop order, the winner, and the rng stream are byte-identical (the
 * `stagedTrajectoryNeutral` guard still holds — this never touches `dropOrder`/`eliminated`/rng).
 */
const ELIMINATION_VERB: Record<CompetitionFormat, { one: string; many: string }> = {
  endurance: { one: "drops", many: "drop" },
  skill: { one: "falls behind and is out", many: "fall behind and are out" },
  quiz: { one: "answers wrong and is out", many: "answer wrong and are out" },
  puzzle: { one: "comes up short and is out", many: "come up short and are out" },
  crapshoot: { one: "comes up empty-handed and is out", many: "come up empty-handed and are out" },
  social: { one: "misreads the room and is out", many: "misread the room and are out" },
};

/** The per-round drop content, format-varied when the drawn def is known (falls back to the original
 *  "is/are eliminated" phrasing when it isn't — e.g. an older persisted save with no compHistory entry). */
function eliminationContent(dropped: readonly EntityId[], stillInCount: number, format?: CompetitionFormat): string {
  const verb = format ? ELIMINATION_VERB[format] : undefined;
  if (!verb) {
    return dropped.length === 1
      ? `${dropped[0]} is eliminated; ${stillInCount} remain`
      : `${dropped.join(", ")} are eliminated; ${stillInCount} remain`;
  }
  return dropped.length === 1
    ? `${dropped[0]} ${verb.one}; ${stillInCount} remain`
    : `${dropped.join(", ")} ${verb.many}; ${stillInCount} remain`;
}

function advanceCompetition(s: LiveSeasonState, ctx: SeasonCtx): BeatEvent | null {
  const c = s.competition!;
  // The crowned winner stands alone — crown them.
  if (c.stillIn.length <= 1) return crownCompetition(s);
  // Intent is asked ONCE, up front (round 1, in resolveHohBeat/resolveVetoComp) — that single binding
  // approach is what the one calibrated roll honored. The later elimination rounds are PRESENTATION ONLY
  // (the outcome is already fixed), so we no longer pause to re-ask the player each round (PO review
  // 2026-06-28: the per-round ask was non-binding flavor that only added taps it could never change).
  // The reveals now play out as drama without interrupting the player for a choice that cannot matter.
  s.compIntent = undefined; // round 1's committed approach is consumed on the first reveal, then cleared
  // Reveal a BATCH of the scheduled drops this round — FEWER, BIGGER rounds (audit 2026-06-20 owner
  // ruling: ~4-8 rounds per comp, not one drop per round which made a 15-player HOH a ~14-round slog).
  // PRESENTATION ONLY: the winner and the full drop ORDER are unchanged (still the single up-front
  // roll), so the trajectory/calibration is byte-identical — only how many drops group per reveal
  // changes. The winner is never in `dropOrder`, so the crown survives every batch by construction.
  const remaining = c.dropOrder!.length - c.eliminated.length;
  const batch = Math.min(stagedBatchSize(c.field.length), remaining);
  const droppedThisRound: EntityId[] = [];
  for (let i = 0; i < batch; i++) {
    const dropped = c.dropOrder![c.eliminated.length]!;
    c.stillIn = c.stillIn.filter((id) => id !== dropped);
    c.eliminated.push(dropped);
    droppedThisRound.push(dropped);
  }
  c.round += 1;
  if (c.stillIn.length === 1) return crownCompetition(s);
  // #1400: when the model authored + the engine VALIDATED fiction for THIS comp, tell the drop as the
  // model's per-round fiction (looked up by the exact dropped ids) instead of the deterministic 0042
  // template. PRESENTATION ONLY — `droppedThisRound` and its order come straight from the fixed
  // `dropOrder`, so this can never rename who goes or reorder them (`comp-elimination` is NOT a
  // TRAJECTORY_BEAT; the winner/order/rng are untouched). Absent/mismatched fiction ⇒ the template.
  const authored = fictionalDropContent(s, c, droppedThisRound);
  const template = eliminationContent(droppedThisRound, c.stillIn.length, competitionDefFor(s, c)?.format);
  // C1 (#1788): append each dropped entrant's failure-style FACT-TO-VOICE after the template — always-on
  // content (not a callable tool, per the I6 lesson), exactly the same delivery mechanism as the format
  // verb above. Only when no authored fiction already dressed this round (avoids a templated sentence
  // clashing with the model's own richer prose for the SAME drop — #1400's precedence rule: authored
  // fiction is never displaced) and the layer is on.
  const wipeout = authored ? undefined : wipeoutContentFor(c, droppedThisRound);
  // C1 (#1788, P1 fixes — PR #1831 review, both leaks): record the reveal into the season-spanning,
  // monotonic history ONLY when the failure-style text actually RIDES the emitted beat below.
  // INVARIANT: wipeoutHistory ⊆ AIRED reel moments. Two paths previously violated it:
  //   (1) the FINAL batch of a comp (narrows `stillIn` to 1) returns via `crownCompetition` above —
  //       a crown beat, never a `comp-elimination` beat (COMP-13: the crown carries no drop flavor) —
  //       so its facts never air; recording them is prevented by this append sitting PAST that return;
  //   (2) an AUTHORED-fiction round (#1400) emits the model's own prose INSTEAD of the reel text
  //       (`wipeout` is undefined when `authored` is set), so its facts never air either; recording
  //       them is prevented by gating on `wipeout` — the exact composed text the beat carries.
  // Either leak let a houseguest's NEXT wipeout wrongly read as a callback ("the second time this
  // season") to a moment the player never saw. Gating on `wipeout` keeps `priorWipeoutCount` — and the
  // callback clause — an honest count of what actually aired. Post-roll bookkeeping either way: no rng,
  // no fold, no effect on `dropOrder`/the winner (`stagedTrajectoryNeutral.test.ts` stays the guard).
  if (wipeout) {
    for (const dropped of droppedThisRound) {
      const fact = c.failureStyles?.[dropped];
      if (fact) appendWipeoutHistory((s.wipeoutHistory ??= {}), dropped, { week: s.week, comp: c.comp, text: fact.text });
    }
  }
  return {
    // A per-round DROP — NOT the crown (which keeps the comp beat key so its consequence still folds).
    // `comp-elimination` falls through every commit side-effect switch (no fold, no soul inflection, no
    // confessional, no rng) — so a reveal is inert to the game state, keeping the trajectory unchanged.
    beat: "comp-elimination",
    content: authored ?? (wipeout ? `${template} ${wipeout}` : template),
    participants: [...droppedThisRound, ...c.stillIn],
  };
}

/**
 * C1 (#1788) — the composed Wipeout Reel text for THIS round's drops, or `undefined` when the layer is
 * off (no `failureStyles` computed) or a defensive miss (a dropped id somehow has no precomputed fact —
 * `beginStaged` covers every `dropOrder` entry when the flag is on, so this is a pure safety net).
 */
function wipeoutContentFor(c: CompetitionProgress, droppedThisRound: readonly EntityId[]): string | undefined {
  if (!c.failureStyles) return undefined;
  const parts: string[] = [];
  for (const id of droppedThisRound) {
    const fact = c.failureStyles[id];
    if (fact) parts.push(fact.text);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * #1400 — the authored fiction line(s) for the ids dropped THIS round, or `undefined` when no VALIDATED
 * fiction is stored for the current comp. PRESENTATION ONLY: the engine looks each dropped id up in the
 * stored, drop-order-validated `eliminations` map — so the fiction it tells is exactly the fiction the
 * model wrote for the houseguest the ENGINE decided drops here. Every dropped id is guaranteed present
 * (validation covered all of `dropOrder`), but a defensive miss falls back to the template.
 */
function fictionalDropContent(
  s: LiveSeasonState, c: CompetitionProgress, droppedThisRound: readonly EntityId[],
): string | undefined {
  const f = s.competitionFiction;
  if (!f || f.comp !== c.comp || f.week !== s.week) return undefined;
  const lineOf = new Map(f.eliminations.map((e) => [e.id, e.fiction]));
  const parts: string[] = [];
  for (const id of droppedThisRound) {
    const line = lineOf.get(id);
    if (!line) return undefined; // a gap in the authored fiction ⇒ fall back to the deterministic template
    parts.push(line);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** The crowned winner stands alone (HOH / veto holder); the beat transitions + the resume is credited. */
function crownCompetition(s: LiveSeasonState): BeatEvent {
  const c = s.competition!;
  // The CALIBRATED winner — the up-front single-roll crown (byte-identical to the non-staged model). A
  // trivial one-competitor field never decided an outcome — fall back to the lone id.
  const winner = c.winner ?? c.stillIn[0]!;
  s.competition = undefined;
  s.compIntent = undefined;
  s.competitionFiction = undefined; // #1400: the authored fiction is per-comp — clear it as the comp crowns
  creditResume(s, winner); // a broadcast win — the jury's gameRespect read counts it (2026-06-11)
  // NOTE (COMP-13, audit 2026-07-03): we deliberately do NOT append the drawn def's name to this
  // beat's content — `hoh-competition`/`veto-competition` are TRAJECTORY_BEATS in
  // tests/unit/stagedTrajectoryNeutral.test.ts, which asserts byte-identical ceremony CONTENT against
  // a frozen pre-#395 baseline fixture (tests/unit/fixtures/liveSeasonBaseline.ts) that never carries
  // the name. The comp's name already reaches the model via `runCompetition`/`peekCompetition`
  // (CompetitionPeek.def.name) earlier in the same turn; the `veto-draw` beat (below, not a
  // TRAJECTORY_BEAT) and the per-round `comp-elimination` verb DO carry the drawn def's flavor.
  if (c.comp === "hoh-competition") {
    const finalThree = s.active.length === 3;
    // 0128: Parts 1 and 2 of the three-part Final HOH ADVANCE the tournament - the structural beat stays `hoh-competition`; only Part 3 crowns the Final HOH below.
    if (finalThree && s.finalHohPart === 1) {
      s.p1Winner = winner; s.finalHohPart = 2;
      return { beat: "final-hoh-part", content: `${winner} wins Part 1 of the final Head of Household and skips ahead to Part 3`, participants: [winner, ...c.field.filter((id) => id !== winner)] };
    }
    if (finalThree && s.finalHohPart === 2) {
      s.p2Winner = winner; s.finalHohPart = 3;
      return { beat: "final-hoh-part", content: `${winner} wins Part 2 of the final Head of Household and advances to Part 3`, participants: [winner, ...c.field.filter((id) => id !== winner)] };
    }
    if (finalThree && s.finalHohPart === 3) { s.finalHohPart = undefined; s.p1Winner = undefined; s.p2Winner = undefined; } // the tournament is over
    s.hoh = winner;
    s.beat = finalThree ? "final-eviction" : "nominations"; // Final 3 (0045) skips noms/veto
    return {
      beat: "hoh-competition",
      content: `${winner} wins ${finalThree ? "the final Head of Household" : "Head of Household"}`,
      participants: [winner],
    };
  }
  s.vetoHolder = winner; s.beat = "veto-ceremony";
  // The crown event carries the FULL field in its ORIGINAL draw order (the participants) so the
  // contested-loss soul inflection (evolveFromBeat's veto case) fires for the whole six, byte-identically
  // to the single-shot model (whose event was `participants: field`). Order matters: the inflect/fold
  // paths must consume identically to keep the diversity-isolation golden stream byte-stable.
  return { beat: "veto-competition", content: `${winner} wins the Power of Veto`, participants: [...c.field] };
}

/**
 * Stage A of the veto beat (E35): the chip draw is a WITNESSED ceremony of its own — the player
 * experiences who plays and who held Houseguest's Choice, before any winner exists. Stores the
 * drawn comp + the field; the competition itself resolves on a later advance (`resolveVetoComp`),
 * after any player intent declaration. Pauses (pending set, event still returned) when the
 * PLAYER drew the Houseguest's Choice chip (B45).
 */
function resolveVetoDraw(s: LiveSeasonState, ctx: SeasonCtx, rng: RandomnessSource): BeatEvent {
  // The comp is drawn FIRST (one rng draw) and held in `vetoComp` so every later stage —
  // including a restart mid-pause (0030) — resolves the SAME drawn competition (0042).
  const def = drawFor(s, "veto", rng, ctx);
  s.vetoComp = def.id;
  const draw = vetoParticipants(weekState(s, ctx), rng, {
    houseguestsChoiceChip: true,
    choose: (holder, cands) => ctx.rel.chooseStrongestBond(holder, cands, rng, undefined, ctx.hcMemoryFor ? (c) => ctx.hcMemoryFor!(c, holder) : undefined),
    playerChoosesOwn: ctx.player, // the player picks their own sixth player; the engine never reads their bonds
  });
  s.vetoField = draw.participants;
  const hc = draw.houseguestsChoice;
  if (hc && hc.picked === undefined) {
    // The player drew Houseguest's Choice (B45): the draw is still a witnessed beat — the five
    // drawn players and the chip in the player's hand are public — and the loop pauses for THEM
    // to name the sixth. The candidates were snapshotted AFTER the full draw (C1).
    s.pending = { kind: "houseguests-choice", by: ctx.player, options: hc.candidates };
    return {
      // COMP-13 (audit 2026-07-03): name the drawn comp in its own ground-truth content — `veto-draw`
      // is not a `TRAJECTORY_BEATS` member (stagedTrajectoryNeutral.test.ts), so this is content-safe.
      beat: "veto-draw",
      content: `the veto players are drawn for ${def.name}: ${draw.participants.join(", ")} — ${hc.holder} draws Houseguest's Choice and will name the sixth houseguest to play`,
      participants: [...draw.participants],
    };
  }
  const hcNote = hc?.picked !== undefined
    ? ` — ${hc.holder} draws Houseguest's Choice and picks ${hc.picked}`
    : "";
  return {
    beat: "veto-draw",
    content: `the veto players are drawn for ${def.name}: ${draw.participants.join(", ")}${hcNote}`,
    participants: [...draw.participants],
  };
}


/** The current competition beat's deterministic outcome (single authority, B37) — or null if the
 *  loop is not at a competition beat. PURE: it does not advance the loop; `advance` crowns the same
 *  winner (same seed) when the beat resolves. */
export interface CompetitionPeek {
  beat: "hoh-competition" | "veto-competition";
  type: CompetitionType;
  /** The drawn library definition (0042): name, format, and the Vault-free narrative scaffold. */
  def: CompetitionDef;
  field: EntityId[];
  winner: EntityId;
}
export function peekCompetition(s: LiveSeasonState, ctx: SeasonCtx, rng: RandomnessSource): CompetitionPeek | null {
  if (s.pending || s.finished) return null;
  // If the staged comp is ALREADY in progress, the outcome is fixed — the preview reports the SAME
  // crown the loop will reveal (single authority, B37). The drop reveals never move it.
  if (s.competition?.winner) {
    const c = s.competition;
    const def = competitionDefFor(s, c);
    if (!def) return null;
    return { beat: c.comp, type: c.type, def, field: [...c.field], winner: c.winner! };
  }
  // The comp has NOT resolved yet: preview the crown with the player COMPETING (the default — `advance`
  // crowns the same one when the player competes), replaying the exact baseline RNG consumption from a
  // fresh position-zero stream (def draw then resolve), so the preview and the live crown agree exactly.
  if (s.beat === "hoh-competition") {
    const { def, field, result } = resolveHoh(s, ctx, rng);
    return { beat: s.beat, type: def.type, def, field, winner: result.winner };
  }
  if (s.beat === "veto-competition") {
    // E35: before the chips are drawn there IS no field — nothing to preview (the draw is a
    // witnessed ceremony of its own). Once drawn, the preview replays the comp exactly: the same
    // stored comp over the same completed field, with no def draw (it was drawn at stage A).
    if (!s.vetoField || !s.vetoComp) return null;
    const def = competitionById(s.vetoComp);
    if (!def) return null;
    return { beat: s.beat, type: def.type, def, field: s.vetoField, winner: resolveComp(s.vetoField, def, ctx, rng, "compete").winner };
  }
  return null;
}

/** The library def backing an in-progress staged competition — the LAST recorded draw for its phase. */
function competitionDefFor(s: LiveSeasonState, c: CompetitionProgress): CompetitionDef | undefined {
  const phase: CompetitionPhase = c.comp === "hoh-competition" ? "hoh" : "veto";
  const recent = s.compHistory?.[phase] ?? [];
  const last = recent[recent.length - 1];
  return last ? competitionById(last) : undefined;
}

/**
 * L-F4 (#1743) — THE PINNED COMP PRESENTATION. Once a competition is drawn, its format/premise is FIXED
 * for the whole event; this is the single engine-side pin the outward ground truth surfaces on EVERY
 * comp-beat turn (the first reveal AND every staged `comp-elimination` round), so the narrator can never
 * re-author "what kind of comp this is" turn to turn (the finding: "Piece by Piece" on one beat, "Center-
 * Ring Trivia" the next — a format flip-flop within one comp). COMP-13 already pins the comp NAME + hard-
 * rejects a winner rename (`validateCompetitionFiction`); this pins the FORMAT + PREMISE the same way.
 *
 * Enforcement mirrors those guards' HARDNESS where a write-back exists and can only be SOFT where one
 * cannot:
 *   • FORMAT is HARD-pinned — always the drawn library `def.format`; the #1400 write-back never carries a
 *     format, so the model literally cannot rename it (the analogue of the winner-rename rejection).
 *   • The #1400 authored PREMISE is HARD-pinned per comp — stored once, immutable until crown (the
 *     `already-authored` reject in `validateCompetitionFiction`), so it too is stable across rounds.
 *   • The free-narration (library-floor) PREMISE is SOFT-pinned — fed on every comp-beat turn's ground
 *     truth. A hard engine-side REJECT of the narration is architecturally impossible: narration runs in
 *     the FE and the engine only emits Vault-free ground truth and never receives the prose, so there is
 *     nothing to reject; feeding the same premise every turn IS the structural pin for that path.
 *
 * Pure (NO rng — safe for the observational `whereabouts` read): a lookup of the recorded draw / vetoComp
 * plus the stored authored fiction. Returns `null` before a def is drawn (the HOH comp before it stages —
 * its premise genuinely does not exist yet) and off a comp beat. Vault-free (public flavor only — never a
 * score / lean / number). The `def` is surfaced so the adapter can dress it in the 0125 seeded theme,
 * matching `runCompetition`'s precedence (model fiction > seeded theme > 0042 library floor).
 */
export interface CompetitionPresentation {
  comp: "hoh-competition" | "veto-competition";
  /** The drawn 0042 library def — the floor the adapter themes; carries the canonical `format`. */
  def: CompetitionDef;
  /** The comp NAME the ground truth shows: the #1400 authored theme, else the library name (pre-theme). */
  name: string;
  /** The comp FORMAT — ALWAYS `def.format`; never model-overridable (the HARD format pin). */
  format: CompetitionFormat;
  /** The comp PREMISE: the #1400 authored premise, else the library premise (pre-theme). */
  premise: string;
  /** Whether #1400 fiction is pinned for THIS comp (the adapter then skips the theme skin, like runCompetition). */
  authored: boolean;
}

export function competitionPresentation(s: LiveSeasonState): CompetitionPresentation | null {
  // L-F4 (#1743): a legacy in-progress comp (no frozen fields) is pinned ONCE here, on first read, so it
  // can't flip for its remaining rounds. A comp drawn under this change is already frozen ⇒ a no-op.
  ensureCompThemeFrozen(s);
  let comp: "hoh-competition" | "veto-competition" | undefined;
  let def: CompetitionDef | undefined;
  if (s.competition) {
    // A staged comp is running — the def is the recorded draw for its phase (a pure lookup).
    comp = s.competition.comp;
    def = competitionDefFor(s, s.competition);
  } else if (s.pending && (s.pending.kind === "comp-intent" || s.pending.kind === "comp-round")) {
    // A comp has surfaced but not yet staged. The VETO def was drawn at the chip-draw stage (`vetoComp`);
    // the HOH def is not drawn until the comp resolves, so there is no premise to pin yet (return null).
    comp = s.pending.comp;
    if (comp === "veto-competition") def = s.vetoComp ? competitionById(s.vetoComp) : undefined;
  }
  if (!comp || !def) return null;
  const f = s.competitionFiction;
  const fictionPresent = !!(f && f.comp === comp && f.week === s.week);
  // L-F4 (#1743) — the presentation SOURCE is FROZEN at draw for a staged comp, so a first-fiction
  // write-back that lands AFTER staged rounds began cannot retroactively re-skin the in-progress comp
  // (the authored-fiction variant of the flip-flop). Honor the frozen decision; fall back to the live
  // read only for a legacy save (no frozen field) or a pre-stage comp (no `s.competition`). A frozen
  // "authored" still requires the fiction to actually be present (it always is — cleared only at crown).
  const sourceAuthored = s.competition && s.competition.themeAuthored !== undefined
    ? s.competition.themeAuthored
    : fictionPresent;
  const authored = sourceAuthored && fictionPresent;
  return {
    comp, def,
    name: authored ? f!.theme : def.name,
    format: def.format, // the HARD pin — the model can never rename the format
    premise: authored ? f!.premise : def.narrative.premise,
    authored,
  };
}

// --- Feature #1400: generative competition design (the model DRESSES the fixed roll) -----------------

/**
 * #1400 — the pure engine's "what to hand the model" data for the CURRENTLY-STAGING competition: the
 * comp + type + the FULL field + the ALREADY-FIXED winner + the ALREADY-FIXED drop order + the drawn
 * 0042 library def (the scaffold the model riffs ON). `null` unless a staged comp has RESOLVED its roll
 * (winner + dropOrder set) — the model dresses a decided result, so there is nothing to hand it before
 * the roll commits (the structural "no outcome-adjacent text before the roll" ordering). Vault-free by
 * construction (ids + the public drop ORDER + public flavor only — never a score/lean/number). The
 * adapter projects the ids to names for the outward view.
 */
export interface CompetitionStagingData {
  comp: "hoh-competition" | "veto-competition";
  type: CompetitionType;
  field: EntityId[];
  winner: EntityId;
  /** The fixed elimination order of the losers (earliest-out first) — the model authors one line per entry. */
  dropOrder: EntityId[];
  /** The drawn 0042 library def (name/format/narrative scaffold) — the deterministic floor + the model's muse. */
  def?: CompetitionDef;
  /**
   * Whether VALIDATED fiction is ALREADY stored for THIS (comp, week). This is the persistent, engine-owned
   * "author exactly once" signal: the staged comp stays surfaced across every reveal round until it crowns,
   * so the FE — which fires its kickoff after EVERY advance/decision — must no-op once this is true, or it
   * would re-author (a fresh utility call + an overwrite) every round. True the moment a fiction write-back
   * lands; back to false only when the comp crowns (which clears `s.competitionFiction`). Vault-free.
   */
  alreadyAuthored: boolean;
}

export function competitionStagingData(s: LiveSeasonState): CompetitionStagingData | null {
  const c = s.competition;
  if (!c || c.winner === undefined || c.dropOrder === undefined) return null;
  const def = competitionDefFor(s, c);
  const f = s.competitionFiction;
  const alreadyAuthored = !!(f && f.comp === c.comp && f.week === s.week);
  return {
    comp: c.comp, type: c.type, field: [...c.field], winner: c.winner,
    dropOrder: [...c.dropOrder], alreadyAuthored, ...(def ? { def } : {}),
  };
}

/** #1400 — the model-authored fiction the FE writes back (structurally compatible with the port's req). */
export interface CompetitionFictionInput {
  comp?: string;
  week?: number;
  theme?: string;
  premise?: string;
  winReads?: string;
  eliminations?: Array<{ id?: string; fiction?: string }>;
}

/** #1400 — a validation outcome: the sanitized fiction to store, or a Vault-free reason it was rejected. */
export type CompetitionFictionValidation =
  | { ok: true; fiction: CompetitionFiction }
  | { ok: false; reason: "no-competition" | "not-resolved" | "comp-mismatch" | "week-mismatch" | "already-authored" | "drop-order-mismatch" | "empty-fiction" };

const clampLen = (v: string, max: number): string => (v.length > max ? v.slice(0, max).trimEnd() : v);

/**
 * #1400 — the HARD validation gate (pure, unit-testable): the model-authored fiction is accepted ONLY
 * when every elimination it names maps to the engine's ALREADY-FIXED `dropOrder` EXACTLY — same ids, in
 * the same order. Any divergence (a renamed houseguest, a reordering, a wrong count, a comp/week that no
 * longer matches, a resolved comp missing) is REJECTED, so the generated fiction can never rename who
 * goes or in what order — on a reject the caller stores nothing and the deterministic 0042 library floor
 * stands. On success returns the sanitized (trimmed-to-bounds), storable `CompetitionFiction`. This never
 * reads or exposes a score/lean/number — only the public drop ORDER the reveal already tells round by round.
 */
export function validateCompetitionFiction(
  s: LiveSeasonState, req: CompetitionFictionInput,
): CompetitionFictionValidation {
  const c = s.competition;
  if (!c) return { ok: false, reason: "no-competition" };
  if (c.winner === undefined || c.dropOrder === undefined) return { ok: false, reason: "not-resolved" };
  if (req.comp !== c.comp) return { ok: false, reason: "comp-mismatch" };
  if (req.week !== s.week) return { ok: false, reason: "week-mismatch" };
  // ENGINE-SIDE EXACTLY-ONCE (idempotence, Greptile P1): validated fiction is ALREADY stored for THIS
  // (comp, week). The staged comp stays surfaced across every reveal round until it crowns, so a second
  // `recordCompetitionFiction` — from a re-driven FE kickoff OR a direct MCP caller — must be REFUSED, not
  // silently overwrite the stored staging (which would make later rounds render different fiction than
  // earlier ones). Authoring is exactly once per competition; the stored fiction is immutable until crown.
  const existing = s.competitionFiction;
  if (existing && existing.comp === c.comp && existing.week === s.week) return { ok: false, reason: "already-authored" };

  const named = req.eliminations ?? [];
  // THE DROP-ORDER BRIGHT LINE: same length, same ids, same order as the fixed drop order. Exact map.
  if (named.length !== c.dropOrder.length) return { ok: false, reason: "drop-order-mismatch" };
  const eliminations: Array<{ id: EntityId; fiction: string }> = [];
  for (let i = 0; i < c.dropOrder.length; i++) {
    const entry = named[i];
    const fiction = typeof entry?.fiction === "string" ? entry.fiction.trim() : "";
    if (entry?.id !== c.dropOrder[i]) return { ok: false, reason: "drop-order-mismatch" };
    if (!fiction) return { ok: false, reason: "empty-fiction" };
    eliminations.push({ id: c.dropOrder[i]!, fiction: clampLen(fiction, GEN_COMPETITION_BOUNDS.maxFictionLen) });
  }

  const theme = (req.theme ?? "").trim();
  const premise = (req.premise ?? "").trim();
  if (!theme || !premise) return { ok: false, reason: "empty-fiction" };
  const winReads = (req.winReads ?? "").trim();

  return {
    ok: true,
    fiction: {
      comp: c.comp, week: s.week,
      theme: clampLen(theme, GEN_COMPETITION_BOUNDS.maxThemeLen),
      premise: clampLen(premise, GEN_COMPETITION_BOUNDS.maxPremiseLen),
      ...(winReads ? { winReads: clampLen(winReads, GEN_COMPETITION_BOUNDS.maxWinReadsLen) } : {}),
      eliminations,
    },
  };
}

export function newLiveSeason(active: EntityId[]): LiveSeasonState {
  return {
    week: 1, beat: active.length > 2 ? "hoh-competition" : "finale",
    active: [...active], vetoUsed: false, evictionOrder: [], finished: false,
  };
}

// --- Staged (endurance-style) competition: visible elimination rounds (0006 staged-rounds evolution) ---
//
// FULL-TRAJECTORY outcome-neutrality (the anti-sycophancy backstop, mandate #3 + the jury calibration
// band, PR #395): the staged rounds are a PRESENTATION-ONLY re-telling of the single-shot 0006 outcome.
// The comp resolves ONCE with the EXACT pre-staging RNG consumption (def draw then `resolveCompetition`
// directly on the beat rng), so the crown — and therefore EVERY downstream HOH/veto winner, nomination,
// eviction, eviction order, and who reaches jury — is BYTE-IDENTICAL to the non-staged model. The drop
// ORDER of the losers is the only new drama, derived PURELY from that roll's scores (`eliminationOrder`,
// consuming ZERO randomness), and the per-round reveals + the player's per-round approach (recorded as
// expression, committed-before/locked-after) consume no rng and mutate no game state — so nothing the
// staging adds can perturb the seeded trajectory.

/**
 * Build the competitor `CompetitionIntents` applying the player's approach. The math is verbatim
 * 0006/0028: stat-vs-type + bounded temperature + the LIVE soul emotional modifier (0041) + the declared
 * intent penalties (0028). NPCs compete (their approach is soul-motivated; for now they always compete,
 * matching the single-shot model's NPC path). The player is declared even when not in the field — it is
 * harmless (never read for a non-competitor) and keeps the resolution byte-identical to the baseline.
 */
function roundIntents(field: readonly EntityId[], ctx: SeasonCtx, playerApproach: Intent): CompetitionIntents {
  const intents = new CompetitionIntents();
  intents.declare(ctx.player, playerApproach);
  // 0006b: every NPC in the field gets a derived intent too, when the provider is wired (live only). With
  // it absent (pure tests + the calibration/UAT harness), NPCs fall through to CompetitionIntents' own
  // "compete" default ⇒ the roll is BYTE-IDENTICAL to the pre-feature model — the calibration spine holds.
  if (ctx.compIntentOf) {
    for (const id of field) {
      if (id === ctx.player) continue;
      intents.declare(id, ctx.compIntentOf(id, field));
    }
  }
  return intents;
}

/** The competitor projection (LIVE soul emotional modifier 0041 + hidden rest deficit, ADR 0006) the 0006 resolve reads. */
function competitorsOf(field: readonly EntityId[], ctx: SeasonCtx): Competitor[] {
  return field.map((id) => ({
    id, stats: ctx.statsOf(id), emotionalState: ctx.emotionalOf?.(id) ?? 0.5, restPenalty: ctx.restOf?.(id),
  }));
}

/** A throwaway WeekState for the legality helpers (they only read the fields they need). */
function weekState(s: LiveSeasonState, ctx: SeasonCtx): WeekState {
  const noms = s.nominees ?? [s.active[0]!, s.active[1]!];
  return {
    houseguests: s.active, player: ctx.player, hoh: s.hoh ?? s.active[0]!,
    nominees: noms, ...(s.outgoingHoh ? { outgoingHoh: s.outgoingHoh } : {}),
    ...(s.vetoHolder ? { vetoWinner: s.vetoHolder } : {}),
  };
}

/** Replacement nominees the HOH may name after a save (excludes HOH, noms, veto winner, the saved). */
function replacementOptions(s: LiveSeasonState, ctx: SeasonCtx): EntityId[] {
  return selectableReplacements(weekState(s, ctx)).filter((h) => h !== s.saved);
}

function otherNominee(s: LiveSeasonState): EntityId {
  return s.nominees!.find((n) => n !== s.saved)!;
}

/**
 * Resolve the eviction once a final vote target exists for the player (or none if NPC-only),
 * RECORDING the manner toward each responsible houseguest so jury management has live effect
 * (0037). `votesToEvict` is filled with each voter who voted for the evictee — those voters,
 * plus the HOH who put the nominees up, are the "responsible" houseguests the evictee reads.
 */
/** Tally one broadcast competition win into the holder's game resume (gameRespect, 2026-06-11). */
function creditResume(s: LiveSeasonState, id: EntityId): void {
  s.resume = s.resume ?? {};
  s.resume[id] = (s.resume[id] ?? 0) + 1;
}

/** The house's CURRENT blocs (0043) — derived fresh per decision; [] when loyalty isn't wired. */
function currentBlocs(s: LiveSeasonState, ctx: SeasonCtx): Bloc[] {
  if (!ctx.loyaltyOf) return [];
  return detectBlocs({ rel: ctx.rel, active: s.active, loyaltyOf: ctx.loyaltyOf, ...(ctx.allianceTie ? { tieBoost: ctx.allianceTie } : {}) });
}

/**
 * A voter's pick between the two final nominees — the enriched vote model (feature 0044, layered
 * on the 0002 threat read). The blend, every magnitude from `decisionConstants`:
 *
 *   threat × (1 + paranoia·moodWeight)   — self-protection: a rattled voter's nerves shout loudest (0041)
 *   + blocTerm                            — vote WITH your bloc: shield a mate, lean into the shared enemy (0043)
 *   − dealHonorWeight (if deal-bound)     — an open promise pulls the vote off the protected party (0039);
 *                                           a strong enough opposing read still BREAKS it — and the ledger
 *                                           reconciles that betrayal with its full consequence downstream
 *   − juryMgmt × trust(nominee → voter)   — light jury management: don't make a bitter juror needlessly (0014)
 *   − bondKeep × bond(voter → nominee)    — keep your own: voters protect the nominee THEY are bonded to,
 *                                           so the unattached houseguest loses the split (D4/E33 calibration)
 *
 * Engine-decided + bounded: the terms shade the threat-primary read, never replace it; voting
 * blocs vote TOGETHER because every member computes the same derived bloc (decision 0002).
 */
export function voteChoice(
  voter: EntityId, fn: [EntityId, EntityId], ctx: SeasonCtx, blocs: readonly Bloc[] = [], hoh?: EntityId,
): EntityId {
  const V = DECISION.vote;
  // The REFERENDUM ON THE HOH (PO ruling 2026-11-02): the HOH's target is the nominee the HOH reads
  // as the bigger threat. A voter aligned with the HOH gives it to them; an opposed voter keeps the
  // target and sends the pawn home. No HOH (or the voter IS the HOH, e.g. a tie-break) ⇒ no term.
  const B = RELATIONSHIP_CONSTANTS.baseline;
  const hohTarget = hoh && hoh !== voter && !fn.includes(hoh)
    ? (ctx.rel.edge(hoh, fn[0]).threat >= ctx.rel.edge(hoh, fn[1]).threat ? fn[0] : fn[1])
    : undefined;
  const hohAlignment = hohTarget
    ? (ctx.rel.bondStrength(voter, hoh!) - (B.trust + B.affinity) / 2) - (ctx.rel.edge(voter, hoh!).threat - B.threat)
    : 0;
  const paranoia = Math.max(0, (0.5 - (ctx.emotionalOf?.(voter) ?? 0.5)) * 2); // 0 calm … 1 fully rattled
  const deals = ctx.dealsOf?.(voter) ?? [];
  const dealBound = (n: EntityId): boolean =>
    deals.some((d) => d.status === "open" && d.condition.promisors.includes(voter) && d.parties.includes(n) && n !== voter);
  const score = (n: EntityId): number =>
    ctx.rel.edge(voter, n).threat * (1 + paranoia * V.moodSelfProtectWeight) +
    blocTerm(blocs, voter, n) +
    // ORW-37 half 2 (B41): a pre-show tie this voter holds with `n` (positive evicts, negative keeps: family keeps, a rival evicts). Absent provider => 0 => byte-identical.
    (ctx.tieVotePushFor?.(n, voter) ?? 0) +
    // 0085: a campaign to evict `n` that this voter is aware of pushes the vote toward `n` — bounded,
    // character-mediated, engine-tallied. Absent provider ⇒ 0 ⇒ byte-identical (the juryReach spine).
    (ctx.campaignTiltFor?.(n, voter) ?? 0) +
    // 0024: this voter's own residual memory of `n` (a grudge raises the odds they evict `n`, a favor lowers them).
    (ctx.memoryTiltFor?.(n, voter) ?? 0) +
    // B29: this voter's exploit tilt toward a visibly rattled `n` (decaying; absent provider => 0 => byte-identical).
    (ctx.moodTiltFor?.(n, voter) ?? 0) +
    // B3b / #2017: this voter's BELIEF that `n` is targeting them (`targets-me` claims, sometimes wrong) — read from claims, never the edge. Absent provider ⇒ 0 ⇒ byte-identical.
    (ctx.beliefTiltFor?.(n, voter) ?? 0) -
    // B4 slice 4: a KEPT casual assurance to `n` shields them (smaller than a formal deal's honor weight). Absent provider => 0 => byte-identical.
    (ctx.assuranceVoteFor?.(n, voter) ?? 0) -
    (dealBound(n) ? V.dealHonorWeight : 0) -
    V.juryManagementWeight * ctx.rel.edge(n, voter).trust -
    V.bondKeepWeight * ctx.rel.bondStrength(voter, n) +
    (n === hohTarget ? V.hohReferendumWeight * hohAlignment : 0);
  return score(fn[0]) >= score(fn[1]) ? fn[0] : fn[1];
}

/** Count the eviction votes (NPCs threat-driven; the player's own vote, if any) WITHOUT breaking a tie. */
function countEvictionVotes(s: LiveSeasonState, ctx: SeasonCtx, playerVote?: EntityId): {
  fn: [EntityId, EntityId]; votes: Record<EntityId, number>; voteOf: Map<EntityId, EntityId>;
} {
  const fn = s.finalNominees!;
  const voters = evictionVoters({ ...weekState(s, ctx), nominees: fn });
  const blocs = currentBlocs(s, ctx); // one derived read for the whole vote — the bloc votes together
  ctx.assuranceKeptAtTally?.(fn); // B4 slice 8: nominees are final here - settle the 'safe' assurances of everyone who stayed off the block
  const votes: Record<EntityId, number> = { [fn[0]]: 0, [fn[1]]: 0 };
  const voteOf = new Map<EntityId, EntityId>();
  for (const v of voters) {
    const target = v === ctx.player && playerVote ? playerVote : voteChoice(v, fn, ctx, blocs, s.hoh ?? undefined);
    votes[target]++;
    voteOf.set(v, target);
    if (ctx.assuranceVotedOut) ctx.assuranceVotedOut(v, target, voters); // B4 slice 4: voting the assured out breaks the assurance (SEALED ballot: ORW-15 - the fold is shared across every voter, never attributed to this one)
    if (ctx.assuranceKeptAtVote) ctx.assuranceKeptAtVote(v, fn[0] === target ? fn[1] : fn[0], voters); // B4 slice 8 (sealed, ORW-15): voting the OTHER nominee out spares this one => kept
  }
  return { fn, votes, voteOf };
}

/**
 * How an evictee reads being moved against by a responsible houseguest (0037). Simple,
 * documented, defensible — the BDD only asserts the directional property. A houseguest the
 * evictee TRUSTED who moved against them ⇒ betrayed; an eviction the evictee did not see
 * coming (they read the houseguest as low-threat) ⇒ blindsided. ENGINE-ONLY (never crosses
 * the wall): it shapes the hidden jury lean, not any player-facing surface.
 */
function mannerToward(evictee: EntityId, responsible: EntityId, ctx: SeasonCtx): EvictionManner {
  const e = ctx.rel.edge(evictee, responsible);
  // PERSIST-2/BE-101: guard NaN → 0 — `intensity` below is written into the persisted
  // `LiveSeasonState.mannerByEvictee`, which the finale jury read consumes. Finite inputs
  // clamp exactly as before.
  const clamp01 = (x: number): number => (Number.isNaN(x) ? 0 : Math.max(0, Math.min(1, x)));
  // SOC-NEW-1/5: the read is GRADED off the actual edge — its severity tracks the relationship.
  const graded = (t: number): number => MANNER_GRADING.grievanceFloor + (1 - MANNER_GRADING.grievanceFloor) * clamp01(t);
  const { trustBetrayal, threatBlindside } = MANNER_THRESHOLDS;
  if (e.trust > trustBetrayal) {
    // Trusted them, yet they moved against me — the deeper the trust, the deeper the betrayal.
    return { betrayed: true, intensity: graded((e.trust - trustBetrayal) / (1 - trustBetrayal)) };
  }
  if (e.threat < threatBlindside) {
    // Read them as no threat — the more harmless they seemed, the bigger the blindside.
    return { blindsided: true, intensity: graded((threatBlindside - e.threat) / threatBlindside) };
  }
  // A clean, expected move — no grievance. SOC-NEW-5: respect is EARNED by threat (a feared rival
  // earns it; an ignored floater nets ~neutral, not a flat lift), graded from 0 at the blindside line.
  return { respected: true, intensity: clamp01((e.threat - threatBlindside) / (1 - threatBlindside)) };
}

/**
 * Record the evictee's manner read toward every responsible houseguest (HOH + evict-voters).
 * Jury management cuts BOTH ways: the player is recorded like any other responsible houseguest
 * (audit A5 — no exemption), so a juror the player blindsided/betrayed on the way out weighs that
 * against them at the player's own finale (0037 §4.2). ENGINE-ONLY: the number never crosses the wall.
 */
function recordEvictionManner(s: LiveSeasonState, evictee: EntityId, responsible: EntityId[], ctx: SeasonCtx): void {
  const map = (s.mannerByEvictee ??= {});
  const row = (map[evictee] ??= {});
  for (const r of responsible) {
    if (r === evictee) continue; // a houseguest is never "responsible" for their own eviction
    row[r] = mergeManner(row[r], mannerToward(evictee, r, ctx));
  }
}

/**
 * #1964: merge a fresh manner read into one already on file for the same (evictee, responsible) pair — OR the
 * booleans, keep the strongest intensity — so an earlier `recordDealBetrayal` flag is never erased by the eviction read.
 */
export function mergeManner(prior: EvictionManner | undefined, fresh: EvictionManner): EvictionManner {
  if (!prior) return fresh;
  const out: EvictionManner = { ...prior, ...fresh };
  for (const k of ["betrayed", "blindsided", "disrespected", "respected"] as const) {
    if (prior[k] || fresh[k]) out[k] = true;
  }
  // Precedence matches `mannerLeanOf`: a grievance (betrayed / blindsided / disrespected) supersedes `respected`, so one
  // eviction never counts toward both the loyalty and the treachery facets.
  if (out.betrayed || out.blindsided || out.disrespected) delete out.respected;
  // An ABSENT intensity means full strength (a boolean-only demerit), so it dominates a graded read.
  if (prior.intensity !== undefined || fresh.intensity !== undefined) {
    out.intensity = Math.max(prior.intensity ?? 1, fresh.intensity ?? 1);
  }
  return out;
}

/**
 * Record a broken-deal demerit (0039): the wronged party will weigh this betrayal against the
 * breaker in their later jury lean. Stored as `manner.betrayed` in the same map the finale reads
 * (`mannerFor`), merged so a later eviction-manner read keeps it rather than clobbering it.
 */
export function recordDealBetrayal(s: LiveSeasonState, wronged: EntityId, breaker: EntityId): void {
  const map = (s.mannerByEvictee ??= {});
  const row = (map[wronged] ??= {});
  row[breaker] = { ...(row[breaker] ?? {}), betrayed: true };
}

/**
 * E89: has the season's FIRST ceremony beat (the week-1 HOH result) resolved yet? Pure and
 * DERIVED — never stored: any of these only exist once at least one ceremony beat committed
 * (rollWeek clears `hoh` but bumps `week` and sets `outgoingHoh`, so the predicate stays true
 * for the rest of the season). Gates NPC approaches (`socialInitiatives`) per ruling #5:
 * move-in gets room to breathe before anyone "wants a word".
 */
export function firstCeremonyBeatResolved(s: LiveSeasonState): boolean {
  return (
    s.finished ||
    s.week > 1 ||
    s.evictionOrder.length > 0 ||
    s.outgoingHoh !== undefined ||
    s.hoh !== undefined ||
    s.nominees !== undefined
  );
}

// --- In-game time of day + the player's bedtime lever (ADR 0006) ----------------
//
// Time advances by PLAY, never a wall-clock (§Principle 1), and the clock NEVER interrupts a
// scene — it only marks how late it is getting (§Principle 2). The diegetic bound (the house
// thins as NPCs reach their bedtimes) lives in `awakeSet` (`./timeOfDay`); these helpers move the
// shared clock and the player's own bedtime/rest. All ENGINE-only mutations; no number crosses the
// wall, and an absent `timeOfDay` keeps the seeded sims byte-identical.

/**
 * Advance the clock by `hours`, projecting the public phase. Shared by the per-BEAT clock (substantive
 * ceremony play) and the per-CONVERSATION clock (Extension 1 — lingering within a beat). The live field
 * `nightDepth` carries the clock-HOUR (8..32) in the 24-hour model (the field name is legacy; the value is
 * the hour-of-day). A fresh day initializes to the 8am wake.
 *
 * `wrapAtEnd` governs the bitter end:
 *  - `true` (the per-BEAT path): crossing the next 8am WRAPS to a new day and banks "running on empty" —
 *    the player outlasted the whole house without turning in (their tiredness today is a full night up).
 *  - `false` (the per-CONVERSATION path): CLAMP just below the 8am wake, never auto-bank — a long engaged
 *    scene can press time to the bitter pre-dawn edge but NEVER skips the player past their own bedtime
 *    choice (ADR 0003 / the lull rule). The night ends only when the player turns in or a ceremony lands.
 */
function advanceClockBy(s: LiveSeasonState, hours: number, wrapAtEnd: boolean): void {
  if (s.finished) return;
  if (s.playerRetired) { s.nightDepth = s.wakeHour ?? WAKE_HOUR; s.timeOfDay = DAY_START; s.playerRetired = false; return; } // P4d: an early riser wakes at their own hour
  if (s.nightDepth === undefined) { s.nightDepth = WAKE_HOUR; s.timeOfDay = DAY_START; return; }
  const next = s.nightDepth + hours;
  if (next >= DAY_END_HOUR) {
    if (wrapAtEnd) {
      // A full night passed without the player turning in — they were "up" to the 8am forced wake
      // (Principle 6 is theirs: nobody sent them to bed). They wake the next morning running on empty:
      // last awake to the bitter end ⇒ the maximum sleep debt.
      s.lastSleepDepth = DAY_END_HOUR;
      s.lastSleepPhase = DAY_END_HOUR;
      s.wakeHour = undefined;
      s.dayNumber = (s.dayNumber ?? 1) + 1; // A69: a real night passed - it is a new day
      s.nightDepth = WAKE_HOUR;
      s.timeOfDay = DAY_START;
      return;
    }
    // The per-conversation path holds at the bitter pre-dawn edge (no auto-bank): the player owns bedtime.
    s.nightDepth = DAY_END_HOUR - 0.0001;
    s.timeOfDay = phaseForHour(s.nightDepth);
    return;
  }
  s.nightDepth = next;
  s.timeOfDay = phaseForHour(next);
}

/** The beats that make up one eviction night (0047 staged reveal + the F3 final eviction). */
const EVICTION_EVENT_BEATS: ReadonlySet<Beat> = new Set<Beat>([
  "eviction", "eviction-reveal", "eviction-goodbye", "eviction-result", "final-eviction",
]);
/** The beats that make up the finale (0037: statements, Q&A, the vote, the reveal, the winner). */
const FINALE_EVENT_BEATS: ReadonlySet<Beat> = new Set<Beat>(["finale", "finale-reveal", "finale-result"]);

/**
 * PO ruling 2026-11-01 — "eviction night and the finale take about two in-game hours, total". Returns the
 * hours a resolved beat should charge the clock when it belongs to a multi-step event, or `null` when it
 * does not (the caller keeps its normal per-beat cost). The event's whole budget (`budgetHours`, the
 * eviction span) is charged on its FIRST step and every later step costs 0, tracked on `s.eventClock` so
 * it survives a save/restart mid-event. `weekBefore` is the week as it stood BEFORE the beat resolved
 * (the eviction result rolls the week inside the same step). No rng; clock-path only.
 */
export function eventBeatHours(s: LiveSeasonState, beat: Beat, weekBefore: number, budgetHours: number): number | null {
  const key = EVICTION_EVENT_BEATS.has(beat) ? `eviction:w${weekBefore}`
    : FINALE_EVENT_BEATS.has(beat) ? "finale"
    : null;
  if (key === null) return null;
  const spent = s.eventClock?.key === key ? s.eventClock.spent : 0;
  const hours = Math.max(0, budgetHours - spent);
  s.eventClock = { key, spent: spent + hours };
  return hours;
}

/**
 * Advance the per-beat clock by a resolved SUBSTANTIVE beat. Defaults to the flat `CLOCK.perBeatHours`
 * (byte-identical to the pre-0119 model); 0119 passes the beat's own FELT duration (a quick ceremony ~1h,
 * a comp ~3h, an eviction ~2h) so different events cost different amounts of the in-game day. The felt
 * duration is only ever passed when the per-conversation clock is live (the caller gates it), so golden
 * replay (per-conversation clock off, master on) keeps the flat default and the fixture is unchanged.
 */
export function advanceClock(s: LiveSeasonState, hours: number = CLOCK.perBeatHours): void {
  advanceClockBy(s, hours, true);
}

/**
 * 0066 Phase-2 (Extension 1) — advance the clock as the player lingers/plays WITHIN a beat (one player
 * social turn). `hours` is the scene's committed felt duration (Extension 5 — type-bounded; defaults to the
 * small per-conversation floor). Pacing-only: it presses the day's finite scheming time turn-by-turn but
 * NEVER rushes — it clamps just below the 8am wake and never wraps the night without the player's own
 * `turnIn` (or a ceremony beat), so it can never skip the player past their bedtime decision. A no-op when
 * the clock hasn't initialized (the very first beat starts the day; lingering only matters once running).
 */
export function advanceClockPerConversation(s: LiveSeasonState, hours: number = CLOCK.perConversationHours): void {
  if (s.nightDepth === undefined) return; // the day hasn't started; the per-beat clock initializes it
  advanceClockBy(s, hours, false);
}

/**
 * P4c - tick the clock by ONE message's few in-game minutes. Continuous (no scene lump, no cap/floor), so a scheduled event can interrupt mid-conversation. Clamps at the
 * pre-dawn edge, never wraps the night, no-op before the day starts. Pure, no rng.
 */
export function advanceClockPerMessage(s: LiveSeasonState, hours: number): void {
  if (s.nightDepth === undefined) return;
  if (hours > 0) advanceClockBy(s, hours, false);
}

/** ORW-116 (b): record that the night in front of the CURRENT beat's day-break has been crossed (by the player's own turn-in). */
function markNightGateCrossed(s: LiveSeasonState): void {
  switch (s.beat) {
    case "hoh-competition": s.firstNightPassed = true; break;
    case "nominations": s.preNomsNightPassed = true; break;
    case "veto-competition": s.preVetoNightPassed = true; break;
    case "veto-ceremony": s.preVetoCeremonyNightPassed = true; break;
    case "eviction": s.preEvictionNightPassed = true; break;
    default: break;
  }
}

/** ORW-116 (b): would the NEXT ordinary advance be a night-gate day-break (the beat that rolls the night)? Pure read of the same one-shot flags `advance` tests. */
export function nightBreakPending(s: LiveSeasonState): boolean {
  if (s.twist?.phase === "running" || s.nightDepth === undefined) return false;
  switch (s.beat) {
    case "hoh-competition": return s.week === 1 && !s.firstNightPassed && (s.dayNumber ?? 1) < 2;
    case "nominations": return !s.preNomsNightPassed;
    case "veto-competition": return !s.preVetoNightPassed && !s.vetoField;
    case "veto-ceremony": return !s.preVetoCeremonyNightPassed;
    case "eviction": return !s.preEvictionNightPassed && !s.eviction;
    default: return false;
  }
}

/**
 * ORW-116 (b), Ryne's rule: the night is NEVER auto-run. With the clock live, the people stay social through the evening and the night until the PLAYER turns in, or the clock reaches the next 8am
 * (full sleep debt, no forced bedtime). So a night-gate day-break (the beat that rolls the night) is HELD until the night is over; a plain advance, an NPC-ceremony pre-resolve, or a chained step
 * can no longer slide the game overnight. No clock (`nightDepth` unset) => never held.
 */
export function nightHeld(s: LiveSeasonState): boolean {
  return s.clockInteractive === true && !nightIsOver(s);
}

export function nightIsOver(s: LiveSeasonState): boolean {
  if (s.nightDepth === undefined) return true;
  return s.playerRetired === true || s.nightDepth >= DAY_END_HOUR - 0.01;
}

/** ORW-116 (a): the clock-hour the first night starts at when the premiere ends (the premiere and toast are the evening; the night is the social night after). */
export const FIRST_NIGHT_HOUR = 20;
/** ORW-116: time passes through the premiere entrances/toast (NOT a player conversation, so it does not arm the night-hold). Clamped below the pre-dawn edge. */
export function tickPremiereClock(s: LiveSeasonState, hours: number): void {
  if (s.nightDepth === undefined || hours <= 0) return;
  s.nightDepth = Math.min(s.nightDepth + hours, DAY_END_HOUR - 0.0001);
  s.timeOfDay = phaseForHour(s.nightDepth);
}
/** ORW-116: the houseguests ENTER in the afternoon - the in-game clock starts here at the premiere entry and runs for real through the entrances and the toast (no jump). */
export const PREMIERE_ENTRY_HOUR = 16;
/** Hours each premiere entrance / toast release costs (time passing, not a skip): 16 entrances put the toast in the evening. */
export const PREMIERE_STEP_HOURS = 0.15;

/**
 * #1320 night-gate — cross the night to the NEXT MORNING as a clean day boundary (the HOH→nominations
 * gate: nominations must not land the same in-fiction moment as the crown). Unlike the per-beat/per-
 * conversation clock this is not a bounded nudge — it deliberately banks the whole night and resets to
 * the 8am wake, so the nominations resolve on Day 2 (the canonical cadence). PURE, no rng. A no-op until
 * the clock is running (the first ceremony beat starts the day). No sleep debt is stamped here: the night
 * between the crown and the noms is a normal night's rest, and any real deficit is (re)banked by the
 * player's own `turnIn` / the per-beat wraps during the days of play that follow before the next comp.
 */
export function crossToNextDay(s: LiveSeasonState): void {
  if (s.nightDepth === undefined) return; // dormant until the per-beat clock starts the day
  // A69: a REAL night is crossed only if the clock has moved past this morning's wake. Just after the player's turn-in the clock sits AT the wake (the turn-in's recap already moved the day), so
  // crossing again is the same morning - not a second night.
  if (s.nightDepth > (s.wakeHour ?? WAKE_HOUR) + 1e-6) s.dayNumber = (s.dayNumber ?? 1) + 1;
  // ORW-116 (b): the player outlasted the whole night without turning in (the clock sat at the bitter pre-dawn edge) - they wake at 8am running on empty: FULL sleep debt, same as the per-beat wrap.
  if (!s.playerRetired && s.nightDepth >= DAY_END_HOUR - 0.01) { s.lastSleepDepth = DAY_END_HOUR; s.lastSleepPhase = DAY_END_HOUR; }
  s.wakeHour = undefined;
  s.nightDepth = WAKE_HOUR;
  s.timeOfDay = DAY_START;
  s.playerRetired = false;
}

/**
 * The player's bedtime lever (§Principle 6): the player CHOOSES to turn in. Captures the clock-HOUR they
 * retired at as last night's bedtime (an early night ⇒ rested, a pre-dawn riser even; outlasting the house
 * past midnight ⇒ real debt), then rolls to the next 8am wake. Never auto-called — only the player's own
 * action fires it. A no-op once the game is over or the player has left.
 */
export function playerTurnIn(s: LiveSeasonState, player: EntityId): void {
  if (s.finished || playerHasLeft(s, player)) return;
  const hour = s.nightDepth ?? WAKE_HOUR;
  s.lastSleepDepth = hour;
  s.lastSleepPhase = hour; // legacy field name; now the clock-hour the player was last awake to
  s.playerRetired = true;
  // ORW-116 (b): the night the player just took IS the night the pending day-break would have rolled. Mark that gate crossed (the turn-in already rolled the day), or the clock ticks that follow (which clear
  // `playerRetired`) would leave the gate held again - a second night nobody asked for.
  if (nightBreakPending(s)) markNightGateCrossed(s);
  // P4d: wake = min(8am, bedtime + 8h) - an EVENING bed wakes early; midnight or later wakes at 8am (debt as before).
  const wake = wakeHourAfterBed(hour);
  s.wakeHour = wake === WAKE_HOUR ? undefined : wake;
  s.nightDepth = wake;
  s.timeOfDay = DAY_START;
}

/** The player's hidden sleep deficit today (0..1) — graded by the clock-hour they were last awake to. */
export function playerRestDeficit(s: LiveSeasonState): number {
  return restDeficitForDepth(s.lastSleepDepth ?? WAKE_HOUR);
}

/**
 * An NPC's hidden sleep deficit (0..1) — keyed off the ACTUAL night, not static aptitude, in the 24-hour
 * model. 0066 Extension 4 (the fairness fix, owner 2026-07-12) makes the NPC's night EMERGENT and
 * INDEPENDENT of the player's bedtime: an NPC is up to their own `emergentBedtimeHour` — a night-owl
 * lingers to their chronotype bedtime ONLY with late-night COMPANY (`company` = other natural owls still
 * up), and beds down at the social floor (midnight, or later if the player kept the house up) ALONE. So an
 * owl who genuinely stayed up (with company) pays their OWN debt whether or not the player did — while a
 * lone owl on a dead night pays nothing (the debt is EARNED, never a flat archetype tax). `bedDepthOverride`
 * (a clock-hour) lets the adapter inject the conflict-drained chronotype bedtime.
 *
 * `company` OMITTED (0) collapses the emergent bedtime to the social floor, whose DEFICIT is byte-identical
 * to the pre-Extension-4 player-capped `min(bedHour, nightRanTo)` — so the seeded calibration spine and the
 * `sleepEconomyFairness` gate are unmoved; the earned-debt behavior fires only when the adapter passes the
 * live co-owl company count. No completed night yet ⇒ 0 (nobody is tired before the first night ends).
 */
export function npcRestDeficit(
  s: LiveSeasonState,
  stats: { physical: number; social: number },
  id?: EntityId,
  bedDepthOverride?: number,
  company = 0,
): number {
  const nightEnd = s.lastSleepDepth ?? WAKE_HOUR;
  if (nightEnd <= WAKE_HOUR) return 0; // no night has completed (or a fresh morning) ⇒ nobody carries debt
  const bedHour = bedDepthOverride ?? bedtimeDepthFor(stats, id);
  return restDeficitForDepth(emergentBedtimeHour(bedHour, company, nightEnd));
}

/** Record the evictee as out (evictionOrder + remove from the live house). Does NOT roll the week. */
function removeEvictee(s: LiveSeasonState, evictee: EntityId): void {
  s.evictee = evictee;
  s.evictionOrder.push(evictee);
  s.active = s.active.filter((h) => h !== evictee);
}

/** Roll into the next week (or the finale at Final 3 → 2): clear the week's ceremony state. */
function rollWeek(s: LiveSeasonState): void {
  // 0133 — the week's public digest, taken BEFORE the ceremony state clears. No rng, no fold. A twist night's
  // second eviction (same week number) gets its own line.
  (s.weekDigests ??= []).push({
    week: s.week, hoh: s.hoh ?? null, nominees: [...(s.finalNominees ?? s.nominees ?? [])],
    vetoHolder: s.vetoHolder ?? null, vetoUsed: !!s.vetoUsed, evictee: s.evictee ?? null,
    juryCount: Math.max(0, s.evictionOrder.length - preJuryEvictionCount(s)),
  });
  s.outgoingHoh = s.hoh;
  s.hoh = undefined; s.nominees = undefined; s.nominationTarget = undefined; s.vetoField = undefined;
  s.vetoHolder = undefined; s.vetoUsed = false; s.saved = undefined;
  s.replacement = undefined; s.finalNominees = undefined; s.vetoComp = undefined;
  s.preNomsNightPassed = undefined; // #1320: re-arm the night-gate for the new reign (undefined ⇒ serialization-neutral)
  // Phase 3a — re-arm the rest of the cadence's day-breaks for the new reign (undefined ⇒ serialization-neutral).
  s.preVetoNightPassed = undefined;
  s.preVetoCeremonyNightPassed = undefined;
  s.preEvictionNightPassed = undefined;
  if (s.active.length <= 2) {
    s.beat = "finale";
    return;
  }
  // 0025/B53 — a SEALED double eviction fires NOW: the same night runs a compressed second cycle
  // (HOH → noms → veto → vote, the hard rules verbatim — the outgoing HOH just set above cannot
  // play the second crown). Same week number: one twist night, two eviction ceremonies. Needs a
  // big-enough house (> 3 after the first eviction) to run a meaningful cycle; otherwise the
  // sealed twist simply never fires (0048's "the twist that never fired").
  if (s.twist?.phase === "pending" && s.twist.kind === "double-eviction" && s.active.length > 3) {
    s.twist = { kind: s.twist.kind, phase: "running" };
    s.beat = "twist-reveal";
    return;
  }
  if (s.twist?.phase === "running") {
    // The second evictee just walked out — the twist night is complete (exactly once).
    (s.firedTwists ??= []).push({ kind: s.twist.kind, beat: s.week });
    s.twist = undefined;
  }
  s.week += 1; s.beat = "hoh-competition";
  // B4 slice 5: an open casual assurance older than the horizon lapses (no longer binding) at the week roll. The ledger exists ONLY when ORWELL_ASSURANCES is on, so off => untouched.
  lapseAssurancesAtRoll(s);
  if (s.twistPlan) {
    // 0025 REACTIVE: the standing pool watches the live house and arms the ONE twist the house
    // has now earned (if any). Evaluated once per roll ⇒ at most one arms per week (the cooldown).
    armReactiveTwist(s);
  } else {
    // Legacy pre-scheduled path (flag off): arm a sealed twist scheduled for the week we just rolled
    // into; it stays invisible until the night's eviction lands (the reveal IS the firing).
    const due = maybeFireTwist(s.week, s.reserve ?? []);
    if (due && !s.twist) s.twist = { kind: due.kind, phase: "pending" };
  }
}

// ── 0025 reactive twists: the live-loop wiring (behind ORWELL_REACTIVE_TWISTS via `s.twistPlan`) ──

/** Jurors seated so far. Cast size is conserved (active + evicted); the first `castSize−11` evictions
 *  are pre-jury, everything after is a juror (a battle-back returnee drops out of this count). */
function juryCountOf(s: LiveSeasonState): number {
  const castSize = s.active.length + s.evictionOrder.length;
  return Math.max(0, s.evictionOrder.length - (castSize - 11));
}

/** The compact live snapshot the reactive triggers read. */
function twistSignalsOf(s: LiveSeasonState): TwistSignals {
  return { activeCount: s.active.length, juryCount: juryCountOf(s), lopsidedStreak: s.lopsidedStreak ?? 0 };
}

/** The already-fired kinds PLUS a granted-but-unplayed secret veto, so neither re-arms (at most once). */
function firedOrGrantedKinds(s: LiveSeasonState): TwistKind[] {
  const set = new Set((s.firedTwists ?? []).map((t) => t.kind));
  if (s.secretVeto) set.add("secret-veto");
  return [...set];
}

/** Grant the sealed one-time safety to an underdog — the fewest-resume active houseguest (engine-only). */
function grantSecretVeto(s: LiveSeasonState): void {
  const holder = [...s.active].sort((a, b) => (s.resume?.[a] ?? 0) - (s.resume?.[b] ?? 0))[0];
  if (holder) s.secretVeto = { holder, used: false };
}

/** Arm whichever twist the reactive plan says the house has just earned (at most one per roll). */
function armReactiveTwist(s: LiveSeasonState): void {
  if (s.twist) return; // a double-eviction is already armed/mid-flight this cycle
  const kind = triggeredTwist(s.twistPlan!, twistSignalsOf(s), firedOrGrantedKinds(s));
  if (kind === "double-eviction") {
    s.twist = { kind, phase: "pending" }; // fires as the compressed second cycle next roll (existing machinery)
  } else if (kind === "battle-back") {
    s.beat = "battle-back"; // resolved in `advance` (needs ctx + rng) before this week's HOH comp
  } else if (kind === "secret-veto" && !s.secretVeto) {
    grantSecretVeto(s); // sealed; "fires" only if/when the holder plays it off the block
  }
}

/**
 * E-1 (2026-11-04) — re-raise the `spectator-choice` card for a player who chose WATCH, so they can switch to SKIP ON THE CARD (the card-only binding stays: the model
 * still cannot commit it). Pure state change, no rng. `true` ⇒ the card is now (or already was) open; `false` ⇒ nothing to raise (no spectator, finished, or SKIP —
 * skip is irreversible, the caller refuses).
 */
export function raiseSpectatorChoice(s: LiveSeasonState, player: EntityId): boolean {
  if (s.finished || !s.spectator || s.spectator.mode !== "watch") return false;
  if (s.pending) return s.pending.kind === "spectator-choice";
  s.pending = { kind: "spectator-choice", by: player, modes: [...SPECTATOR_MODES], again: true };
  return true;
}

/** Atomic eviction (record manner + remove + roll) — used by the non-staged paths (Final-3 0045). */
function applyEviction(s: LiveSeasonState, evictee: EntityId, ctx: SeasonCtx, responsible: EntityId[]): void {
  recordEvictionManner(s, evictee, responsible, ctx);
  removeEvictee(s, evictee);
  rollWeek(s);
}

// --- Self-eviction (0061): the player's voluntary walk-out ----------------------

/** True once the player has genuinely left the game — voted/comp'd out, or a confirmed walk-out. */
export function playerHasLeft(s: LiveSeasonState, player: EntityId): boolean {
  return s.evictionOrder.includes(player);
}

/**
 * Step 1 (§4.2): raise the OOC `self-evict` confirmation. Changes NO game state — it does NOT evict,
 * the house never hears it, and it sits ALONGSIDE any ceremony `pending` so it is legal at any beat
 * (§4.6). A no-op once the player has already left. Idempotent.
 */
export function requestSelfEviction(s: LiveSeasonState, ctx: SeasonCtx): void {
  if (s.finished || playerHasLeft(s, ctx.player)) return;
  s.selfEvictPending = true;
}

/** Cancel the confirmation (§4.2): clear it; the player plays on, ACTIVE and unchanged. */
export function cancelSelfEviction(s: LiveSeasonState): void {
  s.selfEvictPending = false;
}

/**
 * Step 2 (§4.1) — execute a CONFIRMED self-eviction. The player walks out: this is a REAL, recorded
 * transition. The present house WITNESSES the departure (the returned BeatEvent's participants); the
 * player is removed through the SAME exit bookkeeping every player exit uses (`removeEvictee` → the
 * 0046 `evictionOrder` door), the resentment manner is recorded so souls fold it (§4.4), and the
 * forfeit flag (`selfEvicted`) marks the EXIT-ENTIRELY terminal seat (owner decision #1 — never a
 * juror's seat). The season ends for the player here: a quit is terminal. Resolved at this SAFE
 * point (the loop's `pending`/`eviction` sub-state is untouched — never mid-ceremony, §4.6).
 *
 * Returns the witnessed `self-eviction` BeatEvent — the adapter records it (non-hidden, player in the
 * witness set) and folds its hidden impact, exactly like any other witnessed beat (§4.1 / 0023).
 */
export function applySelfEviction(s: LiveSeasonState, ctx: SeasonCtx): BeatEvent {
  const player = ctx.player;
  // The active house in the moment the player walks witnesses the departure. (The fold is the
  // PRESENT HOUSE's read of the leaver — relief/shock/shifted threat — done adapter-side, §4.4; it
  // is NOT the evictee-grievance direction of a vote-out, so we don't record an eviction manner here.)
  const present = s.active.filter((h) => h !== player);
  removeEvictee(s, player);            // the 0046 exit door: evictionOrder + remove from the live house
  s.selfEvictPending = false;
  s.selfEvicted = true;                // owner decision #1: forfeit — the seat reads "evicted" by phase
  s.finished = true;                   // a quit ends the player's game — terminal recap (0048) unseals
  s.beat = "complete";
  return { beat: "self-eviction", content: `${player} self-evicts and walks out of the house`, participants: [player, ...present] };
}

// --- Live eviction sub-loop (0047) --------------------------------------------

/** How many houseguests leave a goodbye message (bounded; seeded selection of the remaining house). */
const GOODBYE_MESSAGE_COUNT = 3;

/** A seeded Fisher–Yates shuffle (does not mutate the input) — the engine-decided reveal order. */
function seededShuffle<T>(items: readonly T[], rng: RandomnessSource): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * The tone of a houseguest's goodbye message to the evictee — DERIVED from real relationship state
 * (anti-sycophancy: never narration). A houseguest who liked the evictee sends a warm one; a cold read
 * sends a cold one; otherwise a respectful nod. (0047 §4.)
 */
export type GoodbyeTone = "warm" | "respectful" | "cold";

/** The legal goodbye tones the PLAYER may choose for their own message (E34). */
export const GOODBYE_TONES: readonly GoodbyeTone[] = ["warm", "respectful", "cold"];

function goodbyeTone(sender: EntityId, evictee: EntityId, ctx: SeasonCtx): GoodbyeTone {
  const e = ctx.rel.edge(sender, evictee);
  if (e.affinity >= 0.6) return "warm";
  if (e.affinity <= 0.35) return "cold";
  return "respectful";
}

/**
 * How a goodbye tone folds into the evictee's read of the sender (feeds jury lean, 0014/0037 §4.2).
 * SOC-NEW-1: the tone is recorded as the `goodbye` field, applied with bounded PRECEDENCE in
 * `mannerLeanOf` — it can soften a grievance toward zero or lift/sting a clean departure, but a warm
 * tone can no longer be ADDED on top to launder a betrayal (the old `{respected}` merge bug).
 */
export function goodbyeMannerFor(tone: GoodbyeTone): EvictionManner {
  return { goodbye: tone };
}

/**
 * An NPC evictee's exit-interview stance (0130), DERIVED from the manner of their eviction
 * (anti-sycophancy — the reaction is grounded in what happened, never free-authored): a houseguest who
 * feels BETRAYED leaves bitter, one who was BLINDSIDED leaves defiant, an evictee moved out cleanly
 * (respected) leaves gracious. Read-only over the already-recorded manner rows toward the responsible
 * houseguests — it draws NO rng and mutates NO state, so it can never perturb the seeded trajectory.
 */
export function npcExitStance(evictee: EntityId, s: LiveSeasonState): ExitStance {
  const rows = Object.values(s.mannerByEvictee?.[evictee] ?? {});
  if (rows.some((m) => m.betrayed || m.disrespected)) return "bitter";
  if (rows.some((m) => m.blindsided)) return "defiant";
  return "gracious";
}

/** The deterministic exit-interview beat line (0130) — the narrator voices it richly from the moment. */
function exitInterviewContent(evictee: EntityId, stance: ExitStance): string {
  return `${evictee} sits with the producers for their exit interview, leaving ${stance}`;
}

/**
 * The seeded houseguests who leave a goodbye message (from the house remaining after the eviction).
 * E34: the PLAYER is never engine-selected here — the engine must not author the player's goodbye
 * or assert a tone computed from their hidden edge. A surviving player is appended as the LAST
 * sender by `commitStagedEviction`, where the goodbye stage pauses for their own decision.
 */
function selectGoodbyeSenders(s: LiveSeasonState, evictee: EntityId, player: EntityId, rng: RandomnessSource): EntityId[] {
  const remaining = s.active.filter((h) => h !== evictee && h !== player);
  return seededShuffle(remaining, rng).slice(0, Math.min(GOODBYE_MESSAGE_COUNT, remaining.length));
}

/** The revealed-only tally of an in-progress reveal: votes read so far for each nominee. */
function revealedTally(e: EvictionProgress): Record<EntityId, number> {
  const tally: Record<EntityId, number> = { [e.nominees[0]]: 0, [e.nominees[1]]: 0 };
  for (let i = 0; i < e.revealIx; i++) tally[e.voteOf[e.revealOrder[i]!]!]! += 1;
  return tally;
}

/** Begin the staged eviction: precompute the (already-decided) votes + the seeded reveal order. */
function beginEviction(s: LiveSeasonState, ctx: SeasonCtx, rng: RandomnessSource, playerVote: EntityId | undefined): void {
  const { fn, voteOf } = countEvictionVotes(s, ctx, playerVote);
  s.eviction = {
    stage: "votes",
    nominees: fn,
    revealOrder: seededShuffle([...voteOf.keys()], rng),
    voteOf: Object.fromEntries(voteOf),
    revealIx: 0,
    goodbyeFrom: [],
    goodbyeIx: 0,
  };
}

/**
 * Advance the live eviction ONE step (0047). votes (reveal one at a time, seeded) → the result lands
 * on the LAST vote (tally + HOH tie-break) → goodbye (an evictee goodbye + goodbye messages whose tone
 * folds into manner) → the house rolls into the next week. Pauses (returns null with `s.pending` set)
 * only for the player-HOH tie-break; everything else resolves deterministically.
 */
function advanceEviction(s: LiveSeasonState, ctx: SeasonCtx, rng: RandomnessSource): BeatEvent | null {
  const e = s.eviction!;
  switch (e.stage) {
    case "votes": {
      if (e.revealIx < e.revealOrder.length) {
        // Reveal a BATCH of ballots this advance (live-verify 2026-06-27): one ballot per advance made a
        // 14-voter eviction a ~14-advance slog of inert beats and let the model race ahead of the engine.
        // The batch size is derived from the TOTAL ballot count (stable + restart-safe — no extra state),
        // so the votes stage lands in ~4-8 rounds. PRESENTATION ONLY: the seeded reveal ORDER, the
        // precomputed tally, and the evictee on the LAST ballot are all unchanged; NO randomness here.
        const batch = stagedEvictionBatchSize(e.revealOrder.length);
        const from = e.revealIx;
        const to = Math.min(from + batch, e.revealOrder.length);
        e.revealIx = to;
        // E12: eviction votes are SECRET BALLOTS — the reveal reads the ballot(s), never the voter
        // ("a vote to evict X…" / "N votes to evict X"). `voteOf` stays engine-internal (manner/deal
        // reconciliation); attributions unseal only in the 0048 post-season retrospective. Anonymized
        // and never a cumulative tally or the evictee — `revealedTally` stays revealed-only.
        const participants = e.revealOrder.slice(from, to).map((voter) => e.voteOf[voter]!);
        return { beat: "eviction-reveal", content: batchedRevealContent(e, from, to), participants };
      }
      // The last vote is read: the tally decides (HOH breaks a tie — the player HOH pauses, B44).
      const tally = revealedTally(e);
      let evictee: EntityId;
      if (tally[e.nominees[0]]! > tally[e.nominees[1]]!) evictee = e.nominees[0];
      else if (tally[e.nominees[1]]! > tally[e.nominees[0]]!) evictee = e.nominees[1];
      else {
        if (s.hoh === ctx.player) { s.pending = { kind: "tie-break", by: ctx.player, nominees: e.nominees }; return null; }
        evictee = voteChoice(s.hoh!, e.nominees, ctx, currentBlocs(s, ctx));
        // B4 review fix: the HOH's tie-break is a vote too - it breaks (evicts the assured) or keeps (spares) their assurances like any ballot.
        ctx.assuranceVotedOut?.(s.hoh!, evictee);
        ctx.assuranceKeptAtVote?.(s.hoh!, e.nominees[0] === evictee ? e.nominees[1] : e.nominees[0]);
      }
      return commitStagedEviction(s, ctx, evictee, rng);
    }
    case "goodbye": {
      if (e.goodbyeIx < e.goodbyeFrom.length) {
        const sender = e.goodbyeFrom[e.goodbyeIx]!;
        if (sender === ctx.player) {
          // E34: the engine NEVER authors the player's goodbye — no beat fires until the player
          // chooses their own tone (the prose is the model's to voice from that choice).
          s.pending = { kind: "goodbye-message", by: ctx.player, evictee: e.evictee!, tones: [...GOODBYE_TONES] };
          return null;
        }
        e.goodbyeIx += 1;
        const tone = goodbyeTone(sender, e.evictee!, ctx);
        // The tone folds into the evictee's manner toward the sender (merged — a goodbye is the last word).
        const row = (s.mannerByEvictee![e.evictee!] ??= {});
        row[sender] = { ...(row[sender] ?? {}), ...goodbyeMannerFor(tone) };
        return { beat: "eviction-goodbye", content: `${sender} leaves ${e.evictee} a ${tone} goodbye message`, participants: [sender, e.evictee!] };
      }
      e.stage = "exit-interview";
      return advanceEviction(s, ctx, rng);
    }
    case "exit-interview": {
      // 0130 — after the house's goodbyes, the evictee is interviewed by the producers: they see + react
      // to their goodbye messages and tell their side. Fires for EVERY staged eviction (the same scope as
      // the goodbye stage). INERT to the seeded spine: it draws no rng and mutates no seeded state — the
      // NPC stance is a read-only derivation of the already-fixed manner; the record feeds only the 0048
      // retrospective. So the eviction order / finalists / winner are byte-identical to the pre-0130 model.
      if (!e.exitInterviewDone) {
        if (e.evictee === ctx.player) {
          // The player IS the evictee: their exit interview is their own — a real pending decision (never
          // engine-authored), exactly like the E34 goodbye message. No beat fires until they answer.
          s.pending = { kind: "exit-interview", by: ctx.player, evictee: e.evictee, stances: [...EXIT_STANCES] };
          return null;
        }
        const stance = npcExitStance(e.evictee!, s);
        (s.exitInterviews ??= []).push({ week: s.week, evictee: e.evictee!, stance });
        e.exitInterviewDone = true;
        return { beat: "exit-interview", content: exitInterviewContent(e.evictee!, stance), participants: [e.evictee!] };
      }
      e.stage = "result";
      return advanceEviction(s, ctx, rng);
    }
    case "result": {
      const evictee = e.evictee!;
      // 0133 — a PRE-JURY-evicted PLAYER chooses how to follow the rest of the season (once). The card is the
      // player's own choice; nothing here draws rng or mutates seeded state.
      if (evictee === ctx.player && !s.selfEvicted && !s.spectatorOffered && isPreJuryEvictee(s, ctx.player)) {
        s.pending = { kind: "spectator-choice", by: ctx.player, modes: [...SPECTATOR_MODES] };
        return null;
      }
      s.eviction = undefined;
      rollWeek(s); // the week's ceremony state clears and the house rolls on (or into the finale)
      return { beat: "eviction-result", content: `${evictee} leaves the house`, participants: [evictee] };
    }
  }
}

/** Once the evictee is known: record responsible manner, remove them, seed the goodbyes, open that stage. */
function commitStagedEviction(s: LiveSeasonState, ctx: SeasonCtx, evictee: EntityId, rng: RandomnessSource): BeatEvent {
  const e = s.eviction!;
  e.evictee = evictee;
  // E12: the ballots are recorded ENGINE-ONLY for the 0048 retrospective unsealing — the week's
  // secret votes become tellable only once the season is over.
  (s.voteRecord ??= []).push({ week: s.week, evictee, voteOf: { ...e.voteOf } });
  const votesToEvict = Object.entries(e.voteOf).filter(([, t]) => t === evictee).map(([v]) => v);
  // 0025 reactive: track the lopsided-eviction streak (the secret-veto trigger's "steamroll" signal).
  // A near-unanimous eviction (all-but-≤1 of a meaningful vote) extends the streak; a close vote resets it.
  const totalVoters = Object.keys(e.voteOf).length;
  const lopsided = totalVoters >= 3 && votesToEvict.length >= totalVoters - 1;
  s.lopsidedStreak = lopsided ? (s.lopsidedStreak ?? 0) + 1 : 0;
  // 0110 — the jury grudge folds on WHO THE EVICTEE BELIEVES moved against them, not the true secret
  // ballot. When deduction is on, the evictee deduces the defectors by process of elimination from the
  // PUBLIC count + eligible pool + their own reads (a belief that CAN be wrong); when off, we fold the
  // true `votesToEvict` exactly as before ⇒ byte-identical (no deduction runs, no sub-rng is drawn). The
  // HOH (public) is always responsible directly. `voteRecord` above keeps the TRUE tally for the 0048 unseal.
  const believedVoters = ctx.voteDeduction
    ? deduceEvictionVoters(
        evictee, Object.keys(e.voteOf), votesToEvict.length,
        ctx.rel, new SeededRandom(deductionSeed(evictee, s.week)),
      ).believed
    : votesToEvict;
  // #1790 — store the POSSIBLY-WRONG deduced set on engine-only season state for jury-house blame
  // routing (AC1). NEVER projected to any surface — this is an engine-only store.
  (s.deducedCulprits ??= {})[evictee] = believedVoters;
  // A62 - remember WHICH of those blames are wrong (flag-gated; no rng, no new draw): a mend appeal can later correct exactly these.
  if (ctx.jurorProfiles && ctx.voteDeduction) {
    const wrong = believedVoters.filter((v) => v !== evictee && !votesToEvict.includes(v) && v !== s.hoh);
    if (wrong.length) (s.mistakenBlame ??= {})[evictee] = wrong;
  }
  // #2017 S0a — mirror the evictee's possibly-wrong deduction into the belief store as `voted-against-me` claims (origin `deduced`). Flag-gated: OFF ⇒
  // the store is never created. Written from values already computed above (no rng, no new draw) and read by nothing, so it moves no outcome.
  if (ctx.npcBeliefs && ctx.voteDeduction) {  // only a REAL 0110 deduction is a belief: with deduction off `believedVoters` is the true ballot
    const store = (s.beliefs ??= {});
    for (const v of believedVoters) {
      recordClaim(store, { holder: evictee, kind: "voted-against-me", subject: v, value: true, origin: "deduced", confidence: DEDUCED_CLAIM_CONFIDENCE, week: s.week });
    }
  }
  recordEvictionManner(s, evictee, [s.hoh!, ...believedVoters], ctx);
  removeEvictee(s, evictee);          // out now — the last vote landed; the result is public
  e.goodbyeFrom = selectGoodbyeSenders(s, evictee, ctx.player, rng);
  // E34: a SURVIVING player always gets jury management's signature lever — their own goodbye
  // message, last, as a real pending decision (never engine-authored, never engine-toned).
  if (s.active.includes(ctx.player)) e.goodbyeFrom.push(ctx.player);
  e.stage = "goodbye";
  return { beat: "eviction", content: `${evictee} is evicted`, participants: [evictee] };
}

// --- Live finale sub-loop (0037) ----------------------------------------------

/**
 * The juror's directed read of a finalist, as the jury math (0014) wants it. The reliability term
 * is CENTERED on the edge baseline (E54): a juror with no protective track record reads 0 (neutral),
 * demonstrated loyalty reads positive, proven disloyalty negative — `juryLean` weights it below
 * relationship+manner.
 *
 * 0100 — the ACCUMULATED jury-house grudge (`s.juryGrudge[juror][finalist]`, bounded + saturated) is
 * folded in here, ALONGSIDE the recorded manner: it lowers the juror's BOND read (trust + affinity)
 * of the finalist, so a juror the jury house soured on goes in colder than the snapshot at their own
 * eviction implied. This is the ONLY change to the vote path — a richer (still hidden) lean INPUT; the
 * tally/tie-break/reveal are reused verbatim. Absent grudge (the default, or with `ORWELL_JURY_HOUSE`
 * off) ⇒ a zero subtraction ⇒ byte-identical to the pre-feature read. The grudge is sized UNDER the
 * manner lean (`JURY_HOUSE.adjustmentCap < |MANNER_LEAN.betrayed|`), so it DEEPENS jury management,
 * never swamps it. ENGINE-ONLY: no number crosses the wall.
 */
function edgeAsJuryRel(s: LiveSeasonState, juror: EntityId, finalist: EntityId, ctx: SeasonCtx): JuryRel {
  const e = ctx.rel.edge(juror, finalist);
  const grudge = s.juryGrudge?.[juror]?.[finalist] ?? 0;
  const cool = (x: number): number => Math.max(0, Math.min(1, x - grudge));
  return {
    // The grudge cools the bond read toward the finalist (clamped to [0,1]); threat/reliability are
    // unchanged. A colder bond lowers `juryLean`'s relationship term, exactly as a hardened room should.
    trust: cool(e.trust),
    affinity: cool(e.affinity),
    threat: e.threat,
    reliability: e.reliability - RELATIONSHIP_CONSTANTS.baseline.reliability,
  };
}

/** The recorded manner the evictee/juror read toward a finalist (empty if none). */
function mannerFor(s: LiveSeasonState, juror: EntityId, finalist: EntityId): EvictionManner {
  return s.mannerByEvictee?.[juror]?.[finalist] ?? {};
}

/**
 * A62 - the manner a juror weighs when VOTING. Flag-off (or no mistaken blame) => exactly `mannerFor`. With `ORWELL_JUROR_PROFILES` on, a juror who WRONGLY blames this finalist (0110 deduction error) carries
 * the grievance as `mistaken`; if the finalist made the `mend` appeal to that juror, the mistaken grievance is dissolved (the juror's held mistake is corrected). A TRUE grievance is never dissolved.
 */
export function mannerForVote(s: LiveSeasonState, ctx: SeasonCtx, f: FinaleProgress, juror: EntityId, fin: EntityId): EvictionManner {
  const base = mannerFor(s, juror, fin);
  if (!ctx.jurorProfiles || !s.mistakenBlame?.[juror]?.includes(fin)) return base;
  if (f.appeals[fin]?.[juror] !== "mend") return { ...base, mistaken: true };
  // ORW-129: a mend FADES the mistaken grievance, it does not erase it - the grievance flags stay, at MEND_TRACE.residual of their strength (a small lingering doubt). A TRUE grievance is never touched here.
  const { mistaken: _m, ...rest } = base;
  const hadGrievance = !!(rest.betrayed || rest.blindsided || rest.disrespected);
  return hadGrievance ? { ...rest, intensity: (rest.intensity ?? 1) * MEND_TRACE.residual } : rest;
}

/** Record the appeal a finalist made to a juror (appeals[finalist][juror]). */
function recordAppeal(f: FinaleProgress, finalist: EntityId, juror: EntityId, appeal: FinaleAppeal): void {
  (f.appeals[finalist] ??= {})[juror] = appeal;
}

/**
 * The appeal a finalist made to a juror — their recorded choice, or `undefined` if NONE was made.
 * With the 18-Q&A finale every juror questions BOTH finalists (audit A6 ruling), so in a complete
 * finale every (finalist, juror) pair is answered; an absent appeal means the finalist DID NOT answer
 * that juror (e.g. a player who skipped/abandoned the finale). SOC-NEW-4 (#567): we no longer launder
 * a missing answer into `bestAppeal` (the argmax-OPTIMAL choice) — that scored not-answering as
 * answering perfectly, a player-favoring anti-sycophancy violation. The caller floors a missing appeal.
 */
function appealMade(
  f: FinaleProgress, finalist: EntityId, juror: EntityId,
): FinaleAppeal | undefined {
  return f.appeals[finalist]?.[juror];
}

/**
 * The finale-performance term for a finalist toward a juror. A RECORDED appeal scores by its actual
 * `appealEffect`; an ABSENT appeal (the finalist never answered this juror) scores at the FLOOR — the
 * weakest effect available against this juror, never the argmax-best. So failing to answer can never
 * beat actually answering (SOC-NEW-4 / #567, anti-sycophancy).
 */
function appealPerf(
  f: FinaleProgress, finalist: EntityId, juror: EntityId, ctx: SeasonCtx, s: LiveSeasonState,
): number {
  const rel = edgeAsJuryRel(s, juror, finalist, ctx);
  const manner = mannerFor(s, juror, finalist);
  const made = appealMade(f, finalist, juror);
  if (made !== undefined) return appealEffect(made, rel, manner);
  // No appeal made — score the floor (the worst appeal this juror could have heard), so not-answering
  // is strictly no better than the weakest real answer.
  return Math.min(...FINALE_APPEALS.map((a) => appealEffect(a, rel, manner)));
}

/** Begin the live finale: lock the Final 2, the last-9 jury, and the engine choreography. */
function beginFinale(s: LiveSeasonState): FinaleProgress {
  const finalists: [EntityId, EntityId] = [s.active[0]!, s.active[1]!];
  const jury = s.evictionOrder.slice(-9);
  const script = buildFinaleScript(finalists, jury);
  return {
    stage: "statements", finalists, jury, script,
    statementIx: 0, questionIx: 0, appeals: {}, revealIx: 0,
  };
}

/**
 * Precompute every juror's vote ONCE (so the tally and the one-at-a-time reveal agree), driving
 * each through `castJuryVote` with the engine lean (relationship + recorded manner) and the
 * BOUNDED finale performance (`appealEffect` of the appeal actually made). The player's own juror
 * vote, if any, is already recorded and is preserved. Deterministic for a given seed.
 */
/** The other finalist in the pair. */
function otherFinalist(finalists: [EntityId, EntityId], fin: EntityId): EntityId {
  return finalists[0] === fin ? finalists[1] : finalists[0];
}

function precomputeVotes(s: LiveSeasonState, ctx: SeasonCtx, f: FinaleProgress, rng: RandomnessSource): Record<EntityId, EntityId> {
  const votes: Record<EntityId, EntityId> = { ...(f.votes ?? {}) };
  for (const juror of f.jury) {
    if (votes[juror]) continue; // the player's own vote (recorded interactively) is kept
    const prof = ctx.jurorProfiles ? jurorProfile(juror, ctx.jurorProfileSalt ?? 0) : undefined; // A2: this juror's OWN profile (flag-gated; no rng)
    const leanFor = prof
      ? (fin: EntityId): number =>
          profiledLean(edgeAsJuryRel(s, juror, fin, ctx), mannerForVote(s, ctx, f, juror, fin), prof) +
          profiledWeights(prof).gameRespect * gameRespectTerm(s.resume?.[fin] ?? 0, s.resume?.[otherFinalist(f.finalists, fin)] ?? 0) +
          (ctx.juryMemoryFor?.(juror, fin) ?? 0)
      : (fin: EntityId): number =>
      juryLean(edgeAsJuryRel(s, juror, fin, ctx), mannerForVote(s, ctx, f, juror, fin)) +
      // GAME RESPECT (ruling 2026-06-11): jurors weigh who actually PLAYED — the public resume
      // (comp wins) splits the two finalists; a goat with no game starts every juror down a
      // bounded notch. Grievance (manner) can still outvote it: bitter juries stay possible.
      JURY_WEIGHTS.gameRespect * gameRespectTerm(s.resume?.[fin] ?? 0, s.resume?.[otherFinalist(f.finalists, fin)] ?? 0) +
      (ctx.juryMemoryFor?.(juror, fin) ?? 0); // B26: the juror's memory of the finalist (flag-gated provider)
    // Each juror questioned BOTH finalists (18-Q&A), so each has a recorded appeal here — scored
    // symmetrically by the same `appealEffect`; the player's own answers are exactly as weighted as the NPC's.
    const perfFor = (fin: EntityId): number => appealPerf(f, fin, juror, ctx, s);
    votes[juror] = prof ? castJuryVote(f.finalists, leanFor, perfFor, rng, profiledWeights(prof)) : castJuryVote(f.finalists, leanFor, perfFor, rng);
  }
  return votes;
}

/**
 * Advance the live finale ONE step (0037). Statements → each juror questions both finalists → the
 * vote → a one-at-a-time reveal → the winner. Pauses (returns null with `s.pending` set) for the
 * player's own statement / answers / juror vote; everything else resolves deterministically.
 */
function advanceFinale(s: LiveSeasonState, ctx: SeasonCtx, rng: RandomnessSource): BeatEvent | null {
  const f = (s.finale ??= beginFinale(s));
  switch (f.stage) {
    case "statements": {
      if (f.statementIx >= f.script.statements.length) { f.stage = "questions"; return advanceFinale(s, ctx, rng); }
      const finalist = f.script.statements[f.statementIx]!;
      if (finalist === ctx.player) {
        s.pending = { kind: "finale-statement", by: ctx.player };
        return null;
      }
      f.statementIx += 1;
      return { beat: "finale", content: `${finalist} gives an opening statement`, participants: [finalist] };
    }
    case "questions": {
      if (f.questionIx >= f.script.questions.length) { f.stage = "vote"; return advanceFinale(s, ctx, rng); }
      const q = f.script.questions[f.questionIx]!;
      if (q.finalist === ctx.player) {
        s.pending = { kind: "finale-answer", by: ctx.player, juror: q.juror, appeals: [...FINALE_APPEALS] };
        return null;
      }
      if (q.juror === ctx.player) {
        // E37: the player-JUROR asks their own question (scoreless free text) — their seat at the
        // finale is a real beat, not a spectator slot the engine auto-fills.
        s.pending = { kind: "juror-question", by: ctx.player, finalist: q.finalist };
        return null;
      }
      // NPC finalist answers optimally for this juror (deterministic argmax), recorded for the tally.
      const appeal = bestAppeal(edgeAsJuryRel(s, q.juror, q.finalist, ctx), mannerFor(s, q.juror, q.finalist));
      recordAppeal(f, q.finalist, q.juror, appeal);
      f.questionIx += 1;
      return { beat: "finale", content: `${q.finalist} answers ${q.juror}`, participants: [q.finalist, q.juror] };
    }
    case "vote": {
      // If the player is a juror and hasn't voted yet, stop for their own vote first.
      if (f.jury.includes(ctx.player) && !(f.votes?.[ctx.player])) {
        s.pending = { kind: "juror-vote", by: ctx.player, finalists: f.finalists };
        return null;
      }
      f.votes = precomputeVotes(s, ctx, f, rng);
      f.stage = "reveal";
      return { beat: "finale", content: `the jury casts their votes`, participants: [...f.finalists] };
    }
    case "reveal": {
      // #1790 AC4 — regroup the reveal order for drama when traitorsFury is ON
      // (groups jurors by which finalist they voted for). The original revealOrder is
      // untouched; the tally/winner are order-independent. Pure presentation-only regrouping.
      const revealOrder = ctx.traitorsFury && f.votes
        ? [
            ...f.jury.filter((j) => f.votes![j] === f.finalists[0]!),
            ...f.jury.filter((j) => f.votes![j] === f.finalists[1]!),
          ]
        : f.script.revealOrder;
      if (f.revealIx < revealOrder.length) {
        const juror = revealOrder[f.revealIx]!;
        const voted = f.votes![juror]!;
        f.revealIx += 1;
        return { beat: "finale-reveal", content: `${juror} votes for ${voted}`, participants: [juror, voted] };
      }
      // All votes revealed: tally (last-evicted-juror tie-break, reused) and crown the winner.
      const winner = tallyJury(f.jury, f.finalists, (j) => f.votes![j]!, s.evictionOrder);
      s.finalTwo = f.finalists; s.jury = f.jury; s.winner = winner; s.finished = true; s.beat = "complete";
      // 0133 — a pre-jury-evicted PLAYER takes part in the finale night with an interview (posture + words). It is
      // raised AFTER the jury has decided, so it can never move a vote or the winner, and it never blocks the
      // crowning (the season is already crowned when it is offered).
      if (!s.selfEvicted && !s.finaleInterview && isPreJuryEvictee(s, ctx.player)) {
        s.pending = { kind: "finale-interview", by: ctx.player, stances: [...EXIT_STANCES] };
      }
      const loser = f.finalists.find((x) => x !== winner)!;
      return { beat: "finale-result", content: `${winner} wins the season over ${loser}`, participants: [...f.finalists] };
    }
  }
}

/**
 * Advance one beat. Returns the meaningful event produced, or `null` if the loop is
 * blocked on a player decision (`state.pending` is set) or already complete.
 */
export function advance(s: LiveSeasonState, ctx: SeasonCtx, rng: RandomnessSource): BeatEvent | null {
  if (s.pending || s.finished || s.beat === "complete") return null;

  switch (s.beat) {
    case "hoh-competition":
      // ORW-116 (Ryne 2026-11-06): NO phase advance moves the clock. The clock starts at the premiere ENTRY (afternoon) and ticks through the entrances and the toast for real (see the adapter), so the premiere
      // exit is just the next beat, and the first night is the player's to spend (below).
      // ORW-116 (a): the first NIGHT is crossed (the player turned in, or the night ran out) before the first HOH: one diegetic day-break to the first morning, the competition set for that afternoon.
      if (ctx.nightGate && s.week === 1 && s.nightDepth !== undefined && !s.firstNightPassed && (s.dayNumber ?? 1) < 2 && s.twist?.phase !== "running") {
        if (ctx.nightHold && nightHeld(s)) return null; // ORW-116 (b): the first night is the player's to spend
        s.firstNightPassed = true;
        crossToNextDay(s);
        return {
          beat: "day-break",
          content: "The first night in the house is over, and the first morning dawns. The Head of Household competition is set for this afternoon.",
          participants: [],
        };
      }
      // STAGED (0006 staged-rounds evolution): the comp plays out in visible elimination rounds. The
      // sub-loop pauses for the player's PER-ROUND approach (`comp-round`) when they are still in —
      // committed before each round resolves, locked after (anti-sycophancy). No up-front binding popup.
      return resolveHohBeat(s, ctx, rng);
    case "final-eviction": {
      // Final 3 (0045): the final HOH evicts one of the other two; the survivor + HOH are the Final 2.
      const rivals = s.active.filter((h) => h !== s.hoh) as EntityId[];
      if (s.hoh === ctx.player) {
        s.pending = { kind: "final-eviction", by: ctx.player, options: [rivals[0]!, rivals[1]!] };
        return null;
      }
      // NPC final HOH evicts the higher-threat rival (relationship-driven, decision 0002).
      const evictee = [...rivals].sort((a, b) => ctx.rel.edge(s.hoh!, b).threat - ctx.rel.edge(s.hoh!, a).threat)[0]!;
      const ev: BeatEvent = { beat: "final-eviction", content: `${s.hoh} evicts ${evictee}, setting the Final 2`, participants: [s.hoh!, evictee] };
      applyEviction(s, evictee, ctx, [s.hoh!]);
      return ev;
    }
    case "nominations": {
      // #1320 NIGHT-GATE: the HOH crown and the nominations must not resolve in the same in-fiction
      // moment. When the clock pacing is live, the FIRST advance into this beat crosses the night to the
      // next morning as its own diegetic `day-break` beat (one-shot per reign), and nominations resolve on
      // the following advance — Day 1 HOH → Day 2 noms (day order WEEKLY_CADENCE.dayOf; slots DAY_SCHEDULE), never a fast-forward. GATED, so a
      // clock-off / calibration game skips this entirely ⇒ byte-identical. (ADR 0006: a diegetic day
      // boundary, not a curfew — it never interrupts an engaged scene, it just seats the ceremony a day on.)
      // TWIST GUARD (all four cadence gates): a RUNNING double eviction is a single COMPRESSED night by
      // design (`rollWeek` re-arms these flags before flipping the twist to "running"), so the re-armed
      // gates must NOT fire during it — that would stretch the same-night second cycle across days. Skip
      // every day-break while `s.twist?.phase === "running"`; the ordinary (non-twist) week is untouched.
      if (ctx.nightGate && !s.preNomsNightPassed && s.twist?.phase !== "running") {
        if (ctx.nightHold && nightHeld(s)) return null; // ORW-116 (b): never auto-run the night
        s.preNomsNightPassed = true;
        crossToNextDay(s);
        return {
          beat: "day-break",
          content: "The house turns in for the night, and a new day dawns over the Head of Household's first morning in power.",
          participants: [],
        };
      }
      if (s.hoh === ctx.player) {
        s.pending = { kind: "nominations", by: ctx.player, options: s.active.filter((h) => h !== ctx.player), pick: 2 };
        return null;
      }
      // The strategic nomination read (0044): threat-primary, bent by the rattled-HOH paranoia
      // term (0041), the bloc shield (0043), the week's political temperature, and the HOH's own
      // disposition-gated tactic (pawn / backdoor / direct). Legality still binds downstream.
      const plan = nominationPlan(s.hoh!, s.active, ctx.rel, {
        blocs: currentBlocs(s, ctx),
        mood: ctx.emotionalOf?.(s.hoh!) ?? 0.5,
        disposition: ctx.dispositionOf?.(s.hoh!) ?? "neutral",
        style: ctx.nominationStyleOf?.(s.hoh!),
        ...(ctx.campaignPushFor ? { campaignPush: (t: EntityId) => ctx.campaignPushFor!(t, s.hoh!) } : {}),
        ...(ctx.memoryTiltFor ? { memoryPush: (t: EntityId) => ctx.memoryTiltFor!(t, s.hoh!) } : {}),
        ...(ctx.moodTiltFor ? { moodPush: (t: EntityId) => ctx.moodTiltFor!(t, s.hoh!) } : {}),
        ...(ctx.drivePushFor ? { drivePush: (t: EntityId) => ctx.drivePushFor!(t, s.hoh!) } : {}),
        ...(ctx.beliefTiltFor ? { beliefPush: (t: EntityId) => ctx.beliefTiltFor!(t, s.hoh!) } : {}),
        ...(ctx.dealNomPushFor || ctx.tieNomPushFor ? { dealPush: (t: EntityId) => (ctx.dealNomPushFor?.(t, s.hoh!) ?? 0) + (ctx.tieNomPushFor?.(t, s.hoh!) ?? 0) } : {}),
        ...(ctx.pitchTiltFor ? { pitchPush: (t: EntityId) => ctx.pitchTiltFor!(t, s.hoh!) } : {}),
        ...(ctx.assuranceProtects ? { protectedByAssurance: (t: EntityId) => ctx.assuranceProtects!(t, s.hoh!) } : {}),
      });
      const nominees = plan.nominees;
      if (ctx.assuranceNominated) for (const n of nominees) ctx.assuranceNominated(s.hoh!, n);
      ctx.assuranceKeptAtNominations?.(s.hoh!, nominees); // B4 slice 8: whoever the HOH had assured and did NOT nominate was spared => kept
      s.nominationTarget = plan.target; // #1948: the replacement branches on WHO the target is
      s.nominees = nominees; s.beat = "veto-competition";
      return { beat: "nominations", content: `${s.hoh} nominates ${nominees[0]} and ${nominees[1]}`, participants: [s.hoh!, ...nominees] };
    }
    case "veto-competition": {
      // Phase 3a NIGHT-GATE: the veto comp is its own day (Day 3, after nominations on Day 2). The first
      // advance into it crosses the night as a one-shot diegetic day-break, before the chip draw. GATED on
      // the clock ⇒ a clock-off calibration game skips it ⇒ byte-identical.
      if (ctx.nightGate && !s.preVetoNightPassed && !s.vetoField && s.twist?.phase !== "running") {
        if (ctx.nightHold && nightHeld(s)) return null; // ORW-116 (b): never auto-run the night
        s.preVetoNightPassed = true;
        crossToNextDay(s);
        return {
          beat: "day-break",
          content: "The house turns in, and morning breaks on the day of the Power of Veto competition.",
          participants: [],
        };
      }
      // E35 stage A: the chip draw is a witnessed ceremony of its own — it precedes any winner.
      if (!s.vetoField) return resolveVetoDraw(s, ctx, rng);
      // STAGED (0006 staged-rounds evolution): the veto comp plays out in elimination rounds exactly
      // like the HOH comp — the sub-loop pauses for the player's PER-ROUND approach when they are in
      // the drawn field. The draw (above) always precedes the rounds.
      return resolveVetoComp(s, ctx, rng);
    }
    case "veto-ceremony": {
      // #1782 (open): the DECIDE→COMMIT→VOICE micro-call would hook here. Its do-nothing flag scaffold
      // was removed; that work brings its own flag when it is built.
      // Phase 3a NIGHT-GATE: the veto ceremony is its own day (Day 4). One-shot day-break before it resolves.
      if (ctx.nightGate && !s.preVetoCeremonyNightPassed && s.twist?.phase !== "running") {
        if (ctx.nightHold && nightHeld(s)) return null; // ORW-116 (b): never auto-run the night
        s.preVetoCeremonyNightPassed = true;
        crossToNextDay(s);
        return {
          beat: "day-break",
          content: "The house sleeps, and a new day arrives — the morning of the Veto Ceremony.",
          participants: [],
        };
      }
      const nominees = s.nominees!;
      if (s.vetoHolder === ctx.player) {
        // The holder may save either nominee (incl. self if nominated) — the whole pair is saveable…
        // …UNLESS no legal replacement exists (the Final-4 rule, E36): then "use" is not a real
        // option and the legal set says so up front, instead of accepting a save and silently
        // inverting it into "does not use the veto".
        const saveable = selectableReplacements(weekState(s, ctx)).length > 0 ? [...nominees] : [];
        s.pending = { kind: "veto-decision", by: ctx.player, nominees, saveable };
        return null;
      }
      // NPC veto holder: save self if nominated, else the most save-worthy nominee — trust shaded
      // by demonstrated loyalty (E54), so a proven protector outranks an equally-liked stranger.
      const saved = nominees.includes(s.vetoHolder!)
        ? s.vetoHolder!
        : ctx.rel.chooseVetoSave(
          s.vetoHolder!, nominees,
          // #1937: a protect campaign on a nominee pushes the holder toward saving them, an evict one away.
          ctx.campaignPushFor || ctx.vetoMemoryFor || ctx.moodVetoFor || ctx.drivePushFor
            ? (n: EntityId) => (ctx.campaignPushFor ? -ctx.campaignPushFor(n, s.vetoHolder!) : 0) + (ctx.vetoMemoryFor?.(n, s.vetoHolder!) ?? 0) + (ctx.moodVetoFor?.(n, s.vetoHolder!) ?? 0) - (ctx.drivePushFor?.(n, s.vetoHolder!) ?? 0)
            : undefined,
        );
      if (!saved) {
        s.vetoUsed = false; s.finalNominees = [nominees[0], nominees[1]]; s.beat = "eviction";
        return { beat: "veto-ceremony", content: `${s.vetoHolder} does not use the veto`, participants: [s.vetoHolder!] };
      }
      s.vetoUsed = true; s.saved = saved;
      return resolveReplacement(s, ctx); // either pends on the player-HOH or NPC-picks, then → eviction
    }
    case "eviction": {
      // Phase 3a NIGHT-GATE: eviction is its own day (Day 5). One-shot day-break before the reveal begins —
      // guarded on `!s.eviction` so a mid-reveal re-entry never re-fires it. GATED on the clock (byte-identical off).
      if (ctx.nightGate && !s.preEvictionNightPassed && !s.eviction && s.twist?.phase !== "running") {
        if (ctx.nightHold && nightHeld(s)) return null; // ORW-116 (b): never auto-run the night
        s.preEvictionNightPassed = true;
        crossToNextDay(s);
        return {
          beat: "day-break",
          content: "Night falls one last time this week, and eviction day dawns over the house.",
          participants: [],
        };
      }
      if (s.eviction) return advanceEviction(s, ctx, rng); // a reveal is already staging — step it
      // 0025 secret veto: a final nominee secretly holds the unplayed safety — they may pull off the
      // block before the vote (player: their choice; NPC: a rational self-save). One eviction still lands.
      const sp = maybePlaySecretVeto(s, ctx, rng);
      if (sp.handled) return sp.event; // a reveal event (played) OR null with the player's choice pending
      const fn = s.finalNominees!;
      const voters = evictionVoters({ ...weekState(s, ctx), nominees: fn });
      if (voters.includes(ctx.player)) {
        s.pending = { kind: "eviction-vote", by: ctx.player, nominees: fn };
        return null;
      }
      // The player is HOH or a nominee: NPC votes are decided; stage the one-at-a-time reveal (0047).
      beginEviction(s, ctx, rng, undefined);
      return advanceEviction(s, ctx, rng);
    }
    case "twist-reveal": {
      // The sealed twist FIRES (0025): a dramatic, witnessed production reveal — only now is it
      // known to anyone. The compressed second cycle opens at a fresh HOH competition.
      s.beat = "hoh-competition";
      return {
        beat: "twist-reveal",
        content: "But the night is not over — this is a DOUBLE EVICTION. A new Head of Household " +
          "will be crowned and a second houseguest will walk out that door tonight.",
        participants: [...s.active],
      };
    }
    case "battle-back":
      // 0025 reactive: the sealed battle-back FIRES — recently-evicted jurors compete and one
      // re-enters the game. Only now is it known. The returning week's HOH comp opens next.
      return resolveBattleBack(s, ctx, rng);
    case "finale":
      return advanceFinale(s, ctx, rng);
    default:
      return null;
  }
}

// --- 0025 reactive twist mechanics (secret veto off the block, battle-back juror return) ---------

/** The houseguests the HOH may name as the secret-veto replacement: active, non-HOH, non-nominee. */
function secretVetoReplacementOptions(s: LiveSeasonState, holder: EntityId): EntityId[] {
  const fn = s.finalNominees!;
  return s.active.filter((h) => h !== s.hoh && h !== holder && !fn.includes(h));
}

/**
 * If a final nominee secretly holds an unplayed safety, resolve it at the eviction gate. The player's
 * is THEIRS to play (a pending choice); an NPC's is engine-resolved (a rational underdog on the block
 * saves themselves). Playing it removes the holder and the HOH names a replacement — still exactly one
 * eviction that week (format-preserving). `handled:false` ⇒ no power in play, proceed normally.
 */
function maybePlaySecretVeto(
  s: LiveSeasonState, ctx: SeasonCtx, rng: RandomnessSource,
): { handled: boolean; event: BeatEvent | null } {
  const sp = s.secretVeto;
  if (!sp || sp.used) return { handled: false, event: null };
  const fn = s.finalNominees!;
  if (!fn.includes(sp.holder)) return { handled: false, event: null }; // holder not on the block this week
  if (sp.declinedWeek === s.week) return { handled: false, event: null }; // player already chose to hold it
  const options = secretVetoReplacementOptions(s, sp.holder);
  if (options.length === 0) return { handled: false, event: null }; // no legal replacement ⇒ cannot force one
  if (sp.holder === ctx.player) {
    if (!s.pending) s.pending = { kind: "secret-veto", by: ctx.player, nominee: sp.holder };
    return { handled: true, event: null }; // the player's choice — pause here
  }
  return { handled: true, event: playSecretVeto(s, ctx, sp.holder, options) };
}

/** Play the secret veto: the holder comes off the block, the HOH names a replacement, the reveal fires. */
function playSecretVeto(s: LiveSeasonState, ctx: SeasonCtx, holder: EntityId, options: EntityId[]): BeatEvent {
  const sp = s.secretVeto!;
  sp.used = true;
  const fn = s.finalNominees!;
  const staying = fn[0] === holder ? fn[1] : fn[0];
  const hoh = s.hoh!;
  const mood = ctx.emotionalOf?.(hoh) ?? 0.5;
  const replacement = [...options].sort((a, b) => nominationScore(hoh, b, ctx.rel, mood) - nominationScore(hoh, a, ctx.rel, mood))[0]!;
  s.finalNominees = [staying, replacement];
  (s.firedTwists ??= []).push({ kind: "secret-veto", beat: s.week });
  return {
    beat: "twist-reveal",
    content: `SECRET VETO: ${holder} reveals a secret one-time safety and removes themselves from the block; ` +
      `${hoh} must name ${replacement} as the replacement nominee`,
    participants: [holder, hoh, replacement, staying],
  };
}

/**
 * Resolve the battle-back: the most-recently-evicted jurors compete and the winner RE-ENTERS the game.
 * The returnee is pulled out of the eviction record (their first eviction is voided — no grudge stands)
 * and back into the active house; when they are re-evicted later they rejoin the jury, so the finale
 * still closes at a jury of nine and a Final 2. The player, if a juror in the window, competes.
 */
function resolveBattleBack(s: LiveSeasonState, ctx: SeasonCtx, rng: RandomnessSource): BeatEvent {
  const k = Math.min(4, s.evictionOrder.length);
  const field = s.evictionOrder.slice(-k); // the recent jurors — includes the player if they were one
  const def = drawFor(s, "hoh", rng, ctx);
  const winner = resolveComp(field, def, ctx, rng, "compete").winner;
  // The returnee leaves the eviction record. The jury is POSITIONAL (the last `castSize - 11`-onward evictions), so removing ANY returnee shifts later evictees down
  // an index — a pre-jury returnee pushes the first juror out of the jury, a juror returnee just leaves it. Either way the count of non-player jurors can DROP; remember
  // how many (`juryReturns`): the jury-house arrivals counter is persisted + monotonic (the integrity checkpoint reads a lowered counter as degradation), so its
  // target must keep counting jurors that already arrived rather than the counter being lowered.
  const castSize = s.active.length + s.evictionOrder.length;
  const nonPlayerJurors = (order: readonly EntityId[]): number => order.slice(Math.max(0, castSize - 11)).filter((h) => h !== ctx.player).length;
  const jurorsBefore = nonPlayerJurors(s.evictionOrder);
  s.evictionOrder = s.evictionOrder.filter((h) => h !== winner);
  const dropped = jurorsBefore - nonPlayerJurors(s.evictionOrder);
  if (dropped > 0) s.juryReturns = (s.juryReturns ?? 0) + dropped;
  s.active.push(winner);
  // A returning PLAYER is a player again: a pre-jury evictee who chose to watch/skip (0133) must not stay a spectator, or the loop would keep
  // fast-forwarding their own weeks as if they were still watching from outside (found by the reactive-twists player-path guard).
  if (winner === ctx.player) s.spectator = undefined;
  if (s.mannerByEvictee) delete s.mannerByEvictee[winner]; // the voided eviction leaves no jury grudge
  (s.firedTwists ??= []).push({ kind: "battle-back", beat: s.week });
  s.beat = "hoh-competition";
  return {
    beat: "twist-reveal",
    content: `BATTLE-BACK: the evicted jurors compete for a second chance — ${winner} wins and re-enters the game.`,
    participants: [...field],
  };
}

/** After a veto save: the HOH names the replacement (player pends; NPC auto-picks). */
function resolveReplacement(s: LiveSeasonState, ctx: SeasonCtx): BeatEvent | null {
  const options = replacementOptions(s, ctx);
  if (options.length === 0) {
    // Final-4 edge: no legal replacement exists, so the veto cannot force one — it
    // resolves UNUSED and the original nominees stand (the holder is the sole voter).
    s.vetoUsed = false; s.saved = undefined; s.finalNominees = [s.nominees![0], s.nominees![1]]; s.beat = "eviction";
    return { beat: "veto-ceremony", content: `${s.vetoHolder} does not use the veto`, participants: [s.vetoHolder!] };
  }
  if (s.hoh === ctx.player) {
    s.pending = { kind: "replacement", by: ctx.player, saved: s.saved!, options };
    return null;
  }
  // The replacement reads the same blended strategy (0044): threat + the rattled-paranoia term + the
  // bloc shield + the HOH's style. If the target is still up (the pawn came down), the HOH names a new
  // PAWN; if the target came down — or this is a backdoor — they name the real target (0044 §9).
  const replacement = replacementPick(s.hoh!, otherNominee(s), options, s.active, ctx.rel, {
    blocs: currentBlocs(s, ctx),
    mood: ctx.emotionalOf?.(s.hoh!) ?? 0.5,
    style: ctx.nominationStyleOf?.(s.hoh!),
    target: s.nominationTarget,
    ...(ctx.campaignPushFor ? { campaignPush: (t: EntityId) => ctx.campaignPushFor!(t, s.hoh!) } : {}),
    ...(ctx.memoryTiltFor ? { memoryPush: (t: EntityId) => ctx.memoryTiltFor!(t, s.hoh!) } : {}),
        ...(ctx.moodTiltFor ? { moodPush: (t: EntityId) => ctx.moodTiltFor!(t, s.hoh!) } : {}),
        ...(ctx.drivePushFor ? { drivePush: (t: EntityId) => ctx.drivePushFor!(t, s.hoh!) } : {}),
    ...(ctx.beliefTiltFor ? { beliefPush: (t: EntityId) => ctx.beliefTiltFor!(t, s.hoh!) } : {}),
  });
  s.replacement = replacement; s.finalNominees = [otherNominee(s), replacement]; s.beat = "eviction";
  ctx.assuranceNominated?.(s.hoh!, replacement); // B4 review fix: naming an assured houseguest the REPLACEMENT breaks the HOH's assurance to them too
  return {
    beat: "veto-ceremony",
    content: `${s.vetoHolder} uses the veto on ${s.vetoHolder === s.saved ? "themselves" : s.saved}; ${s.hoh} names ${replacement} as the replacement`,
    participants: [s.vetoHolder!, s.saved!, s.hoh!, replacement],
  };
}

/**
 * The NPC policy for ANY pending player decision (B55/audit D12): what an NPC sitting in the
 * player's seat would do, by the SAME relationship-driven reads the loop's own NPC paths use.
 * Lets the calibration driver (`playSeason`) and tests auto-answer pendings so the one live
 * loop plays unattended — there is no second rulebook to drift.
 */
export function autoDecision(s: LiveSeasonState, ctx: SeasonCtx, rng: RandomnessSource): DecisionInput {
  const p = s.pending;
  if (!p) throw new Error("no pending decision to auto-resolve");
  const byThreat = (holder: EntityId, cands: readonly EntityId[]): EntityId =>
    [...cands].sort((a, b) => ctx.rel.edge(holder, b).threat - ctx.rel.edge(holder, a).threat)[0]!;
  switch (p.kind) {
    case "comp-intent":
      return { kind: "comp-intent", intent: "compete" };
    case "comp-round":
      // The staged per-round approach (0006 staged-rounds): an NPC in the player's seat competes
      // every round (the same default the loop's NPC competitors use — no second rulebook).
      return { kind: "comp-round", intent: "compete" };
    case "nominations": {
      // The same strategic read the loop's own NPC HOHs use (no second rulebook).
      const [a, b] = nominationStrategy(p.by, s.active, ctx.rel, {
        blocs: currentBlocs(s, ctx),
        mood: ctx.emotionalOf?.(p.by) ?? 0.5,
        disposition: ctx.dispositionOf?.(p.by) ?? "neutral",
        style: ctx.nominationStyleOf?.(p.by),
      });
      return { kind: "nominations", choice: [a, b] };
    }
    case "veto-decision": {
      // Mirror the NPC veto holder: save self if nominated, else the most save-worthy nominee
      // (trust shaded by demonstrated loyalty, E54) — from the LEGAL saveable set only (empty at
      // Final 4, E36: using the veto is barred).
      const saved = p.saveable.includes(p.by)
        ? p.by
        : ctx.rel.chooseVetoSave(p.by, p.saveable);
      return saved ? { kind: "veto-decision", use: true, save: saved } : { kind: "veto-decision", use: false };
    }
    case "houseguests-choice":
      return { kind: "houseguests-choice", pick: ctx.rel.chooseStrongestBond(p.by, p.options, rng) };
    case "replacement":
      // The same pawn-or-target replacement read the loop's NPC HOHs use (0044 §9) — no second rulebook.
      return {
        kind: "replacement",
        replacement: replacementPick(p.by, otherNominee(s), p.options, s.active, ctx.rel, {
          blocs: currentBlocs(s, ctx), mood: ctx.emotionalOf?.(p.by) ?? 0.5, style: ctx.nominationStyleOf?.(p.by),
          target: s.nominationTarget,
        }),
      };
    case "eviction-vote":
      return { kind: "eviction-vote", vote: voteChoice(p.by, p.nominees, ctx, currentBlocs(s, ctx), s.hoh ?? undefined) };
    case "tie-break":
      return { kind: "tie-break", evict: voteChoice(p.by, p.nominees, ctx, currentBlocs(s, ctx)) };
    case "final-eviction":
      return { kind: "final-eviction", evict: byThreat(p.by, p.options) };
    case "goodbye-message":
      // The same relationship-derived tone an NPC sender would use (no second rulebook).
      return { kind: "goodbye-message", tone: goodbyeTone(p.by, p.evictee, ctx) };
    case "exit-interview":
      // 0130 — the same manner-derived stance an NPC evictee would take (auto-play default; the live
      // player answers for themselves through submitDecision).
      return { kind: "exit-interview", stance: npcExitStance(p.evictee, s) };
    case "spectator-choice":
      return { kind: "spectator-choice", mode: "watch" };
    case "finale-interview":
      return { kind: "finale-interview", stance: npcExitStance(p.by, s) };
    case "finale-statement":
      return { kind: "finale-statement", statement: "" };
    case "finale-answer":
      return { kind: "finale-answer", appeal: bestAppeal(edgeAsJuryRel(s, p.juror, p.by, ctx), mannerFor(s, p.juror, p.by)) };
    case "juror-question":
      return { kind: "juror-question", question: "" };
    case "juror-vote": {
      const lean = (fin: EntityId): number => juryLean(edgeAsJuryRel(s, p.by, fin, ctx), mannerFor(s, p.by, fin));
      return { kind: "juror-vote", vote: lean(p.finalists[0]) >= lean(p.finalists[1]) ? p.finalists[0] : p.finalists[1] };
    }
    case "self-evict":
      // 0061: an NPC sitting in the player's seat NEVER voluntarily quits — and the self-evict
      // confirmation never rides `s.pending` (it lives on `selfEvictPending`), so the auto-driver
      // (calibration / admin fast-forward) is never asked to resolve one. Refuse defensively.
      throw new Error("self-eviction is a deliberate player choice — never auto-resolved");
    case "secret-veto":
      // 0025: a rational underdog on the block plays their one-time safety to save themselves.
      return { kind: "secret-veto", use: true };
  }
}

/** Apply the player's decision for the current `pending`, then continue to the next beat. */
export function applyDecision(
  s: LiveSeasonState, input: DecisionInput, ctx: SeasonCtx,
  // Only the Houseguest's-Choice resume needs randomness (to run the veto comp once the field completes);
  // the live adapter passes the beat-deterministic rng, so the same seed reproduces the same outcome.
  rng: RandomnessSource = new SeededRandom(1),
): BeatEvent {
  // `comp-intent` and `comp-round` are interchangeable aliases for the staged per-round approach (the
  // live pending is `comp-round`; the legacy/alias input may arrive as either). Every other kind must match.
  const compApproach = (k: string): boolean => k === "comp-intent" || k === "comp-round";
  const matches = s.pending && (s.pending.kind === input.kind || (compApproach(s.pending.kind) && compApproach(input.kind)));
  if (!matches) {
    throw new Error(`no pending ${input.kind} decision`);
  }
  switch (input.kind) {
    case "nominations": {
      const legal = new Set(s.active.filter((h) => h !== s.hoh));
      const [a, b] = input.choice;
      if (a === b) throw new Error("cannot nominate the same houseguest twice");
      if (!legal.has(a) || !legal.has(b)) throw new Error("illegal nominee");
      s.nominees = [a, b]; s.nominationTarget = undefined; s.pending = undefined; s.beat = "veto-competition";
      return { beat: "nominations", content: `${s.hoh} nominates ${a} and ${b}`, participants: [s.hoh!, a, b] };
    }
    case "veto-decision": {
      const nominees = s.nominees!;
      // Validate BEFORE consuming the pending decision (B59/audit I): an illegal save must refuse
      // and leave the decision standing — the old order cleared `pending` first and stranded the loop.
      const save = input.use ? input.save : undefined;
      if (input.use && (!save || !nominees.includes(save))) throw new Error("can only veto a current nominee");
      // E36: with no legal replacement (Final 4) "use" is refused with the decision STANDING —
      // never accepted and then silently inverted into "does not use the veto".
      if (input.use && selectableReplacements(weekState(s, ctx)).length === 0) {
        throw new Error("the veto cannot be used — no legal replacement nominee exists, so the nominations stand");
      }
      s.pending = undefined;
      if (!input.use) {
        s.vetoUsed = false; s.finalNominees = [nominees[0], nominees[1]]; s.beat = "eviction";
        return { beat: "veto-ceremony", content: `${ctx.player} does not use the veto`, participants: [ctx.player] };
      }
      s.vetoUsed = true; s.saved = save!;
      // The HOH names the replacement. If the player is ALSO HOH, that's the next decision.
      const ev = resolveReplacement(s, ctx);
      return ev ?? { beat: "veto-ceremony", content: `${ctx.player} uses the veto on ${ctx.player === save ? "themselves" : save}`, participants: [ctx.player, save!] };
    }
    case "comp-intent":
    case "comp-round": {
      // 0006 staged-rounds evolution: the player commits their approach for the CURRENT elimination
      // round (compete / throw / play-safe), seeing who is still in. STRUCTURED selection only — never
      // parsed from prose. It is committed BEFORE the round resolves; resolving locks it (the round can
      // not be re-labeled after). Adaptation is forward-only: the NEXT round re-asks over the still-in field.
      // (`comp-intent` is the legacy alias the FE/tests may still send — same per-round semantics.)
      s.compIntent = input.intent;
      s.pending = undefined;
      // Resume the staged sub-loop: it resolves exactly THIS round (eliminate the lowest), then either
      // pauses again for the next round or crowns the last standing.
      if (s.beat === "hoh-competition") return resolveHohBeat(s, ctx, rng)!;
      // E35: at the veto the field is already drawn (the draw ceremony precedes the rounds) — resolve.
      return resolveVetoComp(s, ctx, rng)!;
    }
    case "houseguests-choice": {
      // The player drew Houseguest's Choice and picks the sixth veto player (B45/audit B4).
      const options = (s.pending as { options: EntityId[] }).options;
      // C1: legality is RE-DERIVED at resume — the pick must be an offered candidate AND must not
      // already stand in the drawn field (a stale offer can never produce a duplicate competitor).
      if (!options.includes(input.pick) || s.vetoField!.includes(input.pick)) {
        throw new Error("the Houseguest's Choice must pick an eligible candidate who is not already drawn");
      }
      s.pending = undefined;
      s.vetoField = [...s.vetoField!, input.pick]; // the player's pick completes the field
      // E35: the completed field is the witnessed beat; the STAGED comp resolves on the NEXT advance,
      // pausing for the player's per-round approach (`comp-round`) inside the sub-loop (0006 staged-rounds).
      return {
        beat: "veto-draw",
        content: `${ctx.player} names ${input.pick} to fill the final veto spot`,
        participants: [...s.vetoField],
      };
    }
    case "replacement": {
      const legal = new Set(selectableReplacements(weekState(s, ctx)).filter((h) => h !== s.saved));
      if (!legal.has(input.replacement)) throw new Error("illegal replacement nominee");
      s.replacement = input.replacement; s.finalNominees = [otherNominee(s), input.replacement];
      s.pending = undefined; s.beat = "eviction";
      return { beat: "veto-ceremony", content: `${s.hoh} names ${input.replacement} as the replacement`, participants: [s.hoh!, input.replacement] };
    }
    case "eviction-vote": {
      const fn = s.finalNominees!;
      if (!fn.includes(input.vote)) throw new Error("can only vote to evict a final nominee");
      s.pending = undefined;
      // The player is a voter ⇒ the HOH is an NPC ⇒ no player tie-break; stage the reveal with their vote (0047).
      beginEviction(s, ctx, rng, input.vote);
      return advanceEviction(s, ctx, rng)!; // the first vote reveal — never pends (the player is not the HOH)
    }
    case "tie-break": {
      // The player Head of Household breaks a tied eviction vote, after the reveal (B44/audit B2 · 0047).
      const e = s.eviction!;
      if (!e.nominees.includes(input.evict)) throw new Error("the tie-break must choose a current nominee");
      s.pending = undefined;
      return commitStagedEviction(s, ctx, input.evict, rng);
    }
    case "final-eviction": {
      // Final 3 (0045): the player IS the final HOH and personally evicts one of the other two.
      const rivals = s.active.filter((h) => h !== s.hoh);
      if (!rivals.includes(input.evict)) throw new Error("can only evict one of the other two finalists");
      s.pending = undefined;
      const ev: BeatEvent = { beat: "final-eviction", content: `${s.hoh} evicts ${input.evict}, setting the Final 2`, participants: [s.hoh!, input.evict] };
      applyEviction(s, input.evict, ctx, [s.hoh!]);
      return ev;
    }
    case "goodbye-message": {
      // E34: the player's OWN goodbye — the tone is their choice (the engine never computes it
      // from their hidden edge), folded into the evictee's manner EXACTLY as NPC tones are.
      const p = s.pending;
      if (!p || p.kind !== "goodbye-message") throw new Error("no pending goodbye message");
      if (!GOODBYE_TONES.includes(input.tone)) throw new Error("a legal goodbye tone is required (warm / respectful / cold)");
      const e = s.eviction!;
      s.pending = undefined;
      e.goodbyeIx += 1;
      const row = (s.mannerByEvictee![e.evictee!] ??= {});
      row[p.by] = { ...(row[p.by] ?? {}), ...goodbyeMannerFor(input.tone) };
      return {
        beat: "eviction-goodbye",
        content: `${p.by} leaves ${e.evictee} a ${input.tone} goodbye message`,
        participants: [p.by, e.evictee!],
      };
    }
    case "exit-interview": {
      // 0130: the player, as the EVICTEE, gives their own exit interview — the posture (and their words)
      // are THEIRS (the engine never authors them), recorded for the 0048 retrospective exactly as an NPC
      // stance is. Expressive only: it mutates no seeded state.
      const p = s.pending;
      if (!p || p.kind !== "exit-interview") throw new Error("no pending exit interview");
      if (!EXIT_STANCES.includes(input.stance)) throw new Error("a legal exit stance is required (gracious / defiant / bitter)");
      const e = s.eviction!;
      s.pending = undefined;
      e.exitInterviewDone = true;
      (s.exitInterviews ??= []).push({ week: s.week, evictee: e.evictee!, stance: input.stance, ...(input.message ? { message: input.message } : {}) });
      return {
        beat: "exit-interview",
        content: exitInterviewContent(e.evictee!, input.stance),
        participants: [e.evictee!],
      };
    }
    // --- early eviction (0133) -------------------------------------------------
    case "spectator-choice": {
      const p = s.pending;
      if (!p || p.kind !== "spectator-choice") throw new Error("no pending spectator choice");
      if (!SPECTATOR_MODES.includes(input.mode)) throw new Error("a legal spectator mode is required (watch / skip)");
      s.pending = undefined;
      s.spectatorOffered = true;
      // A re-raised card (watch -> skip) keeps the ORIGINAL sinceWeek, so the weeks already digested are not dropped from the player's recap.
      s.spectator = { mode: input.mode, sinceWeek: s.spectator?.sinceWeek ?? s.week };
      return {
        beat: "spectator-choice",
        content: input.mode === "skip"
          ? `${p.by} chooses to skip ahead to the finale`
          : `${p.by} chooses to keep watching the rest of the season`,
        participants: [p.by],
      };
    }
    case "finale-interview": {
      const p = s.pending;
      if (!p || p.kind !== "finale-interview") throw new Error("no pending finale interview");
      if (!EXIT_STANCES.includes(input.stance)) throw new Error("a legal interview stance is required (gracious / defiant / bitter)");
      s.pending = undefined;
      s.finaleInterview = { stance: input.stance, ...(input.message ? { message: input.message } : {}) };
      return { beat: "finale-interview", content: `${p.by} is interviewed on the finale night`, participants: [p.by] };
    }
    // --- secret veto (0025 reactive redesign) ---------------------------------
    case "secret-veto": {
      const p = s.pending;
      if (!p || p.kind !== "secret-veto") throw new Error("no pending secret-veto decision");
      const sp = s.secretVeto;
      if (!sp || sp.used || sp.holder !== p.by) throw new Error("no secret veto to play");
      s.pending = undefined;
      if (!input.use) {
        // The player holds it for later — not consumed, but not re-offered this week; the eviction proceeds.
        sp.declinedWeek = s.week;
        s.beat = "eviction";
        return { beat: "eviction", content: `${p.by} keeps their options to themselves`, participants: [p.by] };
      }
      const options = secretVetoReplacementOptions(s, sp.holder);
      if (options.length === 0) throw new Error("the secret veto cannot be played — no legal replacement exists");
      return playSecretVeto(s, ctx, sp.holder, options);
    }
    // --- finale (0037) ---------------------------------------------------------
    case "finale-statement": {
      const f = s.finale!;
      const p = s.pending;
      if (!p || p.kind !== "finale-statement") throw new Error("no pending finale statement");
      // Free-text flavor — carries NO score (anti-sycophancy: only structured appeals sway).
      const by = p.by;
      s.pending = undefined;
      f.statementIx += 1;
      return { beat: "finale", content: `${by} gives an opening statement`, participants: [by] };
    }
    case "finale-answer": {
      const f = s.finale!;
      const p = s.pending;
      if (!p || p.kind !== "finale-answer") throw new Error("no pending finale answer");
      if (!FINALE_APPEALS.includes(input.appeal)) throw new Error("no legal appeal");
      recordAppeal(f, p.by, p.juror, input.appeal);
      s.pending = undefined;
      f.questionIx += 1;
      return { beat: "finale", content: `${p.by} answers ${p.juror}`, participants: [p.by, p.juror] };
    }
    case "juror-question": {
      // E37: the player-juror's question is SCORELESS flavor — recording it changes no tally;
      // the NPC finalist's answer is still engine-chosen exactly as for any juror.
      const f = s.finale!;
      const p = s.pending;
      if (!p || p.kind !== "juror-question") throw new Error("no pending juror question");
      s.pending = undefined;
      const appeal = bestAppeal(edgeAsJuryRel(s, p.by, p.finalist, ctx), mannerFor(s, p.by, p.finalist));
      recordAppeal(f, p.finalist, p.by, appeal);
      f.questionIx += 1;
      return { beat: "finale", content: `${p.by} questions ${p.finalist}; ${p.finalist} answers`, participants: [p.finalist, p.by] };
    }
    case "juror-vote": {
      const f = s.finale!;
      const p = s.pending;
      if (!p || p.kind !== "juror-vote") throw new Error("no pending juror vote");
      // An illegal vote (not one of the two finalists) is refused; the pending decision stands.
      if (!p.finalists.includes(input.vote)) throw new Error("can only vote for one of the two finalists");
      (f.votes ??= {})[ctx.player] = input.vote;
      s.pending = undefined;
      return { beat: "finale", content: `you cast your jury vote`, participants: [ctx.player] };
    }
    case "self-evict": {
      // 0061: a confirmed self-eviction does NOT flow through the ceremony-pending machinery (it
      // lives on `selfEvictPending`, alongside any ceremony pending). The adapter executes it via
      // `applySelfEviction` so it never overrides an in-flight ceremony — this seam refuses it, so
      // there is no second exit path through the standard decision rulebook.
      throw new Error("self-eviction is executed through the dedicated confirmed-quit seam, not applyDecision");
    }
  }
}
