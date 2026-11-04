import { describe, it, expect, afterEach } from "vitest";
import { conversationHours, CONVERSATION_DURATION, type ConversationKind } from "../../src/engine/timeOfDay";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * 0066 (#1125) Extension 5 — LOOSE conversation durations (the `expressiveNonCollapse`-FOR-TIME gate).
 *
 * Per ADR 0005 applied to TIME: a scene's felt duration is OPEN-SET. The LLM proposes how long it took;
 * the engine COMMITS it BOUNDED to the scene KIND's range — never normalizing it into a single fixed value
 * that would flatten the creative read, but never 0 and never a day-skip either. Absent a proposal ⇒ the
 * kind BASELINE, BYTE-IDENTICAL to the pre-feature floor (the non-collapse proof: no proposal ⇒ the floor;
 * a proposal is honored within its bound). An engaged scene is NEVER cut by the clock — the duration only
 * ADVANCES time after the scene; it never ends one. Roles only.
 */

const KINDS: ConversationKind[] = ["passing", "casual", "game", "summit"];

afterEach(() => {
  GameSessionAdapter.setTimeOfDayEnabled(null);
});

describe("Extension 5 — the felt duration is loose but bounded (no collapse, no runaway)", () => {
  it("no proposal ⇒ the kind BASELINE (byte-identical to the pre-feature floor)", () => {
    for (const kind of KINDS) {
      expect(conversationHours(kind), `${kind}: absent ⇒ baseline`).toBe(CONVERSATION_DURATION.baselineHours[kind]);
      // a non-finite / zero / negative proposal also falls back to the baseline (never 0, never a day-skip)
      expect(conversationHours(kind, Number.NaN)).toBe(CONVERSATION_DURATION.baselineHours[kind]);
      expect(conversationHours(kind, 0)).toBe(CONVERSATION_DURATION.baselineHours[kind]);
      expect(conversationHours(kind, -3)).toBe(CONVERSATION_DURATION.baselineHours[kind]);
    }
  });

  it("a proposal WITHIN the kind range is HONORED exactly (the open-set is not normalized away)", () => {
    // a mid-range proposal passes through unchanged — the model's felt time is respected.
    for (const kind of KINDS) {
      const mid = (CONVERSATION_DURATION.minHours[kind] + CONVERSATION_DURATION.maxHours[kind]) / 2;
      expect(conversationHours(kind, mid)).toBe(mid);
    }
  });

  it("a proposal OUTSIDE the range is CLAMPED to the bound (never 0, never a day-skip)", () => {
    for (const kind of KINDS) {
      const lo = CONVERSATION_DURATION.minHours[kind];
      const hi = CONVERSATION_DURATION.maxHours[kind];
      expect(conversationHours(kind, 0.01)).toBe(lo);   // an absurdly short proposal floors at the min
      expect(conversationHours(kind, 999)).toBe(hi);    // a day-skip proposal caps at the max
      expect(conversationHours(kind, hi)).toBe(hi);
      expect(conversationHours(kind, lo)).toBe(lo);
    }
  });

  it("the ranges are ordered (passing ≤ casual ≤ game ≤ summit) and every baseline sits inside its bound", () => {
    let prev = 0;
    for (const kind of KINDS) {
      const b = CONVERSATION_DURATION.baselineHours[kind];
      expect(b).toBeGreaterThanOrEqual(CONVERSATION_DURATION.minHours[kind]);
      expect(b).toBeLessThanOrEqual(CONVERSATION_DURATION.maxHours[kind]);
      expect(b).toBeGreaterThanOrEqual(prev); // a longer kind takes at least as long
      prev = b;
    }
  });
});

describe("Extension 5 — the per-conversation clock advance honors the bounded felt duration", () => {
  it("cost depends ONLY on message count: a 'summit' label or a huge proposal bills exactly what a 'passing' one does (P4c - types emerge from length, never billed)", () => {
    const reach = (kind: ConversationKind, proposed?: number): number => {
      GameSessionAdapter.setTimeOfDayEnabled(true);
      const s = new GameSessionAdapter();
      s.createCharacter({ playerName: "The Player", seed: 7 });
      s.setPerConversationClockEnabled(true);
      s.advanceGame(); // 0111: close the premiere champagne circle
      s.advanceGame(); // start the day
      const before = s.snapshot().live?.nightDepth ?? 0;
      s.advanceClockPerConversation({ kind, proposedHours: proposed });
      const after = s.snapshot().live?.nightDepth ?? 0;
      GameSessionAdapter.setTimeOfDayEnabled(null);
      return after - before;
    };
    const passing = reach("passing");
    expect(reach("summit")).toBeCloseTo(passing, 9);
    expect(reach("summit", 999)).toBeCloseTo(passing, 9);
    expect(passing * 60).toBeCloseTo(5, 5);
  });

  it("with the per-conversation flag OFF, no felt duration advances the clock (byte-identical)", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: 7 });
    s.setPerConversationClockEnabled(false); // Extension 1/5 off
    s.advanceGame();
    const before = s.snapshot().live?.nightDepth ?? 0;
    for (let i = 0; i < 10; i++) s.advanceClockPerConversation({ kind: "summit", proposedHours: 4 });
    expect(s.snapshot().live?.nightDepth ?? 0, "no felt-duration advance when the flag is off").toBe(before);
  });
});
