import { describe, it, expect, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { GameSessionRegistry } from "../../src/composition/registry";
import { defaultApply } from "../../src/composition/orchestrator";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import {
  newLiveSeason, advance, applyDecision,
  type LiveSeasonState, type SeasonCtx, type BeatEvent,
} from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import type { Stats } from "../../src/engine/season";

/**
 * Feature 0092 — the CALIBRATION-NEUTRALITY GATE (the `trajectoryOutcomeNeutral` / `stagedTrajectoryNeutral`
 * sibling). THE load-bearing determinism guarantee:
 *
 *   • With `ORWELL_SECRET_PACING` OFF (explicitly `=0`, or `ORWELL_FLAGS_OFF=1`; the code default is now ON), the secret-pacing drip takes ZERO draws — `pacingDrip`
 *     returns immediately — so the orchestrator's bounded off-screen tick draws the SAME seeded stream the
 *     competition/vote/jury spine shares, BYTE-IDENTICALLY to the pre-feature build, and 0060 behaves
 *     exactly as today. The `juryReach` / UAT / gradient gates are unperturbed.
 *   • With the flag ON, the drip draws ONLY on its OWN dedicated side rng (off the game seed + a private
 *     tick counter) — never the shared stream the orchestrator passes — so that shared draw stream is
 *     STILL byte-identical. The only thing it changes is which already-Wall-safe surface 0060 picks and
 *     whether the weekly budget allows it.
 *
 * HARD rule: roles only — no names; all fixtures generated.
 */

// ── 1. The orchestrator's bounded-tick SHARED draw stream is byte-identical (flag off AND on) ────────

/** A SeededRandom that RECORDS every `next()` value — the exact draw stream the calibration spine shares.
 *  Every `int`/`pick`/`fork` routes through `next()` in the base class, so this captures EVERY draw. */
class RecordingSeeded extends SeededRandom {
  readonly draws: number[] = [];
  override next(): number { const v = super.next(); this.draws.push(v); return v; }
}

/** A snapshot fingerprint that captures the whole engine-visible state (threads, events, knowledge, …). */
function snapshotHash(reg: GameSessionRegistry, user: string): string {
  return createHash("sha256").update(JSON.stringify(reg.snapshot(user))).digest("hex");
}

/** Drive N bounded off-screen ticks via the REAL `defaultApply` on a recording rng; return the draw
 *  stream + the final snapshot hash. The feature flag is set by the caller around this. */
function runTicks(seed: number, user: string, ticks: number): { draws: number[]; hash: string } {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const rng = new RecordingSeeded(seed);
  for (let i = 0; i < ticks; i++) defaultApply(sb, "offscreen-tick", rng, i * 1000, 3);
  return { draws: rng.draws, hash: snapshotHash(reg, user) };
}

// Belt-and-suspenders: the process-global pacing override must never leak past this file even if an
// assertion throws mid-test (it would leave a non-default pacing override in place for any later suite).
afterEach(() => { GameSessionAdapter.setSecretPacingEnabled(null); });

describe("0092 — the off-screen tick's SHARED draw stream is calibration-neutral to secret pacing", () => {
  const SEEDS = [1, 2, 7, 13, 42];
  const TICKS = 24;

  it("the flag default (now ON, default flip 2026-11-03) is byte-identical to flag EXPLICITLY on; the shared draw stream also equals explicit-off", () => {
    for (const seed of SEEDS) {
      GameSessionAdapter.setSecretPacingEnabled(null); // env default = ON
      const def = runTicks(seed, "neu-default", TICKS);
      GameSessionAdapter.setSecretPacingEnabled(true); // explicitly on
      const on = runTicks(seed, "neu-on-explicit", TICKS);
      GameSessionAdapter.setSecretPacingEnabled(false); // explicitly off
      const off = runTicks(seed, "neu-off", TICKS);
      GameSessionAdapter.setSecretPacingEnabled(null);
      expect(on.draws, `seed ${seed}: default vs explicit-on share the same draw stream`).toEqual(def.draws);
      expect(on.hash, `seed ${seed}: default vs explicit-on reach the same state`).toBe(def.hash);
      expect(off.draws, `seed ${seed}: explicit-off shares the same shared draw stream`).toEqual(def.draws);
    }
  });

  it("flag ON: the SHARED draw stream is STILL byte-identical (the drip draws only on its own side rng)", () => {
    for (const seed of SEEDS) {
      GameSessionAdapter.setSecretPacingEnabled(false);
      const off = runTicks(seed, "neu-off2", TICKS);
      GameSessionAdapter.setSecretPacingEnabled(true);
      const on = runTicks(seed, "neu-on", TICKS);
      GameSessionAdapter.setSecretPacingEnabled(null);
      // THE LOAD-BEARING PROPERTY: the rng draw stream the competition/vote spine shares is byte-identical
      // whether the secret-pacing drip is on or off — it never consumes a shared-stream draw.
      expect(on.draws, `seed ${seed}: the shared off-screen draw stream is byte-identical with pacing ON`).toEqual(off.draws);
    }
  });
});

// ── 2. The full seeded competition/vote/jury spine is a pure function of the seed (unperturbed) ──────
// (Copied in shape from trajectoryOutcomeNeutral — the spine the off-screen stream feeds. Since the drip
//  touches ONLY the off-screen tick and, with the flag off, is a pure no-op, flag-off cannot change any
//  of these outcomes; this re-proves the spine's determinism WITHOUT the heavy sims.)

interface Trajectory { ceremonies: string[]; evictionOrder: EntityId[]; winner: EntityId | undefined; finalTwo: EntityId[] | undefined; }
const TRAJECTORY_BEATS = new Set(["hoh-competition", "veto-competition", "nominations", "veto-ceremony", "eviction", "final-eviction", "finale-result"]);

function buildHouse(size: number, seed: number): { active: EntityId[]; statsOf: (id: EntityId) => Stats; rel: () => RelationshipModel } {
  const rng = new SeededRandom(seed);
  const active: EntityId[] = [PLAYER, ...Array.from({ length: size - 1 }, (_, i) => npc(i + 1))];
  const stats = new Map<EntityId, Stats>();
  for (const id of active) stats.set(id, { physical: rng.next(), mental: rng.next(), social: rng.next() });
  const edges = new Map<string, { trust: number; affinity: number; threat: number }>();
  for (const a of active) for (const b of active) {
    if (a === b) continue;
    edges.set(`${a}|${b}`, { trust: rng.next(), affinity: rng.next(), threat: rng.next() });
  }
  const freshRel = (): RelationshipModel => {
    const rel = new RelationshipModel(0.5);
    for (const a of active) for (const b of active) {
      if (a === b) continue;
      const e = rel.edge(a, b); const s = edges.get(`${a}|${b}`)!;
      e.trust = s.trust; e.affinity = s.affinity; e.threat = s.threat; e.confidence = 0.5;
    }
    return rel;
  };
  return { active, statsOf: (id) => stats.get(id)!, rel: freshRel };
}

function playGame(active: EntityId[], ctx: SeasonCtx, seed: number): Trajectory {
  const s: LiveSeasonState = newLiveSeason(active);
  const rng = new SeededRandom(seed);
  const t: Trajectory = { ceremonies: [], evictionOrder: [], winner: undefined, finalTwo: undefined };
  const rec = (ev: BeatEvent | null): void => { if (ev && TRAJECTORY_BEATS.has(ev.beat)) t.ceremonies.push(`${ev.beat}: ${ev.content}`); };
  for (let guard = 0; guard < 20_000 && !s.finished; guard++) {
    if (s.pending) {
      const p = s.pending;
      if (p.kind === "comp-round" || p.kind === "comp-intent") rec(applyDecision(s, { kind: p.kind, intent: "compete" }, ctx, rng));
      else if (p.kind === "nominations") rec(applyDecision(s, { kind: "nominations", choice: [p.options[0]!, p.options[1]!] }, ctx));
      else if (p.kind === "veto-decision") rec(applyDecision(s, { kind: "veto-decision", use: false }, ctx));
      else if (p.kind === "replacement") rec(applyDecision(s, { kind: "replacement", replacement: p.options[0]! }, ctx));
      else if (p.kind === "eviction-vote") rec(applyDecision(s, { kind: "eviction-vote", vote: p.nominees[0] }, ctx));
      else if (p.kind === "tie-break") rec(applyDecision(s, { kind: "tie-break", evict: p.nominees[0] }, ctx));
      else if (p.kind === "final-eviction") rec(applyDecision(s, { kind: "final-eviction", evict: p.options[0]! }, ctx));
      else if (p.kind === "houseguests-choice") rec(applyDecision(s, { kind: "houseguests-choice", pick: p.options[0]! }, ctx, rng));
      else if (p.kind === "goodbye-message") rec(applyDecision(s, { kind: "goodbye-message", tone: p.tones[0]! }, ctx));
      else if (p.kind === "exit-interview") rec(applyDecision(s, { kind: "exit-interview", stance: p.stances[0]! }, ctx));
      else if (p.kind === "finale-statement") rec(applyDecision(s, { kind: "finale-statement", statement: "" }, ctx));
      else if (p.kind === "finale-answer") rec(applyDecision(s, { kind: "finale-answer", appeal: p.appeals[0]! }, ctx));
      else if (p.kind === "juror-question") rec(applyDecision(s, { kind: "juror-question", question: "" }, ctx));
      else if (p.kind === "juror-vote") rec(applyDecision(s, { kind: "juror-vote", vote: p.finalists[0] }, ctx));
      else throw new Error(`unhandled pending ${p.kind}`);
    } else {
      rec(advance(s, ctx, rng));
    }
  }
  t.evictionOrder = [...s.evictionOrder];
  t.winner = s.winner;
  t.finalTwo = s.finalTwo ? [...s.finalTwo] : undefined;
  return t;
}

describe("0092 — the seeded competition/vote/jury spine is a pure function of the seed (the drip never touches it)", () => {
  for (const size of [5, 8, 12]) {
    for (const seed of [1, 7, 42]) {
      it(`size ${size}, seed ${seed}: identical eviction order, winner, and Final 2 on replay`, () => {
        const h = buildHouse(size, seed);
        const a = playGame(h.active, { player: PLAYER, statsOf: h.statsOf, rel: h.rel() }, seed);
        const b = playGame(h.active, { player: PLAYER, statsOf: h.statsOf, rel: h.rel() }, seed);
        expect(a.winner, "a winner is crowned").toBeDefined();
        expect(b.evictionOrder).toEqual(a.evictionOrder);
        expect(b.ceremonies).toEqual(a.ceremonies);
        expect(b.winner).toBe(a.winner);
        expect(b.finalTwo).toEqual(a.finalTwo);
      });
    }
  }
});
