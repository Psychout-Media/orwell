import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import { BEDROOM_LAYOUT, spotsIn } from "../../src/engine/data/bedrooms";
import { roomOfBed, pickSpot, bedPartner, type BedsState } from "../../src/engine/beds";

/** ORW-466 (Ryne 2026-11-15: "most people would have an assigned bed... The HOH assigned bed would be upstairs in the HOH room"): every houseguest owns a bed, claimed on move-in day; sleepers sleep
 * and wake in their own bed (the HOH in the HOH room); the player gets the bed left over at their first bedtime until they pick one. Supersedes ORW-383's arbitrary-room setting. Also ORW-383's
 * other half: the state names who is AWAKE. Roles only. A test-only seam on `live` (as in the other live-season tests). */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));
type Live = { timeOfDay?: string; nightDepth?: number; playedGame?: boolean; hoh?: string | null; beds?: BedsState; evictionOrder: string[] };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;

function game(played = true) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`beds-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 7 });
  s.setPerConversationClockEnabled(true);
  if (played) liveOf(s).playedGame = true; // a person is playing (set by the first noted message in a real game)
  for (let i = 0; i < 80 && liveOf(s).nightDepth === undefined; i++) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); }
  s.advanceGame();
  return s;
}
const toNight = (s: GameSessionAdapter) => { for (let i = 0; i < 400 && liveOf(s).timeOfDay !== "night"; i++) s.advanceClockPerConversation(); };
const ownRoom = (s: GameSessionAdapter, id: string) => (liveOf(s).hoh === id ? "hoh-room" : roomOfBed(liveOf(s).beds!.owner[id]!));

describe("assigned beds (ORW-466); the state names who is awake (ORW-383)", () => {
  it("at the player's bedtime every houseguest still asleep is in their OWN bed's room (the HOH upstairs), and the player wakes in their own bed", () => {
    const s = game();
    toNight(s);
    // seat the house outside the bedrooms first (the evening's rooms), so the assertion cannot pass by accident
    const others = [...s.occupancy()!.keys()].filter((id) => id !== "player");
    for (const id of others) s.recordHouseguestMove(id, "living-room");
    s.turnIn({});
    const after = s.occupancy()!;
    const sleepers = ((s.getGameState() as { asleep?: { id: string }[] }).asleep ?? []).map((x) => x.id);
    expect(sleepers.length, "someone is still asleep at the wake, so the assertion bites").toBeGreaterThan(0);
    for (const id of sleepers) expect(after.get(id), `${id} is asleep in their own bed`).toBe(ownRoom(s, id));
    expect(after.get("player"), "the player wakes in their own bed").toBe(ownRoom(s, "player"));
  });

  it("move-in day: every houseguest owns one bed, nobody shares one, no room holds more than its beds; the player's is the one left over at their first bedtime", () => {
    const s = game();
    toNight(s);
    s.turnIn({});
    const beds = liveOf(s).beds!;
    const owners = Object.keys(beds.owner);
    expect(owners.length, "all 16 houseguests own a bed").toBe(16);
    expect(new Set(Object.values(beds.owner)).size, "no two share a bed").toBe(16);
    for (const r of BEDROOM_LAYOUT) expect(Object.values(beds.owner).filter((b) => roomOfBed(b) === r.room).length).toBeLessThanOrEqual(spotsIn(r));
    const inHouse = new Set(owners);
    for (const id of owners) { const p = bedPartner(beds, id, inHouse); if (p) expect(bedPartner(beds, p, inHouse), "a double is shared by exactly two").toBe(id); }
    expect(beds.claims.find((c) => c.who === "player")?.why).toBe("leftover");
    expect(beds.claims.filter((c) => c.why === "move-in").length, "the 15 NPCs claimed on move-in day").toBe(15);
  });

  it("an eviction frees that bed and nobody else's moves; the claim history keeps every claim", () => {
    const s = game();
    toNight(s);
    s.turnIn({});
    const beds = liveOf(s).beds!;
    const before = { ...beds.owner }; const claims = beds.claims.length;
    const gone = Object.keys(before).find((id) => id !== "player")!;
    liveOf(s).evictionOrder.push(gone);
    toNight(s);
    s.turnIn({});
    for (const [id, bed] of Object.entries(before)) if (id !== gone) expect(liveOf(s).beds!.owner[id], `${id} keeps their bed`).toBe(bed);
    expect(liveOf(s).beds!.claims.length, "history is never thinned").toBeGreaterThanOrEqual(claims);
  });

  it("doubles (Ryne: \"there could definitely be doubles in the mix\"): half of a double only next to someone they really like; otherwise a single", () => {
    const state: BedsState = { owner: { friend: "bedroom-b#d1:1" }, claims: [] };
    const inHouse = new Set(["friend", "close", "stranger"]);
    const feel = (who: string) => (who === "close" ? 0.9 : 0.3);
    expect(pickSpot(state, "close", "bedroom-b", inHouse, (w) => feel(w)), "a close houseguest shares the double").toBe("bedroom-b#d1:2");
    expect(pickSpot(state, "stranger", "bedroom-b", inHouse, (w) => feel(w)), "a stranger takes a single").toMatch(/#s\d$/);
  });

  it("a headless game (nobody playing) assigns no beds, so calibration and simulated seasons are untouched", () => {
    const s = game(false);
    toNight(s);
    s.turnIn({});
    expect(liveOf(s).beds).toBeUndefined();
  });

  it("the state carries `awake` and `asleep` as disjoint lists and never lists the player", () => {
    const s = game();
    const st = s.getGameState() as { asleep?: { id: string }[]; awake?: { id: string }[] };
    expect(Array.isArray(st.awake)).toBe(true);
    expect((st.awake ?? []).length, "someone is up").toBeGreaterThan(0);
    const a = new Set((st.awake ?? []).map((x) => x.id)), z = new Set((st.asleep ?? []).map((x) => x.id));
    for (const id of a) expect(z.has(id)).toBe(false);
    const npcCount = s.getGameState().house.filter((h) => h.id !== (s.getGameState() as unknown as { player?: { id: string } }).player?.id).length;
    expect(a.size + z.size, "awake and asleep together cover every arrived houseguest").toBe(npcCount);
    expect(a.has("player")).toBe(false);
  });
});
