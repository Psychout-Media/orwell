import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { sessionCoreSupersetViolation } from "../../src/engine/sessionSnapshot";
import type { Agenda } from "../../src/engine/agenda";
import { playSeason } from "../support/agendaSeasonDriver";
import { PLAYER } from "../../src/domain/ids";

/** ORW-312 (ORW-253 slice 1, spec 0145): the agenda is carried on the live season, re-checked on real events, mulled at night, and saved with nothing lost. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));

type Live = { agendas?: Record<string, Agenda>; winner?: string; evictionOrder: string[]; voteRecord?: unknown; jury?: string[]; finalTwo?: string[]; [k: string]: unknown };
const liveOf = (s: GameSessionAdapter): Live => s.snapshot().live as unknown as Live;
const proto = GameSessionAdapter.prototype as unknown as Record<string, unknown>;
/** The season as it was before this change: the three agenda entry points do nothing. */
function withoutAgendas<T>(fn: () => T): T {
  const keep = { seed: proto.seedAgendas, re: proto.agendaRecheck, mull: proto.mullAgendasOvernight };
  proto.seedAgendas = () => {}; proto.agendaRecheck = () => {}; proto.mullAgendasOvernight = () => {};
  try { return fn(); } finally { proto.seedAgendas = keep.seed; proto.agendaRecheck = keep.re; proto.mullAgendasOvernight = keep.mull; }
}
/** ORW-314: agendas present but their pull on decisions zeroed (the season as it was before decisions read goals). */
function withPullZeroed<T>(fn: () => T): T {
  // ORW-317: a settled goal also moves mood now (goal mood), so "agendas present but with no effect" zeroes that too.
  const keep = { pull: proto.agendaPullOf, mood: proto.appraiseSettled };
  proto.agendaPullOf = () => ({ value: 0 }); proto.appraiseSettled = () => {};
  try { return fn(); } finally { proto.agendaPullOf = keep.pull; proto.appraiseSettled = keep.mood; }
}
const outcome = (l: Live) => JSON.stringify({ winner: l.winner, evictionOrder: l.evictionOrder, jury: l.jury, finalTwo: l.finalTwo, voteRecord: l.voteRecord });
const strip = (l: Live): string => JSON.stringify({ ...l, agendas: undefined });

describe("ORW-312: NPC agendas on the live season", () => {
  it("a played game seeds every NPC (and never the player); an unplayed game has none", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`ag-${Math.random()}`).session as GameSessionAdapter;
    s.createCharacter({ playerName: "P", seed: 5 });
    expect(liveOf(s).agendas).toBeUndefined();
    s.noteMessage({ messageId: "m-1" });
    const ag = liveOf(s).agendas!;
    expect(Object.keys(ag)).toHaveLength(15);
    expect(ag[PLAYER]).toBeUndefined();
    for (const a of Object.values(ag)) expect(a.goals.some((g) => g.horizon === "season")).toBe(true);
  });

  it("(a) ORW-314: with the agenda's pull zeroed a played season is exactly the pre-wiring one; with the pull on it is a different season, REPORTED not gated (balance is a report)", () => {
    for (const seed of [3]) {
      const off = withoutAgendas(() => playSeason(seed));
      const zero = withPullZeroed(() => playSeason(seed));
      const on = playSeason(seed);
      expect(on.finished).toBe(true);
      expect(off.finished).toBe(true);
      expect(zero.finished).toBe(true);
      // the mutation: agendas present, but pulling nothing, is the season as it was before the decisions read goals (and the hidden reason record is the only difference)
      expect(outcome(liveOf(zero.s))).toBe(outcome(liveOf(off.s)));
      const noReasons = (l: Live): string => JSON.stringify({ ...l, agendas: undefined, statedReasons: undefined, moodCauses: undefined });
      expect(noReasons(liveOf(zero.s))).toBe(noReasons(liveOf(off.s)));
      expect(liveOf(off.s).agendas).toBeUndefined();
      expect(Object.keys(liveOf(on.s).agendas ?? {})).toHaveLength(15);
      // eslint-disable-next-line no-console
      console.log(`ORW-314 report seed ${seed}: pre-wiring winner=${liveOf(off.s).winner} evictions=${liveOf(off.s).evictionOrder.join(",")} | goals-on winner=${liveOf(on.s).winner} evictions=${liveOf(on.s).evictionOrder.join(",")} same=${outcome(liveOf(on.s)) === outcome(liveOf(off.s))}`);
    }
  }, 900_000);

  it("(b) save then restore mid-season gives an identical agenda for every NPC", () => {
    const a = playSeason(7, { stopAtWeek: 3 });
    const before = JSON.parse(JSON.stringify(liveOf(a.s).agendas));
    const core = a.s.snapshot();
    const b = new GameSessionRegistry().sandboxFor(`ag-r-${Math.random()}`).session as GameSessionAdapter;
    b.restore(JSON.parse(JSON.stringify(core)));
    expect(liveOf(b).agendas).toEqual(before);
    expect(Object.keys(before)).toHaveLength(15);
  }, 120_000);

  // (d) Auditor ruling on ORW-312 (2026-11-13): the old criterion ("every NPC has >= 3 resolved goals after 3 weeks") was wrong, not the core - a calm, unthreatened NPC may form no week goal by design. Replaced by
  // three checks that run on EVERY scanned seed, with no seed pinned:
  //  (d1) after each week closes, no week goal formed in a closed week is still active, and every week goal in history carries a resolved status;
  //  (d2) after three weeks the house holds at least 2 resolved goals per houseguest in total (still in plus evicted: every agenda persists);
  //  (d3) an NPC that held a week goal in a closed week has at least one resolved week goal for each such week.
  const D_SEEDS = [1, 2, 3, 5, 7, 11];
  const RESOLVED = new Set(["achieved", "failed", "replaced", "dropped"]);
  it.each(D_SEEDS)("(d1, d2, d3) the weekly goals resolve on seed %i", (seed) => {
    const held: Record<string, Set<number>> = {};
    const problems: string[] = [];
    let prevWeek = 1;
    const r = playSeason(seed, {
      stopAtWeek: 3,
      observe: (live) => {
        const ag = (live as unknown as Live).agendas ?? {};
        for (const [id, a] of Object.entries(ag)) for (const g of a.goals) if (g.horizon === "week") (held[id] ??= new Set()).add(g.formedWeek);
        if (live.week > prevWeek) {                                    // a week just closed
          for (const [id, a] of Object.entries(ag)) {
            for (const g of a.goals) if (g.horizon === "week" && g.formedWeek < live.week) problems.push(`d1: ${id} still holds an active week-${g.formedWeek} goal after that week closed`);
            for (const g of a.history) if (g.horizon === "week" && !RESOLVED.has(g.status)) problems.push(`d1: ${id} has a week goal in history with status ${g.status}`);
          }
          prevWeek = live.week;
        }
      },
    });
    const ag = liveOf(r.s).agendas!;
    const total = Object.values(ag).reduce((n, a) => n + a.history.length, 0);
    if (total < 2 * Object.keys(ag).length) problems.push(`d2: ${total} resolved goals for ${Object.keys(ag).length} houseguests (need ${2 * Object.keys(ag).length})`);
    const closedUpTo = liveOf(r.s).week as unknown as number;
    for (const [id, weeks] of Object.entries(held)) for (const w of weeks) {
      if (w >= closedUpTo) continue;                                  // that week is still open
      if (!ag[id]!.history.some((g) => g.horizon === "week" && g.formedWeek === w)) problems.push(`d3: ${id} held a week-${w} goal but has none resolved for that week`);
    }
    expect(Object.keys(held).length, `seed ${seed}: some houseguest held a week goal (the check is not vacuous)`).toBeGreaterThan(0);
    expect(problems, `seed ${seed}`).toEqual([]);
  }, 400_000);

  it("(c) an agenda never reaches a player-facing or admin projection", () => {
    const r = playSeason(3, { stopAtWeek: 2 });
    const live = liveOf(r.s);
    const token = "SENTINEL-AGENDA-ENDNOTE-312";
    const id = Object.keys(live.agendas!)[0]!;
    live.agendas![id]!.history.push({ id: "planted", owner: id, horizon: "week", kind: "get-them-out", why: [{ kind: "memory", ref: token, weight: 1 }], test: { kind: "survives-week" }, commitment: 1, status: "failed", formedDay: 1, formedWeek: 1, endNote: token });
    const core = r.s.snapshot(); (core.live as unknown as Live).agendas = live.agendas;
    r.s.restore(core);
    expect(JSON.stringify(r.s.snapshot())).toContain(token); // it IS in the engine's own state ...
    const surfaces: unknown[] = [r.s.gameStatus(), r.s.getGameState(), r.s.getMomentPrompt("nominations" as never)];
    for (const v of surfaces) expect(JSON.stringify(v ?? null)).not.toContain(token); // ... and on no surface
    expect(JSON.stringify(surfaces)).not.toMatch(/endNote|"agendas"/);
  }, 120_000);

  it("the save integrity check refuses a save that thins an agenda's history, or drops an agenda", () => {
    const r = playSeason(3, { stopAtWeek: 2 });
    const earlier = r.s.snapshot();
    expect(sessionCoreSupersetViolation(earlier as never, earlier as never)).toBeNull();
    const thinned = JSON.parse(JSON.stringify(earlier)); const id = Object.keys(thinned.live.agendas).find((k) => thinned.live.agendas[k].history.length > 0)!;
    thinned.live.agendas[id].history.pop();
    expect(sessionCoreSupersetViolation(thinned, earlier as never)).toBe("agendas");
    const dropped = JSON.parse(JSON.stringify(earlier)); delete dropped.live.agendas[id];
    expect(sessionCoreSupersetViolation(dropped, earlier as never)).toBe("agendas");
  }, 120_000);

  it("the nightly mull fades a goal that made no progress (and skipping it leaves commitment where it was)", () => {
    const withMull = playSeason(3, { stopAtWeek: 2 });
    const without = playSeason(3, { stopAtWeek: 2, mull: false });
    const sum = (r: ReturnType<typeof playSeason>) => Object.values(liveOf(r.s).agendas!).reduce((t, a) => t + a.history.filter((h) => h.endNote === "gave up").length, 0);
    expect(sum(withMull)).toBeGreaterThan(0);
    expect(sum(without)).toBe(0);
  }, 120_000);
});
