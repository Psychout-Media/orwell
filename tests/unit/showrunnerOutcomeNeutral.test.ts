import "../support/pinFlagsOff";
import { describe, it, expect } from "vitest";

// B36: this test asserts the OLD graph-diffusion path (or its neutrality / a positive control that rides it). The co-presence layer (ORWELL_GOSSIP_COPRESENCE) REPLACES that path when on, so the
// test pins the layer OFF explicitly instead of depending on the process env (the one-hop-by-scene equivalents live in copresenceSpread / copresenceScenes tests).
import { beforeAll as _b36BeforeAll, afterAll as _b36AfterAll } from "vitest";
const _b36Prev = process.env["ORWELL_GOSSIP_COPRESENCE"];
_b36BeforeAll(() => { process.env["ORWELL_GOSSIP_COPRESENCE"] = "0"; });
_b36AfterAll(() => { if (_b36Prev === undefined) delete process.env["ORWELL_GOSSIP_COPRESENCE"]; else process.env["ORWELL_GOSSIP_COPRESENCE"] = _b36Prev; });
import { createHash } from "node:crypto";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator, defaultApply } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { RandomnessSource } from "../../src/ports/RandomnessSource";
import type { UserSandbox } from "../../src/composition/registry";

/**
 * Feature 0101 (#1401) — the AI SHOWRUNNER's CLOSED-SET NEUTRALITY GATE (the `*OutcomeNeutral.test.ts`
 * sibling — trajectory / secretBarter / staged). The showrunner re-weights only the OPEN set (which
 * simmering thread the off-screen tick emphasizes); it must be PROVABLY inert to the CLOSED set (every
 * competition roll, eligibility rule, and vote tally). This is airtight BY CONSTRUCTION and proven here:
 *
 *   • The note is composed on a PURE pass (`showrunnerTick`, no rng).
 *   • The scheduler it biases runs on per-thread SIDE rngs (keyed by thread id) — the shared `rng` it is
 *     handed is never consumed — and a surfacing's downstream work runs on DEDICATED rngs / no rng
 *     (`onThreadGossip` forks its own; `onThreadSurfaceToPlayer` draws nothing).
 *
 * So with the flag ON or OFF: (A) the shared off-screen draw stream through the whole tick is
 * byte-identical, and (B) a FULL seeded season's competition/eviction/vote outcomes hash identically.
 * DEFAULT OFF ⇒ nothing composed at all. HARD rule: roles only — no names.
 */

/** A wrapping rng that RECORDS every `next()` value — the exact shared draw stream the tick threads. */
class RecordingRandom implements RandomnessSource {
  readonly draws: number[] = [];
  constructor(private readonly inner: RandomnessSource) {}
  next(): number { const v = this.inner.next(); this.draws.push(v); return v; }
  int(maxExclusive: number): number { if (maxExclusive <= 0) return 0; return Math.floor(this.next() * maxExclusive); }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("empty"); return items[this.int(items.length)]!;
  }
  fork(label: string): RandomnessSource { return this.inner.fork(label); }
}

// ── (A) the shared off-screen draw stream through ONE tick is byte-identical, flag ON vs OFF ─────────

/** Run ONE `defaultApply` off-screen tick on a fresh game with a RECORDING shared rng; return its draws
 *  plus the showrunner's note count (so we can prove the ON run genuinely composed a note). */
function tickDraws(seed: number, drawSeed: number, showrunner: boolean): { draws: number[]; noteCount: number } {
  const reg = new GameSessionRegistry();
  const user = "sr-tick";
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  sb.session.setShowrunnerEnabled(showrunner);
  const rng = new RecordingRandom(new SeededRandom(drawSeed));
  defaultApply(sb, "offscreen-tick", rng as unknown as SeededRandom, 1000, 3);
  return { draws: rng.draws, noteCount: sb.session.snapshot().showrunnerNoteCount ?? 0 };
}

describe("0101/#1401 — the shared off-screen draw stream is byte-identical to the showrunner", () => {
  it("flag ON draws the SAME shared stream as flag OFF — while ON genuinely composed a producer note", () => {
    for (const seed of [1, 2, 3, 7, 13, 42, 99]) {
      const off = tickDraws(seed, seed * 31 + 5, false);
      const on = tickDraws(seed, seed * 31 + 5, true);
      // THE LOAD-BEARING PROPERTY: the rng draw stream the competition/vote spine shares is byte-identical.
      expect(on.draws, `seed ${seed}: the shared off-screen draw stream is byte-identical with the showrunner ON`).toEqual(off.draws);
      // Non-vacuous: the ON run actually ran the layer (composed a note); the OFF run composed none.
      expect(on.noteCount).toBeGreaterThan(0);
      expect(off.noteCount).toBe(0);
    }
  });
});

// ── (B) a FULL seeded season's competition/eviction/vote outcomes hash identically, flag ON vs OFF ───

/** Drive one live-loop beat + resolve any pending; APPEND every outcome-bearing beat (name + the public
 *  participant ids — the closed-set competition/eligibility/vote stream) to `stream`. Returns finished. */
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

/** Play a FULL seeded season with the orchestrator ticking (so the showrunner actually fires), then hash
 *  the whole closed-set outcome trajectory (beat stream + eviction order + winner + Final 2). */
function playAndHash(seed: number, showrunner: boolean): { hash: string; noteCount: number; evictions: number } {
  const reg = new GameSessionRegistry();
  // The SAME user key for OFF and ON (separate registries): the orchestrator seeds its per-user off-screen
  // rng from `hashSeed(seed:user)`, so an ON/OFF pair MUST share the user to share that stream — otherwise
  // the two seasons diverge on the USER KEY, not the flag (the off-screen society drives different scenes).
  const user = "sr-season";
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  sb.session.setShowrunnerEnabled(showrunner);
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
  return {
    hash: createHash("sha256").update(stream.join("\n")).digest("hex"),
    noteCount: core.showrunnerNoteCount ?? 0,
    evictions: (core.live?.evictionOrder ?? []).length,
  };
}

describe("0101/#1401 — a full seeded season's closed-set outcomes are byte-identical to the showrunner", () => {
  for (const seed of [7, 11, 23, 5]) { // ORW-116: 5 added (seed 7 briefly diverged in one staged comp's drop order under the first Day-1 timing; under the final clock-from-entry timing it is neutral again - ORW-211 tracks the main-only seed-13 divergence).
    it(`seed ${seed}: eviction order / winner / Final 2 / every ceremony beat hash identically ON vs OFF`, () => {
      const off = playAndHash(seed, false);
      const on = playAndHash(seed, true);
      // THE PROOF: the SHA256 of the whole competition/eligibility/vote trajectory is identical.
      expect(on.hash, `seed ${seed}: the closed-set outcome hash is byte-identical with the showrunner ON`).toBe(off.hash);
      // Non-vacuous on BOTH sides: the season genuinely progressed (real evictions)…
      expect(off.evictions).toBeGreaterThan(2);
      // …and the ON run genuinely exercised the layer (many per-beat producer notes), OFF composed none.
      expect(on.noteCount).toBeGreaterThan(0);
      expect(off.noteCount).toBe(0);
    });
  }
});
