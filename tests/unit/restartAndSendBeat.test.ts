import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/** ORW-507 (#2619, #2321). A restart forgets the prior season's last-seen mood words; the arrival/departure beat survives a bedtime during the send and dies at the first room change. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

describe("an in-place createCharacter restart (#2619)", () => {
  it("clears the last-seen mood words of the prior season", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", seed: 9 });
    const x = s as unknown as { seenMoods: Map<string, string> | null };
    x.seenMoods = new Map([["npc:stale-sentinel", "buoyant"]]);
    s.createCharacter({ playerName: "P2", seed: 9, confirmRestart: true });
    expect(x.seenMoods?.has("npc:stale-sentinel") ?? false).toBe(false);
  });
});

function setup() {
  GameSessionAdapter.setTimeOfDayEnabled(false);
  const sb = new GameSessionRegistry().sandboxFor(`send-beat-${Math.random()}`);
  sb.session.createCharacter({ playerName: "P", archetype: "floater", seed: 11 });
  sb.session.advanceGame();
  const s = sb.session as unknown as { presence: Map<string, string>; awakeNow(): Set<string> | null; timeOfDayEnabled: boolean };
  const npcs = sb.session.livingIds().filter((i) => i !== PLAYER);
  s.presence.set(PLAYER, "living-room");
  return { sb, s, npcs };
}

describe("whereabouts().sinceSend (#2321)", () => {
  it("names a houseguest who turned in during the send's clock step as departed", () => {
    const { sb, s, npcs } = setup();
    const a = npcs[0]!;
    for (const n of npcs) s.presence.set(n, "bathroom");
    s.presence.set(a, "living-room");
    sb.session.noteMessage({ messageId: "m1" }); // roster + awake set frozen: a is here and up
    // the clock step puts a to bed: a drops out of the awake set (and out of the visible room)
    const everyoneElse = new Set<string>([PLAYER, ...npcs.filter((n) => n !== a)]);
    (s as unknown as { awakeNow: () => Set<string> }).awakeNow = () => everyoneElse;
    const since = sb.session.whereabouts()?.sinceSend;
    expect(since?.departed.length, "the bedtime departure is reported").toBe(1);
  });
  it("leaving and returning during one reply does not revive the old roster", () => {
    const { sb, s, npcs } = setup();
    const [a, b] = npcs;
    for (const n of npcs) s.presence.set(n, "bathroom");
    s.presence.set(a!, "living-room");
    sb.session.noteMessage({ messageId: "m2" });
    sb.session.movePlayer("kitchen");
    s.presence.set(b!, "living-room");
    s.presence.set(PLAYER, "living-room"); // back, with b newly in the room
    expect(sb.session.whereabouts()?.sinceSend, "the stale send-beat is gone").toBeUndefined();
  });
});
