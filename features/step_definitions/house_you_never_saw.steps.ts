import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { Agenda, Goal } from "../../src/engine/agenda";
import type { StatedReasonRecord } from "../../src/engine/agendaDecisions";
import type { HouseStory } from "../../src/ports/GameSession";
import { playSeason } from "../../tests/support/agendaSeasonDriver";

// ORW-320 (spec 0146 slice 7) - "the house you never saw". HARD rule: roles only.
type Live = { agendas: Record<string, Agenda>; statedReasons?: StatedReasonRecord[]; evictionOrder: string[] };
const liveOf = (s: GameSessionAdapter): Live => (s as unknown as { live: Live }).live;
interface HW extends BbWorld { hs?: GameSessionAdapter; hsStories?: HouseStory[]; hsCon?: string; hsEarly?: string; hsRetro?: unknown }

Given("a live played season", function (this: HW) {
  this.hs = playSeason(3, { stopAtWeek: 2 }).s;
  assert.notEqual((liveOf(this.hs) as unknown as { finished?: boolean }).finished, true);
});

Given("a finished played season with a planted long con and a cover-story reason", function (this: HW) {
  const { s, finished } = playSeason(3);
  assert.ok(finished);
  const l = liveOf(s);
  const ids = Object.keys(l.agendas).sort();
  this.hsEarly = l.evictionOrder[0]!;
  const con = ids.find((i) => i !== this.hsEarly)!;
  const mark = ids.find((i) => i !== this.hsEarly && i !== con)!;
  const goal: Goal = { id: `${con}:season:long-con:${mark}:d2`, owner: con, horizon: "season", kind: "long-con", target: mark, why: [{ kind: "threat-read", about: mark, weight: 1 }],
    test: { kind: "cut-later", who: mark, stage: "jury" }, commitment: 1, status: "achieved", formedDay: 2, formedWeek: 1, resolvedDay: 40 };
  l.agendas[con]!.history.push(goal);
  (l.statedReasons ??= []).push({ week: 2, day: 9, decider: con, decision: "nominate", public: true,
    real: { decision: "nominate", decider: con, choice: mark, goalKind: "long-con", goalId: goal.id, terms: [{ name: "threat", value: 0.7 }], tactic: "direct" },
    stated: { kind: "nothing-personal", about: mark, candor: "cover" } });
  this.hs = s; this.hsCon = con;
  assert.equal(s.recordNpcReflections({ reflections: [{ id: con as never, night: 1, reflection: "I kept smiling and counted the days." }] }).accepted, 1);
});

When("the player opens the retrospective of the played season", function (this: HW) {
  this.hsStories = this.hs!.seasonRetrospective()?.houseYouNeverSaw;
});

When("the player of the played season requests the unsealed story before it is over", function (this: HW) {
  this.hsRetro = this.hs!.seasonRetrospective();
});

Then("nothing of the house is returned", function (this: HW) {
  assert.equal(this.hsRetro, null);
});

Then("a post-crown reflection write is refused and stores nothing", function (this: HW) {
  const r = this.hs!.recordNpcReflections({ reflections: [{ id: Object.keys(liveOf(this.hs!).agendas)[0] as never, night: 1, reflection: "A quiet night." }] });
  assert.deepEqual(r, { accepted: 0, rejected: 1, reason: "not-finished" });
});

Then("every houseguest has a story with their goals in order", function (this: HW) {
  assert.ok(this.hsStories && this.hsStories.length >= 10);
  for (const h of this.hsStories!) assert.ok(h.goals.length > 0);
});

Then("the long con is named and the cover-story reason is marked as a lie beside what was said", function (this: HW) {
  const mine = this.hsStories!.find((h) => h.houseguest.id === this.hsCon)!;
  assert.ok(mine.longCon);
  const lie = mine.decisions.find((d) => d.day === 9 && d.week === 2)!;
  assert.equal(lie.honesty, "lie");
  assert.ok(lie.said.includes("nothing personal"));
  assert.ok(lie.real.includes("goal"));
});

Then("a reflection written after the crown appears with the houseguest's story", function (this: HW) {
  const mine = this.hsStories!.find((h) => h.houseguest.id === this.hsCon)!;
  assert.deepEqual(mine.reflections, [{ night: 1, text: "I kept smiling and counted the days." }]);
});

Then("the first evictee's story holds every goal their agenda ever held", function (this: HW) {
  const ag = liveOf(this.hs!).agendas[this.hsEarly!]!;
  const e = this.hsStories!.find((h) => h.houseguest.id === this.hsEarly)!;
  assert.equal(e.goals.length, ag.history.length + ag.goals.length);
});
