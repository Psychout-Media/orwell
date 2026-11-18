import { describe, it, expect } from "vitest";
import { atCommit } from "../support/commitFold";
import { readFileSync } from "node:fs";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { OVERNIGHT_DRIFT, RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";
import { JURY_FADE } from "../../src/engine/juryHouseConstants";
import { juryFadeRate, juryEaseFactor, juryPersonalityMult } from "../../src/engine/juryFade";
import { GRUDGES, grudgeKey } from "../../src/engine/grudges";
import { buildSandbox } from "../support/sandbox";
import { PLAYER, npc } from "../../src/domain/ids";

/** ORW-582: jury-house feelings fade equally toward the player and an NPC finalist, at a per-juror personality rate; grudges ease a little faster. Roles only. */
const JURORS = Array.from({ length: 9 }, (_, i) => npc(i + 1));
const PRE_JURY = [npc(10), npc(11), npc(12), npc(13), npc(15)];
const FINALIST = npc(14);

function rig(seed: number, juryHouse = true) {
  const sb = buildSandbox(seed);
  const session = new GameSessionAdapter();
  session.setRecordProviders({ events: () => sb.engine.events.queryAll(), hidden: () => sb.engine.vault.readHidden() });
  session.createCharacter({ playerName: "The Player", seed });
  session.noteMessage({ messageId: "m-1" } as never);
  session.setJuryHouseEnabled(juryHouse);
  const i = session as any;
  i.live.evictionOrder = [...PRE_JURY, ...JURORS];
  return { session, i, rel: i.rel };
}
const night = (i: any) => { i.buildRecapForDay(1); i.buildRecapForDay(2); };

describe("ORW-582 jury-house fade", () => {
  it("parity: a juror fades toward the player exactly as toward an NPC finalist under identical history", () => {
    const { i, rel } = rig(582);
    for (const subject of [PLAYER, FINALIST]) Object.assign(rel.edge(npc(1), subject), { trust: 0.95, affinity: 0.95, threat: 0.95 });
    i.buildRecapForDay(1);
    i.buildRecapForDay(2);
    const a = rel.edge(npc(1), PLAYER), b = rel.edge(npc(1), FINALIST);
    expect(a.affinity).toBeLessThan(0.95);
    expect(a.trust).toBe(b.trust); expect(a.affinity).toBe(b.affinity); expect(a.threat).toBe(b.threat);
  });

  it("the jury-house fade is smaller than the in-house drift, for every possible personality", () => {
    expect(JURY_FADE.baseRate).toBeLessThan(OVERNIGHT_DRIFT.RATE);
    const worst = juryFadeRate({ keeper: false, volatility: 0, roll: 0.999999 });
    expect(worst).toBeLessThan(OVERNIGHT_DRIFT.RATE);
    const { i, rel } = rig(583);
    Object.assign(rel.edge(npc(1), PLAYER), { trust: 0.95, affinity: 0.95, threat: 0.95 });
    night(i);
    const moved = 0.95 - rel.edge(npc(1), PLAYER).affinity;
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan((0.95 - RELATIONSHIP_CONSTANTS.baseline.affinity) * OVERNIGHT_DRIFT.RATE);
  });

  it("a grudge-keeper fades less than an easygoing juror with the same history, and a sentimental one less than a calm one", () => {
    const same = { volatility: 0.5, roll: 0.5 };
    expect(juryFadeRate({ keeper: true, ...same })).toBeLessThan(juryFadeRate({ keeper: false, ...same }));
    expect(juryFadeRate({ keeper: false, volatility: 0.9, roll: 0.5 })).toBeLessThan(juryFadeRate({ keeper: false, volatility: 0.1, roll: 0.5 }));
    expect(juryEaseFactor({ keeper: true, ...same })).toBeLessThan(juryEaseFactor({ keeper: false, ...same }));
    expect(juryEaseFactor({ keeper: true, ...same })).toBeGreaterThanOrEqual(1);
  });

  it("rates are deterministic per seed and not flat across jurors", () => {
    const rates = (seed: number) => { const m = rig(seed).i.juryFadeRateOf(); return JORS(m); };
    const JORS = (m: Map<string, (s: string) => number>) => JURORS.map((j) => m.get(j)!(PLAYER));
    const a = rates(584), b = rates(584);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBeGreaterThan(1);
    expect(juryPersonalityMult({ keeper: false, volatility: 0.5, roll: 0 })).not.toBe(juryPersonalityMult({ keeper: false, volatility: 0.5, roll: 1 }));
  });

  it("flag off: byte-identical to the old rule (juror feelings about a finalist hold; about the player drift at the in-house rate)", () => {
    const { i, rel } = rig(585, false);
    Object.assign(rel.edge(npc(1), FINALIST), { trust: 0.95, affinity: 0.95, threat: 0.95 });
    Object.assign(rel.edge(npc(1), PLAYER), { trust: 0.95, affinity: 0.95, threat: 0.95 });
    night(i);
    expect(rel.edge(npc(1), FINALIST).affinity).toBe(0.95);
    expect(0.95 - rel.edge(npc(1), PLAYER).affinity).toBeCloseTo((0.95 - RELATIONSHIP_CONSTANTS.baseline.affinity) * OVERNIGHT_DRIFT.RATE, 6);
  });

  it("no player-only branch in the fade rule", () => {
    const src = readFileSync("src/engine/juryFade.ts", "utf8");
    expect(src).not.toMatch(/PLAYER/);
    const adapter = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
    const block = adapter.slice(adapter.indexOf("private juryPersonalityOf"), adapter.indexOf("private grudgeKeeper"));
    expect(block).not.toMatch(/subject\s*===\s*PLAYER|=== PLAYER/);
  });

  it("a juror's grudge fades faster than the same grudge held in the house, still floored, and repair stays capped", () => {
    const { i } = rig(586);
    const row = { kind: "betrayal", week: 1, day: 1, severity: 0.8, peak: 0.8, eased: 0, refKey: "k" };
    for (const holder of [npc(1), npc(14)]) i.live.grudges = { ...(i.live.grudges ?? {}), [grudgeKey(holder, PLAYER)]: { ...row } };
    i.live.week = 12;
    const juror = atCommit(i).grudgeOf(npc(1), PLAYER, false), house = atCommit(i).grudgeOf(npc(14), PLAYER, false);
    expect(juror.freshness).toBeLessThan(house.freshness);
    expect(juror.freshness).toBeGreaterThanOrEqual(GRUDGES.FLOOR_SHARE * 0.8);
    i.live.week = 400;
    expect(atCommit(i).grudgeOf(npc(1), PLAYER, false).freshness).toBeGreaterThanOrEqual(GRUDGES.FLOOR_SHARE * 0.8 - 1e-9);
    for (let n = 0; n < 5; n++) i.repairGrudge(npc(1), PLAYER, 10);
    const left = i.live.grudges[grudgeKey(npc(1), PLAYER)];
    expect(left.eased).toBeLessThanOrEqual(GRUDGES.EASE_CAP * left.peak + 1e-9);
    expect(left.eased).toBeGreaterThan(0);
  });

  it("wall: no fade or ease field in a player or admin projection", () => {
    const { session, i } = rig(587);
    night(i);
    const blob = JSON.stringify([session.gameStatus(), session.whereabouts()]);
    expect(blob).not.toMatch(/jury-fade|fadeRate|easeGain|keeperMult|juryFade|juryEase/);
  });
});
