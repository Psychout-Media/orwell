import { describe, it, expect, afterEach } from "vitest";
import { toDayTwoMorning } from "../support/dayTwoMorning";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * ORW-296 - the provider's prompt prefix cache reuses only the identical PREFIX of consecutive requests, so the
 * per-turn volatile GAME CONTEXT lines (clock, whereabouts, present knowledge, ...) must sit AFTER the stable
 * ones (the roster). Roles only. Reordering only: the multiset of lines must not change.
 *
 * Measured on this pair (a started game, one in-game clock step apart):
 *   BEFORE the reorder: common prefix = 0.6792 (49,012 of 72,160 chars; first diff = the Clock line near the top of GAME CONTEXT).
 *   AFTER: 0.8705 (62,817 of 72,160). The line multiset was verified identical before/after by sorting the lines of the same prompt.
 */
function startedGame() {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`cache-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 7 });
  s.setPerConversationClockEnabled(true);
  toDayTwoMorning(s);
  return s;
}
const MIN_SHARED = 0.85; // measured 0.8705, minus a small margin
const prompt = (s: GameSessionAdapter) => s.getMomentPrompt({ moment: "social" }).systemPrompt;
const common = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

describe("ORW-296 - narrator prompt cache stability", () => {
  it("two consecutive prompts share a long common prefix (stable text before volatile text)", () => {
    const s = startedGame();
    const a = prompt(s);
    for (let i = 0; i < 3; i++) s.advanceClockPerConversation();
    const b = prompt(s);
    expect(a).not.toBe(b); // the clock moved, so something per-turn really differs
    const frac = common(a, b) / Math.min(a.length, b.length);
    expect(frac).toBeGreaterThanOrEqual(MIN_SHARED);
  });
  it("the stable roster precedes every per-turn GAME CONTEXT line", () => {
    const a = prompt(startedGame());
    const roster = a.indexOf("this roster is the single source of truth");
    expect(roster).toBeGreaterThan(0);
    for (const volatile of ["\n- Week:", "\n- Phase:", "\n- Time of day:", "\n- Clock:", "\n- Houseguests remaining:"]) {
      const at = a.indexOf(volatile);
      if (at >= 0) expect(at, volatile).toBeGreaterThan(roster);
    }
  });
  it("the frozen world block precedes GAME CONTEXT, so it is part of the cached prefix", () => {
    const s = startedGame();
    (s as unknown as { recordWorldSnapshot(r: unknown): unknown }).recordWorldSnapshot({ slices: { news: ["a headline the house half-remembers"], mood: "restless" } });
    const a = prompt(s);
    const world = a.indexOf("THE WORLD YOU ALL MOVED IN WITH");
    const ctx = a.indexOf("GAME CONTEXT:");
    expect(world, "the world block is in the prompt").toBeGreaterThan(0);
    expect(world).toBeLessThan(ctx);
    for (let i = 0; i < 3; i++) s.advanceClockPerConversation();
    const b = prompt(s);
    expect(common(a, b), "the shared prefix runs past the world block").toBeGreaterThan(world + 200);
  });
});
