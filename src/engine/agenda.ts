/**
 * ORW-253 slice 1 - the NPC AGENDA (theme 1, NPC minds; design approved by Ryne 2026-11-12, vault "NPC Minds Design Theme 1").
 *
 * Every houseguest holds a small, LASTING agenda: season goals (rarely change), up to a few goals for this week, each with WHO it is
 * about, WHY (links to the real reads, memories and board facts that caused it), HOW the holder will know it worked (a closed success
 * test the engine evaluates), how committed they are, and its status. Goals OUTLIVE MOODS: a held goal is replaced only when it is
 * achieved, clearly fails, a new goal beats it by the holder's stubbornness margin, or the holder gives up overnight.
 *
 * Authority and walls:
 *  - PURE and deterministic: no I/O, no shared rng. Any variety comes from a local hash of (season seed, owner), so this module can
 *    never shift the seeded spine (it is read by nothing in slice 1; slice 2 makes decisions read it).
 *  - VAULT-CLASS: an agenda is secret state. It must never reach a player, prompt or admin surface; the only sanctioned reader outside
 *    the engine is the post-season retrospective (Ryne 2026-11-12: "I want that limited perspective to be broken in the season
 *    retrospective"), which slice 6+ wires. Ryne's motive rule: no hints point at a motive; motives drive ACTIONS, and actions are the
 *    evidence the player infers from.
 *  - NON-DEGRADING (mandate 4): resolved goals move to `history`, which only ever grows (`isAgendaSuperset`).
 *  - The holder's VIEW only: every input is the owner's own read (their threat/affinity edges, their memories, the public board).
 */
import type { EntityId } from "../domain/ids";
import { clamp01 } from "../domain/num";
import type { Archetype, StrategyStyle, HiddenElementKind } from "./characterFactory";
import { AGENDA, LONG_CON_ARCHETYPES, LONG_CON_STYLES, PHILOSOPHY_LEAN, SEASON_GOAL_LEAN, STUBBORNNESS, STYLE_LEAN, STYLE_STUBBORNNESS, type SeasonGoalKind } from "./agendaConstants";
import type { GamePhilosophy } from "./philosophyConstants";

// --- Types -------------------------------------------------------------------------------------------------------------------------

export type { SeasonGoalKind };
export type WeekGoalKind = "get-them-out" | "stay-safe" | "pull-them-in" | "keep-them-safe" | "win-power" | "find-out";
export type GoalKind = SeasonGoalKind | WeekGoalKind;
export type GoalHorizon = "season" | "week";
export type GoalStatus = "active" | "achieved" | "failed" | "dropped" | "replaced" | "ended";

/** One reason a goal exists - a pointer to something real, never invented. `weight` is how much it counted (0..1). */
export type CauseKind = "character" | "threat-read" | "bond" | "memory" | "board" | "secret" | "pre-show-tie" | "carry-over" | "question";
export interface Cause { kind: CauseKind; about?: EntityId; ref?: string; weight: number }

/** The closed set of tests the engine evaluates to decide whether a goal worked. */
export type SuccessTest =
  | { kind: "evicted"; who: EntityId }             // they are out (while the holder is still playing)
  | { kind: "survives-week" }                       // the holder is still in the house when the week closes
  | { kind: "allied-with"; who: EntityId }          // they are in an alliance with the holder
  | { kind: "still-in"; who: EntityId }             // they are still in the house when the week closes
  | { kind: "holds-power" }                         // the holder is HOH or veto holder this week
  | { kind: "question-answered"; ref: string }      // an open question the holder had is resolved
  | { kind: "reaches-jury" }                        // the jury phase starts with the holder still playing
  | { kind: "final-two-alliance" }                  // both finalists are the holder or the holder's alliance mates (at that time)
  | { kind: "reaches-final-two"; who: EntityId }    // that person makes the final two
  | { kind: "wins" }                                // the holder wins the season
  | { kind: "wins-power-once" }                     // the holder wins HOH or veto at least once
  | { kind: "secret-kept" }                         // the holder's secret is never exposed
  | { kind: "cut-later"; who: EntityId; stage: "jury" | "final-five" }; // long con: they leave AFTER the stage, with the holder still in

export interface Goal {
  id: string;
  owner: EntityId;
  horizon: GoalHorizon;
  kind: GoalKind;
  target?: EntityId;
  why: Cause[];
  test: SuccessTest;
  /** How committed the holder is (0..1). Fades overnight without progress; the holder gives up below the drop floor. */
  commitment: number;
  status: GoalStatus;
  formedDay: number;
  formedWeek: number;
  resolvedDay?: number;
  /** For a replaced / dropped goal: what replaced it or why it was let go (engine words, Vault only). */
  endNote?: string;
}

export interface Agenda {
  owner: EntityId;
  /** Active goals (season and week). */
  goals: Goal[];
  /** Every goal ever resolved, in order. Append-only (non-degradation; the retrospective reads it). */
  history: Goal[];
  /** The week the week-goals were last formed for. */
  formedForWeek: number;
}

/** What the agenda needs to know about the holder's own character (static; from `Character`). */
export interface AgendaCharacter {
  archetype: Archetype;
  strategyStyle: StrategyStyle;
  /** Kinds of the holder's hidden elements (a secret worth protecting comes from these). */
  secretKinds: HiddenElementKind[];
  /** The houseguest's own game philosophy (B40), if drawn. */
  philosophy?: GamePhilosophy;
  /** How easily THEY are swayed (0..1, `Character.influence.susceptibility`), if known. */
  susceptibility?: number;
  /** A pre-show tie, if any, and whether it is hidden from the house. */
  preShowTie?: { with: EntityId; hidden: boolean; friendly: boolean; /** ORW-329: the tie's nature (family, ex, old-friend, rival, ...); absent on older callers. */ nature?: string };
}

/** The holder's own view this moment. Every field is the HOLDER's read, never an omniscient ledger. */
export interface AgendaView {
  owner: EntityId;
  character: AgendaCharacter;
  /** The holder's threat reads of others (0..1). */
  threats: Array<{ toward: EntityId; threat: number }>;
  /** The holder's affinity for others (0..1). */
  affinity: Array<{ toward: EntityId; affinity: number }>;
  /** The holder's remembered grievances, by person (0..1 salience, from the memory ledger). */
  grudges: Array<{ toward: EntityId; salience: number; ref: string }>;
  /** The holder's soul emotional state (0..1, 0.5 calm). */
  emotional: number;
  /** The holder's alliance mates right now. */
  allianceMates: EntityId[];
  /** True once the holder's secret has been exposed. */
  secretExposed: boolean;
  /** Open questions the holder has (e.g. "who flipped on me"), with an optional prime suspect. */
  openQuestions: Array<{ ref: string; suspect?: EntityId }>;
  /** Questions now answered (refs). */
  answered: string[];
  /** Times the holder has won HOH or veto this season. */
  powerWins: number;
}

/** The public board (everyone can see it). */
export interface AgendaBoard {
  day: number;
  week: number;
  inHouse: EntityId[];
  /** Evicted houseguests, in order. */
  evicted: EntityId[];
  juryStarted: boolean;
  /** Set once the final five is reached. */
  finalFive: boolean;
  hoh?: EntityId;
  vetoHolder?: EntityId;
  nominees: EntityId[];
  /** True once this week's eviction is done. */
  weekClosed: boolean;
  finalTwo?: EntityId[];
  winner?: EntityId;
}

/** What made the agenda look again. Each is a real event the engine saw. */
export type AgendaTrigger =
  | "season-start" | "week-start" | "week-closed" | "nominated" | "power-changed" | "eviction" | "betrayed" | "deal-broken"
  | "caught-lying" | "comp-result" | "alliance-changed" | "secret-exposed" | "night";

// --- Small pure helpers ------------------------------------------------------------------------------------------------------------


const strHash = (s: string): number => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
/** A unit roll from (seed, owner, salt) that touches no shared random stream. */
export function agendaRoll(seed: number, owner: EntityId, salt: string): number {
  let h = (Math.imul(seed >>> 0, 0x9e3779b1) ^ strHash(`${owner}|${salt}`)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const goalKey = (g: Pick<Goal, "kind" | "target">): string => `${g.kind}:${g.target ?? "-"}`;
const makeId = (owner: EntityId, horizon: GoalHorizon, kind: GoalKind, target: EntityId | undefined, day: number): string =>
  `${owner}:${horizon}:${kind}:${target ?? "-"}:d${day}`;
/** How stubborn THIS houseguest is: archetype base, their style, their susceptibility, and a small personal seeded offset. */
export function stubbornnessOf(c: AgendaCharacter, owner: EntityId, seed: number): number {
  const base = (STUBBORNNESS[c.archetype] ?? 0.5) + (STYLE_STUBBORNNESS[c.strategyStyle] ?? 0);
  const sway = c.susceptibility === undefined ? 0 : (0.5 - c.susceptibility) * AGENDA.susceptibilityWeight;
  const personal = (agendaRoll(seed, owner, "stubborn") * 2 - 1) * AGENDA.personalStubbornness;
  return clamp01(base + sway + personal);
}
/** This houseguest's season-goal leanings: archetype + their own style + their own philosophy (the person, not only the type). */
export function seasonLeanOf(c: AgendaCharacter): Partial<Record<SeasonGoalKind, number>> {
  const out: Partial<Record<SeasonGoalKind, number>> = { ...(SEASON_GOAL_LEAN[c.archetype] ?? {}) };
  const add = (t: Partial<Record<SeasonGoalKind, number>> | undefined): void => {
    for (const [k, w] of Object.entries(t ?? {}) as Array<[SeasonGoalKind, number]>) out[k] = (out[k] ?? 0) + w;
  };
  add(STYLE_LEAN[c.strategyStyle]);
  if (c.philosophy) add(PHILOSOPHY_LEAN[c.philosophy]);
  return out;
}
export const canRunLongCon = (c: AgendaCharacter): boolean =>
  LONG_CON_ARCHETYPES.includes(c.archetype) || LONG_CON_STYLES.includes(c.strategyStyle);
const SECRET_KINDS: readonly HiddenElementKind[] = ["secret-motive", "divergent-persona", "concealed-aptitude"];
/** Does the holder carry a secret worth protecting? (Ryne 2026-11-12: "yes on secrets worth protecting".) */
export function hasSecretWorthProtecting(c: AgendaCharacter): boolean {
  return c.secretKinds.some((k) => SECRET_KINDS.includes(k)) || (c.preShowTie?.hidden ?? false);
}

interface Candidate { horizon: GoalHorizon; kind: GoalKind; target?: EntityId; weight: number; why: Cause[]; test: SuccessTest }

function toGoal(c: Candidate, owner: EntityId, board: AgendaBoard): Goal {
  return {
    id: makeId(owner, c.horizon, c.kind, c.target, board.day), owner, horizon: c.horizon, kind: c.kind,
    ...(c.target !== undefined ? { target: c.target } : {}), why: c.why, test: c.test, commitment: clamp01(c.weight),
    status: "active", formedDay: board.day, formedWeek: board.week,
  };
}

// --- Season goals ------------------------------------------------------------------------------------------------------------------

function seasonTest(kind: SeasonGoalKind, target: EntityId | undefined): SuccessTest {
  switch (kind) {
    case "reach-jury": return { kind: "reaches-jury" };
    case "prove-not-a-floater": return { kind: "wins-power-once" };
    case "last-alliance-standing": return { kind: "final-two-alliance" };
    case "protect-my-person": return { kind: "reaches-final-two", who: target! };
    case "revenge": return { kind: "evicted", who: target! };
    case "keep-my-secret": return { kind: "secret-kept" };
    case "long-con": return { kind: "cut-later", who: target!, stage: "jury" };
    default: return { kind: "wins" };
  }
}

const isFamilyProtect = (g: Goal): boolean => g.kind === "protect-my-person" && g.why.some((w) => w.kind === "pre-show-tie" && w.ref === "family");

/** ORW-329: the houseguests this holder avoids spending free time with (an ex from before the show: awkward). */
export function tieAvoids(c: AgendaCharacter): EntityId[] {
  return c.preShowTie?.nature === "ex" ? [c.preShowTie.with] : [];
}

/** The starting season goal(s) from the holder's character alone (season start: nobody has history yet). */
export function seedAgenda(view: AgendaView, board: AgendaBoard, seed: number): Agenda {
  const c = view.character;
  const lean = seasonLeanOf(c);
  const scored = (Object.keys(lean) as SeasonGoalKind[])
    .map((k) => ({ k, w: (lean[k] ?? 0) + agendaRoll(seed, view.owner, `season:${k}`) * AGENDA.seasonJitter }))
    .sort((a, b) => b.w - a.w || a.k.localeCompare(b.k));
  const goals: Goal[] = [];
  const top = scored[0];
  const tie = c.preShowTie;
  // ORW-329 (Ryne 2026-11-03, epic #2017 idea 4: "Family protects, rivals target, exes are awkward, old friends are loyal until pressured").
  if (tie && tie.nature === "rival") {
    // Bad blood from before the show: they want the rival gone from day one.
    goals.push(toGoal({ horizon: "season", kind: "get-them-out", target: tie.with, weight: AGENDA.tie.rival,
      why: [{ kind: "pre-show-tie", about: tie.with, ref: "rival", weight: AGENDA.tie.rival }], test: { kind: "evicted", who: tie.with } }, view.owner, board));
  } else if (tie && tie.friendly && tie.nature !== "ex") {
    // A friend or family from before the show: protecting them is the first thing they want (it can sit beside the main goal). Family hardest.
    const w = tie.nature === "family" ? AGENDA.tie.family : AGENDA.tie.friend;
    goals.push(toGoal({ horizon: "season", kind: "protect-my-person", target: tie.with, weight: w,
      why: [{ kind: "pre-show-tie", about: tie.with, ...(tie.nature ? { ref: tie.nature } : {}), weight: w }], test: seasonTest("protect-my-person", tie.with) }, view.owner, board));
  }
  // An ex is neither protected nor targeted: it is awkward (house life avoids them; see `tieAvoids`).
  if (top) {
    goals.push(toGoal({ horizon: "season", kind: top.k, weight: clamp01(top.w), why: [{ kind: "character", ref: c.archetype, weight: clamp01(top.w) }],
      test: seasonTest(top.k, undefined) }, view.owner, board));
  }
  if (hasSecretWorthProtecting(c)) {
    goals.push(toGoal({ horizon: "season", kind: "keep-my-secret", weight: 0.8, why: [{ kind: "secret", weight: 0.8 }],
      test: { kind: "secret-kept" } }, view.owner, board));
  }
  return recheckAgenda({ owner: view.owner, goals, history: [], formedForWeek: 0 }, view, board, "season-start", seed);
}

// --- Week goal candidates (the holder's own reads) ---------------------------------------------------------------------------------

function weekCandidates(view: AgendaView, board: AgendaBoard, agenda: Agenda): Candidate[] {
  const out: Candidate[] = [];
  const me = view.owner;
  const live = new Set(board.inHouse);
  const seasonKinds = new Set(agenda.goals.filter((g) => g.horizon === "season").map((g) => g.kind));
  const lastWeekFailed = new Set(agenda.history.filter((g) => g.horizon === "week" && g.status === "failed" && g.formedWeek === board.week - 1).map(goalKey));
  const carry = (kind: GoalKind, target?: EntityId): number => (lastWeekFailed.has(`${kind}:${target ?? "-"}`) ? AGENDA.carryOverBonus : 0);

  // Stay safe: on the block beats almost anything; otherwise a rattled mood makes it louder.
  const onBlock = board.nominees.includes(me);
  const danger = onBlock ? AGENDA.nominatedDanger : AGENDA.baseDanger + Math.max(0, 0.5 - view.emotional);
  out.push({ horizon: "week", kind: "stay-safe", weight: danger, test: { kind: "survives-week" },
    why: [{ kind: onBlock ? "board" : "character", ref: onBlock ? "nominated" : "nerves", weight: danger }] });

  // Get them out: the holder's strongest threat reads, plus grudges (a grievance makes a target).
  const grudgeOf = new Map(view.grudges.map((g) => [g.toward, g]));
  const mates = new Set(view.allianceMates);
  for (const t of view.threats) {
    if (!live.has(t.toward) || t.toward === me || t.toward === board.hoh) continue; // the HOH is safe this week
    const g = grudgeOf.get(t.toward);
    const w = t.threat + (g ? g.salience * 0.5 : 0) + carry("get-them-out", t.toward) - (mates.has(t.toward) ? 0.3 : 0);
    if (t.threat < AGENDA.targetThreat && !(g && g.salience >= AGENDA.revengeGrudge)) continue;
    const why: Cause[] = [{ kind: "threat-read", about: t.toward, weight: t.threat }];
    if (g) why.push({ kind: "memory", about: t.toward, ref: g.ref, weight: g.salience });
    if (carry("get-them-out", t.toward) > 0) why.push({ kind: "carry-over", about: t.toward, weight: AGENDA.carryOverBonus });
    out.push({ horizon: "week", kind: "get-them-out", target: t.toward, weight: w, why, test: { kind: "evicted", who: t.toward } });
  }

  // Pull them in / keep them safe: the holder's bonds.
  const buildsAlliances = seasonKinds.has("last-alliance-standing") || seasonKinds.has("run-the-house");
  for (const a of view.affinity) {
    if (!live.has(a.toward) || a.toward === me || a.affinity < AGENDA.allyAffinity) continue;
    if (mates.has(a.toward)) {
      if (board.nominees.includes(a.toward)) {
        out.push({ horizon: "week", kind: "keep-them-safe", target: a.toward, weight: a.affinity, test: { kind: "still-in", who: a.toward },
          why: [{ kind: "bond", about: a.toward, weight: a.affinity }, { kind: "board", about: a.toward, ref: "nominated", weight: 1 }] });
      }
      continue;
    }
    const w = a.affinity * (buildsAlliances ? 1 : 0.7) + carry("pull-them-in", a.toward);
    out.push({ horizon: "week", kind: "pull-them-in", target: a.toward, weight: w, test: { kind: "allied-with", who: a.toward },
      why: [{ kind: "bond", about: a.toward, weight: a.affinity }] });
  }

  // Win power: competitors want it; so does anyone in danger who has never won.
  const compMinded = seasonKinds.has("win-by-comps") || seasonKinds.has("prove-not-a-floater");
  const wp = (compMinded ? 0.7 : 0.2) + (onBlock ? 0.2 : 0);
  out.push({ horizon: "week", kind: "win-power", weight: wp, test: { kind: "holds-power" },
    why: [{ kind: compMinded ? "character" : "board", ref: compMinded ? view.character.archetype : "danger", weight: wp }] });

  // Find out: an open question the holder has (who flipped, who told).
  for (const q of view.openQuestions) {
    if (view.answered.includes(q.ref)) continue;
    out.push({ horizon: "week", kind: "find-out", ...(q.suspect !== undefined ? { target: q.suspect } : {}), weight: 0.5,
      test: { kind: "question-answered", ref: q.ref }, why: [{ kind: "question", ref: q.ref, ...(q.suspect !== undefined ? { about: q.suspect } : {}), weight: 0.5 }] });
  }
  return out;
}

/** Season-horizon goals that EMERGE from play (not from the character alone): revenge after a betrayal, and a long con. */
function emergentSeasonCandidates(view: AgendaView, board: AgendaBoard, agenda: Agenda, seed: number): Candidate[] {
  const out: Candidate[] = [];
  const live = new Set(board.inHouse);
  const held = new Set(agenda.goals.map(goalKey));
  const everHeld = new Set([...agenda.goals, ...agenda.history].map(goalKey));
  for (const g of view.grudges) {
    if (g.salience < AGENDA.revengeGrudge || !live.has(g.toward) || held.has(`revenge:${g.toward}`)) continue;
    out.push({ horizon: "season", kind: "revenge", target: g.toward, weight: g.salience, test: { kind: "evicted", who: g.toward },
      why: [{ kind: "memory", about: g.toward, ref: g.ref, weight: g.salience }] });
  }
  // A long con: strategic types only, at most once a season, decided by a seeded roll per holder (Ryne: "most people wouldn't do it").
  if (canRunLongCon(view.character) && !board.juryStarted && ![...everHeld].some((k) => k.startsWith("long-con:"))
      && agendaRoll(seed, view.owner, "long-con") < AGENDA.longConChance) {
    const aff = new Map(view.affinity.map((a) => [a.toward, a.affinity]));
    const mark = view.threats
      .filter((t) => live.has(t.toward) && t.toward !== view.owner && t.threat >= AGENDA.longConThreat && (aff.get(t.toward) ?? 0) >= AGENDA.allyAffinity)
      .sort((a, b) => b.threat - a.threat || a.toward.localeCompare(b.toward))[0];
    if (mark) {
      out.push({ horizon: "season", kind: "long-con", target: mark.toward, weight: mark.threat, test: { kind: "cut-later", who: mark.toward, stage: "jury" },
        why: [{ kind: "threat-read", about: mark.toward, weight: mark.threat }, { kind: "bond", about: mark.toward, weight: aff.get(mark.toward) ?? 0 }, { kind: "character", ref: view.character.archetype, weight: 1 }] });
    }
  }
  return out;
}

// --- Evaluating success tests ------------------------------------------------------------------------------------------------------

type Verdict = "achieved" | "failed" | "open";

export function evaluateTest(test: SuccessTest, owner: EntityId, view: AgendaView, board: AgendaBoard): Verdict {
  const out = (who: EntityId): boolean => board.evicted.includes(who);
  const ownerOut = out(owner);
  switch (test.kind) {
    case "evicted": return out(test.who) && !ownerOut ? "achieved" : ownerOut || board.winner === test.who || (board.finalTwo?.includes(test.who) ?? false) ? "failed" : "open";
    case "survives-week": return ownerOut ? "failed" : board.weekClosed ? "achieved" : "open";
    case "allied-with": return view.allianceMates.includes(test.who) ? "achieved" : out(test.who) || ownerOut ? "failed" : "open";
    case "still-in": return out(test.who) ? "failed" : board.weekClosed ? "achieved" : "open";
    case "holds-power": return board.hoh === owner || board.vetoHolder === owner ? "achieved" : board.weekClosed || ownerOut ? "failed" : "open";
    case "question-answered": return view.answered.includes(test.ref) ? "achieved" : ownerOut ? "failed" : "open";
    case "reaches-jury": return board.juryStarted && !ownerOut ? "achieved" : ownerOut ? "failed" : "open";
    case "final-two-alliance": {
      if (ownerOut) return "failed";
      if (board.finalTwo) return board.finalTwo.every((p) => p === owner || view.allianceMates.includes(p)) ? "achieved" : "failed";
      return "open";
    }
    case "reaches-final-two": {
      if (out(test.who)) return "failed";
      if (board.finalTwo) return board.finalTwo.includes(test.who) ? "achieved" : "failed";
      return "open";
    }
    case "wins": return board.winner === owner ? "achieved" : ownerOut || (board.winner !== undefined) ? "failed" : "open";
    case "wins-power-once": return view.powerWins > 0 ? "achieved" : ownerOut ? "failed" : "open";
    case "secret-kept": return view.secretExposed ? "failed" : board.winner !== undefined || ownerOut ? "achieved" : "open";
    case "cut-later": {
      const stageReached = test.stage === "jury" ? board.juryStarted : board.finalFive;
      if (out(test.who)) return stageReached && !ownerOut ? "achieved" : "failed"; // cut too early (or by someone else before the stage) is a failed con
      return ownerOut || board.winner === test.who ? "failed" : "open";
    }
  }
}

// --- The re-check (any trigger) and the nightly mull -------------------------------------------------------------------------------

function resolve(g: Goal, status: GoalStatus, day: number, endNote?: string): Goal {
  return { ...g, status, resolvedDay: day, ...(endNote ? { endNote } : {}) };
}

/**
 * Look at the agenda again after something happened. Resolves goals whose tests settled, closes the week's goals at week close, adds
 * goals that emerged (revenge, a long con, next week's goals), and lets a new goal REPLACE a held one only when it beats it by the
 * holder's stubbornness margin. Pure; same inputs, same agenda.
 */
export function recheckAgenda(agenda: Agenda, view: AgendaView, board: AgendaBoard, trigger: AgendaTrigger, seed: number): Agenda {
  if (board.evicted.includes(agenda.owner)) {
    // The holder is out: their season ends; everything still open ends with them (kept for the retrospective).
    const ended = agenda.goals.map((g) => {
      const v = evaluateTest(g.test, agenda.owner, view, board);
      return resolve(g, v === "open" ? "ended" : v, board.day, v === "open" ? "evicted" : undefined);
    });
    return { ...agenda, goals: [], history: [...agenda.history, ...ended] };
  }
  const stub = stubbornnessOf(view.character, view.owner, seed);
  const history = [...agenda.history];
  let goals: Goal[] = [];
  for (const g of agenda.goals) {
    const v = evaluateTest(g.test, agenda.owner, view, board);
    if (v !== "open") history.push(resolve(g, v, board.day));
    else if (g.horizon === "week" && board.weekClosed) history.push(resolve(g, "failed", board.day, "week closed"));
    else goals.push(g);
  }
  // ORW-329: an old friend is loyal until pressured: once the friend reads as a real threat (past the holder's stubbornness margin), the
  // protection gives way. Family never does.
  const threatOf = new Map(view.threats.map((t) => [t.toward, t.threat]));
  goals = goals.filter((g) => {
    if (g.kind !== "protect-my-person" || !g.target || isFamilyProtect(g)) return true;
    const isOldFriend = g.why.some((w) => w.kind === "pre-show-tie" && w.ref === "old-friend");
    if (!isOldFriend || (threatOf.get(g.target) ?? 0) < AGENDA.targetThreat * (1 + stub)) return true;
    history.push(resolve(g, "replaced", board.day, "pressured: the friend became a threat"));
    return false;
  });
  const working: Agenda = { ...agenda, goals, history };

  // Season goals: keep at least one main aim. If the main aim settled, a new one forms from where the holder now stands.
  const mainKinds: SeasonGoalKind[] = ["win-by-comps", "win-by-being-liked", "run-the-house", "reach-jury", "last-alliance-standing", "prove-not-a-floater"];
  if (!goals.some((g) => g.horizon === "season" && (mainKinds as GoalKind[]).includes(g.kind))) {
    const lean = seasonLeanOf(view.character);
    const done = new Set(history.filter((h) => h.status === "achieved").map((h) => h.kind));
    // Once the jury is reached, the aim moves to winning: the strongest "win" lean that has not already been achieved.
    const options = (Object.keys(lean) as SeasonGoalKind[])
      .filter((k) => !done.has(k) && !(k === "reach-jury" && board.juryStarted))
      .map((k) => ({ k, w: (lean[k] ?? 0) + agendaRoll(seed, view.owner, `season:${k}:w${board.week}`) * AGENDA.seasonJitter }))
      .sort((a, b) => b.w - a.w || a.k.localeCompare(b.k));
    const pick = options[0]?.k ?? "win-by-being-liked";
    goals.push(toGoal({ horizon: "season", kind: pick, weight: 0.6, why: [{ kind: "character", ref: view.character.archetype, weight: 0.6 }],
      test: seasonTest(pick, undefined) }, view.owner, board));
  }

  // Emergent season goals (revenge, long con) join beside the main aim.
  for (const c of emergentSeasonCandidates(view, board, working, seed)) goals.push(toGoal(c, view.owner, board));

  // Week goals: form them at the week's start (or on the first look this week), then let real events re-rank them.
  const weekNow = board.weekClosed ? board.week + 1 : board.week;
  // At week close the old nominees and HOH no longer bind: next week's goals form on a clean board.
  const formingBoard: AgendaBoard = board.weekClosed ? { ...board, nominees: [], hoh: undefined, vetoHolder: undefined, weekClosed: false, week: weekNow } : board;
  const candidates = weekCandidates(view, formingBoard, { ...working, goals }).sort((a, b) => b.weight - a.weight || goalKey(a).localeCompare(goalKey(b)));
  const heldWeek = goals.filter((g) => g.horizon === "week");
  const others = goals.filter((g) => g.horizon !== "week");
  let week = heldWeek;
  if (agenda.formedForWeek !== weekNow || heldWeek.length === 0) {
    week = candidates.filter((c) => c.weight >= AGENDA.weekGoalFloor).slice(0, AGENDA.weekGoalSlots).map((c) => toGoal(c, view.owner, formingBoard));
  } else {
    // A held week goal is replaced only by a candidate that beats the weakest held one by the stubbornness margin.
    const heldKeys = new Set(heldWeek.map(goalKey));
    for (const c of candidates) {
      if (c.weight < AGENDA.weekGoalFloor || heldKeys.has(goalKey(c))) continue;
      if (week.length < AGENDA.weekGoalSlots) { week = [...week, toGoal(c, view.owner, board)]; heldKeys.add(goalKey(c)); continue; }
      const weakest = [...week].sort((a, b) => a.commitment - b.commitment || a.id.localeCompare(b.id))[0]!;
      if (c.weight > weakest.commitment * (1 + stub)) {
        history.push(resolve(weakest, "replaced", board.day, `replaced by ${goalKey(c)}`));
        week = [...week.filter((g) => g !== weakest), toGoal(c, view.owner, board)];
        heldKeys.add(goalKey(c));
      }
    }
  }
  void trigger; // the trigger is recorded by the caller on its event; the agenda's own record is the causes + statuses.
  return { owner: agenda.owner, goals: [...others, ...week], history, formedForWeek: weekNow };
}

/**
 * The nightly mull (asleep: inner processing only, never scheming - Ryne ruling ORW-256). Goals with no progress fade by
 * (1 - stubbornness) x fade; below the drop floor the holder gives up (kept in history as "dropped"). Then a normal re-check.
 * `progressed` lists goal ids that moved forward today (the caller decides from real events; slice 3 wires it).
 */
export function mullAgenda(agenda: Agenda, view: AgendaView, board: AgendaBoard, seed: number, progressed: ReadonlySet<string> = new Set()): Agenda {
  if (board.evicted.includes(agenda.owner)) return recheckAgenda(agenda, view, board, "night", seed);
  const stub = stubbornnessOf(view.character, view.owner, seed);
  const history = [...agenda.history];
  const goals: Goal[] = [];
  for (const g of agenda.goals) {
    if (progressed.has(g.id)) { goals.push({ ...g, commitment: clamp01(g.commitment + 0.1) }); continue; }
    const faded = clamp01(g.commitment - (1 - stub) * AGENDA.mullFade);
    if (faded < AGENDA.dropFloor && g.kind !== "keep-my-secret" && !isFamilyProtect(g)) history.push(resolve({ ...g, commitment: faded }, "dropped", board.day, "gave up"));
    else goals.push({ ...g, commitment: faded });
  }
  return recheckAgenda({ ...agenda, goals, history }, view, board, "night", seed);
}

// --- Non-degradation ---------------------------------------------------------------------------------------------------------------

/** True when `next` keeps every resolved goal `prev` had, in order (history only grows) - the 0007/0031 superset rule for agendas. */
export function isAgendaSuperset(prev: Agenda, next: Agenda): boolean {
  if (prev.owner !== next.owner || next.history.length < prev.history.length) return false;
  return prev.history.every((g, i) => JSON.stringify(g) === JSON.stringify(next.history[i]));
}
