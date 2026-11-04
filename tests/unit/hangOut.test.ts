import { describe, it, expect } from "vitest";
import { runHangOut, HANGOUT, type HangOutProbes } from "../../src/engine/hangOut";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/** "Hang out until X": every stop reason, the event clamp, the beat cap, determinism. Roles only. */
function world(over: Partial<HangOutProbes> & { startHour?: number; eventHour?: number | null; bedHour?: number } = {}) {
  let hour = over.startHour ?? 12;
  const eventHour = over.eventHour === undefined ? null : over.eventHour;
  const bedHour = over.bedHour ?? 20;
  const log: number[] = [];
  const probes: HangOutProbes = {
    advance: (h) => { hour += h; log.push(h); },
    hoursUntilEvent: () => (eventHour === null ? null : Math.max(0, eventHour - hour)),
    eventDue: () => eventHour !== null && hour + 1e-6 >= eventHour,
    bedtime: () => hour >= bedHour,
    pulled: () => null, approach: () => null, observed: () => null,
    ...over,
  };
  return { probes, hour: () => hour, log };
}
const rng = (n = 1) => new SeededRandom(n);

describe("runHangOut", () => {
  it("runs the cap of beats, each 15-30 minutes, when nothing interrupts", () => {
    const w = world();
    const r = runHangOut(w.probes, rng());
    expect(r.stopReason).toBe("max-beats");
    expect(r.beats).toBe(HANGOUT.maxBeats);
    for (const h of w.log) { expect(h * 60).toBeGreaterThanOrEqual(15 - 1e-9); expect(h * 60).toBeLessThanOrEqual(30 + 1e-9); }
    expect(r.minutes).toBe(Math.round(w.log.reduce((a, b) => a + b, 0) * 60));
  });
  it("honours a smaller maxBeats, never above the hard cap, never below one", () => {
    expect(runHangOut(world().probes, rng(), { maxBeats: 3 }).beats).toBe(3);
    expect(runHangOut(world().probes, rng(), { maxBeats: 99 }).beats).toBe(HANGOUT.maxBeats);
    expect(runHangOut(world().probes, rng(), { maxBeats: 0 }).beats).toBe(1);
  });
  it("stop: event-due - clamps the last beat to the event and never passes it", () => {
    const w = world({ startHour: 11.5, eventHour: 12 });
    const r = runHangOut(w.probes, rng());
    expect(r.stopReason).toBe("event-due");
    expect(w.hour()).toBeCloseTo(12, 6);
    expect(w.hour()).toBeLessThanOrEqual(12 + 1e-9);
  });
  it("stop: event-due before any beat when the event is already due (fires nothing early, spends no time)", () => {
    const w = world({ startHour: 12, eventHour: 12 });
    const r = runHangOut(w.probes, rng());
    expect(r).toEqual({ stopReason: "event-due", beats: 0, minutes: 0 });
    expect(w.log).toEqual([]);
  });
  it("stop: pulled - reports who pulled", () => {
    const r = runHangOut(world({ pulled: (_r, b) => (b === 2 ? { by: "diary-room" } : null) }).probes, rng());
    expect(r).toMatchObject({ stopReason: "pulled", beats: 2, detail: { by: "diary-room" } });
  });
  it("stop: npc-approach - reports who approached", () => {
    const r = runHangOut(world({ approach: (_r, b) => (b === 3 ? { npc: "npc-1" } : null) }).probes, rng());
    expect(r).toMatchObject({ stopReason: "npc-approach", beats: 3, detail: { npc: "npc-1" } });
  });
  it("stop: observed - reports what was seen", () => {
    const r = runHangOut(world({ observed: (_r, b) => (b === 1 ? { kind: "overheard-whisper", who: ["a", "b"] } : null) }).probes, rng());
    expect(r).toMatchObject({ stopReason: "observed", beats: 1, detail: { kind: "overheard-whisper", who: ["a", "b"] } });
  });
  it("stop: bedtime - mid-run, and before the first beat when already late", () => {
    const mid = runHangOut(world({ startHour: 19.6, bedHour: 20 }).probes, rng());
    expect(mid.stopReason).toBe("bedtime");
    expect(mid.beats).toBeGreaterThan(0);
    expect(runHangOut(world({ startHour: 21, bedHour: 20 }).probes, rng())).toEqual({ stopReason: "bedtime", beats: 0, minutes: 0 });
  });
  it("priority: event-due beats pulled beats approach beats observed beats bedtime", () => {
    const all = { pulled: () => ({ by: "production" as const }), approach: () => ({ npc: "n" }), observed: () => ({ kind: "k", who: [] }) };
    expect(runHangOut(world({ ...all, startHour: 11.9, eventHour: 12, bedHour: 99 }).probes, rng()).stopReason).toBe("event-due");
    expect(runHangOut(world({ ...all, bedHour: 99 }).probes, rng()).stopReason).toBe("pulled");
    expect(runHangOut(world({ ...all, pulled: () => null, bedHour: 99 }).probes, rng()).stopReason).toBe("npc-approach");
    expect(runHangOut(world({ ...all, pulled: () => null, approach: () => null, bedHour: 99 }).probes, rng()).stopReason).toBe("observed");
  });
  it("is deterministic for a seed and consumes only the injected rng", () => {
    const a = world(), b = world();
    runHangOut(a.probes, rng(7)); runHangOut(b.probes, rng(7));
    expect(a.log).toEqual(b.log);
    const c = world(); runHangOut(c.probes, rng(8));
    expect(c.log).not.toEqual(a.log);
  });
});
