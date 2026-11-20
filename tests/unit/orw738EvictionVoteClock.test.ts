import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { eventSpanHours } from "../../src/engine/timeOfDay";

/**
 * ORW-738 (Season 2 week 3 playtest: "the eviction vote ran with no narration: the clock jumped 4:00 -> 6:10pm, eleven banners, a blank announcement line").
 * Real path: a played season (clock on, the player a NOMINEE) driven to the eviction night, then pressed through it ONE STEP AT A TIME exactly as the Continue
 * button does (`ceremony-continue` is a bare `advanceGame`, never `noteMessage`). Pins what the engine hands the player on every step:
 *  - the clock: the eviction night's whole budget (PO 2026-11-01, "about two in-game hours, total") is SPREAD over its first steps (ORW-262), never one jump;
 *    the jump the player saw is the 2h budget plus the two typed messages (2 x 5 min) = 2h10, and no single press costs more than a slice;
 *  - the announcements: every ballot step and the result step carry a non-empty public headline (the engine never hands the chyron a blank line);
 *  - E12: no ballot headline names a voter.
 * Roles only. These are honest pins of designed behaviour (green on creation), not a red-then-green fix.
 */
type Any = Record<string, any>;
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

describe("ORW-738: pressing Continue through a played eviction night (the player is a nominee)", () => {
  it("spreads the 2h budget over the first steps, hands a non-empty headline on every ballot and the result, and names no voter", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orw738-")))).sandboxFor("u").session as unknown as Any;
    s.createCharacter({ playerName: "P", seed: 5 });
    s.noteMessage({ messageId: "m1" });
    s.scheduleGateBypass = true;
    for (let i = 0; i < 300; i++) {
      const live = s.live;
      if (live.beat === "eviction" && !live.pending && !live.ceremony && !live.eviction) break;
      const p = s.advanceGame().pending;
      if (!p) continue;
      if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
      else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
      else if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
      else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", pick: p.options[0].id });
      else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
    }
    const live = s.live;
    const others = live.active.filter((h: string) => h !== PLAYER);
    live.hoh = others[0];
    live.finalNominees = [PLAYER, others[1]];
    live.nominees = [PLAYER, others[1]];
    live.preEvictionNightPassed = true;

    const clock = (): number => s.live.nightDepth as number;
    const t0 = clock();
    const costs: number[] = [];
    const views: Any[] = [];
    for (let i = 0; i < 60; i++) {
      const p = s.live.pending as Any | undefined;
      if (p?.kind === "eviction-vote" || p?.kind === "goodbye-message" || p?.kind === "exit-interview" || p?.kind === "spectator-choice") break;
      const before = clock();
      const v = s.advanceGame();
      costs.push(clock() - before);
      views.push(v);
      if (v.event?.beat === "eviction") break; // the result is committed
    }
    const ballots = views.filter((v) => v.event?.beat === "eviction-reveal");
    const result = views.find((v) => v.event?.beat === "eviction");
    expect(ballots.length).toBeGreaterThan(5);
    expect(result).toBeDefined();

    // the clock: the eviction night's budget in total, in slices, never one jump
    const budget = eventSpanHours("eviction");
    expect(clock() - t0).toBeCloseTo(budget, 5);
    expect(Math.max(...costs)).toBeLessThanOrEqual(budget / 5 + 1e-9);
    expect(costs.filter((c) => c > 0).length).toBe(5);
    expect(costs.slice(-5).every((c) => c === 0)).toBe(true); // later presses cost nothing: the vote never stretches past its budget
    // the two typed messages around the vote (the plea, the count question) are 5 minutes each: 2h + 10 min is the 4:00 -> 6:10 the playtest saw
    expect(budget).toBe(2); // 120 min + 10 = 130

    // the announcements: never blank; E12: no voter
    for (const v of [...ballots, result]) {
      expect(v, "every ballot and the result is a view").toBeDefined();
      expect(Array.isArray(v?.announcements) && (v?.announcements?.length ?? 0) > 0).toBe(true);
      for (const a of v?.announcements ?? []) {
        expect(typeof a.headline === "string" && a.headline.trim().length > 0).toBe(true);
        expect(a.headline).not.toMatch(/votes? (by|from)|voted/i);
      }
    }
    for (const v of ballots) expect(v?.announcements?.[0]?.headline).toMatch(/^a vote to evict \S.*\.$/);
    expect(result?.announcements?.[0]?.headline).toMatch(/has been evicted from the house/);
  });
});
