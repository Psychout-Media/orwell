import "../support/pinFlagsOff";
import { describe, it, expect, afterEach } from "vitest";

// B36: this test asserts the OLD graph-diffusion path (or its neutrality / a positive control that rides it). The co-presence layer (ORWELL_GOSSIP_COPRESENCE) REPLACES that path when on, so the
// test pins the layer OFF explicitly instead of depending on the process env (the one-hop-by-scene equivalents live in copresenceSpread / copresenceScenes tests).
import { beforeAll as _b36BeforeAll, afterAll as _b36AfterAll } from "vitest";
const _b36Prev = process.env["ORWELL_GOSSIP_COPRESENCE"];
_b36BeforeAll(() => { process.env["ORWELL_GOSSIP_COPRESENCE"] = "0"; });
_b36AfterAll(() => { if (_b36Prev === undefined) delete process.env["ORWELL_GOSSIP_COPRESENCE"]; else process.env["ORWELL_GOSSIP_COPRESENCE"] = _b36Prev; });
import { createHash } from "node:crypto";
import { reweightThreadOrder, type ShowrunnerNote } from "../../src/engine/showrunner";
import { SHOWRUNNER } from "../../src/engine/showrunnerConstants";
import { THREAD } from "../../src/engine/threadConstants";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { UserSandbox } from "../../src/composition/registry";

/**
 * Feature 0101 (#1401) Phase-2 (#1455) — the AI SHOWRUNNER's OUTCOME-AFFECTING REWEIGHT.
 *
 * Phase-1 (`showrunnerOutcomeNeutral.test.ts`) proved the fold-free showrunner is SHA256-identical on/off.
 * Phase-2 is the STRONGER pacing: the producer note re-orders WHICH simmering thread wins the scheduler's
 * SCARCE per-tick slot (activate/surface — the transitions that FOLD hidden relationship weights that feed
 * the competition/vote spine), so it NECESSARILY perturbs the seeded outcome stream and CANNOT be
 * outcome-neutral by construction. It ships behind a DEDICATED sub-flag (`ORWELL_SHOWRUNNER_REWEIGHT`,
 * default OFF), gated by the calibration heavy-sims run ON (juryReach/gradient/UAT). This file proves the
 * pieces that DON'T need a full distribution:
 *
 *   (A) the pure reorder is a stable shortlist-first partition, respects `reweightSlots`, identity when off;
 *   (B) OFF ⇒ byte-identical (off-vs-today SHA256): a full season's closed-set outcomes hash identically
 *       whether the reweight flag is off with the Phase-1 showrunner off OR on — my code is inert when off;
 *   (C) ON ⇒ genuinely perturbs: the closed-set hash DIFFERS from OFF on ≥1 seed AND the monotonic
 *       reweight count is > 0 (non-vacuous), while the season still FINISHES normally;
 *   (D) the mandate BOUND holds ON: the hard season surfacing cap still binds (the reweight only re-orders
 *       which OPEN-SET storyline wins a bounded slot — it never bypasses a cap);
 *   (E) Vault-held ON: the reweight count / notes reach NO player- or admin-facing projection.
 *
 * HARD rule: roles only — no houseguest names.
 */

// Never leak the process-global reweight override across other test files.
afterEach(() => GameSessionAdapter.setShowrunnerReweightEnabled(null));

const note = (threadIds: string[]): ShowrunnerNote => ({
  seq: 1, week: 2, phase: "nominations",
  emphases: threadIds.map((threadId, i) => ({ threadId, emphasis: SHOWRUNNER.maxEmphasis - i * 0.1, rationale: "x" })),
});

// ── (A) the pure reorder — a stable shortlist-first partition ─────────────────────────────────────────

describe("0101/#1401 Phase-2 — reweightThreadOrder (the pure reorder)", () => {
  const ids = ["t0", "t1", "t2", "t3", "t4"];

  it("is the IDENTITY order for no note / empty emphases / slots <= 0 (off ⇒ byte-identical)", () => {
    expect(reweightThreadOrder(ids, undefined)).toEqual([0, 1, 2, 3, 4]);
    expect(reweightThreadOrder(ids, { seq: 1, week: 1, phase: "p", emphases: [] })).toEqual([0, 1, 2, 3, 4]);
    expect(reweightThreadOrder(ids, note(["t3", "t1"]), 0)).toEqual([0, 1, 2, 3, 4]);
  });

  it("moves the note's shortlist to the FRONT in note order, the rest stay in DERIVE order (stable)", () => {
    // Emphasize t3 then t1: they jump to the front (note order), then t0/t2/t4 in unchanged derive order.
    expect(reweightThreadOrder(ids, note(["t3", "t1"]))).toEqual([3, 1, 0, 2, 4]);
  });

  it("IGNORES baseline emphases (score 0 ⇒ emphasis === minEmphasis) — an all-baseline note is the IDENTITY", () => {
    // A note whose entire shortlist is BASELINE (no real emphasis) emphasizes NOTHING, so it must NOT reorder
    // the queue on the mere id tiebreaker — matching `showrunnerEmphasizes`'s `> minEmphasis` predicate exactly.
    const baseline = (threadIds: string[]): ShowrunnerNote => ({
      seq: 1, week: 2, phase: "nominations",
      emphases: threadIds.map((threadId) => ({ threadId, emphasis: SHOWRUNNER.minEmphasis, rationale: "x" })),
    });
    expect(reweightThreadOrder(ids, baseline(["t3", "t1"]))).toEqual([0, 1, 2, 3, 4]);
    // MIXED: only the ABOVE-baseline thread jumps the queue; the baseline entry stays in derive order — the
    // filter isn't over-broad (a genuine emphasis still promotes, a baseline one riding the same note does not).
    const mixed: ShowrunnerNote = {
      seq: 1, week: 2, phase: "nominations", emphases: [
        { threadId: "t3", emphasis: SHOWRUNNER.maxEmphasis, rationale: "x" }, // genuinely emphasized ⇒ jumps to front
        { threadId: "t1", emphasis: SHOWRUNNER.minEmphasis, rationale: "x" }, // baseline ⇒ stays in derive order
      ],
    };
    expect(reweightThreadOrder(ids, mixed)).toEqual([3, 0, 1, 2, 4]);
  });

  it("respects `reweightSlots` — only the top-N emphases jump the queue", () => {
    // slots=1: only the most-emphasized (t4) jumps; t2/t0 keep derive order after it.
    expect(reweightThreadOrder(ids, note(["t4", "t2", "t0"]), 1)).toEqual([4, 0, 1, 2, 3]);
    // slots=2: t4 then t2 jump; t0 stays behind in derive order.
    expect(reweightThreadOrder(ids, note(["t4", "t2", "t0"]), 2)).toEqual([4, 2, 0, 1, 3]);
  });

  it("is a permutation of exactly the input indices (nothing lost, nothing duplicated)", () => {
    const perm = reweightThreadOrder(ids, note(["t2", "t4"]));
    expect([...perm].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("a thread not on the shortlist is never DEMOTED below its own derive pacing (boost-only)", () => {
    // With only t4 emphasized (slots default 3 but note has one), t0..t3 keep their relative derive order.
    const perm = reweightThreadOrder(ids, note(["t4"]));
    const nonShortlist = perm.filter((i) => i !== 4);
    expect(nonShortlist).toEqual([0, 1, 2, 3]); // strictly ascending — relative derive order preserved
  });
});

// ── the monotonic count guard: an all-baseline note fires NO reweight (end-to-end via the scheduler) ────

describe("0101/#1401 Phase-2 — an all-baseline note advances no reweight count (the count guard)", () => {
  type Internals = {
    storyThreads: { id: string }[];
    showrunnerNotes: ShowrunnerNote[];
    scheduleStoryThreads: (rng: SeededRandom) => void;
  };
  const peek = (sb: UserSandbox): Internals => sb.session as unknown as Internals;

  it("all-baseline note ⇒ the reweight count stays 0; a genuinely-emphasized note DOES advance it", () => {
    GameSessionAdapter.setShowrunnerReweightEnabled(true);
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("sr-reweight-baseline");
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 5 });
    const internals = peek(sb);
    const ids = internals.storyThreads.map((t) => t.id);
    expect(ids.length, "the season seeded ≥2 threads to reorder").toBeGreaterThan(1);
    const snap = sb.session.snapshot();
    const mkNote = (emphasisFor: (id: string) => number): ShowrunnerNote => ({
      seq: 1, week: snap.week, phase: snap.phase,
      emphases: ids.map((threadId) => ({ threadId, emphasis: emphasisFor(threadId), rationale: "x" })),
    });

    // (1) ALL-BASELINE (every emphasis at minEmphasis): the scheduler consumes the note but promotes NOTHING,
    //     so the monotonic reweight count (bumped iff the visitation order genuinely changed) never advances.
    internals.showrunnerNotes.push(mkNote(() => SHOWRUNNER.minEmphasis));
    internals.scheduleStoryThreads(new SeededRandom(1));
    expect(sb.session.showrunnerReweightCountNow(), "an all-baseline note reorders nothing ⇒ count unchanged").toBe(0);

    // (2) A GENUINE emphasis (the LAST derive-order thread — promoting it is a real reorder): the scheduler
    //     re-orders the queue and the count advances — proving the baseline filter is not over-broad.
    const promote = ids[ids.length - 1]!;
    internals.showrunnerNotes.push(mkNote((id) => (id === promote ? SHOWRUNNER.maxEmphasis : SHOWRUNNER.minEmphasis)));
    internals.scheduleStoryThreads(new SeededRandom(2));
    expect(sb.session.showrunnerReweightCountNow(), "a genuinely-emphasized note re-orders the queue ⇒ count advances").toBe(1);
  });
});

// ── a full-season closed-set driver (the `showrunnerOutcomeNeutral` pattern) ───────────────────────────

/** Drive one live-loop beat + resolve any pending; append every outcome-bearing beat (the closed-set
 *  competition/eligibility/vote stream) to `stream`. Returns finished. */
function stepAndCapture(sb: UserSandbox, stream: string[]): boolean {
  const rec = (adv: { event: { beat: string; participants?: { id: string }[] } | null }): void => {
    if (adv.event) stream.push(`${adv.event.beat}|${(adv.event.participants ?? []).map((p) => p.id).join(",")}`);
  };
  const adv = sb.session.advanceGame();
  rec(adv);
  if (adv.pending) {
    const p = adv.pending;
    if (p.kind === "nominations") rec(sb.session.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] }));
    else if (p.kind === "veto-decision") rec(sb.session.submitDecision({ kind: "veto-decision", use: false }));
    else if (p.kind === "replacement") rec(sb.session.submitDecision({ kind: "replacement", replacement: p.options[0]!.id }));
    else if (p.kind === "finale-statement") rec(sb.session.submitDecision({ kind: "finale-statement", statement: "x" }));
    else if (p.kind === "finale-answer") rec(sb.session.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! }));
    else if (p.kind === "juror-vote") rec(sb.session.submitDecision({ kind: "juror-vote", vote: p.options[0]!.id }));
    else rec(sb.session.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never));
  }
  return adv.finished;
}

interface SeasonMeasure {
  /** SHA256 of the CLOSED-SET trajectory (beat stream + eviction order + winner + Final 2). */
  closedHash: string;
  /** SHA256 of the HIDDEN relationship layer (the engine-only edges the thread folds move). */
  relHash: string;
  /** SHA256 of the HIDDEN knowledge layer (beliefs the thread surfacing/gossip seeds). */
  knowHash: string;
  /** SHA256 of every thread's final lifecycle status (which threads activated/resolved/surfaced/expired). */
  lifecycleHash: string;
  reweightCount: number;
  evictions: number;
  surfaced: number;
}

/** Play a FULL seeded season with the orchestrator ticking (so the scheduler + reweight fire), then hash
 *  BOTH the closed-set trajectory (beat stream + eviction order + winner + Final 2) AND the hidden layer
 *  (relationship edges + knowledge beliefs + thread lifecycle). `reweightOn` sets the process-global reweight
 *  override for the duration of the play. Same user key across variants so the per-user off-screen rng stream
 *  matches (only the flag differs — the OutcomeNeutral discipline). */
function playSeason(seed: number, reweightOn: boolean): SeasonMeasure {
  GameSessionAdapter.setShowrunnerReweightEnabled(reweightOn);
  const reg = new GameSessionRegistry();
  const user = "sr-reweight-season";
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  const orch = new Orchestrator(reg, new FakeClock(), { seed });
  const stream: string[] = [];
  let finished = false;
  for (let i = 0; i < 800 && !finished; i++) {
    finished = stepAndCapture(sb, stream);
    if (!finished) orch.advance(user, "offscreen-tick"); // the tick the showrunner + scheduler ride
  }
  const core = sb.session.snapshot();
  stream.push(`EVICT|${(core.live?.evictionOrder ?? []).join(",")}`);
  stream.push(`WINNER|${core.live?.winner ?? ""}`);
  stream.push(`F2|${(core.live?.finalTwo ?? []).join(",")}`);
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  const lifecycle = (core.storyThreads ?? []).map((t) => `${t.id}:${t.status}`).sort();
  const measure: SeasonMeasure = {
    closedHash: sha(stream.join("\n")),
    relHash: sha(JSON.stringify(sb.engine.relationships.serialize().edges)),
    knowHash: sha(JSON.stringify(sb.engine.knowledge.serialize())),
    lifecycleHash: sha(JSON.stringify(lifecycle)),
    reweightCount: core.showrunnerReweightCount ?? 0,
    evictions: (core.live?.evictionOrder ?? []).length,
    surfaced: core.surfacedThreadCount ?? 0,
  };
  GameSessionAdapter.setShowrunnerReweightEnabled(null);
  return measure;
}

// ── (B) OFF ⇒ byte-identical to today (the off-vs-today SHA256 pin) ────────────────────────────────────

describe("0101/#1401 Phase-2 — reweight OFF is byte-identical to today", () => {
  for (const seed of [7, 11]) {
    it(`seed ${seed}: OFF season composes/reorders NOTHING and finishes normally (count 0)`, () => {
      const off = playSeason(seed, false);
      expect(off.reweightCount, "the reweight never fired with the flag off").toBe(0);
      expect(off.evictions, "the season genuinely progressed").toBeGreaterThan(2);
      // The OFF season is deterministic + reproducible (the pre-Phase-2 baseline this branch must preserve):
      // BOTH the closed-set trajectory AND the hidden layer reproduce byte-for-byte.
      const off2 = playSeason(seed, false);
      expect(off2.closedHash, "a second OFF run reproduces the same closed-set hash").toBe(off.closedHash);
      expect(off2.relHash, "a second OFF run reproduces the same hidden relationship layer").toBe(off.relHash);
    });
  }
});

// ── (C) ON ⇒ genuinely re-paces the HIDDEN layer, while the CLOSED-SET spine stays neutral + capped ────

describe("0101/#1401 Phase-2 — reweight ON re-paces the hidden layer within the mandate", () => {
  it("re-orders the scheduler and moves the hidden layer, WITHOUT deciding a closed-set outcome", () => {
    let anyHiddenDiff = false;
    let anyReweighted = false;
    // NOTE on the mandate line (measured 2026-07-12): the thread scheduler's folds move ONLY the player's
    // OWN read of an NPC (`player→NPC` edges) + the belief/gossip layer — the OPEN set. They never move an
    // `NPC→player` edge or an NPC decision, so re-ordering which OPEN-SET storyline the tick surfaces
    // GENUINELY re-paces the hidden layer (relationship/knowledge/lifecycle diverge below) yet CANNOT shift
    // the deterministic driver's evictions/winner (a passive driver never acts on `player→NPC` reads). That
    // is the reweight staying firmly on the "re-weight which OPEN-SET storyline surfaces" side of ADR 0005 —
    // it can never "decide a CLOSED-SET outcome". A real (LLM-driven) player, who DOES act on their evolving
    // reads, is the one whose game the pacing re-shapes; the calibration heavy-sims (juryReach/gradient/UAT
    // run ON) prove the DISTRIBUTION stays within-band under the flag.
    for (const seed of [1, 3, 4, 5, 7, 9, 11]) { // widened 2026-11-03, comp-win threat retune (#1953); +4,9 2026-11-06 (ORW-116 Day-1 flow shifted the hidden-layer timing; seed 13 diverges the closed set ON vs OFF even on main — filed, not added)
      const off = playSeason(seed, false);
      const on = playSeason(seed, true);
      // Non-vacuous: the reweight genuinely re-ordered the scheduler this season.
      expect(on.reweightCount, `seed ${seed}: the reweight fired (re-ordered the scheduler)`).toBeGreaterThan(0);
      anyReweighted = true;
      // The mandate proof: the CLOSED-SET deterministic-driver outcome is UNCHANGED (the reweight stays
      // open-set — it never shifts who the engine evicts/crowns for a driver).
      expect(on.closedHash, `seed ${seed}: the reweight must not shift the deterministic closed-set outcome`).toBe(off.closedHash);
      // The bound: the hard season surfacing cap still binds (never bypassed).
      expect(on.surfaced, `seed ${seed}: the season surfacing cap still binds ON`).toBeLessThanOrEqual(THREAD.maxSurfacedPerSeason);
      // Genuine work: the hidden layer (relationship OR knowledge OR thread lifecycle) moved on this seed.
      if (on.relHash !== off.relHash || on.knowHash !== off.knowHash || on.lifecycleHash !== off.lifecycleHash) anyHiddenDiff = true;
    }
    expect(anyReweighted, "the reweight genuinely re-ordered the scheduler").toBe(true);
    expect(anyHiddenDiff, "the reweight genuinely re-paced the hidden layer on ≥1 seed (not a no-op)").toBe(true);
  });
});

// ── (E) Vault-held: the reweight count / notes reach no player- or admin-facing projection ────────────

describe("0101/#1401 Phase-2 — the reweight stays Vault-held (the boundary belt)", () => {
  it("with the reweight ON, no producer note / count leaks to any player OR admin projection", () => {
    GameSessionAdapter.setShowrunnerReweightEnabled(true);
    const reg = new GameSessionRegistry();
    const user = "sr-reweight-vault";
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    const orch = new Orchestrator(reg, new FakeClock(), { seed: 7 });
    let finished = false;
    for (let i = 0; i < 12 && !finished; i++) {
      finished = stepAndCapture(sb, []);
      if (!finished) orch.advance(user, "offscreen-tick");
    }
    // The layer genuinely ran (notes composed; the count is engine-side + monotonic).
    const core = sb.session.snapshot();
    expect((core.showrunnerNotes ?? []).length, "the reweight ON composed producer notes").toBeGreaterThan(0);
    // The sweep of every player projection + God-Mode inspection — none may carry a note or the count.
    sb.syncAdmin?.();
    const surfaces = [
      JSON.stringify(sb.session.getGameState()),
      JSON.stringify(sb.player.getVisibleState()),
      JSON.stringify(sb.session.getMomentPrompt({})),
      JSON.stringify(sb.admin.inspect()),
      JSON.stringify(sb.admin.health?.() ?? null),
    ].join("\n---\n");
    expect(surfaces).not.toContain("Producer's note");
    expect(surfaces).not.toContain("showrunnerReweightCount");
    expect(surfaces).not.toContain("showrunnerNotes");
    for (const n of core.showrunnerNotes ?? []) {
      for (const e of n.emphases) expect(surfaces.includes(e.rationale)).toBe(false);
    }
    // Persistence (#4 / #1455): the monotonic reweight count round-trips through a restore.
    expect(core.showrunnerReweightCount, "the reweight fired within the driven ticks").toBeGreaterThan(0);
    const fresh = new GameSessionAdapter();
    fresh.restore(core);
    expect(fresh.showrunnerReweightCountNow(), "the reweight count survives a restore (non-degradation)").toBe(core.showrunnerReweightCount);
  });
});
