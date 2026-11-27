import { describe, it, expect } from "vitest";
import { battleBackField } from "../../src/engine/liveSeason";
import { npc, PLAYER } from "../../src/domain/ids";

/** ORW-1088 (Ryne 2026-11-27: "It shouldn't mix jurors and non jurors in the same battle back"): the battle-back field is all jurors or all pre-jury evictees, never both. Roles only. */
const out = [npc(20), npc(21), npc(22), npc(23), npc(24), npc(25), npc(26)]; // 16 houseguests, 9 still in: the first five out are pre-jury
const inHouse = [npc(1), npc(2), npc(3), npc(4), npc(5), npc(6), npc(7), npc(8), PLAYER];

describe("ORW-1088 battle-back field", () => {
  it("with jurors seated, the field is jurors only (here the two seated)", () => {
    expect(battleBackField({ evictionOrder: out, active: inHouse })).toEqual([npc(25), npc(26)]);
    expect(battleBackField({ evictionOrder: out, active: inHouse, jurorIds: [npc(25), npc(26)] })).toEqual([npc(25), npc(26)]);
  });
  it("with more than four jurors, the four most recent", () => {
    expect(battleBackField({ evictionOrder: [...out, npc(27), npc(28), npc(29)], active: inHouse.slice(0, 6) })).toEqual([npc(26), npc(27), npc(28), npc(29)]);
  });
  it("before the jury, the field is the most recent pre-jury evictees", () => {
    expect(battleBackField({ evictionOrder: out.slice(0, 3), active: [...inHouse, npc(23), npc(24), npc(25), npc(26)] })).toEqual([npc(20), npc(21), npc(22)]);
  });
});
