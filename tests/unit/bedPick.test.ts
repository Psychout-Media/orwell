import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import { roomOfBed, type BedsState } from "../../src/engine/beds";
import { pickBedFor, type BedReader } from "../../src/engine/bedClaims";
import { roomDisplayName } from "../../src/domain/house";

/** ORW-466 slice 2 - the move-in day bed pick: NPCs claim as they walk in (crowd / personality / luck), the player claims in their own words before the narrator writes, a taken bed is a swap
 * the owner answers, the leftover bed at the first bedtime, and a headless game stays bed-free. Roles only. */
type Pe = { order: string[]; playerPos: number; arrived: number; stage: string };
type Live = { playedGame?: boolean; beds?: BedsState; premiereEntrance?: Pe; timeOfDay?: string; nightDepth?: number };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const relOf = (s: GameSessionAdapter) => (s as unknown as { rel: { edge(a: string, b: string): { affinity: number } } }).rel;

function premiere(played = true) {
  const s = new GameSessionRegistry().sandboxFor(`bedpick-${Math.random()}`).session as GameSessionAdapter;
  s.setPremiereEntrancesEnabled(true);
  s.createCharacter({ playerName: "P", seed: 11 });
  if (played) liveOf(s).playedGame = true; // a person is playing
  return s;
}
const step = (s: GameSessionAdapter) => { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); };
/** advance the staged entrances until the player is inside */
const walkIn = (s: GameSessionAdapter) => { for (let i = 0; i < 20 && liveOf(s).premiereEntrance!.arrived <= liveOf(s).premiereEntrance!.playerPos; i++) step(s); };
const nameOf = (s: GameSessionAdapter, id: string) => s.getGameState().house.find((h) => h.id === id)!.name;

describe("the move-in bed pick (ORW-466 slice 2)", () => {
  it("NPCs claim as they walk in, in entrance order: those inside own beds, those still outside do not", () => {
    const s = premiere();
    walkIn(s); step(s); // one more arrival after the player
    const pe = liveOf(s).premiereEntrance!;
    const beds = liveOf(s).beds!;
    const inside = pe.order.slice(0, pe.arrived).filter((id) => id !== "player");
    const outside = pe.order.slice(pe.arrived);
    for (const id of inside) expect(beds.owner[id], "an arrived houseguest owns a bed").toBeDefined();
    for (const id of outside) expect(beds.owner[id], "a houseguest still outside has not picked").toBeUndefined();
    expect(beds.claims.map((c) => c.who), "claims follow the entrance order (early arrivals pick first)").toEqual(inside);
  });

  it("a social houseguest picks the busier room, a private one the quiet room (no luck)", () => {
    const state: BedsState = { owner: { x1: "bedroom-a#1", x2: "bedroom-a#2", x3: "bedroom-a#3", y1: "bedroom-b#1" }, claims: [] };
    const inHouse = new Set(["x1", "x2", "x3", "y1", "social", "private"]);
    const reader = (social: number): BedReader => ({ stats: () => ({ social, mental: 0.5 }), warmth: () => 0 });
    expect(roomOfBed(pickBedFor(state, "social", inHouse, reader(0.95), () => 0)!)).toBe("bedroom-a");
    expect(roomOfBed(pickBedFor(state, "private", inHouse, reader(0.05), () => 0)!)).toBe("bedroom-c");
  });

  it("the player's claim in their own words lands in the engine before the narrator writes, and the narrator's BEDS line says so", () => {
    const s = premiere();
    walkIn(s);
    const room = "bedroom-c";
    s.resolvePlayerMove({ text: `I'll take the bed by the window in ${roomDisplayName(room)}.` });
    expect(roomOfBed(liveOf(s).beds!.owner["player"]!)).toBe(room);
    const prompt = s.getMomentPrompt({}).systemPrompt;
    expect(prompt).toContain("- BEDS (engine truth");
    expect(prompt).toContain(`the player just claimed a bed in ${roomDisplayName(room)}`);
  });

  it("a taken bed: the owner refuses a swap when they don't like the player and accepts when they do", () => {
    for (const [affinity, yes] of [[0, false], [0.95, true]] as const) {
      const s = premiere();
      walkIn(s);
      const beds = liveOf(s).beds!;
      const owner = Object.keys(beds.owner).find((id) => id !== "player")!;
      const theirs = beds.owner[owner]!;
      relOf(s).edge(owner, "player").affinity = affinity;
      s.resolvePlayerMove({ text: `Can I swap beds with ${nameOf(s, owner)}?` });
      expect(beds.owner["player"] === theirs, `swap ${yes ? "accepted" : "refused"}`).toBe(yes);
      expect(beds.owner[owner] === theirs).toBe(!yes);
      expect(s.getMomentPrompt({}).systemPrompt).toContain(yes ? "said YES" : "said NO");
    }
  });

  it("a player who never picks gets the last free bed at their first bedtime", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    try {
      const s = premiere();
      s.setPerConversationClockEnabled(true);
      for (let i = 0; i < 80 && liveOf(s).nightDepth === undefined; i++) step(s);
      for (let i = 0; i < 400 && liveOf(s).timeOfDay !== "night"; i++) s.advanceClockPerConversation();
      expect(liveOf(s).beds!.owner["player"], "no bed before bedtime").toBeUndefined();
      s.turnIn({});
      const beds = liveOf(s).beds!;
      expect(beds.claims.find((c) => c.who === "player")?.why).toBe("leftover");
      expect(new Set(Object.values(beds.owner)).size).toBe(Object.keys(beds.owner).length);
    } finally { GameSessionAdapter.setTimeOfDayEnabled(false); }
  });

  it("a headless game (nobody playing) claims no beds through the entrances", () => {
    const s = premiere(false);
    walkIn(s); step(s);
    expect(liveOf(s).beds).toBeUndefined();
  });
});
