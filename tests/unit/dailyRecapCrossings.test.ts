import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { crossToNextDay } from "../../src/engine/liveSeason";
import { CLOCK } from "../../src/engine/sleepConstants";

const WAKE_HOUR = CLOCK.wakeHour;
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";
import type { DailyRecapView } from "../../src/ports/GameSession";

/**
 * ORW-282 (BDD card 29): every game day gets a recap, not only the days the player turns in. A day that rolls by the production schedule (crossToNextDay), the all-night wrap or a player who never
 * turns in used to get none. Roles only; no model.
 */
afterEach(() => { delete process.env.ORWELL_TIME_OF_DAY; });

type Internals = { live: { dayNumber?: number; nightDepth?: number; dailyRecapDay?: number; dailyRecapLog?: DailyRecapView[]; lastDailyRecap?: DailyRecapView } & Record<string, unknown>; persist(): void };

function rig(seed: number, played: boolean) {
  const sb = buildSandbox(seed);
  const session = new GameSessionAdapter();
  session.setPlayerKnowledgeReader(() => sb.engine.knowledge.knownTo(PLAYER).map((f) => ({ id: f.id, content: f.content, subject: f.subject, factId: f.factId, pathway: f.pathway })));
  session.setRecordProviders({ events: () => sb.engine.events.queryAll(), hidden: () => sb.engine.vault.readHidden() });
  session.setOnEvent((ev) => sb.engine.events.record({
    id: `season:${sb.engine.events.count()}`, ts: sb.engine.events.count(), type: "house-event", initiator: ev.participants[0] ?? PLAYER,
    witnessSet: [PLAYER, ...ev.participants.filter((p) => p !== PLAYER)], hidden: false, content: ev.content,
  }));
  session.createCharacter({ playerName: "The Player", seed });
  if (played) session.noteMessage({ messageId: "m-1" } as never); // a person is playing: messageMode on
  const i = session as unknown as Internals;
  i.live.nightDepth = (i.live.nightDepth ?? WAKE_HOUR) ; // the clock is running
  return { sb, session, i };
}

/** What the production schedule does at the HOH-to-nominations night gate: a real night passes and the day counter moves. */
function crossNight(i: Internals) {
  i.live.nightDepth = WAKE_HOUR + 6; // past this morning's wake: a real night is crossed
  crossToNextDay(i.live as never);
}

describe("daily recap at every day crossing (ORW-282)", () => {
  it("a week with no turn-in yields exactly one recap per day, none merged", () => {
    const { i } = rig(31, true);
    const start = i.live.dayNumber ?? 1;
    for (let n = 0; n < 6; n++) { crossNight(i); i.persist(); }
    const days = (i.live.dailyRecapLog ?? []).map((r) => r.day);
    expect(days).toEqual(Array.from({ length: 6 }, (_, k) => start + k));
    expect(new Set(days).size).toBe(days.length);
    expect(i.live.dailyRecapDay).toBe(start + 5);
    expect(i.live.lastDailyRecap?.day).toBe(start + 5);
  });

  it("several days crossed between two saves still produce one recap each, oldest first", () => {
    const { i } = rig(32, true);
    const start = i.live.dayNumber ?? 1;
    crossNight(i); crossNight(i); crossNight(i); // three nights, no save in between
    i.persist();
    expect((i.live.dailyRecapLog ?? []).map((r) => r.day)).toEqual([start, start + 1, start + 2]);
  });

  it("persisting again without a new crossing adds nothing", () => {
    const { i } = rig(33, true);
    crossNight(i); i.persist();
    const n = (i.live.dailyRecapLog ?? []).length;
    i.persist(); i.persist();
    expect((i.live.dailyRecapLog ?? []).length).toBe(n);
  });

  it("a bedtime turn-in and a later crossing do not double up (the bedtime day is not recapped twice)", () => {
    const { session, i } = rig(34, true);
    const start = i.live.dayNumber ?? 1;
    i.live.nightDepth = 22; i.live.timeOfDay = "night";
    session.turnIn();
    crossNight(i); i.persist();
    const days = (i.live.dailyRecapLog ?? []).map((r) => r.day);
    expect(new Set(days).size).toBe(days.length);
    expect(days[0]).toBe(start);
  });

  it("MUTATION GUARD: without the catch-up a crossing leaves the day with no recap", () => {
    const { i } = rig(35, true);
    const before = (i.live.dailyRecapLog ?? []).length;
    crossNight(i); // no persist => no catch-up
    expect((i.live.dailyRecapLog ?? []).length).toBe(before);
    i.persist();
    expect((i.live.dailyRecapLog ?? []).length).toBe(before + 1);
  });

  it("a headless sim (no player messages) is untouched: no recap log, no marker, same day counter", () => {
    const { i } = rig(36, false);
    const start = i.live.dayNumber ?? 1;
    crossNight(i); i.persist();
    expect(i.live.dailyRecapLog).toBeUndefined();
    expect(i.live.dailyRecapDay).toBeUndefined();
    expect(i.live.lastDailyRecap).toBeUndefined();
    expect(i.live.dayNumber).toBe(start + 1);
  });

  it("a crossing recap only carries what the player witnessed or was told (no hidden fact)", () => {
    const { sb, i } = rig(37, true);
    sb.engine.events.record({ id: "secret-1", ts: 900, type: "scheme", initiator: "npc:1", witnessSet: ["npc:1", "npc:2"], hidden: true, content: "SENTINEL-HIDDEN-SCHEME" });
    sb.engine.events.record({ id: "season:vis", ts: 901, type: "house-event", initiator: PLAYER, witnessSet: [PLAYER], hidden: false, content: "a public house event" });
    crossNight(i); crossNight(i); i.persist();
    const blob = JSON.stringify(i.live.dailyRecapLog);
    expect(blob).not.toContain("SENTINEL-HIDDEN-SCHEME");
    expect(blob).toContain("a public house event");
  });
});
