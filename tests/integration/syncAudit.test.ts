/**
 * tests/integration/syncAudit.test.ts
 *
 * The DETERMINISTIC half of the chat↔engine SYNC AUDIT (a standing CI regression gate).
 *
 * A recurring bug class in this product is chat↔engine DESYNC: the narration LLM asserts game
 * state the engine never produced (it narrates past a pending decision, invents nominees, or
 * voices a HOH/veto holder that disagrees with the board). We have shipped point fixes for the
 * symptoms (C-02 NPC pre-resolve, C-03 veto-draw grounding, the pending-decision barrier in
 * `frontend/routes/chat_helpers.py`). This file turns the ROOT CAUSE into a deterministic gate.
 *
 * CI cannot drive the real (non-deterministic, paid) model, so we do not test the narration. We
 * test the two things that PREVENT desync deterministically — and this is half #1:
 *
 *   The engine's FE-facing PROJECTIONS — `gameStatus()` (`PublicGameStatus`) and `getGameState()`
 *   (`GameStateView`) — are the model's GROUNDING SOURCES. They are what the narrator is handed to
 *   voice the real ceremony. If those two views ever DISAGREE on a shared fact, or go ill-formed,
 *   the narration can desync no matter how good the prompt is. So we drive a FULL season (several
 *   seeds, every player pending auto-resolved like the UAT / statusPending helpers) and, at EVERY
 *   beat, assert the projections are mutually consistent, every pending is well-formed, the beat
 *   signature only moves monotonically forward, and the season actually REACHES a terminal state.
 *
 * The Python half (`frontend/tests/test_sync_audit.py`) covers the other prevention: the
 * pending-decision barrier blocks the model from narrating past EVERY player decision kind.
 *
 * Roles only — no names. Seed-stable and fully deterministic (no real LLM, no real embeddings).
 */

import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { CAST_SIZE } from "../../src/engine/characterFactory";
import type {
  AdvanceView,
  PublicGameStatus,
  GameStateView,
} from "../../src/ports/GameSession";

// The complete set of player decision kinds (mirrors PendingDecisionView.kind).
const KNOWN_PENDING_KINDS = new Set<string>([
  "nominations", "veto-decision", "comp-intent", "comp-round", "houseguests-choice", "replacement",
  "eviction-vote", "tie-break", "final-eviction", "goodbye-message", "exit-interview", "finale-statement",
  "finale-answer", "juror-question", "juror-vote", "spectator-choice", "finale-interview",
]);

type Pending = NonNullable<AdvanceView["pending"]>;

/**
 * Answer EVERY pending kind automatically (mirrors tests/unit/statusPending.test.ts `resolve`
 * and tests/uat/fullGameUatHarness.ts `autoResolve`) so a season runs unattended to completion.
 */
function resolve(s: GameSessionAdapter, p: Pending): void {
  const o = (i = 0): string => p.options[i]?.id;
  switch (p.kind) {
    case "nominations": s.submitDecision({ kind: "nominations", choice: [o(0), o(1)] }); break;
    case "veto-decision": s.submitDecision({ kind: "veto-decision", use: false }); break;
    case "comp-intent": s.submitDecision({ kind: "comp-intent", intent: "compete" }); break;
    case "comp-round": s.submitDecision({ kind: "comp-round", intent: "compete" }); break; // 0006 staged-rounds
    case "houseguests-choice": s.submitDecision({ kind: "houseguests-choice", choice: [o(0)] }); break;
    case "replacement": s.submitDecision({ kind: "replacement", replacement: o(0) }); break;
    case "eviction-vote": s.submitDecision({ kind: "eviction-vote", vote: o(0) }); break;
    case "tie-break": s.submitDecision({ kind: "tie-break", vote: o(0) }); break;
    case "final-eviction": s.submitDecision({ kind: "final-eviction", vote: o(0) }); break;
    case "goodbye-message": s.submitDecision({ kind: "goodbye-message", vote: o(0), statement: "x" }); break;
    case "exit-interview": s.submitDecision({ kind: "exit-interview", vote: o(0), statement: "x" }); break;
    case "spectator-choice": s.submitDecision({ kind: "spectator-choice", vote: "watch" }); break;
    case "finale-interview": s.submitDecision({ kind: "finale-interview", vote: o(0), statement: "x" }); break;
    case "finale-statement": s.submitDecision({ kind: "finale-statement", statement: "x" }); break;
    case "finale-answer": s.submitDecision({ kind: "finale-answer", appeal: p.appeals?.[0] ?? "own-game" }); break;
    case "juror-question": s.submitDecision({ kind: "juror-question", statement: "x" }); break;
    case "juror-vote": s.submitDecision({ kind: "juror-vote", vote: o(0) }); break;
    default: s.submitDecision({ kind: (p as Pending).kind, vote: o(0) }); break;
  }
}

/** A `{id,name}` ref compared by VALUE (the model grounds on these exact pairs). */
type Ref = { id: string; name: string } | null;
function normRef(r: { id: string; name: string } | null | undefined): Ref {
  return r ? { id: r.id, name: r.name } : null;
}
function normRefs(rs: Array<{ id: string; name: string }> | undefined): Ref[] {
  return (rs ?? []).map((r) => ({ id: r.id, name: r.name }));
}

/** Carries the running beat-signature so monotonicity can be asserted across the whole season. */
interface BeatTracker {
  prevWeek: number;
  prevEvicted: number;
  everFinished: boolean;
}

/**
 * Assert ALL sync invariants at one beat. `label` names the beat so a failure points at it.
 * `status` is `gameStatus()` (PublicGameStatus); `view` is `getGameState()` (GameStateView).
 */
function assertBeatInvariants(
  label: string,
  status: PublicGameStatus,
  view: GameStateView,
  winner: AdvanceView["winner"],
  t: BeatTracker,
): void {
  // ── (a) PROJECTION CONSISTENCY — the two grounding views never disagree on shared facts ──
  // If these diverge, the narrator can voice one view's HOH/nominees/veto while the board holds
  // the other's — the exact desync C-02/C-03 fight at the source.
  expect(status.week, `${label}: gameStatus.week vs getGameState.week`).toBe(view.week);
  expect(status.phase, `${label}: gameStatus.phase vs getGameState.phase`).toBe(view.phase);
  expect(normRef(status.hoh), `${label}: HOH disagrees between gameStatus and getGameState.ceremony`)
    .toEqual(normRef(view.ceremony.hoh));
  expect(normRefs(status.nominees), `${label}: nominees disagree between the two projections`)
    .toEqual(normRefs(view.ceremony.nominees));
  expect(normRef(status.veto.holder), `${label}: veto holder disagrees between the two projections`)
    .toEqual(normRef(view.ceremony.veto.holder));
  expect(status.veto.used, `${label}: veto.used disagrees between the two projections`)
    .toBe(view.ceremony.veto.used);

  // ── (b) PENDING WELL-FORMEDNESS — a malformed pending desyncs the decision card / barrier ──
  const pending = status.pending;
  if (pending !== null) {
    // 0133: the ONE sanctioned exception — a pre-jury-evicted player's finale-night interview is raised AFTER the season is
    // crowned (`finished`), so it can never move the vote or block the crowning. Every other pending still implies not-finished.
    if (pending.kind !== "finale-interview") {
      expect(view.finished, `${label}: a pending is open but the game claims finished`).toBe(false);
    } else {
      expect(view.finished, `${label}: the finale interview is only offered once the season is crowned`).toBe(true);
    }
    expect(KNOWN_PENDING_KINDS.has(pending.kind), `${label}: unknown pending kind '${pending.kind}'`).toBe(true);
    expect(pending.by, `${label}: pending.by missing`).toBeTruthy();
    expect(typeof pending.by.id, `${label}: pending.by.id not an id`).toBe("string");
    expect(pending.by.id.length, `${label}: pending.by.id empty`).toBeGreaterThan(0);
    expect(typeof pending.by.name, `${label}: pending.by.name not a name`).toBe("string");
    expect(pending.by.name.length, `${label}: pending.by.name empty`).toBeGreaterThan(0);
    expect(Array.isArray(pending.options), `${label}: pending.options not an array`).toBe(true);
  }
  if (view.finished) {
    // (the same 0133 exception: only a finale-night interview may still be open on a crowned season)
    expect(status.pending?.kind ?? null, `${label}: game is finished but a pending is still open`).toBe(status.pending ? "finale-interview" : null);
  }

  // ── (c) BEAT-SIGNATURE MONOTONICITY — the season only moves forward (never rewinds) ──
  expect(typeof view.phase, `${label}: phase is not a string`).toBe("string");
  expect(view.phase.length, `${label}: phase is empty`).toBeGreaterThan(0);
  expect(view.week, `${label}: week went BACKWARD (${view.week} < ${t.prevWeek})`)
    .toBeGreaterThanOrEqual(t.prevWeek);

  const evicted = view.house.filter((h) => h.status !== "active").length;
  expect(evicted, `${label}: evicted count went BACKWARD (${evicted} < ${t.prevEvicted})`)
    .toBeGreaterThanOrEqual(t.prevEvicted);
  expect(evicted, `${label}: evicted count ${evicted} exceeds cast-1 (${CAST_SIZE - 1})`)
    .toBeLessThanOrEqual(CAST_SIZE - 1);

  if (t.everFinished) {
    // Once finished, it must STAY finished (the season can't un-end under the narrator).
    expect(view.finished, `${label}: game un-finished after having finished`).toBe(true);
  }
  if (view.finished) {
    expect(winner, `${label}: finished season has no winner`).toBeTruthy();
    expect(winner?.id, `${label}: finished season winner has no id`).toBeTruthy();
    expect(winner?.name, `${label}: finished season winner has no name`).toBeTruthy();
  }

  // Advance the running signature.
  t.prevWeek = view.week;
  t.prevEvicted = evicted;
  if (view.finished) t.everFinished = true;
}

/** Drive one full season for `seed`, asserting the sync invariants at every beat. */
function runSeasonWithSyncAudit(seed: number): { finished: boolean; weeks: number; beats: number } {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "P", seed });

  const t: BeatTracker = { prevWeek: 0, prevEvicted: 0, everFinished: false };
  let finished = false;
  let lastWeek = 0;
  let beats = 0;
  let lastWinner: AdvanceView["winner"] = null;

  // A generous but bounded budget — a full 16-cast season is far under this; a runaway loop trips it.
  const MAX_BEATS = 5_000;
  for (let i = 0; i < MAX_BEATS && !finished; i++) {
    const adv = s.advanceGame();
    expect(adv.started, `seed ${seed}: advanceGame returned started=false`).toBe(true);
    lastWinner = adv.winner;
    lastWeek = adv.status.week;

    // After the advance, read BOTH live projections and assert they agree / are well-formed.
    assertBeatInvariants(
      `seed ${seed} beat#${beats} after-advance (phase=${adv.status.phase} week=${adv.status.week})`,
      s.gameStatus(), s.getGameState(), adv.winner, t,
    );
    beats++;
    finished = adv.finished;

    // Resolve a surfaced player pending, then re-assert at the post-decision beat too.
    const pending = adv.pending;
    if (pending && !finished) {
      resolve(s, pending);
      const postStatus = s.gameStatus();
      const postView = s.getGameState();
      // The decision's resulting winner lives on the next advance/gameStatus; track the latest.
      lastWinner = postView.finished ? lastWinner : lastWinner;
      assertBeatInvariants(
        `seed ${seed} beat#${beats} after-decision (resolved=${pending.kind})`,
        postStatus, postView, lastWinner, t,
      );
      beats++;
      finished = postView.finished;
    }
  }

  return { finished, weeks: lastWeek, beats };
}

describe("chat↔engine sync audit — engine projection + beat-signature invariants over a full season", () => {
  // A few seeds so different paths run (player surviving deep vs. evicted pre-jury / into the jury).
  const SEEDS = [1, 2, 3, 4, 5];

  for (const seed of SEEDS) {
    it(
      `seed ${seed}: projections stay consistent + well-formed every beat, and the season reaches a winner`,
      () => {
        const { finished, weeks, beats } = runSeasonWithSyncAudit(seed);

        // ── (d) The season actually REACHES a terminal state — proves a REAL full run, not a bail ──
        expect(finished, `seed ${seed}: season did not reach finished=true`).toBe(true);
        expect(weeks, `seed ${seed}: season played < 1 week`).toBeGreaterThanOrEqual(1);
        expect(beats, `seed ${seed}: implausibly few beats for a full season`).toBeGreaterThan(5);
      },
      { timeout: 60_000 },
    );
  }
});
