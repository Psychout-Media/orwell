import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Room, Zone } from "../../src/domain/house";
import type { GameHouse } from "../../src/engine/characterFactory";
import { renderGameContext, BASE_GAME_MASTER_PROMPT } from "../../src/engine/momentPrompts";

/**
 * ORW-1167 - a confidence is heard by the people in earshot, and the narrator is told so plainly. The engine seats each houseguest in a zone of the yard (0077): another zone is seen, not heard. `whereabouts.present` marks them
 * `outOfEarshot`; the game context lists them and says never private; the base prompt carries the rule. Roles only.
 */
function seated(room: Room, zones: Array<[EntityId, Zone]>): { session: GameSessionAdapter; ids: EntityId[] } {
  const session = new GameSessionAdapter();
  session.createCharacter({ playerName: "The Player", seed: 31 });
  const house = (session as unknown as { house: GameHouse }).house;
  (session as unknown as { live?: { champagneCircle?: string } }).live!.champagneCircle = undefined;
  const ids = house.npcs.map((n) => n.id);
  const p = session as unknown as { presence: Map<EntityId, Room>; presenceZone: Map<EntityId, Zone> | null };
  p.presence = new Map<EntityId, Room>([[PLAYER, room], [ids[0]!, room], [ids[1]!, room]]);
  p.presenceZone = new Map<EntityId, Zone>(zones);
  return { session, ids };
}

describe("ORW-1167 earshot on the whereabouts read and in what the narrator is told", () => {
  it("flags a houseguest in another zone of the yard as out of earshot, and not the one in the player's zone", () => {
    const { session, ids } = seated("backyard", []);
    const p = session as unknown as { presenceZone: Map<EntityId, Zone> };
    p.presenceZone = new Map<EntityId, Zone>([[PLAYER, "poolside"]]);
    p.presenceZone.set(ids[0]!, "poolside");
    p.presenceZone.set(ids[1]!, "workout");
    const w = session.whereabouts()!;
    const by = new Map(w.present.map((x) => [x.id, x]));
    expect(by.get(ids[0]!)?.outOfEarshot).toBeUndefined();
    expect(by.get(ids[1]!)?.outOfEarshot).toBe(true);
  });

  it("the game context names who is out of earshot and says a shared room is not private", () => {
    const { session, ids } = seated("backyard", []);
    const p = session as unknown as { presenceZone: Map<EntityId, Zone> };
    p.presenceZone = new Map<EntityId, Zone>([[PLAYER, "poolside"], [ids[0]!, "poolside"], [ids[1]!, "workout"]]);
    const view = { ...session.getGameState(), whereabouts: session.whereabouts() } as unknown as Parameters<typeof renderGameContext>[0];
    const ctx = renderGameContext(view);
    expect(ctx).toMatch(/OUT OF EARSHOT[^\n]*\n?[^\n]*/);
    expect(ctx).toContain("NOT a private conversation");
    expect(ctx).toContain("askToTalkAlone");
  });

  it("an un-zoned room has no far end: everyone there hears and nobody is flagged", () => {
    const { session } = seated("kitchen", []);
    const w = session.whereabouts()!;
    expect(w.present.every((x) => x.outOfEarshot === undefined)).toBe(true);
    const ctx = renderGameContext({ ...session.getGameState(), whereabouts: w } as unknown as Parameters<typeof renderGameContext>[0]);
    expect(ctx).not.toContain("OUT OF EARSHOT");
    expect(ctx).toContain("NOT a private conversation");
  });

  it("the base prompt carries the rule: never private, an out-of-earshot person does not join", () => {
    const all = JSON.stringify(BASE_GAME_MASTER_PROMPT);
    expect(all).toContain("outOfEarshot");
    expect(all).toContain("Never promise privacy in a shared room");
  });
});
