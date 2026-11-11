import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { SCENE, CLOCK } from "../../src/engine/sleepConstants";
import { PLAYER } from "../../src/domain/ids";

/**
 * Phase 2 (duration-based clock) — a recorded social scene carries the LLM's proposed felt duration
 * (`feltMinutes`), and the day clock advances by that BOUNDED duration on the next per-turn tick instead
 * of the flat floor. So time tracks the play the player actually did ("a quick word" vs "a long summit").
 *
 * Calibration-safe by construction: the advance rides `advanceClockPerConversation`, self-gated on the
 * master clock — the seeded juryReach/UAT sims run clock-OFF, so `feltMinutes` is fully inert there
 * (proven here). Roles only; all fixtures generated. No fold, no number crosses to the player.
 */

const SEED = 7;

afterEach(() => {
  GameSessionAdapter.setTimeOfDayEnabled(null);
});

/** A wired sandbox with the clock + per-conversation extension ON, the day started, and one NPC id. */
function startedWithClock(): { session: ReturnType<GameSessionRegistry["sandboxFor"]>["session"]; commands: ReturnType<GameSessionRegistry["sandboxFor"]>["commands"]; npc: string } {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor("felt");
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
  sb.session.setPerConversationClockEnabled(true);
  sb.session.advanceGame(); // 0111: close the premiere champagne circle
  sb.session.advanceGame(); // start the day (initializes the clock)
  const npc = [...sb.session.livingIds()].find((id) => id !== PLAYER)!;
  return { session: sb.session, commands: sb.commands, npc };
}

const depth = (s: { snapshot: () => { live?: { nightDepth?: number } | null } }): number => s.snapshot().live?.nightDepth ?? 0;

describe("Phase 2 — feltMinutes drives the per-conversation clock", () => {
  it("a long proposed scene bills NOTHING extra: the message still costs exactly the pace (P4c)", () => {
    const { session, commands, npc } = startedWithClock();
    const start = depth(session);
    commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc], content: "a long strategy summit", feltMinutes: 120 });
    session.advanceClockPerConversation(); // the orchestrator's per-turn tick consumes the stash
    expect(depth(session) - start).toBeCloseTo(SCENE.perExchangeHours, 5); // 120 min proposed => still one message's tick
  });

  it("clamps an absurd proposal to the sane envelope (anti-abuse)", () => {
    const { session, commands, npc } = startedWithClock();
    const start = depth(session);
    commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc], content: "a quick word", feltMinutes: 6000 });
    session.advanceClockPerConversation();
    expect(depth(session) - start).toBeCloseTo(SCENE.perExchangeHours, 5); // an absurd proposal bills nothing
  });

  it("falls back to the small per-exchange increment when no feltMinutes is proposed (Extension 6 scene model)", () => {
    const { session, commands, npc } = startedWithClock();
    const start = depth(session);
    commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc], content: "an untimed scene" });
    session.advanceClockPerConversation();
    expect(depth(session) - start).toBeCloseTo(SCENE.perExchangeHours, 5); // the per-exchange increment, not the old 0.5h floor
  });

  it("a later tick in the SAME scene accrues only the per-exchange increment (capped accumulation, not a fresh floor)", () => {
    const { session, commands, npc } = startedWithClock();
    commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc], content: "a chat", feltMinutes: 90 });
    session.advanceClockPerConversation(); // this scene's FIRST turn: bills the 90-min stash (1.5h)
    const mid = depth(session);
    session.advanceClockPerConversation(); // SAME scene (occupancy unchanged) ⇒ just the per-exchange increment
    expect(depth(session) - mid).toBeCloseTo(SCENE.perExchangeHours, 5);
  });

  it("discards a duration stashed while gated — it never leaks into a later enabled turn", () => {
    // Bug repro: a scene carries feltMinutes while the per-conversation clock is OFF, so the tick's clock
    // gate is a no-op. The stash must be DISCARDED there — otherwise a later turn (once the clock is on)
    // consumes the STALE duration instead of the floor.
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("felt-gated-leak");
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: SEED });
    sb.session.setPerConversationClockEnabled(false); // per-conversation clock OFF ⇒ the tick self-gates to a no-op
    sb.session.advanceGame(); // 0111: close the premiere champagne circle
    sb.session.advanceGame(); // start the day (master clock initialized) but per-conversation clock still OFF
    const npc = [...sb.session.livingIds()].find((id) => id !== PLAYER)!;

    // Record a felt duration while the per-conversation clock is gated OFF, then tick (gated no-op).
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc], content: "a long summit while gated", feltMinutes: 120 });
    const beforeGatedTick = depth(sb.session);
    sb.session.advanceClockPerConversation(); // gated no-op — must NOT advance AND must discard the stash
    expect(depth(sb.session)).toBeCloseTo(beforeGatedTick, 5); // gated ⇒ nothing moved

    // Now enable the clock and tick with NO new scene: the stale 2h must be gone ⇒ the floor, not 2h.
    sb.session.setPerConversationClockEnabled(true);
    const beforeEnabledTick = depth(sb.session);
    sb.session.advanceClockPerConversation();
    expect(depth(sb.session) - beforeEnabledTick).toBeCloseTo(SCENE.perExchangeHours, 5); // per-exchange increment, NOT the stale 2h
  });

  it("is INERT when the master clock is off (the calibration-spine guarantee)", () => {
    GameSessionAdapter.setTimeOfDayEnabled(false);
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("felt-off");
    sb.session.createCharacter({ playerName: "The Player", seed: SEED });
    sb.session.setPerConversationClockEnabled(true);
    sb.session.advanceGame();
    const npc = [...sb.session.livingIds()].find((id) => id !== PLAYER)!;
    const before = sb.session.snapshot().live?.nightDepth;
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc], content: "x", feltMinutes: 200 });
    sb.session.advanceClockPerConversation();
    expect(sb.session.snapshot().live?.nightDepth).toBe(before); // clock off ⇒ nothing moves
  });
});
