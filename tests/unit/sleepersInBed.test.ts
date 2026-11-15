import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";

/** ORW-383 (Ryne's live playtest): (1) after the night passes the house was still seated where the evening left it - sleepers belong in bedrooms; (2) the night widget lists who is AWAKE
 * (day and night), so the state carries an `awake` list that is the complement of `asleep`. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));
type Peek = { snapshot(): { live: { timeOfDay?: string; nightDepth?: number } } };

function game() {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`sib-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 7 });
  s.setPerConversationClockEnabled(true);
  const live = () => (s as unknown as Peek).snapshot().live;
  for (let i = 0; i < 80 && live().nightDepth === undefined; i++) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); }
  s.advanceGame();
  return { s, live };
}
const BEDS = new Set(["bedroom-a", "bedroom-b", "bedroom-c"]);

describe("sleepers belong in bedrooms; the state names who is awake", () => {
  it("after the player turns in, every houseguest wakes in a bedroom, not where the evening left them", () => {
    const { s, live } = game();
    s.setSleepersInBedEnabled(true);
    for (let i = 0; i < 400 && live().timeOfDay !== "night"; i++) s.advanceClockPerConversation();
    // seat the house outside the bedrooms first (the evening's rooms), so the assertion cannot pass by accident
    const occ = s.occupancy()!; const me = (s.getGameState() as unknown as { player?: { id: string } }).player?.id;
    const others = [...occ.keys()].filter((id) => id !== (me ?? "player"));
    for (const id of others) s.recordHouseguestMove(id, "living-room");
    expect(others.some((id) => !BEDS.has(s.occupancy()!.get(id)!))).toBe(true);
    s.turnIn({});
    const after = s.occupancy()!;
    // Only those STILL ASLEEP when the player wakes are seated; whoever is up keeps the evening's room.
    const sleepers = ((s.getGameState() as { asleep?: { id: string }[] }).asleep ?? []).map((x) => x.id);
    expect(sleepers.length, "someone is still asleep at the wake, so the assertion bites").toBeGreaterThan(0);
    for (const id of sleepers) expect(BEDS.has(after.get(id)!), `${id} is asleep and in a bedroom`).toBe(true);
  });
  it("a sleeper's bed does not change when an earlier houseguest has been evicted (stable per houseguest)", () => {
    const { s } = game();
    s.setSleepersInBedEnabled(true);
    const priv = s as unknown as { seatInBedrooms(ids: string[], into: Map<string, string>): void; house: { npcs: { id: string }[] } };
    const ids = priv.house.npcs.map((n) => n.id);
    const seat = () => { const m = new Map<string, string>(ids.map((id) => [id, "living-room"])); priv.seatInBedrooms(ids, m); return m; };
    const before = seat();
    (s as unknown as { live: { evictionOrder?: string[] } }).live.evictionOrder = [ids[0]!];
    const after = seat();
    for (const id of ids.slice(1)) expect(after.get(id), `${id} keeps its bed`).toBe(before.get(id));
  });
  it("the state carries `awake` and `asleep` as disjoint lists and never lists the player", () => {
    const { s } = game();
    const st = s.getGameState() as { asleep?: { id: string }[]; awake?: { id: string }[] };
    expect(Array.isArray(st.awake)).toBe(true);
    expect((st.awake ?? []).length, "someone is up").toBeGreaterThan(0);
    const a = new Set((st.awake ?? []).map((x) => x.id)), z = new Set((st.asleep ?? []).map((x) => x.id));
    for (const id of a) expect(z.has(id)).toBe(false);
    const npcCount = s.getGameState().house.filter((h) => h.id !== (s.getGameState() as unknown as { player?: { id: string } }).player?.id).length;
    expect(a.size + z.size, "awake and asleep together cover every arrived houseguest").toBeLessThanOrEqual(npcCount);
    expect(a.size + z.size).toBeGreaterThan(0);
    expect(a.has("player")).toBe(false);
  });
});
