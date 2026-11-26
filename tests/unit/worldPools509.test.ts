import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { composedAt, composedSize, composeAll, pickComposed, firstAccepted, sideStream } from "../../src/engine/data/composedFloor";
import { pickAllianceName, allianceNameAt, ALLIANCE_NAME_SPACE } from "../../src/engine/alliances";
import { nextHouseEvent, houseEventLineAt, HOUSE_EVENT_SPACE, HOUSE_EVENT_POOL } from "../../src/engine/houseEvents";
import { themeForWeek, applyTheme, COMPETITION_THEMES, BEAT_FLOURISHES } from "../../src/engine/competitionThemes";
import { COMPETITION_LIBRARY } from "../../src/engine/competitionLibrary";
import { acceptHouseThemeDraft, registerHouseTheme, houseTheme, roomLabel, drawHouseTheme } from "../../src/engine/roomLabels";
import { HOUSE_THEMES } from "../../src/engine/data/houseThemes";
import { HOUSE_ROOMS } from "../../src/domain/house";
import { CURIOSITY_NEEDLES } from "../../src/engine/curiosityNeedle";
import { composedCuriosityNeedle, CURIOSITY_NEEDLE_SPACE } from "../../src/engine/curiosityNeedleComposed";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { RandomnessSource } from "../../src/ports/RandomnessSource";

/** A stream that counts how many draws a function takes, to prove the main stream's consumption is unchanged. */
function counting(seed: number): { rng: RandomnessSource; draws: () => number } {
  const inner = new SeededRandom(seed);
  let n = 0;
  const rng: RandomnessSource = {
    next: () => { n++; return inner.next(); },
    int: (m) => { n++; return inner.int(m); },
    pick: (xs) => { n++; return inner.pick(xs); },
    fork: (l) => inner.fork(l),
  };
  return { rng, draws: () => n };
}

describe("ORW-509 composed floor helpers", () => {
  const axes = [["a", "b", "c"], ["x", "y"], ["1", "2", "3", "4"]];
  it("decodes every index to a distinct combination", () => {
    expect(composedSize(axes)).toBe(24);
    expect(new Set(Array.from({ length: 24 }, (_, i) => composedAt(axes, i).join(""))).size).toBe(24);
    expect(composeAll(axes, (p) => p.join("")).length).toBe(24);
  });
  it("one rng draw addresses the whole space", () => {
    const { rng, draws } = counting(3);
    pickComposed(rng, axes);
    expect(draws()).toBe(1);
  });
  it("bounded retries then a plain fallback, counting rejections", () => {
    const never = firstAccepted([["a", "b"]], 0, () => false);
    expect(never.line).toBe("a");
    expect(never.rejected).toBe(2);
    const some = firstAccepted([["a", "b", "c"]], 0, (l) => l === "c");
    expect(some).toEqual({ line: "c", rejected: 2 });
  });
  it("a side stream is deterministic per key and independent between keys", () => {
    const a = sideStream("1:world:x"), b = sideStream("1:world:x"), c = sideStream("1:world:y");
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
    expect(sideStream("1:world:x").next()).not.toBe(c.next());
  });
});

describe("ORW-509 alliance names", () => {
  it("the composed space is large and no fixed short list stands behind it", () => {
    expect(ALLIANCE_NAME_SPACE).toBeGreaterThan(1500);
    expect(readFileSync("src/engine/alliances.ts", "utf8")).not.toMatch(/ALLIANCE_NAMES\b/);
    expect(new Set(Array.from({ length: ALLIANCE_NAME_SPACE }, (_, i) => allianceNameAt(i))).size).toBe(ALLIANCE_NAME_SPACE);
  });
  it("takes exactly one draw and never needs a numbered fallback in a season", () => {
    const { rng, draws } = counting(9);
    const taken = new Set<string>();
    for (let i = 0; i < 40; i++) { const before = draws(); const n = pickAllianceName(rng, taken); taken.add(n); expect(draws() - before).toBe(1); expect(n).not.toMatch(/ \d+$/); }
    expect(taken.size).toBe(40);
  });
  it("skips the previous season's names while others are left", () => {
    const first = pickAllianceName(new SeededRandom(5), new Set());
    expect(pickAllianceName(new SeededRandom(5), new Set(), new Set([first]))).not.toBe(first);
  });
});

describe("ORW-509 house events", () => {
  it("takes exactly one rng draw per pick, as the old pool pick did", () => {
    const { rng, draws } = counting(4);
    nextHouseEvent(new InMemoryEventStore(), rng, { week: 1, phase: "hoh" });
    expect(draws()).toBe(1);
  });
  it("keeps the 32 authored lines first and composes far past them", () => {
    expect(HOUSE_EVENT_SPACE).toBeGreaterThan(20000);
    expect(HOUSE_EVENT_POOL.map((_, i) => houseEventLineAt(i))).toEqual([...HOUSE_EVENT_POOL]);
    for (const i of [40, 999, 12345]) expect(houseEventLineAt(i)).toMatch(/^[A-Z].*\.$/);
  });
  it("honours the previous season's lines (avoid)", () => {
    const store = new InMemoryEventStore();
    const a = nextHouseEvent(store, new SeededRandom(2), { week: 1, phase: "hoh" }).replace(/^Week \d+(, day \d+)?: /, "");
    const b = nextHouseEvent(new InMemoryEventStore(), new SeededRandom(2), { week: 1, phase: "hoh", avoid: new Set([a]) }).replace(/^Week \d+(, day \d+)?: /, "");
    expect(b).not.toBe(a);
  });
});

describe("ORW-509 competition skins", () => {
  it("the world pool is wider than a season and keeps HOH and veto worlds disjoint across 14 weeks", () => {
    expect(COMPETITION_THEMES.length).toBeGreaterThanOrEqual(80);
    for (const seed of [1, 7, 42, 1234]) {
      const hoh = new Set<string>(), veto = new Set<string>();
      for (let w = 1; w <= 14; w++) { hoh.add(themeForWeek(seed, "hoh", w).id); veto.add(themeForWeek(seed, "veto", w).id); }
      expect(hoh.size).toBe(14);
      expect(veto.size).toBe(14);
      expect([...hoh].filter((x) => veto.has(x))).toEqual([]);
    }
  });
  it("avoid removes last season's worlds while a season's worth is left, and is a pure function of its inputs", () => {
    const prev = Array.from({ length: 14 }, (_, w) => themeForWeek(5, "hoh", w + 1).id);
    for (let w = 1; w <= 14; w++) expect(prev).not.toContain(themeForWeek(6, "hoh", w, 0, prev).id);
    expect(themeForWeek(6, "veto", 3, 0, prev)).toEqual(themeForWeek(6, "veto", 3, 0, prev));
  });
  it("a beat key dresses the authored beats; no key leaves them as they were", () => {
    const def = COMPETITION_LIBRARY[0]!;
    const theme = themeForWeek(1, def.phase, 1);
    expect(applyTheme(def, theme).narrative.beats).toEqual(def.narrative.beats);
    const dressed = applyTheme(def, theme, "1:hoh:1:0").narrative.beats;
    dressed.forEach((b, i) => expect(b.startsWith(def.narrative.beats[i]!)).toBe(true));
    expect(BEAT_FLOURISHES.length).toBeGreaterThanOrEqual(40);
  });
});

describe("ORW-509 writer-authored house acceptance", () => {
  const draft = (over: Record<string, unknown> = {}): unknown => ({
    name: "The Lantern Inn", pitch: "An old coaching inn at the end of a snowed-in road, every room lit by a different lantern.",
    rooms: Object.fromEntries(HOUSE_ROOMS.map((r) => [r, { name: `the ${r.replace(/-/g, " ")} lantern ${r.length}x`, look: "Low beams, a single hanging lantern, and a smell of woodsmoke and old paper." }])),
    ...over,
  });
  it("accepts a well-formed fresh house and resolves it like a library theme", () => {
    const r = acceptHouseThemeDraft(draft());
    expect(r.accepted).toBe(true);
    registerHouseTheme(r.theme!);
    expect(houseTheme(r.theme!.id)?.name).toBe("The Lantern Inn");
    expect(roomLabel("kitchen", r.theme!.id)).toBe("the lantern kitchen");
  });
  it("counts rejections by rule and falls back to the library, never throwing", () => {
    expect(acceptHouseThemeDraft(null).rejected.shape).toBe(1);
    expect(acceptHouseThemeDraft(draft({ pitch: "short" })).rejected.length).toBe(1);
    const dup = draft({ rooms: Object.fromEntries(HOUSE_ROOMS.map((r) => [r, { name: "the same room", look: "Low beams, a single hanging lantern, and a smell of woodsmoke." }])) });
    expect(acceptHouseThemeDraft(dup).rejected["unique-in-house"]).toBe(1);
    const lib = HOUSE_THEMES[0]!;
    // ORW-968: the library's HOH room, landing, storage room and Diary Room are the plain word alone (a writer's draft may not be), so those four get a name of their own; the other ten are the library's, which is what the freshness rule refuses
    const plainOnly = new Set(["hoh-room", "landing", "storage-room", "diary-room"]);
    const copied = draft({ rooms: Object.fromEntries(HOUSE_ROOMS.map((r) => [r, { name: plainOnly.has(r) ? `the ${r.replace(/-/g, " ")} annex` : lib.rooms[r].name, look: lib.rooms[r].look }])) });
    const res = acceptHouseThemeDraft(copied);
    expect(res.accepted).toBe(false);
    expect(res.rejected.fresh).toBe(1);
    expect(res.fallback).toBe("library");
    expect(HOUSE_THEMES.map((t) => t.id)).toContain(drawHouseTheme(7));
  });
  it("refuses room names the last seasons used", () => {
    const ok = acceptHouseThemeDraft(draft());
    const avoidNames = HOUSE_ROOMS.map((r) => ok.theme!.rooms[r].name);
    expect(acceptHouseThemeDraft(draft(), { avoidNames }).rejected.fresh).toBe(1);
  });
});

describe("ORW-509 curiosity needle", () => {
  it("keeps the five authored lines and composes far past them, one line a season", () => {
    expect(CURIOSITY_NEEDLE_SPACE).toBeGreaterThan(100);
    expect(composedCuriosityNeedle(1)).toBe(composedCuriosityNeedle(1));
    const a = composedCuriosityNeedle(1);
    expect(composedCuriosityNeedle(1, [a])).not.toBe(a);
    expect(CURIOSITY_NEEDLES.length).toBe(5);
  });
});

describe("ORW-604 alliance name floor", () => {
  it("is composed (no dealt short list), deterministic per seed, and unique within a game", () => {
    const run = (seed: number): string[] => { const r = new SeededRandom(seed), taken = new Set<string>(); for (let i = 0; i < 30; i++) taken.add(pickAllianceName(r, taken)); return [...taken]; };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).toHaveLength(30);
    expect(ALLIANCE_NAME_SPACE).toBeGreaterThan(1500);
  });
});
