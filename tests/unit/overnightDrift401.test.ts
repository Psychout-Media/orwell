import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { RELATIONSHIP_CONSTANTS, OVERNIGHT_DRIFT } from "../../src/engine/relationshipConstants";
import { buildSandbox } from "../support/sandbox";
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

  it("the day-start reference survives a snapshot round trip (a restart does not decay a fed edge)", () => {
    const { i, rel } = rig(55);
    rel.edge(npc(1), PLAYER).affinity = 0.9;
    i.buildRecapForDay(1);
    const ref = JSON.parse(JSON.stringify(i.live.feelRef));
    expect(ref).toBeTruthy();
    i.live.feelRef = ref;
    const v = rel.edge(npc(1), PLAYER).affinity;
    i.buildRecapForDay(2);
    expect(rel.edge(npc(1), PLAYER).affinity).toBeLessThan(v);
  });
});
