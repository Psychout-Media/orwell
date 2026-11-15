import { describe, it, expect, afterEach, vi } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER_TOOLS, PLAYER_AGENT_LEVERS } from "../../src/surfaces/tools/registry";
import { BASE_GAME_MASTER_PROMPT } from "../../src/engine/momentPrompts";
import { restDeficitForDepth, phaseForHour } from "../../src/engine/timeOfDay";
import { napFactor } from "../../src/engine/liveSeason";
import { hoursUntilDue } from "../../src/engine/daySchedule";
import { NAP } from "../../src/engine/sleepConstants";
import { priv, setup, at, quiet } from "../support/napWorld";
import type { NapView } from "../../src/ports/GameSession";

/**
 * 0148 / ORW-417 - the player's nap, through the REAL session + orchestrator (turn-driven, the live path). Each test places the clock explicitly so the scenarios are exact; roles only, no names.
 * The deficit assertions read the competition's own rest term (`restDeficitOf`, the function the comp fold calls), never a magic number.
 */
type S = GameSessionAdapter;
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
const rest = (s: S): number => priv(s).restDeficitOf("player");
const hourOf = (s: S): number => priv(s).live.nightDepth;
const near = (a: number, b: number): void => expect(a).toBeCloseTo(b, 6);

describe("0148 - the nap lever: the deficit", () => {
  it("2 hours of nap halve the rest term the competition reads; the clock moves by 2 hours", () => {
    const { s } = setup();
    at(s, 8);
    const before = rest(s);
    expect(before).toBeGreaterThan(0);
    const r = s.nap({ hours: 2 });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    near(r.slept, 2);
    near(hourOf(s), 10);
    near(rest(s), before / 2);
  });
  it("2 + 2 hours make a quarter and it is never zero; 1 hour is ~71%", () => {
    const { s } = setup();
    at(s, 8);
    const before = rest(s);
    s.nap({ hours: 2 }); s.nap({ hours: 2 });
    near(rest(s), before / 4);
    expect(rest(s)).toBeGreaterThan(0);
    at(s, 8);
    s.nap({ hours: 1 });
    near(rest(s) / before, Math.SQRT1_2);
    expect(rest(s)).toBeGreaterThan(before / 2);
    expect(rest(s)).toBeLessThan(before);
    expect(napFactor(60)).toBeGreaterThan(0); // never reaches zero, however long
  });
  it("a night in bed resets the nap credit with the night (turnIn): the same bed gives the same rest term with or without the earlier nap", () => {
    const night = (nap: boolean): { rest: number; credit: number | undefined } => {
      const { s } = setup();
      at(s, 8);
      if (nap) s.nap({ hours: 2 });
      const l = priv(s).live; l.nightDepth = 26; l.timeOfDay = phaseForHour(26);
      s.turnIn();
      return { rest: rest(s), credit: priv(s).live.napHoursToday };
    };
    const napped = night(true), control = night(false);
    expect(napped.credit ?? 0).toBe(0);
    near(napped.rest, control.rest); // no nap factor carried over into the next day
    expect(napped.rest).toBeGreaterThan(0);
  });
  it("the multi-night meter's own history is not rewritten, but what it feeds today's comp is eased", () => {
    const { s } = setup();
    s.setMultiNightFatigueEnabled(true);
    at(s, 8);
    (priv(s).live as { playerFatigue?: number }).playerFatigue = 0.4;
    const before = rest(s);
    s.nap({ hours: 2 });
    near(rest(s), before / 2);
    expect((priv(s).live as { playerFatigue?: number }).playerFatigue).toBe(0.4);
  });
});

describe("0148 - the nap lever: waking", () => {
  it("a scheduled event comes due mid-nap: the nap ends there, only slept time counts", () => {
    const { s } = setup(3, (x) => (x.getGameState() as { daySchedule?: { due: boolean } }).daySchedule?.due === false && quiet(x) && priv(x).live.beat === "veto-competition");
    const st = s.getGameState() as { daySchedule?: { due: boolean } };
    expect(st.daySchedule?.due).toBe(false);
    // the next milestone's hour: park the clock one hour before it
    const target = (s.getGameState() as { daySchedule?: { minutesUntil?: number } }).daySchedule?.minutesUntil;
    expect(target).toBeDefined();
    const h = hourOf(s);
    const until = h + (target as number) / 60;
    at(s, until - 1);
    if (hourOf(s) < 8) at(s, 8);
    const r = s.nap({ hours: 3 });
    expect(r.ok).toBe(true);
    expect(r.wokenBy).toBe("event");
    near(r.slept, 1);
    near(priv(s).live.napHoursToday!, 1);
    expect((s.getGameState() as { daySchedule?: { due: boolean } }).daySchedule?.due).toBe(true);
    // the slept hours are lived by the house during the nap's own commit, not carried past the event the nap woke for
    expect((s as unknown as { napPendingHours: number }).napPendingHours, "nap hours consumed by the nap's commit").toBe(0);
  });
  it("a failed nap tick (sandbox rolled back to a fresh session) does not wake the player for the ticks after it", () => {
    const { s, orch, reg } = setup();
    at(s, 8);
    type Adv = (user: string, trigger: string, opts?: unknown) => unknown;
    const o = orch as unknown as { advance: Adv };
    const orig = o.advance.bind(orch);
    const asleepAtTick: boolean[] = [];
    let ticks = 0;
    o.advance = (user, trigger, opts) => {
      if (trigger !== "offscreen-tick") return orig(user, trigger, opts);
      asleepAtTick.push((reg.sandboxFor(user).session as unknown as { napAsleep: boolean }).napAsleep);
      const out = orig(user, trigger, opts);
      if (ticks++ === 0) reg.restore(user, reg.snapshot(user)); // what a faulted tick does: a fresh session built from the baseline
      return out;
    };
    s.nap({ hours: 3 });
    expect(asleepAtTick.length, "the nap lives more than one tick").toBeGreaterThan(1);
    expect(asleepAtTick.every(Boolean), "the player is out of the awake set on every nap tick, before and after the rollback").toBe(true);
    expect((reg.sandboxFor("u").session as unknown as { napAsleep: boolean }).napAsleep, "and awake again afterwards").toBe(false);
  });
  it("a nap steps to the event's exact hour: a wake 0.03h before it sleeps 0.03h, not a whole 0.1h step", () => {
    const { s } = setup(3, (x) => (x.getGameState() as { daySchedule?: { due: boolean } }).daySchedule?.due === false && quiet(x) && priv(x).live.beat === "veto-competition");
    const l = priv(s).live;
    const exactDue = l.nightDepth + hoursUntilDue(l as unknown as Parameters<typeof hoursUntilDue>[0])!;
    at(s, exactDue - 0.03);
    const r = s.nap({ hours: 3 });
    expect(r.wokenBy).toBe("event");
    near(r.slept, 0.03);
    near(hourOf(s), exactDue);
  });
  it("a nap never runs into the night: cut at the start of the evening, the night has not ended", () => {
    const { s } = setup(3, (x) => quiet(x) && ["nominations", "veto-ceremony", "eviction"].includes(priv(x).live.beat!));
    at(s, 15);
    const day = priv(s).live.dayNumber;
    const r = s.nap({ hours: 3 });
    expect(r).toMatchObject({ ok: true, wokenBy: "evening", timeOfDay: "evening" });
    near(r.slept, 1);
    near(hourOf(s), 16);
    expect(priv(s).live.dayNumber).toBe(day);
    expect(priv(s).live.playerRetired).toBe(false);
    expect(priv(s).live.lastSleepDepth).toBe(28); // only a bed re-stamps the night
  });
  it("the player sleeps in their own bedroom (the HOH room when they hold the crown)", () => {
    const { s } = setup();
    at(s, 8);
    s.nap({ hours: 1 });
    expect(["bedroom-a", "bedroom-b", "bedroom-c", "hoh-room"]).toContain(priv(s).presence.get("player"));
  });
});

describe("0148 - the nap lever: refusals leave the clock unmoved", () => {
  const unchanged = (s: S, run: () => NapView, reason: string): void => {
    const hour = hourOf(s); const seq = s.getGameState().beatSeq; const credit = priv(s).live.napHoursToday;
    const r = run();
    expect(r).toMatchObject({ ok: false, reason });
    expect(typeof r.why).toBe("string");
    expect(hourOf(s)).toBe(hour);
    expect(s.getGameState().beatSeq).toBe(seq);
    expect(priv(s).live.napHoursToday).toBe(credit);
  };
  it("the evening", () => { const { s } = setup(); at(s, 17); unchanged(s, () => s.nap({ hours: 1 }), "evening"); });
  it("a competition in session", () => {
    const { s } = setup(); at(s, 9);
    priv(s).live.competition = { comp: "hoh-competition", field: ["x"] };
    unchanged(s, () => s.nap({ hours: 1 }), "event-in-session");
  });
  it("a decision waiting on the player", () => {
    const { s } = setup(); at(s, 9);
    priv(s).live.pending = { kind: "comp-intent" };
    unchanged(s, () => s.nap({ hours: 1 }), "decision-pending");
  });
  it("the premiere", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("pre").session;
    s.createCharacter({ playerName: "The Player", seed: 4 }); s.setPerConversationClockEnabled(true);
    s.noteMessage({ messageId: "m" });
    unchanged(s, () => s.nap({ hours: 1 }), "premiere");
  });
  it("an event that is due right now", () => {
    // Build the due state directly (no seed search): a quiet day-3+ morning world parked on a milestone beat, the clock set to that milestone's own hour.
    const { s } = setup(3, (x) => (x.getGameState() as { daySchedule?: { due: boolean } }).daySchedule?.due === false && quiet(x) && priv(x).live.beat === "veto-competition");
    const l = priv(s).live;
    const exactDue = l.nightDepth + hoursUntilDue(l as unknown as Parameters<typeof hoursUntilDue>[0])!;
    l.nightDepth = exactDue; l.timeOfDay = phaseForHour(exactDue); // the milestone's hour: due, and still before the evening
    expect(["morning", "afternoon"], "setup reached a nap-eligible phase").toContain(l.timeOfDay);
    expect((s.getGameState() as { daySchedule?: { due: boolean } }).daySchedule?.due, "the engine reads this state as event-due").toBe(true);
    unchanged(s, () => s.nap({ hours: 1 }), "event-due");
  });
  it("the flag off: refused as not available, nothing changes", () => {
    const { s } = setup(); at(s, 9);
    s.setNapEnabled(false);
    unchanged(s, () => s.nap({ hours: 1 }), "not-available");
  });
});

describe("0148 - the nap lever: length, idempotency, beatSeq", () => {
  it("length is rounded to 30-minute steps within 0.5-3h, default 1h", () => {
    for (const [asked, slept] of [[undefined, 1], [0.1, 0.5], [0.7, 0.5], [1.3, 1.5], [9, 3], [2.25, 2.5]] as const) {
      const { s } = setup(); at(s, 8);
      near(s.nap(asked === undefined ? {} : { hours: asked }).slept, slept);
    }
    expect(NAP.minHours).toBe(0.5); expect(NAP.maxHours).toBe(3);
  });
  it("an idempotencyKey replays the same nap instead of sleeping twice", () => {
    const { s } = setup(); at(s, 8);
    const a = s.nap({ hours: 1, idempotencyKey: "k1" });
    const h = hourOf(s);
    const b = s.nap({ hours: 1, idempotencyKey: "k1" });
    expect(b).toEqual(a);
    expect(hourOf(s)).toBe(h);
    expect(priv(s).live.napHoursToday).toBe(1);
  });
  it("a stale expectedBeatSeq is refused before any change", () => {
    const { s } = setup(); at(s, 8);
    expect(() => s.nap({ hours: 1, expectedBeatSeq: -5 })).toThrow();
    expect(hourOf(s)).toBe(8);
  });
});

describe("0148 - the house lives it, unseen; houseguests see it; nobody else naps", () => {
  it("off-screen house life ticks over the slept span, hidden, with no player in any witness set, and the player learns nothing", () => {
    const { s, sb, orch } = setup(); at(s, 8);
    const spy = vi.spyOn(orch, "advance");
    const eventsBefore = sb.engine.events.count();
    const knownBefore = sb.engine.knowledge.knownTo("player").length;
    s.nap({ hours: 3 });
    const ticks = spy.mock.calls.filter((c) => c[1] === "offscreen-tick").length;
    expect(ticks).toBeGreaterThanOrEqual(2); // one tick per SOCIETY_TICK_HOURS slept
    const fresh = sb.engine.events.queryAll().slice(eventsBefore);
    const offscreen = fresh.filter((e) => e.hidden);
    expect(offscreen.length).toBeGreaterThan(0);
    for (const e of offscreen) expect(e.witnessSet).not.toContain("player");
    expect(sb.engine.knowledge.knownTo("player").length).toBe(knownBefore);
  });
  it("a houseguest in the player's room witnesses the nap as a public fact; one who never saw it holds none", () => {
    const { s, sb } = setup(); at(s, 8);
    // put one awake houseguest in the room the player will sleep in, another far away
    const npcs = [...priv(s).presence.keys()].filter((id) => id !== "player");
    const room = (() => { s.nap({ hours: 0.5 }); return priv(s).presence.get("player")!; })();
    at(s, 8);
    const [watcher, away] = npcs;
    priv(s).presence.set(watcher!, room);
    priv(s).presence.set(away!, "kitchen");
    const before = sb.engine.events.count();
    s.nap({ hours: 1 });
    const napEvents = sb.engine.events.queryAll().slice(before).filter((e) => /was napping/.test(e.content));
    expect(napEvents).toHaveLength(1);
    expect(napEvents[0]!.hidden).toBe(false);
    expect(napEvents[0]!.witnessSet).toContain(watcher);
    expect(napEvents[0]!.witnessSet).not.toContain(away);
  });
  it("the next moment prompt carries a one-shot WHILE YOU SLEPT read, with no number and no clock time", () => {
    const { s } = setup(); at(s, 8);
    s.nap({ hours: 2 });
    const first = s.getMomentPrompt({}).systemPrompt;
    expect(first).toMatch(/- WHILE YOU SLEPT \(voice only/);
    expect(first).toMatch(/woke from a nap/);
    expect(s.getMomentPrompt({}).systemPrompt).not.toMatch(/- WHILE YOU SLEPT \(voice only/); // consumed once
  });
  it("no houseguest ever naps: napHoursToday is the PLAYER's alone and no NPC rest deficit reads it", () => {
    const { s } = setup(); at(s, 8);
    const npc = [...priv(s).presence.keys()].find((id) => id !== "player")!;
    const before = priv(s).restDeficitOf(npc);
    s.nap({ hours: 3 });
    expect(priv(s).restDeficitOf(npc)).toBe(before);
  });
  it("the deficit never reaches a player-facing view (no rest number / nap factor anywhere in the state or the prompt)", () => {
    const { s } = setup(); at(s, 8);
    const r = s.nap({ hours: 2 });
    const surface = JSON.stringify([r, s.getGameState(), s.getMomentPrompt({}).systemPrompt]);
    expect(surface).not.toMatch(/napHoursToday|napFactor|restDeficit|deficit/i);
  });
});

describe("0148 - persistence and the boundary", () => {
  it("napHoursToday survives a snapshot/restore", () => {
    const { s } = setup(); at(s, 8);
    s.nap({ hours: 2 });
    const snap = s.snapshot();
    const t = new GameSessionRegistry().sandboxFor("restore").session;
    t.restore(snap as unknown as Parameters<S["restore"]>[0]);
    expect(priv(t).live.napHoursToday).toBe(2);
    near(rest(t as S), restDeficitForDepth(28) / 2);
  });
  it("is a player tool, advertised in the prompt manifest, and dispatches through McpServer.callTool (guards + dispatch)", async () => {
    expect(PLAYER_TOOLS.map((t) => t.name)).toContain("nap");
    expect(PLAYER_AGENT_LEVERS).toContain("nap");
    expect(BASE_GAME_MASTER_PROMPT).toMatch(/•\s+nap\s+—/);
    const { s, sb } = setup(); at(s, 8);
    const res = (await sb.mcp.player.callTool("nap", { hours: 2, idempotencyKey: "mcp-1" })) as NapView;
    expect(res.ok).toBe(true);
    near(res.slept, 2);
    expect(priv(s).live.napHoursToday).toBe(2);
    await expect(sb.mcp.player.callTool("nap", { hours: "two" })).rejects.toThrow();
    await expect(sb.mcp.player.callTool("nap", { idempotencyKey: 5 })).rejects.toThrow();
  });
  it("the admin channel does not carry it", () => {
    const sb = new GameSessionRegistry().sandboxFor("adm");
    return expect(sb.mcp.admin.callTool("nap", {})).rejects.toThrow();
  });
});

describe("0148 - the narrator's NAP line costs the fixed prompt nothing", () => {
  it("the NAP instruction is in the narrator's context only while a nap is open (morning yes, evening no); the fixed prompt names the lever in one line", () => {
    const { s } = setup();
    at(s, 9);
    expect(s.getMomentPrompt({}).systemPrompt).toContain("- NAP (open now):");
    at(s, 18);
    expect(s.getMomentPrompt({}).systemPrompt).not.toContain("- NAP (open now):");
    s.setNapEnabled(false); at(s, 9);
    expect(s.getMomentPrompt({}).systemPrompt).not.toContain("- NAP (open now):");
    expect(BASE_GAME_MASTER_PROMPT).not.toContain("call nap {hours}"); // the how-to rides the per-turn line, not the fixed prompt
  });
});
