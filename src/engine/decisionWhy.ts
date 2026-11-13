/**
 * ORW-305 - the WHY of an NPC decision: a structured, HIDDEN, engine-only record of the named terms behind a choice.
 *
 * The engine records WHAT an NPC decided; this records WHY (the chosen option and the runner-up, each as a list of named
 * terms with the size it contributed). It is a RECORD, never an input: the scoring code accumulates its terms as it already
 * computes them and the score IS the left-to-right sum of those terms, so the recorded breakdown reproduces the score to the
 * bit and no existing number, comparison or rng draw moves. Vault side: it lives on `LiveSeasonState.decisionWhy` beside
 * `voteRecord` (engine-only, persisted with the season, append-only) and is read by NO outward surface (the narrator
 * hand-off is a later slice). Pure: no I/O, no rng.
 */
import type { EntityId } from "../domain/ids";

/** One contributing term: a name and the signed size it added to the option's score. A term may be built of `parts` (its size is their sum). */
export type WhyTerm = [name: string, size: number];

export interface WhyOption {
  /** The option scored: a houseguest id, or a rule label such as "hold" for "no candidate cleared the bar". */
  option: string;
  /** The seat this option held in the decision ("target", "pawn", "runner-up", "chosen" ...). */
  role: "chosen" | "runner-up";
  /** The option's score: exactly the left-to-right sum of `terms` (zero-size terms are omitted). */
  total: number;
  terms: WhyTerm[];
  /** Raw inputs that shaped a term but are not themselves additive (a paranoia level, a threshold). */
  inputs?: Record<string, number>;
}

export type DecisionWhyKind =
  | "nomination-target" | "nomination-seat" | "replacement" | "vote" | "tie-break" | "veto" | "secret-veto-replacement"
  | "final-hoh-eviction" | "deal-consent";

export interface DecisionWhy {
  kind: DecisionWhyKind;
  /** The decider. */
  by: EntityId;
  week: number;
  /** The tactic the choice played (target / pawn / backdoor / direct / ...), when the decision has one. */
  tactic?: string;
  /** Set when the choice is rule-based rather than a pure score ("self-save", "backdoor-rank-2-3", "pawn-floater"): the rule's name. */
  rule?: string;
  /** The chosen option first, then the runner-up. */
  options: WhyOption[];
}

/** The sum of a term list, left to right, exactly as the scoring code adds them (no initial 0: `0 + x` is `x`, and `-0` is preserved). */
export function sumTerms(terms: ReadonlyArray<readonly [string, number]>): number {
  let t = 0;
  for (let i = 0; i < terms.length; i++) t = i === 0 ? terms[i]![1] : t + terms[i]![1];
  return t;
}

/** Left-to-right sum of raw values (the hot-path twin of `sumTerms`). */
export function sumVals(vals: readonly number[]): number {
  let t = 0;
  for (let i = 0; i < vals.length; i++) t = i === 0 ? vals[i]! : t + vals[i]!;
  return t;
}

/** Zip names with values into a record's term list, dropping zero-size terms (adding +0 never moves a sum). */
export function termsOf(names: readonly string[], vals: readonly number[]): WhyTerm[] {
  const out: WhyTerm[] = [];
  for (let i = 0; i < names.length; i++) if (vals[i] !== 0 && vals[i] !== undefined) out.push([names[i]!, vals[i]!]);
  return out;
}

/** Build a scored option from parallel name / value arrays and the score the decision used. */
export function whyOption(option: string, role: WhyOption["role"], names: readonly string[], vals: readonly number[], total: number, inputs?: Record<string, number>): WhyOption {
  // `total` is the score the decision ACTUALLY used (passed in by the caller from the very value it compared), NOT re-derived from the kept terms: a breakdown that loses a term no longer reproduces it.
  return { option, role, total: total + 0, terms: termsOf(names, vals), ...(inputs ? { inputs } : {}) };
}

/** A sink the pure decision functions call with their finished breakdown; the caller owns where it is stored. */
export type WhySink = (w: Omit<DecisionWhy, "by" | "week">) => void;

/** The id of the second-best entry by `score` (first on ties) among `items` excluding `chosen`. */
export function runnerUp<T>(items: readonly T[], chosen: T, score: (x: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const it of items) {
    if (it === chosen) continue;
    const sc = score(it);
    if (best === undefined || sc > bestScore) { best = it; bestScore = sc; }
  }
  return best;
}
