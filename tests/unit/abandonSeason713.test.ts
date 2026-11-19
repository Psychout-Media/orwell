import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { InMemoryUserSeasonArchive } from "../../src/adapters/engine/FileUserSeasonArchive";
import { InMemoryUserHallOfFameStore } from "../../src/adapters/engine/FileUserHallOfFameStore";
import type { GameStateView } from "../../src/ports/GameSession";

/**
 * ORW-713 - the player's confirmed "end this season and start a new one" goes through the ONE sanctioned restart
 * door (the player channel's confirmed createCharacter -> registry.resetUser). A season ended mid-way is
 * ABANDONED: it is not finished, so it is filed nowhere (no hall-of-fame credit, no returner archive entry): the
 * design files finished, played seasons only (0208 B2/B3). Roles only, no names.
 */
describe("ORW-713: ending a live season through the one restart door", () => {
  const setup = () => {
    const archive = new InMemoryUserSeasonArchive();
    const hall = new InMemoryUserHallOfFameStore();
    const reg = new GameSessionRegistry(undefined, { seasonArchive: archive, hallStore: hall });
    const user = "u-abandon";
    const mcp = reg.resolver()("player", user);
    return { reg, archive, hall, user, mcp };
  };

  it("an unconfirmed createCharacter over a live season is refused and leaves it untouched (no silent wipe)", async () => {
    const { reg, user, mcp } = setup();
    await mcp.callTool("createCharacter", { playerName: "The Player", seed: 3 });
    const before = reg.sandboxFor(user);
    const view = (await mcp.callTool("createCharacter", { playerName: "The Player", seed: 4 })) as GameStateView & { createRefused?: string };
    expect(view.createRefused).toBe("in-progress");
    expect(reg.sandboxFor(user)).toBe(before);
  });

  it("a confirmed restart mid-season starts a fresh season in a clean sandbox and files the unfinished one nowhere", async () => {
    const { reg, archive, hall, user, mcp } = setup();
    await mcp.callTool("createCharacter", { playerName: "The Player", seed: 3 });
    const old = reg.sandboxFor(user);
    old.session.noteMessage({ messageId: "m1" });
    old.session.advanceGame();
    expect(old.session.getGameState().finished).not.toBe(true);

    const view = (await mcp.callTool("createCharacter", { playerName: "The Player", seed: 4, confirmRestart: true })) as GameStateView & { createRefused?: string };
    expect(view.createRefused).toBeUndefined();
    expect(view.started).toBe(true);
    const fresh = reg.sandboxFor(user);
    expect(fresh).not.toBe(old); // one active game: the old sandbox is replaced, not kept beside the new one
    expect(fresh.session.getGameState().week).toBe(1);
    expect(hall.read(user)).toEqual([]);    // an abandoned season earns no hall-of-fame credit
    expect(archive.read(user)).toEqual([]); // and no returner entries
  });

  it("another user's game is untouched by this user's restart", async () => {
    const { reg, mcp } = setup();
    await mcp.callTool("createCharacter", { playerName: "The Player", seed: 3 });
    const other = reg.resolver()("player", "u-other");
    await other.callTool("createCharacter", { playerName: "The Player", seed: 9 });
    const otherSb = reg.sandboxFor("u-other");
    await mcp.callTool("createCharacter", { playerName: "The Player", seed: 4, confirmRestart: true });
    expect(reg.sandboxFor("u-other")).toBe(otherSb);
  });
});
