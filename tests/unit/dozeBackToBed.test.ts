import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { WAKE_HOUR, phaseForHour, dozesBackToBed } from "../../src/engine/timeOfDay";
import { DOZE } from "../../src/engine/sleepConstants";
import { priv, setup } from "../support/napWorld";

/**
 * ORW-705 PT-10 (PO ruling 2026-11-19): the player who woke before the house can `turnIn` to sleep on until the house's wake-up call (capped there); a still-tired early-waking houseguest
 * dozes back too (read off the hidden rest meter, no draw). Real session + orchestrator via the nap world; roles only.
 */
type S = GameSessionAdapter;
type P = { live: Record<string, unknown> & { nightDepth: number; napWake?: { doze?: boolean }; dayNumber: number; lastSleepDepth?: number; wakeHour?: number; playerRetired?: boolean; npcFatigue?: Record<string, number>; timeOfDay: string }; awakeNow(): Set<string> | null; dozeBackEnabled: boolean };
const pv = (s: S): P => s as unknown as P;
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

/** The player woke at their own early hour (a 9pm bed): clock at 5, wakeHour 5, awake. */
function earlyRiser(hour = 5) {
  const w = setup();
  w.s.setBedtimeGateEnabled(true); // the unit lane defaults it off; the deployed game has it on
  const l = pv(w.s).live;
  l.nightDepth = hour; l.timeOfDay = "morning"; l.wakeHour = hour; l.lastSleepDepth = 21; l.playerRetired = false; l.napHoursToday = undefined;
  return w;
}

describe("ORW-705 - the player dozes back to bed", () => {
  it("at the early hour turnIn is accepted and the clock lands on the house wake-up call, not later; the day and the night's rest bookkeeping are untouched", () => {
    const { s } = earlyRiser(4.9);
    const day = pv(s).live.dayNumber;
    const v = s.turnIn();
    expect(v.held).toBeUndefined();
    expect(v.dailyRecap).toBeUndefined();
    const l = pv(s).live;
    expect(l.nightDepth).toBe(WAKE_HOUR);
    expect(l.timeOfDay).toBe("morning");
    expect(l.dayNumber).toBe(day);
    expect(l.lastSleepDepth).toBe(21);
    expect(l.wakeHour).toBeUndefined();
    expect(l.playerRetired).toBe(false);
    expect(l.napWake?.doze).toBe(true);
    expect(priv(s).restDeficitOf("player")).toBe(0);
  });
  it("the doze read survives a snapshot (no new persisted field beyond the napWake flag) and carries no number", () => {
    const { s } = earlyRiser(5);
    s.turnIn();
    const snap = JSON.parse(JSON.stringify(s.snapshot().live));
    expect(snap.napWake.doze).toBe(true);
    expect(snap.nightDepth).toBe(WAKE_HOUR);
    const said = (s as unknown as { takeWhileYouSlept(): string }).takeWhileYouSlept();
    expect(said).toMatch(/wake-up call/);
    expect(said).not.toMatch(/\d/);
  });
  it("a repeat call with the same key replays; a second turnIn after the call is refused as not bedtime, exactly as today", () => {
    const { s } = earlyRiser(5);
    const a = s.turnIn({ idempotencyKey: "k" });
    const b = s.turnIn({ idempotencyKey: "k" });
    expect(b).toEqual(a);
    expect(pv(s).live.nightDepth).toBe(WAKE_HOUR);
    const c = s.turnIn();
    expect(c.held?.next).toBe("bedtime");
    expect(pv(s).live.nightDepth).toBe(WAKE_HOUR);
  });
  it("in the morning band after the wake hour the lever is refused as today", () => {
    const { s } = earlyRiser(5);
    const l = pv(s).live; l.nightDepth = 9.5; l.timeOfDay = "morning"; l.wakeHour = undefined;
    expect(s.turnIn().held?.next).toBe("bedtime");
    expect(l.nightDepth).toBe(9.5);
  });
  it("the evening lever behaves as today (a bed at night wakes early, a recap closes the day)", () => {
    const { s } = earlyRiser(5);
    const l = pv(s).live; l.nightDepth = 22; l.timeOfDay = phaseForHour(22); l.wakeHour = undefined;
    const day = l.dayNumber;
    const v = s.turnIn();
    expect(v.held).toBeUndefined();
    expect(pv(s).live.nightDepth).toBe(6);
    expect(pv(s).live.playerRetired).toBe(true);
    expect(pv(s).live.dayNumber).toBeGreaterThanOrEqual(day);
  });
  it("flag off: refused as not bedtime at the early hour (byte-identical to today)", () => {
    const { s } = earlyRiser(4.9);
    pv(s).dozeBackEnabled = false;
    const v = s.turnIn();
    expect(v.held?.next).toBe("bedtime");
    expect(pv(s).live.nightDepth).toBe(4.9);
  });
});

describe("ORW-705 - an early-waking houseguest who is still tired dozes back", () => {
  it("the pure rule: only before the call, only at or above the tired deficit", () => {
    expect(dozesBackToBed(5, DOZE.tiredDeficit)).toBe(true);
    expect(dozesBackToBed(5, DOZE.tiredDeficit - 0.01)).toBe(false);
    expect(dozesBackToBed(WAKE_HOUR, 1)).toBe(false);
    expect(dozesBackToBed(30, 1)).toBe(false);
  });
  it("a tired one is out of the awake set until the call; a rested one stays up (both occur); at the call everyone is up; deterministic", () => {
    const { s } = earlyRiser(5);
    (s as unknown as { effectiveBedDepth: () => number }).effectiveBedDepth = () => 20; // everyone bedded early: all are up at 5 on their own chronotype
    const npcs = [...(pv(s).awakeNow() ?? [])].filter((id) => id !== "player");
    // Then tire half of them by their own hidden meter.
    const l = pv(s).live;
    const tired = npcs.filter((_, i) => i % 2 === 0);
    l.npcFatigue = Object.fromEntries(npcs.map((id) => [id, tired.includes(id) ? 0.9 : 0]));
    (s as unknown as { multiNightFatigueEnabled: boolean }).multiNightFatigueEnabled = true;
    const up = pv(s).awakeNow()!;
    expect(tired.length).toBeGreaterThan(0);
    expect(npcs.length - tired.length).toBeGreaterThan(0);
    for (const id of tired) expect(up.has(id), `tired ${id}`).toBe(false);
    for (const id of npcs.filter((x) => !tired.includes(x))) expect(up.has(id), `rested ${id}`).toBe(true);
    expect([...pv(s).awakeNow()!].sort()).toEqual([...up].sort());
    l.nightDepth = WAKE_HOUR; l.timeOfDay = "morning";
    const call = pv(s).awakeNow()!;
    for (const id of tired) expect(call.has(id)).toBe(true);
  });
  it("flag off: the tired one stays in the awake set", () => {
    const { s } = earlyRiser(5);
    (s as unknown as { effectiveBedDepth: () => number }).effectiveBedDepth = () => 20;
    const npcs = [...(pv(s).awakeNow() ?? [])].filter((id) => id !== "player");
    const l = pv(s).live;
    l.npcFatigue = Object.fromEntries(npcs.map((id) => [id, 0.9]));
    (s as unknown as { multiNightFatigueEnabled: boolean }).multiNightFatigueEnabled = true;
    const on = pv(s).awakeNow()!;
    pv(s).dozeBackEnabled = false;
    const off = pv(s).awakeNow()!;
    expect(off.size).toBeGreaterThan(on.size);
  });
});
