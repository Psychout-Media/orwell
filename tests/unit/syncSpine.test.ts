import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { createHttpMcpServer } from "../../src/adapters/mcp/HttpMcpServer";
import { GameSessionRegistry } from "../../src/composition/registry";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { UserSandbox } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView } from "../../src/ports/GameSession";
import { StaleBeatError } from "../../src/domain/errors";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * Feature 0065 Parts A + B — the versioned, at-most-once write path. `beatSeq` is the monotonic
 * compare-and-swap token; `expectedBeatSeq` refuses a write computed against a superseded board
 * (stale-beat / 409); `idempotencyKey` makes a retried progression at-most-once. Absent fields ⇒
 * byte-identical to the pre-0065 path. HARD rule: roles only — no names.
 */
const freshDir = (): string => mkdtempSync(join(tmpdir(), "orwell-0065-"));

/** A turn-driven runtime over a fresh save dir with a started game (its first commit baselines). */
function startedRuntime(seed = 2): { reg: GameSessionRegistry; sb: UserSandbox; session: GameSessionAdapter; dir: string } {
  const dir = freshDir();
  const runtime = composeRuntime({ saveStore: new FileSaveStore(dir), clock: new FakeClock() });
  const sb = runtime.registry.sandboxFor("u");
  sb.session.createCharacter({ playerName: "P", seed });
  sb.session.setNpcDealConsentEnabled(false); // these tests exercise deal MECHANICS, not NPC consent (dealConsent*.test.ts cover that)
  return { reg: runtime.registry, sb, session: sb.session, dir };
}

/** Resolve a pending decision LEGALLY (roles only); optional sync-spine fields ride along. */
function resolveLegally(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>, extra: { expectedBeatSeq?: number; idempotencyKey?: string } = {}): AdvanceView {
  if (p.kind === "nominations") return s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id], ...extra });
  if (p.kind === "veto-decision") return s.submitDecision({ kind: "veto-decision", use: false, ...extra });
  if (p.kind === "replacement") return s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id, ...extra });
  if (p.kind === "comp-intent" || p.kind === "comp-round") return s.submitDecision({ kind: p.kind, intent: "compete", ...extra });
  if (p.kind === "finale-statement") return s.submitDecision({ kind: "finale-statement", statement: "x", ...extra });
  if (p.kind === "finale-answer") return s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]!, ...extra });
  if (p.kind === "juror-vote") return s.submitDecision({ kind: "juror-vote", vote: p.options[0]!.id, ...extra });
  return s.submitDecision({ kind: p.kind, vote: p.options[0]!.id, ...extra });
}

/** Drive the loop until it blocks on a player decision (or finishes). Returns the latest view. */
function driveToPending(s: GameSessionAdapter): AdvanceView {
  let adv = s.advanceGame();
  for (let i = 0; i < 50 && !adv.pending && !adv.finished; i++) adv = s.advanceGame();
  return adv;
}

describe("0065 Part A — beatSeq is a monotonic per-sandbox commit counter", () => {
  it("increments by EXACTLY one per committed state mutation", () => {
    const { sb, session } = startedRuntime();
    // A started game already committed (createCharacter) → the counter advanced off zero.
    expect(session.getGameState().beatSeq).toBeGreaterThan(0);

    // Each single committed mutation bumps the counter by exactly one (a recorded scene, a deal,
    // a Diary-Room entry are each ONE commit through the single funnel).
    const a = session.gameStatus().beatSeq;
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "chat A" });
    expect(session.gameStatus().beatSeq).toBe(a + 1);
    sb.session.makeDeal({ with: npc(1), kind: "safety", terms: "t" });
    expect(session.gameStatus().beatSeq).toBe(a + 2);
    sb.commands.diaryRoom({ entry: "my plan" });
    expect(session.gameStatus().beatSeq).toBe(a + 3);
  });

  it("is stable across a no-op advance (a repeat advance while a decision is pending)", () => {
    const { session } = startedRuntime();
    const adv = driveToPending(session);
    expect(adv.pending).toBeTruthy();
    // Settle: keep advancing until the counter stops moving while still blocked on the decision.
    let settled = session.gameStatus().beatSeq;
    for (let i = 0; i < 5; i++) {
      const a = session.advanceGame();
      if (a.beatSeq === settled) break;
      settled = a.beatSeq;
    }
    // Now an advance is a pure no-op (the loop is blocked on the player) — the counter does not move.
    expect(session.advanceGame().beatSeq).toBe(settled);
    expect(session.advanceGame().beatSeq).toBe(settled);
  });

  it("survives a snapshot round-trip (restart-safe, co-versioned with the save)", () => {
    const { reg, session, dir } = startedRuntime();
    session.makeDeal({ with: npc(1), kind: "safety", terms: "t" }); // a committed mutation
    const before = session.gameStatus().beatSeq;
    expect(before).toBeGreaterThan(0);
    reg.saveUser("u");

    // A fresh registry over the same dir (process restart) resumes the counter at the saved value.
    const resumed = new GameSessionRegistry(new FileSaveStore(dir)).sandboxFor("u").session;
    expect(resumed.getGameState().beatSeq).toBe(before);
  });
});

describe("0065 Part A — compare-and-swap stale-write rejection", () => {
  it("a stale expectedBeatSeq refuses with stale-beat and changes NO state", () => {
    const { sb, session } = startedRuntime();
    const current = session.gameStatus().beatSeq;
    const eventsBefore = sb.engine.events.count();

    let thrown: unknown;
    try {
      session.makeDeal({ with: npc(1), kind: "safety", terms: "t", expectedBeatSeq: current - 1 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(StaleBeatError);
    expect((thrown as StaleBeatError).code).toBe("stale-beat");
    expect((thrown as StaleBeatError).beatSeq).toBe(current); // carries the CURRENT counter
    expect((thrown as StaleBeatError).board).toBeTruthy(); // carries the Vault-free board

    // No state change: the counter did not move and nothing was recorded.
    expect(session.gameStatus().beatSeq).toBe(current);
    expect(sb.engine.events.count()).toBe(eventsBefore);
  });

  it("the CURRENT expectedBeatSeq is honored (the write goes through)", () => {
    const { session } = startedRuntime();
    const current = session.gameStatus().beatSeq;
    const deal = session.makeDeal({ with: npc(1), kind: "safety", terms: "t", expectedBeatSeq: current });
    expect(deal).toBeTruthy();
    expect(session.gameStatus().beatSeq).toBe(current + 1); // a committed mutation
  });

  it("an ABSENT expectedBeatSeq is byte-identical to the pre-0065 path (regression guard)", () => {
    // Two same-seed runtimes; one drives WITH no sync fields (today's path). The views — minus the
    // always-present beatSeq scalar — match beat-for-beat, and the counter is deterministic too.
    const a = startedRuntime(7);
    const b = startedRuntime(7);
    let advA = a.session.advanceGame();
    let advB = b.session.advanceGame();
    for (let i = 0; i < 16; i++) {
      const stripA = { ...advA, beatSeq: 0 };
      const stripB = { ...advB, beatSeq: 0 };
      expect(stripA).toEqual(stripB);
      expect(advA.beatSeq).toBe(advB.beatSeq);
      if (advA.finished || advB.finished) break;
      advA = advA.pending ? resolveLegally(a.session, advA.pending) : a.session.advanceGame();
      advB = advB.pending ? resolveLegally(b.session, advB.pending) : b.session.advanceGame();
    }
  });

  it("a two-writer race (the 0064 queued-turn shape) refuses the stale second write", () => {
    const { session } = startedRuntime();
    // Two writers read the SAME board. Writer 1 commits first; writer 2 was computed against the
    // now-stale board — its expectedBeatSeq no longer matches, so it is refused, not applied.
    const seen = session.gameStatus().beatSeq;
    const first = session.makeDeal({ with: npc(1), kind: "safety", terms: "1", expectedBeatSeq: seen });
    expect(first).toBeTruthy();
    const moved = session.gameStatus().beatSeq;
    expect(moved).toBe(seen + 1);
    expect(() => session.makeDeal({ with: npc(2), kind: "safety", terms: "2", expectedBeatSeq: seen })).toThrow(StaleBeatError);
    expect(session.gameStatus().beatSeq).toBe(moved); // unchanged by the refused write
  });

  it("recordInteraction + advanceGame both enforce the CAS against the session's counter", () => {
    const { sb, session } = startedRuntime();
    const current = session.gameStatus().beatSeq;
    const eventsBefore = sb.engine.events.count();
    expect(() =>
      sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "chat", expectedBeatSeq: current - 1 }),
    ).toThrow(StaleBeatError);
    expect(sb.engine.events.count()).toBe(eventsBefore); // refused before the mutation — nothing recorded
    expect(() => session.advanceGame({ expectedBeatSeq: current - 1 })).toThrow(StaleBeatError);
    // The CURRENT token is accepted on the command port.
    const ok = sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "chat", expectedBeatSeq: session.gameStatus().beatSeq });
    expect(ok.eventId).toBeTruthy();
  });

  // BE-5 — `recordImageBeat` is the one FE-driven write-back on this port that had NO expectedBeatSeq
  // guard at all (unlike recordInteraction/surfaceInformationTo/advanceGame/submitDecision above), so a
  // stale image-shown beat could commit against a superseded board with no 409 to reconcile against.
  it("recordImageBeat enforces the SAME CAS guard as every other mutating command (BE-5)", () => {
    const { sb, session } = startedRuntime();
    const current = session.gameStatus().beatSeq;
    const eventsBefore = sb.engine.events.count();
    expect(() =>
      sb.commands.recordImageBeat({ houseguestId: npc(1), imageRef: "img-1", expectedBeatSeq: current - 1 }),
    ).toThrow(StaleBeatError);
    expect(sb.engine.events.count()).toBe(eventsBefore); // refused before the mutation — nothing recorded
    // The CURRENT token is accepted on the command port.
    const ok = sb.commands.recordImageBeat({ houseguestId: npc(1), imageRef: "img-1", expectedBeatSeq: session.gameStatus().beatSeq });
    expect(ok.eventId).toBeTruthy();
    expect(sb.engine.events.count()).toBe(eventsBefore + 1);
  });

  it("recordImageBeat with an ABSENT expectedBeatSeq is unchanged (byte-identical to the pre-BE-5 path)", () => {
    const { sb, session } = startedRuntime();
    const before = session.gameStatus().beatSeq;
    const eventsBefore = sb.engine.events.count();
    const ok = sb.commands.recordImageBeat({ houseguestId: npc(1), imageRef: "img-1" });
    expect(ok.eventId).toBeTruthy();
    expect(sb.engine.events.count()).toBe(eventsBefore + 1);
    expect(session.gameStatus().beatSeq).toBe(before + 1); // still a committed mutation
  });

  // R1c / audit A-S3 / issue #591 — the consequence FOLD (the hidden trust/affinity move that is "the
  // whole point of the game", mandate #4) lands EXACTLY ONCE across a stale-409 → reconcile → re-attempt.
  // The event-count guard above proves nothing was RECORDED on a stale write; this is the stronger claim
  // the FE's reconcile-and-re-attempt (`_backfill_with_cas`, frontend/src/agent_loop.py) relies on: a
  // stale `recordInteraction` folds ZERO impact (so a re-attempt cannot LOSE the scene's only fold — the
  // bug), and because the engine throws `StaleBeatError` BEFORE any mutation the re-attempt against the
  // FRESH beatSeq folds the SAME impact exactly once (it can never DOUBLE-apply — there was no first
  // apply to race). This is the engine-side idempotency assertion the FE retry leans on; recordInteraction
  // needs no idempotencyKey precisely because the CAS guard makes the stale path a pure no-op.
  it("a stale recordInteraction folds NOTHING; the re-attempt at the fresh beatSeq folds exactly once (#591)", () => {
    // Control: a single clean fold of the SAME scene on a sibling sandbox (same seed ⇒ same rng path),
    // so we can assert the stale→retry sequence moves the edge to the IDENTICAL place (once, not twice).
    const control = startedRuntime();
    const cSeq = control.session.gameStatus().beatSeq;
    control.sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a bond", kind: "bonding", expectedBeatSeq: cSeq });
    const expectedEdge = { ...control.sb.engine.relationships.edge(npc(1), PLAYER) }; // the partner's edge toward the initiator

    const { sb, session } = startedRuntime();
    const before = { ...sb.engine.relationships.edge(npc(1), PLAYER) };

    // 1. A stale write (the board moved under it) is refused BEFORE folding — the edge is UNCHANGED.
    //    Dropping this scene here (the old reconcile-and-SKIP) would EVAPORATE its only consequence fold.
    const seen = session.gameStatus().beatSeq;
    expect(() =>
      sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a bond", kind: "bonding", expectedBeatSeq: seen - 1 }),
    ).toThrow(StaleBeatError);
    expect(sb.engine.relationships.edge(npc(1), PLAYER)).toEqual(before); // no fold on the stale path

    // 2. Reconcile to the fresh beatSeq and RE-ATTEMPT the SAME scene — the fold lands now (not lost).
    const fresh = session.gameStatus().beatSeq;
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a bond", kind: "bonding", expectedBeatSeq: fresh });
    const after = sb.engine.relationships.edge(npc(1), PLAYER);

    // The edge MOVED (the fold landed, mandate #4 — it did NOT evaporate)…
    expect(after.affinity).toBeGreaterThan(before.affinity);
    expect(after.trust).toBeGreaterThan(before.trust);
    // …and it landed EXACTLY ONCE: identical to the single clean control fold, never double-applied.
    expect(after).toEqual(expectedEdge);
  });
});

describe("0065 Part B — idempotency keys on progression tools", () => {
  it("the same submitDecision key twice ⇒ resolved ONCE and an identical view", () => {
    const { session } = startedRuntime();
    const adv = driveToPending(session);
    expect(adv.pending).toBeTruthy();
    const after = resolveLegally(session, adv.pending!, { idempotencyKey: "decide-1" });
    const seq = session.gameStatus().beatSeq;
    const replay = resolveLegally(session, adv.pending!, { idempotencyKey: "decide-1" }); // a retry
    expect(replay).toEqual(after); // verbatim, including its beatSeq
    expect(session.gameStatus().beatSeq).toBe(seq); // the decision resolved exactly once
  });

  it("different keys ⇒ two distinct advances (no caching across keys)", () => {
    const { session } = startedRuntime();
    // Two distinct decisions get two distinct keys → two real resolutions; counts as a plain drive.
    let adv = driveToPending(session);
    const seqAtFirst = session.gameStatus().beatSeq;
    adv = resolveLegally(session, adv.pending!, { idempotencyKey: "k-1" });
    adv = driveToPending(session);
    if (adv.pending) resolveLegally(session, adv.pending, { idempotencyKey: "k-2" });
    expect(session.gameStatus().beatSeq).toBeGreaterThan(seqAtFirst); // distinct keys advanced again
  });

  it("an absent key ⇒ unchanged behavior (a real resolution moves the board)", () => {
    const { session } = startedRuntime();
    const adv = driveToPending(session);
    const before = session.gameStatus().beatSeq;
    resolveLegally(session, adv.pending!); // no key — the pre-0065 path
    expect(session.gameStatus().beatSeq).toBeGreaterThan(before); // the decision committed
  });

  it("PERSIST-9 — the idempotency cache SURVIVES a snapshot restore (a retry across a restart/LRU-unload does not re-apply)", () => {
    const { reg, session, dir } = startedRuntime();
    const adv = driveToPending(session);
    expect(adv.pending).toBeTruthy();
    const after = resolveLegally(session, adv.pending!, { idempotencyKey: "restart-key" });
    const seq = session.gameStatus().beatSeq;
    reg.saveUser("u");

    // A fresh registry over the same dir (a process restart / the routine LRU unload-then-resume that
    // ALSO runs restore()). Before PERSIST-9 the cache was cleared here, so the retry below re-applied.
    const resumed = new GameSessionRegistry(new FileSaveStore(dir)).sandboxFor("u").session;
    const replay = resumed.submitDecision({ kind: adv.pending!.kind, ...(adv.pending!.kind === "nominations"
      ? { choice: [adv.pending!.options[0]!.id, adv.pending!.options[1]!.id] }
      : adv.pending!.kind === "veto-decision" ? { use: false }
      : adv.pending!.kind === "comp-intent" || adv.pending!.kind === "comp-round" ? { intent: "compete" as const }
      : { vote: adv.pending!.options[0]!.id }), idempotencyKey: "restart-key" });
    expect(replay).toEqual(after);                       // verbatim replay from the restored cache
    expect(resumed.gameStatus().beatSeq).toBe(seq);      // the decision did NOT re-apply across the restart
  });

  it("a replayed advanceGame key WINS even if beatSeq has since moved (the cache is the authority)", () => {
    const { session } = startedRuntime();
    const first = session.advanceGame({ idempotencyKey: "k" });
    // Move the board on with unrelated committed mutations.
    session.makeDeal({ with: npc(1), kind: "safety", terms: "t" });
    session.makeDeal({ with: npc(2), kind: "safety", terms: "t" });
    expect(session.gameStatus().beatSeq).toBeGreaterThan(first.beatSeq);
    const replay = session.advanceGame({ idempotencyKey: "k" }); // returns the ORIGINAL view verbatim
    expect(replay).toEqual(first);
    expect(replay.beatSeq).toBe(first.beatSeq);
  });

  // BL-003 (2026-07-16 full playtest audit) — the engine-side contract the FE's `retry_progression_after_stale`
  // (do_advance_game) depends on: the mechanical root cause of the audit was an un-retried `advanceGame`
  // `StaleBeatError` that let the engine FREEZE at premiere while narration ran a fabricated HOH/removal arc
  // on top of it. The FE fix reconciles + re-fires ONCE against the fresh beatSeq with the SAME idempotency
  // key; that is only safe because the engine (a) throws the stale conflict BEFORE caching the key (so the
  // retry genuinely advances, never short-circuits to a stale cached view) and (b) then dedups a further
  // replay of the key (at-most-once, so the bounded retry can never double-advance). This pins BOTH halves.
  it("BL-003 — a STALE advanceGame throws WITHOUT caching the key, so the reconciled retry advances EXACTLY once", () => {
    const { sb, session } = startedRuntime();
    const seen = session.gameStatus().beatSeq;           // the beatSeq the FE last saw / computed against
    // A belt commit (the 0055/0065 back-fill) lands between the model's read and its advanceGame — the exact
    // stale-beat trigger. beatSeq moves by one; the model's `seen` token is now stale.
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a belt", kind: "bonding", expectedBeatSeq: seen });
    const moved = session.gameStatus().beatSeq;
    expect(moved).toBe(seen + 1);

    const KEY = "advance-after-stale";
    // (1) The model-driven advanceGame fires against the STALE token + a key. The engine refuses BEFORE any
    //     mutation AND before caching the key (`guardBeatSeq` throws on the cache MISS) — the beat does NOT
    //     advance and the key is NOT poisoned with a stale/no-op view.
    expect(() => session.advanceGame({ expectedBeatSeq: seen, idempotencyKey: KEY })).toThrow(StaleBeatError);
    expect(session.gameStatus().beatSeq).toBe(moved);     // stale throw changed NO state (fail-closed)

    // (2) The FE reconciles to the fresh beatSeq and RE-FIRES the SAME key. Because the stale throw cached
    //     nothing, this genuinely ADVANCES — it is NOT short-circuited to a cached stale view. This is the
    //     difference between the engine advancing and the BL-003 freeze. (Issue #1725/C1: the returned VIEW's
    //     `beatSeq` now MATCHES the live `gameStatus()` counter — see the "carries the FINAL post-commit
    //     beatSeq" describe block below — so the FE can trust the response directly, no extra read required.)
    const applied = session.advanceGame({ expectedBeatSeq: moved, idempotencyKey: KEY });
    const liveAfterRetry = session.gameStatus().beatSeq;
    expect(liveAfterRetry).toBeGreaterThan(moved);        // the advance really committed against the fresh board
    expect(applied.beatSeq).toBe(liveAfterRetry);         // #1725 — the response already carries the fresh value

    // (3) A FURTHER replay of the SAME key (a flaky-socket double-send, or the FE's own belt-and-suspenders)
    //     returns the applied view verbatim WITHOUT advancing again — 0065 Part B at-most-once. The bounded
    //     reconcile-and-retry can never double-progress the season.
    const replay = session.advanceGame({ idempotencyKey: KEY });
    expect(replay).toEqual(applied);
    expect(session.gameStatus().beatSeq).toBe(liveAfterRetry);  // no second advance
  });
});

// Issue #1725 (C1, 2026-07-20 reconciliation forensics audit) — a player turn commits the player's own
// mutation AND (on a progressed beat) a supplementary off-screen tick in the SAME synchronous commit
// (`onPersist` drives the registry's commit funnel → the orchestrator's turn-driven tick). Root cause,
// traced end-to-end: `inOneCommit` built the RETURNED view (reading `this.beatSeq` via `advanceView`)
// BEFORE its own deferred `onPersist()` call — so every mutating response reported the PRE-commit-funnel
// counter, stale by the ONE bump the mutation itself just earned (empirically: never more than one, since
// the tick never routes through the commit funnel — see `integrityBreaker.test.ts` — but the response was
// ALWAYS wrong by exactly that one). The FE caches the response's `beatSeq` as its next compare-and-swap
// token, so its own very next mutation-first call self-409'd — zero concurrency required. Fixed by
// refreshing `out.beatSeq` to the counter's CURRENT value once the deferred commit (inclusive of any
// tick) has actually landed.
describe("0065 / issue #1725 (C1) — a mutating response's beatSeq matches the FULLY-committed counter", () => {
  it("after a turn that runs the supplementary off-screen tick, the response beatSeq equals the live post-tick counter", () => {
    const { session } = startedRuntime();
    // Drive to a resolved beat via `advanceGame` (a progressed beat ALWAYS earns its off-screen tick —
    // `maybeTurnDrivenTick` in `src/composition/orchestrator.ts`).
    let adv = session.advanceGame();
    for (let i = 0; i < 20 && !adv.pending && !adv.event && !adv.finished; i++) adv = session.advanceGame();
    // The response's beatSeq must already equal the fully-committed live counter — not lag by the tick
    // (or by the mutation's own bump, the original off-by-one this issue traces).
    expect(adv.beatSeq).toBe(session.gameStatus().beatSeq);
  });

  it("a mutation-first turn using the PRIOR response's beatSeq as its CAS token no longer self-409s", () => {
    const { session } = startedRuntime();
    // Turn 1: resolve a beat (fires the supplementary tick) and cache its response beatSeq exactly like
    // the FE's `_refresh_beat_seq(user, adv)` would.
    let adv = session.advanceGame();
    for (let i = 0; i < 20 && !adv.pending && !adv.event && !adv.finished; i++) adv = session.advanceGame();
    const feCachedToken = adv.beatSeq;

    // Turn 2: the FE's FIRST engine call is a MUTATION (never a read first) — the exact self-409 shape
    // from the audit (a `moveTo`/`_auto_record_scene` fold-backfill leading a turn). Before the fix this
    // threw StaleBeatError even though nothing else touched the board between the two calls.
    expect(() => session.makeDeal({ with: npc(1), kind: "safety", terms: "t", expectedBeatSeq: feCachedToken })).not.toThrow();
  });

  // The FE's REAL call shape (`docs/CLAUDE_CODE_INSTRUCTIONS.md` / CLAUDE.md's belt-fire notes): every
  // FE-issued progression call attaches a FRESHLY-MINTED `idempotencyKey`. That path routes through
  // `rememberIdempotent`'s PERSIST-9 durability backfill, which — for a genuinely NEW key — fires a
  // SECOND real commit (bumping `beatSeq` again) AFTER `inOneCommit` already built the response. This
  // was a second, independent staleness source beyond the `inOneCommit` ordering bug: `rememberIdempotent`
  // returned the view unchanged, one bump further behind current than the fixed `inOneCommit` value.
  it("an idempotency-keyed advance (the FE's real shape) also reports the FULLY-committed beatSeq, including PERSIST-9's own backfill commit", () => {
    const { session } = startedRuntime();
    let adv = session.advanceGame({ idempotencyKey: "turn-1" });
    for (let i = 0; i < 20 && !adv.pending && !adv.event && !adv.finished; i++) {
      adv = session.advanceGame({ idempotencyKey: `turn-1-${i}` });
    }
    expect(adv.beatSeq).toBe(session.gameStatus().beatSeq);
    // The token this response reports is immediately usable as the next mutation's CAS token.
    expect(() => session.makeDeal({ with: npc(1), kind: "safety", terms: "t", expectedBeatSeq: adv.beatSeq })).not.toThrow();
  });

  it("driving a full sequence of decisions never desyncs the response beatSeq from the live counter", () => {
    // Broader sweep (belt-and-suspenders on the single-assertion tests above): across MANY consecutive
    // committed mutations — including whichever ones resolve a beat and fire the tick — the returned
    // view's beatSeq tracks the live counter exactly, every single time.
    const { session } = startedRuntime(11);
    let adv = session.advanceGame();
    for (let i = 0; i < 60 && !adv.finished; i++) {
      expect(adv.beatSeq).toBe(session.gameStatus().beatSeq);
      if (adv.pending) {
        adv = resolveLegally(session, adv.pending);
      } else {
        adv = session.advanceGame();
      }
    }
  });
});

describe("0065 Part A — the HTTP edge maps stale-beat to 409 with code + beatSeq + board", () => {
  it("a stale expectedBeatSeq over HTTP is 409 { code, beatSeq, board }; current ⇒ 200; malformed ⇒ 400", async () => {
    const runtime = composeRuntime({ saveStore: new FileSaveStore(freshDir()), clock: new FakeClock() });
    const server = createHttpMcpServer({ resolve: runtime.registry.resolver() }, {});
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const user = { "x-orwell-user": "u", "content-type": "application/json" } as Record<string, string>;
    const call = (name: string, args: Record<string, unknown> = {}): Promise<Response> =>
      fetch(`${base}/player/call`, { method: "POST", headers: user, body: JSON.stringify({ name, args }) });
    try {
      await (await call("createCharacter", { playerName: "P", seed: 3 })).json();
      const statusBody = await (await call("gameStatus")).json() as { result: { beatSeq: number } };
      const current = statusBody.result.beatSeq;

      // A stale write ⇒ 409 with the stable machine code + the current counter + the Vault-free board.
      const stale = await call("makeDeal", { with: "npc:1", kind: "safety", terms: "t", expectedBeatSeq: current - 1 });
      expect(stale.status).toBe(409);
      const body = await stale.json() as { code: string; beatSeq: number; board: unknown };
      expect(body.code).toBe("stale-beat");
      expect(body.beatSeq).toBe(current);
      expect(body.board).toBeTruthy();

      // The current token ⇒ 200 (honored).
      const ok = await call("makeDeal", { with: "npc:1", kind: "safety", terms: "t", expectedBeatSeq: current });
      expect(ok.status).toBe(200);

      // A MALFORMED expectedBeatSeq is a deliberate 400 (E31 shape guard), never a 500.
      const bad = await call("advanceGame", { expectedBeatSeq: "nope" });
      expect(bad.status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
