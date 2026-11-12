/**
 * ORW-253 slice 1 (theme 1, NPC minds; design approved by Ryne 2026-11-12): every tunable of the NPC AGENDA lives here (the B59
 * pattern - one module, one edit). Pure data, no imports beyond types. See `agenda.ts` for what each number does.
 *
 * Ryne's rulings this module serves (vault "NPC Minds Design Theme 1"):
 *  - goals count as much as the houseguest's own threat read (answer 1) - so the weights below are on the SAME 0..1 scale as a threat read;
 *  - long cons only for strategic / mastermind types (answer 3);
 *  - secrets worth protecting become a real goal (answer 3).
 */
import type { Archetype, StrategyStyle } from "./characterFactory";
import type { GamePhilosophy } from "./philosophyConstants";

/** The season-long aims (kept here so agenda.ts and this table share it without an import cycle; agenda.ts re-exports it). */
export type SeasonGoalKind =
  | "win-by-comps" | "win-by-being-liked" | "run-the-house" | "reach-jury" | "last-alliance-standing" | "prove-not-a-floater"
  | "protect-my-person" | "revenge" | "keep-my-secret" | "long-con";

/** How strongly each archetype leans toward each season goal (0..1). Missing = 0. The top one (plus a small seeded jitter) is the starting season goal. */
export const SEASON_GOAL_LEAN: Readonly<Record<Archetype, Partial<Record<SeasonGoalKind, number>>>> = {
  "comp-beast":       { "win-by-comps": 1.0, "prove-not-a-floater": 0.35, "run-the-house": 0.3 },
  mastermind:         { "run-the-house": 1.0, "last-alliance-standing": 0.6, "reach-jury": 0.2 },
  "social-butterfly": { "win-by-being-liked": 1.0, "last-alliance-standing": 0.4 },
  floater:            { "reach-jury": 1.0, "win-by-being-liked": 0.45 },
  villain:            { "run-the-house": 0.95, "win-by-comps": 0.35 },
  underdog:           { "prove-not-a-floater": 0.85, "reach-jury": 0.55 },
  flirt:              { "win-by-being-liked": 0.8, "last-alliance-standing": 0.4 },
  loyalist:           { "last-alliance-standing": 1.0, "win-by-being-liked": 0.4 },
  wildcard:           { "run-the-house": 0.55, "win-by-comps": 0.5, "prove-not-a-floater": 0.45 },
  analyst:            { "run-the-house": 0.75, "reach-jury": 0.45 },
  hothead:            { "win-by-comps": 0.65, "prove-not-a-floater": 0.6 },
  peacemaker:         { "win-by-being-liked": 0.85, "last-alliance-standing": 0.5 },
};

/**
 * How stubborn each archetype is (0..1): how much a NEW goal must beat a held one before the holder switches, and how slowly a goal
 * with no progress fades overnight. A loyalist or hothead holds on; a floater or wildcard lets go. This is what makes goals outlive moods.
 */
export const STUBBORNNESS: Readonly<Record<Archetype, number>> = {
  "comp-beast": 0.55, mastermind: 0.6, "social-butterfly": 0.4, floater: 0.2, villain: 0.65, underdog: 0.55,
  flirt: 0.35, loyalist: 0.8, wildcard: 0.2, analyst: 0.5, hothead: 0.75, peacemaker: 0.45,
};

/**
 * The PERSON, not only the type (Coordinator review of #2557, against Ryne's "get creative" ask): a houseguest's own strategy style and
 * game philosophy add to the archetype's leanings, so two houseguests of one archetype can want different things. Additive, 0..1 scale.
 */
export const STYLE_LEAN: Readonly<Record<StrategyStyle, Partial<Record<SeasonGoalKind, number>>>> = {
  aggressive:        { "win-by-comps": 0.25, "run-the-house": 0.2 },
  social:            { "win-by-being-liked": 0.3, "last-alliance-standing": 0.1 },
  strategic:         { "run-the-house": 0.3, "reach-jury": 0.1 },
  "under-the-radar": { "reach-jury": 0.35, "win-by-being-liked": 0.1 },
  emotional:         { "prove-not-a-floater": 0.2, "win-by-being-liked": 0.15 },
  loyal:             { "last-alliance-standing": 0.35 },
};
export const PHILOSOPHY_LEAN: Readonly<Record<GamePhilosophy, Partial<Record<SeasonGoalKind, number>>>> = {
  shark:            { "win-by-comps": 0.2, "run-the-house": 0.15 },
  "chaos-agent":    { "run-the-house": 0.25, "prove-not-a-floater": 0.1 },
  "loyal-soldier":  { "last-alliance-standing": 0.3 },
  protector:        { "last-alliance-standing": 0.15, "win-by-being-liked": 0.15 },
  "social-climber": { "win-by-being-liked": 0.2, "run-the-house": 0.15 },
};
/** Strategy style shifts stubbornness: the loyal hold on, the emotional and under-the-radar bend. */
export const STYLE_STUBBORNNESS: Readonly<Record<StrategyStyle, number>> = {
  aggressive: 0.05, social: -0.05, strategic: 0, "under-the-radar": -0.1, emotional: -0.05, loyal: 0.15,
};

/** Only these may run a LONG CON (Ryne 2026-11-12: "reserved for like strategic players or masterminds"). */
export const LONG_CON_ARCHETYPES: readonly Archetype[] = ["mastermind", "villain", "analyst"];
export const LONG_CON_STYLES: readonly StrategyStyle[] = ["strategic"];

export const AGENDA = {
  /** Seeded jitter added to each season-goal lean so two houseguests of one archetype need not want the same thing (0..jitter). */
  seasonJitter: 0.3,
  /** A week goal is kept only if its weight reaches this. */
  weekGoalFloor: 0.3,
  /** Week goals held at once (the strongest first). Not a scarcity cap on play: a person pursues a few things a week, not everything. */
  weekGoalSlots: 3,
  /** A threat read at/above this makes "get them out" a candidate goal (same scale as the campaign threshold). */
  targetThreat: 0.55,
  /** An affinity at/above this makes "pull them in" (or "protect them") a candidate. */
  allyAffinity: 0.6,
  /** A memory grudge at/above this (0..1 salience) is a betrayal that can turn into a season-long REVENGE goal. */
  revengeGrudge: 0.6,
  /** Weight of being on the block for "stay safe" (it should beat almost anything). */
  nominatedDanger: 1.0,
  /** Baseline "stay safe" weight when not on the block, raised by a rattled mood. */
  baseDanger: 0.25,
  /** Extra weight a goal gets when the same goal (kind + target) failed last week: the grudge carries over. */
  carryOverBonus: 0.15,
  /** Overnight fade of a goal with no progress = (1 - stubbornness) x this. Below `dropFloor` the holder gives up. */
  mullFade: 0.25,
  dropFloor: 0.2,
  /** Chance (seeded per houseguest and season) that an eligible strategic type runs a long con at all. */
  longConChance: 0.5,
  /** A long-con mark is someone the holder rates a threat of at least this AND an ally of at least `allyAffinity` (keep them close, cut them later). */
  longConThreat: 0.45,
  /** How much a houseguest's own susceptibility to persuasion (0..1, from their influence aptitudes) lowers stubbornness around 0.5. */
  susceptibilityWeight: 0.3,
  /** A personal, seeded stubbornness offset (+/- this) so no two houseguests of one type hold on the same. */
  personalStubbornness: 0.1,
} as const;
