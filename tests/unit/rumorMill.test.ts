import { describe, it, expect } from "vitest";
import { buildRumorMill } from "../../src/engine/rumorMill";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefClaim, BeliefStore } from "../../src/engine/beliefStore";
import type { TruthFacts } from "../../src/engine/houseSpeech";
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
  it("words the vote claim kinds", () => {
    const m = buildRumorMill(logOf([
      claim({ speaker: "s", listener: "l", subject: "a", kind: "voted-against", object: "b" }),
      claim({ speaker: "s", listener: "l", subject: "c", kind: "voted-to-keep", object: "d" }),
      claim({ speaker: "s", listener: "l", subject: "e", kind: "voted-against" }),
    ]), nameOf)!;
    expect(m.biggest.map((r) => r.claim).sort()).toEqual([
      "that name-of-a voted to evict name-of-b", "that name-of-c voted to keep name-of-d", "that name-of-e voted to evict them"]);
  });

  describe("beliefs the engine formed other ways, about the player", () => {
    const facts = (o: Partial<TruthFacts> = {}): TruthFacts => ({
      goalAgainst: () => false, votedToEvict: () => false, votedToKeep: () => false, finalTwo: () => false, liedTo: () => false, talkedAbout: () => false, ...o });
    const belief = (o: Partial<BeliefClaim> & Pick<BeliefClaim, "holder" | "kind" | "subject">): BeliefClaim =>
      ({ id: `${o.holder}|${o.kind}|${o.subject}|${o.object ?? ""}|1`, value: true, origin: "deduced", confidence: 0.6, week: 1, ...o });
    const store = (...bs: BeliefClaim[]): BeliefStore => { const s: BeliefStore = {}; for (const b of bs) (s[b.holder] ??= []).push(b); return s; };

    it("a false belief about the player counts, with the holder as believer and the source as starter; same fact held by two merges", () => {
      const m = buildRumorMill(undefined, nameOf, store(
        belief({ holder: "h1", kind: "targets-me", subject: PLAYER, week: 3, source: "src" }),
        belief({ holder: "h2", kind: "heard-rumor", nature: "going-after", subject: PLAYER, object: "h1", week: 2 }),
        belief({ holder: "h3", kind: "heard-rumor", nature: "going-after", subject: PLAYER, object: "h1", week: 4 })), facts())!;
      expect(m.biggest).toEqual([]);
      expect(m.aboutYou.map((r) => r.claim)).toEqual([`that name-of-${PLAYER} was going after name-of-h1`]);
      const merged = m.aboutYou[0]!;
      expect(merged.believers.map((x) => x.id)).toEqual(["h1", "h2", "h3"]);
      expect(merged.starter.id).toBe("src");
      expect(merged.startedWeek).toBe(2);
    });
    it("a belief the engine's records bear out, a refuted one, a held-false one and a non-player subject do not count", () => {
      const m = buildRumorMill(undefined, nameOf, store(
        belief({ holder: "h1", kind: "targets-me", subject: PLAYER }),
        belief({ holder: "h2", kind: "targets-me", subject: PLAYER, refuted: true }),
        belief({ holder: "h3", kind: "targets-me", subject: PLAYER, value: false }),
        belief({ holder: "h4", kind: "targets-me", subject: "x" })), facts({ goalAgainst: (who, t) => who === PLAYER && t === "h1" }));
      expect(m).toBeUndefined();
    });
    it("a player's own beliefs never count; a lie in the claim log and a matching belief merge their believers", () => {
      const log = logOf([claim({ speaker: "s", listener: "l", subject: PLAYER, kind: "going-after", object: "h1" })]);
      const m = buildRumorMill(log, nameOf, store(
        belief({ holder: "h1", kind: "targets-me", subject: PLAYER }),
        belief({ holder: PLAYER, kind: "targets-me", subject: PLAYER })), facts())!;
      expect(m.aboutYou).toHaveLength(1);
      expect(m.aboutYou[0]!.starter.id).toBe("s");
      expect(m.aboutYou[0]!.believers.map((x) => x.id)).toEqual(["h1", "l"]);
    });
    it("no beliefs and no lies: nothing; output carries no truth or ids", () => {
      expect(buildRumorMill(undefined, nameOf, store(), facts())).toBeUndefined();
      const blob = JSON.stringify(buildRumorMill(undefined, nameOf, store(belief({ holder: "h1", kind: "lied-to-me", subject: PLAYER })), facts()));
      for (const k of ["isTrue", "intent", "|lied-to-me", "confidence"]) expect(blob).not.toContain(k);
    });
  });
});
