import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * ORW-1156 part 4: every one-shot release step is idempotent per idempotencyKey. A retried or duplicated call (a stream retry, a belt and a model both calling it, a replayed turn) must give the SAME
 * view and change the board ONCE: an arrival, a toast batch, the night's turnIn and its day recap. Roles only; no player or cast text.
 * What is NOT keyed (an advance with no key is a new step by design) is pinned too, so a future change cannot make a keyed retry advance twice.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function premiere(seed: number) {
  const s = new GameSessionRegistry().sandboxFor(`idem${seed}`).session as any;
  s.setPremiereEntrancesEnabled(true);
  s.createCharacter({ playerName: "P", seed });
  return s;
}
const stage = (s: any) => s.premiereIntros()?.entrance?.stage as string | undefined;
const arrived = (s: any) => s.premiereIntros()?.entrance?.index as number;
const spoke = (s: any) => s.snapshot().live.premiereEntrance.spoke.length as number;

describe("ORW-1156 part 4 - release steps are at-most-once per key", () => {
  it("an arrival: the same key twice is one arrival and the identical view", () => {
    const s = premiere(31);
    expect(stage(s)).toBe("entrances");
    const before = arrived(s);
    const a = s.advanceGame({ idempotencyKey: "arr-1" });
    const b = s.advanceGame({ idempotencyKey: "arr-1" });
    expect(arrived(s)).toBe(before + 1);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    s.advanceGame({ idempotencyKey: "arr-2" });
    expect(arrived(s)).toBe(before + 2);
  });

  it("a toast batch: the same key twice releases the batch once", () => {
    const s = premiere(32);
    for (let i = 0; i < 60 && stage(s) !== "toast"; i++) s.advanceGame();
    expect(stage(s)).toBe("toast");
    const n0 = spoke(s);
    const a = s.advanceGame({ idempotencyKey: "toast-1" });
    const n1 = spoke(s);
    const b = s.advanceGame({ idempotencyKey: "toast-1" });
    expect(n1).toBeGreaterThan(n0);
    expect(spoke(s)).toBe(n1);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const toasts = s.record.events().filter((e: any) => e.type === "toast-speech").length;
    s.advanceGame({ idempotencyKey: "toast-1" });
    expect(s.record.events().filter((e: any) => e.type === "toast-speech").length).toBe(toasts);
  });

  it("the circle's close: the same key twice closes it once and never re-opens it", () => {
    const s = premiere(33);
    for (let i = 0; i < 80 && stage(s) !== "done"; i++) s.advanceGame();
    expect(stage(s)).toBe("done");
    const snap = JSON.stringify(s.snapshot().live.premiereEntrance);
    s.advanceGame({ idempotencyKey: "after-close" });
    s.advanceGame({ idempotencyKey: "after-close" });
    expect(s.snapshot().live.champagneCircle).toBe("done");
    expect(JSON.stringify(s.snapshot().live.premiereEntrance)).toBe(snap);
  });

  function nightGame(seed: number) {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`idemN${seed}`).session as any;
    s.setPremiereEntrancesEnabled(true);
    s.createCharacter({ playerName: "P", seed });
    s.setPerConversationClockEnabled(true);
    for (let i = 0; i < 40 && s.getGameState().phase === "premiere"; i++) { if (s.advanceGame().pending) break; }
    for (let i = 0; i < 400 && !["night", "late-night"].includes(s.gameStatus().timeOfDay); i++) s.noteMessage({ messageId: `m${i}` });
    return s;
  }

  it("turnIn: the same key twice ends the night once, one recap, one day rolled", () => {
    const s = nightGame(34);
    const day0 = s.getGameState().dayNumber;
    const a = s.turnIn({ idempotencyKey: "bed-1" });
    expect(a.held).toBeUndefined();
    const day1 = s.getGameState().dayNumber;
    expect(day1).toBe(day0 + 1);
    const ledger = s.dayLedger().length;
    const b = s.turnIn({ idempotencyKey: "bed-1" });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(s.getGameState().dayNumber).toBe(day1);
    expect(s.dayLedger().length).toBe(ledger);
    expect(s.dailyRecap()?.day).toBe(a.dailyRecap?.day);
  });

  it("turnIn with no key right after a night ended is held or a no-op: it never builds a second recap or rolls a second day", () => {
    const s = nightGame(35);
    s.setBedtimeGateEnabled(true); // the played game's gate: a bed in the morning is held, not a second night
    const a = s.turnIn();
    expect(a.held).toBeUndefined();
    const day1 = s.getGameState().dayNumber;
    const recapDay = s.dailyRecap()?.day;
    const b = s.turnIn();
    expect(s.getGameState().dayNumber).toBe(day1);
    expect(s.dailyRecap()?.day).toBe(recapDay);
    expect(b.dailyRecap?.day === undefined || b.dailyRecap.day === recapDay).toBe(true);
  });
});
