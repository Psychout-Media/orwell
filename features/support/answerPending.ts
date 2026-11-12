import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";

/**
 * BDD PAT-1 — ONE shared "answer whatever decision is pending" driver for the step files that auto-play a season.
 * It is a FAITHFUL player, not a lenient one: every pending kind the engine can raise is answered EXPLICITLY below, and an
 * UNKNOWN kind throws a clear error naming it. It never guesses (the old per-file `else submitDecision({ kind: p.kind,
 * vote: options[0] })` fallback answered new pendings — skip/watch, the finale interview, card-gating — by accident, so a
 * scenario could pass for the wrong reason). A new pending kind therefore fails loudly here until someone decides how a
 * scenario should answer it. Roles only.
 */
export type PendingView = NonNullable<AdvanceView["pending"]>;

export interface AnswerPolicy {
  /** veto-decision: use the veto on the first nominee (default: hold it). */
  useVeto?: boolean;
}

/**
 * The request that answers `p`, or `null` for a kind that is INTENTIONALLY never auto-answered (`self-evict`: the
 * out-of-character walk-out confirmation, which only a scenario about it may ever send). Throws on an unknown kind.
 */
export function answerPending(p: PendingView, policy: AnswerPolicy = {}): SubmitDecisionReq | null {
  const first = p.options?.[0]?.id;
  switch (p.kind) {
    case "nominations": return { kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] };
    case "veto-decision":
      return policy.useVeto && first ? { kind: "veto-decision", use: true, save: first } : { kind: "veto-decision", use: false };
    case "comp-intent": return { kind: "comp-intent", intent: "compete" };
    case "comp-round": return { kind: "comp-round", intent: "compete" };
    case "replacement": return { kind: "replacement", replacement: p.options[0]!.id };
    case "houseguests-choice": return { kind: "houseguests-choice", vote: p.options[0]!.id };
    case "eviction-vote": return { kind: "eviction-vote", vote: p.options[0]!.id };
    case "tie-break": return { kind: "tie-break", vote: p.options[0]!.id };
    case "final-eviction": return { kind: "final-eviction", vote: p.options[0]!.id };
    case "juror-vote": return { kind: "juror-vote", vote: p.options[0]!.id };
    case "goodbye-message": return { kind: "goodbye-message", vote: first ?? "respectful" };
    case "exit-interview": return { kind: "exit-interview", vote: p.stances?.[0] ?? first ?? "gracious" }; // the first LEGAL posture offered
    case "spectator-choice": return { kind: "spectator-choice", vote: "watch" };
    case "finale-interview": return { kind: "finale-interview", vote: p.stances?.[0] ?? "gracious" };
    case "juror-question": return { kind: "juror-question", statement: "What was your biggest move?" };
    case "finale-statement": return { kind: "finale-statement", statement: "I played my own game." };
    case "finale-answer": return { kind: "finale-answer", appeal: p.appeals?.[0] ?? "own-game" };
    case "secret-veto": return { kind: "secret-veto", use: false };
    // Intentionally never auto-answered: `self-evict` (the out-of-character walk-out confirmation) and `deal-offer` (the engine
    // surfaces a floated deal through `openDealOffer`, which needs an explicit chat answer — a shared driver must not decline it
    // by accident). The type union lists both kinds, so they are named here instead of falling into the throwing default.
    // `ceremony-step` (ORW-281 4a) is a WATCH step answered by advanceGame, never by a decision.
    case "ceremony-step":
    case "deal-offer":
    case "self-evict": return null;
    default: {
      const unknown: never = p.kind;
      throw new Error(
        `answerPending: unhandled pending decision kind '${String(unknown)}' — add an explicit answer in features/support/answerPending.ts (never default one)`,
      );
    }
  }
}

/** Submit the answer for `p` through `submit`; a `null` (intentionally unanswered) answer submits nothing. */
export function resolvePending<R>(p: PendingView, submit: (req: SubmitDecisionReq) => R, policy: AnswerPolicy = {}): R | undefined {
  const req = answerPending(p, policy);
  return req === null ? undefined : submit(req);
}
