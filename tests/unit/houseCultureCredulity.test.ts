import { describe, it, expect } from "vitest";
import { dialMult, HOUSE_LEAN_TUNING, LEAN_IDS, type HouseLeans } from "../../src/engine/houseLeans";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/** ORW-551 / spec 0168 slice 5: the culture leans a listener's credulity at the one adapter seam. Roles only. */
const one = (id: (typeof LEAN_IDS)[number]): HouseLeans => ({ leans: [{ id, w: 1 }] });
const F = HOUSE_LEAN_TUNING.MAX_FACTOR;
type L = { live: { houseLeans?: HouseLeans } };
let n = 0;
const start = (seed: number, culture?: HouseLeans): GameSessionAdapter => {
  const sb = new GameSessionRegistry().sandboxFor(`cred0168-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  sb.session.setHouseCultureEnabled(culture !== undefined);
  if (culture) (sb.session as unknown as L).live.houseLeans = culture;
  sb.session.noteMessage({ messageId: "m1" });
  return sb.session;
};
const cred = (s: GameSessionAdapter, id: string): number => (s as unknown as { credulityOf(id: string): number }).credulityOf(id);
const ids = (s: GameSessionAdapter): string[] => (s as unknown as { house: { npcs: { id: string }[] } }).house.npcs.map((x) => x.id);

describe("the credulity dial", () => {
  it("direction follows the lean table: gossip-mill raises it, liars' season and puppet master lower it", () => {
    expect(dialMult(one("gossip-mill"), "credulity")).toBeGreaterThan(1);
    expect(dialMult(one("liars-season"), "credulity")).toBeLessThan(1);
    expect(dialMult(one("puppet-master"), "credulity")).toBeLessThan(1);
  });
  it("every lean keeps the multiplier within 1/1.35 .. 1.35", () => {
    for (const id of LEAN_IDS) {
      const v = dialMult(one(id), "credulity");
      expect(v).toBeLessThanOrEqual(F); expect(v).toBeGreaterThanOrEqual(1 / F);
    }
  });
  it("a listener's credulity moves with the culture at the adapter seam and stays in 0..1", () => {
    for (const seed of [3, 11]) {
      const none = start(seed);
      for (const id of ids(none)) {
        const base = cred(none, id);
        const up = cred(start(seed, one("gossip-mill")), id);
        const down = cred(start(seed, one("liars-season")), id);
        expect(up).toBeGreaterThanOrEqual(base); expect(down).toBeLessThanOrEqual(base);
        for (const v of [base, up, down]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
        if (base > 0) { expect(up / base).toBeLessThanOrEqual(F + 1e-9); expect(down / base).toBeGreaterThanOrEqual(1 / F - 1e-9); }
        expect(cred(start(seed, { leans: [] }), id)).toBe(base);
      }
      expect(cred(start(seed, one("gossip-mill")), "npc:1")).toBeGreaterThan(cred(none, "npc:1"));
    }
  });
  it("an empty culture plays identically to no culture (seeds 3 and 11)", () => {
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
});
