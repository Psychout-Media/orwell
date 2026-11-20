import { describe, it, expect } from "vitest";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { InMemoryUserSeasonArchive, FileUserSeasonArchive } from "../../src/adapters/engine/FileUserSeasonArchive";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ORW-739 (spec 0208, ORW-663 rule 1): the player chooses at a season's end to start as a NEW person or to RETURN as one of their OWN previous characters.
 * Real path: seasons are played to completion through the player session, restarts go through the player tool door (McpServer.callTool), nothing is set by hand.
 * Roles only.
 */

type Inner = { house: { player: { name: string; character: { archetype: string; strategyStyle: string } } } | null };
const inner = (sb: UserSandbox): Inner => sb.session as never as Inner;

/** Play the season on screen to a crowned winner as a played game (a message was sent). */
function finish(sb: UserSandbox, id: string): void {
  sb.session.noteMessage({ messageId: id });
  expect(sb.session.advanceToFinale().finished).toBe(true);
}
const postSeasonFacts = (sb: UserSandbox): string => sb.session.getMomentPrompt({ moment: "post-season" }).systemPrompt;

describe("ORW-739: start new or return as one of my own previous characters", () => {
  it("REAL PATH: play season 1 as role A, restart new as role B, finish; the choice lists both; return as role A restores A", async () => {
    const archive = new InMemoryUserSeasonArchive();
    const reg = new GameSessionRegistry(undefined, { seasonArchive: archive });
    const user = "u-own-real";
    let sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "Role Alpha", seed: 7, archetype: "villain", strategyStyle: "aggressive", backstory: "Alpha's own backstory", motivation: "Alpha's own reason" });
    finish(sb, "m1");
    // the first season just ended: the choice is offered in facts, listing the character just played
    expect(postSeasonFacts(sb)).toContain("season 1: Role Alpha");
    expect(postSeasonFacts(sb)).toContain("returnAs");

    // season 2: a NEW person, through the tool door
    await sb.mcp.player.callTool("createCharacter", { playerName: "Role Beta", seed: 8, confirmRestart: true, start: "new", archetype: "peacemaker", strategyStyle: "social" });
    sb = reg.sandboxFor(user);
    expect(inner(sb).house!.player.name).toBe("Role Beta");
    expect(archive.readOwn(user).map((c) => [c.season, c.name])).toEqual([[1, "Role Alpha"]]);
    finish(sb, "m2");
    const facts = postSeasonFacts(sb);
    expect(facts).toContain("season 1: Role Alpha");
    expect(facts).toContain("season 2: Role Beta");

    // season 3: RETURN as the season-1 character (not the one just finished), no other detail handed over
    await sb.mcp.player.callTool("createCharacter", { seed: 9, confirmRestart: true, start: "return", returnAs: 1 });
    sb = reg.sandboxFor(user);
    const p = inner(sb).house!.player;
    expect(p.name).toBe("Role Alpha");
    expect(p.character.archetype).toBe("villain");
    expect(p.character.strategyStyle).toBe("aggressive");
    expect(sb.session.carriedNotoriety()).not.toBeNull(); // a return: reputation walks in
    // append-only: season 2's character is archived at the next cutover and season 1 is never rewritten
    expect(archive.readOwn(user).map((c) => c.season)).toEqual([1, 2]);
  });

  it("returnAs the season just finished is the same as keeping the character; an unknown season is refused, typed, and the season is untouched", async () => {
    const archive = new InMemoryUserSeasonArchive();
    const reg = new GameSessionRegistry(undefined, { seasonArchive: archive });
    let sb = reg.sandboxFor("u-own-cur");
    sb.session.createCharacter({ playerName: "Role Alpha", seed: 7, archetype: "mastermind", strategyStyle: "strategic" });
    finish(sb, "m1");
    await expect(sb.mcp.player.callTool("createCharacter", { seed: 9, confirmRestart: true, start: "return", returnAs: 5 })).rejects.toThrow(/returnAs/);
    expect(sb.session.getGameState().finished).toBe(true); // the finished season is still standing
    await expect(sb.mcp.player.callTool("createCharacter", { seed: 9, confirmRestart: true, start: "new", returnAs: 1 })).rejects.toThrow(/returnAs/);
    await expect(sb.mcp.player.callTool("createCharacter", { seed: 9, confirmRestart: true, returnAs: "1" })).rejects.toThrow(/returnAs/);
    await expect(sb.mcp.player.callTool("createCharacter", { seed: 9, confirmRestart: true, returnAs: 0 })).rejects.toThrow(/returnAs/);
    await sb.mcp.player.callTool("createCharacter", { seed: 9, confirmRestart: true, start: "return", returnAs: 1 });
    sb = reg.sandboxFor("u-own-cur");
    expect(inner(sb).house!.player.name).toBe("Role Alpha");
    expect(inner(sb).house!.player.character.archetype).toBe("mastermind");
  });

  it("a first-season player (nothing played) is never offered the choice and archives nothing", () => {
    const archive = new InMemoryUserSeasonArchive();
    const reg = new GameSessionRegistry(undefined, { seasonArchive: archive });
    const sb = reg.sandboxFor("u-own-none");
    sb.session.createCharacter({ playerName: "Role Alpha", seed: 7 });
    expect(sb.session.advanceToFinale().finished).toBe(true); // headless: no message was ever sent
    expect(postSeasonFacts(sb)).not.toContain("PREVIOUS CHARACTERS");
    sb.session.createCharacter({ playerName: "Role Beta", seed: 8, confirmRestart: true });
    expect(archive.readOwn("u-own-none")).toEqual([]);
  });

  it("the archive holds the player's own authored fields only, per user, and an old archive file (no own file) loads", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-arch-"));
    const store = new FileUserSeasonArchive(dir);
    expect(store.readOwn("u-a")).toEqual([]);
    const entry = { season: 1, name: "Role Alpha", fields: { playerName: "Role Alpha", archetype: "villain" } };
    store.appendOwn("u-a", entry);
    store.appendOwn("u-a", { ...entry, name: "Rewritten" }); // a season already on file is ignored
    expect(store.readOwn("u-a")).toEqual([entry]);
    expect(store.readOwn("u-b")).toEqual([]); // never another user's
    expect(store.read("u-a")).toEqual([]); // the houseguest archive is a separate, unchanged file
    store.append("u-a", []);
    writeFileSync(join(dir, "season-archive", `${Buffer.from("u-old").toString("hex")}.json`), "[]");
    expect(store.readOwn("u-old")).toEqual([]);
    expect(readdirSync(join(dir, "season-archive")).some((f) => f.endsWith(".own.json"))).toBe(true);
  });
});
