import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { Room } from "../../src/domain/house";

/**
 * PLAYTEST BUG (Ryne, 2026-11-06): "I sent a message when someone wasn't in the room, and when the reply came a person appeared and heard it as if I said it while they were there."
 * Cause: the turn-driven tick re-seats the house between the player's send (`noteMessage`) and the scene being recorded, and `recordInteraction` grounded its witnesses on the occupancy at RECORD time.
 * Contract: only houseguests in the player's room at SEND time can have heard it - a later arrival is no witness, gets no relationship fold, no memory, no recall. Roles only.
 */
type P = { presence: Map<string, Room>; noteMessage(r: { messageId: string }): unknown; movePlayer(room: string): unknown };
function game() {
  GameSessionAdapter.setTimeOfDayEnabled(false); // ORW-116: the clock now starts at the first player message; this contract is about the SEND-time roster, not the clock
  const sb = new GameSessionRegistry().sandboxFor(`sendroster-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); // the champagne-circle close (ORW-116: the exit advance is no longer a day-break, so it is not part of this setup)
  const p = sb.session as unknown as P;
  const npcs = sb.session.livingIds().filter((i) => i !== PLAYER);
  const [here, late, away] = npcs as [string, string, string];
  p.presence.set(PLAYER, "living-room"); p.presence.set(here, "living-room"); p.presence.set(late, "kitchen"); p.presence.set(away, "bedroom-a");
  return { sb, p, here, late, away };
}
const witnessesOf = (sb: ReturnType<typeof game>["sb"], eventId: string): readonly string[] => sb.engine.events.queryAll().find((e) => e.id === eventId)!.witnessSet;

afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

describe("only the people in the room when the player SENDS can have heard it", () => {
  it("a houseguest who walks in AFTER the send is not a witness of the scene (no fold, no memory path)", () => {
    const { sb, p, here, late } = game();
    p.noteMessage({ messageId: "m1" }); // the player sends; the roster at THIS moment is who heard
    p.presence.set(late, "living-room"); // ...then the tick re-seats the house: the late one walks in
    const { eventId } = sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, here, late], content: "I told them what I really think of the plan", kind: "strategy" });
    const w = witnessesOf(sb, eventId);
    expect(w, "the one who was there heard it").toContain(here);
    expect(w, "the late arrival did not").not.toContain(late);
  });
  it("co-presence expansion honours the send-time roster too (a bystander who arrived later is not added)", () => {
    const { sb, p, here, late } = game();
    p.noteMessage({ messageId: "m2" });
    p.presence.set(late, "living-room");
    const { eventId } = sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER], content: "a quiet word", kind: "bonding" });
    const w = witnessesOf(sb, eventId);
    expect(w).toContain(here);
    expect(w).not.toContain(late);
  });
  it("someone who LEFT after the send still heard it (they were there)", () => {
    const { sb, p, here } = game();
    p.noteMessage({ messageId: "m3" });
    p.presence.set(here, "kitchen"); // walks out after the player spoke
    const { eventId } = sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, here], content: "before you go", kind: "bonding" });
    expect(witnessesOf(sb, eventId)).toContain(here);
  });
  it("if the player MOVES rooms after the send, the send-time roster no longer applies (the new room's occupants are present)", () => {
    const { sb, p, late } = game();
    p.noteMessage({ messageId: "m4" });
    p.movePlayer("kitchen");
    const { eventId } = sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, late], content: "hi there", kind: "bonding" });
    expect(witnessesOf(sb, eventId)).toContain(late);
  });
  it("no message announced (legacy / not in message mode) => unchanged: the live occupancy decides", () => {
    const { sb, p, late } = game();
    p.presence.set(late, "living-room");
    const { eventId } = sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, late], content: "hello", kind: "bonding" });
    expect(witnessesOf(sb, eventId)).toContain(late);
  });
  it("wiring pin: the commands port reads the send-time roster provider", () => {
    expect(readFileSync("src/composition/registry.ts", "utf8")).toMatch(/setPresenceProvider\(\(\) => session\.sendTimeOccupancy\(\)\)/);
  });
});
