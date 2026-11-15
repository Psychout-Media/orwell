import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { TIE_BEHAVIOR } from "../../src/engine/tieBehavior";

/** ORW-37 half 2 (B41): a pre-show tie's nature shapes DECISIONS between the two people it binds - never competition odds. Roles only. */
type G = { seededRels: { ties: Array<{ a: string; b: string; nature: string }> }; tieNomPushFor(t: string, h: string): number; tieVotePushFor(n: string, v: string): number; setTieBehaviorEnabled(on: boolean): void };
function game() {
  const sb = new GameSessionRegistry().sandboxFor(`tiebeh-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  const g = sb.session as unknown as G; g.seededRels.ties.length = 0;
  const [p, q, r, s] = sb.session.livingIds().filter((i) => i !== PLAYER) as [string, string, string, string];
  return { g, p, q, r, s };
}
describe("tie behavior is wired into the NPC nomination and the eviction vote", () => {
  it("family: the HOH shields their relative in nominations and the voter keeps them; a rival is pushed; an ex / a bare acquaintance moves nothing", () => {
    const { g, p, q, r, s } = game();
    g.seededRels.ties.push({ a: p, b: q, nature: "family" }, { a: p, b: r, nature: "rival" }, { a: p, b: s, nature: "ex" });
    expect(g.tieNomPushFor(q, p)).toBe(TIE_BEHAVIOR.family.nominationPush);
    expect(g.tieNomPushFor(p, q)).toBe(TIE_BEHAVIOR.family.nominationPush); // the tie is mutual
    expect(g.tieNomPushFor(r, p)).toBe(TIE_BEHAVIOR.rival.nominationPush);
    expect(g.tieVotePushFor(q, p)).toBe(TIE_BEHAVIOR.family.votePush);
    expect(g.tieVotePushFor(r, p)).toBe(TIE_BEHAVIOR.rival.votePush);
    expect(g.tieNomPushFor(s, p), "an ex is ambivalence: neither targets nor protects").toBe(0);
    expect(g.tieVotePushFor(s, p)).toBe(0);
    expect(g.tieNomPushFor(r, q), "a houseguest outside the tie is not moved by it").toBe(0);
  });
  it("never the player, never a self-pair, and OFF returns 0", () => {
    const { g, p, q } = game();
    g.seededRels.ties.push({ a: p, b: q, nature: "family" });
    expect(g.tieNomPushFor(PLAYER, p)).toBe(0); expect(g.tieNomPushFor(p, PLAYER)).toBe(0); expect(g.tieNomPushFor(p, p)).toBe(0);
    g.setTieBehaviorEnabled(false);
    expect(g.tieNomPushFor(q, p)).toBe(0); expect(g.tieVotePushFor(q, p)).toBe(0);
  });
  it("wiring pins: the nomination plan and the vote read the providers, the decision matrix lists them, and no competition term exists", () => {
    const live = readFileSync("src/engine/liveSeason.ts", "utf8");
    expect(live).toMatch(/ctx\.tieNomPushFor\?\.\(t, s\.hoh!\)/);
    expect(live).toMatch(/ctx\.tieVotePushFor\?\.\(n, voter\) \?\? 0/);
    const sources = readFileSync("src/engine/memorySources.ts", "utf8");
    expect(sources).toMatch(/hohNominations: \[[^\]]*"tieNomPushFor"/);
    expect(sources).toMatch(/evictionVote: \[[^\]]*"tieVotePushFor"/);
    expect(Object.keys(TIE_BEHAVIOR.family).sort()).toEqual(["nominationPush", "pressureFlipAt", "sceneAwkwardness", "votePush"]);
  });
});
