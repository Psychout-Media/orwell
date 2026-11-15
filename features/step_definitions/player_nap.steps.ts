import { Given, When, Then, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { phaseForHour } from "../../src/engine/timeOfDay";
import { resolvePending } from "../support/answerPending";
import { priv, setup, at } from "../../tests/support/napWorld";
import type { NapView } from "../../src/ports/GameSession";

/**
 * FEATURE 0148 / ORW-417 - the player's nap, stated in Ryne's terms. Every scenario drives the REAL runtime (a played, turn-driven game: a real per-user sandbox + the orchestrator, so the house really lives the
 * slept hours); the rest term is the competition's own (`restDeficitOf`, what the comp fold calls), never a magic number. Roles only.
 */
type W = { n: Record<string, any> };
const n = (w: unknown): Record<string, any> => ((w as W).n ??= {});
After(function () { GameSessionAdapter.setTimeOfDayEnabled(false); });
const rest = (s: GameSessionAdapter): number => priv(s).restDeficitOf("player");
const hourOf = (s: GameSessionAdapter): number => priv(s).live.nightDepth;
const close = (a: number, b: number, msg: string): void => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

// --- the Background ---------------------------------------------------------------------------------------------------
Given("a played game with the in-game clock running", function () {
  Object.assign(n(this), setup(3));
});
Given("the player stayed up until 4am last night", function () {
  at(n(this).s, 8, 28);
  n(this).before = rest(n(this).s);
  assert.ok(n(this).before > 0, "a 4am night leaves a real deficit");
});

// --- the situations -----------------------------------------------------------------------------------------------------
Given("it is the morning", function () { at(n(this).s, 8); });
Given("it is the afternoon", function () { at(n(this).s, 13); });
Given("it is late afternoon, one hour before the evening", function () {
  const c = n(this);
  const g = setup(3, (x) => !priv(x).live.competition && !priv(x).live.ceremony && !priv(x).live.pending && priv(x).live.timeOfDay === "morning" && (priv(x).live.dayNumber ?? 1) >= 3 && priv(x).live.playedGame !== true && ["nominations", "veto-ceremony", "eviction"].includes(priv(x).live.beat!));
  Object.assign(c, g);
  at(g.s, 15);
});
Given("it is the morning of the veto competition, one hour before it is due", function () {
  const c = n(this);
  const g = setup(3, (x) => (x.getGameState() as { daySchedule?: { due: boolean } }).daySchedule?.due === false && !priv(x).live.competition && !priv(x).live.ceremony && !priv(x).live.pending
    && priv(x).live.timeOfDay === "morning" && (priv(x).live.dayNumber ?? 1) >= 3 && priv(x).live.playedGame !== true && priv(x).live.beat === "veto-competition");
  Object.assign(c, g);
  const mins = (g.s.getGameState() as { daySchedule?: { minutesUntil?: number } }).daySchedule?.minutesUntil;
  assert.ok(mins !== undefined, "the veto competition is the next scheduled event");
  at(g.s, hourOf(g.s) + (mins as number) / 60 - 1);
  c.dueHour = hourOf(g.s) + 1;
});
Given("the player napped {int} hours today", function (h: number) {
  const s = n(this).s as GameSessionAdapter;
  at(s, 8);
  s.nap({ hours: h });
  assert.equal(priv(s).live.napHoursToday, h);
});
Given("it is the evening", function () { at(n(this).s, 17); });
Given("a competition is in session", function () { at(n(this).s, 9); priv(n(this).s).live.competition = { comp: "hoh-competition", field: [] }; });
Given("a decision is waiting on the player", function () { at(n(this).s, 9); priv(n(this).s).live.pending = { kind: "comp-intent" }; });
Given("it is the premiere", function () {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const sb = new GameSessionRegistry().sandboxFor("premiere");
  const s = sb.session;
  s.createCharacter({ playerName: "The Player", seed: 4 });
  s.setPerConversationClockEnabled(true);
  s.noteMessage({ messageId: "premiere-0" });
  Object.assign(n(this), { s, sb });
});
Given("the nap feature is off", function () {
  const c = n(this);
  if (!c.s) Object.assign(c, setup(3));
  at(c.s, 9);
  c.s.setNapEnabled(false);
});

// --- the actions --------------------------------------------------------------------------------------------------------------
const doNap = (c: Record<string, any>, h: number): void => {
  c.t0 = hourOf(c.s);
  c.eventsBefore = c.sb?.engine.events.count(); c.knownBefore = c.sb?.engine.knowledge.knownTo("player").length; // the house-life scenarios compare against the moment before
  c.r = c.s.nap({ hours: h }) as NapView;
};
When("the player naps for {int} hours", function (h: number) { doNap(n(this), h); });
When("the player naps for {int} hour", function (h: number) { doNap(n(this), h); });
When("the player naps for {int} hours, wakes, and naps for {int} hours again", function (a: number, b: number) {
  const c = n(this);
  c.t0 = hourOf(c.s);
  c.s.nap({ hours: a });
  c.r = c.s.nap({ hours: b }) as NapView;
});
When("the player tries to nap", function () {
  const c = n(this); const s = c.s as GameSessionAdapter;
  c.t0 = hourOf(s); c.seq = s.getGameState().beatSeq;
  c.r = s.nap({ hours: 1 }) as NapView;
});
When("the player goes to bed at midnight and wakes the next morning", function () {
  const c = n(this); const s = c.s as GameSessionAdapter;
  const l = priv(s).live; l.nightDepth = 24; l.timeOfDay = phaseForHour(24);
  s.turnIn();
});

// --- the outcomes ---------------------------------------------------------------------------------------------------------------
Then("the player's rest term in a competition is half of what it was before the nap", function () { const c = n(this); close(rest(c.s), c.before / 2, "half"); });
Then("the in-game clock has moved on by {int} hours", function (h: number) { const c = n(this); close(hourOf(c.s) - c.t0, h, "clock"); });
Then("the player's rest term is a quarter of what it was before the first nap", function () { const c = n(this); close(rest(c.s), c.before / 4, "quarter"); });
Then("it is still greater than zero", function () { assert.ok(rest(n(this).s) > 0); });
Then("the player's rest term is between half and the full amount it was before the nap", function () {
  const c = n(this); const r = rest(c.s);
  assert.ok(r > c.before / 2 && r < c.before, `${r} not in (${c.before / 2}, ${c.before})`);
});
Then("the player's rest term is what a midnight bedtime gives, with no nap factor carried over", function () {
  const c = n(this); const s = c.s as GameSessionAdapter;
  assert.equal(priv(s).live.napHoursToday ?? 0, 0, "the nap credit reset with the night");
  // the same midnight bed with NO earlier nap gives the identical rest term
  const control = setup(3); at(control.s, 8); const l = priv(control.s).live; l.nightDepth = 24; l.timeOfDay = phaseForHour(24); control.s.turnIn();
  close(rest(s), rest(control.s), "the midnight night");
});
Then("the nap ended when the competition came due, after {int} hour", function (h: number) {
  const c = n(this);
  assert.equal(c.r.wokenBy, "event");
  close(c.r.slept, h, "slept");
  assert.equal((c.s.getGameState() as { daySchedule?: { due: boolean } }).daySchedule?.due, true, "the event is due");
});
Then("only that {int} hour counts toward the deficit", function (h: number) { close(priv(n(this).s).live.napHoursToday!, h, "credit"); });
Then("the competition proceeds with the player in it", function () {
  const c = n(this); const s = c.s as GameSessionAdapter;
  assert.equal(priv(s).live.playerRetired, false, "the player is awake");
  const v = s.advanceGame();
  assert.ok(v.pending || (s.snapshot().live as unknown as { competition?: unknown }).competition !== undefined || (priv(s).live.beat !== undefined), "the competition advanced");
  if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
});
Then("the nap ended at the start of the evening", function () {
  const c = n(this);
  assert.equal(c.r.wokenBy, "evening"); assert.equal(c.r.timeOfDay, "evening"); close(hourOf(c.s), 16, "the evening starts at 16");
});
Then("the night has not ended: only going to bed ends it", function () {
  const l = priv(n(this).s).live;
  assert.equal(l.playerRetired, false); assert.equal(l.lastSleepDepth, 28, "the night's bedtime stamp is untouched");
});
Then("the nap is refused with an in-fiction reason", function () {
  const r = n(this).r as NapView;
  assert.equal(r.ok, false); assert.ok(typeof r.why === "string" && r.why.length > 10, "a reason the narrator can voice");
});
Then("the in-game clock has not moved", function () {
  const c = n(this);
  assert.equal(hourOf(c.s), c.t0); assert.equal(c.s.getGameState().beatSeq, c.seq, "no commit");
});
Then("the nap is refused as not available", function () { const r = n(this).r as NapView; assert.equal(r.ok, false); assert.equal(r.reason, "not-available"); });

// --- the house, unseen ---------------------------------------------------------------------------------------------------------------
Then("off-screen house-life scenes happened during the nap", function () {
  const c = n(this);
  c.fresh = c.sb.engine.events.queryAll().slice(c.eventsBefore);
  c.offscreen = c.fresh.filter((e: { hidden: boolean }) => e.hidden);
  assert.ok(c.offscreen.length > 0, "the house lived while the player slept");
});
Then("every one of them is hidden and has no player in its witness set", function () {
  for (const e of n(this).offscreen as Array<{ witnessSet: string[] }>) assert.ok(!e.witnessSet.includes("player"));
});
Then("the player's knowledge gained nothing from them", function () {
  const c = n(this);
  assert.equal(c.sb.engine.knowledge.knownTo("player").length, c.knownBefore);
});
Given("a houseguest walks into the player's bedroom during the nap", function () {
  const c = n(this); const s = c.s as GameSessionAdapter;
  at(s, 8);
  const others = [...priv(s).presence.keys()].filter((id) => id !== "player");
  s.nap({ hours: 0.5 }); const room = priv(s).presence.get("player")!;
  at(s, 8);
  c.watcher = others[0]; c.away = others[1];
  priv(s).presence.set(c.watcher, room); priv(s).presence.set(c.away, "kitchen");
  const before = c.sb.engine.events.count();
  s.nap({ hours: 1 });
  c.napEvents = c.sb.engine.events.queryAll().slice(before).filter((e: { content: string }) => /was napping/.test(e.content));
});
Then("that houseguest witnessed the player napping, as a public fact", function () {
  const c = n(this);
  assert.equal(c.napEvents.length, 1);
  assert.equal(c.napEvents[0].hidden, false);
  assert.ok(c.napEvents[0].witnessSet.includes(c.watcher));
});
Then("a houseguest who never saw it holds no such fact", function () { const c = n(this); assert.ok(!c.napEvents[0].witnessSet.includes(c.away)); });
Then("no player-facing or admin view carries a rest number or the nap factor", function () {
  const c = n(this); const s = c.s as GameSessionAdapter;
  const surface = JSON.stringify([c.r, s.getGameState(), s.getMomentPrompt({}).systemPrompt]);
  assert.ok(!/napHoursToday|napFactor|restDeficit|deficit/i.test(surface), "no rest number or nap factor on a player-facing view");
  const admin = JSON.stringify(c.sb.admin.inspectNonVaultState ? c.sb.admin.inspectNonVaultState() : {});
  assert.ok(!/napHoursToday|napFactor|restDeficit|deficit/i.test(admin), "none on the admin view either");
});

// --- the house-life + no-NPC + byte-identical scenarios need their own preparation -------------------------------------------------------
Then("no houseguest ever naps", function () {
  const c = n(this);
  for (const e of c.events as Array<{ initiator: string; content: string }>) if (e.initiator !== "player") assert.ok(!/\bnap(s|ped|ping)?\b/i.test(e.content), `an NPC napped: ${e.content}`);
});
When("many afternoons pass in played games", function () {
  const events: unknown[] = [];
  for (const seed of [3, 5, 8]) {
    const g = setup(seed);
    for (let i = 0; i < 40; i++) { g.s.advanceClockPerConversation(); if ((g.s.getGameState() as { daySchedule?: { due: boolean } }).daySchedule?.due) { const v = g.s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void g.s.submitDecision(req)); } }
    events.push(...g.sb.engine.events.queryAll());
    for (const [id] of priv(g.s).presence) if (id !== "player") assert.equal((g.s as unknown as { npcNapHours?: unknown }).npcNapHours, undefined, id);
  }
  n(this).events = events;
});
Then("a headless seeded season is byte-identical to one with the feature on and no nap taken", function () {
  const run = (on: boolean): string => {
    GameSessionAdapter.setTimeOfDayEnabled(false);
    const s = new GameSessionRegistry().sandboxFor(`bi-${on}`).session;
    s.setNapEnabled(on);
    s.createCharacter({ playerName: "The Player", seed: 9 });
    for (let i = 0; i < 80; i++) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); }
    return JSON.stringify(s.snapshot());
  };
  assert.equal(run(false), run(true));
});
