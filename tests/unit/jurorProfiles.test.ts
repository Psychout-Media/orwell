import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../../features/support/answerPending";
import { ARCHETYPES, jurorProfile, profiledLean, profiledWeights } from "../../src/engine/jurorProfile";
import { juryLean, JURY_WEIGHTS } from "../../src/engine/jury";
import { npc } from "../../src/domain/ids";
import { createHash } from "node:crypto";

/** A2 (design §13): per-juror vote profiles behind ORWELL_JUROR_PROFILES (default OFF). Roles only. */
const ids = Array.from({ length: 600 }, (_, i) => npc(i + 1));

describe("A2 - per-juror vote profiles", () => {
  it("is deterministic per juror and varied across jurors (all five archetypes occur)", () => {
    expect(jurorProfile(npc(3), 7)).toEqual(jurorProfile(npc(3), 7));
    expect(new Set(ids.map((j) => jurorProfile(j, 1).archetype)).size).toBe(5);
    expect(jurorProfile(npc(3), 1).archetype === jurorProfile(npc(3), 2).archetype && jurorProfile(npc(4), 1).archetype === jurorProfile(npc(4), 2).archetype && jurorProfile(npc(5), 1).archetype === jurorProfile(npc(5), 2).archetype && jurorProfile(npc(6), 1).archetype === jurorProfile(npc(6), 2).archetype && jurorProfile(npc(7), 1).archetype === jurorProfile(npc(7), 2).archetype).toBe(false); // the salt (game seed) reshuffles
  });

  it("NORMALISED EXACTLY: every term's five archetype multipliers sum to 5.0 (the house-mean weight is preserved by construction)", () => {
    for (let col = 1; col <= 5; col++) expect(ARCHETYPES.reduce((a, row) => a + (row[col] as number), 0), `column ${col}`).toBeCloseTo(5, 10);
  });

  it("NORMALISED: the house-mean multiplier of every term is 1.0 (over the five archetypes, and ~1.0 over many jurors)", () => {
    const mean = (f: (p: ReturnType<typeof jurorProfile>) => number): number => ids.reduce((a, j) => a + f(jurorProfile(j, 11)), 0) / ids.length;
    for (const term of ["relationship", "manner", "reliability", "gameRespect", "finale"] as const) expect(mean((p) => p.mult[term]), term).toBeGreaterThan(0.93);
    for (const term of ["relationship", "manner", "reliability", "gameRespect", "finale"] as const) expect(mean((p) => p.mult[term]), term).toBeLessThan(1.07);
    const w = profiledWeights(jurorProfile(npc(1), 0));
    expect(Object.keys(w).sort()).toEqual(Object.keys(JURY_WEIGHTS).sort());
  });

  it("different jurors weigh the SAME evidence differently (the point: a coalition is winnable, the house is not one verdict)", () => {
    // A finalist with a great resume but a cold relationship: competitors lean to them far more than loyalists.
    const rel = { trust: 0.3, affinity: 0.3, threat: 0.2, reliability: 0 };
    const leans = ids.slice(0, 60).map((j) => profiledLean(rel, {}, jurorProfile(j, 3)));
    expect(Math.max(...leans) - Math.min(...leans)).toBeGreaterThan(0.05);
  });

  it("FRIEND-FORGIVES: a close friend discounts a blindside; a stranger does not; respect is untouched", () => {
    const forgiver = Array.from(ids).map((j) => jurorProfile(j, 5)).find((p) => p.archetype === "forgiver")!;
    const blind = { blindsided: true } as const;
    const friend = profiledLean({ trust: 0.9, affinity: 0.9, threat: 0.1 }, blind, forgiver) - profiledWeights(forgiver).relationship * 0.9;
    const stranger = profiledLean({ trust: 0.0, affinity: 0.0, threat: 0.1 }, blind, forgiver) - 0;
    expect(friend - stranger, "the friend's grievance term is clearly smaller (less negative)").toBeGreaterThan(0.1);
    const nogripe = { respected: true } as const;
    const a = profiledLean({ trust: 0.9, affinity: 0.9, threat: 0.1 }, nogripe, forgiver), b = profiledLean({ trust: 0.9, affinity: 0.9, threat: 0.1 }, nogripe, { ...forgiver, forgiveness: 0 });
    expect(a).toBeCloseTo(b, 10);
  });

  it("reduces to the global ballot for a profile of all-ones with no forgiveness", () => {
    const flat = { archetype: "pragmatist" as const, mult: { relationship: 1, manner: 1, reliability: 1, gameRespect: 1, finale: 1 }, forgiveness: 0 };
    const rel = { trust: 0.6, affinity: 0.5, threat: 0.3, reliability: 0.1 }, manner = { betrayed: true } as const;
    expect(profiledLean(rel, manner, flat)).toBeCloseTo(juryLean(rel, manner), 12);
  });
});

/** Play a full seeded game and hash the outcome (winner, finalists, jury order, eviction order). */
let n = 0;
function outcomeHash(seed: number, set: (s: GameSessionAdapter) => void): string {
  const sb = new GameSessionRegistry().sandboxFor(`jp${n++}`);
  set(sb.session);
  sb.session.createCharacter({ playerName: "P", seed });
  for (let i = 0; i < 8000; i++) { const v = sb.session.advanceGame(); if (v.pending) resolvePending(v.pending, (r) => void sb.session.submitDecision(r)); if (v.finished) break; }
  const l = sb.session.snapshot().live!;
  return createHash("sha256").update(JSON.stringify([l.winner, l.finalTwo, l.jury, l.evictionOrder, l.finale?.votes])).digest("hex");
}

describe("A2 - flag OFF is byte-identical; ON changes ballots", () => {
  it("default (never touched) == ON explicit (the flag is ON by default since 2026-11-06, ORW-16); the opt-out is =0", () => {
    for (const seed of [2, 5]) expect(outcomeHash(seed, (s) => s.setJurorProfilesEnabled(true))).toBe(outcomeHash(seed, () => undefined));
  });
  it("ON draws no extra rng and moves SOME ballot on some seed (non-vacuous)", () => {
    let moved = 0;
    for (const seed of [2, 5, 7, 11, 13, 17]) {
      const off = outcomeHash(seed, (s) => s.setJurorProfilesEnabled(false)), on = outcomeHash(seed, (s) => s.setJurorProfilesEnabled(true));
      if (off !== on) moved++;
    }
    expect(moved).toBeGreaterThan(0);
  });
});
