import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/** A51 (flag ORWELL_NPC_TELLS, default OFF): whereabouts.present carries one closed-vocabulary `tell` word for an in-room, awake houseguest. OFF => no key. Roles only. */
type S = {
  presence: Map<EntityId, string>;
  soulObj(id: EntityId): { confidence?: number; distress?: number; emotionalState: number; volatility: number } | undefined;
  setNpcTellsEnabled(on: boolean): void;
  houseEventInSession: () => unknown;
  whereabouts(): { present: Array<{ id: string; tell?: string }>; companions: Array<Record<string, unknown>>; nearby: Array<{ present: Array<{ id: string; tell?: string }> }> } | null;
};
function game() {
  const sb = new GameSessionRegistry().sandboxFor(`chip-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  const s = sb.session as unknown as S;
  s.houseEventInSession = () => null; // the day-1 set-piece gathers everyone; test the ordinary presence read
  const npcs = sb.session.livingIds().filter((i) => i !== PLAYER);
  const room = s.presence.get(PLAYER)!;
  for (const n of npcs.slice(0, 2)) s.presence.set(n, room);
  const soul = s.soulObj(npcs[0]!)!;
  soul.distress = 0.9; soul.confidence = 0.1; soul.emotionalState = 0.1; soul.volatility = 0.8;
  return { s, a: npcs[0]!, b: npcs[1]!, far: npcs[2]! };
}
const KINDS = new Set(["withdrawn", "tearful", "snapping", "brittle-calm", "giddy", "warm-open", "guarded", "restless"]);

describe("whereabouts tell chip (A51)", () => {
  it("OFF: no tell key anywhere", () => {
    const { s } = game();
    s.setNpcTellsEnabled(false);
    expect(JSON.stringify(s.whereabouts())).not.toContain('"tell"');
  });
  it("ON: the distressed in-room houseguest carries one closed word; a calm one and an out-of-room one carry none; no band/number rides", () => {
    const { s, a, b, far } = game();
    s.setNpcTellsEnabled(true);
    const w = s.whereabouts()!;
    const pa = w.present.find((p) => p.id === a)!;
    expect(KINDS.has(pa.tell!)).toBe(true);
    expect(w.present.find((p) => p.id === b)?.tell).toBeUndefined();
    expect(JSON.stringify(w.nearby)).not.toContain('"tell"');
    expect(JSON.stringify(w.companions)).not.toContain('"tell"');
    expect(w.present.find((p) => p.id === far)).toBeUndefined();
    expect(Object.keys(pa).sort()).toEqual(["id", "name", "tell"]);
  });
  it("ON but the houseguest is out of the player room: no chip", () => {
    const { s, a } = game();
    s.setNpcTellsEnabled(true);
    s.presence.set(a, s.presence.get(PLAYER) === "kitchen" ? "bedroom-a" : "kitchen");
    expect(JSON.stringify(s.whereabouts())).not.toContain('"tell"');
  });
});
