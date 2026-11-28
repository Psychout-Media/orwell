import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import { roomOfBed, type BedsState } from "../../src/engine/beds";
import { pickBedFor, bedmateShare, type BedReader } from "../../src/engine/bedClaims";
import { roomDisplayName } from "../../src/domain/house";
import { HOUSE_THEMES } from "../../src/engine/data/houseThemes";
import { themedRoomAliases, roomNamesFor } from "../../src/engine/roomLabels";

/** ORW-466 slice 2 - the move-in day bed pick: NPCs claim as they walk in (crowd / personality / luck), the player claims in their own words before the narrator writes, a taken bed is a swap
 * the owner answers, the leftover bed at the first bedtime, and a headless game stays bed-free. Roles only. */
type Pe = { order: string[]; playerPos: number; arrived: number; stage: string };
type Live = { houseTheme?: string; playedGame?: boolean; beds?: BedsState; premiereEntrance?: Pe; timeOfDay?: string; nightDepth?: number };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const relOf = (s: GameSessionAdapter) => (s as unknown as { rel: { edge(a: string, b: string): { affinity: number } } }).rel;

function premiere(played = true) {
  const s = new GameSessionRegistry().sandboxFor(`bedpick-${Math.random()}`).session as GameSessionAdapter;
  s.setPremiereEntrancesEnabled(true);
  s.setBedRushEnabled(false); // ORW-672 / 0201: these pin the OLD walk-in-order claim (flag off); the bed rush has its own tests (bedRush.test.ts)
  s.createCharacter({ playerName: "P", seed: 11 });
  if (played) liveOf(s).playedGame = true; // a person is playing
  return s;
}
const step = (s: GameSessionAdapter) => { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); };
/** advance the staged entrances until the player is inside */
const walkIn = (s: GameSessionAdapter) => { for (let i = 0; i < 20 && liveOf(s).premiereEntrance!.arrived <= liveOf(s).premiereEntrance!.playerPos; i++) step(s); };
/** ORW-1134: beds open after the circle - run the entrances and the toast to the host's close (nobody holds a bed on the way). */
const circleClosed = (s: GameSessionAdapter, leaveOpen = true) => { for (let i = 0; i < 80 && liveOf(s).premiereEntrance!.stage !== "done"; i++) { step(s); if (liveOf(s).premiereEntrance!.stage !== "done") expect(liveOf(s).beds?.claims.length ?? 0, "no bed before the circle closes").toBe(0); } expect(liveOf(s).premiereEntrance!.stage).toBe("done"); (s as unknown as { ensureBeds(): unknown }).ensureBeds(); /* rush off: the claims run at the close */ if (leaveOpen) { const b = liveOf(s).beds!; for (const c of [...b.claims]) if (roomOfBed(b.owner[c.who]!) !== "bedroom-b") { delete b.owner[c.who]; b.claims.splice(b.claims.indexOf(c), 1); } /* fixture: only bedroom-b is full, so the player's window has spots in the other two; the close's claims have run, so the idempotent claim step stays out of the way */ (s as unknown as { ensureBeds(): unknown }).ensureBeds = () => liveOf(s).beds; } };
const nameOf = (s: GameSessionAdapter, id: string) => s.getGameState().house.find((h) => h.id === id)!.name;

describe("the move-in bed pick (ORW-466 slice 2)", () => {
  it("ORW-1134: nobody claims on walking in; with the rush off the first claims come at the circle's close, in entrance order", () => {
    const s = premiere();
    walkIn(s); step(s); // one more arrival after the player
    expect(liveOf(s).beds?.claims.length ?? 0, "arrivals hold no bed").toBe(0);
    circleClosed(s, false);
    const pe = liveOf(s).premiereEntrance!;
    const beds = liveOf(s).beds!;
    const npcs = pe.order.filter((id) => id !== "player");
    for (const id of npcs) expect(beds.owner[id], "everyone owns a bed once the circle is closed").toBeDefined();
    expect(beds.claims.map((c) => c.who), "claims follow the entrance order (early arrivals pick first)").toEqual(npcs);
  });

  it("a social houseguest picks the busier room, a private one the quiet room (no luck)", () => {
    const state: BedsState = { owner: { x1: "bedroom-a#1", x2: "bedroom-a#2", x3: "bedroom-a#3", y1: "bedroom-b#1" }, claims: [] };
    const inHouse = new Set(["x1", "x2", "x3", "y1", "social", "private"]);
    const reader = (social: number): BedReader => ({ stats: () => ({ social, mental: 0.5 }), warmth: () => 0 });
    const pick = (who: string, r: BedReader) => pickBedFor(state, who, inHouse, r, bedmateShare(r, 0.25), () => 0)!;
    expect(roomOfBed(pick("social", reader(0.95)))).toBe("bedroom-a");
    expect(roomOfBed(pick("private", reader(0.05)))).toBe("bedroom-c");
  });

  it("half of a double: the would-be bedmate weighs far more than the room - a mild liking shares the double, a mild dislike takes a single elsewhere", () => {
    const state: BedsState = { owner: { mate: "bedroom-b#d1:1" }, claims: [] };
    const inHouse = new Set(["mate", "fond", "cold"]);
    const reader = (w: number): BedReader => ({ stats: () => ({ social: 0.5, mental: 0.5 }), warmth: () => w });
    const pick = (who: string, r: BedReader) => pickBedFor(state, who, inHouse, r, bedmateShare(r, 0.25), () => 0)!;
    expect(pick("fond", reader(0.15)), "a mild liking is enough to share the double").toBe("bedroom-b#d1:2");
    const cold = pick("cold", reader(-0.1));
    expect(cold, "a mild dislike keeps them out of that double").not.toBe("bedroom-b#d1:2");
    expect(roomOfBed(cold), "and out of that room").not.toBe("bedroom-b");
  });

  it("the player's claim in their own words lands in the engine before the narrator writes, and the narrator's BEDS line says so", () => {
    const s = premiere();
    circleClosed(s);
    const room = "bedroom-c";
    s.resolvePlayerMove({ text: `I'll take the bed by the window in ${roomDisplayName(room)}.` });
    expect(roomOfBed(liveOf(s).beds!.owner["player"]!)).toBe(room);
    const prompt = s.getMomentPrompt({}).systemPrompt;
    expect(prompt).toContain("- BEDS (engine truth");
    expect(prompt).toMatch(new RegExp(`the player just claimed (?:a single bed|half of a double)[^.]* in ${roomDisplayName(room)}`));
  });

  it("a themed season: the player claims a bed by the room's themed short name, and the BEDS line uses the themed name", () => {
    const s = premiere();
    const theme = HOUSE_THEMES[0]!;
    liveOf(s).houseTheme = theme.id;
    circleClosed(s);
    const room = "bedroom-a";
    const themed = roomNamesFor(theme.id)![room]!; // ORW-968: the shown name says the plain word
    const alias = themedRoomAliases(theme.id).filter(([, r]) => r === room).map(([a]) => a).sort((x, y) => x.length - y.length)[0]!;
    s.resolvePlayerMove({ text: `I'll take a bed in ${alias}.` });
    expect(roomOfBed(liveOf(s).beds!.owner["player"]!), `"${alias}" names ${themed}`).toBe(room);
    const prompt = s.getMomentPrompt({}).systemPrompt;
    const bedsLine = prompt.split("\n").find((l) => l.includes("- BEDS (engine truth"))!;
    expect(bedsLine).toMatch(new RegExp(`the player just claimed (?:a single bed|half of a double)[^.]* in ${themed}`));
    expect(bedsLine, "the BEDS line names the room by its themed name only").not.toContain(roomDisplayName(room));
  });

  it("a taken bed: the owner refuses a swap when they don't like the player and accepts when they do", () => {
    for (const [affinity, yes] of [[0, false], [0.95, true]] as const) {
      const s = premiere();
      circleClosed(s);
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

  it("a half-double swap is a shared trade: the spot owner AND the other half's sleeper must agree (Ryne 2026-11-15: \"they should get a say\")", () => {
    const s = premiere();
    circleClosed(s);
    const beds = liveOf(s).beds!;
    const [a, b] = Object.keys(beds.owner).filter((id) => id !== "player");
    // seat the two in one double (trading spots with whoever held those halves)
    const seat = (who: string, spot: string) => { const held = Object.keys(beds.owner).find((o) => beds.owner[o] === spot); if (held && held !== who) beds.owner[held] = beds.owner[who]!; beds.owner[who] = spot; };
    seat(a!, "bedroom-c#d1:1"); seat(b!, "bedroom-c#d1:2");
    relOf(s).edge(a!, b!).affinity = 0.25;
    relOf(s).edge(a!, "player").affinity = 0.95; // the spot's owner likes the player
    relOf(s).edge(b!, "player").affinity = 0; // the other half does not: they say no
    s.resolvePlayerMove({ text: `Could I swap beds with ${nameOf(s, a!)}?` });
    expect(beds.owner["player"], "the other half said no: no swap").not.toBe("bedroom-c#d1:1");
    expect(beds.owner[a!]).toBe("bedroom-c#d1:1");
    relOf(s).edge(b!, "player").affinity = 0.95; // now the other half is warm too
    s.resolvePlayerMove({ text: `Could I swap beds with ${nameOf(s, a!)}?` });
    expect(beds.owner["player"], "both agreed: the player is in the double now").toBe("bedroom-c#d1:1");
    expect(beds.owner[b!], "the other half keeps their spot").toBe("bedroom-c#d1:2");
  });

  it("a swap is recorded as a swap in the claim history, and a player who shares the owner's double is not their own veto", () => {
    const s = premiere();
    circleClosed(s);
    const beds = liveOf(s).beds!;
    const [a] = Object.keys(beds.owner).filter((id) => id !== "player");
    const seat = (who: string, spot: string) => { const held = Object.keys(beds.owner).find((o) => beds.owner[o] === spot); if (held && held !== who) beds.owner[held] = beds.owner[who]!; beds.owner[who] = spot; };
    seat(a!, "bedroom-c#d1:1"); seat("player", "bedroom-c#d1:2");
    relOf(s).edge(a!, "player").affinity = 0.95;
    s.resolvePlayerMove({ text: `Could I swap beds with ${nameOf(s, a!)}?` });
    expect(beds.owner["player"], "sharing the double never vetoes the player's own ask").toBe("bedroom-c#d1:1");
    expect(beds.claims.slice(-2).map((c) => c.why)).toEqual(["swap", "swap"]);
  });

  it("a player who never picks gets the last free bed at their first bedtime", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    try {
      const s = premiere();
      s.setPerConversationClockEnabled(true);
      for (let i = 0; i < 80 && liveOf(s).nightDepth === undefined; i++) step(s);
      for (let i = 0; i < 400 && liveOf(s).timeOfDay !== "night"; i++) s.advanceClockPerConversation();
      expect(liveOf(s).beds?.owner["player"], "no bed before bedtime").toBeUndefined();
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
