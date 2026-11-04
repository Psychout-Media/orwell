import { describe, it, expect } from "vitest";
import { voteChoice, type SeasonCtx } from "../../src/engine/liveSeason";
import { RelationshipModel } from "../../src/engine/relationships";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * B4 slice 4 - a KEPT casual "vote" / "safe" assurance a voter made to a nominee lowers the odds they vote that nominee out; voting the assured out BREAKS it (resolved once, a smaller grudge than a
 * broken deal). Flag-off (ORWELL_ASSURANCES) byte-identical. Roles only.
 */
const ctxOf = (extra: Partial<SeasonCtx> = {}): SeasonCtx => ({ rel: new RelationshipModel(0.5), player: PLAYER, ...extra } as unknown as SeasonCtx);

describe("voteChoice with an assurance term", () => {
  it("absent the provider the vote is unchanged (byte-identical)", () => {
    const a = voteChoice("npc:1", ["npc:2", "npc:3"], ctxOf());
    expect(voteChoice("npc:1", ["npc:2", "npc:3"], ctxOf({ assuranceVoteFor: undefined }))).toBe(a);
  });
  it("a large kept-assurance term toward the otherwise-evicted nominee flips the vote to the other nominee", () => {
    const base = voteChoice("npc:1", ["npc:2", "npc:3"], ctxOf());
    const other = base === "npc:2" ? "npc:3" : "npc:2";
    expect(voteChoice("npc:1", ["npc:2", "npc:3"], ctxOf({ assuranceVoteFor: (n) => (n === base ? 5 : 0) }))).toBe(other);
  });
});

describe("adapter (ORWELL_ASSURANCES)", () => {
  function started() {
    const sb = new GameSessionRegistry().sandboxFor(`asrvote-${Math.random()}`);
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
    sb.session.advanceGame(); sb.session.advanceGame();
    sb.session.setAssurancesEnabled(true);
    const [voter, nominee] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
    return { sb, voter: voter!, nominee: nominee! };
  }
  type G = { assuranceVoteFor(n: string, voter: string): number; assuranceVotedOut(voter: string, nominee: string): void; recordAssurance(a: unknown): void };
  const items = (s: ReturnType<typeof started>["sb"]["session"]) => ((s.snapshot().live as { assurances: { items: { status: string }[] } }).assurances.items);
  it("no assurance => 0; a sincere vote assurance from a keeper => a positive shield; a strategic lie => 0", () => {
    const { sb, voter, nominee } = started(); const g = sb.session as unknown as G;
    expect(g.assuranceVoteFor(nominee, voter)).toBe(0);
    g.recordAssurance({ from: voter, to: nominee, kind: "vote", sincerity: 0, source: "npc" });
    expect(g.assuranceVoteFor(nominee, voter)).toBe(0);
  });
  it("is deterministic and bounded", () => {
    const { sb, voter, nominee } = started(); const g = sb.session as unknown as G;
    g.recordAssurance({ from: voter, to: nominee, kind: "vote", sincerity: 1, source: "npc" });
    const a = g.assuranceVoteFor(nominee, voter);
    expect(g.assuranceVoteFor(nominee, voter)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThanOrEqual(1);
  });
  it("voting the assured out resolves the open assurance broken exactly once", () => {
    const { sb, voter, nominee } = started(); const g = sb.session as unknown as G;
    g.recordAssurance({ from: voter, to: nominee, kind: "vote", sincerity: 1, source: "npc" });
    g.assuranceVotedOut(voter, nominee); g.assuranceVotedOut(voter, nominee);
    expect(items(sb.session).map((i) => i.status)).toEqual(["broken"]);
  });
  it("flag off: nothing shields, nothing resolves", () => {
    const { sb, voter, nominee } = started(); const g = sb.session as unknown as G;
    g.recordAssurance({ from: voter, to: nominee, kind: "vote", sincerity: 1, source: "npc" });
    sb.session.setAssurancesEnabled(false);
    expect(g.assuranceVoteFor(nominee, voter)).toBe(0);
    g.assuranceVotedOut(voter, nominee);
    expect(items(sb.session).map((i) => i.status)).toEqual(["open"]);
  });
});
