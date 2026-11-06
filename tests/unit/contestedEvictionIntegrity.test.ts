import { describe, it, expect, vi } from "vitest";
// ORW-212: a seed-pinned tie-break; the calm re-seat (ORW-212) shifts the weighted occupancy that co-presence consumers read; this test pins the previous (non-calm) movement so its seeded premise holds. The calm movement has its own tests (calmPresence.test.ts).
vi.hoisted(() => { process.env.ORWELL_CALM_PRESENCE = "0"; });
import { freshTmpDir } from "../support/freshTmpDir";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import type { HealthRecord } from "../../src/composition/orchestrator";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { AdvanceView, PendingDecisionView } from "../../src/ports/GameSession";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { PLAYER, npc } from "../../src/domain/ids";
import { StaleBeatError } from "../../src/domain/errors";

/**
 * #1106 — the engine integrity circuit OPENED during a contested eviction (and recovered).
 *
 * Forensic context (2026-06-27 convergence mining of `engine.log`): SIX consecutive
 *   `[orwell] integrity fault user=default trigger=player-turn kinds=degradation`
 * — the last `circuit=OPEN` — correlated 1:1 with six FE `pre-emission guard HELD a phantom
 * closed-set outcome` fires in a ~3s burst. The player was on the block; the narration model
 * REPEATEDLY narrated the eviction outcome AHEAD of the engine commit, and each ahead-of-the-board
 * write produced a candidate that DROPPED persisted detail (a phantom that re-rendered fewer events
 * than the committed baseline holds). The fail-closed non-degradation checkpoint (0031) correctly
 * REFUSED all six, rolled each back to the intact prior save (`registry.restore(baseline)` — NO data
 * loss), and tripped the `BREAKER_THRESHOLD` circuit. Recovery was automatic: `commitPlayerTurn`
 * never SKIPS on an open circuit (only off-screen ticks do), so the next clean turn reset the circuit
 * and the eviction committed; the game reached its finale.
 *
 * DIAGNOSIS: the six faults were REAL degradations the guard correctly caught — NOT false positives.
 * The fix is UPSTREAM (the model narrating ahead — #1107 momentPrompts); the checkpoint behaved
 * exactly as mandate #4 demands and MUST NOT be weakened. These regression tests pin the diagnosis:
 * the 6-fault → OPEN → recover sequence, zero data loss on every rollback, and that a genuine
 * degradation is STILL refused (the guard is intact).
 *
 * HARD rule: roles only — no names.
 */
const freshDir = (): string => freshTmpDir("orwell-1106-");

function resolveLegally(s: GameSessionAdapter, p: PendingDecisionView): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-intent" || p.kind === "comp-round") s.submitDecision({ kind: p.kind, intent: "compete" }); // default flip 2026-11-03
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "juror-vote") s.submitDecision({ kind: "juror-vote", vote: p.options[0]!.id });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id });
}

/** Drive a real game until the eviction-vote pending of the FIRST week, leaving it UNRESOLVED so the
 *  test can exercise the contested-eviction commit pattern at exactly that beat. */
function driveToFirstEvictionVote(sb: { session: GameSessionAdapter }): AdvanceView {
  let view: AdvanceView = sb.session.advanceGame();
  for (let i = 0; i < 80; i++) {
    if (view.finished) throw new Error("game finished before reaching an eviction-vote");
    if (view.pending?.kind === "eviction-vote") return view;
    if (view.pending) resolveLegally(sb.session, view.pending);
    view = sb.session.advanceGame();
  }
  throw new Error("never reached an eviction-vote");
}

describe("#1106 — the contested-eviction integrity fault sequence (correctly caught, recovers, no data loss)", () => {
  it("six narrate-ahead degrading player-turn commits → circuit OPENS → next clean turn recovers; prior save intact throughout", () => {
    const dir = freshDir();
    const user = "default";
    const runtime = composeRuntime({ saveStore: new FileSaveStore(dir), clock: new FakeClock() });
    const reg = runtime.registry;
    const orch = runtime.orchestrator;
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 12 }); // re-selected 2026-11-03, default flip (was 11)

    // Drive to a real contested beat: the first week's eviction-vote, left unresolved. Every step here
    // committed cleanly through the checkpoint, so the durable save now holds a real, healthy game.
    const atEviction = driveToFirstEvictionVote(sb);
    expect(atEviction.pending?.kind).toBe("eviction-vote");

    // The good, committed baseline the checkpoint will protect — captured from the durable save, exactly
    // what `registry.restore(baseline)` rolls back TO on a refused commit.
    const goodSave: SessionSnapshot = new FileSaveStore(dir).loadLatest(user)!;
    const goodEventCount = goodSave.events.length;
    expect(goodEventCount).toBeGreaterThan(0);
    const goodBlob = JSON.stringify(goodSave);

    // The narrate-ahead candidate: the model narrates the eviction outcome AHEAD of the board, and the
    // resulting ahead-of-the-board write re-renders a candidate that has LOST persisted detail (here:
    // a dropped tail of events — the realistic shape of a phantom commit). This is a GENUINE degradation,
    // not a false positive: persisted detail would thin out if it ever committed (mandate #4 forbids it).
    const degradedCandidate: SessionSnapshot = {
      ...goodSave,
      events: goodSave.events.slice(0, Math.max(1, goodEventCount - 2)),
    };

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let attempt = 1; attempt <= 6; attempt++) {
        // The FE's narrate-ahead commit lands a degrading candidate in the live sandbox, then the
        // registry's commit funnel runs the checkpoint (the same path `onPersist` drives in production).
        reg.restore(user, degradedCandidate);
        expect(() => orch.commitPlayerTurn(user)).toThrowError(/turn refused/);

        const health = orch.sandboxHealth(user) as HealthRecord;
        // Every refusal is a `degradation` fault — the precise kind the forensic log recorded.
        expect(health.lastIntegrity).toBe("fault");
        expect(health.faults.at(-1)!.kind).toBe("degradation");
        // The breaker (BREAKER_THRESHOLD = 3): the circuit OPENS once three consecutive faults stack.
        expect(health.circuitOpen).toBe(attempt >= 3);

        // NO DATA LOSS: the prior good save is byte-for-byte intact after every rollback. A refused
        // commit never persists — the durable save is exactly the healthy pre-burst game.
        expect(JSON.stringify(new FileSaveStore(dir).loadLatest(user)!)).toBe(goodBlob);
      }

      // The circuit is OPEN after the six-fault burst (mirrors the `circuit=OPEN` on the 6th log line)…
      expect((orch.sandboxHealth(user) as HealthRecord).circuitOpen).toBe(true);

      // …and the fail-closed rollback ALREADY left the live sandbox at the last GOOD committed baseline
      // (every refused `commitPlayerTurn` calls `registry.restore(baseline)` internally). The orchestrator
      // also still holds that good baseline, so recovery needs NO external re-ground — exactly the live
      // recovery in #1106: a player-turn NEVER skips on an open circuit (only off-screen ticks do), so the
      // next clean turn just works. Re-fetch the (restored) live session and resolve the eviction legally.
      const live = reg.sandboxFor(user);
      const refetched = live.session.advanceGame();
      const pending = refetched.pending ?? atEviction.pending!;
      if (pending.kind === "eviction-vote") resolveLegally(live.session, pending); // the real eviction → a committed beat
      else if (pending) resolveLegally(live.session, pending);

      const recovered = orch.sandboxHealth(user) as HealthRecord;
      // The circuit CLOSED on the clean commit, and the eviction's beat committed cleanly.
      expect(recovered.circuitOpen).toBe(false);
      expect(recovered.lastIntegrity).toBe("ok");

      // The eviction ultimately COMMITTED and PERSISTED — the durable save advanced past the pre-burst
      // game (the recovered turn recorded its events), and the game can keep advancing to the finale.
      const afterSave = new FileSaveStore(dir).loadLatest(user)!;
      expect(afterSave.events.length).toBeGreaterThan(goodEventCount);
    } finally {
      errSpy.mockRestore();
    }
  });
});

/** Resolve ANY pending with a legal default (roles only) — the local full-drive variant of
 *  `resolveLegally` above, covering the endgame/nightly kinds a long drive can hit. Every kind is
 *  handled with its CORRECT payload shape (no cast — a shape mismatch must fail the test, #1380). */
function resolveAnyLegally(s: GameSessionAdapter, p: PendingDecisionView): void {
  switch (p.kind) {
    case "nominations": s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] }); return;
    case "veto-decision": s.submitDecision({ kind: "veto-decision", use: false }); return;
    case "secret-veto": s.submitDecision({ kind: "secret-veto", use: false }); return;
    case "replacement": s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id }); return;
    case "comp-intent":
    case "comp-round": s.submitDecision({ kind: p.kind, intent: "compete" }); return;
    case "finale-statement": s.submitDecision({ kind: "finale-statement", statement: "x" }); return;
    case "finale-answer": s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! }); return;
    case "juror-question": s.submitDecision({ kind: "juror-question", statement: "q" }); return;
    case "goodbye-message": s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id, statement: "bye" }); return;
    case "exit-interview": s.submitDecision({ kind: "exit-interview", vote: "gracious" }); return; // 0130
    case "spectator-choice": s.submitDecision({ kind: "spectator-choice", vote: "watch" }); return; // 0133
    case "finale-interview": s.submitDecision({ kind: "finale-interview", vote: "gracious" }); return; // 0133
    // The single-pick kinds share the `vote` payload (audit A10: `vote`/1-element `choice` interchangeable).
    case "houseguests-choice":
    case "eviction-vote":
    case "tie-break":
    case "final-eviction":
    case "juror-vote": s.submitDecision({ kind: p.kind, vote: p.options[0]!.id }); return;
    default: throw new Error(`unsupported pending kind in test driver: ${p.kind as string}`);
  }
}

describe("#1106 — a REAL contested eviction (player-HOH TIE) through the production runtime", () => {
  /**
   * The mission-critical empirical fact behind the #1106 diagnosis: the ENGINE's contested-eviction
   * path — the staged secret-ballot reveal in batched rounds, a genuinely TIED vote, the player-HOH
   * tie-break pending, the goodbye stage, the week rollover — commits CLEAN through the production
   * spine (composeRuntime: LogicalClock, turn-driven ticks, the checkpointed commit funnel). Seed 44
   * deterministically produces a tied eviction vote with the player as HOH. Zero integrity faults on
   * the whole drive proves the #1106 faults were EXTERNALLY-induced degrading candidates (the
   * narrate-ahead writes), not an eviction-path bug and not a checkpoint false-positive on mid-stage
   * eviction state. The storm/recovery/stale/duplicate arms then re-run the #1106 sequence AT the
   * live tie-break beat — the commit spine's worst-case moment.
   *
   * Seed re-selected 2026-07-21 (T0-2, "beats terminate themselves"): resolving a CLOSED-SET ceremony
   * pending (veto-decision/replacement/eviction-vote/…) now auto-advances the live loop one more
   * deterministic step in the SAME `submitDecision` call — this test's drive loop pairs one
   * `advanceGame` with one decision-resolve per iteration, so the same 2000-iteration budget now
   * covers MORE of the season per iteration, and (per ADR "one off-screen tick per committed player
   * turn," not per beat) a turn that now carries two beats still earns exactly one tick — fewer ticks
   * land between some ceremony beats than before, which can shift a relationship-driven vote (NPCs'
   * `voteChoice`) from tied to not (or vice versa) for a given seed. Seed 45 no longer produces a
   * player-HOH tie within the budget under the new interleave; seed 14 does. Harness-timing retune
   * only — the engine's tie/vote-count LOGIC is untouched, and the whole #1106 non-degradation/
   * checkpoint story this test exists to pin is orthogonal to which seed reaches the contested beat.
   *
   * Seed re-selected again 2026-11-02 (0044 §9 difficulty rulings — floaters as pawns, the HOH-referendum
   * vote, per-houseguest nomination styles, the pawn-or-target replacement reshape the block): seed 44 produces the
   * player-HOH tie. Same harness-only retune; the integrity story is unchanged.
   */
  it("tie-break fires; a 3-fault storm at the beat opens the circuit; the tie still resolves clean; no data loss; stale/duplicate submits are inert", () => {
    // The tie is a property of (seed, user, driving-pattern) and the balance moves it, so SEARCH for a seed that
    // reaches a player-HOH tie (44 first — the last known one — then a tail) instead of re-pinning by hand every
    // time the difficulty changes. Anything other than "this seed had no tie" surfaces.
    const user = "u";
    const SEARCH: number[] = [44, ...Array.from({ length: 80 }, (_, i) => i + 1)];
    let dir = "";
    let runtime!: ReturnType<typeof composeRuntime>;
    let reg!: ReturnType<typeof composeRuntime>["registry"];
    let orch!: ReturnType<typeof composeRuntime>["orchestrator"];
    let tie: PendingDecisionView | null = null;
    let view!: AdvanceView;
    for (const seed of SEARCH) {
      dir = freshDir();
      runtime = composeRuntime({ saveStore: new FileSaveStore(dir) }); // the PRODUCTION clock/wiring
      reg = runtime.registry;
      orch = runtime.orchestrator;
      reg.sandboxFor(user).session.createCharacter({ playerName: "The Player", seed });
      // Drive the real game to the CONTESTED beat: a tied eviction vote with the player holding HOH.
      view = reg.sandboxFor(user).session.advanceGame();
      for (let i = 0; i < 2000 && !view.finished; i++) {
        if (view.pending?.kind === "tie-break") { tie = view.pending; break; }
        if (view.pending) resolveAnyLegally(reg.sandboxFor(user).session, view.pending);
        view = reg.sandboxFor(user).session.advanceGame();
      }
      if (tie && tie.by.id === PLAYER) break;
      tie = null;
    }
    expect(tie).not.toBeNull();
    expect(tie!.by.id).toBe(PLAYER); // the player-HOH breaks the tie — the contested case
    expect(tie!.options.length).toBe(2);

    // The whole drive TO the contested beat committed clean: zero integrity faults, circuit closed.
    const atTie = orch.sandboxHealth(user) as HealthRecord;
    expect(atTie.faults).toEqual([]);
    expect(atTie.circuitOpen).toBe(false);

    const store = new FileSaveStore(dir);
    const goodSave: SessionSnapshot = store.loadLatest(user)!;
    const goodBlob = JSON.stringify(goodSave);
    const goodEventCount = goodSave.events.length;

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // THE #1106 STORM AT THE CONTESTED BEAT: repeated narrate-ahead degrading candidates. Each is
      // refused fail-closed (typed, rolled back); the third opens the circuit; the durable save —
      // the tied board, the pending tie-break, every ballot — stays byte-for-byte intact throughout.
      const degraded: SessionSnapshot = { ...goodSave, events: goodSave.events.slice(0, goodEventCount - 2) };
      for (let attempt = 1; attempt <= 3; attempt++) {
        reg.restore(user, degraded);
        expect(() => orch.commitPlayerTurn(user)).toThrowError(/turn refused/);
        expect((orch.sandboxHealth(user) as HealthRecord).circuitOpen).toBe(attempt >= 3);
        expect(JSON.stringify(store.loadLatest(user)!)).toBe(goodBlob);
      }

      // A STALE-BOARD submission (the two-window / narrate-ahead concurrency shape, 0065 Part A) is
      // refused BEFORE any write — typed StaleBeatError, no integrity fault, durable save untouched.
      const live = reg.sandboxFor(user);
      const faultsBefore = (orch.sandboxHealth(user) as HealthRecord).faults.length;
      expect(() => live.session.submitDecision({
        kind: "tie-break", vote: tie!.options[0]!.id, expectedBeatSeq: live.session.beatSeqNow() - 1,
      })).toThrowError(StaleBeatError);
      expect((orch.sandboxHealth(user) as HealthRecord).faults.length).toBe(faultsBefore);
      expect(JSON.stringify(store.loadLatest(user)!)).toBe(goodBlob);

      // RECOVERY AT THE CONTESTED BEAT: `commitPlayerTurn` never skips on an open circuit, so the
      // player's legal tie-break commits IMMEDIATELY — the circuit closes, the eviction lands, and
      // the durable save advances past the pre-storm game (the beat was recorded, not just narrated).
      const resolved = live.session.submitDecision({ kind: "tie-break", vote: tie!.options[0]!.id });
      expect(resolved.pending?.kind ?? null).not.toBe("tie-break");
      const recovered = orch.sandboxHealth(user) as HealthRecord;
      expect(recovered.circuitOpen).toBe(false);
      expect(recovered.lastIntegrity).toBe("ok");
      const evictionOrder = live.session.snapshot().live?.evictionOrder ?? [];
      expect(evictionOrder).toContain(tie!.options[0]!.id);
      expect(store.loadLatest(user)!.events.length).toBeGreaterThan(goodEventCount);

      // #1106 FORENSICS SURVIVE RECOVERY: the recent-fault ring still shows the storm's degradation
      // kinds AFTER the clean commit (God Mode can reconstruct the burst without log mining), capped.
      expect(recovered.faults.filter((f) => f.kind === "degradation").length).toBeGreaterThanOrEqual(3);
      expect(recovered.faults.length).toBeLessThanOrEqual(20);

      // A DUPLICATE tie-break submission (second window, replayed turn) is an inert no-op: no second
      // eviction, no fault, the board unchanged.
      const savedAfter = JSON.stringify(store.loadLatest(user)!);
      live.session.submitDecision({ kind: "tie-break", vote: tie!.options[1]!.id });
      expect(reg.sandboxFor(user).session.snapshot().live?.evictionOrder ?? []).toEqual(evictionOrder);
      expect((orch.sandboxHealth(user) as HealthRecord).lastIntegrity).toBe("ok");
      expect(JSON.stringify(store.loadLatest(user)!)).toBe(savedAfter);

      // The house keeps playing clean past the contested night (a bounded stretch — the UAT lane
      // owns full-game drives): goodbyes → eviction-result → the next week's beats, zero new faults.
      let after: AdvanceView = reg.sandboxFor(user).session.advanceGame();
      for (let i = 0; i < 40 && !after.finished; i++) {
        if (after.pending) resolveAnyLegally(reg.sandboxFor(user).session, after.pending);
        after = reg.sandboxFor(user).session.advanceGame();
      }
      const settled = orch.sandboxHealth(user) as HealthRecord;
      expect(settled.circuitOpen).toBe(false);
      expect(settled.lastIntegrity).toBe("ok");
      // No state fault was added after recovery (the retained ring is exactly the storm's).
      expect(settled.faults.filter((f) => f.kind === "degradation").length)
        .toBe(recovered.faults.filter((f) => f.kind === "degradation").length);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("#1106 — the non-degradation guard is NOT weakened by the recovery path", () => {
  it("a GENUINE degradation is STILL refused (dropped persisted detail never commits)", () => {
    const dir = freshDir();
    const user = "u";
    {
      const r1 = composeRuntime({ saveStore: new FileSaveStore(dir), clock: new FakeClock() });
      r1.registry.sandboxFor(user).session.createCharacter({ playerName: "The Player", seed: 7 });
      r1.registry.sandboxFor(user).session.advanceGame();
    }
    // Resume the healthy game; the boot preload seeds the non-degradation baseline from the save.
    const runtime = composeRuntime({ saveStore: new FileSaveStore(dir), clock: new FakeClock() });
    const snap = runtime.registry.snapshot(user);
    expect(snap.events.length).toBeGreaterThan(0);
    const goodBlob = JSON.stringify(new FileSaveStore(dir).loadLatest(user)!);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Drop persisted events — a real thinning. Even AFTER the recovery path exists, the guard must
      // refuse it: non-degradation (mandate #4) is intact.
      runtime.registry.restore(user, { ...snap, events: snap.events.slice(0, 1) });
      expect(() => runtime.orchestrator.commitPlayerTurn(user)).toThrowError(/turn refused/);
      expect((runtime.orchestrator.sandboxHealth(user) as HealthRecord).faults.some((f) => f.kind === "degradation")).toBe(true);
      // The prior good save was never overwritten by the refused commit.
      expect(JSON.stringify(new FileSaveStore(dir).loadLatest(user)!)).toBe(goodBlob);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a leak (Vault content with no pathway) is STILL refused at the same beat — the guard's other arm is intact", () => {
    const runtime = composeRuntime({ saveStore: new FileSaveStore(freshDir()), clock: new FakeClock() });
    const user = "leaker";
    const sb = runtime.registry.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 2 });

    const SECRET = "LEAK-1106-SENTINEL";
    sb.engine.events.record({ id: "leak:h", ts: 1, type: "conversation", initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: `secret ${SECRET}` });
    sb.engine.events.record({ id: "leak:v", ts: 2, type: "house-event", initiator: npc(1), witnessSet: [PLAYER, npc(1)], hidden: false, content: `secret ${SECRET}` });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => runtime.orchestrator.commitPlayerTurn(user)).toThrowError(/turn refused/);
      expect(runtime.registry.sandboxFor(user).engine.events.queryAll().some((e) => e.content.includes(SECRET))).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});
