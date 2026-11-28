import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { BED_RUSH, arrivalTick, claimKeepsFloor } from "../../src/engine/bedRush";
import { BEDROOM_LAYOUT } from "../../src/engine/data/bedrooms";
import { freeBeds, roomOfBed } from "../../src/engine/beds";
import { resolvePending } from "../../features/support/answerPending";

/** ORW-672 / feature 0201 - the bed rush. Roles only; no fixture names. */
type Live = { premiereEntrance?: { stage: string; order: string[] }; beds?: { owner: Record<string, string>; claims: Array<{ who: string; bed: string; why: string }> }; bedRush?: { tick: number; done: boolean; windowEnded?: boolean; plan: Record<string, { room: string; at: number }>; log: Array<{ tick: number; who: string; room: string }> }; playedGame?: boolean };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
let n = 0;
function start(seed: number): GameSessionAdapter {
  const s = new GameSessionRegistry().sandboxFor(`bedrush-${n++}`).session as GameSessionAdapter;
  s.setPremiereEntrancesEnabled(true);
  s.setBedRushEnabled(true);
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" }); // a person is playing
  return s;
}
const step = (s: GameSessionAdapter) => { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); return v; };
/** Entrances and toast, up to the closed circle; asserts nobody has a bed on the way. */
function toCircleClosed(s: GameSessionAdapter): void {
  for (let i = 0; i < 60 && liveOf(s).premiereEntrance!.stage !== "done"; i++) {
    step(s);
    expect(liveOf(s).beds?.claims.length ?? 0, "no bed is claimed before the circle closes").toBe(0);
  }
  expect(liveOf(s).premiereEntrance!.stage).toBe("done");
}
const spots = (s: GameSessionAdapter) => { const l = liveOf(s); return freeBeds(l.beds as never, new Set(s.getGameState().house.map((h) => h.id))); };
const roomsOpen = (b: string[]) => new Set(b.map((x) => roomOfBed(x))).size;
const bedRoomNames = BEDROOM_LAYOUT.map((r) => r.room);

describe("the bed rush: pure model", () => {
  it("a faster, hungrier, closer runner arrives no later than a slower one; arrivals stay inside the race", () => {
    const fast = arrivalTick({ speed: 1, eagerness: 1, distance: 0, luck: 0 });
    const slow = arrivalTick({ speed: 0, eagerness: 0, distance: 1, luck: 1 });
    expect(fast).toBe(1);
    expect(slow).toBe(BED_RUSH.ticks);
    for (let i = 0; i < 200; i++) { const t = arrivalTick({ speed: (i % 7) / 6, eagerness: (i % 5) / 4, distance: (i % 3) / 2, luck: (i % 11) / 10 }); expect(t).toBeGreaterThanOrEqual(1); expect(t).toBeLessThanOrEqual(BED_RUSH.ticks); }
  });
  it("the floor: a claim that would leave too few spots, or too few rooms, is refused", () => {
    expect(claimKeepsFloor({ a: 5, b: 5, c: 6 }, "a" as never)).toBe(true);
    expect(claimKeepsFloor({ a: 2, b: 2, c: 0 }, "a" as never)).toBe(false); // 3 spots left
    expect(claimKeepsFloor({ a: 0, b: 6, c: 0 }, "b" as never)).toBe(false); // one room only
  });
});

describe("the bed rush: nothing before the toast, and a claim needs the room", () => {
  it("no NPC claims on walking in or on the first message, and the player's claim before the circle closes is refused", () => {
    const s = start(7);
    expect(liveOf(s).beds?.claims.length ?? 0).toBe(0);
    s.resolvePlayerMove({ text: "I take a bed in bedroom A" });
    expect(liveOf(s).beds?.owner["player"], "the player cannot claim before the circle closes").toBeUndefined();
    toCircleClosed(s);
  });
  it("a claim attempt from the common area is refused; NPC claims land only on or after their arrival tick", () => {
    const s = start(7);
    toCircleClosed(s);
    const priv = s as unknown as { resolvePlayerBed(t: string): boolean };
    expect(priv.resolvePlayerBed("I take a bed in bedroom A"), "the player stands in the common area").toBe(false);
    expect(liveOf(s).beds?.owner["player"]).toBeUndefined();
    for (let i = 0; i < BED_RUSH.ticks + BED_RUSH.graceTicks && !liveOf(s).bedRush?.done; i++) {
      step(s);
      const br = liveOf(s).bedRush!;
      for (const c of br.log) expect(br.plan[c.who]!.at, "an NPC claims only once their arrival tick has come").toBeLessThanOrEqual(c.tick);
      expect(br.log.every((c) => c.tick <= br.tick)).toBe(true);
    }
  });
});

describe("the bed rush: the player always keeps a real choice", () => {
  it("on every seed, while the player hangs back, at least the floor of beds stays open across at least two rooms", () => {
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
      const s = start(seed);
      toCircleClosed(s);
      for (let i = 0; i < BED_RUSH.ticks + BED_RUSH.graceTicks; i++) {
        step(s);
        const free = spots(s);
        expect(free.length, `seed ${seed} tick ${i + 1}: spots open for the player`).toBeGreaterThanOrEqual(BED_RUSH.floorSpots);
        expect(roomsOpen(free), `seed ${seed}: rooms open for the player`).toBeGreaterThanOrEqual(BED_RUSH.floorRooms);
      }
      // the player arrives late and still claims where they like among the open rooms
      const open = [...new Set(spots(s).map((b) => roomOfBed(b)))];
      s.resolvePlayerMove({ text: `I run to ${open[0]!.replace("-", " ")} and take a bed there` });
      expect(liveOf(s).beds!.owner["player"], `seed ${seed}: the late player got a bed in a room they chose`).toBeDefined();
      expect(roomOfBed(liveOf(s).beds!.owner["player"]!)).toBe(open[0]);
    }
  });
});

describe("the bed rush: a whole premiere", () => {
  it("everyone is bedded exactly once, 16 beds, the player included, when the player rushes in", () => {
    const s = start(7);
    toCircleClosed(s);
    s.resolvePlayerMove({ text: "I sprint to bedroom B and take a bed there" });
    expect(liveOf(s).beds!.owner["player"], "the player rushed and claimed straight away").toBeDefined();
    for (let i = 0; i < 12 && !liveOf(s).bedRush?.done; i++) step(s);
    const l = liveOf(s);
    expect(l.bedRush!.done).toBe(true);
    const owners = Object.values(l.beds!.owner);
    expect(Object.keys(l.beds!.owner).length).toBe(16);
    expect(new Set(owners).size, "no two houseguests own one spot").toBe(16);
    const firstClaims = l.beds!.claims.filter((c) => c.why === "move-in");
    expect(new Set(firstClaims.map((c) => c.who)).size, "nobody claimed twice").toBe(firstClaims.length);
    expect(l.bedRush!.tick).toBeLessThanOrEqual(BED_RUSH.ticks);
    expect(owners.every((b) => bedRoomNames.includes(roomOfBed(b) as never))).toBe(true);
  });
  it("a player who hangs back past the whole window still gets a bed at bedtime and everyone ends up bedded", () => {
    const s = start(11);
    toCircleClosed(s);
    for (let i = 0; i < 12 && !liveOf(s).bedRush?.done && !liveOf(s).bedRush?.windowEnded; i++) step(s);
    expect(liveOf(s).bedRush!.done || liveOf(s).bedRush!.windowEnded).toBe(true);
    expect(spots(s).length).toBeGreaterThanOrEqual(BED_RUSH.floorSpots);
    (s as unknown as { bedThePlayer(): void }).bedThePlayer();
    expect(liveOf(s).bedRush!.done).toBe(true);
    expect(new Set(Object.values(liveOf(s).beds!.owner)).size).toBe(16);
  });
});

describe("the bed rush: save and restore mid-rush", () => {
  it("a restored game resumes to the identical final bed assignment", () => {
    const run = (restoreMid: boolean) => {
      const sb = new GameSessionRegistry().sandboxFor(`bedrush-${n++}`);
      let s = sb.session as GameSessionAdapter;
      s.setPremiereEntrancesEnabled(true); s.setBedRushEnabled(true);
      s.createCharacter({ playerName: "P", seed: 21 });
      s.noteMessage({ messageId: "m1" });
      toCircleClosed(s);
      step(s); // one heat in
      if (restoreMid) {
        const snap = JSON.parse(JSON.stringify(s.snapshot()));
        // the relationship model is a separate port the registry restores on its own: share it, so this proves the rush state round-trips
        const again = new GameSessionAdapter(sb.engine.relationships as never); again.restore(snap as never); s = again;
      }
      for (let i = 0; i < 12 && !liveOf(s).bedRush?.done && !liveOf(s).bedRush?.windowEnded; i++) step(s);
      (s as unknown as { bedThePlayer(): void }).bedThePlayer();
      return { owner: liveOf(s).beds!.owner, tick: liveOf(s).bedRush!.tick, plan: liveOf(s).bedRush!.plan };
    };
    expect(run(true)).toEqual(run(false));
  });
});

describe("the bed rush: flag off is the old behaviour", () => {
  it("off, nobody claims as they walk in (ORW-1134); the claims run when the circle closes and the rush never runs", () => {
    const s = new GameSessionRegistry().sandboxFor(`bedrush-${n++}`).session as GameSessionAdapter;
    s.setPremiereEntrancesEnabled(true); s.setBedRushEnabled(false);
    s.createCharacter({ playerName: "P", seed: 7 });
    s.noteMessage({ messageId: "m1" });
    for (let i = 0; i < 60 && liveOf(s).premiereEntrance!.stage !== "done"; i++) { step(s); if (liveOf(s).premiereEntrance!.stage !== "done") expect(liveOf(s).beds?.claims.length ?? 0).toBe(0); }
    (s as unknown as { ensureBeds(): unknown }).ensureBeds();
    expect(liveOf(s).beds!.claims.length).toBeGreaterThan(0);
    expect(liveOf(s).bedRush).toBeUndefined();
  });
});

describe("the bed rush: the wall and the prompt", () => {
  it("what the narrator and player are handed carries no pick score, arrival model or plan internals, and no digits", () => {
    const s = start(7);
    toCircleClosed(s);
    const seen: string[] = []; const rushText: string[] = [];
    for (let i = 0; i < BED_RUSH.ticks + BED_RUSH.graceTicks && !liveOf(s).bedRush?.done; i++) {
      const v = step(s);
      seen.push(JSON.stringify(v.event ?? {}), (s as unknown as { bedsLine(): string | undefined }).bedsLine() ?? "");
      rushText.push(String((v.event as { content?: string } | undefined)?.content ?? ""), (s as unknown as { bedRushFacts(): string | undefined }).bedRushFacts() ?? ""); // the rush's own words (the BEDS line's room tallies are the older ORW-466 text)
    }
    const text = seen.join("\n");
    expect(text.length).toBeGreaterThan(50);
    for (const banned of ["eagerness", "speed", "arrivalTick", "warmth", "affinity", "trust", "threat", "\"at\":", "plan", "luck", "noise", "score"]) expect(text, banned).not.toContain(banned);
    const stripped = rushText.join("\n");
    expect(stripped.match(/.{0,30}\d.{0,20}/g)?.slice(0,3), "the rush is voiced number-free ").toBeUndefined();
  });
  it("the premiere prompt tells the narrator to voice the rush as a live scene and to leave the choice to the player", async () => {
    const { MOMENT_PROMPTS } = await import("../../src/engine/momentPrompts");
    const p = MOMENT_PROMPTS["premiere"]!;
    expect(p).toContain("THE BED RUSH");
    expect(p).toContain("LIVELY SCENE");
    expect(p).toContain("rush straight to a room");
    expect(p).toContain("hang back");
    expect(p).not.toMatch(/\be\.g\.|for example|such as/i);
  });
});
