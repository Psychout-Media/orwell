import { describe, it, expect } from "vitest";
import { dialMult, HOUSE_LEAN_TUNING, LEAN_IDS, type DialId, type HouseLeans } from "../../src/engine/houseLeans";
import { nominationBaseVals } from "../../src/engine/season";
import { derivedLoyalty } from "../../src/engine/blocs";
import { npcWouldCall, MEETING, type Grievance } from "../../src/engine/houseMeeting";
import { RelationshipModel } from "../../src/engine/relationships";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** ORW-551 / spec 0168 slice 3: the culture leans paranoia, loyalty, bonding, alliance size and meetings. Roles only. */
const one = (id: (typeof LEAN_IDS)[number]): HouseLeans => ({ leans: [{ id, w: 1 }] });
const F = HOUSE_LEAN_TUNING.MAX_FACTOR;
const SLICE3: DialId[] = ["paranoia", "loyalty", "bonding", "allianceSize", "meetings"];

describe("each dial moves the way its lean says, never past the bound", () => {
  it("paranoid raises paranoia, ride-or-die raises loyalty, majority-bloc raises alliance size, powder-keg raises meetings, one-big-family raises bonding", () => {
    expect(dialMult(one("paranoid"), "paranoia")).toBeGreaterThan(1);
    expect(dialMult(one("ride-or-die"), "loyalty")).toBeGreaterThan(1);
    expect(dialMult(one("backstabbers"), "loyalty")).toBeLessThan(1);
    expect(dialMult(one("majority-bloc"), "allianceSize")).toBeGreaterThan(1);
    expect(dialMult(one("duos"), "allianceSize")).toBeLessThan(1);
    expect(dialMult(one("powder-keg"), "meetings")).toBeGreaterThan(1);
    expect(dialMult(one("one-big-family"), "bonding")).toBeGreaterThan(1);
    expect(dialMult(one("cold-war"), "bonding")).toBeLessThan(1);
  });
  it("no lean moves any slice-3 dial beyond 1.35 of baseline", () => {
    for (const id of LEAN_IDS) for (const d of SLICE3) {
      const v = dialMult(one(id), d);
      expect(v).toBeLessThanOrEqual(F); expect(v).toBeGreaterThanOrEqual(1 / F);
    }
  });
});

describe("the pure seams take the multiplier as an argument and are exact at 1", () => {
  const rel = new RelationshipModel(0.6);
  it("the rattled-HOH paranoia term scales with the multiplier, the threat term does not; 1 is unchanged", () => {
    const [t1, p1] = nominationBaseVals("npc:1", "npc:2", rel, 0.1);
    const [t2, p2] = nominationBaseVals("npc:1", "npc:2", rel, 0.1, 1);
    expect([t2, p2]).toEqual([t1, p1]);
    const [t3, p3] = nominationBaseVals("npc:1", "npc:2", rel, 0.1, F);
    expect(t3).toBe(t1);
    expect(p3).toBeCloseTo(p1 * F, 12);
    expect(nominationBaseVals("npc:1", "npc:2", rel, 0.9, F)[1]).toBe(0); // a calm HOH is untouched: the dial scales the weight, not the mood
  });
  it("derived loyalty scales the disposition baseline; the soul swing still applies; 1 is unchanged", () => {
    expect(derivedLoyalty("neutral", 0.5, 1)).toBe(derivedLoyalty("neutral", 0.5));
    expect(derivedLoyalty("neutral", 0.5, 1.2)).toBeGreaterThan(derivedLoyalty("neutral", 0.5));
    expect(derivedLoyalty("neutral", 0.5, 1 / 1.2)).toBeLessThan(derivedLoyalty("neutral", 0.5));
    expect(derivedLoyalty("bond", 1, F)).toBeLessThanOrEqual(1);
    expect(derivedLoyalty("bond", 0.2, 1.2)).toBeLessThan(derivedLoyalty("bond", 0.8, 1.2)); // the individual's own state still moves it
  });
  it("a higher meetings multiplier moves only the threshold: the same roll calls at a higher dial and not at 1", () => {
    const g: Grievance = { holder: "npc:1", subject: "npc:2", kind: "going-after", object: "npc:1", strength: 1 };
    const roll = MEETING.callChancePerDay * 1.2;
    expect(npcWouldCall(g, false, roll)).toBe(false);
    expect(npcWouldCall(g, false, roll, 1)).toBe(false);
    expect(npcWouldCall(g, false, roll, F)).toBe(true);
    expect(npcWouldCall(g, false, 0.0, 1)).toBe(true);
  });
});

describe("in a played game", () => {
  let n = 0;
  type L = { live: { houseLeans?: HouseLeans } };
  const start = (seed: number, culture?: HouseLeans): GameSessionAdapter => {
    const sb = new GameSessionRegistry().sandboxFor(`rel0159-${n++}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    sb.session.setHouseCultureEnabled(culture !== undefined);
    if (culture) (sb.session as unknown as L).live.houseLeans = culture;
    sb.session.noteMessage({ messageId: "m1" });
    return sb.session;
  };
  it("an empty culture plays identically to no culture over several beats (seeds 3 and 11)", () => {
    for (const seed of [3, 11]) {
      const run = (c?: HouseLeans): string => {
        const s = start(seed, c);
        for (let i = 0; i < 6; i++) s.advanceGame({});
        const x = s.snapshot() as unknown as { live?: { houseLeans?: unknown } };
        if (x.live) delete x.live.houseLeans;
        return JSON.stringify(x);
      };
      expect(run({ leans: [] })).toBe(run(undefined));
    }
  });
  it("the bond-speed seam reads the live culture: a family house warms faster and stings less, a cold-war house the reverse, none leaves it alone", () => {
    const id = "npc:1";
    const none = start(3).socialFoldValence(id);
    expect(start(3, { leans: [] }).socialFoldValence(id)).toEqual(none);
    const fam = start(3, one("one-big-family")).socialFoldValence(id);
    const cold = start(3, one("cold-war")).socialFoldValence(id);
    expect(fam.warm).toBeGreaterThan(none.warm); expect(fam.sore).toBeLessThan(none.sore);
    expect(cold.warm).toBeLessThan(none.warm); expect(cold.sore).toBeGreaterThan(none.sore);
    expect(fam.warm / none.warm).toBeLessThanOrEqual(F);
  });
  it("the season context carries the paranoia dial: raised for a paranoid house, exactly 1 without", () => {
    const pm = (s: GameSessionAdapter): number | undefined => (s as unknown as { ctx(): { paranoiaMult?: number } }).ctx().paranoiaMult;
    expect(pm(start(3))).toBe(1);
    expect(pm(start(3, { leans: [] }))).toBe(1);
    expect(pm(start(3, one("paranoid")))!).toBeGreaterThan(1);
  });
});
