import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * ORW-275 (week chapters, Lane A slice 1): the played-game turnIn that crosses a week boundary (the bed on eviction night)
 * carries a Vault-free `weekChapter`. Roles only. Driver = the ORW-258 one-event-per-day player.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolveLegally(s: Pick<GameSession, "submitDecision" | "advanceGame">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "ceremony-step") s.advanceGame(); // ORW-281: a staged ceremony step is a watch step - answered by advanceGame, refused by submitDecision
  else if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", statement: "bye", vote: p.options[0]?.id });
  else s.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id } as never);
}

interface Night { weekBefore: number; key: string; view: AdvanceView }
async function play(seed: number, weeks: number, flag: boolean): Promise<{ nights: Night[]; live: Record<string, unknown>; mcp: { callTool(n: string, a: unknown): Promise<unknown> } }> {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`wc-${seed}-${flag}`);
  const s = sb.session as GameSession & Record<string, any>;
  s.setWeekChaptersEnabled(flag);
  s.createCharacter({ playerName: "P", seed });
  s.setPerConversationClockEnabled(true);
  const nights: Night[] = [];
  let n = 0;
  const bed = async (): Promise<void> => {
    const key = `k${n++}`;
    const weekBefore = s.getGameState().week ?? 1;
    const view = (await sb.mcp.player.callTool("turnIn", { idempotencyKey: key })) as AdvanceView;
    nights.push({ weekBefore, key, view });
    s.noteMessage({ messageId: `w${n++}` });
  };
  for (let i = 0; i < 8000; i++) {
    const st = s.getGameState();
    if ((st.week ?? 1) > weeks) break;
    if (st.pending) { resolveLegally(s, st.pending); continue; }
    const ds = st.daySchedule;
    if (st.phase === "premiere" || (ds && ds.due)) {
      const a = s.advanceGame();
      if (a.held) {
        for (let k = 0; k < 3000 && !["night", "late-night"].includes(s.gameStatus().timeOfDay ?? ""); k++) s.noteMessage({ messageId: `m${n++}` });
        await bed();
        continue;
      }
      if (a.pending) resolveLegally(s, a.pending);
      if (a.finished) break;
    } else {
      s.noteMessage({ messageId: `m${n++}` });
      if (["night", "late-night"].includes(s.gameStatus().timeOfDay ?? "") && ds && !ds.due) await bed();
    }
  }
  return { nights, live: JSON.parse(JSON.stringify(s.snapshot().live)), mcp: sb.mcp.player };
}

describe("ORW-275 - weekChapter on the eviction-night turn-in", () => {
  it("appears exactly once per week boundary, on that turn-in only, with the new week and a Vault-free recap", async () => {
    const { nights } = await play(21, 3, true);
    const chapters = nights.filter((x) => x.view.weekChapter);
    expect(chapters.length).toBeGreaterThanOrEqual(2);
    chapters.forEach((c, i) => {
      const wc = c.view.weekChapter!;
      expect(wc.week).toBe(i + 2);
      expect(Object.keys(wc).sort()).toEqual(["recap", "week"]);
      expect(Object.keys(wc.recap).sort()).toEqual(["evicted", "hoh", "standing"]);
      expect(wc.recap.evicted.length).toBe(1);
      expect(wc.recap.hoh === null || typeof wc.recap.hoh === "string").toBe(true);
      expect(wc.recap.standing).toMatch(/^You are (still in the game|the Head of Household)\. \d+ houseguests remain\.$/);
      expect(nights.filter((x) => x.weekBefore === c.weekBefore && x !== c && x.view.weekChapter)).toHaveLength(0);
    });
    expect(chapters[0]!.view.weekChapter!.recap.standing).toContain("15 houseguests remain.");
    expect(nights.filter((x) => !x.view.weekChapter).length).toBeGreaterThan(chapters.length);
  }, 240000);

  it("a replayed turnIn (same idempotencyKey) returns the same weekChapter", async () => {
    const { nights, mcp } = await play(21, 2, true);
    const c = nights.find((x) => x.view.weekChapter)!;
    const again = (await mcp.callTool("turnIn", { idempotencyKey: c.key })) as AdvanceView;
    expect(again.weekChapter).toEqual(c.view.weekChapter);
  }, 240000);

  it("flag off: no chapter, and the played-game snapshot is identical bar the two cursors", async () => {
    const on = await play(21, 2, true);
    const off = await play(21, 2, false);
    expect(off.nights.some((x) => x.view.weekChapter)).toBe(false);
    expect(off.live.chapterWeek).toBeUndefined();
    const strip = (l: Record<string, unknown>): Record<string, unknown> => { const c = { ...l }; delete c.chapterWeek; delete c.chapterEvictCursor; return c; };
    expect(strip(on.live)).toEqual(strip(off.live));
    expect(on.nights.map((x) => ({ ...x.view, weekChapter: undefined }))).toEqual(off.nights.map((x) => ({ ...x.view, weekChapter: undefined })));
  }, 240000);

  it("Vault sentinel: the chapter carries only display names, a public line and the count", async () => {
    const { nights } = await play(21, 2, true);
    const wc = nights.find((x) => x.view.weekChapter)!.view.weekChapter!;
    const json = JSON.stringify(wc);
    expect(json).not.toMatch(/trust|affinity|threat|secret|vault|npc:/i);
  }, 240000);
});
