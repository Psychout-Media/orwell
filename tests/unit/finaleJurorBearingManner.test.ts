import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { mannerGrudge, bearingWord } from "../../src/engine/juryHouse";

/**
 * ORW-110: at the finale a juror's "bearing" word must reflect how the juror was treated on the way out, not only the jury-house grudge (which never carries the juror who took the grievance out of the house).
 * A juror blindsided/betrayed with NO relayed grudge reads "burning"; a disrespected one "warm"; a respected one "settled"; the larger of manner and grudge wins; and the word is never a number. Roles only.
 */
type L = { mannerByEvictee?: Record<string, Record<string, { betrayed?: boolean; blindsided?: boolean; disrespected?: boolean; respected?: boolean }>>; juryGrudge?: Record<string, Record<string, number>>; finale?: unknown };
function finaleSetup(manner: Record<string, unknown> | undefined, grudge: number | undefined, flag = true) {
  const sb = new GameSessionRegistry().sandboxFor(`bearing-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.setTraitorsFuryEnabled(flag);
  const npcs = sb.session.livingIds().filter((i) => i !== PLAYER);
  const juror = npcs[0]!, other = npcs[1]!;
  const live = (sb.session as unknown as { live: L }).live;
  live.mannerByEvictee = manner ? { [juror]: { [PLAYER]: manner } } : {};
  live.juryGrudge = grudge === undefined ? {} : { [juror]: { [PLAYER]: grudge } };
  live.finale = { stage: "questions", finalists: [PLAYER, other], questionIx: 0, revealIx: 0, script: { questions: [{ juror }], revealOrder: [] } };
  return sb.session.finaleView()!;
}
function finale(manner: Record<string, unknown> | undefined, grudge: number | undefined) {
  return finaleSetup(manner, grudge).asking!.bearing;
}
describe("the finale bearing reads how the juror was treated (ORW-110)", () => {
  it("pure: wronged => burning tier, disrespected => warm tier, otherwise none", () => {
    expect(bearingWord(mannerGrudge({ blindsided: true }))).toBe("burning");
    expect(bearingWord(mannerGrudge({ betrayed: true }))).toBe("burning");
    expect(bearingWord(mannerGrudge({ disrespected: true }))).toBe("warm");
    expect(bearingWord(mannerGrudge({ respected: true } as never))).toBe("settled");
    expect(mannerGrudge(undefined)).toBe(0);
  });
  it("a juror blindsided on the way out with NO relayed grudge reads burning (was: settled)", () => {
    expect(finale({ blindsided: true }, undefined)).toBe("burning");
  });
  it("a respected juror reads settled; a disrespected one warm", () => {
    expect(finale({ respected: true }, undefined)).toBe("settled");
    expect(finale({ disrespected: true }, undefined)).toBe("warm");
  });
  it("the larger of manner and grudge wins (a grudge above a mild manner is not lowered)", () => {
    expect(finale({ disrespected: true }, 0.15)).toBe("burning");
    expect(finale({ blindsided: true }, 0.03)).toBe("burning");
  });
  it("a word, never a number", () => {
    expect(typeof finale({ blindsided: true }, undefined)).toBe("string");
    expect(String(finale({ blindsided: true }, undefined))).not.toMatch(/\d/);
  });
  it("Vault sentinel: the whole finale view carries no grudge number or grudge/manner field", () => {
    const json = JSON.stringify(finaleSetup({ blindsided: true }, 0.123456));
    expect(json).not.toMatch(/0\.123456/);
    expect(json).not.toMatch(/grudge|blindsided|betrayed|manner/i);
    expect(json).toContain('"bearing":"burning"');
  });
  it("flag OFF: no bearing at all, even for a blindsided juror (byte-identical headless view)", () => {
    expect(finaleSetup({ blindsided: true }, undefined, false).asking!.bearing).toBeUndefined();
  });
});
