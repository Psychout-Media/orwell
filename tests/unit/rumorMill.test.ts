import { describe, it, expect } from "vitest";
import { buildRumorMill } from "../../src/engine/rumorMill";
import { PLAYER } from "../../src/domain/ids";
import type { ClaimLog, SpokenClaim } from "../../src/engine/spokenClaims";

/** 0157 / ORW-525 - the rumor mill's pure ranking rules. Roles only. */
const nameOf = (id: string) => `name-of-${id}`;
let seq = 0;
const claim = (o: Partial<SpokenClaim> & Pick<SpokenClaim, "speaker" | "listener" | "subject">): SpokenClaim =>
  ({ id: `claim:${++seq}`, kind: "voted-to-evict-you", week: 1, isTrue: false, intent: "mislead", origin: "engine", ...o });
const logOf = (items: SpokenClaim[]): ClaimLog => ({ seq: items.length, items });

describe("0157 the rumor mill", () => {
  it("no claims, or only true ones: nothing", () => {
    expect(buildRumorMill(undefined, nameOf)).toBeUndefined();
    expect(buildRumorMill(logOf([claim({ speaker: "s", listener: "l", subject: "x", isTrue: true })]), nameOf)).toBeUndefined();
  });
  it("ranks by believers, then tellings, then earliest; true claims never count", () => {
    const m = buildRumorMill(logOf([
      claim({ speaker: "s1", listener: "l1", subject: "a" }),
      claim({ speaker: "s2", listener: "l1", subject: "b", kind: "targets-you" }),
      claim({ speaker: "s2", listener: "l2", subject: "b", kind: "targets-you" }),
      claim({ speaker: "s2", listener: "l3", subject: "b", kind: "targets-you", isTrue: true }),
    ]), nameOf)!;
    expect(m.biggest.map((r) => r.claim)).toEqual(["that name-of-b was targeting them", "that name-of-a voted to evict them"]);
    expect(m.biggest[0]!.believers.map((x) => x.id)).toEqual(["l1", "l2"]);
    expect(m.biggest[0]!.tellings).toBe(2);
  });
  it("the starter is the earliest false claim; only later informers are leaks", () => {
    const m = buildRumorMill(logOf([
      claim({ speaker: "first", listener: "l1", subject: "a" }),
      claim({ speaker: "leaker", listener: "l2", subject: "a", intent: "inform" }),
      claim({ speaker: "pusher", listener: "l3", subject: "a", intent: "recruit" }),
      claim({ speaker: "first", listener: "l4", subject: "a", intent: "inform" }),
    ]), nameOf)!;
    const r = m.biggest[0]!;
    expect(r.starter.id).toBe("first");
    expect(r.passedOn.map((x) => x.id)).toEqual(["leaker"]);
    expect(r.believers.map((x) => x.id)).toEqual(["l1", "l2", "l3", "l4"]);
  });
  it("what the house got wrong about the player; the player listening is toldToYou, not a believer", () => {
    const m = buildRumorMill(logOf([
      claim({ speaker: "s", listener: "l", subject: PLAYER, kind: "going-after", object: "x" }),
      claim({ speaker: "s", listener: PLAYER, subject: PLAYER === "a" ? "b" : "a" }),
    ]), nameOf)!;
    expect(m.aboutYou).toHaveLength(1);
    expect(m.aboutYou[0]!.claim).toBe(`that name-of-${PLAYER} was going after name-of-x`);
    expect(m.biggest.find((r) => r.toldToYou)!.believers).toEqual([]);
  });
  it("caps the list and never mutates the log", () => {
    const items = Array.from({ length: 9 }, (_, i) => claim({ speaker: "s", listener: "l", subject: `x${i}` }));
    const log = logOf(items);
    const before = JSON.stringify(log);
    expect(buildRumorMill(log, nameOf)!.biggest).toHaveLength(5);
    expect(JSON.stringify(log)).toBe(before);
  });
  it("carries no truth, intent or claim id in its output", () => {
    const blob = JSON.stringify(buildRumorMill(logOf([claim({ speaker: "s", listener: "l", subject: "a" })]), nameOf));
    for (const k of ["claim:", "isTrue", "intent", "mislead"]) expect(blob).not.toContain(k);
  });
});
