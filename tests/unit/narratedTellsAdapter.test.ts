import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/** ORW-576 - the adapter: a played game's narrator sees the narrated tells (a withdrawn read now exists); a headless game keeps the old read; the persisted decision tells are never touched. Roles only. */
type Soul = { confidence?: number; distress?: number; emotionalState: number; volatility: number; emotionalHistory: number[]; tells?: unknown };
type Internals = {
  presence: Map<EntityId, string>; soulObj(id: EntityId): Soul | undefined; setNpcTellsEnabled(on: boolean): void;
  live?: { playedGame?: boolean };
  npcVoice(id: EntityId): { tells?: Array<{ kind: string }>; mood?: string } | null;
};
function stage(played: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(`n576-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  const s = sb.session as unknown as Internals;
  s.setNpcTellsEnabled(true);
  if (s.live) s.live.playedGame = played;
  const npc = sb.session.livingIds().filter((i) => i !== PLAYER)[0]!;
  s.presence.set(npc, s.presence.get(PLAYER)!);
  const soul = s.soulObj(npc)!;
  soul.distress = 0.95; soul.confidence = 0.5; soul.emotionalState = 0.3; soul.volatility = 0.4; soul.emotionalHistory = [0.3];
  delete soul.tells;
  return { s, npc, soul };
}
describe("ORW-576 adapter", () => {
  it("played: the narrator gets the withdrawn tell the old read could never reach", () => {
    const { s, npc } = stage(true);
    expect(s.npcVoice(npc)?.tells?.map((t) => t.kind)).toContain("withdrawn");
  });
  it("headless: the old read stands (no withdrawn from a floor-level confidence)", () => {
    const { s, npc } = stage(false);
    expect(s.npcVoice(npc)?.tells?.map((t) => t.kind) ?? []).not.toContain("withdrawn");
  });
  it("wall: no raw axis value reaches the voice view", () => {
    const { s, npc, soul } = stage(true);
    soul.distress = 0.8137;
    expect(JSON.stringify(s.npcVoice(npc))).not.toMatch(/0\.8137/);
  });
});
