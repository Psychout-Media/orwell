import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-249: the engine re-seats the house after the player's message, so the narrator (handed the send-time roster) and the widget (live) could disagree. `whereabouts().sinceSend` names who walked in and
 * who left the player's room since the send, so the turn carries a short arrival/departure beat and story + widget change together. Names only; absent when nothing changed. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
function setup() {
  GameSessionAdapter.setTimeOfDayEnabled(false); // the clock is not the subject here
  const sb = new GameSessionRegistry().sandboxFor(`since-send-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 11 });
  sb.session.advanceGame(); // leave the premiere champagne circle (a whole-house event overrides whereabouts)
  const s = sb.session as unknown as { presence: Map<string, string>; presenceZone?: unknown };
  const npcs = sb.session.livingIds().filter((i) => i !== PLAYER);
  s.presence.set(PLAYER, "living-room");
  return { sb, s, npcs };
}
describe("whereabouts().sinceSend (ORW-249)", () => {
  it("absent before any send, and when nothing changed after one", () => {
    const { sb } = setup();
    expect(sb.session.whereabouts()?.sinceSend).toBeUndefined();
    sb.session.noteMessage({ messageId: "m1" });
    expect(sb.session.whereabouts()?.sinceSend).toBeUndefined();
  });
  it("names a houseguest who walked in after the send, and one who left", () => {
    const { sb, s, npcs } = setup();
    const room = "living-room";
    const [a, b] = npcs;
    s.presence.set(a!, room); s.presence.set(b!, "bathroom");
    sb.session.noteMessage({ messageId: "m2" }); // roster frozen: a here, b not
    s.presence.set(a!, "bathroom"); s.presence.set(b!, room); // the tick re-seats: a leaves, b walks in
    const since = sb.session.whereabouts()!.sinceSend!;
    const nameOf = (id: string) => sb.session.whereabouts()!.present.find((p) => p.id === id)?.name;
    expect(since.arrived).toEqual([nameOf(b!)]);
    expect(since.departed.length).toBe(1);
    expect(since.arrived.join()).not.toMatch(/\d/);
  });
  it("is dropped when the player changes rooms (the old roster is stale)", () => {
    const { sb, s, npcs } = setup();
    s.presence.set(npcs[0]!, s.presence.get(PLAYER)!);
    sb.session.noteMessage({ messageId: "m3" });
    s.presence.set(npcs[1]!, s.presence.get(PLAYER)!);
    s.presence.set(PLAYER, s.presence.get(PLAYER) === "kitchen" ? "bathroom" : "kitchen");
    expect(sb.session.whereabouts()?.sinceSend).toBeUndefined();
  });
});
