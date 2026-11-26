import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { playedGame } from "../support/playedGame";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * ORW-930 (a playtest: week-1 deals closed at the week roll and nothing said so, so the player ended the week believing they still held a pact). REAL PATH: the player makes safety deals in week 1 through
 * `makeDeal`; the season is played to the next week's HOH competition or nominations; the narrator's moment prompt then says which of the player's deals ran out and that a renewal is recorded with
 * makeDeal. Making a new deal with that houseguest takes them off the list. Roles only.
 */
const LINE = "LAST WEEK'S DEALS ARE DONE";
type Priv = { live: { week: number; beat: string }; livingIds(): string[] };

function week2WithAClosedDeal(seed: number, sandbox: string) {
  const g = playedGame({ seed, user: sandbox });
  const p = g.s as unknown as Priv;
  g.playUntil(() => p.live.week === 1 && p.live.beat !== "hoh-competition" && !g.s.getGameState().pending, 4000, "week 1 past the HOH competition");
  const made: string[] = [];
  for (const id of p.livingIds().filter((x) => x !== PLAYER)) {
    const r = g.s.makeDeal({ with: id, kind: "safety", terms: "we keep each other safe" });
    if (r && !(r as { refused?: boolean }).refused) made.push(id);
  }
  if (made.length === 0) return undefined;
  g.playUntil(() => p.live.week === 2 && (p.live.beat === "hoh-competition" || p.live.beat === "nominations") && !g.s.getGameState().pending, 4000, "week 2's HOH competition or nominations");
  const closed = g.s.getMomentPrompt({}).systemPrompt.split("\n").find((l) => l.includes(LINE));
  return closed ? { g, p, made, closed } : undefined;
}

describe("the narrator is told the player's week-long deals ran out (played)", () => {
  it("names them at the new week, says nothing binds now, and a renewal takes that houseguest off the list", () => {
    const f = firstSeedWhereSync((seed, sandbox) => week2WithAClosedDeal(seed, sandbox), { from: 1, to: 12, hint: [1, 2], sandbox: (s) => `lw930-${s}`, what: "a week-2 house where one of the player's week-1 safety deals ran out" });
    const { g, p, made, closed } = f.at;
    const named = made.filter((id) => closed.includes((g.s as unknown as { nameOf(i: string): string }).nameOf(id)));
    expect(named.length, "the ran-out partners are named").toBeGreaterThan(0);
    expect(closed).toContain("Nothing binds");
    expect(closed).toContain("makeDeal");
    const partner = named.find((id) => p.livingIds().includes(id))!;
    const r = g.s.makeDeal({ with: partner, kind: "safety", terms: "again, this week" }) as { refused?: boolean } | null;
    if (r && !r.refused) {
      const after = g.s.getMomentPrompt({}).systemPrompt.split("\n").find((l) => l.includes(LINE)) ?? "";
      expect(after.includes((g.s as unknown as { nameOf(i: string): string }).nameOf(partner)), "a new deal takes them off the list").toBe(false);
    }
  }, 600_000);
});
