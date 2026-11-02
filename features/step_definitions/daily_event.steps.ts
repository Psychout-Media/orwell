import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld, LiveDay } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * 0008 — the daily-event invariant, measured on the LIVE game (audit 2026-10-25: this BDD used to run
 * against `src/engine/schedule.ts`, a shadow scheduler nothing in production imports). Each scenario now
 * plays a real season through the production spine — `advanceGame`/`submitDecision`, with the
 * orchestrator as the commit delegate exactly as `composeRuntime` wires it — and buckets every PUBLIC
 * event the store records by the in-game (week, day) the live status reports. Roles only.
 */

/** The beats that make a day a CEREMONY day (comp, nominations, veto, eviction, finale, twist). */
const CEREMONY_BEAT = /^(hoh-competition|comp-elimination|nominations|veto-|eviction|final-|finale|twist-)/;

function resolve(s: GameSession, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "comp-intent" || p.kind === "comp-round") s.submitDecision({ kind: p.kind, intent: "compete" } as never);
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
}

/** Play one full live season and return its days in order, each with its ceremony beats + public events. */
function playLiveSeason(seed: number): LiveDay[] {
  const reg = new GameSessionRegistry();
  const orch = new Orchestrator(reg, { now: () => seed }, { seed, turnDriven: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  const sb = reg.sandboxFor(`daily-event-${seed}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const days: LiveDay[] = [];
  const dayOf = (week: number, day: number): LiveDay => {
    const last = days[days.length - 1];
    if (last && last.week === week && last.day === day) return last;
    const d: LiveDay = { week, day, beats: [], publicEvents: 0 };
    days.push(d);
    return d;
  };
  let seen = sb.engine.events.queryAll().length;
  const bucket = (v: { status: AdvanceView["status"]; event?: AdvanceView["event"] }): void => {
    const all = sb.engine.events.queryAll();
    const fresh = all.slice(seen);
    seen = all.length;
    // A read with no day yet (the premiere's pre-day, a mid-twist boundary) carries over to the next day.
    if (v.status.day == null) { seen -= fresh.length; return; }
    const d = dayOf(v.status.week, v.status.day);
    d.publicEvents += fresh.filter((e) => !e.hidden).length;
    if (v.event?.beat) d.beats.push(v.event.beat);
  };
  for (let i = 0; i < 2000; i++) {
    const v = sb.session.advanceGame();
    bucket(v);
    if (v.pending) {
      resolve(sb.session, v.pending);
      bucket({ status: sb.session.gameStatus() });
    }
    if (v.finished) break;
  }
  assert.ok(sb.session.gameStatus().finished, `seed ${seed}: the live season must play to a finale`);
  return days;
}

const weeksOf = (days: LiveDay[]): LiveDay[][] => {
  const byWeek = new Map<number, LiveDay[]>();
  for (const d of days) byWeek.set(d.week, [...(byWeek.get(d.week) ?? []), d]);
  return [...byWeek.values()];
};
const isMeaningful = (d: LiveDay): boolean => d.publicEvents > 0;
const isCeremonyDay = (d: LiveDay): boolean => d.beats.some((b) => CEREMONY_BEAT.test(b));

// --- A single completed day ---------------------------------------------------

When("an in-game day completes", function (this: BbWorld) {
  this.liveDays = playLiveSeason(1);
  this.liveDay = this.liveDays[2];
  assert.ok(this.liveDay, "the live season produced completed days");
});

// regex: the step text contains "{...}".
Then(
  /^at least one of \{HOH competition, nominations, veto competition, veto ceremony, eviction, significant house event\} occurred$/,
  function (this: BbWorld) {
    assert.ok(isMeaningful(this.liveDay!), "every completed day must carry a meaningful event");
  },
);

// --- A week is one HOH reign --------------------------------------------------

Given("a week begins with an HOH competition", function (this: BbWorld) {
  this.liveDays = playLiveSeason(3);
  this.liveWeek = weeksOf(this.liveDays)[1]!; // a full mid-season reign (week 1 opens with the premiere)
  assert.ok(this.liveWeek.flatMap((d) => d.beats).includes("hoh-competition"), "the week's reign opens with an HOH comp");
});

When("the week ends", function (this: BbWorld) {
  assert.ok(this.liveWeek && this.liveWeek.length > 0);
});

Then("it ends with an eviction", function (this: BbWorld) {
  const lastDay = this.liveWeek![this.liveWeek!.length - 1]!;
  assert.ok(lastDay.beats.some((b) => b.startsWith("eviction")), `the reign's last day must carry the eviction, got [${lastDay.beats}]`);
});

Then("the number of in-game days in the week may vary", function (this: BbWorld) {
  const n = this.liveWeek!.length;
  assert.ok(n >= 2 && n <= 6, `a week is a ceremony-paced reign of a few days (not a fixed 7), got ${n}`);
});

// --- No empty days over a seeded season ---------------------------------------

Given("a season is simulated with seed {string}", function (this: BbWorld, seed: string) {
  this.liveDays = playLiveSeason(Number(seed));
});

Then("every completed in-game day contains at least one meaningful event", function (this: BbWorld) {
  const empty = this.liveDays!.filter((d) => !isMeaningful(d)).map((d) => `w${d.week}d${d.day}`);
  assert.deepEqual(empty, [], "no live day may be empty");
});

// --- Social-day cap -----------------------------------------------------------

Given("a season is simulated", function (this: BbWorld) {
  this.liveDays = playLiveSeason(7);
});

// regex: the step text contains parentheses.
Then(
  /^no week \(one HOH reign\) contains more than one social day \(a day with no ceremony beat\)$/,
  function (this: BbWorld) {
    for (const week of weeksOf(this.liveDays!)) {
      const social = week.filter((d) => !isCeremonyDay(d)).length;
      assert.ok(social <= 1, `week ${week[0]!.week} had ${social} social days`);
    }
  },
);

Then("many weeks contain none", function (this: BbWorld) {
  const weeks = weeksOf(this.liveDays!);
  const withSocial = weeks.filter((w) => w.some((d) => !isCeremonyDay(d))).length;
  assert.ok(withSocial <= weeks.length / 2, `${withSocial}/${weeks.length} weeks had a social day — should be a minority`);
});

Then("any social day still carries a significant house event", function (this: BbWorld) {
  for (const d of this.liveDays!.filter((x) => !isCeremonyDay(x))) {
    assert.ok(isMeaningful(d), `social day w${d.week}d${d.day} must still carry a significant house event`);
  }
});
