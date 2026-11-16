import { describe, it, expect } from "vitest";
import { chooseHourAction, type HourView, type ActionKind } from "../../src/engine/houseLife";
import { HOUSE_LIFE, type HouseCulture } from "../../src/engine/houseLifeConstants";
import { dialMult, HOUSE_LEAN_TUNING, LEAN_IDS, DIAL_IDS, type LeanId } from "../../src/engine/houseLeans";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { Room } from "../../src/domain/house";
import type { Archetype } from "../../src/engine/characterFactory";

/** ORW-551 / spec 0168 slice 2: the house culture scales the house-life BASELINE of four dials. Roles only. */
const HOLDER = "npc:1", FRIEND = "npc:4", FOE = "npc:3", AWAY = "npc:6", PARTNER = "npc:7";
const NONE: HouseCulture = { gossip: 1, conflict: 1, flirting: 1, lying: 1 };
const cultureOf = (id: LeanId): HouseCulture => {
  const c = { leans: [{ id, w: 1 }] };
  return { gossip: dialMult(c, "gossip"), conflict: dialMult(c, "conflict"), flirting: dialMult(c, "flirting"), lying: dialMult(c, "lying") };
};
const person = (archetype: Archetype) => ({ archetype, strategyStyle: "social" as const, secretKinds: [] });
function view(over: Partial<HourView> = {}): HourView {
  return {
    owner: HOLDER, character: person("analyst"), agenda: undefined, habits: [], emotional: 0.5, room: "living-room",
    whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [FRIEND, "living-room"], [FOE, "living-room"], [AWAY, "kitchen"], [PARTNER, "living-room"]]),
    affinity: new Map([[FRIEND, 0.8], [FOE, 0.1], [AWAY, 0.5], [PARTNER, 0.8]]), threat: new Map([[AWAY, 0.8]]),
    mates: [], nominees: [], timeOfDay: "afternoon", day: 3, hour: 14, inCompetition: false, candor: 0.7, ...over,
  };
}
const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
/** Rate of `kinds` over a fixed seed x hour set. */
function rate(v: HourView, kinds: ActionKind[]): number {
  let hit = 0, n = 0;
  for (const seed of SEEDS) for (let h = 8; h < 24; h++) { n++; if (kinds.includes(chooseHourAction({ ...v, hour: h }, seed).kind)) hit++; }
  return hit / n;
}
const gossipView = (culture?: HouseCulture) => view({ whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [FRIEND, "living-room"], [AWAY, "kitchen"]]), affinity: new Map([[FRIEND, 0.8], [AWAY, 0.5]]), ...(culture ? { culture } : {}) });
const frictionView = (culture?: HouseCulture, who: Archetype = "hothead") => view({ whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [FOE, "living-room"]]), affinity: new Map([[FOE, 0.1]]), threat: new Map(), character: person(who), ...(culture ? { culture } : {}) });
const romanceView = (culture?: HouseCulture) => view({ showmance: PARTNER, ...(culture ? { culture } : {}) });

describe("each dial moves the way its lean says", () => {
  it("a gossip-mill culture gossips more than no culture", () => {
    expect(rate(gossipView(cultureOf("gossip-mill")), ["gossip"])).toBeGreaterThan(rate(gossipView(), ["gossip"]));
  });
  it("a showmance culture flirts more with a showmance partner", () => {
    expect(rate(romanceView(cultureOf("showmance")), ["flirt", "cuddle"])).toBeGreaterThan(rate(romanceView(), ["flirt", "cuddle"]));
  });
  it("a powder-keg culture fights more (the conflict dial is a threshold: below 1 raises the chance); a family culture fights less", () => {
    expect(cultureOf("powder-keg").conflict).toBeLessThan(1);
    expect(cultureOf("one-big-family").conflict).toBeGreaterThan(1);
    const base = rate(frictionView(), ["chore-fight"]);
    expect(base).toBeGreaterThan(0);
    expect(rate(frictionView(cultureOf("powder-keg")), ["chore-fight"])).toBeGreaterThan(base);
    expect(rate(frictionView(cultureOf("one-big-family")), ["chore-fight"])).toBeLessThan(base);
  });
  it("an honor-code culture lies less in scheming speech, a liars-season culture lies more", () => {
    const lies = (c?: HouseCulture): number => {
      let n = 0, lied = 0;
      for (const seed of SEEDS) for (let h = 8; h < 24; h++) {
        const p = chooseHourAction(view({
          hour: h, candor: 0.75, ...(c ? { culture: c } : {}),
          agenda: { owner: HOLDER, history: [], formedForWeek: 1, goals: [{ id: "g", owner: HOLDER, horizon: "week", kind: "long-con", target: FOE, why: [{ kind: "character", weight: 1 }], test: { kind: "survives-week" }, commitment: 1, status: "active", formedDay: 1, formedWeek: 1 }] },
          whereabouts: new Map<string, Room>([[HOLDER, "living-room"], [FOE, "living-room"], [FRIEND, "living-room"]]),
        }), seed);
        if (p.goalKind === "long-con") { n++; if (!p.truthful) lied++; }
      }
      expect(n).toBeGreaterThan(50);
      return lied / n;
    };
    const base = lies();
    expect(lies(cultureOf("honor-code"))).toBeLessThan(base);
    expect(lies(cultureOf("liars-season"))).toBeGreaterThan(base);
  });
});

describe("bounded, individual, and neutral without a culture", () => {
  it("every multiplier any single lean produces is within the 1.35 factor, so the baseline never moves further", () => {
    const F = HOUSE_LEAN_TUNING.MAX_FACTOR;
    for (const id of LEAN_IDS) for (const d of ["gossip", "conflict", "flirting", "lying"] as const) {
      const v = dialMult({ leans: [{ id, w: 1 }] }, d);
      expect(v).toBeLessThanOrEqual(F); expect(v).toBeGreaterThanOrEqual(1 / F);
    }
    expect(DIAL_IDS).toContain("conflict");
    expect(HOUSE_LIFE.gossipChance * F).toBeLessThan(1);
    expect(HOUSE_LIFE.romanceChance * F).toBeLessThan(1);
  });
  it("a culture of exactly 1 and no culture plan identically, hour for hour", () => {
    for (const mk of [gossipView, frictionView, romanceView]) for (const seed of SEEDS) for (let h = 8; h < 24; h++) {
      expect(chooseHourAction({ ...mk(NONE), hour: h }, seed)).toEqual(chooseHourAction({ ...mk(), hour: h }, seed));
    }
  });
  it("individuals still push against the culture: a hothead in a house that leans against fighting still fights more than a peacemaker in a powder keg", () => {
    const hot = rate(frictionView(cultureOf("one-big-family"), "hothead"), ["chore-fight"]);
    const calm = rate(frictionView(cultureOf("powder-keg"), "peacemaker"), ["chore-fight"]);
    expect(hot).toBeGreaterThan(calm);
  });
});

describe("a played game", () => {
  let n = 0;
  const play = (seed: number, setup: (s: GameSessionAdapter) => void): string => {
    const sb = new GameSessionRegistry().sandboxFor(`dials0159-${n++}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    setup(sb.session);
    sb.session.noteMessage({ messageId: "m1" });
    sb.session.advanceGame({});
    const x = sb.session.snapshot() as unknown as { live?: { houseLeans?: unknown } };
    if (x.live) delete x.live.houseLeans;
    return JSON.stringify(x);
  };
  it("flag off equals a neutral culture exactly (no dial moves without a culture)", () => {
    for (const seed of [3, 11]) {
      const off = play(seed, (s) => s.setHouseCultureEnabled(false));
      const neutral = play(seed, (s) => { s.setHouseCultureEnabled(true); (s as unknown as { live: { houseLeans?: unknown } }).live.houseLeans = { leans: [] }; });
      expect(neutral).toBe(off);
    }
  });
});
