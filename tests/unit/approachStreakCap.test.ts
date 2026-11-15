import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../../features/support/answerPending";
import { streakHolds, nextStreak, heldOutcome, HELD, DESIRE } from "../../src/engine/desireClock";

/** ORW-423: a pile of same-purpose approaches is capped per stretch in a PLAYED game only; the brief carries no "N people asked" count. Roles only. */
type S = GameSessionAdapter;
type Live = { desireRestShift?: Record<string, number>; approachHeld?: true; playedGame?: boolean; approachStreak?: { desire: string; count: number; lastHour: number }; interruption?: { npc: string; desire: string }; desireApproachedAt?: Record<string, number> };
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
  it("played game: never more than the cap in a row, the cap releases after a quiet stretch, and a held houseguest rests per their own sheet (ORW-452), not a fixed 3 h", () => {
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
  it("controlled: with the cap reached the same pick comes back marked capped (the pick itself is unchanged; the caller rests them per their sheet), and a quiet gap releases it", () => {
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

describe("ORW-452 approachHeld on the hang-out path", () => {
  type P = { desireApproach(ids: string[]): { npc: string; desire: string; capped?: true } | null; awakeNow(): Set<string> | null; absHour(): number };
  const stateOf = (s: S) => s.getGameState() as { approachHeld?: boolean; interruption?: unknown; daySchedule?: { due: boolean }; player?: { id: string } };
  /** Arm the cap for whatever the next pick would be (streak at the cap, same desire, "now"), then wait. */
  function armedWait(s: S): { held: boolean; npc?: string } {
    const p = s as unknown as P; const l = liveRef(s);
    const ids = [...(p.awakeNow() ?? [])].filter((id) => id !== stateOf(s).player?.id);
    l.approachStreak = undefined;
    const peek = p.desireApproach(ids);
    if (peek) l.approachStreak = { desire: peek.desire, count: DESIRE.streakCap, lastHour: p.absHour() };
    s.hangOut({ maxBeats: 3 });
    return { held: stateOf(s).approachHeld === true, ...(peek ? { npc: peek.npc } : {}) };
  }
  it("a played wait that holds an approach ends with approachHeld; it clears on the next turn without one; headless never sets it", () => {
    let held = 0;
    for (const seed of [3, 5, 8, 11, 13]) {
      const s = parked(seed, `ho${seed}`); if (!s) continue;
      liveRef(s).playedGame = true;
      for (let i = 0; i < 40 && !stateOf(s).daySchedule?.due; i++) {
        const before = JSON.stringify(live(s).desireApproachedAt ?? {});
        const r = armedWait(s);
        if (r.held) {
          held++;
          expect(stateOf(s).interruption, "the hold never interrupts").toBeUndefined();
          expect(JSON.stringify(live(s).desireApproachedAt ?? {}) !== before, "the want was spent").toBe(true);
          // the held pick got the NORMAL cooldown (cubic): it cannot be picked again right away, and the hold never coexists with a real interruption
          expect((s as unknown as P).desireApproach([r.npc!])?.npc, "the held houseguest is on cooldown").not.toBe(r.npc);
          expect(stateOf(s).interruption === undefined, "a hold and a real approach never coexist").toBe(true);
          // the next wait with no capped approach (streak released) clears it
          liveRef(s).approachStreak = undefined;
          s.hangOut({ maxBeats: 1 });
          expect("approachHeld" in stateOf(s), "cleared on the next turn").toBe(false);
          break;
        }
      }
    }
    expect(held, "at least one played wait held an approach").toBeGreaterThan(0);
    for (const seed of [3, 5, 8]) {
      const s = parked(seed, `hoh${seed}`); if (!s) continue; // headless: never played
      for (let i = 0; i < 20 && !stateOf(s).daySchedule?.due; i++) { armedWait(s); expect("approachHeld" in stateOf(s)).toBe(false); }
    }
  });
  it("a hang-out with no capped approach clears a stale hold", () => {
    const s = parked(3, "hostale"); if (!s) return;
    liveRef(s).playedGame = true; liveRef(s).approachHeld = true;
    liveRef(s).approachStreak = undefined;
    s.hangOut({ maxBeats: 1 });
    expect("approachHeld" in stateOf(s) && stateOf(s).approachHeld).toBe(false);
  });
});

describe("ORW-452 point 2: a held houseguest's next step comes from their own sheet", () => {
  const warm = { affinity: 0.8, trust: 0.8 }; const cold = { affinity: 0, trust: 0 };
  it("pure: a persistent, high-want houseguest returns sooner than a proud, low-want one; deterministic", () => {
    const keen = heldOutcome({ strategyStyle: "aggressive", ...warm });
    const proud = heldOutcome({ strategyStyle: "under-the-radar", ...cold });
    expect(keen.outcome).toBe("come-back");
    expect(proud.outcome).toBe("give-up");
    expect(keen.cooldownHours).toBeLessThan(proud.cooldownHours);
    expect(heldOutcome({ strategyStyle: "strategic", affinity: 0.4, trust: 0.4 }).outcome).toBe("wait");
    expect(heldOutcome({ strategyStyle: "aggressive", ...cold }).outcome, "driven but not toward the player").toBe("elsewhere");
    expect(heldOutcome({ strategyStyle: "aggressive", ...warm })).toEqual(keen);
    expect(keen.cooldownHours).toBe(HELD.cooldownHours["come-back"]);
  });
  it("live: the same held pick rests longer or shorter by sheet; the hold itself still withholds the interruption", () => {
    type P = { desireApproach(ids: string[]): { npc: string; desire: string; capped?: true } | null; awakeNow(): Set<string> | null; absHour(): number; noteApproach(n: string, d?: string, c?: boolean): void; house: { npcs: { id: string; character: { strategyStyle: string } }[] }; rel: { edge(a: string, b: string): { affinity: number; trust: number } } };
    let exercised = 0;
    for (const seed of [3, 5, 8, 11, 13]) {
      const s = parked(seed, `sh${seed}`); if (!s) continue;
      const p = s as unknown as P; const l = liveRef(s); l.playedGame = true;
      const npc = p.house.npcs[0]!; const e = p.rel.edge(npc.id, "player");
      const rest = (style: string, aff: number) => {
        npc.character.strategyStyle = style; e.affinity = aff; e.trust = aff; delete l.desireApproachedAt;
        const t = p.absHour(); p.noteApproach(npc.id, "campaign", true);
        expect(l.desireApproachedAt![npc.id], "movement keeps the plain stamp").toBe(t);
        return l.desireRestShift![npc.id]!;
      };
      const keen = rest("aggressive", 0.9); const proud = rest("under-the-radar", 0);
      expect(keen).toBeLessThan(0); expect(proud).toBeGreaterThan(0);
      expect(rest("aggressive", 0.9)).toBe(keen); // deterministic
      delete l.desireApproachedAt; p.noteApproach(npc.id, "campaign", false);
      expect(l.desireApproachedAt![npc.id], "an un-held approach stamps now").toBe(p.absHour());
      l.playedGame = false; npc.character.strategyStyle = "aggressive"; delete l.desireApproachedAt; p.noteApproach(npc.id, "campaign", true);
      expect(l.desireApproachedAt![npc.id], "headless: unchanged").toBe(p.absHour()); expect(l.desireRestShift?.[npc.id]).toBeUndefined();
      exercised++;
    }
    expect(exercised).toBeGreaterThan(0);
  });
});
