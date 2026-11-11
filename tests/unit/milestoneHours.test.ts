import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import { DAY_SCHEDULE } from "../../src/engine/daySchedule";
import { phaseForHour } from "../../src/engine/timeOfDay";

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
function weekOne(played = false): Row[] {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`mh-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 7 });
  s.setPerConversationClockEnabled(true);
  const live = () => s.snapshot().live as unknown as { nightDepth: number; timeOfDay: string; nightDepthUndefined?: boolean };
  for (let i = 0; i < 80 && (s.snapshot().live as { nightDepth?: number }).nightDepth === undefined; i++) s.advanceGame();
  if (played) s.noteMessage({ messageId: "mh-0" }); // ORW-258: the event-per-day cadence is for a game a PERSON is playing (a headless driver keeps the pre-258 due-ness, byte-identical)
  const rows: Row[] = [];
  for (let step = 0; step < 2500 && !rows.some((r) => r.next === "eviction" && r.event !== "day-break" && !r.event); step++) {
    const d = (s.getGameState() as { daySchedule?: { due: boolean; next: string; phase: string } }).daySchedule;
    if (d?.due) {
      const before = { h: live().nightDepth, tod: live().timeOfDay };
      const v = s.advanceGame();
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
      rows.push({ next: d.next, scheduled: d.phase, dueHour: before.h, dueTod: phaseForHour(before.h + 1e-6) /* the clock accrues in 5-minute float steps (15.999999999 reads 'due'): label the phase by the hour with the same tolerance milestoneDue uses */, event: v.event?.beat ?? undefined, afterHour: live().nightDepth });
    } else if (live().timeOfDay === "night" || live().timeOfDay === "late-night") { s.turnIn({}); } // ORW-258: the player goes to bed at the NIGHT period (no earlier), and the next event is its own day
    else s.advanceClockPerConversation();
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
  it("ORW-258 (a PLAYED game; replaces the pinned quirk): an event behind its night is NOT due on the previous event's day; its day-break needs no 'due' and the event is due only on its own day", () => {
    // the old quirk (nominations/veto/ceremony reading `due: true` at the tail of the previous event day while the engine still needed a night) is gone: every row where `due` was true advanced the EVENT itself, never a day-break
    const rows = weekOne(true);
    const dueRows = rows.filter((x) => x.event === "day-break");
    expect(dueRows, "no day-break was ever advanced because the schedule said 'due'").toEqual([]);
    const at = (n: string, e: string) => rows.find((x) => x.next === n && x.event === e)!;
    expect(at("nominations", "nominations").dueTod, "nominations fire on their own day, in the evening").toBe("evening");
    expect(at("veto-ceremony", "veto-ceremony").dueTod).toBe("evening");
  });
});
