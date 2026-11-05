import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import type { UserSandbox } from "../../src/composition/registry";

/**
 * Feature 0127 — mixed-type (hybrid) competitions, live through the adapter. Proves the flag off is
 * byte-identical (the seeded eviction trajectory is unmoved), the flag on actually changes seeded winners
 * (a hybrid comp folds its secondary aptitude), it is seed-deterministic, and no stat/score leaks. Roles
 * only — no names.
 */

/** Answer whatever pending the live game raises with a legal, deterministic choice (roles only). */
function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: p.options[0]!.id });
  else if (p.options?.[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
}

/** Start a fresh seeded sandbox with hybrid (mixed) competition resolution explicitly on or off. */
function newGame(user: string, seed: number, mixedOn: boolean): UserSandbox {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setCompMixedEnabled(mixedOn);
  return sb;
}

/** Drive a seeded game to completion, returning the eviction order. */
function playFull(sb: UserSandbox): readonly string[] {
  const s = sb.session;
  for (let i = 0; i < 2000; i++) {
    const a = s.advanceGame();
    if (a.pending) resolveLegally(s, a.pending);
    if (a.finished) break;
  }
  return s.snapshot().live?.evictionOrder ?? [];
}

describe("0127 — with hybrid resolution OFF the seeded spine is deterministic (the anchor that absent secondary == the old call is mixedCompetition.test.ts)", () => {
  it("two OFF games on the same seed evict in the same order", () => {
    const off = playFull(newGame("mx-off-a", 77, false));
    const base = playFull(newGame("mx-off-b", 77, false));
    expect(off).toEqual(base);
    expect(off.length).toBeGreaterThan(0);
  });
});

describe("0127 — turning hybrid resolution ON changes seeded outcomes (the flag does something)", () => {
  it("across several seeds, at least one season's eviction trajectory diverges from the pure model", () => {
    let anyDiverged = false;
    for (const seed of [7, 31, 77, 108, 202]) {
      const on = playFull(newGame(`mx-on-${seed}`, seed, true));
      const off = playFull(newGame(`mx-cmp-${seed}`, seed, false));
      if (JSON.stringify(on) !== JSON.stringify(off)) { anyDiverged = true; break; }
    }
    expect(anyDiverged, "the mixed blend never changed any seeded season — the flag is inert").toBe(true);
  });
});

describe("0127 — determinism + the Vault wall", () => {
  it("is seed-deterministic — the same seed reproduces the same eviction order with hybrids on", () => {
    expect(playFull(newGame("mx-det-a", 19, true))).toEqual(playFull(newGame("mx-det-b", 19, true)));
  });

  it("no stat, score, or ranking rides the competition result under hybrid resolution", () => {
    const sb = newGame("mx-wall", 5, true);
    const views: unknown[] = [];
    for (let i = 0; i < 240; i++) {
      views.push(sb.session.runCompetition({}));
      const a = sb.session.advanceGame();
      if (a.pending) resolveLegally(sb.session, a.pending);
      if (a.status.week > 4 || a.finished) break;
    }
    const blob = JSON.stringify(views);
    expect(/"(physical|mental|social|trust|affinity|threat)"\s*:\s*[\d.]/.test(blob)).toBe(false);
    expect(/"scores"|"temperature"|"governing"|"ranking/i.test(blob)).toBe(false);
    void PLAYER;
  });
});
