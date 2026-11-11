import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import { DAY_SCHEDULE } from "../../src/engine/daySchedule";

/**
 * Milestone hours, pinned through the real loop (week 1, clock on, per-conversation clock). Found while chasing the ledger note "the veto ceremony is due at 'evening' but is scheduled for the afternoon":
 *  1. Every ceremony RESOLVES in its scheduled phase (DAY_SCHEDULE): hoh-competition 12:00, nominations/veto-ceremony ~12-13h, eviction 16h. The schedule itself is honoured.
 *  2. BUT `daySchedule.due` turns true EARLY, at the tail of the PREVIOUS event day: when a staged comp ends at 15:00 / 18:00 the clock is already past the next milestone's phase start, so the next
 *     ceremony reads `due: true` at 15:00 (nominations), 13:00 (veto-comp, after the nominations hour) and 18:00 / "evening" (veto-ceremony) - and the engine's next advance is a `day-break` that crosses the
 *     night, so the ceremony actually lands the NEXT afternoon. The HUD/narrator-facing "due now, evening" is therefore ahead of what happens. Pinned as today's behavior (see the write-up
 *     bdd-audit/design/veto-ceremony-evening-due.md; a ruling is needed on whether `due` should stay false until the day-break).
 * Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));
type Row = { next: string; scheduled: string; dueHour: number; dueTod: string; event?: string; afterHour: number };
function weekOne(): Row[] {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`mh-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 7 });
  s.setPerConversationClockEnabled(true);
  const live = () => s.snapshot().live as unknown as { nightDepth: number; timeOfDay: string; nightDepthUndefined?: boolean };
  for (let i = 0; i < 80 && (s.snapshot().live as { nightDepth?: number }).nightDepth === undefined; i++) s.advanceGame();
  const rows: Row[] = [];
  for (let step = 0; step < 700 && !rows.some((r) => r.next === "eviction" && r.event !== "day-break" && !r.event); step++) {
    const d = (s.getGameState() as { daySchedule?: { due: boolean; next: string; phase: string } }).daySchedule;
    if (d?.due) {
      const before = { h: live().nightDepth, tod: live().timeOfDay };
      const v = s.advanceGame();
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
      rows.push({ next: d.next, scheduled: d.phase, dueHour: before.h, dueTod: before.tod, event: v.event?.beat ?? undefined, afterHour: live().nightDepth });
    } else s.advanceClockPerConversation();
  }
  return rows;
}

describe("milestone hours vs the schedule (week 1, real loop)", () => {
  const rows = weekOne();
  it("the schedule table says what the code says", () => {
    // ORW-116 (Ryne 2026-11-06): competitions afternoon, ceremonies (nominations, veto ceremony) and eviction evening, the veto player draw in the morning of the veto day.
    expect(DAY_SCHEDULE["hoh-competition"]).toBe("afternoon");
    expect(DAY_SCHEDULE["veto-competition"]).toBe("afternoon");
    expect(DAY_SCHEDULE.nominations).toBe("evening");
    expect(DAY_SCHEDULE["veto-ceremony"]).toBe("evening");
    expect(DAY_SCHEDULE.eviction).toBe("evening");
  });
  it("every ceremony RESOLVES in its own scheduled phase (the schedule is honoured)", () => {
    for (const beat of ["nominations", "veto-ceremony"] as const) {
      const r = rows.find((x) => x.next === beat && x.event === beat);
      expect(r, `${beat} resolved`).toBeDefined();
      expect(r!.dueTod, `${beat} resolved in the ${DAY_SCHEDULE[beat]}`).toBe(DAY_SCHEDULE[beat]);
    }
    const ev = rows.find((x) => x.next === "eviction" && !x.event);
    expect(ev!.dueTod).toBe(DAY_SCHEDULE.eviction);
  });
  it("every event of a played week lands in its slot: draw in the morning, the competition that afternoon of the SAME day, ceremonies and eviction in the evening", () => {
    const at = (next: string, ev: string) => rows.find((x) => x.next === next && x.event === ev)!;
    const draw = at("veto-competition", "veto-draw");
    expect(draw.dueTod, "the veto player draw is a MORNING event").toBe("morning");
    expect(draw.dueHour).toBeCloseTo(8, 1);
    const comp = at("veto-competition", "veto-competition");
    expect(comp.dueTod, "the veto competition itself is the afternoon").toBe("afternoon");
    expect(comp.dueHour).toBeCloseTo(12, 1);
    expect(at("nominations", "nominations").dueTod).toBe("evening");
    expect(at("veto-ceremony", "veto-ceremony").dueTod).toBe("evening");
    expect(rows.find((x) => x.next === "eviction" && !x.event)!.dueTod).toBe("evening");
  });
  it("PINNED QUIRK (still true, now only about the night): `due` reads true at the tail of the previous event day and the next advance is a day-break that crosses the night; the event then lands in its slot the next day", () => {
    const tail = (beat: string) => rows.find((x) => x.next === beat && x.event === "day-break");
    expect(tail("nominations")!.afterHour, "the night is crossed to 8am; nominations land that evening").toBeCloseTo(8, 1);
    expect(tail("veto-competition")!.dueHour, "after the nominations ceremony (evening) the veto draw already reads due").toBeCloseTo(17, 1);
    expect(tail("veto-competition")!.afterHour).toBeCloseTo(8, 1);
    expect(tail("veto-ceremony")!.afterHour).toBeCloseTo(8, 1);
  });
});
