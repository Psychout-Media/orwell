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
  it("controlled: with the cap reached the same pick comes back marked capped (desire and cooldown untouched), and a quiet gap releases it", () => {
    type P = { desireApproach(ids: string[]): { npc: string; desire: string; capped?: true } | null; awakeNow(): Set<string> | null; absHour(): number };
    let exercised = 0;
    for (const seed of [3, 5, 8, 11, 13]) {
      const s = parked(seed, `ctl${seed}`); if (!s) continue;
      const p = s as unknown as P; const l = liveRef(s);
      l.playedGame = true;
      const idsNow = () => [...(p.awakeNow() ?? [])].filter((id) => id !== (s.getGameState() as unknown as { player?: { id: string } }).player?.id);
      l.approachStreak = undefined;
      let free: ReturnType<P["desireApproach"]> = null;
      for (let i = 0; i < 120 && !free && !(s.getGameState() as { daySchedule?: { due: boolean } }).daySchedule?.due; i++) {
        free = p.desireApproach(idsNow());
        if (!free) { l.approachStreak = undefined; s.advanceClockPerConversation(); }
      }
      if (!free) continue;
      const ids = idsNow();
      expect(free.capped, "no streak: not capped").toBeUndefined();
      const cooldownBefore = JSON.stringify(l.desireApproachedAt ?? {});
      l.approachStreak = { desire: free.desire, count: DESIRE.streakCap, lastHour: p.absHour() };
      const held = p.desireApproach(ids);
      expect(held, "the cap marks the SAME pick capped").toEqual({ ...free, capped: true });
      expect(JSON.stringify(l.desireApproachedAt ?? {}), "deciding a capped pick spends no cooldown by itself").toBe(cooldownBefore);
      l.approachStreak = { desire: free.desire, count: DESIRE.streakCap, lastHour: p.absHour() - DESIRE.streakQuietHours };
      expect(p.desireApproach(ids)?.capped, "a quiet gap releases the cap").toBeUndefined();
      exercised++;
    }
    expect(exercised, "at least one seed produced an approach to cap").toBeGreaterThan(0);
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
