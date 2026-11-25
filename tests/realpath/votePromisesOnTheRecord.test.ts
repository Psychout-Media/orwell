import { describe, it, expect } from "vitest";
import { playedGame } from "../support/playedGame";

/**
 * ORW-750 (2): the narrator voiced six houseguests promising to keep a nominee while the engine held no promise for any of them, so the vows bound nothing. The moment prompt now lists, in the week of a nomination,
 * the vote promises that ARE on the record for each nominee (names only, what the player was told or heard), and says a vow not listed is not on the record. REAL PATH: a season is played through the player's levers
 * to a week with a nominee; the line says nobody for each nominee; one houseguest who is in the room with the player promises to keep a nominee through the real `recordInteraction` lever (the typed promise, as the
 * front-end belt records it); the next prompt lists that houseguest for that nominee ONLY (a houseguest who voiced nothing recorded is not listed). Nothing is set by hand. Roles only. HEAVY LANE (tests/realpath).
 */
type Live = { nominees?: string[]; finalNominees?: string[]; hoh?: string; finished?: boolean };
describe("the vote promises on the record are in the narrator's prompt", () => {
  it("lists a recorded promise for its nominee only, says nobody otherwise, and is absent when no one is on the block", async () => {
    const g = playedGame({ seed: 3, user: "wf-3" });
    const live = (): Live => (g.s.snapshot() as unknown as { live: Live }).live;
    const block = (): string[] => (live().finalNominees ?? live().nominees ?? []) as string[];
    const line = (): string => (g.s.getMomentPrompt({}).systemPrompt as string).split("\n").find((l) => l.startsWith("- VOTE PROMISES ON THE RECORD")) ?? "";
    expect(line(), "nobody is on the block at the start").toBe("");
    // a week with two nominees, neither the player, and a houseguest in the player's room who is not on the block and not the HOH
    let voter = "", nominee = "";
    g.playUntil(() => {
      const nom = block();
      if (nom.length < 2 || nom.includes("player")) return false;
      const present = (g.s.whereabouts()?.present ?? []).map((p) => p.id as string).filter((id) => !nom.includes(id) && id !== live().hoh);
      if (present.length === 0) return false;
      voter = present[0]!; nominee = nom[0]!;
      return true;
    }, 1500, "a week with two nominees and a free houseguest in the room");
    const nameOf = (id: string): string => (g.s.getGameState().house as Array<{ id: string; name: string }>).find((h) => h.id === id)!.name;
    const before = line();
    expect(before, "the line is present while someone is on the block").toContain("VOTE PROMISES ON THE RECORD");
    expect(before, "no promise is on the record yet: nobody for each nominee").not.toContain(nameOf(voter));
    expect((before.match(/nobody/g) ?? []).length).toBe(block().length);
    expect(before).toContain("A vow that is not listed is not on the record");
    await g.sb.mcp.player.callTool("recordInteraction", { initiator: voter, witnessSet: [voter, "player"], content: "I will vote to keep them.", promise: { what: "no-evict-vote", from: voter, subject: nominee } });
    const after = line();
    expect(after, "the recorded promise is listed for its nominee").toContain(`${nameOf(nominee)}: ${nameOf(voter)}`);
    const other = nameOf(block()[1]!);
    expect(after, "the other nominee still has nobody").toContain(`${other}: nobody`);
    expect(after, "names only: no number, no sincerity").not.toMatch(/\d|sincer|honest|loyal/i);
  }, 600_000);
});
