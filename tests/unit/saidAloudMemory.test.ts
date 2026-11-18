import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { playSeason } from "../support/agendaSeasonDriver";
import { PLAYER } from "../../src/domain/ids";
import type { StatedReasonRecord } from "../../src/engine/agendaDecisions";

/** ORW-578 (b): a reason said aloud at a public act stays in the house's shared memory as a witnessed event. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

type Live = { statedReasons?: StatedReasonRecord[]; [k: string]: unknown };
const liveOf = (s: GameSessionAdapter): Live => s.snapshot().live as unknown as Live;
const words = (slug: string): string => slug.replace(/-/g, " ");

describe("ORW-578 (b): said-aloud reasons kept as witnessed memory", () => {
  it("a played season keeps each public reason as a witnessed (never hidden) event the player heard, holding only the said kind in words", () => {
    const a = playSeason(3, { stopAtWeek: 3 });
    const recs = liveOf(a.s).statedReasons ?? [];
    const kept = recs.filter((r) => r.saidEventId !== undefined);
    expect(kept.length).toBeGreaterThan(0);
    const events = a.sb.engine.events.queryAll();
    const said = events.filter((e) => e.type === "said-aloud");
    expect(said.length).toBe(kept.length);
    for (const r of kept) {
      const e = events.find((x) => x.id === r.saidEventId)!;
      expect(e).toBeDefined();
      expect(e.hidden).toBe(false);
      expect(e.witnessSet).toContain(PLAYER);
      expect(e.witnessSet).toContain(r.decider);
      expect(e.witnessSet).toContain(r.stated.about);
      expect(e.initiator).toBe(r.decider);
      // the SAID kind, in words, by composition from the closed kind (recall can compare it with what drove the choice)
      expect(e.content).toContain(words(r.stated.kind));
      expect(e.content).toContain(words(r.decision));
      expect(/[0-9]|npc:|player/.test(e.content)).toBe(false); // no number, id or role token
    }
    // recall: the player's own visible events carry them
    const mine = a.sb.engine.events.query({ witnessedBy: PLAYER, type: "said-aloud" });
    expect(mine.length).toBe(said.length);
    // each reason is kept once
    expect(new Set(kept.map((r) => r.saidEventId)).size).toBe(kept.length);
  }, 300_000);

  it("the real reason never reaches the kept event or any player-visible event: the goal ids and term words on the records are absent", () => {
    const a = playSeason(3, { stopAtWeek: 3 });
    const recs = liveOf(a.s).statedReasons ?? [];
    const visible = JSON.stringify(a.sb.engine.events.query({ witnessedBy: PLAYER }).filter((e) => e.type === "said-aloud"));
    const goalIds = recs.map((r) => r.real.goalId).filter((g): g is string => !!g);
    expect(recs.length).toBeGreaterThan(0);
    for (const g of goalIds) expect(visible.includes(g)).toBe(false);
    expect(/candor|terms|goal|truth|cover/i.test(visible)).toBe(false);
  }, 300_000);

  it("flag off: nothing is kept and the season is otherwise the same; the kept record survives a save and restore", () => {
    const strip = (l: Live): string => JSON.stringify(l, (k, v) => (k === "saidEventId" || k === "seenAt" || /cursor$/i.test(k) ? undefined : v)); // the kept events only move the event-log INDEX cursors
    const on = playSeason(3, { stopAtWeek: 2 });
    GameSessionAdapter.setTimeOfDayEnabled(false);
    const off = playSeason(3, { stopAtWeek: 2, configure: (s) => s.setSaidAloudMemoryEnabled(false) });
    expect(off.sb.engine.events.queryAll().filter((e) => e.type === "said-aloud")).toHaveLength(0);
    expect((liveOf(off.s).statedReasons ?? []).some((r) => r.saidEventId !== undefined)).toBe(false);
    expect(strip(liveOf(off.s))).toBe(strip(liveOf(on.s)));
    const kept = (liveOf(on.s).statedReasons ?? []).filter((r) => r.saidEventId !== undefined).map((r) => r.saidEventId);
    expect(kept.length).toBeGreaterThan(0);
    const again = JSON.parse(JSON.stringify(on.s.snapshot())) as { live: Live };
    expect((again.live.statedReasons ?? []).filter((r) => r.saidEventId !== undefined).map((r) => r.saidEventId)).toEqual(kept);
  }, 300_000);
});
