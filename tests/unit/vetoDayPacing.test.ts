import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { CLOCK } from "../../src/engine/sleepConstants";
import { VETO_DRAW_TO_COMP_GAP_HOURS } from "../../src/engine/daySchedule";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * ORW-565 (Ryne, 11-17: "The veto draw should always be in the morning. The comp in the afternoon. There should always be a gap in between."). A played game, schedule gate ON, the
 * production-shaped player (asks for the next beat only when due, turns in at night). The draw runs only in the morning band; one that missed it waits for the next morning (never late, never
 * a skipped day); the competition starts only in the afternoon band, never in the draw's own turn, and never sooner than the minimum gap after the draw ended. Roles only.
 */
type Any = Record<string, any>;
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolveLegally(s: GameSession, p: NonNullable<AdvanceView["pending"]>): AdvanceView | void {
  if (p.kind === "ceremony-step") return s.advanceGame();
  if (p.kind === "nominations") return s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  if (p.kind === "veto-decision") return s.submitDecision({ kind: "veto-decision", use: false });
  if (p.kind === "replacement") return s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  if (p.kind === "houseguests-choice") return s.submitDecision({ kind: "houseguests-choice", choice: p.options[0] } as never);
  if (p.kind === "comp-round" || p.kind === "comp-intent") { s.submitDecision({ kind: p.kind, intent: "compete" }); return; }
  if (p.kind === "goodbye-message") { s.submitDecision({ kind: "goodbye-message", statement: "bye", vote: p.options[0]?.id }); return; }
  return s.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id } as never);
}

function start(seed: number): GameSessionAdapter {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`vp-${seed}-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed });
  s.setPerConversationClockEnabled(true);
  s.setAdvanceGateEnabled(true);
  return s;
}
const L = (s: GameSessionAdapter): Any => (s as unknown as Any).live;
const abs = (s: GameSessionAdapter): number => ((L(s).dayNumber ?? 1) - 1) * 24 + (L(s).nightDepth ?? 8);

interface Week { drawStartHour?: number; drawEndAbs?: number; compStartHour?: number; compStartAbs?: number; drawTurnStartedComp?: boolean; week: number; drawDay?: number; compDay?: number }

/** Drive the production-shaped player; `stop` ends the drive. Returns one record per veto week. */
function drive(s: GameSessionAdapter, weeks: number, stop?: () => boolean): Week[] {
  const out = new Map<number, Week>();
  const rec = (w: number): Week => { let r = out.get(w); if (!r) { r = { week: w }; out.set(w, r); } return r; };
  let n = 0;
  for (let i = 0; i < 12000; i++) {
    if (stop?.()) break;
    const st = s.getGameState();
    if ((st.week ?? 1) > weeks) break;
    if (st.pending) {
      const before = { hour: L(s).nightDepth as number, hadField: !!L(s).vetoField, ceremony: L(s).ceremony?.kind };
      const p = st.pending;
      if ((p.kind === "comp-round" || p.kind === "comp-intent") && L(s).beat === "veto-competition" && L(s).vetoField) {
        const r = rec(st.week ?? 1);
        if (r.compStartHour === undefined) { r.compStartHour = before.hour; r.compStartAbs = abs(s); r.compDay = L(s).dayNumber; }
      }
      resolveLegally(s, p);
      continue;
    }
    const ds = st.daySchedule;
    if (st.phase === "premiere" || (ds && ds.due)) {
      const hour = L(s).nightDepth as number, day = L(s).dayNumber, wasDraw = L(s).beat === "veto-competition" && !L(s).vetoField && !L(s).ceremony;
      const compNow = L(s).beat === "veto-competition" && !!L(s).vetoField && !L(s).pending; // the comp is what this advance would start
      const a = s.advanceGame();
      if (compNow && !a.held) { const r = rec(st.week ?? 1); if (r.compStartHour === undefined) { r.compStartHour = hour; r.compStartAbs = (day - 1) * 24 + hour; r.compDay = day; } }
      if (a.held) {
        for (let k = 0; k < 3000 && !["night", "late-night"].includes(s.gameStatus().timeOfDay ?? ""); k++) s.noteMessage({ messageId: `m${n++}` });
        s.turnIn(); s.noteMessage({ messageId: `w${n++}` });
        continue;
      }
      if (wasDraw && L(s).ceremony?.kind === "veto-draw") { const r = rec(st.week ?? 1); r.drawStartHour = hour; r.drawDay = day; }
      if (a.finished) break;
      if (a.pending) resolveLegally(s, a.pending);
    } else {
      s.noteMessage({ messageId: `m${n++}` });
      if (["night", "late-night"].includes(s.gameStatus().timeOfDay ?? "") && ds && !ds.due) { s.turnIn(); s.noteMessage({ messageId: `w${n++}` }); }
    }
    for (const r of out.values()) if (r.drawEndAbs === undefined && L(s).vetoDrawnAtAbs !== undefined && r.week === (L(s).week ?? 1)) r.drawEndAbs = L(s).vetoDrawnAtAbs;
  }
  return [...out.values()];
}

describe("ORW-565 - veto day pacing: draw in the morning, comp in the afternoon, a gap between", () => {
  it("every veto week of several seeded played games keeps all three promises", () => {
    let checked = 0;
    for (const seed of [3, 11, 29]) {
      const s = start(seed);
      const weeks = drive(s, 3);
      for (const w of weeks) {
        if (w.drawStartHour === undefined || w.compStartHour === undefined || w.drawEndAbs === undefined) continue;
        checked++;
        expect(w.drawStartHour, `seed ${seed} week ${w.week}: the draw starts in the morning band`).toBeGreaterThanOrEqual(CLOCK.phaseStartsHour.morning - 1e-6);
        expect(w.drawStartHour, `seed ${seed} week ${w.week}: ...and before the afternoon`).toBeLessThan(CLOCK.phaseStartsHour.afternoon);
        expect(w.compStartHour! + 1e-6, `seed ${seed} week ${w.week}: the competition is not before the afternoon start`).toBeGreaterThanOrEqual(CLOCK.phaseStartsHour.afternoon);
        expect(w.compStartHour!, `seed ${seed} week ${w.week}: ...and in the afternoon band`).toBeLessThan(CLOCK.phaseStartsHour.evening);
        expect(w.compDay, `seed ${seed} week ${w.week}: the same day`).toBe(w.drawDay);
        expect(w.compStartAbs! - w.drawEndAbs! + 1e-6, `seed ${seed} week ${w.week}: the minimum gap after the draw ended`).toBeGreaterThanOrEqual(VETO_DRAW_TO_COMP_GAP_HOURS);
      }
    }
    expect(checked, "veto weeks were actually checked").toBeGreaterThanOrEqual(3);
  }, 240_000);

  it("a draw that comes due after the morning waits for the next morning: held, never run late, a day later, no day skipped", () => {
    const s = start(7);
    drive(s, 9, () => L(s).beat === "veto-competition" && !L(s).vetoField && L(s).preVetoNightPassed === true && !L(s).pending && !L(s).ceremony);
    expect(L(s).beat).toBe("veto-competition");
    const day = L(s).dayNumber as number;
    expect(L(s).nightDepth, "the veto day starts in the morning").toBeLessThan(CLOCK.phaseStartsHour.afternoon);
    // the clock slipped past the morning with the draw still waiting (a long turn, a late load)
    L(s).nightDepth = 14; L(s).timeOfDay = "afternoon";
    const seqBefore = s.getGameState().beatSeq;
    const held = s.advanceGame() as Any;
    expect(held.held, "the late draw is held, typed").toBeDefined();
    expect(L(s).vetoField, "nothing drawn").toBeUndefined();
    expect(L(s).ceremony).toBeUndefined();
    expect(s.getGameState().beatSeq, "no commit").toBe(seqBefore);
    expect(s.getGameState().daySchedule?.tomorrow, "the schedule tells the player: tomorrow").toBe(true);
    // the player's night passes; the next morning the draw runs
    const weeks = drive(s, 9, () => L(s).beat === "veto-competition" && !!L(s).vetoField);
    const w = weeks.find((x) => x.drawStartHour !== undefined)!;
    expect(w, "the draw ran").toBeDefined();
    expect(w.drawStartHour!).toBeGreaterThanOrEqual(CLOCK.phaseStartsHour.morning - 1e-6);
    expect(w.drawStartHour!).toBeLessThan(CLOCK.phaseStartsHour.afternoon);
    expect(w.drawDay, "exactly one day later: nothing skipped, nothing doubled").toBe(day + 1);
  }, 120_000);

  it("a restore across the draw keeps the gap hold; the competition never starts in the draw's own turn", () => {
    const s = start(5);
    drive(s, 9, () => L(s).beat === "veto-competition" && !!L(s).vetoField && !L(s).ceremony && L(s).vetoDrawnAtAbs !== undefined);
    expect(L(s).vetoDrawnAtAbs, "the draw's end is stamped").toBeDefined();
    const endAbs = L(s).vetoDrawnAtAbs as number;
    // the draw's own closing turn did not start the competition
    expect(L(s).pending?.kind === "comp-round" || L(s).pending?.kind === "comp-intent", "no competition pending in the draw's turn").toBe(false);
    const revived = new GameSessionRegistry().sandboxFor(`vp-restore-${Math.random()}`).session as GameSessionAdapter;
    revived.restore(s.snapshot());
    revived.setAdvanceGateEnabled(true); revived.setPerConversationClockEnabled(true);
    expect(L(revived).vetoDrawnAtAbs, "the stamp survives the save").toBe(endAbs);
    // put the restored clock inside the gap (afternoon already started, gap not yet kept): the competition is HELD
    L(revived).dayNumber = Math.floor(endAbs / 24) + 1; L(revived).nightDepth = endAbs - Math.floor(endAbs / 24) * 24; L(revived).timeOfDay = "afternoon";
    if ((L(revived).nightDepth as number) < CLOCK.phaseStartsHour.afternoon) L(revived).nightDepth = CLOCK.phaseStartsHour.afternoon - 0 + 0;
    L(revived).vetoDrawnAtAbs = (L(revived).dayNumber - 1) * 24 + (L(revived).nightDepth as number); // the draw ended just now
    const a = revived.advanceGame() as Any;
    expect(a.held?.reason, "inside the gap the competition is held").toBe("schedule");
    expect(L(revived).pending).toBeUndefined();
    // once the gap has passed the same restored game starts the competition
    L(revived).nightDepth = (L(revived).nightDepth as number) + VETO_DRAW_TO_COMP_GAP_HOURS;
    const b = revived.advanceGame() as Any;
    expect(b.held, "after the gap it runs").toBeUndefined();
  }, 120_000);

  it("a draw late in the morning still leaves the full gap before an afternoon competition", () => {
    const s = start(13);
    drive(s, 9, () => L(s).beat === "veto-competition" && !L(s).vetoField && L(s).preVetoNightPassed === true && !L(s).pending && !L(s).ceremony);
    L(s).nightDepth = CLOCK.phaseStartsHour.afternoon - 0.2; L(s).timeOfDay = "morning"; // the last minutes of the morning
    const w = drive(s, 9, () => L(s).beat !== "veto-competition").find((x) => x.drawStartHour !== undefined)!;
    expect(w.drawStartHour!).toBeLessThan(CLOCK.phaseStartsHour.afternoon);
    expect(w.compStartHour!, "the afternoon has begun").toBeGreaterThanOrEqual(CLOCK.phaseStartsHour.afternoon - 1e-6);
    expect(w.compStartAbs! - w.drawEndAbs! + 1e-6, "and the gap after the draw ended is still kept").toBeGreaterThanOrEqual(VETO_DRAW_TO_COMP_GAP_HOURS);
    expect(w.compDay).toBe(w.drawDay);
  }, 120_000);
});
