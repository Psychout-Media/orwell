import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { bootPlayed, playNight, nightRows, outcomeFingerprint, type NightRun } from "../../tests/support/longNightDriver";

// Feature 0025 amendment (ORW-652): a double eviction as one long night. Roles only; played sandboxes through the real adapter.
type Any = Record<string, any>;
let session: Any;
let run: NightRun;
let pair: { on: NightRun; off: NightRun } | undefined;
let held: Any | undefined;

Given("long night: a played game with a double eviction armed", function () { session = bootPlayed(5, true); });
When("long night: the double eviction plays out", function () { run = playNight(session); assert.ok(run.fired, "the double eviction fired"); });
Then("long night: both evictions land inside one in-game day", function () {
  const night = nightRows(run);
  const first = run.rows[run.rows.indexOf(night[0]!) - 1]!;
  assert.equal(new Set([first.day, ...night.map((x) => x.day)]).size, 1);
  assert.equal(night[night.length - 1]!.evicted - first.evicted, 1);
});
Then("long night: no schedule or bedtime hold interrupts the second cycle", function () { assert.deepEqual(run.holdsInNight, []); });
Then("long night: the clock only moves forward and the day does not roll", function () {
  const hours = nightRows(run).map((x) => x.hour);
  assert.ok(hours.every((h, i) => i === 0 || h >= hours[i - 1]!));
  assert.ok(hours.every((h) => h < 32));
});

Given("long night: the same seed played with the compression on and off", function () { pair = { on: playNight(bootPlayed(7, true)), off: playNight(bootPlayed(7, false)) }; });
Then("long night: the same houseguests are evicted and crowned either way", function () {
  assert.ok(pair!.on.fired && pair!.off.fired);
  assert.equal(outcomeFingerprint(pair!.on), outcomeFingerprint(pair!.off));
});

Given("long night: a played game partway through the second cycle", function () { session = bootPlayed(7, true); run = playNight(session, (r) => r.twist === "running" && r.beat === "nominations"); assert.equal(run.fired, false); });
When("long night: the player says goodnight", function () { held = session.turnIn().held; });
Then("long night: the bed is refused until the second eviction is done", function () { assert.ok(held, "held"); assert.equal(held!.reason, "ceremony"); });
Then("long night: the narrator is handed one line naming the first evictee, the instant crown and the second eviction", function () {
  const lines = (session.getMomentPrompt({}).systemPrompt as string).split("\n").filter((l) => l.includes("LONG NIGHT"));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /second eviction/);
  assert.match(lines[0]!, /Head of Household/);
});
