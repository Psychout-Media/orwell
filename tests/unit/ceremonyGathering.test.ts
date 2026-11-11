import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-247: a ceremony (nominations / veto ceremony / eviction) moves the houseguests for real. The engine presence map, whereabouts() (widget + narrator) and the witness roster all agree that the house is
 * in the ceremony room; they stay for the ceremony and then disperse on their own through the calm tick (a capped number of movers per tick), never all at once. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
type Internals = { presence: Map<string, string>; live: { pending?: { kind: string } | null } };
function setup() {
  GameSessionAdapter.setTimeOfDayEnabled(false);
  const sb = new GameSessionRegistry().sandboxFor(`ceremony-gather-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 21 });
  sb.session.advanceGame(); // leave the premiere champagne circle
  const s = sb.session as unknown as Internals;
  const npcs = sb.session.livingIds().filter((i) => i !== PLAYER);
  // scatter everyone to distinct side rooms
  const rooms = ["kitchen", "bathroom", "bedroom-a", "bedroom-b", "backyard", "lounge", "hoh-room", "storage-room"];
  npcs.forEach((id, i) => s.presence.set(id, rooms[i % rooms.length]!));
  s.presence.set(PLAYER, "kitchen");
  return { sb, s, npcs };
}
const startCeremony = (s: Internals, kind: string) => { s.live.pending = { kind }; };

describe("ceremony gathering (ORW-247)", () => {
  it("moves every active houseguest, and the player, into the ceremony room for a nominations ceremony", () => {
    const { sb, s, npcs } = setup();
    startCeremony(s, "nominations");
    const w = sb.session.whereabouts()!;
    expect(w.room).toBe("living-room");
    expect(w.houseEvent?.kind).toBe("nominations");
    for (const id of npcs) expect(s.presence.get(id)).toBe("living-room"); // the engine truth moved, not just the view
    expect(s.presence.get(PLAYER)).toBe("living-room");
    expect(w.present.length).toBe(npcs.length);
  });
  it("widget view, engine presence and the witness roster agree during the ceremony", () => {
    const { sb, s, npcs } = setup();
    startCeremony(s, "veto-decision");
    const w = sb.session.whereabouts()!;
    const wit = sb.session.witnessOccupancy()!;
    expect(w.houseEvent?.kind).toBe("veto-ceremony");
    for (const id of npcs) expect(wit.get(id)).toBe(w.room);
    expect(new Set(w.present.map((p) => p.id))).toEqual(new Set(npcs));
  });
  it("holds everyone in place while the ceremony runs (a tick does not scatter them)", () => {
    const { sb, s, npcs } = setup();
    startCeremony(s, "eviction-vote");
    sb.session.whereabouts();
    for (let i = 0; i < 4; i++) sb.session.presenceTick();
    for (const id of npcs) expect(s.presence.get(id)).toBe("living-room");
  });
  it("disperses on its own after the ceremony: gradually, not all at once", () => {
    const { sb, s, npcs } = setup();
    startCeremony(s, "nominations");
    sb.session.whereabouts();
    s.live.pending = null; // the ceremony resolves
    sb.session.presenceTick();
    const stillThere = npcs.filter((id) => s.presence.get(id) === "living-room").length;
    expect(stillThere).toBeGreaterThan(npcs.length / 2); // a calm tick moves only a few
    for (let i = 0; i < 40; i++) sb.session.presenceTick();
    const later = npcs.filter((id) => s.presence.get(id) === "living-room").length;
    expect(later).toBeLessThan(npcs.length); // they drift apart over time
  });
  it("does not re-gather a house that has already dispersed for the same ceremony", () => {
    const { sb, s, npcs } = setup();
    startCeremony(s, "nominations");
    sb.session.whereabouts();
    s.live.pending = null;
    for (let i = 0; i < 40; i++) sb.session.presenceTick();
    startCeremony(s, "nominations"); // a NEW ceremony later gathers again
    sb.session.whereabouts();
    for (const id of npcs) expect(s.presence.get(id)).toBe("living-room");
  });
});

describe("a ceremony an NPC runs (no player pending) still gathers the house (ORW-247b)", () => {
  type Adv = { advanceView(ev: { beat: string; content: string; participants: string[] } | null): unknown };
  const resolved = (sb: { session: unknown }, beat: string) => (sb.session as unknown as Adv).advanceView({ beat, content: "x", participants: [] });
  it("gathers in the living room while the resolved nominations beat is the live scene, then lets go once the player speaks", () => {
    const { sb, s, npcs } = setup();
    s.live.pending = null;
    resolved(sb, "nominations");
    const w = sb.session.whereabouts()!;
    expect(w.houseEvent?.kind).toBe("nominations");
    expect(w.room).toBe("living-room");
    for (const id of npcs) expect(s.presence.get(id)).toBe("living-room");
    sb.session.noteMessage({ messageId: "after-noms" });
    expect(sb.session.whereabouts()?.houseEvent).toBeUndefined();
    for (let i = 0; i < 40; i++) sb.session.presenceTick();
    expect(npcs.filter((id) => s.presence.get(id) === "living-room").length).toBeLessThan(npcs.length);
  });
  it("covers the veto ceremony and an eviction too, and a non-ceremony beat clears it", () => {
    const { sb, s } = setup();
    s.live.pending = null;
    resolved(sb, "veto-ceremony");
    expect(sb.session.whereabouts()?.houseEvent?.kind).toBe("veto-ceremony");
    resolved(sb, "eviction");
    expect(sb.session.whereabouts()?.houseEvent?.kind).toBe("eviction");
    resolved(sb, "hoh-competition");
    expect(sb.session.whereabouts()?.houseEvent).toBeUndefined();
  });
});
