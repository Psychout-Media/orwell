import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { buildHallRecord, mergeHall, hallKeepsAll, hallView, type HallRecord } from "../../src/engine/hallOfFame";
import { InMemoryUserHallOfFameStore, FileUserHallOfFameStore } from "../../src/adapters/engine/FileUserHallOfFameStore";
import type { YourEditView } from "../../src/engine/yourEdit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 0208 B3 (ORW-665, flag ORWELL_SEASON_MEMORY): the hall of fame. Roles only; step prefix "hall of fame:". */
const you = (because: YourEditView["you"]["because"]): YourEditView["you"] => ({ band: "mixed", dealsKept: 1, dealsBroken: 0, dealsBrokenOnYou: 1, blindsidesDealt: 0, blindsidesReceived: 1, betrayalsDealt: 0, betrayalsReceived: 2, compWins: 3, because, line: "" });
const rec = (season: number, placement = 3): HallRecord => buildHallRecord({ season, placement, juror: placement > 2, castSize: 16, playerName: "P", winnerName: "W" });

describe("hall of fame: the pure record", () => {
  it("the result comes from placement and the jury seat", () => {
    expect(rec(1, 1).result).toBe("won");
    expect(rec(1, 2).result).toBe("runner-up");
    expect(rec(1, 5).result).toBe("jury");
    expect(buildHallRecord({ season: 1, placement: 14, juror: false, castSize: 16, playerName: "P" }).result).toBe("evicted-pre-jury");
  });
  it("best move is the player's own good act; worst betrayal is one done TO the player; neither is invented", () => {
    const r = buildHallRecord({ season: 1, placement: 2, juror: false, castSize: 16, playerName: "P", you: you([{ kind: "betrayal", actor: "A", subject: "P" }, { kind: "comp-win", actor: "P" }, { kind: "betrayal", actor: "P", subject: "B" }]) });
    expect(r.bestMove).toEqual({ kind: "comp-win", actor: "P" });
    expect(r.worstBetrayal).toEqual({ kind: "betrayal", actor: "A", subject: "P" });
    expect(r.counts?.compWins).toBe(3);
    const none = buildHallRecord({ season: 1, placement: 2, juror: false, castSize: 16, playerName: "P", you: you([{ kind: "betrayal", actor: "P", subject: "B" }]) });
    expect(none.bestMove).toBeUndefined();
    expect(none.worstBetrayal).toBeUndefined();
  });
  it("the merge is monotonic: a stored season is never changed or dropped, a new one is added, order by season", () => {
    const first = [rec(1, 4), rec(2, 1)];
    const merged = mergeHall(first, [{ ...rec(1, 1) }, rec(3, 2)]);
    expect(merged.map((r) => r.season)).toEqual([1, 2, 3]);
    expect(merged[0]!.placement).toBe(4);
    expect(hallKeepsAll(first, merged)).toBe(true);
    expect(hallKeepsAll(merged, first)).toBe(false);
    expect(hallView(merged)).toMatchObject({ seasonsPlayed: 3, won: 1 });
  });
});

describe("hall of fame: the per-user store", () => {
  it("in memory and on disk: append only, per user, never a cross-user read, survives a fresh instance", () => {
    const dir = mkdtempSync(join(tmpdir(), "hall-"));
    try {
      for (const store of [new InMemoryUserHallOfFameStore(), new FileUserHallOfFameStore(dir)]) {
        store.append("u1", rec(1, 4)); store.append("u1", rec(2, 1)); store.append("u1", rec(1, 1));
        expect(store.read("u1").map((r) => [r.season, r.placement])).toEqual([[1, 4], [2, 1]]);
        expect(store.read("u2")).toEqual([]);
      }
      expect(new FileUserHallOfFameStore(dir).read("u1")).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

type Internals = { live: { finished?: boolean; winner?: string; finalTwo?: string[] }; setSeasonMemoryEnabled(on: boolean): void; hallRecordDraft(n: number): HallRecord | null };
const play = (seed: number, user: string, on = true, reg = new GameSessionRegistry()) => {
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const s = sb.session as unknown as Internals;
  s.setSeasonMemoryEnabled(on);
  sb.session.noteMessage({ messageId: "m1" });
  return { reg, sb, s };
};
const finish = (s: Internals) => { s.live.finished = true; s.live.winner = "npc:other"; };

describe("hall of fame: in a played game", () => {
  it("no finished season: an empty hall; the read tool dispatches through the MCP boundary", async () => {
    const { sb } = play(5, "h-a");
    expect(sb.session.hallOfFame()).toEqual({ seasonsPlayed: 0, won: 0, seasons: [] });
    expect(await sb.mcp.player.callTool("hallOfFame", {})).toEqual({ seasonsPlayed: 0, won: 0, seasons: [] });
  });
  it("a season that just ended shows at once; the cutover files it for good; the next season still reads it; another user does not", async () => {
    const { reg, s } = play(5, "h-b");
    finish(s);
    expect(reg.sandboxFor("h-b").session.hallOfFame().seasons).toHaveLength(1);
    reg.resetUser("h-b");
    const next = reg.sandboxFor("h-b").session.hallOfFame();
    expect(next.seasonsPlayed).toBe(1);
    expect(next.seasons[0]!.season).toBe(1);
    expect(reg.sandboxFor("h-other").session.hallOfFame().seasonsPlayed).toBe(0);
    const viaTool = await reg.sandboxFor("h-b").mcp.player.callTool("hallOfFame", {});
    expect(viaTool).toEqual(next);
  });
  it("a second finished season is added beside the first, never over it", () => {
    const { reg, s } = play(5, "h-c");
    finish(s); reg.resetUser("h-c");
    const second = play(6, "h-c", true, reg);
    finish(second.s);
    expect(reg.sandboxFor("h-c").session.hallOfFame().seasons.map((r) => r.season)).toEqual([1, 2]);
    reg.resetUser("h-c");
    expect(reg.sandboxFor("h-c").session.hallOfFame().seasons.map((r) => r.season)).toEqual([1, 2]);
  });
  it("the wall: a planted hidden fact never reaches the hall; a live season files nothing; flag off is empty and files nothing", () => {
    const SENT = "SENTINEL-HIDDEN-FACT";
    const { reg, sb, s } = play(5, "h-d");
    const sess = sb.session as unknown as { live: { beliefs?: Record<string, unknown> } };
    sess.live.beliefs = { [SENT]: { content: SENT } };
    expect(s.hallRecordDraft(1)).toBeNull(); // not finished
    finish(s);
    expect(JSON.stringify(sb.session.hallOfFame())).not.toContain(SENT);
    const off = play(5, "h-e", false); finish(off.s);
    expect(off.sb.session.hallOfFame().seasonsPlayed).toBe(0);
    off.reg.resetUser("h-e");
    expect(off.reg.sandboxFor("h-e").session.hallOfFame().seasonsPlayed).toBe(0);
    reg.resetUser("h-d");
  });
  it("a game nobody plays files nothing", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("h-f");
    sb.session.createCharacter({ playerName: "The Player", seed: 5 });
    finish(sb.session as unknown as Internals);
    reg.resetUser("h-f");
    expect(reg.sandboxFor("h-f").session.hallOfFame().seasonsPlayed).toBe(0);
  });
  it("it is deterministic for a seed", () => {
    const one = () => { const { s, sb } = play(7, "h-g"); finish(s); return sb.session.hallOfFame(); };
    expect(one()).toEqual(one());
  });
});
