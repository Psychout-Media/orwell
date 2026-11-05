import type { EntityId } from "../domain/ids";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { tallyJury } from "./season";
import { JURY_WEIGHTS, MANNER_LEAN, MANNER_GRADING, APPEAL, type JuryWeights } from "./juryConstants";

// Re-export the tunables so existing importers keep reading them from `jury` (the math lives here).
export { JURY_WEIGHTS, type JuryWeights };

/**
 * Jury & endgame (feature 0014) — the finale. PURE and engine-owned: the engine
 * DECIDES every vote from accumulated jury relationships ("jury management") plus
 * the finale performance; the LLM only voices jurors and never changes a vote
 * (anti-sycophancy). Jury management is the dominant term — how the player treated
 * people on the way out is what mostly decides the finale; a strong/weak finale
 * sways close jurors but rarely overturns a clear lead.
 *
 * The tally + last-evicted-juror tie-break reuse `season.tallyJury` (0005 rule).
 */

/** A juror's directed read of a finalist at eviction (decision 0002 signals). */
export interface JuryRel {
  trust: number;
  affinity: number;
  threat: number;
  /**
   * ADR 0002's EVIDENCE signal (E54), already CENTERED on the edge baseline by the caller so a
   * juror with no protective track record reads 0 (neutral). Demonstrated loyalty toward this
   * juror lifts the lean; proven disloyalty (betrayal tears reliability down) pulls it under 0.
   * Optional: a read without an evidence term (older call sites, tests) defaults to neutral.
   */
  reliability?: number;
}

/** How the finalist treated this juror on the way out — the manner of eviction. */
export interface EvictionManner {
  respected?: boolean;
  blindsided?: boolean;
  betrayed?: boolean;
  disrespected?: boolean;
  /** A62 (ORWELL_JUROR_PROFILES): the grievance rests on a possibly-WRONG belief - the juror blames this finalist for a vote they did not cast (0110 deduction error). A `mend` appeal dissolves it. Absent => byte-identical. */
  mistaken?: boolean;
  /**
   * SOC-NEW-1/5: the graded 0..1 SEVERITY of the categorical read above, read off the actual edge
   * numbers (how deeply they were trusted / how harmless they seemed / how feared a clean cut was).
   * Absent ⇒ 1 (full strength) — so a boolean-only manner (a broken-deal demerit, an older call site,
   * a test) reads byte-identically to the pre-grading model.
   */
  intensity?: number;
  /**
   * SOC-NEW-1: the goodbye tone the responsible houseguest sent, applied with bounded PRECEDENCE in
   * `mannerLeanOf` — it softens a grievance toward (never across) zero, or gives a small lift/sting on
   * a clean departure. Replaces the old additive `{respected}/{disrespected}` merge that let a warm
   * tone launder a betrayal. Absent ⇒ no goodbye folded.
   */
  goodbye?: "warm" | "respectful" | "cold";
}

/**
 * A juror's lean toward a finalist: relationship (trust+affinity) plus the manner of
 * eviction. Blindsided / betrayed / disrespected pulls the lean down (less likely to
 * vote for the responsible finalist); feeling respected lifts it. The signed manner
 * shifts live in `juryConstants.MANNER_LEAN`.
 *
 * THREAT is deliberately ABSENT here (D4/E33 ruling, 2026-06-11): fearing a dangerous player
 * is an in-season eviction heuristic; at the finale the game is over, and a juror penalizing
 * "they were a threat" structurally crowns the harmless goat. Post-season, a big game earns
 * respect instead — the `gameRespect` resume term at the call site.
 *
 * RELIABILITY (E54 consumption tail) adds a centered evidence term: a juror leans toward a finalist
 * who DEMONSTRATED loyalty toward them (honored deals, protective votes, a veto save) above sentiment,
 * and away from one who proved disloyal. Sized below relationship+manner (`JURY_WEIGHTS.reliability`).
 */
export function juryLean(rel: JuryRel, manner: EvictionManner = {}, w: JuryWeights = JURY_WEIGHTS): number {
  const relationship = (rel.trust + rel.affinity) / 2;
  return w.relationship * relationship + w.manner * mannerLeanOf(manner) + w.reliability * (rel.reliability ?? 0);
}

/**
 * SOC-NEW-1/5 — the signed manner contribution, DYNAMIC and precedence-based (not a flat sum):
 *  - a grievance (betrayal/blindside/disrespect) and a clean cut's respect are each scaled by the
 *    graded `intensity` read off the relationship (absent ⇒ full strength);
 *  - a grievance takes PRECEDENCE: a `respected` flag set ALONGSIDE one (the legacy additive
 *    laundering shape) is dropped, never summed on top;
 *  - the `goodbye` tone is then applied with bounded precedence — a warm/respectful send-off softens
 *    a grievance by at most `goodbyeSoftenMax` (never crossing zero) or gives a small lift on a clean
 *    departure; a cold one stings. So a costless warm goodbye can no longer launder a betrayal.
 */
export function mannerLeanOf(manner: EvictionManner): number {
  const grievance =
    (manner.betrayed ? MANNER_LEAN.betrayed : 0) +
    (manner.blindsided ? MANNER_LEAN.blindsided : 0) +
    (manner.disrespected ? MANNER_LEAN.disrespected : 0);
  const respect = grievance < 0 ? 0 : (manner.respected ? MANNER_LEAN.respected : 0); // precedence
  let lean = (grievance + respect) * (manner.intensity ?? 1);
  if (manner.goodbye === "cold") {
    lean -= MANNER_GRADING.goodbyeColdSting; // a cold send-off stings; never itself laundered
  } else if (manner.goodbye === "warm" || manner.goodbye === "respectful") {
    if (lean < 0) lean *= 1 - MANNER_GRADING.goodbyeSoftenMax; // soften a grievance toward, never across, 0
    else lean += MANNER_GRADING.goodbyeWarmLift;               // a small lift on a clean departure
  }
  return lean;
}

/**
 * The signed GAME-RESPECT split between two finalists' public resumes (comp wins): the share of
 * the pair's combined resume this finalist owns, centered (±0.5). Both résumé-less ⇒ 0 (neutral).
 * Pure; weighted by `JURY_WEIGHTS.gameRespect` at the call site (ruling 2026-06-11).
 */
export function gameRespectTerm(own: number, other: number): number {
  const total = own + other;
  if (total <= 0) return 0;
  return own / total - 0.5;
}

/** Finale performance in [0,1] — mean quality of the opening statement + answers. */
export function finalePerformance(parts: ReadonlyArray<{ quality: number }>): number {
  if (parts.length === 0) return 0.5;
  return parts.reduce((s, p) => s + Math.max(0, Math.min(1, p.quality)), 0) / parts.length;
}

/**
 * The structured appeal a finalist makes when answering a juror (feature 0037). This is the
 * ANTI-SYCOPHANCY crux: the finale sway comes from a finalist's CHOICE of appeal scored by the
 * engine against THAT juror's state — never from the LLM grading the eloquence of prose. The LLM
 * voices the exchange; the number below is the engine's.
 */
export type FinaleAppeal = "own-game" | "mend" | "connect" | "discredit-rival";

export const FINALE_APPEALS: readonly FinaleAppeal[] = ["own-game", "mend", "connect", "discredit-rival"];

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * Engine-scored quality in [0,1] of `appeal` made to a juror with this read/manner of the finalist:
 *  - `mend`            lands only where there is a grievance (blindside/betrayal/disrespect) to address.
 *  - `connect`         scales with the juror's affinity for the finalist.
 *  - `own-game`        lands with jurors who respect a threatening, fair game; backfires on the betrayed.
 *  - `discredit-rival` a small generic lift that backfires with a juror loyal (high-affinity) to the rival.
 * The overall sway stays bounded by `JURY_WEIGHTS.finale` (well below relationship+manner), so a strong
 * finale tips CLOSE jurors and never overturns a clear lead.
 */
export function appealEffect(appeal: FinaleAppeal, rel: JuryRel, manner: EvictionManner = {}): number {
  // SOC-NEW-1: a cold send-off is itself a (mendable) grievance, like the categorical reads.
  const grievance = !!(manner.blindsided || manner.betrayed || manner.disrespected || manner.goodbye === "cold");
  switch (appeal) {
    case "mend":
      return grievance ? APPEAL.mendGrievance : APPEAL.mendNoGrievance;
    case "connect":
      return clamp01(APPEAL.connectBase + APPEAL.connectAffinity * rel.affinity);
    case "own-game":
      return manner.betrayed ? APPEAL.ownGameBetrayed : clamp01(APPEAL.ownGameBase + APPEAL.ownGameThreat * rel.threat);
    case "discredit-rival":
      return rel.affinity > APPEAL.discreditLoyaltyThreshold ? APPEAL.discreditLoyalToRival : APPEAL.discreditBase;
  }
}

/**
 * The strongest appeal a finalist can make to a given juror — used to let an NPC finalist play the
 * finale optimally (deterministic argmax over `FINALE_APPEALS`, ties broken by declaration order), so
 * the player's own appeals have to be at least as good to gain ground.
 */
export function bestAppeal(rel: JuryRel, manner: EvictionManner = {}): FinaleAppeal {
  let best: FinaleAppeal = FINALE_APPEALS[0]!;
  let bestScore = -Infinity;
  for (const a of FINALE_APPEALS) {
    const s = appealEffect(a, rel, manner);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return best;
}

/**
 * One juror's engine-decided vote between the two finalists. The dominant term is
 * the accumulated lean; the finale adds a small swing (performance + a momentary
 * seeded sway) that can tip a close juror but not a clear lead.
 */
export function castJuryVote(
  finalists: [EntityId, EntityId],
  leanFor: (f: EntityId) => number,
  perfFor: (f: EntityId) => number,
  rng: RandomnessSource,
  w: JuryWeights = JURY_WEIGHTS,
): EntityId {
  const sway = (f: EntityId): number => leanFor(f) + w.finale * (perfFor(f) + (rng.next() - 0.5));
  return sway(finalists[0]) >= sway(finalists[1]) ? finalists[0] : finalists[1];
}

/**
 * Tally the jury vote: each juror votes ONCE (precomputed so the tally and the
 * tie-break agree), most votes wins, a tie breaks to the last-evicted juror's vote.
 */
export function tallyJuryVote(
  jury: EntityId[],
  finalists: [EntityId, EntityId],
  leanOf: (juror: EntityId, finalist: EntityId) => number,
  perfOf: (finalist: EntityId) => number,
  juryEvictionOrder: EntityId[],
  rng: RandomnessSource,
  w: JuryWeights = JURY_WEIGHTS,
): EntityId {
  const votes = new Map<EntityId, EntityId>();
  for (const j of jury) votes.set(j, castJuryVote(finalists, (f) => leanOf(j, f), perfOf, rng, w));
  return tallyJury(jury, finalists, (j) => votes.get(j)!, juryEvictionOrder);
}

// --- Final 2 choreography -----------------------------------------------------

export interface FinaleScript {
  /** One opening statement slot per finalist. */
  statements: EntityId[];
  /** A question for EACH finalist from EACH juror (the player answers their own, 0012/0037). */
  questions: Array<{ juror: EntityId; finalist: EntityId }>;
  /** The order votes are revealed in — one at a time, for drama. */
  revealOrder: EntityId[];
}

/**
 * The engine-produced finale choreography: a statement slot per finalist, then a question to
 * BOTH finalists from EACH juror (9 jurors × 2 finalists = 18 Q&A), and a one-at-a-time reveal
 * order. Every (finalist, juror) pair is answered — the player-finalist answers all 9 jurors and
 * the NPC finalist answers all 9 with its best appeal — so the finale scoring is symmetric by
 * construction (no "unasked" pair the engine has to fill, audit A6). The narrative layer voices
 * each beat; it produces no decisions.
 */
export function runFinale(finalists: [EntityId, EntityId], jury: EntityId[]): FinaleScript {
  return {
    statements: [finalists[0], finalists[1]],
    questions: jury.flatMap((juror) => finalists.map((finalist) => ({ juror, finalist }))),
    revealOrder: [...jury],
  };
}
