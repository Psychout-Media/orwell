import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * ORW-363 (Ryne, playtest 11-15: "Those tools should be a guide to player on what to expect. Next. For example, when we wake up the tool should say, Nominations this
 * evening."): the schedule the HUD reads says whether the next event is TODAY or TOMORROW. The claim is checked against what really happens: every read that says
 * "tomorrow" is followed by the event firing on a later day, and every read that does not is followed by it firing the same day. Headless player behind the
 * production hold (asks for the next beat only when due, turns in at night), as in eventPerDayCadence. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolveLegally(s: GameSession, p: NonNullable<AdvanceView["pending"]>): AdvanceView | void {
  if (p.kind === "ceremony-step") return s.advanceGame();
  if (p.kind === "nominations") return s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  if (p.kind === "veto-decision") return s.submitDecision({ kind: "veto-decision", use: false });
  if (p.kind === "replacement") return s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  if (p.kind === "comp-round" || p.kind === "comp-intent") { s.submitDecision({ kind: p.kind, intent: "compete" }); return; }
  if (p.kind === "goodbye-message") { s.submitDecision({ kind: "goodbye-message", statement: "bye", vote: p.options[0]?.id }); return; }
  return s.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id } as never);
}

type Read = { next: string; day: number; tomorrow: boolean };

function play(seed: number, weeks: number) {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const reg = new GameSessionRegistry();
  const s = reg.sandboxFor(`tomorrow-${seed}`).session as GameSession & { snapshot(): { live?: { dayNumber?: number } } } & Record<string, any>;
  s.createCharacter({ playerName: "P", seed });
  s.setPerConversationClockEnabled(true);
  const day = () => s.snapshot().live?.dayNumber ?? 0;
  // An event has HAPPENED when the schedule's next milestone moves on from it: every read of it so far is then checked against today's day number.
  let open: Read[] = [];
  let lastNext: string | undefined;
  const checked: Array<Read & { firedDay: number }> = [];
  const observe = (next: string | undefined) => {
    if (lastNext !== undefined && next !== lastNext) {
      const d = day();
      for (const r of open) checked.push({ ...r, firedDay: d });
      open = [];
    }
    lastNext = next;
  };
  let n = 0;
  for (let i = 0; i < 8000; i++) {
    const st = s.getGameState();
    const ds = st.daySchedule;
    if (ds) observe(ds.next); // observe BEFORE the week limit: the transition that ends the last week must flush its open reads, or the last scheduled event goes unchecked
    if ((st.week ?? 1) > weeks) break;
    if (ds && !st.pending) open.push({ next: ds.next, day: day(), tomorrow: ds.tomorrow === true });
    if (st.pending) { resolveLegally(s, st.pending); continue; }
    if (st.phase === "premiere" || (ds && ds.due)) {
      const a = s.advanceGame();
      if (a.held) {
        for (let k = 0; k < 3000 && !["night", "late-night"].includes(s.gameStatus().timeOfDay ?? ""); k++) s.noteMessage({ messageId: `m${n++}` });
        s.turnIn(); s.noteMessage({ messageId: `w${n++}` });
        continue;
      }
      if (a.pending) resolveLegally(s, a.pending);
      if (a.finished) break;
    } else {
      s.noteMessage({ messageId: `m${n++}` });
      if (["night", "late-night"].includes(s.gameStatus().timeOfDay ?? "") && ds && !ds.due) { s.turnIn(); s.noteMessage({ messageId: `w${n++}` }); }
    }
  }
  return checked;
}

describe("ORW-363 - the schedule says today or tomorrow, and it is right", () => {
  it("every 'tomorrow' read is followed by the event on a later day; every other read by the event the same day", () => {
    const checked = play(31, 2);
    const tomorrow = checked.filter((r) => r.tomorrow), today = checked.filter((r) => !r.tomorrow);
    expect(tomorrow.length, "the evening/night after an event announces the next one for tomorrow").toBeGreaterThan(0);
    expect(today.length, "the morning of an event day announces it for today").toBeGreaterThan(0);
    const lastEvent = checked[checked.length - 1]!;
    expect(lastEvent.firedDay, "the final week's last transition was flushed and checked, not dropped by the week-limit break").toBeGreaterThanOrEqual(Math.max(...checked.map((r) => r.day)));
    for (const r of tomorrow) expect(r.firedDay, `${r.next} read on day ${r.day} as tomorrow`).toBeGreaterThan(r.day);
    for (const r of today) expect(r.firedDay, `${r.next} read on day ${r.day} as today`).toBe(r.day);
  }, 120_000);
});
