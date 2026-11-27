import { describe, it, expect } from "vitest";
import { pitchPatienceDays, PITCH_PATIENCE } from "../../src/engine/pitchPatience";
import { playedGame } from "../support/playedGame";
import type { EntityId } from "../../src/domain/ids";

/** ORW-963 item 3 (Ryne 2026-11-26): how long an unanswered pitch stays open depends on the houseguest. Roles only. */
describe("pitch patience comes from the pitcher", () => {
  it("loyal and patient types wait longer than impatient or paranoid ones, within bounds", () => {
    const loyal = pitchPatienceDays({ style: "loyal", archetype: "loyalist", volatility: 0.3 });
    const plain = pitchPatienceDays({ style: "social", archetype: "underdog" });
    const hot = pitchPatienceDays({ style: "aggressive", archetype: "hothead", volatility: 0.9 });
    expect(loyal).toBeGreaterThan(plain);
    expect(plain).toBeGreaterThan(hot);
    expect(pitchPatienceDays({ style: "social", paranoia: 0.9 })).toBeLessThan(pitchPatienceDays({ style: "social" }));
    for (const d of [loyal, plain, hot]) { expect(d).toBeGreaterThanOrEqual(PITCH_PATIENCE.minDays); expect(d).toBeLessThanOrEqual(PITCH_PATIENCE.maxDays); }
    expect(hot).toBeLessThanOrEqual(PITCH_PATIENCE.coolsAtDays);
    expect(loyal).toBeGreaterThan(PITCH_PATIENCE.coolsAtDays);
  });
});

interface Inside {
  house: { npcs: { id: EntityId; character: { strategyStyle: string; archetype: string } }[] };
  live: { dayNumber?: number; week: number; pitchedDay?: Record<string, number> };
  rel: { edge(a: EntityId, b: EntityId): { trust: number } };
  lapseNpcPitches(): void;
  pitchPatienceOf(h: EntityId): number;
}

describe("a houseguest's pitch to another lapses by the same patience", () => {
  it("it stays open until the pitcher's patience runs out, then closes, and an impatient pitcher cools", () => {
    const g = playedGame({ seed: 2 });
    for (let i = 0; i < 4; i++) g.turn();
    const x = g.s as unknown as Inside;
    const [a, b] = x.house.npcs;
    a!.character.strategyStyle = "aggressive"; a!.character.archetype = "hothead";
    const back = x.rel.edge("player" as EntityId, a!.id) as unknown as { trust: number; affinity: number };
    const days = x.pitchPatienceOf(a!.id);
    const today = x.live.dayNumber ?? x.live.week;
    x.live.pitchedDay = { [`${a!.id}>${b!.id}`]: today };
    x.rel.edge(a!.id, b!.id).trust = 0.6;
    x.live.dayNumber = today + days - 1; x.lapseNpcPitches();
    expect(Object.keys(x.live.pitchedDay!)).toHaveLength(1);
    x.live.dayNumber = today + days; x.lapseNpcPitches();
    expect(Object.keys(x.live.pitchedDay!)).toHaveLength(0);
    expect(x.rel.edge(a!.id, b!.id).trust).toBeLessThan(0.6);
  });
});

describe("silence to a pitch reads as a no", () => {
  it("the player's open pitch closes, openly, once the pitcher's patience runs out, and not before", () => {
    const g = playedGame({ seed: 2 });
    for (let i = 0; i < 4; i++) g.turn();
    const x = g.s as unknown as Inside & {
      groupLifeTick(): void;
      alliances: { add(n: string, f: EntityId, m: EntityId[], b: number): { id: string }; reveal(id: string, who: EntityId): void; pitchesFor(who: EntityId): { id: string }[] };
      live: { groupLifeDay?: number; dayNumber?: number; week: number; pitchSince?: Record<string, number> };
    };
    const [a, b] = x.house.npcs;
    a!.character.strategyStyle = "loyal"; a!.character.archetype = "loyalist";
    const al = x.alliances.add("The Test Pair", a!.id, [a!.id, b!.id], 1);
    x.alliances.reveal(al.id, "player" as EntityId);
    const trust = x.rel.edge(a!.id, "player" as EntityId) as unknown as { trust: number; affinity: number };
    const back = x.rel.edge("player" as EntityId, a!.id) as unknown as { trust: number; affinity: number };
    const days = x.pitchPatienceOf(a!.id);
    const today = x.live.dayNumber ?? x.live.week;
    const tick = (day: number): boolean => { trust.trust = 0.9; trust.affinity = 0.9; back.trust = 0.9; back.affinity = 0.9; x.live.dayNumber = day; delete x.live.groupLifeDay; x.groupLifeTick(); return x.alliances.pitchesFor("player" as EntityId).some((p) => p.id === al.id); };
    expect(tick(today)).toBe(true);
    expect(tick(today + days - 1)).toBe(true);
    expect(tick(today + days)).toBe(false);
    expect(g.sb.engine.events.queryAll().some((e) => /silence about the alliance/.test(e.content) && e.witnessSet.includes("player"))).toBe(true);
  });
});
