import { describe, it, expect } from "vitest";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER } from "../../src/domain/ids";
import { buildSandbox } from "../support/sandbox";
import { playedGame } from "../support/playedGame";
import type { OpenLedger } from "../../src/engine/openLedger";

/**
 * ORW-693 / bug scan B1-6, REAL PATH: a final-two promise made early is weighed at the final three. A final-two term was read only in the week it was made (nothing set a season
 * window) and its open-ledger line lapsed after 7 quiet days, so by the final three the promise was gone. 0187: a final-two deal lasts the season. Both ways: a houseguest's
 * final-two promise to the player (the promiser's own keep-or-break read at the final three still sees it) and the player's to a houseguest (still open, to be judged at the
 * final two). Played through the player's levers; the promise goes through the real MCP door (recordInteraction.promise). Roles only.
 */
type S = { movePlayer(room: string): { present: Array<{ id: string }> } | undefined; livingIds(): string[]; live: { week: number; dayNumber?: number }; getGameState(): { pending?: unknown };
  termKeepsOf(holder: string, what: string): Array<{ subject: string; keep: boolean }>; promiseFinalTwoFor(hoh: string, rivals: readonly string[]): string | undefined; snapshot(): unknown };

describe("ORW-693 REAL PATH: a final-two promise lasts the season", () => {
  it("made in week 2, it is still open and still read three weeks later, both ways", async () => {
    const g = playedGame({ seed: 4, user: "f2p-4" });
    const s = g.s as unknown as S;
    let npc = "", madeWeek = 0;
    g.playUntil(() => {
      if (s.live.week < 2 || s.getGameState().pending) return false;
      const here = (s.movePlayer("living-room")?.present ?? []).map((p) => p.id).filter((id) => id !== PLAYER);
      if (!here.length) return false;
      npc = here[0]!; madeWeek = s.live.week; return true;
    }, 3000, "a week-2 room with a houseguest in it");
    const b = buildSandbox(1);
    const server = new McpServer("player", { player: b.player, admin: b.admin, summary: b.summary, commands: g.sb.commands, session: g.sb.session });
    await server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, npc], content: "they swear we go to the end together", kind: "alliance", promise: { what: "final-two", from: npc } });
    await server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, npc], content: "I swear we go to the end together", kind: "alliance", promise: { what: "final-two" } });
    const f2 = (): Array<{ term?: { by: string; to: string; what: string }; status: string }> =>
      ((s.snapshot() as { openLedger?: OpenLedger }).openLedger?.entries ?? []).filter((e) => e.term?.what === "final-two") as never;
    const theirs = () => f2().find((e) => e.term!.by === npc && e.term!.to === PLAYER);
    const mine = () => f2().find((e) => e.term!.by === PLAYER && e.term!.to === npc);
    expect(theirs()?.status, "setup: the houseguest's final-two promise is recorded").toBe("open");
    expect(mine()?.status, "setup: the player's final-two promise is recorded").toBe("open");
    g.playUntil(() => s.live.week >= madeWeek + 3 || !s.livingIds().includes(npc), 6000, "three weeks on");
    expect(s.livingIds(), "setup: the houseguest is still in the house").toContain(npc);
    expect(theirs()?.status, "the houseguest's promise to the player did not lapse").toBe("open");
    expect(mine()?.status, "the player's promise to the houseguest did not lapse").toBe("open");
    const reads = s.termKeepsOf(npc, "final-two");
    expect(reads.map((r) => r.subject), "the promiser's own final-three read still sees the promise made weeks ago").toContain(PLAYER);
    const keep = reads.find((r) => r.subject === PLAYER)!.keep;
    const rival = s.livingIds().find((id) => id !== PLAYER && id !== npc)!;
    expect(s.promiseFinalTwoFor(npc, [PLAYER, rival]), "as the final HOH, a promiser who keeps it takes the player").toBe(keep ? PLAYER : undefined);
  }, 600_000);
});
