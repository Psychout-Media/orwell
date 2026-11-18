import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { EntityId } from "../../src/domain/ids";
import { TOLD_LEADS, noteToldLead, recentWrongLeads, resolveToldLeads, type ToldLead } from "../../src/engine/toldLeads";

/** Feature 0197 - drives the pure lead record directly. Roles only. Every step carries the "misdirection:" prefix. */
type Bag = { list: ToldLead[]; tick: number };
const bag = (w: unknown): Bag => ((w as { md0197?: Bag }).md0197 ??= { list: [], tick: 1 });
const subject = "subject" as EntityId;
const look = (w: Bag, tick: number, day: number, seen?: string, view?: string): void => {
  resolveToldLeads(w.list, { tick, day, seenRoomOf: (s) => (s === subject ? seen : undefined), roomInView: (r) => r === view });
  w.tick = tick;
};

Given("misdirection: a lead naming a room", function () {
  const w = bag(this);
  noteToldLead(w.list, { key: "k", speaker: "speaker" as EntityId, subject, toldRoom: "kitchen", misled: false, tick: 1, day: 1, part: "morning" });
});
When("misdirection: the player sees the person in that room on the same tick", function () { look(bag(this), 1, 1, "kitchen"); });
When("misdirection: the player sees the person in that room later", function () { look(bag(this), 2, 1, "kitchen"); });
When("misdirection: the player sees the person in another room later", function () { look(bag(this), 2, 1, "backyard"); });
When("misdirection: the player looks into that room later and the person is not there", function () { look(bag(this), 2, 1, undefined, "kitchen"); });
When("misdirection: the player sees the person in another room on a later day", function () { look(bag(this), 2, 2, "backyard"); });
Then("misdirection: the lead is still open", function () { assert.equal(bag(this).list[0]!.status, undefined); });
Then("misdirection: the lead held", function () { assert.equal(bag(this).list[0]!.status, "held"); });
Then("misdirection: the lead was wrong and the other room is noted", function () { const l = bag(this).list[0]!; assert.equal(l.status, "wrong"); assert.equal(l.foundRoom, "backyard"); });
Then("misdirection: the lead was wrong and no other room is noted", function () { const l = bag(this).list[0]!; assert.equal(l.status, "wrong"); assert.equal(l.foundRoom, undefined); });
Then("misdirection: the lead lapsed", function () { assert.equal(bag(this).list[0]!.status, "lapsed"); });
Then("misdirection: the lead shows as found wrong right away", function () { const w = bag(this); assert.equal(recentWrongLeads(w.list, w.tick).length, 1); });
Then("misdirection: the lead no longer shows after the notice window", function () { const w = bag(this); assert.equal(recentWrongLeads(w.list, w.tick + TOLD_LEADS.noticeTicks).length, 0); });
Then("misdirection: the record still holds the lead", function () { assert.equal(bag(this).list.length, 1); });
