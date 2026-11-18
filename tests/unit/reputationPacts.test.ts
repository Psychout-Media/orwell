import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { REPUTATION } from "../../src/engine/reputation";
import { reputationNature } from "../../src/engine/spokenClaims";

/** 0184 part 2c (ORW-564): a bad name keeps someone out of pacts and alliances, both ways and for the player too; the house's social map shows only after the crown. Roles only. */
type Seam = {
  live: { playedGame?: boolean; pending?: unknown; week: number; finished?: boolean; beliefs?: Record<string, Array<Record<string, unknown>>> };
  record?: { events(): unknown[] };
  badNameBetween(a: string, b: string): boolean; reputationOf(o: string, t: string): number;
  seasonRetrospective(): { socialMap?: { people: Array<{ id: string; heldAs: Array<{ role: string; by: number }> }> } } | null;
};
function setup() {
  const sb = new GameSessionRegistry().sandboxFor(`pacts-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 61 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Seam;
  g.live.playedGame = true; g.live.pending = undefined;
  const [a, b, c] = sb.session.livingIds().filter((i) => i !== PLAYER) as [string, string, string];
  return { g, a, b, c };
}
/** `holder` has heard, from several people, that `subject` lied to and turned on others (part 1's evidence). */
const badName = (g: Seam, holder: string, subject: string) => {
  const store = (g.live.beliefs ??= {});
  const mine = (store[holder] ??= []);
  for (const [i, nature] of ["lying", "betrayal", "lying"].entries()) mine.push({ id: `${holder}|heard-rumor|${subject}|x${i}|${g.live.week}`, holder, kind: "heard-rumor", subject, object: `npc:other${i}`, value: true, origin: "told", nature, confidence: 0.9, week: g.live.week });
};

describe("0184 part 2c: a bad name keeps someone out of pacts and alliances", () => {
  it("either side holding the other at a bad name blocks it; the player's name counts like anyone's; a clean pair is untouched", () => {
    const { g, a, b, c } = setup();
    expect(g.badNameBetween(a, b)).toBe(false);
    badName(g, a, b);
    expect(g.reputationOf(a, b)).toBeLessThanOrEqual(REPUTATION.pactBar);
    expect(g.badNameBetween(a, b)).toBe(true);
    expect(g.badNameBetween(b, a)).toBe(true); // either way round
    expect(g.badNameBetween(a, c)).toBe(false);
    badName(g, c, PLAYER);
    expect(g.badNameBetween(c, PLAYER)).toBe(true); // a founder who has heard the player is a snake will not pitch them
  });

  it("the social map reads only after the crown, and names each role the house read with how many held it", () => {
    const { g, a, b, c } = setup();
    // three houseguests each told the player is a snake (one telling at full confidence makes the read)
    for (const o of [a, b, c]) ((g.live.beliefs ??= {})[o] ??= []).push({ id: `${o}|heard-rumor|${PLAYER}||${g.live.week}`, holder: o, kind: "heard-rumor", subject: PLAYER, value: true, origin: "told", nature: reputationNature("snake"), confidence: 1, week: g.live.week });
    expect(g.seasonRetrospective()).toBeNull();
    g.live.finished = true;
    const me = g.seasonRetrospective()?.socialMap?.people.find((p) => p.id === PLAYER);
    expect(me?.heldAs.find((h) => h.role === "snake")?.by).toBeGreaterThanOrEqual(1);
  });
});
