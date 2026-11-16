import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { composeRuntime } from "../../src/composition/runtime";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import { MEETING_RULES, canCallMeeting, decideAnswer, type HouseMeeting, type MeetingAnswer } from "../../src/engine/houseMeeting";
import { claimConfidence, type ClaimLog } from "../../src/engine/spokenClaims";

/**
 * Feature 0156 - house meetings, the engine half (theme 2 slice 7a, ORW-330). Drives the REAL adapter through a per-user registry sandbox. TEST-ONLY seams: the live season (to read the engine-only
 * meetings / claims / beliefs and to set `playedGame`), the relationship model (trust in each side) and the agendas (the engine's own truth for a "going after" claim). Roles only.
 * The shared bag `house0156` is also read by the player-call steps (house_meetings_player.steps.ts): this file owns "a started season with house meetings on" and the accusation Given.
 */
export type Bag = { sb?: UserSandbox; s?: GameSessionAdapter; npcs?: string[]; meeting?: HouseMeeting; trusting?: string; doubting?: string; accuser?: string; accused?: string; victim?: string; nextWeek?: number };
export const bag = (w: unknown): Bag => ((w as { house0156?: Bag }).house0156 ??= {});
type Live = { week: number; dayNumber?: number; playedGame?: boolean; claims?: ClaimLog; beliefs?: Record<string, BeliefClaim[]>; houseMeetings?: HouseMeeting[]; agendas?: Record<string, { goals: Array<Record<string, unknown>> }> };
export const live = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const rel = (s: GameSessionAdapter) => (s as unknown as { rel: { edge(a: string, b: string): { trust: number } } }).rel;
let n = 0;

function fresh(w: unknown, seed = 7): void {
  const sb = new GameSessionRegistry().sandboxFor(`meet0156-${n++}`);
  sb.session.setNpcBeliefsEnabled(true);
  sb.session.setHouseMeetingsEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  live(sb.session).playedGame = true;
  const b = bag(w);
  b.sb = sb; b.s = sb.session; b.meeting = undefined;
  b.npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
  assert.ok(b.npcs.length >= 6, "too few houseguests");
  [b.accuser, b.accused, b.victim, b.trusting, b.doubting] = b.npcs;
}
/** Make the accusation FALSE (the accused holds no goal against the victim), so it can only be denied or redirected. */
function falsify(s: GameSessionAdapter, accused: string, victim: string): void {
  const goals = live(s).agendas?.[accused]?.goals;
  if (goals) for (let g = goals.length - 1; g >= 0; g--) if (goals[g]!.kind === "get-them-out" && goals[g]!.target === victim) goals.splice(g, 1);
}
function setTrust(b: Bag, spec: { trustAccuser: string; trustAccused: string; hi: number; lo: number }): void {
  const r = rel(b.s!);
  for (const l of b.npcs!) { r.edge(l, b.accuser!).trust = 0.5; r.edge(l, b.accused!).trust = 0.5; }
  r.edge(spec.trustAccuser, b.accuser!).trust = spec.hi; r.edge(spec.trustAccuser, b.accused!).trust = spec.lo;
  r.edge(spec.trustAccused, b.accuser!).trust = spec.lo; r.edge(spec.trustAccused, b.accused!).trust = spec.hi;
}
function accuse(w: unknown): HouseMeeting {
  const b = bag(w);
  b.meeting = b.s!.holdHouseMeeting({ caller: b.accuser!, accused: b.accused!, claim: { kind: "going-after", subject: b.accused!, object: b.victim! } });
  assert.ok(b.meeting, "the engine refused a valid house meeting");
  return b.meeting;
}
const beliefOf = (w: unknown, holder: string, claimIds: string[]) => (live(bag(w).s!).beliefs?.[holder] ?? []).find((c) => claimIds.some((id) => c.id.endsWith(`|${id}`)));

Given("a started season with house meetings on", function () { fresh(this); });

Given("an accusation is made against a houseguest in front of the house", function () {
  const b = bag(this);
  if (!b.s) fresh(this);
  const bb = bag(this);
  falsify(bb.s!, bb.accused!, bb.victim!);
  setTrust(bb, { trustAccuser: bb.trusting!, trustAccused: bb.doubting!, hi: 0.95, lo: 0.05 });
});

// ---- Scenario 1 ----

When("the accused answers", function () { accuse(this); });

Then("each houseguest present updates their belief by how much they trust each side", function () {
  const b = bag(this);
  const m = b.meeting!;
  const listeners = m.attendees.filter((id) => id !== PLAYER && id !== m.caller && id !== m.accused);
  assert.ok(listeners.length >= 4, "the house was not gathered");
  for (const l of listeners) assert.ok(beliefOf(this, l, m.claimIds), `${l} holds no belief from the accusation`);
  assert.ok(m.attendees.includes(m.caller) && m.attendees.includes(m.accused));
});

Then("a listener who trusts the accuser more comes out holding the accusation harder, and one who trusts the accused more comes out doubting it", function () {
  const b = bag(this);
  const m = b.meeting!;
  assert.notEqual(m.answer, "admit", "a false accusation cannot be admitted");
  const believer = beliefOf(this, b.trusting!, m.claimIds)!, doubter = beliefOf(this, b.doubting!, m.claimIds)!;
  assert.ok(believer.confidence > claimConfidence(0.95, false) + 0.01 && !believer.refuted, "the believer did not hold the accusation harder");
  assert.equal(doubter.refuted, true, "the doubter did not come out doubting");
  assert.ok(doubter.id.endsWith(`|${m.claimIds.find((id) => doubter.id.endsWith(`|${id}`))}`), "the belief id must stay intact");
  assert.equal(live(b.s!).houseMeetings!.length, 1);
});

// ---- Scenario 2 ----

const sweep = (isTrue: boolean): Set<MeetingAnswer> => {
  const got = new Set<MeetingAnswer>();
  for (let i = 0; i < 100; i++) got.add(decideAnswer({ isTrue, candor: 0.5, cunning: 0.5, roomLean: 0.3, roll: i / 100 }));
  return got;
};
Then("the engine decides the answer from what is true, the accused's candor and how the room stands", function () {
  const admits = (candor: number) => Array.from({ length: 100 }, (_, i) => decideAnswer({ isTrue: true, candor, cunning: 0.4, roomLean: 0, roll: i / 100 })).filter((x) => x === "admit").length;
  assert.ok(admits(1) > admits(0), "candor must matter");
  assert.notEqual(decideAnswer({ isTrue: false, candor: 1, cunning: 0.4, roomLean: 0, roll: 0.05 }), "admit", "truth must matter");
  const redirects = (roomLean: number) => Array.from({ length: 100 }, (_, i) => decideAnswer({ isTrue: false, candor: 0.5, cunning: 0.5, roomLean, roll: i / 100 })).filter((x) => x === "redirect").length;
  const calm = redirects(0), hot = redirects(1);
  assert.ok(hot > calm, "how the room stands must matter");
});
/** The wording "the same inputs always give the same answer" is shared with 0152 (who_told_you.steps.ts), which delegates here when this feature's bag is live. */
(globalThis as { sameAnswer0156?: (w: unknown) => void }).sameAnswer0156 = function (w: unknown): void {
  const mk = () => { fresh(w, 11); const b = bag(w); falsify(b.s!, b.accused!, b.victim!); setTrust(b, { trustAccuser: b.trusting!, trustAccused: b.doubting!, hi: 0.9, lo: 0.1 }); return accuse(w).answer; };
  assert.equal(mk(), mk());
};
Then("a true accusation can be admitted, denied or redirected, and a false one denied or redirected", function () {
  assert.deepEqual([...sweep(true)].sort(), ["admit", "deny", "redirect"]);
  assert.deepEqual([...sweep(false)].sort(), ["deny", "redirect"]);
  // through the adapter: a TRUE accusation the accused admits confirms every listener's belief (the engine's own truth check, a real get-them-out goal)
  for (let seed = 1; seed <= 80; seed++) {
    fresh(this, seed);
    const b = bag(this);
    const agendas = (live(b.s!).agendas ??= {});
    const goals = (agendas[b.accused!] ??= { goals: [] }).goals;
    goals.push({ id: "g-seed", owner: b.accused, horizon: "week", kind: "get-them-out", target: b.victim, why: [], test: { kind: "evicted", who: b.victim }, commitment: 0.9, status: "active", formedDay: 1, formedWeek: live(b.s!).week });
    setTrust(b, { trustAccuser: b.trusting!, trustAccused: b.doubting!, hi: 0.6, lo: 0.4 });
    const m = accuse(this);
    if (m.answer !== "admit") continue;
    for (const l of m.attendees.filter((id) => id !== PLAYER && id !== m.caller && id !== m.accused)) assert.ok(beliefOf(this, l, m.claimIds)!.confidence >= 0.95 && !beliefOf(this, l, m.claimIds)!.refuted, "an admission confirms every listener");
    return;
  }
  assert.fail("no seed produced an admission");
});

// ---- Scenario 3 ----

Given("the accused redirects", function () {
  for (let seed = 1; seed <= 80; seed++) {
    fresh(this, seed);
    const b = bag(this);
    falsify(b.s!, b.accused!, b.victim!);
    setTrust(b, { trustAccuser: b.trusting!, trustAccused: b.doubting!, hi: 0.6, lo: 0.4 });
    const m = accuse(this);
    if (m.answer === "redirect") return;
  }
  assert.fail("no seed produced a redirect");
});
Then("the accused tells the house that the accuser is lying", function () {
  const b = bag(this);
  assert.deepEqual(b.meeting!.redirect, { to: b.accuser });
  const lies = (live(b.s!).claims?.items ?? []).filter((c) => c.speaker === b.accused && c.kind === "lying-about" && c.subject === b.accuser);
  assert.ok(lies.length >= 4, "the accused told too few listeners");
  assert.ok(lies.every((c) => c.intent === "deflect" && c.isTrue === true), "a redirect over a false accusation is true: the accuser did lie");
});
Then("each listener who believes the accused holds that as a claim from the accused", function () {
  const b = bag(this);
  const m = b.meeting!;
  const redirects = (live(b.s!).claims?.items ?? []).filter((c) => c.speaker === b.accused && c.kind === "lying-about");
  for (const c of redirects) {
    const held = (live(b.s!).beliefs?.[c.listener] ?? []).find((x) => x.id.endsWith(`|${c.id}`));
    assert.ok(held, "the listener holds no belief from the redirect");
    assert.equal(held.source, b.accused);
    assert.equal(held.kind, "lied-to-me");
    assert.equal(held.subject, b.accuser);
  }
  assert.ok(m.attendees.length > 4);
  const redirectBelief = (l: string) => (live(b.s!).beliefs?.[l] ?? []).find((x) => redirects.some((c) => c.listener === l && x.id.endsWith(`|${c.id}`)))!;
  assert.ok(!redirectBelief(b.trusting!).refuted === false, "a listener who trusts the accuser more does not keep the accused's counter-charge");
  assert.ok(!redirectBelief(b.doubting!).refuted, "a listener who trusts the accused keeps the counter-charge");
});

// ---- Scenario 4 (NPC half) ----

type Priv = { npcCallsHouseMeeting(): void };
Given("an NPC holds a strong grievance belief about a houseguest", function () {
  fresh(this, 5);
  const b = bag(this);
  const l = live(b.s!);
  l.beliefs = { [b.accuser!]: [{ id: `${b.accuser}|targets-me|${b.accused}|seed`, holder: b.accuser!, kind: "targets-me", subject: b.accused!, object: b.accuser!, value: true, origin: "told", source: b.victim!, confidence: 0.9, week: l.week }] };
});
const callDays = (w: unknown, days: number): number => {
  const b = bag(w), l = live(b.s!);
  const start = l.houseMeetings?.length ?? 0;
  for (let d = 0; d < days; d++) { l.dayNumber = (l.dayNumber ?? 1) + 1; (b.s as unknown as Priv).npcCallsHouseMeeting(); }
  return (l.houseMeetings?.length ?? 0) - start;
};
Then("the NPC can call a house meeting about it, at most once a week", function () {
  const b = bag(this), l = live(b.s!);
  const first = callDays(this, 120);
  assert.equal(first, 1, "exactly one meeting in a week, however many days pass");
  assert.equal(l.houseMeetings![0]!.caller, b.accuser);
  assert.equal(l.houseMeetings![0]!.accused, b.accused);
  l.week += 1; // a new week: the cap is per week
  (l.beliefs![b.accuser!]![0]!).week = l.week; (l.beliefs![b.accuser!]![0]!).refuted = false;
  assert.equal(callDays(this, 120), 1, "the next week allows another");
});
Then("the player can call one by saying so in their own words", function () {
  assert.equal(canCallMeeting("player"), true); // the parser itself is slice 7b; the rule is read here
});
Then("who may call one is decided in one place", function () {
  const b = bag(this), l = live(b.s!);
  const before = MEETING_RULES.callers;
  try {
    MEETING_RULES.callers = "player";
    assert.equal(canCallMeeting("npc"), false);
    l.week += 1; (l.beliefs![b.accuser!]![0]!).week = l.week; (l.beliefs![b.accuser!]![0]!).refuted = false;
    assert.equal(callDays(this, 120), 0, "an NPC may not call when only the player may");
    assert.equal(b.s!.holdHouseMeeting({ caller: b.accuser!, accused: b.accused!, claim: { kind: "going-after", subject: b.accused!, object: b.victim! } }), undefined);
    MEETING_RULES.callers = "npc";
    assert.equal(canCallMeeting("player"), false);
    assert.equal(b.s!.holdHouseMeeting({ caller: PLAYER, accused: b.accused!, claim: { kind: "going-after", subject: b.accused!, object: b.victim! } }), undefined);
  } finally { MEETING_RULES.callers = before; }
});

// ---- Scenario 7: no ballot ----

When("houseguests accuse and answer each other about how they voted", function () {
  fresh(this, 9);
  const b = bag(this);
  accuse(this); // the accusation is a claim, never a ballot
  b.s!.holdHouseMeeting({ caller: b.trusting!, accused: b.doubting!, claim: { kind: "lying-about", subject: b.doubting!, object: b.victim! } });
});
Then("no view shows any houseguest's actual ballot before the retrospective", async function () {
  const b = bag(this);
  const blob = JSON.stringify([
    await b.sb!.mcp.player.callTool("getGameState", {}), await b.sb!.mcp.player.callTool("gameStatus", {}),
    await b.sb!.mcp.player.callTool("getMomentPrompt", {}), await b.sb!.mcp.admin.callTool("inspectNonVaultState", {}),
  ]);
  assert.ok(!/"(?:voters?|voterId|castBy|ballots?ByVoter|unsealed\w*)"\s*:/i.test(blob), "no per-voter attribution on any live surface");
  for (const id of b.meeting!.claimIds) assert.ok(!blob.includes(id), "a meeting's claim ids never ride on a view");
  assert.ok(!/houseMeetings|"attendees"|"playerPresent"/.test(blob), "the engine-only meeting record is never projected");
});

// ---- Scenario: mix and late guards stay neutral ----

type Counts = Record<string, number>;
async function playMix(on: boolean): Promise<{ share: Counts; scenes: number; meetings: number }> {
  const user = `meet-mix`;
  const rt = composeRuntime({ clock: new FakeClock(), seed: 3 });
  const sb = rt.registry.sandboxFor(user);
  sb.session.setHouseMeetingsEnabled(on);
  const mcp = rt.registry.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed: 3, archetype: "floater" });
  for (let i = 0; i < 360; i++) await mcp.callTool("noteMessage", { messageId: `${user}-${i}` });
  const counts: Counts = {}; let scenes = 0;
  for (const e of sb.engine.events.queryAll()) if (e.houseLife) { scenes++; counts[e.type] = (counts[e.type] ?? 0) + 1; }
  const share: Counts = {};
  for (const k of Object.keys(counts)) share[k] = (100 * counts[k]!) / scenes;
  return { share, scenes, meetings: live(sb.session).houseMeetings?.length ?? 0 };
}
When("seeded seasons play with house meetings on", async function () {
  // The shared Then steps ("the week-one house mix stays within the agreed reference", "the late-game guard stays green") are defined once, in what_you_hear.steps.ts, and compare `mix.on` to `mix.off`
  // by equality. Here the two are the same string exactly when every house-life scene share is within 5 points with meetings on vs off and meetings stay rare; otherwise they carry the differing readings.
  const on = await playMix(true), off = await playMix(false);
  assert.ok(on.scenes > 20, "enough scenes to read a mix");
  const kinds = new Set([...Object.keys(on.share), ...Object.keys(off.share)]);
  const within = [...kinds].every((k) => Math.abs((on.share[k] ?? 0) - (off.share[k] ?? 0)) <= 5) && on.meetings <= 3;
  const reading = (r: typeof on) => JSON.stringify({ shares: Object.fromEntries([...kinds].map((k) => [k, +(r.share[k] ?? 0).toFixed(1)])), meetings: r.meetings });
  const hear = ((this as { hear0151?: { mix?: { on: string; off: string } } }).hear0151 ??= {});
  hear.mix = within ? { on: "within", off: "within" } : { on: reading(on), off: reading(off) };
});
