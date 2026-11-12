import { describe, it, expect, afterEach } from "vitest";
import { toDayTwoMorning } from "../support/dayTwoMorning";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-303 - a player who has LEFT the game (evicted: a juror, or a spectator) must never be held by the A65 schedule gate. Their clock only moves with messages an outsider does not send and
 * turnIn is a no-op for them, so the hold could never lift: the sentinel (ORW-299) froze on seeds 10-14 for exactly that reason. The gate still holds an ACTIVE player (the contrast case).
 * Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

function playedGame(): GameSessionAdapter {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`left-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 7 });
  s.setPerConversationClockEnabled(true);
  toDayTwoMorning(s);
  (s as unknown as { noteMessage(r: { messageId: string }): unknown }).noteMessage({ messageId: "open" }); // a PLAYED game
  s.setAdvanceGateEnabled(true);
  return s;
}

describe("ORW-303 - the schedule gate does not hold a player who has left", () => {
  it("contrast: an ACTIVE player is held before the milestone is due", () => {
    const s = playedGame();
    const v = s.advanceGame();
    expect(v.held, "the gate is on and the next milestone is not due").toBeDefined();
  });
  it("an evicted player (a juror or spectator-to-be) is never held on the schedule: the season keeps moving", () => {
    const s = playedGame();
    const core = JSON.parse(JSON.stringify(s.snapshot())) as { live: { evictionOrder: string[]; active: string[] } };
    core.live.evictionOrder.push(PLAYER);
    core.live.active = core.live.active.filter((id) => id !== PLAYER);
    s.restore(core as never);
    let seq = s.getGameState().beatSeq;
    let moved = 0;
    for (let i = 0; i < 60; i++) {
      const v = s.advanceGame();
      expect((v as { held?: { reason?: string } }).held?.reason, `advance ${i}`).not.toBe("schedule");
      if (v.pending && v.pending.kind !== "ceremony-step") break; // a player decision card is outside this test
      if (v.beatSeq !== seq) { moved++; seq = v.beatSeq; }
    }
    expect(moved, "the beats keep committing for a player who has left").toBeGreaterThan(5);
  });
});
