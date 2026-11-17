import { describe, it, expect } from "vitest";
import { parsePlayerMeetingCall } from "../../src/engine/meetingCall";
import { PLAYER } from "../../src/domain/ids";

/** Feature 0156 slice 7b: the player calls a house meeting in their own words. Roles only (A, B, C are houseguests). */
const people = [
  { id: "a", names: ["Alpha One", "Alpha"] },
  { id: "b", names: ["Bravo Two", "Bravo"] },
  { id: "c", names: ["Charlie Three", "Charlie"] },
];
const call = (t: string) => parsePlayerMeetingCall(t, people);

describe("parsePlayerMeetingCall", () => {
  it("a bare call has no accused and no claim", () => {
    expect(call("I call a house meeting.")).toEqual({});
    expect(call("Everyone, living room, we need to talk.")).toEqual({});
  });
  it("a call with a named claim yields the accused (the subject) and the claim", () => {
    expect(call("I call a house meeting: Alpha is going after Bravo.")).toEqual({ accused: "a", claim: { kind: "going-after", subject: "a", object: "b" } });
    expect(call("I want to say this in front of everybody: Alpha is going after Bravo!")).toEqual({ accused: "a", claim: { kind: "going-after", subject: "a", object: "b" } });
    expect(call("Everyone, living room. Alpha is going after me.")?.claim).toEqual({ kind: "going-after", subject: "a", object: PLAYER });
  });
  it("covers each claim kind of the fixed set", () => {
    const k = (t: string) => call(`I call a house meeting. ${t}`)?.claim;
    expect(k("Alpha is targeting all of us.")).toEqual({ kind: "targets-you", subject: "a" });
    expect(k("Alpha voted to evict me.")).toEqual({ kind: "voted-to-evict-you", subject: "a" });
    expect(k("Alpha and Bravo have a final two.")).toEqual({ kind: "final-two-with", subject: "a", object: "b" });
    expect(k("Alpha has been talking about Charlie behind their back.")).toEqual({ kind: "talking-about", subject: "a", object: "c" });
    expect(k("Alpha is lying to Bravo.")).toEqual({ kind: "lying-about", subject: "a", object: "b" });
    expect(k("Alpha is lying.")).toEqual({ kind: "lying-about", subject: "a" });
  });
  it("unrelated text, hypotheticals, negations and questions call nothing", () => {
    for (const t of [
      "I go to the kitchen and make a sandwich.",
      "Alpha is going after Bravo.", // a claim with no call
      "I won't call a house meeting.",
      "I will not call a house meeting about Alpha.",
      "What if I called a house meeting?",
      "Should I call a house meeting?",
      "If I call a house meeting, Alpha is going after Bravo.",
      "Maybe I should call a house meeting later.",
      "I don't want to hold a house meeting.",
      "Alpha, we need to talk.", // to one person, not the house
    ]) expect(call(t), t).toBeNull();
  });
  it("a hedged claim next to a real call is not picked up", () => {
    expect(call("I call a house meeting. Maybe Alpha is going after Bravo.")).toEqual({});
  });
  it("garbage in", () => {
    expect(call("")).toBeNull();
    expect(parsePlayerMeetingCall(undefined as unknown as string, people)).toBeNull();
  });
});

describe("ORW-560: a broken word is a lie the player can call the house about", () => {
  it("the live sweep's phrasing and its neighbours name a lying-about claim", () => {
    expect(call("I call a house meeting: Alpha told two people they were safe and then nominated them anyway")).toEqual({ accused: "a", claim: { kind: "lying-about", subject: "a" } });
    expect(call("Everyone, living room. Alpha promised me safety and put me up.")).toEqual({ accused: "a", claim: { kind: "lying-about", subject: "a", object: PLAYER } });
    expect(call("I call a house meeting. Alpha broke her word to Bravo.")).toEqual({ accused: "a", claim: { kind: "lying-about", subject: "a", object: "b" } });
    expect(call("I want to say this in front of everybody: Alpha is a liar.")).toEqual({ accused: "a", claim: { kind: "lying-about", subject: "a" } });
    expect(call("House meeting! Alpha backstabbed Charlie.")).toEqual({ accused: "a", claim: { kind: "lying-about", subject: "a", object: "c" } });
  });
  it("still calls nothing when hedged, asked, or not a call", () => {
    expect(call("Maybe I should call a house meeting: Alpha broke her word.")).toBeNull();
    expect(call("Alpha broke her word.")).toBeNull();
  });
});
