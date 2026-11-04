import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { shapeMessageHours, PACE, MESSAGES_PER_MORNING } from "../../src/engine/sleepConstants";

/**
 * P4 item 2 (rehearsal #3: a morning took ~3-6 messages, not the ~10 the pace constant targets). The narrator PROPOSES a felt duration for each scene it records
 * (`feltMinutes`) and that proposal REPLACED the floor — so ordinary chat billed 1-1.5h a message. An ORDINARY message's proposal is now capped (PACE.ordinaryMaxHours);
 * only a genuinely long scene (a strategy summit, >= PACE.summitMinHours) spends its full proposed time. Measured with a scripted set of ordinary messages. Roles only.
 */
describe("shapeMessageHours (pure)", () => {
  it("caps an ordinary proposal, leaves a floor-sized one alone, and lets a summit spend its full time", () => {
    expect(shapeMessageHours(0.25)).toBe(0.25);
    expect(shapeMessageHours(0.5)).toBe(0.5);
    expect(shapeMessageHours(1)).toBe(PACE.ordinaryMaxHours);
    expect(shapeMessageHours(1.25)).toBe(PACE.ordinaryMaxHours);
    expect(shapeMessageHours(PACE.summitMinHours)).toBe(PACE.summitMinHours);
    expect(shapeMessageHours(3)).toBe(3);
  });
});

describe("a scripted ordinary-chat morning is ~8-12 messages; a summit spends more", () => {
  afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
  function morning(): GameSessionAdapter {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`pace-${Math.random()}`).session;
    s.createCharacter({ playerName: "P", archetype: "floater", seed: 7 });
    s.setPerConversationClockEnabled(true);
    s.advanceGame(); s.advanceGame();                 // premiere -> the day starts at 8am
    return s;
  }
  // the felt durations an LLM plausibly proposes for ordinary chat (hours): quick words to ~75-minute heart-to-hearts, never a long summit
  const ORDINARY = [0.5, 0.75, 1, 0.5, 1.25, 0.75, 1, 0.5, 1, 0.75, 1.25, 0.5, 1, 0.75, 1];
  const hour = (s: GameSessionAdapter): number => s.snapshot().live?.nightDepth ?? 0;

  it("ordinary messages bring the 12:00 afternoon event in after 8-12 messages (was ~4-5 unshaped)", () => {
    const s = morning();
    expect(hour(s)).toBe(8);
    let n = 0;
    while (hour(s) < 12 - 1e-9 && n < 40) {
      s.stashPendingFeltHours(ORDINARY[n % ORDINARY.length]!);
      s.advanceClockPerConversation();
      n++;
    }
    expect(n, `a chat morning took ${n} messages`).toBeGreaterThanOrEqual(8);
    expect(n).toBeLessThanOrEqual(12);
    expect(MESSAGES_PER_MORNING).toBeGreaterThanOrEqual(8);
  });

  it("a long strategy summit still spends its full proposed time", () => {
    const s = morning();
    s.stashPendingFeltHours(2.5);
    s.advanceClockPerConversation();
    expect(hour(s) - 8).toBeCloseTo(2.5, 5);
  });
});
