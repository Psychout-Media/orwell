import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../../features/support/answerPending";
import { streakHolds, nextStreak, DESIRE } from "../../src/engine/desireClock";

/** ORW-423: a pile of same-purpose approaches is capped per stretch in a PLAYED game only; the brief carries no "N people asked" count. Roles only. */
type S = GameSessionAdapter;
type Live = { playedGame?: boolean; approachStreak?: { desire: string; count: number; lastHour: number }; interruption?: { npc: string; desire: string }; desireApproachedAt?: Record<string, number> };
const live = (s: S): Live => (s.snapshot() as unknown as { live: Live }).live;
const liveRef = (s: S): Live => (s as unknown as { live: Live }).live;

function parked(seed: number, user: string): S | null {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(user).session as S;
  s.createCharacter({ playerName: "P", seed });
  s.setPerConversationClockEnabled(true); s.setHangOutEnabled(true); s.setDesireClockEnabled(true);
  for (let i = 0; i < 600; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    const st = s.getGameState() as { daySchedule?: { due: boolean }; pending?: unknown };
    if (st.daySchedule && st.daySchedule.due === false && !st.pending && live(s).interruption === undefined && (s.snapshot() as unknown as { live: { hoh?: string } }).live.hoh !== undefined) return s;
  }
  return null;
}
/** Step conversation beats; return the approaches seen as [desire] in order, plus the max run of the same desire. */
function run(s: S, steps: number): { seen: string[]; maxRun: number } {
  const seen: string[] = []; let maxRun = 0; let cur = 0; let last = ""; let lastAt = -99;
  for (let i = 0; i < steps; i++) {
    const before = JSON.stringify(live(s).desireApproachedAt ?? {});
    s.advanceClockPerConversation();
    const l = live(s);
    if (l.interruption && JSON.stringify(l.desireApproachedAt ?? {}) !== before) {
      seen.push(l.interruption.desire);
      const at = Math.max(...Object.values(l.desireApproachedAt ?? {}));
      cur = l.interruption.desire === last && at - lastAt < DESIRE.streakQuietHours ? cur + 1 : 1; lastAt = at; last = l.interruption.desire; maxRun = Math.max(maxRun, cur);
    }
    if ((s.getGameState() as { daySchedule?: { due: boolean } }).daySchedule?.due) break;
  }
  return { seen, maxRun };
}
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

describe("ORW-423 pure cap", () => {
  it("holds after the cap within a stretch; releases on a quiet gap or a different purpose", () => {
    let st = nextStreak(undefined, "campaign", 10);
    st = nextStreak(st, "campaign", 10.5);
    expect(st.count).toBe(DESIRE.streakCap);
    expect(streakHolds(st, "campaign", 11)).toBe(true);
    expect(streakHolds(st, "plea", 11)).toBe(false);
    expect(streakHolds(st, "campaign", 10.5 + DESIRE.streakQuietHours)).toBe(false);
    expect(nextStreak(st, "campaign", 10.5 + DESIRE.streakQuietHours).count).toBe(1);
    expect(streakHolds(undefined, "campaign", 1)).toBe(false);
  });
});

describe("ORW-423 live", () => {
  it("played game: never more than the cap in a row, the cap releases after a quiet stretch, and the deferred keep their desire", () => {
    let checked = 0;
    for (const seed of [3, 5, 8, 11, 13]) {
      const s = parked(seed, `cap${seed}`); if (!s) continue;
      liveRef(s).playedGame = true;
      const r = run(s, 120);
      expect(r.maxRun, `seed ${seed} ${r.seen.join(",")}`).toBeLessThanOrEqual(DESIRE.streakCap);
      if (r.seen.length > 0) checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
  it("headless (not played): the cap never applies and no streak is written", () => {
    let sawMore = false;
    for (const seed of [3, 5, 8, 11, 13]) {
      const s = parked(seed, `hl${seed}`); if (!s) continue;
      expect(liveRef(s).playedGame).not.toBe(true);
      const r = run(s, 120);
      expect(JSON.stringify(s.snapshot())).not.toContain("approachStreak");
      if (r.maxRun > DESIRE.streakCap) sawMore = true;
    }
    expect(sawMore, "without played-game gating the old pile-up still occurs (control)").toBe(true);
  });
  it("the interruption brief is names + coarse desire only: no count of people who asked", () => {
    for (const seed of [3, 5, 8]) {
      const s = parked(seed, `br${seed}`); if (!s) continue;
      liveRef(s).playedGame = true;
      for (let i = 0; i < 80; i++) {
        s.advanceClockPerConversation();
        const b = (s.getGameState() as { interruption?: Record<string, unknown> }).interruption;
        if (b) { expect(Object.keys(b).sort().filter((k) => k !== "tells")).toEqual(["desire", "npc"]); expect(JSON.stringify(b)).not.toMatch(/\d/); return; }
      }
    }
    throw new Error("no interruption surfaced");
  });
});

describe("ORW-443 approachHeld", () => {
  it("true exactly on a turn the cap withheld an approach; absent otherwise and for headless games", () => {
    let held = 0;
    for (const seed of [3, 5, 8, 11, 13]) {
      const s = parked(seed, `ah${seed}`); if (!s) continue;
      liveRef(s).playedGame = true;
      for (let i = 0; i < 120; i++) {
        const before = JSON.stringify(live(s).desireApproachedAt ?? {});
        s.advanceClockPerConversation();
        const l = live(s); const v = s.getGameState() as { approachHeld?: boolean; interruption?: unknown; daySchedule?: { due: boolean } };
        const stamped = JSON.stringify(l.desireApproachedAt ?? {}) !== before;
        if (v.approachHeld) { held++; expect(v.interruption).toBeUndefined(); expect(stamped).toBe(true); }
        else if (stamped) expect(v.interruption).toBeDefined(); // an approach ran and was not withheld
        else expect("approachHeld" in v).toBe(false); // clears the next turn
        if (v.daySchedule?.due) break;
      }
    }
    expect(held).toBeGreaterThan(0);
    for (const seed of [3, 5, 8]) {
      const s = parked(seed, `ahh${seed}`); if (!s) continue;
      for (let i = 0; i < 120; i++) { s.advanceClockPerConversation(); expect("approachHeld" in (s.getGameState() as object)).toBe(false); }
    }
  });
});
