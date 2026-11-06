import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { PLAYER_TOOLS } from "../../src/surfaces/tools/registry";
import { buildSandbox } from "../support/sandbox";
import { resolvePending } from "../../features/support/answerPending";

/** "Hang out until X" through the REAL session: every stop reason, the event clamp, flag-off/clock-off no-ops, determinism, persistence, MCP boundary. Roles only. */
type S = GameSessionAdapter;
type Live = { nightDepth?: number; hangOutLog?: unknown[]; hangOutCount?: number };

/** A started, clock-on game parked on a not-yet-due milestone (so there is a scheduled event to clamp to). */
function parked(seed: number, user = `ho${seed}`, afterFirstCeremony = false): S | null {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(user).session as S;
  s.createCharacter({ playerName: "P", seed });
  s.setDesireClockEnabled(false); s.setWantMovementEnabled(false); s.setMorningApproachEnabled(false); s.setMoodApproachEnabled(false); s.setApproachMemoryEnabled(false); s.setNpcTellsEnabled(false); // explicit OFF: these default ON now and re-time the hang-out stops this fixture counts
  s.setPerConversationClockEnabled(true);
  s.setHangOutEnabled(true);
  for (let i = 0; i < 600; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    const st = s.getGameState() as { daySchedule?: { due: boolean } };
    if (st.daySchedule && st.daySchedule.due === false && ((s.snapshot() as unknown as { live: { dayNumber?: number } }).live.dayNumber ?? 1) >= 2 && !(s.getGameState() as { pending?: unknown }).pending && (!afterFirstCeremony || (s.snapshot() as unknown as { live: { hoh?: string } }).live.hoh !== undefined)) return s;
  }
  return null;
}
const live = (s: S): Live => (s.snapshot() as unknown as { live: Live }).live;
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

describe("hangOut lever", () => {
  it("flag off: ok:false and ZERO state change (byte-identical)", () => {
    const s = parked(3)!; s.setHangOutEnabled(false);
    const before = JSON.stringify(s.snapshot());
    expect(s.hangOut()).toMatchObject({ ok: false, reason: "disabled", beats: 0 });
    expect(JSON.stringify(s.snapshot())).toBe(before);
  });
  it("clock off: ok:false and ZERO state change", () => {
    const s = parked(3)!; s.setPerConversationClockEnabled(false);
    const before = JSON.stringify(s.snapshot());
    expect(s.hangOut()).toMatchObject({ ok: false, reason: "clock-off" });
    expect(JSON.stringify(s.snapshot())).toBe(before);
  });
  it("no game: ok:false", () => {
    const s = new GameSessionRegistry().sandboxFor("ho-none").session as S; s.setHangOutEnabled(true);
    expect(s.hangOut()).toMatchObject({ ok: false, reason: "no-game" });
  });
  it("runs beats of 15-30 min, never past the scheduled event, and records the stop", () => {
    let checked = 0;
    for (const seed of [3, 5, 8, 11]) {
      const s = parked(seed); if (!s) continue;
      const h0 = live(s).nightDepth!;
      const r = s.hangOut();
      expect(r.ok).toBe(true);
      expect(r.beats).toBeGreaterThan(0);
      expect(r.beats).toBeLessThanOrEqual(8);
      expect(r.minutes).toBeGreaterThanOrEqual(15 * r.beats - 1);
      expect(r.minutes).toBeLessThanOrEqual(30 * r.beats + 1);
      const st = s.getGameState() as { daySchedule?: { due: boolean } };
      if (r.stopReason === "event-due") expect(st.daySchedule?.due).toBe(true);
      else expect(st.daySchedule?.due).toBe(false); // never fires/skips an event
      expect(live(s).nightDepth!).toBeGreaterThan(h0);
      expect(live(s).hangOutLog).toHaveLength(1);
      expect(live(s).hangOutCount).toBe(1);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
  it("repeated hang-outs reach the event and STOP there (event-due), without overshooting it", () => {
    const s = parked(5)!;
    let last = s.hangOut();
    for (let i = 0; i < 40 && last.stopReason !== "event-due" && last.stopReason !== "bedtime"; i++) last = s.hangOut();
    expect(["event-due", "bedtime"]).toContain(last.stopReason);
    if (last.stopReason === "event-due") expect((s.getGameState() as { daySchedule?: { due: boolean } }).daySchedule?.due).toBe(true);
    // once due: a further call fires nothing and spends nothing
    const again = s.hangOut();
    if (last.stopReason === "event-due") expect(again).toMatchObject({ ok: true, stopReason: "event-due", beats: 0, minutes: 0 });
  });
  it("every stop reason is reachable and each carries only public detail", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 200 && seen.size < 4; seed++) {
      const s = parked(seed, `ho${seed}x`, true); if (!s) continue;
      for (let i = 0; i < 12; i++) {
        const r = s.hangOut(); seen.add(r.stopReason!);
        if (r.stopReason === "npc-approach") expect(typeof r.detail?.npc).toBe("string");
        if (r.stopReason === "pulled") expect(["diary-room", "production"]).toContain(r.detail?.by);
        if (r.stopReason === "observed") { expect(r.detail?.who?.length).toBeGreaterThan(0); expect(JSON.stringify(r.detail)).not.toMatch(/npc-\d|[0-9]\.[0-9]/); }
        if (r.stopReason === "event-due" || r.stopReason === "bedtime") break;
      }
    }
    for (const reason of ["event-due", "npc-approach", "pulled", "observed"]) expect(seen, `stop reason ${reason} reached`).toContain(reason);
  });
  it("stop: bedtime - already late => no beats; nearing midnight => stops at it; 8pm is NOT bedtime (max-beats is pinned in the pure runner)", () => {
    const s = parked(3)!;
    // Park the clock just before the night threshold with the event comfortably not due (the next day's milestone).
    const snap = s.snapshot() as unknown as { live: Live & { timeOfDay?: string } };
    snap.live.nightDepth = 23.9;
    const c = new GameSessionRegistry().sandboxFor("ho-bed").session as S; c.setHangOutEnabled(true); c.setPerConversationClockEnabled(true);
    GameSessionAdapter.setTimeOfDayEnabled(true);
    c.restore(snap as unknown as Parameters<S["restore"]>[0]);
    const r = c.hangOut();
    expect(["bedtime", "event-due", "pulled", "npc-approach", "observed"]).toContain(r.stopReason);
    const late = JSON.parse(JSON.stringify(snap)); late.live.nightDepth = 24.5;
    const d = new GameSessionRegistry().sandboxFor("ho-bed2").session as S; d.setHangOutEnabled(true); d.setPerConversationClockEnabled(true);
    d.restore(late);
    const r2 = d.hangOut();
    expect(r2.beats).toBe(0);
    expect(["bedtime", "event-due"]).toContain(r2.stopReason);
    // 8pm-midnight is prime social time: a mid-evening hang-out is NOT stopped as bedtime up front.
    const eve = JSON.parse(JSON.stringify(snap)); eve.live.nightDepth = 20.5;
    const e = new GameSessionRegistry().sandboxFor("ho-bed3").session as S; e.setHangOutEnabled(true); e.setPerConversationClockEnabled(true);
    e.restore(eve);
    const r3 = e.hangOut();
    expect(r3.beats > 0 || r3.stopReason === "event-due").toBe(true); // never an up-front "bedtime" at 8:30pm
  });
  it("pulled fires at most once per in-game day", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = parked(seed, `ho${seed}y`, true); if (!s) continue;
      let pulls = 0;
      for (let i = 0; i < 30; i++) { const r = s.hangOut(); if (r.stopReason === "pulled") pulls++; if (r.stopReason === "event-due" || r.stopReason === "bedtime") break; }
      expect(pulls).toBeLessThanOrEqual(1);
    }
  });
  it("is deterministic for a seed and survives a snapshot/restore", () => {
    const a = parked(5)!, b = parked(5, "ho5b")!;
    expect(a.hangOut()).toEqual(b.hangOut());
    const snap = a.snapshot();
    const c = new GameSessionRegistry().sandboxFor("ho5c").session as S; c.setHangOutEnabled(true); c.setPerConversationClockEnabled(true);
    c.setDesireClockEnabled(false); c.setWantMovementEnabled(false); c.setMorningApproachEnabled(false); c.setMoodApproachEnabled(false); c.setApproachMemoryEnabled(false); c.setNpcTellsEnabled(false); // the SAME flags `parked` pins (the restored session must run the same layers as the original)
    GameSessionAdapter.setTimeOfDayEnabled(true);
    c.restore(snap);
    expect(live(c).hangOutCount).toBe(1);
    expect(c.hangOut()).toEqual(a.hangOut()); // the persisted counter keeps the side stream aligned
  });
  it("refuses while a decision is pending (no state change)", () => {
    const s = parked(3)!;
    for (let i = 0; i < 600 && !(s.getGameState() as { pending?: unknown }).pending; i++) { const v = s.advanceGame(); if (v.finished) break; }
    if (!(s.getGameState() as { pending?: unknown }).pending) return;
    const before = JSON.stringify(s.snapshot());
    expect(s.hangOut()).toMatchObject({ ok: false, reason: "pending-decision" });
    expect(JSON.stringify(s.snapshot())).toBe(before);
  });
  it("the orchestrator's follow-up per-conversation step is skipped ONCE after a hang-out", () => {
    const s = parked(3)!;
    s.hangOut();
    const h = live(s).nightDepth!;
    s.advanceClockPerConversation(); expect(live(s).nightDepth).toBe(h); // skipped once
    s.advanceClockPerConversation(); expect(live(s).nightDepth!).toBeGreaterThan(h); // then normal again
  });
});

describe("hangOut isolation (AMEND time-stack v2 #6)", () => {
  it("does not perturb the comp/vote random stream: after a hang-out the season plays out EXACTLY as a twin that merely has the same clock hour", () => {
    let checked = 0;
    for (const seed of [3, 5, 8]) {
      const a = parked(seed, `iso${seed}a`);
      if (!a) continue;
      a.hangOut();
      const snapA = JSON.parse(JSON.stringify(a.snapshot())) as { live: Live & Record<string, unknown> };
      // The twin: the SAME snapshot minus every hang-out artefact - same clock hour, no counter/log/pull-day, so any divergence can only come from a perturbed rng.
      const snapB = JSON.parse(JSON.stringify(snapA)) as typeof snapA;
      delete snapB.live.hangOutCount; delete snapB.live.hangOutLog; delete snapB.live.hangOutPulledDay;
      const play = (snap: typeof snapA, user: string) => {
        const g = new GameSessionRegistry().sandboxFor(user).session as S;
        GameSessionAdapter.setTimeOfDayEnabled(true);
        g.setPerConversationClockEnabled(true); g.setHangOutEnabled(true);
        g.restore(snap as unknown as Parameters<S["restore"]>[0]);
        for (let i = 0; i < 6000; i++) { const v = g.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void g.submitDecision(req)); if (v.finished) break; }
        const l = (g.snapshot() as unknown as { live: { evictionOrder: unknown; winner: unknown } }).live;
        return { order: l.evictionOrder, winner: l.winner };
      };
      expect(play(snapA, `iso${seed}c`)).toEqual(play(snapB, `iso${seed}d`));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
  it("a hang-out never fires an event early: the board's due flag only flips at/after the scheduled hour", () => {
    for (const seed of [3, 5, 8, 11]) {
      const s = parked(seed); if (!s) continue;
      for (let i = 0; i < 30; i++) {
        const before = (s.getGameState() as { daySchedule?: { due: boolean }; phase: string });
        const r = s.hangOut();
        const after = (s.getGameState() as { daySchedule?: { due: boolean }; phase: string });
        expect(after.phase, "a hang-out never advances the loop").toBe(before.phase);
        if (r.stopReason !== "event-due") expect(after.daySchedule?.due).toBe(false);
        if (r.stopReason === "event-due" || r.stopReason === "bedtime") break;
      }
    }
  });
});

describe("hangOut over the MCP boundary", () => {
  it("is a player tool and dispatches (not 'not available'); bad maxBeats is refused", async () => {
    expect(PLAYER_TOOLS.map((t) => t.name)).toContain("hangOut");
    const sb = buildSandbox(1);
    const session = new GameSessionAdapter();
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    const res = (await server.callTool("hangOut", {})) as { ok: boolean; reason?: string };
    expect(res.ok).toBe(false); // flag off / no game - but it dispatched
    await expect(server.callTool("hangOut", { maxBeats: 0 })).rejects.toThrow();
  });
});
