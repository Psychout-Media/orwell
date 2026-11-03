import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { UserSandbox } from "../../src/composition/registry";
import { startNewGame, generateHiddenElements } from "../../src/engine/characterFactory";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/**
 * Feature 0091 — the CALIBRATION-NEUTRALITY GATE (the `trajectoryOutcomeNeutral` / `stagedTrajectoryNeutral`
 * sibling). The load-bearing determinism guarantee is bipartite (mandate #3 + the spec's determinism callout):
 *
 *   • The trigger check draws ONLY on its own DEDICATED session rng, NEVER the shared off-screen stream that
 *     drives the seeded society/competition/vote spine. So within a tick the society's seeded output is
 *     byte-IDENTICAL whether the layer is OFF or ON (the check runs AFTER the society, on a separate rng).
 *   • Flag OFF (the DEFAULT — the state the juryReach/UAT/gradient calibration sims run in) ⇒ the orchestrator
 *     never runs the trigger check ⇒ ZERO draws on ANY rng (the dedicated trigger-rng tick counter never
 *     advances) ⇒ the run is a byte-identical deterministic fixed point.
 *   • The HOUSE-GENERATION main stream stays byte-stable: arming runs on a dedicated `:trigger:` side rng, so
 *     stats/names/ages/souls (the calibration inputs) are byte-identical whether or not a trigger is armed.
 *
 * NOTE (by design, NOT asserted): with the layer ON the eruption's soul/witness FOLDS legitimately MOVE reads
 * (the same kind of fold the society already applies), so relationship EDGES / vote OUTCOMES may differ ON vs
 * OFF. That is fine — the calibration harness runs with the flag OFF (proven byte-identical here + by the
 * `tests/property/juryReach.property.test.ts` heavy gate), and the RNG STREAM the comps/votes resolve on is
 * untouched (proven by the identical SHARED-event stream below).
 *
 * HARD rule: roles only — no names; all fixtures generated.
 */

// Seed re-selected 2026-07-21 (T0-2, "beats terminate themselves"): resolving a CLOSED-SET ceremony
// pending (nominations/veto-decision/replacement/eviction-vote/tie-break/…) now auto-advances the live
// loop one more deterministic step in the SAME `submitDecision` call (`AUTO_ADVANCE_PENDING_KINDS` in
// `GameSessionAdapter.ts`) — this harness's `stepLoop` drives exactly ONE `advanceGame`+decision per
// outer iteration, so the SAME 120-iteration budget now covers MORE of the season per iteration,
// shifting (again) which beat/tick the reactive-twist eruption window falls in for a given seed — the
// SAME class of harness-timing artifact 0130 hit on 2026-07-13 (see the seed history below). Seed 42 no
// longer erupts within the bounded run under the new interleave; seed 8 does. This is a harness-timing
// retune only — NOT a calibration change (triggers are OFF in every seeded UAT/juryReach/gradient gate)
// — and the CORE invariants this file protects (dedicated-vs-shared rng separation, flag-OFF byte-
// identical fixed point) are untouched by T0-2 and stay green regardless of which seed is picked here;
// only the "flag ON is non-vacuous" check needs a seed that actually erupts inside the fixed budget.
//
// Prior history (2026-07-13, 0130): the exit-interview beat added one step per eviction, shifting the
// 1-beat:1-tick interleave then in effect — seed 7 stopped erupting within the bounded run and seed 42
// was picked as its replacement.
// re-selected 2026-11-03, default flip (seed 8 no longer erupts within the bounded run)
const SEED = 7;

/** Drive a bounded, fully-deterministic sequence of orchestrator off-screen ticks + live-loop steps; capture
 *  the SHARED-rng-driven content (every recorded event) and the layer's own additive eruptions, separately. */
function runAndHash(triggersOn: boolean): { sharedStream: string; fullStream: string; eruptions: number; triggerTicks: number } {
  const reg = new GameSessionRegistry();
  const user = "tn";
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
  sb.session.setTriggersEnabled(triggersOn);
  const orch = new Orchestrator(reg, new FakeClock(), { seed: SEED });

  // A fixed interleave: advance the live loop a step, then an off-screen tick (where the trigger check rides).
  // Bounded (not to the finale) — long enough to exercise many off-screen ticks + several ceremonies, short
  // enough to keep the parallel unit lane's memory in check.
  let finished = false;
  // Bounded (memory-conscious) but large enough to reach the reactive-twist eruption window for SEED (see
  // the seed note above — 0130's per-eviction beat shifted the beat:tick interleave).
  for (let i = 0; i < 120 && !finished; i++) {
    finished = stepLoop(sb);
    if (!finished) orch.advance(user, "offscreen-tick");
  }

  const events = sb.engine.events.queryAll();
  const eruptions = events.filter((e) => e.id.startsWith("trigger:erupt:"));
  // The id carries a wall-clock / rng nonce irrelevant to calibration; hash the SEEDED content of each event.
  const sig = (e: (typeof events)[number]): string =>
    `${e.type}|${e.initiator}|${[...e.witnessSet].sort().join(",")}|${e.hidden ? 1 : 0}|${e.content}`;
  // The SHARED-rng-driven content: every event EXCEPT the layer's own additive eruptions. This is the stream
  // the off-screen society + the seeded spine draw from — byte-identical whether the layer is off or on.
  const sharedStream = createHash("sha256")
    .update(events.filter((e) => !e.id.startsWith("trigger:erupt:")).map(sig).join("\n")).digest("hex");
  const fullStream = createHash("sha256").update(events.map(sig).join("\n")).digest("hex");
  return { sharedStream, fullStream, eruptions: eruptions.length, triggerTicks: sb.session.snapshot().triggerTickCount ?? 0 };
}

function stepLoop(sb: UserSandbox): boolean {
  const adv = sb.session.advanceGame();
  if (adv.pending) {
    const p = adv.pending;
    if (p.kind === "nominations") sb.session.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
    else if (p.kind === "veto-decision") sb.session.submitDecision({ kind: "veto-decision", use: false });
    else if (p.kind === "replacement") sb.session.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
    else if (p.kind === "finale-statement") sb.session.submitDecision({ kind: "finale-statement", statement: "x" });
    else if (p.kind === "finale-answer") sb.session.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
    else if (p.kind === "juror-vote") sb.session.submitDecision({ kind: "juror-vote", vote: p.options[0]!.id });
    else sb.session.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
  }
  return adv.finished;
}

/** A single off-screen tick on a freshly-created season; returns the SEEDED non-eruption event content this
 *  tick produced (the off-screen society's output, which the shared `rng` drives). The trigger check runs
 *  AFTER the society on a DEDICATED rng, so this society output must be byte-identical whether the layer is
 *  off or on — a tight per-tick proof that the shared off-screen stream is untouched (no fold feedback can
 *  have accumulated yet on the first tick). */
function oneTickSharedEvents(triggersOn: boolean): string {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor("one");
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
  sb.session.setTriggersEnabled(triggersOn);
  const orch = new Orchestrator(reg, new FakeClock(), { seed: SEED });
  orch.advance("one", "offscreen-tick");
  return sb.engine.events.queryAll()
    .filter((e) => !e.id.startsWith("trigger:erupt:"))
    .map((e) => `${e.type}|${e.initiator}|${e.hidden ? 1 : 0}|${e.content}`)
    .join("\n");
}

describe("0091 — the trigger layer is calibration-neutral to the SHARED off-screen / seeded rng stream", () => {
  it("a single off-screen tick's society output is byte-IDENTICAL OFF vs ON (dedicated rng, shared stream intact)", () => {
    // The off-screen society runs FIRST on the shared `rng`, then the trigger check runs on its DEDICATED rng.
    // On the first tick no fold feedback has accumulated, so the society's seeded output is byte-identical —
    // direct proof the trigger check consumes nothing from the shared off-screen stream.
    expect(oneTickSharedEvents(true)).toBe(oneTickSharedEvents(false));
  });

  it("flag OFF ⇒ ZERO eruptions, ZERO dedicated-rng draws, and a deterministic fixed point", () => {
    const a = runAndHash(false);
    const b = runAndHash(false);
    expect(a.fullStream, "flag OFF is a deterministic fixed point (same seed ⇒ same SHA256)").toBe(b.fullStream);
    expect(a.eruptions, "flag OFF records no eruptions").toBe(0);
    expect(a.triggerTicks, "flag OFF never advances the dedicated trigger rng (zero draws)").toBe(0);
  });

  it("flag ON is non-vacuous over the run (the dedicated trigger stream actually advanced)", () => {
    const on = runAndHash(true);
    // The check actually RAN on its dedicated stream (so the per-tick identity above is a real result, not a
    // vacuous one where nothing happened). The full stream differs from OFF only because eruptions were added.
    expect(on.triggerTicks, "the trigger check ran on its dedicated rng with the layer on").toBeGreaterThan(0);
    expect(on.fullStream).not.toBe(runAndHash(false).fullStream); // the eruptions are a real, recorded addition
  });
});

describe("0091 — the house-generation MAIN stream is byte-stable (arming runs on a dedicated side rng)", () => {
  it("startNewGame is byte-identical run-to-run, and the calibration inputs (stats/ages/souls) are unchanged", () => {
    // Determinism across the WHOLE house (incl. the trigger arming + volatility): same seed ⇒ identical.
    for (const seed of [1, 7, 42, 99]) {
      const a = startNewGame({ seed, playerName: "The Player" });
      const b = startNewGame({ seed, playerName: "The Player" });
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      // The calibration-load-bearing fields — stats, ages, baseline volatility — are produced on the MAIN
      // house stream (arming never touches it). Hash them so a future change that accidentally perturbed the
      // main stream from the trigger side-stream would FAIL here.
      const calib = (h: typeof a): string => h.npcs.map((n) => `${n.id}|${JSON.stringify(n.character.stats)}|${n.character.age}|${n.soul.volatility}`).join(";");
      expect(calib(b)).toBe(calib(a));
    }
  });

  it("the B50 hidden-element DRAW SEQUENCE is unchanged by arming (arming only DECORATES, never re-phases)", () => {
    // The arming pass runs on its OWN side rng and only sets fields on already-drawn elements; it never adds/
    // removes/reorders a draw. So the SEQUENCE OF WORDINGS the B50 stream deals is byte-identical with vs.
    // without the trigger side-rng — proven directly at the minting seam (the season-level determinism above is
    // the end-to-end corollary). If a future change interleaved trigger draws INTO the B50 stream, this fails.
    const fit = { stats: { physical: 0.7, mental: 0.7, social: 0.5 }, publicBias: { physical: 0.5, mental: 0.5, social: 0.5 } };
    for (const seed of [1, 7, 42, 99, 123]) {
      const noArm = generateHiddenElements(new SeededRandom(seed), fit).map((e) => e.detail);
      const armed = generateHiddenElements(new SeededRandom(seed), fit, new SeededRandom(seed)).map((e) => e.detail);
      expect(armed, `seed ${seed}: arming leaves the B50 wording sequence byte-identical`).toEqual(noArm);
    }
  });
});
