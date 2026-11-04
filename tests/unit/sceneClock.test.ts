import { describe, it, expect, afterEach } from "vitest";
import { advanceClockPerScene, resetSceneClock, type LiveSeasonState } from "../../src/engine/liveSeason";
import { SCENE, WAKE_HOUR } from "../../src/engine/timeOfDay";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * Extension 6 (0066) — the SCENE-based clock: time advances per SCENE (room + co-present set), not per turn.
 * Model B "capped accumulation": turns inside one scene accrue toward `SCENE.capHours`; a new scene key
 * resets the cap. So a long conversation is a touch longer in-fiction, but turn count can never run the
 * clock away. Pure + deterministic (no rng); gated on the per-conversation clock ⇒ off is byte-identical.
 * Roles only; all fixtures generated.
 */

/** A minimal started-day live state (only the clock fields the scene advance reads/writes matter). */
function startedState(): LiveSeasonState {
  return { nightDepth: WAKE_HOUR } as unknown as LiveSeasonState;
}

describe("Extension 6 — advanceClockPerScene (pure Model-B accumulation)", () => {
  it("accumulates turns inside ONE scene at the pace floor; a PROPOSED duration (not the floor) is what the cap bounds (P2b)", () => {
    const s = startedState();
    const key = "scene:kitchen|npc:1,npc:2";
    for (let i = 0; i < 10; i++) advanceClockPerScene(s, key, SCENE.perExchangeHours);
    // 10 ordinary messages = one morning (4h) at the pace; every message billed at least the floor.
    expect((s.nightDepth ?? 0) - WAKE_HOUR).toBeCloseTo(10 * SCENE.minPerMessageHours, 5);
    // A single scene's PROPOSED felt time stays capped (the floor is a floor, not a loophole).
    const t = startedState();
    advanceClockPerScene(t, "scene:long", 99);
    expect((t.nightDepth ?? 0) - WAKE_HOUR).toBeCloseTo(SCENE.capHours, 5);
  });

  it("a NEW scene key resets the cap (a fresh scene's proposed time bills in full again)", () => {
    const s = startedState();
    advanceClockPerScene(s, "scene:A", 99);                       // scene A bills its full cap
    expect(s.sceneAccruedHours).toBeCloseTo(SCENE.capHours, 5);
    const afterA = s.nightDepth ?? 0;
    advanceClockPerScene(s, "scene:B", 2);                        // a different room / co-present set: fresh cap, the 2h proposal bills
    expect(s.sceneAccruedHours).toBeCloseTo(2, 5);
    expect((s.nightDepth ?? 0) - afterA).toBeCloseTo(2, 5);
  });

  it("bills a proposed felt duration on a scene's FIRST turn, then only the increment as it continues", () => {
    const s = startedState();
    advanceClockPerScene(s, "scene:X", 1.5); // first turn: a proposed 1.5h scene
    expect((s.nightDepth ?? 0) - WAKE_HOUR).toBeCloseTo(1.5, 5);
    advanceClockPerScene(s, "scene:X", SCENE.perExchangeHours); // same scene continues at the pace
    expect((s.nightDepth ?? 0) - WAKE_HOUR).toBeCloseTo(1.5 + SCENE.perExchangeHours, 5);
    expect(s.sceneAccruedHours).toBeCloseTo(1.5 + SCENE.perExchangeHours, 5);
  });

  it("resetSceneClock forgets the scene so the next turn opens a fresh one (a beat boundary)", () => {
    const s = startedState();
    for (let i = 0; i < 40; i++) advanceClockPerScene(s, "scene:A", SCENE.perExchangeHours); // max scene A
    resetSceneClock(s); // a beat interrupts
    expect(s.sceneKey).toBeUndefined();
    // The SAME key after a reset is treated as a brand-new scene (fresh cap), not a continuation.
    advanceClockPerScene(s, "scene:A", SCENE.perExchangeHours);
    expect(s.sceneAccruedHours).toBeCloseTo(SCENE.perExchangeHours, 5);
  });

  it("is a no-op before the day starts (nightDepth undefined) — the per-beat clock initializes the day", () => {
    const s = {} as unknown as LiveSeasonState; // no nightDepth
    advanceClockPerScene(s, "scene:A", SCENE.perExchangeHours);
    expect(s.nightDepth).toBeUndefined();
    expect(s.sceneAccruedHours).toBeUndefined();
  });
});

describe("Extension 6 — the adapter caps a single scene end-to-end", () => {
  afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

  it("ordinary messages in one scene bill the pace floor each (P2b) and never wrap the night", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("scene-cap");
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    sb.session.setPerConversationClockEnabled(true);
    sb.session.advanceGame(); // 0111: close the premiere champagne circle
    sb.session.advanceGame(); // start the day
    const start = sb.session.snapshot().live?.nightDepth ?? 0;
    for (let i = 0; i < 10; i++) sb.session.advanceClockPerConversation(); // one continuous scene
    const elapsed = (sb.session.snapshot().live?.nightDepth ?? 0) - start;
    expect(elapsed).toBeCloseTo(10 * SCENE.minPerMessageHours, 5);
    for (let i = 0; i < 200; i++) sb.session.advanceClockPerConversation();   // spam: the clock clamps at the bitter end, never wraps without the player's turnIn
    expect(sb.session.snapshot().live?.nightDepth ?? 0).toBeLessThan(32); // DAY_END (8am next day) — clamped, never wrapped
  });

  it("is INERT when the master clock is off (calibration spine): scene fields never set, no advance", () => {
    GameSessionAdapter.setTimeOfDayEnabled(false);
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("scene-off");
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    sb.session.setPerConversationClockEnabled(true);
    sb.session.advanceGame();
    const before = sb.session.snapshot().live?.nightDepth;
    for (let i = 0; i < 10; i++) sb.session.advanceClockPerConversation();
    const live = sb.session.snapshot().live;
    expect(live?.nightDepth).toBe(before);          // nothing moved
    expect(live?.sceneKey).toBeUndefined();          // no scene tracked
    expect(live?.sceneAccruedHours).toBeUndefined(); // byte-identical to pre-Extension-6
  });
});
