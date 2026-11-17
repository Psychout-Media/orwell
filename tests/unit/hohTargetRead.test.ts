import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { voteChoice } from "../../src/engine/liveSeason";

/**
 * ORW-573 (Fable T1-5): a voter reads the HOH's target from what THEY know - never the HOH's hidden threat numbers. Roles only: the HOH, two nominees (a, b),
 * a voter, a teller. TEST-ONLY seams: the live season (beliefs, stated reasons, the block), the relationship model, the adapter's private read.
 */
type Live = { playedGame?: boolean; week: number; beliefs?: BeliefStore; statedReasons?: unknown[]; nominees?: [string, string]; replacement?: string };
type Seam = { live: Live; rel: { edge(a: string, b: string): { threat: number } }; hohTargetReadOf(v: string, h: string, fn: readonly [string, string]): string };
function house() {
  const sb = new GameSessionRegistry().sandboxFor(`hohread-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", seed: 4 });
  const s = sb.session as unknown as Seam;
  s.live.playedGame = true;
  const [hoh, a, b, voter, teller] = sb.session.livingIds().filter((id) => id !== PLAYER) as [string, string, string, string, string];
  s.live.nominees = [a, b];
  // the HOH's HIDDEN read: a is the far bigger threat to them
  s.rel.edge(hoh, a).threat = 0.95; s.rel.edge(hoh, b).threat = 0.05;
  return { s, hoh, a, b, voter, teller };
}
const said = (week: number, hoh: string, about: string, kind: string) => ({ week, day: 2, decider: hoh, decision: "nominate", public: true, real: { decision: "nominate", decider: hoh, choice: about, terms: [] }, stated: { kind, about, candor: "cover" } });

describe("ORW-573: the voter's read of the HOH's target", () => {
  it("never reads the HOH's hidden threat: with nothing else known, it is the first name called", () => {
    const { s, hoh, a, b, voter } = house();
    s.live.nominees = [b, a]; // b was named first
    expect(s.hohTargetReadOf(voter, hoh, [a, b])).toBe(b); // the hidden read says a
  });
  it("a nominee the HOH publicly called a pawn is not the target", () => {
    const { s, hoh, a, b, voter } = house();
    s.live.statedReasons = [said(s.live.week, hoh, a, "pawn-youll-be-fine")];
    expect(s.hohTargetReadOf(voter, hoh, [a, b])).toBe(b);
  });
  it("a nominee the HOH gave a reason to go is the target", () => {
    const { s, hoh, a, b, voter } = house();
    s.live.nominees = [a, b];
    s.live.statedReasons = [said(s.live.week, hoh, b, "biggest-threat")];
    expect(s.hohTargetReadOf(voter, hoh, [a, b])).toBe(b);
  });
  it("what the voter was told and believes outranks what the HOH said aloud", () => {
    const { s, hoh, a, b, voter, teller } = house();
    s.live.statedReasons = [said(s.live.week, hoh, b, "pawn-youll-be-fine")];
    recordClaim((s.live.beliefs ??= {}), { holder: voter, kind: "heard-rumor", nature: "going-after", subject: hoh, object: b, value: true, origin: "told", source: teller, confidence: 0.85, week: s.live.week });
    expect(s.hohTargetReadOf(voter, hoh, [a, b])).toBe(b);
  });
  it("a replacement named after a veto reads as the real target", () => {
    const { s, hoh, a, b, voter } = house();
    s.live.nominees = [a, b]; s.live.replacement = b;
    expect(s.hohTargetReadOf(voter, hoh, [a, b])).toBe(b);
  });
  it("the vote uses the hook when given, and the hidden read only without it (a headless sim)", () => {
    const { s, hoh, a, b, voter } = house();
    const base = { rel: s.rel } as unknown as Parameters<typeof voteChoice>[2];
    const why: Array<{ options: Array<{ option: string; terms: Array<[string, number]> }> }> = [];
    voteChoice(voter, [a, b], { ...base, hohTargetReadFor: () => b } as never, [], hoh, (w) => why.push(w as never));
    const ref = (o: string) => why[0]!.options.find((x) => x.option === o)!.terms.find(([n]) => n === "hoh-referendum")?.[1] ?? 0;
    expect(Math.abs(ref(b))).toBeGreaterThanOrEqual(Math.abs(ref(a)));
  });
});
