import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";
import { PLAYER, type EntityId } from "../../src/domain/ids";

/** ORW-1076 (Ryne 2026-11-26): the player may go up to the HOH room on their own; the HOH may say no. Roles only. */
interface Inside { presence: Map<EntityId, string>; awakeNow: () => Set<EntityId> | null; live: { week: number; hoh?: EntityId; hohRoom?: { done: string[]; playerUp?: string[] } }; rel: { edge(a: EntityId, b: EntityId): { trust: number; affinity: number } }; ceremony: { hoh?: EntityId } }

function reign() {
  const g = playedGame({ seed: 3 });
  const x = g.s as unknown as Inside;
  g.playUntil(() => !!x.ceremony.hoh && x.ceremony.hoh !== PLAYER && !g.s.getGameState().pending && !g.s.whereabouts()?.houseEvent, 4000, "an NPC reign with the house free");
  const hoh = x.ceremony.hoh!;
  x.awakeNow = () => null;
  const away = (): void => { x.presence.set(PLAYER, "living-room"); };
  const mood = (v: number): void => { const e = x.rel.edge(hoh, PLAYER); e.trust = v; e.affinity = v; };
  away();
  return { g, x, hoh, away, mood };
}
const room = (x: Inside): string | undefined => x.presence.get(PLAYER);

describe("going up to the HOH room on your own", () => {
  it("the first visit of the reign stands on the open invitation; after that a cold HOH says no and a warm one lets you in", () => {
    const { g, x, hoh, away, mood } = reign();
    mood(0.1);
    g.s.movePlayer("hoh-room");
    expect(room(x), "the room was opened to the whole house").toBe("hoh-room");
    away();
    x.presence.set(hoh, "hoh-room");
    const refused = g.s.movePlayer("hoh-room")!;
    expect(room(x)).toBe("living-room");
    expect(refused.moveRefused).toMatchObject({ reason: "hoh-door" });
    expect(refused.moveRefused!.detail).toMatch(/did not let them in/);
    expect(JSON.stringify(refused.moveRefused)).not.toMatch(/\d\.\d/);
    mood(0.8);
    g.s.movePlayer("hoh-room");
    expect(room(x)).toBe("hoh-room");
  });
  it("nobody in there, or asleep, and the door stays shut; the intent-first move says why", () => {
    const { g, x, hoh, away, mood } = reign();
    g.s.movePlayer("hoh-room"); away(); mood(0.9);
    x.presence.set(hoh, "kitchen");
    expect(g.s.movePlayer("hoh-room")!.moveRefused!.detail).toMatch(/not in there/);
    x.presence.set(hoh, "hoh-room");
    x.awakeNow = () => new Set<EntityId>([PLAYER]);
    const r = g.s.resolvePlayerMove({ text: "I go up to the HOH room" });
    expect(room(x)).toBe("living-room");
    expect(r.playerMove).toMatchObject({ refused: true });
    expect((r.playerMove as { reason: string }).reason).toMatch(/asleep/);
  });
  it("the HOH themselves walks straight in", () => {
    const { g, x } = reign();
    x.ceremony.hoh = PLAYER;
    g.s.movePlayer("hoh-room");
    expect(room(x)).toBe("hoh-room");
  });
});
