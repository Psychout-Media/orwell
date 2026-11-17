import { describe, it, expect } from "vitest";
import { SCAPEGOAT, findScapegoat, holdsGrievance, scapegoatLean, weekHardness } from "../../src/engine/houseNorms";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/** Feature 0180 part 3 - scapegoats. Roles only: holders (h1..h5), the scapegoat (g), another houseguest (x). */
const belief = (holder: string, kind: BeliefClaim["kind"], subject: string, week = 4, extra: Partial<BeliefClaim> = {}): BeliefClaim =>
  ({ id: `${holder}|${kind}|${subject}|${week}|${extra.nature ?? ""}`, holder, kind, subject, value: true, origin: "told", confidence: 0.7, week, ...extra }) as BeliefClaim;

describe("scapegoats (houseNorms.ts)", () => {
  it("a grievance is what the holder holds: a lie, being targeted, a vote against them, a rumor of lying or scheming - recent, unrefuted, never about themself", () => {
    expect(holdsGrievance([belief("h", "lied-to-me", "g")], "h", "g", 4)).toBe(true);
    expect(holdsGrievance([belief("h", "heard-rumor", "g", 4, { nature: "going-after", object: "x" })], "h", "g", 4)).toBe(true);
    expect(holdsGrievance([belief("h", "lied-to-me", "g", 2)], "h", "g", 4)).toBe(false); // too old
    expect(holdsGrievance([belief("h", "lied-to-me", "g", 4, { refuted: true })], "h", "g", 4)).toBe(false);
    expect(holdsGrievance([belief("h", "allied-with", "g")], "h", "g", 4)).toBe(false);
  });
  it("a week is hard only when enough of the house is rattled", () => {
    expect(weekHardness([0.6, 0.6, 0.3, 0.6, 0.6])).toBe(0);
    expect(weekHardness([0.3, 0.3, 0.3, 0.3, 0.3])).toBe(1);
    expect(weekHardness([0.3, 0.3, 0.3, 0.6, 0.6])).toBeGreaterThan(0);
  });
  it("the scapegoat is the one most of the house holds a grievance against, with a clear lead; a tie or a thin share is no one", () => {
    const by = { h1: [belief("h1", "lied-to-me", "g")], h2: [belief("h2", "targets-me", "g")], h3: [belief("h3", "lied-to-me", "x")], h4: [], h5: [] };
    const holders = ["h1", "h2", "h3", "h4", "h5"];
    expect(findScapegoat(by, holders, ["g", "x", ...holders], 4)).toBe("g");
    expect(findScapegoat({ ...by, h2: [] }, holders, ["g", "x", ...holders], 4)).toBeUndefined(); // 1 v 1: no clear focus, and below the share
  });
  it("the lean: full for a decider with a grievance, a follower's share without, nothing for anyone else or in a calm week", () => {
    expect(scapegoatLean("g", "g", 1, true)).toBeCloseTo(SCAPEGOAT.weight, 12);
    expect(scapegoatLean("g", "g", 1, false)).toBeCloseTo(SCAPEGOAT.weight * SCAPEGOAT.followShare, 12);
    expect(scapegoatLean("x", "g", 1, true)).toBe(0);
    expect(scapegoatLean("g", "g", 0, true)).toBe(0);
  });
  it("the player can be the house's scapegoat: in a hard week, a houseguest's belief term leans toward the player", () => {
    const sb = new GameSessionRegistry().sandboxFor("scapegoat-player");
    sb.session.setHouseNormsEnabled(true);
    sb.session.createCharacter({ playerName: "The Player", seed: 23 });
    const seam = sb.session as unknown as { live: { playedGame?: boolean; week: number; beliefs?: Record<string, BeliefClaim[]> }; emotionalReadOf(id: string): number; scapegoatLeanFor(s: string, d: string): number };
    seam.live.playedGame = true;
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    const w = seam.live.week;
    seam.live.beliefs = Object.fromEntries(npcs.slice(0, Math.ceil(npcs.length / 2)).map((h) => [h, [belief(h, "lied-to-me", PLAYER, w)]]));
    const calm = seam.scapegoatLeanFor(PLAYER, npcs[0]!);
    seam.emotionalReadOf = () => 0.2; // TEST-ONLY seam: the whole house rattled
    (seam as unknown as { beatSeq: number }).beatSeq += 1; // a new beat: the cached read refreshes
    expect(calm).toBe(0);
    expect(seam.scapegoatLeanFor(PLAYER, npcs[0]!)).toBeGreaterThan(0);
    expect(seam.scapegoatLeanFor(npcs[1]!, npcs[0]!)).toBe(0); // only the scapegoat
    expect(seam.scapegoatLeanFor(npcs[1]!, PLAYER)).toBe(0); // the player's own choices are theirs
  });
});
