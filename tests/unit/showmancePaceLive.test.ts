import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { GameEvent } from "../../src/domain/event";
import { chemistryKey } from "../../src/engine/attraction";
import { ATTRACTION_LIFE, SHOWMANCE_PACE } from "../../src/engine/attractionLife";
import { sessionCoreSupersetViolation } from "../../src/engine/sessionSnapshot";
import { romancePairKey } from "../../src/engine/heartAgainstGame";

/** ORW-736: the slow build through the session with the days, chemistry and time together SET BY HAND (unit tests; the REAL PATH is tests/uat/realPathShowmancePace.test.ts, ORW-811). Roles only: a pair, a player, bystanders. */
type Live = Record<string, any> & { playedGame?: boolean; active: string[]; dayNumber?: number; nominees?: string[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
type Seam = {
  live: Live;
  seededRels: { ties: unknown[]; showmances: Array<{ a: string; b: string; stage: string }> };
  rel: { edge(a: string, b: string): { affinity: number; trust: number } };
  advanceShowmances(): unknown[];
  setRecordProviders(p: { events: () => GameEvent[]; hidden: () => [] }): void;
  setOnShowmanceSurfaced(fn: (sm: { a: string; b: string }) => void): void;
  setShowmancePacingEnabled(on: boolean): void;
};
let n = 0;
function played(pacing: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(`pace-live-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed: 7 } as never);
  const s = sb.session as unknown as Seam;
  s.live.playedGame = true;
  s.setShowmancePacingEnabled(pacing);
  const events: GameEvent[] = [];
  s.setRecordProviders({ events: () => events, hidden: () => [] });
  const surfaced: Array<{ a: string; b: string }> = [];
  s.setOnShowmanceSurfaced((sm) => surfaced.push(sm));
  const ids = s.live.active.filter((i) => i !== PLAYER);
  return { s, sb, ids, events, surfaced };
}
/** One day for a pair: shared stretches in both directions, then a tick. */
function day(s: Seam, a: string, b: string, d: number, shared: number): void {
  s.live.dayNumber = d;
  const tg = (s.live.together ??= {});
  for (const k of [chemistryKey(a, b), chemistryKey(b, a)]) if (s.live.chemistry![k] !== undefined) tg[k] = (tg[k] ?? 0) + shared * ATTRACTION_LIFE.stretchesPerDay;
  s.advanceShowmances();
}
const setup = (s: Seam, a: string, b: string, chem = 0.9): void => {
  s.live.chemistry = { [chemistryKey(a, b)]: chem, [chemistryKey(b, a)]: chem };
  s.live.together = {};
  for (const id of s.live.active) for (const o of s.live.active) if (id !== o && s.live.chemistry[chemistryKey(id, o)] === undefined && id !== PLAYER && o !== PLAYER) s.live.chemistry[chemistryKey(id, o)] = 0;
};
const watched = (events: GameEvent[], a: string, b: string, by: string[]): void => {
  events.push({ id: `r${events.length}`, ts: events.length, type: "showmance", initiator: a, witnessSet: [a, b], hidden: true, content: "x", baseContent: "x", houseLife: { action: "flirt", seenBy: by } } as never);
};

describe("unit, state set by hand: the slow build, through the played session", () => {
  it("flag off: today's affinity-threshold stages, no pace record (byte-identical path)", () => {
    const { s, ids } = played(false);
    const [a, b] = ids as [string, string];
    s.seededRels.showmances = [{ a, b, stage: "spark" }];
    setup(s, a, b);
    s.rel.edge(a, b).affinity = 0.95; s.rel.edge(b, a).affinity = 0.95;
    s.advanceShowmances();
    expect(s.seededRels.showmances[0]!.stage).toBe("bond"); // the old rule: one tick of high affinity is a stage
    expect(s.live.showmancePace).toBeUndefined();
  });

  it("flag on: the same high affinity and a pile of chemistry on the first day is not a stage", () => {
    const { s, ids } = played(true);
    const [a, b] = ids as [string, string];
    s.seededRels.showmances = [{ a, b, stage: "spark" }];
    setup(s, a, b);
    s.live.dayNumber = 1;
    s.advanceShowmances();
    s.rel.edge(a, b).affinity = 0.95; s.rel.edge(b, a).affinity = 0.95;
    day(s, a, b, 2, 9);
    expect(s.seededRels.showmances[0]!.stage).toBe("spark");
    expect(s.live.showmancePace![romancePairKey(a, b)].level).toBe(0);
  });

  it("builds over weeks: each step needs days, chemistry and the people who caught it; the public couple comes only late, once", () => {
    const { s, ids, events, surfaced } = played(true);
    const [a, b, ...others] = ids as [string, string, ...string[]];
    s.seededRels.showmances = [{ a, b, stage: "spark" }];
    setup(s, a, b);
    s.live.dayNumber = 1;
    s.advanceShowmances();
    const stageByDay: Record<number, string> = {};
    for (let d = 2; d <= 50; d++) {
      if (d === 8) watched(events, a, b, [others[0]!]);
      if (d === 14) for (const o of others.slice(0, Math.ceil(others.length * 0.7))) watched(events, a, b, [o]);
      s.rel.edge(others[0]!, a).affinity = 0.9; // a close ally of one of the pair
      day(s, a, b, d, 0.8);
      stageByDay[d] = s.seededRels.showmances[0]!.stage;
    }
    const rec = s.live.showmancePace![romancePairKey(a, b)];
    expect(rec.steps.map((x: { to: number }) => x.to)).toEqual([1, 2, 3, 4]);
    const lastDay = rec.steps.at(-1)!.day as number;
    expect(lastDay).toBeGreaterThanOrEqual(SHOWMANCE_PACE.publicNotBeforeDay);
    for (let d = 2; d < lastDay; d++) expect(stageByDay[d]).not.toBe("visible");
    expect(stageByDay[50]).toBe("visible");
    expect(surfaced).toHaveLength(1); // the house's noticing is one beat, at the end
    // the noticing steps carry who had caught it at that moment
    expect(rec.steps[1]!.seenBy.length).toBeGreaterThanOrEqual(1);
    expect(rec.steps[3]!.seenBy.length).toBeGreaterThanOrEqual(rec.steps[1]!.seenBy.length);
  });

  it("a pair who spend no time together stall and a crisis holds them; the record keeps its history", () => {
    const { s, ids } = played(true);
    const [a, b] = ids as [string, string];
    s.seededRels.showmances = [{ a, b, stage: "spark" }];
    setup(s, a, b);
    s.live.dayNumber = 1; s.advanceShowmances();
    for (let d = 2; d <= 30; d++) day(s, a, b, d, 0);
    expect(s.seededRels.showmances[0]!.stage).toBe("spark");
    s.live.nominees = [a];
    for (let d = 31; d <= 40; d++) day(s, a, b, d, 1);
    expect(s.live.showmancePace![romancePairKey(a, b)].progress).toBe(0);
  });

  it("the player's own romance runs the same machine with the same minimums, only by the player's own time together; the player's pair is public late and the house's noticing is one beat", () => {
    const L = played(true), N = played(true);
    const [x, y] = N.ids as [string, string];
    const p = L.ids[0]!;
    // an NPC pair and the player's pair, given identical chemistry on the houseguest's side
    N.s.seededRels.showmances = [{ a: x, b: y, stage: "spark" }];
    setup(N.s, x, y, 0.9);
    L.s.live.chemistry = { [chemistryKey(p, PLAYER)]: 0.9 }; L.s.live.together = { [chemistryKey(p, PLAYER)]: 0 };
    L.s.live.romances = { [romancePairKey(p, PLAYER)]: 1 };
    // the player's own first day
    const run = (live: Live, step: (d: number) => void, upTo: number): void => { live.dayNumber = 1; for (let d = 2; d <= upTo; d++) step(d); };
    N.s.live.dayNumber = 1; N.s.advanceShowmances(); L.s.live.dayNumber = 1; L.s.advanceShowmances();
    const everyoneSaw = (events: GameEvent[], a: string, b: string, room: string[]): void => { for (const o of room) watched(events, a, b, [o]); };
    everyoneSaw(N.events, x, y, N.ids.filter((i) => i !== x && i !== y).concat(PLAYER));
    everyoneSaw(L.events, p, PLAYER, L.ids.filter((i) => i !== p));
    for (const o of N.ids.filter((i) => i !== x && i !== y)) N.s.rel.edge(o, x).affinity = 0.9;
    for (const o of L.ids.filter((i) => i !== p)) L.s.rel.edge(o, p).affinity = 0.9;
    run(N.s.live, (d) => day(N.s, x, y, d, 0.8), 50);
    run(L.s.live, (d) => { L.s.live.dayNumber = d; L.s.live.together![chemistryKey(p, PLAYER)] += 0.8 * ATTRACTION_LIFE.stretchesPerDay; L.s.advanceShowmances(); }, 50);
    const npcSteps = N.s.live.showmancePace![romancePairKey(x, y)].steps.map((q: { day: number }) => q.day);
    const playerSteps = L.s.live.showmancePace![romancePairKey(p, PLAYER)].steps.map((q: { day: number }) => q.day);
    expect(playerSteps).toHaveLength(4);
    expect(npcSteps).toHaveLength(4);
    // the same minimums: every gap at least the level's days times that pair's own factor (the spread is keyed per pair)
    const min = SHOWMANCE_PACE.minDays.map((m) => m * (1 - SHOWMANCE_PACE.jitter));
    for (const steps of [npcSteps, playerSteps]) { expect(steps[0]).toBeGreaterThanOrEqual(1 + min[0]!); for (let i = 1; i < 4; i++) expect(steps[i] - steps[i - 1]).toBeGreaterThanOrEqual(min[i]! - 1); expect(steps[3]).toBeGreaterThanOrEqual(SHOWMANCE_PACE.publicNotBeforeDay); }
    expect(L.surfaced).toHaveLength(1);
    // and with no time together the engine never moves the player's romance for them
    const Z = played(true);
    const q = Z.ids[0]!;
    Z.s.live.chemistry = { [chemistryKey(q, PLAYER)]: 0.9 }; Z.s.live.together = { [chemistryKey(q, PLAYER)]: 0 };
    Z.s.live.romances = { [romancePairKey(q, PLAYER)]: 1 };
    Z.s.live.dayNumber = 1; Z.s.advanceShowmances();
    for (let d = 2; d <= 60; d++) { Z.s.live.dayNumber = d; Z.s.advanceShowmances(); }
    expect(Z.s.live.showmancePace![romancePairKey(q, PLAYER)].level).toBe(0);
    expect(Z.surfaced).toHaveLength(0);
  });
});

describe("unit, state set by hand: persistence: the pace record is history", () => {
  it("round-trips through a snapshot, and a save that lost a pair's steps is refused", () => {
    const { s, sb, ids } = played(true);
    const [a, b] = ids as [string, string];
    s.live.showmancePace = { [romancePairKey(a, b)]: { level: 1, progress: 2, since: 5, lastDay: 6, lastTogetherDay: 6, lastShared: 3, steps: [{ day: 5, from: 0, to: 1, seenBy: [] }] } };
    const snap = JSON.parse(JSON.stringify(sb.session.snapshot()));
    const sb2 = new GameSessionRegistry().sandboxFor("pace-live-restore");
    sb2.session.restore(JSON.parse(JSON.stringify(snap)) as never);
    expect((sb2.session as unknown as Seam).live.showmancePace).toEqual(s.live.showmancePace);
    const lost = JSON.parse(JSON.stringify(snap));
    lost.live.showmancePace[romancePairKey(a, b)].steps = [];
    expect(sessionCoreSupersetViolation(lost as never, snap as never)).toBe("showmancePace");
    expect(sessionCoreSupersetViolation(snap as never, snap as never)).toBeNull();
  });
});

describe("unit, state set by hand: the wall: no pace stage, level, progress or step reaches any outward surface", () => {
  it("player projections, the moment prompt and the admin view carry none (positive control: the live state does)", async () => {
    const sb = new GameSessionRegistry().sandboxFor(`pace-wall-${n++}`);
    sb.session.createCharacter({ playerName: "The Player", seed: 21 } as never);
    sb.session.noteMessage({ messageId: "w0" });
    const s = sb.session as unknown as Seam;
    const [a, b] = s.live.active.filter((i) => i !== PLAYER) as [string, string];
    s.live.showmancePace = { [romancePairKey(a, b)]: { level: 3, progress: 6.1234567, since: 4, lastDay: 9, lastTogetherDay: 9, lastShared: 7, steps: [{ day: 4, from: 2, to: 3, seenBy: [a] }] } };
    expect(JSON.stringify(s.live)).toContain("showmancePace"); // positive control
    const surfaces = [
      await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
      await sb.mcp.player.callTool("seasonRecap", {}), await sb.mcp.player.callTool("whereabouts", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {}),
    ];
    const blob = JSON.stringify(surfaces);
    expect(/showmancePace|lastTogetherDay|"progress"\s*:\s*6\.12|"seenBy"/.test(blob)).toBe(false);
    expect(blob.includes("6.1234567")).toBe(false);
  });
});
