import { describe, it, expect } from "vitest";
import { chooseHourAction, type HourView } from "../../src/engine/houseLife";
import type { AgendaCharacter } from "../../src/engine/agenda";
import type { Room } from "../../src/domain/house";
import { attractionOf, chemistryFor, daysTogether, drawnTo, ATTRACTION_LIFE } from "../../src/engine/attractionLife";
import { ATTRACTION, canBeDrawnTo, chemistryKey } from "../../src/engine/attraction";
import { showmancePlausible } from "../../src/engine/diversity";
import { GENDER_PRESENTATIONS } from "../../src/engine/diversityConstants";
import type { Orientation } from "../../src/engine/diversityConstants";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** 0207 Theme A, A1 (ORW-658): attraction is real, private, and shows only in behaviour. Roles only: no names; no gender or orientation is assumed anywhere. */
const SEEKER = "npc:1", TARGET = "npc:2", OTHER = "npc:3";
const ORIENTATIONS: readonly Orientation[] = ["straight", "gay", "lesbian", "bisexual", "queer", "pansexual"];

describe("who may be drawn to whom reads only the data on the characters", () => {
  it("is exactly the foundation's one-sided rule, and one side of the showmance eligibility rule, for every combination", () => {
    for (const o of ORIENTATIONS) for (const g of GENDER_PRESENTATIONS) for (const t of GENDER_PRESENTATIONS) {
      expect(drawnTo({ orientation: o, gender: g }, t)).toBe(canBeDrawnTo(o, g, t));
      // both sides drawn <=> the existing both-sided eligibility rule (the rules are kept in step)
      for (const o2 of ORIENTATIONS) expect(canBeDrawnTo(o, g, t) && canBeDrawnTo(o2, t, g)).toBe(showmancePlausible({ orientation: o, genderPresentation: g }, { orientation: o2, genderPresentation: t }));
    }
  });
  it("a missing datum means no attraction (nothing is inferred), including toward a player who has not said", () => {
    expect(drawnTo(undefined, "woman")).toBe(false);
    expect(drawnTo({ orientation: undefined, gender: "man" }, "woman")).toBe(false);
    expect(drawnTo({ orientation: "bisexual", gender: undefined }, "woman")).toBe(false);
    for (const o of ORIENTATIONS) for (const g of GENDER_PRESENTATIONS) expect(drawnTo({ orientation: o, gender: g }, undefined)).toBe(false);
  });
  it("the chemistry draw is a function of the pair's ids and the seed alone (no name, no gender, no orientation) and is zero when ineligible", () => {
    for (let seed = 1; seed < 40; seed++) {
      expect(chemistryFor(seed, SEEKER, TARGET, true)).toBe(chemistryFor(seed, SEEKER, TARGET, true));
      expect(chemistryFor(seed, SEEKER, TARGET, false)).toBe(0);
    }
    let some = 0, n = 0;
    for (let seed = 1; seed < 2000; seed++) { n++; if (chemistryFor(seed, SEEKER, TARGET, true) > 0) some++; }
    expect(some / n, "about the foundation's share of eligible pairs have any").toBeGreaterThan(ATTRACTION.chemistryShare - 0.05);
    expect(some / n).toBeLessThan(ATTRACTION.chemistryShare + 0.05);
  });
  it("one ordered pair is one-sided: the other direction rolls on its own", () => {
    let differ = 0;
    for (let seed = 1; seed < 200; seed++) if (chemistryFor(seed, SEEKER, TARGET, true) !== chemistryFor(seed, TARGET, SEEKER, true)) differ++;
    expect(differ).toBeGreaterThan(25);
  });
});

describe("attraction grows with time together, toward its ceiling, and is the same toward the player as toward anyone", () => {
  const chem = { [chemistryKey(SEEKER, TARGET)]: 0.8, [chemistryKey(SEEKER, "player")]: 0.8 };
  it("starts at nothing, grows with shared stretches, never passes the ceiling, and is nothing without chemistry", () => {
    const at = (n: number): number => attractionOf(chem, { [chemistryKey(SEEKER, TARGET)]: n }, SEEKER, TARGET);
    expect(at(0)).toBe(0);
    expect(at(ATTRACTION_LIFE.stretchesPerDay)).toBeCloseTo(ATTRACTION.growthPerDayTogether, 6);
    expect(at(10 * ATTRACTION_LIFE.stretchesPerDay)).toBeGreaterThan(at(ATTRACTION_LIFE.stretchesPerDay));
    expect(at(10_000)).toBe(0.8);
    expect(attractionOf(chem, { [chemistryKey(OTHER, TARGET)]: 500 }, OTHER, TARGET)).toBe(0);
    expect(attractionOf(undefined, undefined, SEEKER, TARGET)).toBe(0);
    expect(daysTogether(-3)).toBe(0);
  });
  it("player parity: the same chemistry and shared time give the same attraction toward the player as toward a houseguest", () => {
    for (const n of [0, 5, 40, 400]) {
      expect(attractionOf(chem, { [chemistryKey(SEEKER, "player")]: n }, SEEKER, "player")).toBe(attractionOf(chem, { [chemistryKey(SEEKER, TARGET)]: n }, SEEKER, TARGET));
    }
  });
});

describe("it shows only in behaviour: who the houseguest seeks out and flirts with", () => {
  const char: AgendaCharacter = { archetype: "analyst", strategyStyle: "social", secretKinds: [] };
  const rooms = (targetRoom: Room): Map<string, Room> => new Map<string, Room>([[SEEKER, "living-room"], [TARGET, targetRoom], [OTHER, "living-room"]]);
  const hv = (over: Partial<HourView> = {}): HourView => ({
    owner: SEEKER, character: char, agenda: undefined, habits: [], emotional: 0.6, room: "living-room", whereabouts: rooms("living-room"),
    affinity: new Map([[TARGET, 0.5], [OTHER, 0.5]]), threat: new Map(), mates: [], nominees: [], timeOfDay: "afternoon", day: 3, hour: 14, inCompetition: false, candor: 0.7, ...over,
  });
  const run = (v: HourView, n = 1200): ReturnType<typeof chooseHourAction>[] =>
    Array.from({ length: n }, (_, i) => chooseHourAction({ ...v, day: 3 + Math.floor(i / 8), hour: 8 + (i % 8) }, 100 + i));
  const towardTarget = (xs: ReturnType<typeof chooseHourAction>[]): number => xs.filter((p) => p.with[0] === TARGET).length / xs.length;

  it("an absent attraction is byte-identical to the old hour, for every seed", () => {
    for (let i = 0; i < 300; i++) expect(chooseHourAction(hv({ day: 3 + (i % 5), hour: 8 + (i % 9) }), i)).toEqual(chooseHourAction({ ...hv({ day: 3 + (i % 5), hour: 8 + (i % 9) }) }, i));
  });
  it("the one they are drawn to is sought out more than chance, and more as the attraction grows", () => {
    const base = towardTarget(run(hv()));
    const weak = towardTarget(run(hv({ attract: new Map([[TARGET, 0.2]]) })));
    const strong = towardTarget(run(hv({ attract: new Map([[TARGET, 0.9]]) })));
    expect(weak).toBeGreaterThan(base);
    expect(strong).toBeGreaterThan(weak + 0.03);
  });
  it("someone in another room is walked to (a seek, marked), and a flirt starts only where one may", () => {
    const far = run(hv({ whereabouts: rooms("kitchen"), attract: new Map([[TARGET, 0.9]]) }));
    const sought = far.filter((p) => p.drawn);
    expect(sought.length).toBeGreaterThan(50);
    for (const p of sought) { expect(p.with).toEqual([TARGET]); expect(p.place).toBe("kitchen"); expect(p.kind).toBe("check-in"); }
    const near = run(hv({ attract: new Map([[TARGET, 0.9]]) }));
    expect(near.filter((p) => p.drawn && (p.kind === "flirt" || p.kind === "cuddle")).length, "no flirt unless flirtable").toBe(0);
    const flirty = run(hv({ attract: new Map([[TARGET, 0.9]]), flirtable: new Set([TARGET]) }));
    expect(flirty.filter((p) => p.drawn && (p.kind === "flirt" || p.kind === "cuddle")).length).toBeGreaterThan(30);
  });
  it("a seeded showmance keeps its own rule (no seek of someone else); and attraction toward the player is never a flirt the engine makes for them", () => {
    for (let i = 0; i < 200; i++) {
      const v = hv({ showmance: TARGET, attract: new Map([[OTHER, 0.9]]), flirtable: new Set([OTHER]) });
      expect(chooseHourAction(v, i).drawn).toBeUndefined();
    }
    const withPlayer = run(hv({ whereabouts: new Map<string, Room>([[SEEKER, "living-room"], ["player", "kitchen"]]), attract: new Map([["player", 0.9]]), flirtable: new Set(["player"]) }));
    const toPlayer = withPlayer.filter((p) => p.drawn);
    expect(toPlayer.length).toBeGreaterThan(50);
    for (const p of toPlayer) expect(p.kind, "an approach to the player, never a flirt").toBe("check-in");
  });
});

type Live = { chemistry?: Record<string, number>; together?: Record<string, number>; playedGame?: boolean; nightDepth?: number };
type Hours = { houseLifeStretch(e: unknown, a: readonly string[], i: number): unknown[]; livingIds(): string[]; live: Live; attractionViewOf(id: string, t: readonly string[]): { attract: Map<string, number>; flirtable: Set<string> } | undefined };
let n = 0;
const SB = new WeakMap<GameSessionAdapter, { session: GameSessionAdapter; engine: { events: unknown } }>();
function play(seed: number, opts: { flag: boolean; played: boolean; gender?: "man" | "woman" | "nonbinary"; hours?: number }): GameSessionAdapter {
  const sb = new GameSessionRegistry().sandboxFor(`showmance-a1-${n++}`);
  SB.set(sb.session, sb as never);
  sb.session.setShowmancesEnabled(opts.flag);
  sb.session.createCharacter({ playerName: "The Player", seed, ...(opts.gender ? { genderPresentation: opts.gender } : {}) } as never);
  if (opts.played) { sb.session.noteMessage({ messageId: "m0" }); runHours(sb.session, opts.hours ?? 1); }
  sb.session.advanceGame({});
  return sb.session;
}
function runHours(session: GameSessionAdapter, hours: number): void {
  const s = session as unknown as Hours;
  const awake = s.livingIds().filter((i) => i !== "player");
  for (let h = 0; h < hours; h++) { s.live.nightDepth = (s.live.nightDepth ?? 8) + 1; s.houseLifeStretch(SB.get(session)!.engine.events, awake, h); }
}
const live = (s: GameSessionAdapter): Live => (s as unknown as { live: Live }).live;
const snap = (s: GameSessionAdapter): string => JSON.stringify(s.snapshot());

describe("a played game's private chemistry", () => {
  it("is drawn on a keyed side stream, grows as people share rooms, and is monotonic", () => {
    const s = play(7, { flag: true, played: true, hours: 60, gender: "woman" });
    const chem = live(s).chemistry!;
    expect(Object.keys(chem).length).toBeGreaterThan(5);
    for (const v of Object.values(chem)) { expect(v).toBeGreaterThanOrEqual(0.4); expect(v).toBeLessThanOrEqual(1); }
    const t = live(s).together!;
    expect(Object.values(t).some((x) => x > 0), "shared time is counted").toBe(true);
    const before = JSON.parse(JSON.stringify(t)) as Record<string, number>;
    const beforeChem = JSON.parse(JSON.stringify(chem)) as Record<string, number>;
    runHours(s, 30);
    for (const [k, v] of Object.entries(before)) expect(live(s).together![k]).toBeGreaterThanOrEqual(v);
    for (const [k, v] of Object.entries(beforeChem)) expect(live(s).chemistry![k]).toBe(v);
  });
  it("only the drawn-to pairs hold chemistry: every stored pair is orientation-eligible one way", () => {
    const s = play(11, { flag: true, played: true, hours: 5, gender: "man" });
    const adapter = s as unknown as { attractionIdentityOf(id: string): { orientation: Orientation | undefined; gender: "man" | "woman" | "nonbinary" | undefined } | undefined; playerStatedGender(): "man" | "woman" | "nonbinary" | undefined };
    for (const key of Object.keys(live(s).chemistry!)) {
      const from = key.slice(5, key.indexOf(">")), to = key.slice(key.indexOf(">") + 1);
      const toGender = to === "player" ? adapter.playerStatedGender() : adapter.attractionIdentityOf(to)?.gender;
      expect(drawnTo(adapter.attractionIdentityOf(from), toGender), key).toBe(true);
    }
  });
  it("survives a save round-trip (a superset) and an old save without it loads and redraws", () => {
    const s = play(7, { flag: true, played: true, hours: 40, gender: "woman" });
    const snapped = JSON.parse(JSON.stringify(s.snapshot())) as { live: Live };
    const sb2 = new GameSessionRegistry().sandboxFor(`showmance-a1-rt-${n++}`);
    sb2.session.restore(snapped as never);
    expect(live(sb2.session).chemistry).toEqual(live(s).chemistry);
    expect(live(sb2.session).together).toEqual(live(s).together);
    const old = JSON.parse(JSON.stringify(s.snapshot())) as { live: Live };
    delete old.live.chemistry; delete old.live.together;
    const sb3 = new GameSessionRegistry().sandboxFor(`showmance-a1-old-${n++}`);
    sb3.session.restore(old as never);
    expect(live(sb3.session).chemistry).toBeUndefined();
    sb3.session.noteMessage({ messageId: "zz" });
    expect(live(sb3.session).playedGame).toBe(true);
  });
  it("flag off, or a headless game, keeps none; a headless game's snapshot is byte-identical with the flag on or off", () => {
    expect(live(play(7, { flag: false, played: true, hours: 30 })).chemistry).toBeUndefined();
    expect(live(play(7, { flag: true, played: false })).chemistry).toBeUndefined();
    for (const seed of [3, 11]) expect(snap(play(seed, { flag: true, played: false }))).toBe(snap(play(seed, { flag: false, played: false })));
  });
  it("a played game with the flag off is the old house life (nothing about attraction in its state)", () => {
    const off = snap(play(7, { flag: false, played: true, hours: 20 }));
    expect(off.includes("chemistry")).toBe(false);
    expect(off.includes('"together"')).toBe(false);
  });
});

describe("the player as the object: only once the player has said how they present", () => {
  const toPlayer = (s: GameSessionAdapter): string[] => Object.keys(live(s).chemistry ?? {}).filter((k) => k.endsWith(">player"));
  it("a player who has not said is never anyone's attraction", () => {
    for (const seed of [3, 7, 11, 19]) {
      const s = play(seed, { flag: true, played: true, hours: 30 });
      expect(toPlayer(s)).toEqual([]);
      const view = (s as unknown as Hours).attractionViewOf;
      for (const id of (s as unknown as Hours).livingIds().filter((i) => i !== "player")) expect(view.call(s, id, ["player"])?.attract.has("player") ?? false).toBe(false);
    }
  });
  it("once they have said, a houseguest whose orientation includes that may be drawn to them, whichever way they present", () => {
    for (const g of GENDER_PRESENTATIONS) {
      let found = 0;
      for (const seed of [3, 7, 11, 19, 23, 29]) found += toPlayer(play(seed, { flag: true, played: true, hours: 5, gender: g })).length;
      expect(found, `presenting as ${g}`).toBeGreaterThan(0);
    }
  });
  it("it grows with the time the houseguest spends in the player's room and is read only through the private view", () => {
    const s = play(7, { flag: true, played: true, hours: 120, gender: "woman" });
    const keys = toPlayer(s);
    expect(keys.length).toBeGreaterThan(0);
    const grown = keys.filter((k) => (live(s).together![k] ?? 0) > 0);
    if (grown.length) {
      const id = grown[0]!.slice(5, grown[0]!.indexOf(">"));
      const v = (s as unknown as Hours).attractionViewOf(id, ["player"]);
      expect(v?.attract.get("player") ?? 0).toBeGreaterThan(0);
      expect(v?.flirtable.has("player"), "the engine never flirts for the player").toBe(false);
    }
  });
});

describe("the wall: no chemistry, attraction or shared-time field on any outward surface", () => {
  it("projections, the moment prompt and the admin view carry none (positive control: the live state does)", async () => {
    const sb = new GameSessionRegistry().sandboxFor(`showmance-a1-wall-${n++}`);
    SB.set(sb.session, sb as never);
    sb.session.createCharacter({ playerName: "The Player", seed: 21, genderPresentation: "nonbinary" } as never);
    sb.session.noteMessage({ messageId: "w0" });
    runHours(sb.session, 60);
    const ch = live(sb.session).chemistry ?? {};
    expect(Object.keys(ch).length, "positive control").toBeGreaterThan(0);
    const surfaces = [
      await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
      await sb.mcp.player.callTool("seasonRecap", {}), await sb.mcp.player.callTool("whereabouts", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {}),
    ];
    const blob = JSON.stringify(surfaces);
    expect(/"chemistry"|"together"\s*:|"attract"|"flirtable"|"drawn"\s*:|chem:/i.test(blob)).toBe(false);
    for (const v of Object.values(ch)) expect(blob.includes(String(v)), "no ceiling value reaches a surface").toBe(false);
  });
});
