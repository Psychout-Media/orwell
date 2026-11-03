import { answerPending } from "./answerPending";
import type { AdvanceView, FinaleFastForwardView, SubmitDecisionReq } from "../../src/ports/GameSession";

/**
 * BDD PAT-3 — the shared "play one seeded season and fingerprint the PROTECTED outcome" helper.
 *
 * Every "outcome-neutral / byte-identical" scenario must compare a run with the layer ON against a run with it
 * explicitly OFF (a setter), never an OFF run against another OFF run. The fingerprint is the closed-set outcome the
 * layer must not move: the crowned winner, the Final 2, the full eviction order, the public competition tally
 * (`resume`) and the finale jury votes. Roles only — ids, never names.
 */
export interface SeasonSession {
  advanceToFinale(): FinaleFastForwardView;
  advanceGame(): AdvanceView;
  submitDecision(req: SubmitDecisionReq): unknown;
  snapshot(): { live?: unknown | null };
}

export interface SeasonOutcome {
  winner: unknown;
  finalTwo: unknown;
  evictionOrder: unknown;
  resume: unknown;
  juryVotes: unknown;
}

interface LiveShape {
  winner?: unknown; finalTwo?: unknown; evictionOrder?: unknown; resume?: unknown; finale?: { votes?: unknown };
}

/** Read the protected outcome off a finished (or in-progress) session. */
export function outcomeOf(s: Pick<SeasonSession, "snapshot">): SeasonOutcome {
  const live = (s.snapshot().live ?? {}) as LiveShape;
  return {
    winner: live.winner ?? null,
    finalTwo: live.finalTwo ?? null,
    evictionOrder: live.evictionOrder ?? [],
    resume: live.resume ?? {},
    juryVotes: live.finale?.votes ?? {},
  };
}

/**
 * Play the season to its finale and return the protected outcome. With no `perBeat` hook it uses the engine's own
 * admin fast-forward; with one it drives the season beat by beat through the shared pending-decision driver and
 * calls `perBeat` after each advance (for layers that tick between beats, e.g. campaigns).
 */
export function playSeasonOutcome(s: SeasonSession, perBeat?: () => void): SeasonOutcome {
  if (!perBeat) {
    const v = s.advanceToFinale();
    if (!v.finished) throw new Error("playSeasonOutcome: the season did not reach its finale");
    return outcomeOf(s);
  }
  for (let i = 0; i < 6000; i++) {
    const a = s.advanceGame();
    if (a.pending) {
      const req = answerPending(a.pending);
      if (req) s.submitDecision(req);
    }
    perBeat();
    if (a.finished) return outcomeOf(s);
  }
  throw new Error("playSeasonOutcome: the beat-by-beat season did not finish");
}
