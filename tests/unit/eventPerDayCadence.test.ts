import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * ORW-258 (Ryne 2026-11-11): EVERY EVENT GETS ITS OWN DAY; nothing is combined except the veto draw with the veto competition. Day 1 premiere only; Day 2 HOH comp; Day 3 nominations;
 * Day 4 veto draw (morning) + veto comp (afternoon); Day 5 veto ceremony; Day 6 eviction; the NEXT HOH comp the following day (Day 7), and the cycle repeats. The headless driver below is a
 * player behind the FE's production hold: it asks for the next beat only once the schedule says it is DUE, lets time pass otherwise, and turns in at night. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolveLegally(s: Pick<GameSession, "submitDecision" | "advanceGame">, p: NonNullable<AdvanceView["pending"]>): AdvanceView | void {
  if (p.kind === "ceremony-step") return (s as unknown as GameSession).advanceGame(); // ORW-281 4a: a staged ceremony watch step is answered by Continue (advanceGame), never a decision
  else if (p.kind === "nominations") return s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") return s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") return s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", statement: "bye", vote: p.options[0]?.id });
  else return s.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id } as never); // (houseguests-choice returns the staged draw's published field)
}

type Live = { dayNumber?: number };
function playWeeks(seed: number, weeks: number): Array<{ beat: string; day: number; week: number }> {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const reg = new GameSessionRegistry();
  const s = reg.sandboxFor(`cadence-${seed}`).session as GameSession & { snapshot(): { live?: Live } } & Record<string, any>;
  s.createCharacter({ playerName: "P", seed });
  s.setPerConversationClockEnabled(true);
  const rows: Array<{ beat: string; day: number; week: number }> = [];
  let n = 0;
  for (let i = 0; i < 8000; i++) {
    const st = s.getGameState();
    if ((st.week ?? 1) > weeks) break;
    if (st.pending) {
      const r = resolveLegally(s, st.pending); // ORW-281 4a: a staged ceremony publishes its beat on a step's result (the 'named' step), not on the first advance
      const rb = r?.event?.beat;
      if (rb === "nominations" || rb === "veto-draw" || rb === "veto-ceremony") rows.push({ beat: rb, day: s.snapshot().live?.dayNumber ?? 0, week: st.week ?? 0 });
      continue;
    }
    const ds = st.daySchedule;
    if (st.phase === "premiere" || (ds && ds.due)) {
      const a = s.advanceGame();
      if (a.held) {
        for (let k = 0; k < 3000 && !["night", "late-night"].includes(s.gameStatus().timeOfDay ?? ""); k++) s.noteMessage({ messageId: `m${n++}` });
        s.turnIn(); s.noteMessage({ messageId: `w${n++}` });
        continue;
      }
      const b = a.event?.beat;
      if (b && ["hoh-competition", "nominations", "veto-draw", "veto-competition", "veto-ceremony", "eviction"].includes(b)) rows.push({ beat: b, day: s.snapshot().live?.dayNumber ?? 0, week: st.week ?? 0 });
      if (a.pending) {
        const r = resolveLegally(s, a.pending);
        if (r?.event?.beat === "nominations" || r?.event?.beat === "veto-draw" || r?.event?.beat === "veto-ceremony") rows.push({ beat: r.event.beat, day: s.snapshot().live?.dayNumber ?? 0, week: st.week ?? 0 });
      }
      if (a.finished) break;
    } else {
      s.noteMessage({ messageId: `m${n++}` });
      // the player stays up until the night period, then goes to bed (no earlier: the bedtime gate would refuse)
      if (["night", "late-night"].includes(s.gameStatus().timeOfDay ?? "") && ds && !ds.due) { s.turnIn(); s.noteMessage({ messageId: `w${n++}` }); }
    }
  }
  return rows;
}

describe("ORW-258 — one event per day, and the next week's HOH is the day after the eviction", () => {
  it("weeks 1-3 follow HOH / noms / veto day / ceremony / eviction on five consecutive event days, then the next HOH the day after", () => {
    const rows = playWeeks(21, 3);
    const byWeek = (w: number) => rows.filter((r) => r.week === w);
    for (const w of [2, 3]) {
      const r = byWeek(w); const day = (b: string) => r.find((x) => x.beat === b)?.day;
      const hoh = day("hoh-competition")!;
      expect(hoh, `week ${w} HOH happened`).toBeGreaterThan(0);
      expect(day("nominations"), `week ${w} nominations are the day after the HOH`).toBe(hoh + 1);
      expect(day("veto-draw"), `week ${w} veto draw`).toBe(hoh + 2);
      expect(day("veto-competition"), `week ${w} veto competition shares the draw's day`).toBe(hoh + 2);
      expect(day("veto-ceremony"), `week ${w} veto ceremony`).toBe(hoh + 3);
      expect(day("eviction"), `week ${w} eviction`).toBe(hoh + 4);
    }
    const w2hoh = byWeek(2).find((x) => x.beat === "hoh-competition")!.day, w1ev = byWeek(1).find((x) => x.beat === "eviction")!.day;
    expect(w2hoh, "the week-2 HOH competition is the day AFTER the week-1 eviction (not that same night)").toBe(w1ev + 1);
    const w3hoh = byWeek(3).find((x) => x.beat === "hoh-competition")!.day, w2ev = byWeek(2).find((x) => x.beat === "eviction")!.day;
    expect(w3hoh).toBe(w2ev + 1);
  }, 180000);

  it("an event waiting behind its night is not 'due' tonight, names the right event for today, and bed is refused before the night period", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const reg = new GameSessionRegistry();
    const s = reg.sandboxFor("cadence-bed").session as GameSession & Record<string, any>;
    s.createCharacter({ playerName: "P", seed: 21 });
    s.setPerConversationClockEnabled(true);
    // play to just after the week-1 HOH is crowned
    let guard = 0;
    for (let i = 0; i < 4000 && guard < 1; i++) {
      const st = s.getGameState();
      if (st.pending) { resolveLegally(s, st.pending); continue; }
      if (st.phase === "nominations") { guard = 1; break; }
      const ds = st.daySchedule;
      if (st.phase === "premiere" || (ds && ds.due)) {
        const a = s.advanceGame();
        if (a.held) { for (let k = 0; k < 3000 && !["night", "late-night"].includes(s.gameStatus().timeOfDay ?? ""); k++) s.noteMessage({ messageId: `a${i}-${k}` }); s.turnIn(); s.noteMessage({ messageId: `b${i}` }); continue; }
        if (a.pending) resolveLegally(s, a.pending);
      } else s.noteMessage({ messageId: `c${i}` });
    }
    expect(guard, "reached the nominations phase (HOH day)").toBe(1);
    // let the evening arrive: the nominations are NOT due tonight and today's event is the HOH
    for (let k = 0; k < 400 && s.gameStatus().timeOfDay !== "evening"; k++) s.noteMessage({ messageId: `e${k}` });
    const ds = s.getGameState().daySchedule!;
    expect(ds.next).toBe("nominations");
    expect(ds.due, "nominations belong to the next day: not due on the HOH's evening").toBe(false);
    expect(ds.todaysEvent, "today is the HOH day").toBe("hoh-competition");
    expect(ds.minutesUntil!, "the wait is the rest of tonight plus the morning-to-evening span").toBeGreaterThan(12 * 60);
    // bed in the evening is refused; at night it is allowed
    s.setBedtimeGateEnabled(true);
    const refused = s.turnIn();
    expect((refused as any).held?.next, "no bed before the night period").toBe("bedtime");
    for (let k = 0; k < 400 && !["night", "late-night"].includes(s.gameStatus().timeOfDay ?? ""); k++) s.noteMessage({ messageId: `f${k}` });
    const slept = s.turnIn();
    expect((slept as any).held).toBeUndefined();
  }, 180000);
});

describe("ORW-258 — the narrator is told the next event is TOMORROW while it waits behind its night", () => {
  it("renderGameContext says TOMORROW (and names today's event) when todaysEvent is set; 'this evening' otherwise", async () => {
    const { renderGameContext } = await import("../../src/engine/momentPrompts");
    const base = new GameSessionAdapter().createCharacter({ playerName: "P", seed: 5 });
    const wait = { ...base, daySchedule: { next: "nominations", phase: "evening", due: false, minutesUntil: 900, todaysEvent: "hoh-competition" } } as never;
    const own = { ...base, daySchedule: { next: "nominations", phase: "evening", due: false, minutesUntil: 90 } } as never;
    const a = renderGameContext(wait), b = renderGameContext(own);
    expect(a).toMatch(/set for TOMORROW evening/);
    expect(a).toMatch(/do not stage the .* today/);
    expect(b).toMatch(/set for this evening/);
    expect(b).not.toMatch(/TOMORROW/);
  });
});
