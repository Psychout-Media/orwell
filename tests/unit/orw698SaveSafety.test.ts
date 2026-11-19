import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { sessionCoreSupersetViolation } from "../../src/engine/sessionSnapshot";

/** ORW-698 (B2-11 + B2-12). Roles only: a speaker, two listeners, a believer. */
type Live = Record<string, unknown> & { playedGame?: boolean; week: number; finished?: boolean };
type Seam = {
  live: Live;
  habitSightings: Array<{ pair: [string, string]; room: string; onlookers: string[] }>;
  roomCardNow: { msg?: string; room: string } | null;
  noteRoomEntry(room: string): void;
  roomCardView(room: string, present: unknown[]): { roomCard?: unknown };
  secretBreakTick(k: unknown): void;
  livingIds(): string[];
  buildReunionView(): { threads: Array<{ kind: string; said?: string; listener?: string }> } | undefined;
};
const seam = (s: unknown): Seam => s as Seam;
function played(name: string, seed = 7) {
  const sb = new GameSessionRegistry().sandboxFor(name);
  sb.session.createCharacter({ playerName: "The Player", seed });
  seam(sb.session).live.playedGame = true;
  return sb;
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
function restored(name: string, snap: unknown) {
  const sb = new GameSessionRegistry().sandboxFor(name);
  sb.session.restore(clone(snap) as never);
  return sb;
}

describe("B2-11: the engine-only stores are guarded as a superset (only what is monotone)", () => {
  const snap = () => {
    const sb = played("orw698-guard");
    const live = seam(sb.session).live as Record<string, unknown>;
    live.routines = { a: [{ k: 1 }, { k: 2 }] };
    live.routineSightings = { a: { r1: [1, 2] } };
    live.chemistry = { "chem:a>b": 0.4 };
    live.together = { "chem:a>b": 3 };
    live.romances = { "a|b": 2 };
    live.breakups = ["a|b"];
    live.diaryCalls = { seen: [{ at: 1 }], byDay: { "1": 1 } };
    live.leveragePlays = [{ id: "lp1", status: "open" }];
    live.viewOfPlayer = { a: [{ week: 1, trust: 0.1, affinity: 0.1 }] };
    live.returners = { a: { season: 1, seasonsAgo: 1, placement: 2, juror: false } };
    live.bedRush = { tick: 3, plan: {}, log: [{ tick: 1, who: "a", room: "bedroom" }], done: false };
    live.secretBreakDay = 4;
    return clone(sb.session.snapshot()) as unknown as { live: Record<string, unknown> };
  };
  it("growth and ordinary change pass (a play closing, a week's sample overwritten, a call ending)", () => {
    const before = snap(), after = clone(before);
    (after.live.routines as Record<string, unknown[]>).a!.push({ k: 3 });
    (after.live.leveragePlays as Array<{ status: string }>)[0]!.status = "complied";
    (after.live.viewOfPlayer as Record<string, Array<{ trust: number }>>).a![0]!.trust = 0.3;
    (after.live.diaryCalls as { byDay: Record<string, number> }).byDay = {};
    (after.live.bedRush as { done: boolean; log: unknown[]; tick: number }).done = true;
    (after.live.bedRush as { log: unknown[] }).log.push({ tick: 4, who: "b", room: "bedroom" });
    (after.live.bedRush as { tick: number }).tick = 4;
    (after.live.together as Record<string, number>)["chem:a>b"] = 5;
    after.live.secretBreakDay = 5;
    expect(sessionCoreSupersetViolation(after as never, before as never)).toBeNull();
  });
  it.each([
    ["routines", (l: Record<string, unknown>) => { delete l.routines; }],
    ["routineSightings", (l: Record<string, unknown>) => { (l.routineSightings as Record<string, Record<string, number[]>>).a!.r1 = [1]; }],
    ["chemistry", (l: Record<string, unknown>) => { delete l.chemistry; }],
    ["together", (l: Record<string, unknown>) => { (l.together as Record<string, number>)["chem:a>b"] = 1; }],
    ["romances", (l: Record<string, unknown>) => { delete l.romances; }],
    ["breakups", (l: Record<string, unknown>) => { l.breakups = []; }],
    ["diaryCalls", (l: Record<string, unknown>) => { (l.diaryCalls as { seen: unknown[] }).seen = []; }],
    ["leveragePlays", (l: Record<string, unknown>) => { l.leveragePlays = []; }],
    ["viewOfPlayer", (l: Record<string, unknown>) => { l.viewOfPlayer = {}; }],
    ["returners", (l: Record<string, unknown>) => { delete l.returners; }],
    ["bedRush", (l: Record<string, unknown>) => { (l.bedRush as { log: unknown[] }).log = []; }],
    ["secretBreakDay", (l: Record<string, unknown>) => { delete l.secretBreakDay; }],
  ])("a save that lost %s is refused", (name, lose) => {
    const before = snap(), after = clone(before);
    lose(after.live);
    expect(sessionCoreSupersetViolation(after as never, before as never)).toBe(name);
  });
});

describe("B2-12: one-shots survive a restart (act, snapshot, restore: not repeated or rerolled)", () => {
  it("the nightly secret-break pass does not run again the same night after a restore; an old save loads as not run", () => {
    const sb = played("orw698-break");
    const s = seam(sb.session);
    (s as unknown as { onPlayerEvent: unknown }).onPlayerEvent = () => "ev";
    const calls = { n: 0 };
    const orig = s.livingIds.bind(s);
    const knowledge = { knownTo: () => [] };
    s.secretBreakTick(knowledge);
    expect(typeof s.live.secretBreakDay).toBe("number");
    const snap = clone(sb.session.snapshot()) as unknown;
    const spyOn = (x: Seam) => { (x as unknown as { onPlayerEvent: unknown }).onPlayerEvent = () => "ev"; const o = x.livingIds.bind(x); x.livingIds = () => { calls.n++; return o(); }; };
    const r = seam(restored("orw698-break-r", snap).session);
    spyOn(r); r.secretBreakTick(knowledge);
    expect(calls.n).toBe(0);
    const old = clone(snap) as unknown as { live: Record<string, unknown> }; delete old.live.secretBreakDay;
    const r2 = seam(restored("orw698-break-old", old).session);
    spyOn(r2); r2.secretBreakTick(knowledge);
    expect(calls.n).toBeGreaterThan(0);
    void orig;
  });
  it("a first-time room card pending on the turn is still there after a restore", () => {
    const sb = played("orw698-card");
    const s = seam(sb.session);
    s.live.houseTour = { seen: [] };
    s.noteRoomEntry("kitchen");
    expect(s.roomCardView("kitchen", []).roomCard).toBeDefined();
    const snap = clone(sb.session.snapshot()) as unknown;
    const r = seam(restored("orw698-card-r", snap).session);
    expect(r.roomCardView("kitchen", []).roomCard).toBeDefined();
    expect((r.live.houseTour as { seen: string[] }).seen).toEqual(["kitchen"]); // and the room is not offered a second time
    r.roomCardNow = null; r.noteRoomEntry("kitchen");
    expect(r.roomCardView("kitchen", []).roomCard).toBeUndefined();
  });
  it("habit scenes waiting for the calm tick's whisper survive a restore", () => {
    const sb = played("orw698-habit");
    const s = seam(sb.session);
    const ids = sb.session.livingIds().filter((id) => id !== PLAYER);
    s.habitSightings = [{ pair: [ids[0]!, ids[1]!], room: "kitchen", onlookers: [ids[2]!] }];
    const snap = clone(sb.session.snapshot()) as unknown;
    const r = seam(restored("orw698-habit-r", snap).session);
    expect(r.habitSightings).toEqual(s.habitSightings);
    const old = clone(snap) as unknown as Record<string, unknown>; delete old.habitSightings;
    expect(seam(restored("orw698-habit-old", old).session).habitSightings).toEqual([]);
  });
});

describe("B2-12: the reunion's caught is per claim, not per listener and speaker", () => {
  it("a second lie by the same speaker to the same listener is not listed as caught because the first one was", () => {
    const sb = played("orw698-reunion");
    const s = seam(sb.session);
    const [sp, li] = sb.session.livingIds().filter((id) => id !== PLAYER);
    const base = { speaker: sp!, listener: li!, kind: "allied-with", subject: sp!, isTrue: false, week: 1 };
    s.live.finished = true;
    s.live.claims = { seq: 2, items: [{ id: "claim:1", ...base }, { id: "claim:2", ...base, week: 2 }] };
    // the listener caught the speaker over claim 1 only: that telling's belief is taken back and the lie is held against the speaker
    s.live.beliefs = { [li!]: [
      { id: `${li}|heard-rumor|x|claim:1`, holder: li!, kind: "heard-rumor", subject: sp!, value: true, origin: "told", confidence: 0.5, week: 1, refuted: true },
      { id: `${li}|lied-to-me|${sp}`, holder: li!, kind: "lied-to-me", subject: sp!, value: true, origin: "told", confidence: 0.8, week: 1 },
    ] };
    const lies = (s.buildReunionView()?.threads ?? []).filter((t) => t.kind === "lie");
    expect(lies.length).toBe(1); // claim 2 still comes out; claim 1 was caught
  });
});
