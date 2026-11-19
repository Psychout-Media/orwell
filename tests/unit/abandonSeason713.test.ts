import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { InMemoryUserSeasonArchive } from "../../src/adapters/engine/FileUserSeasonArchive";
import { InMemoryUserHallOfFameStore } from "../../src/adapters/engine/FileUserHallOfFameStore";
import type { GameStateView } from "../../src/ports/GameSession";

/**
 * ORW-713 - the player's confirmed "end this season and start a new one" goes through the ONE sanctioned restart
 * door (the player channel's confirmed createCharacter -> registry.resetUser). A season ended mid-way is
 * ABANDONED: it earns NO hall-of-fame record (0208 B3 files finished seasons only), but a PLAYED season in which someone had
 * actually been evicted still lends its houseguests to the returner archive (PO ruling 2026-11-19: "Old players can return no
 * matter what"). Roles only, no names.
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

  it("a confirmed restart mid-season starts a fresh season in a clean sandbox; with nobody evicted yet the unfinished season files nowhere", async () => {
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
    expect(archive.read(user)).toEqual([]); // and, with nobody evicted yet, no returner entries
  });

  it("an abandoned season in which someone was evicted earns no hall record but its houseguests CAN come back as returners", async () => {
    const { reg, archive, hall, user, mcp } = setup();
    GameSessionAdapter.setTimeOfDayEnabled(false); // a plain week loop (no clock holds) to reach the first eviction headlessly
    try {
      await mcp.callTool("createCharacter", { playerName: "The Player", seed: 3 });
      const old = reg.sandboxFor(user);
      const live = (old.session as unknown as { live: { evictionOrder?: string[]; finished?: boolean; playedGame?: boolean } }).live;
      for (let i = 0; i < 300 && (live.evictionOrder?.length ?? 0) < 1; i++) {
        const v = old.session.advanceGame();
        if (v.pending) old.session.submitDecision({ kind: v.pending.kind, intent: "compete", vote: v.pending.options?.[0]?.id } as never);
      }
      expect(live.evictionOrder?.length ?? 0, "precondition: someone was evicted").toBeGreaterThan(0);
      expect(live.finished).not.toBe(true);
      live.playedGame = true; // the season was a person-played one (the headless loop above only stands in for the play)
      await mcp.callTool("createCharacter", { playerName: "The Player", seed: 4, confirmRestart: true });
    } finally { GameSessionAdapter.setTimeOfDayEnabled(null); }
    expect(hall.read(user)).toEqual([]); // still no hall-of-fame credit
    const entries = archive.read(user);
    expect(entries.length, "the abandoned season's houseguests are on file for returners").toBeGreaterThan(0);
    expect(new Set(entries.map((e) => e.season)).size).toBe(1);
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
