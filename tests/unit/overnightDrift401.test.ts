import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { RELATIONSHIP_CONSTANTS, OVERNIGHT_DRIFT } from "../../src/engine/relationshipConstants";
import { buildSandbox } from "../support/sandbox";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";

/** ORW-401 follow-up: overnight drift. Relationships must not polarise; an untended played-game feeling about the player eases toward the middle each night. Roles only. */
function rig(seed: number, played = true) {
  const sb = buildSandbox(seed);
  const session = new GameSessionAdapter();
  session.setRecordProviders({ events: () => sb.engine.events.queryAll(), hidden: () => sb.engine.vault.readHidden() });
  session.createCharacter({ playerName: "The Player", seed });
  if (played) session.noteMessage({ messageId: "m-1" } as never);
  const i = session as any;
  return { session, i, rel: i.rel };
}
const base = RELATIONSHIP_CONSTANTS.baseline;

describe("ORW-401 overnight drift (played game)", () => {
  it("an untouched extreme edge moves toward the middle every night and never crosses it", () => {
    const { i, rel } = rig(51);
    rel.edge(npc(1), PLAYER).affinity = 0.98;
    rel.edge(npc(2), PLAYER).affinity = 0.01; // below baseline: pulled UP
    i.buildRecapForDay(1); // night 1: the edge was set after the (empty) start of day, so it counts as moved
    let hi = rel.edge(npc(1), PLAYER).affinity, lo = rel.edge(npc(2), PLAYER).affinity;
    for (let day = 2; day <= 6; day++) {
      i.buildRecapForDay(day);
      const nh = rel.edge(npc(1), PLAYER).affinity, nl = rel.edge(npc(2), PLAYER).affinity;
      expect(nh).toBeLessThan(hi); expect(nh).toBeGreaterThan(base.affinity);
      expect(nl).toBeGreaterThan(lo); expect(nl).toBeLessThan(base.affinity);
      expect(hi - nh).toBeCloseTo((hi - base.affinity) * OVERNIGHT_DRIFT.RATE, 6);
      hi = nh; lo = nl;
    }
  });

  it("an edge that moved during the day just closed does not decay that night", () => {
    const { i, rel } = rig(52);
    rel.edge(npc(1), PLAYER).affinity = 0.95;
    i.buildRecapForDay(1);
    i.buildRecapForDay(2); // quiet night: drifts
    const before = rel.edge(npc(1), PLAYER).affinity;
    rel.edge(npc(1), PLAYER).affinity = Math.min(1, before + 0.02); // fed today
    const fed = rel.edge(npc(1), PLAYER).affinity;
    i.buildRecapForDay(3);
    expect(rel.edge(npc(1), PLAYER).affinity).toBe(fed);
    i.buildRecapForDay(4); // nothing fed today: drifts again
    expect(rel.edge(npc(1), PLAYER).affinity).toBeLessThan(fed);
  });

  it("edges between two houseguests (not the player) are left alone", () => {
    const { i, rel } = rig(53);
    rel.edge(npc(1), npc(2)).affinity = 0.97;
    i.buildRecapForDay(1); i.buildRecapForDay(2);
    expect(rel.edge(npc(1), npc(2)).affinity).toBe(0.97);
  });

  it("a headless game does not drift", () => {
    const { i, rel } = rig(54, false);
    rel.edge(npc(1), PLAYER).affinity = 0.97;
    i.buildRecapForDay(1); i.buildRecapForDay(2);
    expect(rel.edge(npc(1), PLAYER).affinity).toBe(0.97);
  });

  it("the day-start reference survives a REAL snapshot round trip (fresh sandbox restored from the JSON save): an unfed edge still drifts, a fed one still holds", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("drift-rt");
    const s0 = sb.session as GameSessionAdapter;
    s0.createCharacter({ playerName: "The Player", seed: 55 });
    s0.noteMessage({ messageId: "m-1" } as never);
    const rel0 = (s0 as any).rel;
    rel0.edge(npc(1), PLAYER).affinity = 0.9; // will stay unfed
    rel0.edge(npc(2), PLAYER).affinity = 0.9; // will be fed after the roll
    (s0 as any).buildRecapForDay(1);
    expect((s0 as any).live.feelRef, "the roll stored the reference").toBeTruthy();
    const unfedBefore = rel0.edge(npc(1), PLAYER).affinity;
    rel0.edge(npc(2), PLAYER).affinity = 0.93; // fed during day 2
    const fedBefore = 0.93;
    reg.restore("drift-rt", JSON.parse(JSON.stringify(reg.snapshot("drift-rt")))); // a restart: a NEW session and relationship model built from the save
    const s1 = reg.sandboxFor("drift-rt").session as GameSessionAdapter;
    expect(s1).not.toBe(s0);
    const rel1 = (s1 as any).rel;
    expect(rel1).not.toBe(rel0);
    expect((s1 as any).live.feelRef, "the reference came back from the save").toBeTruthy();
    (s1 as any).buildRecapForDay(2);
    expect(rel1.edge(npc(1), PLAYER).affinity, "an unfed edge drifts after the restart").toBeLessThan(unfedBefore);
    expect(rel1.edge(npc(2), PLAYER).affinity, "a fed edge holds after the restart").toBeCloseTo(fedBefore, 9);
  });

  it("all three signals drift: above baseline eases down, below baseline eases up, by exactly OVERNIGHT_DRIFT.RATE of the remaining distance (trust, affinity, threat)", () => {
    const { i, rel } = rig(56);
    const hi = { trust: 0.95, affinity: 0.95, threat: 0.95 }, lo = { trust: 0.02, affinity: 0.02, threat: 0.02 };
    Object.assign(rel.edge(npc(1), PLAYER), hi);
    Object.assign(rel.edge(npc(2), PLAYER), lo);
    i.buildRecapForDay(1); // night 1 holds (set after the empty start of the day): the reference is taken here
    i.buildRecapForDay(2); // a quiet night: every signal drifts
    for (const k of ["trust", "affinity", "threat"] as const) {
      expect(rel.edge(npc(1), PLAYER)[k], `${k} above baseline`).toBeCloseTo(hi[k] + (base[k] - hi[k]) * OVERNIGHT_DRIFT.RATE, 6);
      expect(rel.edge(npc(2), PLAYER)[k], `${k} below baseline`).toBeCloseTo(lo[k] + (base[k] - lo[k]) * OVERNIGHT_DRIFT.RATE, 6);
    }
  });
});
