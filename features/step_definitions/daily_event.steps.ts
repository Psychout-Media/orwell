import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld, LiveDay } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import { resolvePending } from "../support/answerPending";

/**
 * 0008 — the daily-event invariant, measured on the LIVE game (audit 2026-10-25: this BDD used to run
 * against `src/engine/schedule.ts`, a shadow scheduler nothing in production imports). Each scenario now
 * plays a real season through the production spine — `advanceGame`/`submitDecision`, with the
 * orchestrator as the commit delegate exactly as `composeRuntime` wires it — and buckets every PUBLIC
 * event the store records by the in-game (week, day) the live status reports. Roles only.
 */

/** The beats that make a day a CEREMONY day (comp, nominations, veto, eviction, finale, twist). */
const CEREMONY_BEAT = /^(hoh-competition|comp-elimination|nominations|veto-|eviction|final-|finale|twist-)/;

function resolve(s: GameSession, p: NonNullable<AdvanceView["pending"]>): AdvanceView | undefined {
  return resolvePending(p, (req) => s.submitDecision(req));
}

/** A day's own ambient "Week N, day D:" house event (houseEvents.ts) — present, but not a ceremony. */
const DAILY_MARKER = /^Week \d+, day \d+: /;

/** Play one full live season and return its days in order, each with its ceremony beats + public events. */
function playLiveSeason(seed: number): LiveDay[] {
  const reg = new GameSessionRegistry();
  const orch = new Orchestrator(reg, { now: () => seed }, { seed, turnDriven: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  const sb = reg.sandboxFor(`daily-event-${seed}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const days: LiveDay[] = [];
  const dayOf = (week: number, day: number): LiveDay => {
    let d = days.find((x) => x.week === week && x.day === day);
    if (!d) { d = { week, day, beats: [], publicEvents: 0, ceremonyEvents: 0, markerEvents: 0 }; days.push(d); }
    return d;
  };
  // Tag every event with the in-game (week, day) the season was on AT THE MOMENT IT WAS RECORDED — one
  // advance or decision can cross a day (a comp crowned on day 1, the next day's house event after), so
  // the status returned afterwards would mis-file part of the batch. Observation only: the wrapper calls
  // the real store unchanged.
  const store = sb.engine.events;
  const record = store.record.bind(store);
  store.record = (e) => {
    const st = sb.session.gameStatus();
    if (st.day != null && !e.hidden) {
      const d = dayOf(st.week, st.day);
      d.publicEvents += 1;
      if (DAILY_MARKER.test(e.content)) d.markerEvents += 1;
      if (e.id.startsWith("season:") && !DAILY_MARKER.test(e.content)) d.ceremonyEvents += 1;
    }
    record(e);
  };
  /** Register every day the season is SEEN on — whether or not anything was recorded — so an eventless
   *  visited day enters the list and fails the no-empty-day check instead of silently vanishing. */
  const visit = (st: AdvanceView["status"]): void => {
    if (st.day != null) dayOf(st.week, st.day);
  };
  /** Each response's ceremony beat, filed under the day it reports (for the reign-order checks). */
  const noteBeat = (v: AdvanceView): void => {
    visit(v.status);
    if (v.event?.beat && v.status.day != null) dayOf(v.status.week, v.status.day).beats.push(v.event.beat);
  };
  for (let i = 0; i < 2000; i++) {
    visit(sb.session.gameStatus());
    const v = sb.session.advanceGame();
    noteBeat(v);
    if (v.pending) {
      const r = resolve(sb.session, v.pending);
      if (r) noteBeat(r);
    }
    if (v.finished) break;
  }
  assert.ok(sb.session.gameStatus().finished, `seed ${seed}: the live season must play to a finale`);
  days.sort((x, y) => x.week - y.week || x.day - y.day);
  return days;
}

const weeksOf = (days: LiveDay[]): LiveDay[][] => {
  const byWeek = new Map<number, LiveDay[]>();
  for (const d of days) byWeek.set(d.week, [...(byWeek.get(d.week) ?? []), d]);
  return [...byWeek.values()];
};
// AMEND 0008 (Ryne-approved 2026-11-04): the day's own ambient "Week N, day D:" marker is recorded EVERY day, so counting it made the invariant unfalsifiable. A day is meaningful only
// if it carries a ceremony beat or a REAL public house event beyond that marker.
const isMeaningful = (d: LiveDay): boolean => d.publicEvents - d.markerEvents > 0 || d.beats.some((b) => CEREMONY_BEAT.test(b));
// A ceremony day carries a public ceremony broadcast (a `season:` event other than the day's own marker)
// or a ceremony beat in a response; a "social day" carries neither.
const isCeremonyDay = (d: LiveDay): boolean => d.ceremonyEvents > 0 || d.beats.some((b) => CEREMONY_BEAT.test(b));

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
  this.liveDays = playLiveSeason(4); // seed 4: a mid-season reign that opens with an HOH comp (week index 1 is a full reign, not the premiere week); a re-pick is EXPECTED after balance changes — re-selected 2026-11-03 (default flip + 0133 on main; was 3): a mid-season reign opens with an HOH comp
  this.liveWeek = weeksOf(this.liveDays)[1]!; // a full mid-season reign (week 1 opens with the premiere)
  const beats = this.liveWeek.flatMap((d) => d.beats);
  const hoh = beats.indexOf("hoh-competition");
  assert.ok(hoh >= 0, "the week's reign has an HOH comp");
  // ORDER, not just presence: the crown comes before any of the reign's ceremonies.
  for (const later of ["nominations", "veto-competition", "veto-ceremony"]) {
    const at = beats.indexOf(later);
    assert.ok(at === -1 || at > hoh, `the HOH comp opens the reign (it came after ${later})`);
  }
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
  this.liveDays = playLiveSeason(7); // seed 7: a season whose weeks include social days, so the cap + "social day still carries a real event" checks have teeth; a re-pick is EXPECTED after balance changes
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

// --- Negative control (AMEND 0008) ---------------------------------------------

Given("a day whose only recorded event is the ambient daily marker", function (this: BbWorld) {
  this.liveDay = { week: 9, day: 2, beats: [], publicEvents: 1, ceremonyEvents: 0, markerEvents: 1 };
});

Then("that day does not count as meaningful", function (this: BbWorld) {
  assert.equal(isMeaningful(this.liveDay!), false, "a day with only the ambient marker must FAIL the daily-event invariant");
});

Then("a day with the marker plus a real public event does count", function (this: BbWorld) {
  assert.equal(isMeaningful({ week: 9, day: 3, beats: [], publicEvents: 2, ceremonyEvents: 0, markerEvents: 1 }), true);
  assert.equal(isMeaningful({ week: 9, day: 4, beats: ["nominations"], publicEvents: 1, ceremonyEvents: 0, markerEvents: 1 }), true, "a ceremony beat alone also counts");
});
