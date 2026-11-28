import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import { roomOfBed, type BedsState } from "../../src/engine/beds";
import { headcountLines } from "../../src/engine/momentPrompts";

/** ORW-1154 (Ryne, prod 2026-11-28): "where's everyone going when they're asleep? am I in a room alone?" Sleepers were seated in their own beds only AT the player's turnIn; all night
 * before it they stayed wherever the tick left them (the kitchen) and the player's room read "alone" with a sleeper in a bed beside them. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));
type Live = { timeOfDay?: string; nightDepth?: number; playedGame?: boolean; hoh?: string | null; beds?: BedsState; evictionOrder: string[] };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;

function game() {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`sleepers-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 7 });
  s.setPerConversationClockEnabled(true);
  liveOf(s).playedGame = true;
  for (let i = 0; i < 80 && liveOf(s).nightDepth === undefined; i++) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); }
  s.advanceGame();
  (s as unknown as { ensureBeds(): unknown }).ensureBeds(); // the move-in beds (a real game has them from day 1)
  (s as unknown as { houseEventInSession: () => null }).houseEventInSession = () => null; // no comp or ceremony gathers the house: an ordinary night
  return s;
}
const ownRoom = (s: GameSessionAdapter, id: string) => (liveOf(s).hoh === id ? "hoh-room" : roomOfBed(liveOf(s).beds!.owner[id]!));

describe("sleepers sleep in their own bed's room all night (ORW-1154)", () => {
  it("late at night, before the player turns in, every houseguest who has turned in is in their own bed's room", () => {
    const s = game();
    for (let i = 0; i < 600 && liveOf(s).timeOfDay !== "night"; i++) s.advanceClockPerConversation();
    for (const id of [...s.occupancy()!.keys()].filter((x) => x !== "player")) s.recordHouseguestMove(id, "living-room"); // the evening's rooms, outside the bedrooms
    for (let i = 0; i < 600 && liveOf(s).timeOfDay !== "late-night"; i++) s.advanceClockPerConversation();
    expect(liveOf(s).timeOfDay).toBe("late-night");
    for (let i = 0; i < 3; i++) s.presenceTick(); // a few ticks so the sleepers would have wandered under the old behaviour
    const asleep = ((s.getGameState() as { asleep?: { id: string }[] }).asleep ?? []).map((x) => x.id);
    expect(asleep.length, "someone has turned in, so the assertion bites").toBeGreaterThan(0);
    const occ = s.occupancy()!;
    for (const id of asleep) expect(occ.get(id), `${id} is asleep in their own bed's room`).toBe(ownRoom(s, id));
  });

  it("the narrator's view names the sleepers in the player's own room, so it can never say the room is theirs alone", () => {
    const s = game();
    for (let i = 0; i < 600 && liveOf(s).timeOfDay !== "late-night"; i++) s.advanceClockPerConversation();
    s.presenceTick();
    const asleep = ((s.getGameState() as { asleep?: { id: string }[] }).asleep ?? []).map((x) => x.id);
    const target = asleep.find((id) => ownRoom(s, id).startsWith("bedroom-"))!;
    expect(target).toBeTruthy();
    s.movePlayer(ownRoom(s, target));
    const wa = s.whereabouts()!;
    expect(wa.asleepHere?.map((x) => x.id)).toContain(target);
    expect(wa.present.map((x) => x.id), "`present` stays the awake").not.toContain(target);
    const text = headcountLines(wa).join("\n");
    expect(text).toMatch(/Asleep in THIS room/);
    expect(text).not.toMatch(/you are alone/);
  });
});
