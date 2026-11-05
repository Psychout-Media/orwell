import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { COMPETITION_LIBRARY_PLUS } from "../../src/engine/competitionLibrary";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import type { UserSandbox } from "../../src/composition/registry";

/**
 * Feature 0126 — the expanded mechanic pool, live through the adapter. Proves: with the flag on a season
 * draws essentially all-distinct MECHANICS (repeat-free, not just reskinned); with it off the pool is the
 * bare base 12 AND the seeded eviction trajectory is byte-identical (the calibration guard); it is
 * seed-deterministic; and no stat/score leaks. Roles only — no names.
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

/** Start a fresh seeded sandbox with the expanded-mechanic pool explicitly on or off. */
function newGame(user: string, seed: number, plusOn: boolean): UserSandbox {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setCompMechanicsPlusEnabled(plusOn);
  return sb;
}

/** Drive a seeded game to completion, returning the drawn-comp history + the eviction order. */
function playFull(sb: UserSandbox): { hoh: string[]; veto: string[]; evictionOrder: readonly string[] } {
  const s = sb.session;
  for (let i = 0; i < 2000; i++) {
    const a = s.advanceGame();
    if (a.pending) resolveLegally(s, a.pending);
    if (a.finished) break;
  }
  const live = s.snapshot().live!;
  return { hoh: live.compHistory?.hoh ?? [], veto: live.compHistory?.veto ?? [], evictionOrder: live.evictionOrder ?? [] };
}

const PLUS_IDS = new Set(COMPETITION_LIBRARY_PLUS.map((d) => d.id));

describe("0126 — with the expanded pool ON, a season is repeat-free at the MECHANIC level", () => {
  it("a full season draws almost all-distinct HOH and veto mechanics, using the new pool", () => {
    const { hoh, veto } = playFull(newGame("mp-on", 31, true));
    // ~14 HOH / ~13 veto comps drawn from a 15-deep pool ⇒ nearly every one distinct. NOTE (S16): the floors (>=13 HOH, >=12 veto distinct) are pinned to THIS seed (31) and season length; if the pool size or the season length changes, re-derive them from COMPETITION_LIBRARY_PLUS (pool size) and the comps drawn.
    expect(new Set(hoh).size).toBeGreaterThanOrEqual(13);
    expect(new Set(veto).size).toBeGreaterThanOrEqual(12);
    // And the new mechanics are actually in play (not just the base 12 reshuffled).
    expect([...hoh, ...veto].some((id) => PLUS_IDS.has(id))).toBe(true);
  });
});

describe("0126 — with the pool OFF the seeded spine is deterministic (the base 12 only)", () => {
  it("two OFF games on the same seed evict the same houseguests in the same order (determinism) and never draw an expanded-only mechanic", () => {
    const off = playFull(newGame("mp-off-a", 77, false));
    const base = playFull(newGame("mp-off-b", 77, false));
    expect(off.evictionOrder).toEqual(base.evictionOrder);
    expect(off.evictionOrder.length).toBeGreaterThan(0);
    // Off ⇒ no expanded-only mechanic is ever drawn.
    expect([...off.hoh, ...off.veto].some((id) => PLUS_IDS.has(id))).toBe(false);
  });

  it("turning the pool ON changes which mechanics are drawn (the flag is really doing something)", () => {
    const on = playFull(newGame("mp-cmp-on", 77, true));
    const off = playFull(newGame("mp-cmp-off", 77, false));
    // The expanded draw is a superset that includes new ids ⇒ the history diverges from the base.
    expect(on.hoh).not.toEqual(off.hoh);
  });
});

describe("0126 — determinism + the Vault wall", () => {
  it("is seed-deterministic — the same seed reproduces the same drawn-comp history", () => {
    const a = playFull(newGame("mp-det-a", 19, true));
    const b = playFull(newGame("mp-det-b", 19, true));
    expect(a.hoh).toEqual(b.hoh);
    expect(a.veto).toEqual(b.veto);
  });

  it("no stat, score, or ranking rides the expanded competition result", () => {
    const sb = newGame("mp-wall", 5, true);
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
