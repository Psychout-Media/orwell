import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * ORW-1064 (audit A6): a room name that is not ONE room never silently becomes the first candidate. movePlayer, recordHouseguestMove and askToTalkAlone refuse explicitly (nothing moves, the candidates come back, a counter records it).
 */
function started() {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "The Player", seed: 41 });
  const live = (s as unknown as { live: { champagneCircle?: string; playedGame?: boolean; talkAsk?: { npc: string; until: number } } }).live;
  live.champagneCircle = undefined;
  live.playedGame = true;
  s.movePlayer("living-room");
  return { s, live };
}
const npcIn = (s: GameSessionAdapter) => s.livingIds().find((id) => id !== "player")!;

describe("ORW-1064: an ambiguous or unknown room is an explicit refusal", () => {
  it("movePlayer: 'bedroom' from the living room moves nobody, names the candidates, and is counted", () => {
    const { s } = started();
    const w = s.movePlayer("bedroom");
    expect(w!.room).toBe("living-room");
    expect(w!.moveRefused).toMatchObject({ reason: "ambiguous-room", asked: "bedroom" });
    expect(w!.moveRefused!.candidates!.length).toBeGreaterThan(1);
    expect(s.moveRefusalCounts()["movePlayer:ambiguous-room"]).toBe(1);
  });
  it("movePlayer: an unknown room is distinguishable from 'already there'", () => {
    const { s } = started();
    const unknown = s.movePlayer("the moon base");
    expect(unknown!.moveRefused).toMatchObject({ reason: "unknown-room" });
    expect(s.movePlayer("living-room")!.moveRefused, "already there is no refusal").toBeUndefined();
    expect(s.moveRefusalCounts()["movePlayer:unknown-room"]).toBe(1);
  });
  it("recordHouseguestMove: an ambiguous room is illegal with the candidates, and the houseguest stays", () => {
    const { s } = started();
    const id = npcIn(s);
    s.recordHouseguestMove(id, "kitchen");
    const before = s.occupancy()!.get(id);
    const r = s.recordHouseguestMove(id, "bedroom");
    expect(r.status).toBe("illegal");
    expect(r.reason).toBe("ambiguous-room");
    expect(r.candidates!.length).toBeGreaterThan(1);
    expect(s.occupancy()!.get(id)).toBe(before);
    expect(s.recordHouseguestMove(id, "the moon base").reason).toBe("unknown-room");
  });
  it("askToTalkAlone: an ambiguous named room is refused, never 'accepted' in another room", () => {
    const { s, live } = started();
    const id = npcIn(s);
    live.talkAsk = { npc: id, until: 1e9 };
    const r = s.askToTalkAlone({ npcId: id, room: "bedroom" });
    expect(r!.outcome).toBe("ambiguous-room");
    expect(r!.candidates!.length).toBeGreaterThan(1);
    expect(s.whereabouts()!.room).toBe("living-room");
    expect(s.moveRefusalCounts()["askToTalkAlone:ambiguous-room"]).toBe(1);
  });
});
