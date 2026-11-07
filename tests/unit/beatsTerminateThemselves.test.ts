import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GameSessionAdapter as GameSessionAdapterImpl } from "../../src/adapters/engine/GameSessionAdapter";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, PendingDecisionView } from "../../src/ports/GameSession";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PersistFailureError } from "../../src/domain/errors";
import type { UserSaveStore } from "../../src/ports/UserSaveStore";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

/**
 * T0-2 — "beats terminate themselves" (moonshot P1 stage 1 / #27a; `docs/audits/
 * 2026-07-21-campaign-report-and-exhaustive-backlog.md` DoR/AC/DoD). Resolving a CLOSED-SET ceremony
 * pending (`AUTO_ADVANCE_PENDING_KINDS` in `GameSessionAdapter.ts`) now auto-advances the live loop
 * ONE more deterministic step IN THE SAME committed transaction — `submitDecision` never leaves the
 * game sitting at "resolved, but nothing moved" waiting for a separate `advanceGame` call. Pendings
 * that carry the player's own expressive content (goodbye messages, the interactive finale…) keep
 * their CURRENT semantics — resolving them does NOT auto-advance.
 *
 * Games are driven through a real `composeRuntime` (not a bare `GameSessionAdapter`) because
 * `beatSeq` only bumps through the registry's commit funnel (0065 Part A) — the invariant this suite
 * exists to pin needs that funnel wired up, exactly like a live game.
 *
 * HERMETICITY (root-caused 2026-07-22, the #1825-engine-lane flake): a "seeded" live game is only
 * trajectory-deterministic if EVERY rng dimension it touches is pinned — the player's `gameSeed`
 * (via `createCharacter({ seed })`) pins CEREMONY beats (`GameSessionAdapter.beatRng`), but
 * `composeRuntime`'s per-turn off-screen tick is seeded PER SANDBOX USER
 * (`Orchestrator.rngFor`: `hashSeed(\`${orchestratorSeed}:${user}\`)`, by design — two different
 * users playing the same game-seed must not get identical off-screen scheming). `startedGame` below
 * previously minted a RANDOM username per call (`Math.random()`), so the off-screen society (which
 * folds into relationship/emotional state, which weighs INTO competition outcomes) drew a DIFFERENT
 * stream every run — occasionally shifting week 2's HOH winner and, downstream, whether the PLAYER
 * ever won HOH within the drive at all ("game finished before reaching a nominations pending",
 * intermittent, seed-independent — confirmed via a bare Node loop with no vitest involved, and
 * confirmed NOT caused by cross-test state: it reproduced with every OTHER test in this file
 * `.skip`'d). Every sandbox user string below is now a FIXED constant — never mint one from
 * `Math.random()`/`Date.now()`/anything non-deterministic in a trajectory-sensitive test.
 *
 * HARD rule: roles only — no fixture names asserted.
 */

/** Resolve a pending decision LEGALLY, whatever kind it is (a generic driver, no strategy asserted).
 *  Returns the `submitDecision` result so a caller can inspect what the SAME call also did. */
function resolveLegally(s: GameSessionAdapter, p: PendingDecisionView): AdvanceView {
  if (p.kind === "nominations") return s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  if (p.kind === "veto-decision") return s.submitDecision({ kind: "veto-decision", use: false });
  if (p.kind === "replacement") return s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  if (p.kind === "comp-intent" || p.kind === "comp-round") return s.submitDecision({ kind: p.kind, intent: "compete" });
  if (p.kind === "finale-statement") return s.submitDecision({ kind: "finale-statement", statement: "x" });
  if (p.kind === "finale-answer") return s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  if (p.kind === "juror-vote") return s.submitDecision({ kind: "juror-vote", vote: p.options[0]!.id });
  return s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}

// Default flip 2026-11-03: with the in-game clock ON the single auto-advanced step after `nominations` is the
// day-break beat, not the chip draw this suite pins. Pin the clock OFF for this file (the clock-on path is
// covered by the timeOfDay suites).
const clockOff = (): void => GameSessionAdapterImpl.setTimeOfDayEnabled(false);
afterEach(() => GameSessionAdapterImpl.setTimeOfDayEnabled(null));

/** The T0-2 auto-advance-eligible pending kinds (mirrors `AUTO_ADVANCE_PENDING_KINDS` in
 *  `GameSessionAdapter.ts` — kept as a literal set here so this suite fails loudly, not silently,
 *  if the two ever drift). */
const AUTO_ADVANCE_KINDS = new Set<PendingDecisionView["kind"]>([
  "nominations", "veto-decision", "comp-intent", "comp-round", "houseguests-choice",
  "replacement", "eviction-vote", "tie-break", "final-eviction",
]);

/** Drive a live game (via plain `advanceGame`, resolving every OTHER pending generically) until a
 *  pending of exactly `kind` appears for the player, or the season finishes. */
function driveToPendingKind(
  s: GameSessionAdapter, kind: PendingDecisionView["kind"], maxIterations = 1000,
): NonNullable<AdvanceView["pending"]> {
  let view: AdvanceView = s.advanceGame();
  for (let i = 0; i < maxIterations; i++) {
    if (view.pending?.kind === kind) return view.pending;
    if (view.finished) throw new Error(`game finished before reaching a '${kind}' pending`);
    if (view.pending) resolveLegally(s, view.pending);
    view = s.advanceGame();
  }
  throw new Error(`never reached a '${kind}' pending within ${maxIterations} iterations`);
}

/**
 * A fresh started game over a real (in-memory-store) runtime, so `beatSeq` bumps through the
 * registry's commit funnel exactly like production. Each call composes a BRAND NEW `composeRuntime`
 * (its own `GameSessionRegistry`/`Orchestrator` instance, own `Map`s) — so there is zero collision
 * risk in reusing the SAME fixed username across calls/tests; a fixed string is required for the
 * off-screen-tick rng to be reproducible (see the file-level hermeticity note above), not merely
 * convenient. Never derive `user` from `Math.random()`/`Date.now()`/anything non-deterministic.
 */
function startedGame(seed: number) {
  const runtime = composeRuntime({ clock: new FakeClock() }); // no saveStore ⇒ in-memory only
  const user = `t0-2-${seed}`;
  const session = runtime.registry.sandboxFor(user).session;
  session.createCharacter({ playerName: "P", seed });
  return { runtime, user, session };
}

describe("T0-2 — resolving a CLOSED-SET ceremony pending auto-advances in ONE commit", () => {
  it("nominations: the veto field is already drawn immediately after submitDecision — no follow-up advanceGame needed", () => {
    // Seed 81005 (re-selected 2026-11-03: #1965 made the replaced fold trust-gated, then the default flip moved the clock ON; was 81003): the player reaches HOH within the drive.
    clockOff();
    const { session } = startedGame(81005);
    const pending = driveToPendingKind(session, "nominations");

    // Before the fix, resolving `nominations` left the loop sitting at "veto-competition, nothing
    // drawn yet" until a SEPARATE advanceGame() call ran the chip draw.
    expect(session.gameStatus().veto.players.length).toBe(0);
    const beatSeqBefore = session.gameStatus().beatSeq;

    const r1 = session.submitDecision({ kind: "nominations", choice: [pending.options[0]!.id, pending.options[1]!.id] });

    // The returned event is unchanged (still the nominations' OWN resolution) — the auto-advance
    // does not alter the existing single-event response contract.
    expect(r1.event?.beat).toBe("nominations");

    // THE PROOF: without a second call, the veto field is ALREADY drawn — the chip-draw ceremony
    // that used to require its own advanceGame() call already happened, inside the SAME commit.
    expect(session.gameStatus().veto.players.length).toBeGreaterThan(0);
    expect(r1.status.veto.players.length).toBeGreaterThan(0);

    // One committed transaction, one beatSeq bump — even though TWO beats (nominations + the veto
    // draw) resolved and were folded (0065 Part A: "bumped once per committed mutation").
    expect(r1.beatSeq).toBe(beatSeqBefore + 1);

    // A follow-up advanceGame() call is now a genuine settle/no-op for whatever the auto-advance
    // already produced: either a fresh pending was ALSO raised as part of the draw (Houseguest's
    // Choice) — in which case the follow-up call changes nothing further — or none was, in which
    // case the very next natural step (the staged veto comp) is what a plain call would have done
    // regardless (T0-2 only guarantees ONE extra step, not the whole chain).
    const r2 = session.advanceGame();
    if (r1.pending) {
      expect(r2.event).toBeNull();
      expect(r2.beatSeq).toBe(r1.beatSeq);
      expect(r2.pending?.kind).toBe(r1.pending.kind);
    } else {
      expect(r2.beatSeq).toBeGreaterThan(r1.beatSeq);
    }
  });

  it("veto-decision (unused): the eviction beat is already entered immediately after submitDecision", () => {
    const { session } = startedGame(81000);
    driveToPendingKind(session, "veto-decision");
    const beatSeqBefore = session.gameStatus().beatSeq;

    const r1 = session.submitDecision({ kind: "veto-decision", use: false });
    expect(r1.event?.beat).toBe("veto-ceremony");

    // One transaction, one beatSeq bump for the whole chain (veto-ceremony resolution + the follow-up
    // step into the eviction beat), same invariant as the nominations case above.
    expect(r1.beatSeq).toBe(beatSeqBefore + 1);

    // THE PROOF: the loop already moved past "veto-ceremony resolved, nothing else happened" — a
    // fresh pending (eviction-vote / tie-break) OR a real eviction-reveal event already landed, in
    // the SAME submitDecision call, without a follow-up advanceGame().
    const movedAlready = r1.pending !== null || r1.status.phase !== "veto-ceremony";
    expect(movedAlready).toBe(true);
  });

  it("does not remove the L39b/forced-tool_choice belts — they stay declared in the FE undercall inventory doc", () => {
    // T9 (owner resiliency ruling): T0-2 is an engine-side structural fix; it does not delete any FE
    // belt. This is a documentation/pointer check only (engine-side gate — the belts themselves live
    // in `frontend/`, out of this suite's reach).
    const doc = readFileSync(join(__dirname, "../../docs/design/undercall-seam-structural.md"), "utf8");
    expect(doc).toContain("L39b forced");
    expect(doc).toContain("T0-2");
  });

  it("the veto ceremony resolves 'does not use the veto' and replays byte-identically from the same seed", () => {
    const { session } = startedGame(81000);
    const pending = driveToPendingKind(session, "veto-decision");

    // Resolve the veto-decision with `use: false` (the standard path that produces
    // "does not use the veto").
    const r1 = resolveLegally(session, pending);
    expect(r1.event?.beat).toBe("veto-ceremony");
    expect(r1.event?.content).toContain("does not use the veto");

    // Run the game TWICE with the SAME deterministic seed and assert byte-identical
    // final game status.
    const runWithSeed = (seed: number) => {
      const { session: s2 } = startedGame(seed);
      const p2 = driveToPendingKind(s2, "veto-decision");
      resolveLegally(s2, p2);
      return s2.gameStatus();
    };
    const status1 = runWithSeed(81000);
    const status2 = runWithSeed(81000);
    expect(status1).toEqual(status2);
  });
});

describe("T0-2 — the EXCLUDED pending kinds keep their CURRENT (non-auto-advancing) semantics", () => {
  it("goodbye-message: resolving the player's own goodbye does NOT auto-advance (a follow-up advanceGame is still required)", () => {
    const { session } = startedGame(81000);
    const pending = driveToPendingKind(session, "goodbye-message");
    const beatSeqBefore = session.gameStatus().beatSeq;

    const r1 = session.submitDecision({ kind: "goodbye-message", vote: pending.options[0]!.id });
    expect(r1.event?.beat).toBe("eviction-goodbye");
    // Resolving the goodbye is still exactly ONE commit on its own...
    expect(r1.beatSeq).toBe(beatSeqBefore + 1);

    // ...but UNLIKE the auto-advance-eligible kinds above, nothing further happened automatically:
    // the eviction reveal's next step (more goodbyes, the exit interview, or the result) STILL
    // requires its own separate advanceGame() call, which does REAL further work (a strictly later
    // beatSeq) — proving the goodbye-message resolution itself did not chain forward.
    const r2 = session.advanceGame();
    expect(r2.beatSeq).toBeGreaterThan(r1.beatSeq);
  });
});

describe("T0-2 — the chained auto-advance still floats the 0123 NPC deal offer, and never blocks on it", () => {
  it("a deal due at the post-resolution lull is floated on the chained path, and the beat still advances (PO ruling 2026-11-01)", () => {
    // #1824: `maybeOfferPlayerDeal()` is folded INTO `advanceOneBeat()` so the chained submitDecision path
    // honors the same lull gate as a plain advanceGame call (the offer opportunity is never skipped).
    // PO ruling 2026-11-01: a floated offer is open state the narrator voices — it NEVER blocks the week,
    // so the chained step still draws its beat in the same single commit.
    // Seed 2 (re-selected 2026-11-04: the one-turn eviction reveal shortened the trajectory; 2,10,24,25 qualify under the ORW-116 clock-from-entry flow): an offer floats on a chained call.
    const { session } = startedGame(2);
    session.setNpcDealOffersEnabled(true);

    let view: AdvanceView = session.advanceGame();
    let caught: AdvanceView | null = null;
    let beforeSeq = -1;
    for (let i = 0; i < 1500 && !view.finished && !caught; i++) {
      if (view.pending && AUTO_ADVANCE_KINDS.has(view.pending.kind)) {
        const hadOffer = !!session.getGameState().openDealOffer;
        beforeSeq = session.gameStatus().beatSeq;
        const result = resolveLegally(session, view.pending);
        if (!hadOffer && session.getGameState().openDealOffer) { caught = result; break; }
        view = result;
        continue;
      }
      if (view.pending) resolveLegally(session, view.pending);
      view = session.advanceGame();
    }

    expect(caught, "seed 2 should float a deal offer on a chained submitDecision call").not.toBeNull();
    const offer = session.getGameState().openDealOffer!;
    expect(offer.from.id).not.toBe("player");
    expect(["safety", "final-two"]).toContain(offer.kind);
    // One commit, exactly like every other T0-2 auto-advance (the offer adds no extra transaction)...
    expect(caught!.beatSeq).toBe(beforeSeq + 1);
    // ...never a pending card...
    expect(caught!.pending?.kind).not.toBe("deal-offer");
    // ...and the game is NOT frozen: a follow-up advance still moves it while the offer stands.
    const r2 = session.advanceGame();
    if (r2.pending) resolveLegally(session, r2.pending);
    expect(session.gameStatus().beatSeq).toBeGreaterThan(caught!.beatSeq);
  });
});

describe("T0-2 — a failed persist rolls back BOTH the pending's resolution and its auto-advance", () => {
  class FlakyStore implements UserSaveStore {
    failing = false;
    private readonly saves = new Map<string, string>();
    saveFor(user: string, snapshot: SessionSnapshot): void {
      if (this.failing) throw new Error("ENOSPC: no space left on device");
      this.saves.set(user, JSON.stringify(snapshot));
    }
    hasSave(user: string): boolean { return this.saves.has(user); }
    loadLatest(user: string): SessionSnapshot | null {
      const blob = this.saves.get(user);
      return blob === undefined ? null : (JSON.parse(blob) as SessionSnapshot);
    }
  }

  const deepCapture = (snap: SessionSnapshot): SessionSnapshot =>
    JSON.parse(JSON.stringify(snap)) as SessionSnapshot;

  it("a disk failure during submitDecision(nominations) leaves NEITHER the nominations NOR the auto-advanced veto draw committed", () => {
    clockOff();
    const store = new FlakyStore();
    const runtime = composeRuntime({ saveStore: store, clock: new FakeClock() });
    const user = "t0-2-fault";
    runtime.registry.sandboxFor(user).session.createCharacter({ playerName: "P", seed: 81005 }); // re-selected 2026-11-03, default flip (was 81003)

    const pending = driveToPendingKind(runtime.registry.sandboxFor(user).session, "nominations");
    expect(runtime.registry.sandboxFor(user).session.gameStatus().veto.players.length).toBe(0);

    // The full pre-attempt baseline — both in-memory and durable — is what a refused commit must
    // restore EXACTLY (E3/E7: fail-closed, never a half-applied chain). A rolled-back commit REPLACES
    // the sandbox object (`registry.restore`), so every read after the throw must re-fetch
    // `sandboxFor(user)` fresh rather than reuse a pre-attempt reference (the existing #1106 tests'
    // own convention).
    const goodMemory = deepCapture(runtime.registry.snapshot(user));
    const goodDurable = store.loadLatest(user)!;

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      store.failing = true;
      expect(() =>
        runtime.registry.sandboxFor(user).session.submitDecision({
          kind: "nominations", choice: [pending.options[0]!.id, pending.options[1]!.id],
        }),
      ).toThrowError(PersistFailureError);

      // Neither half of the chained transaction survives: no nominees recorded, no veto field drawn —
      // the WHOLE in-memory sandbox rolled back to the pre-attempt baseline, and the durable save
      // (which never received the failed write) is untouched.
      expect(runtime.registry.sandboxFor(user).session.gameStatus().nominees.length).toBe(0);
      expect(runtime.registry.sandboxFor(user).session.gameStatus().veto.players.length).toBe(0);
      expect(deepCapture(runtime.registry.snapshot(user))).toEqual(goodMemory);
      expect(store.loadLatest(user)!).toEqual(goodDurable);

      // The disk recovers ⇒ the SAME decision now commits cleanly, chaining exactly as tested above.
      store.failing = false;
      const recovered = runtime.registry.sandboxFor(user).session.submitDecision({
        kind: "nominations", choice: [pending.options[0]!.id, pending.options[1]!.id],
      });
      expect(recovered.event?.beat).toBe("nominations");
      expect(runtime.registry.sandboxFor(user).session.gameStatus().veto.players.length).toBeGreaterThan(0);
    } finally {
      errSpy.mockRestore();
    }
  });
});
