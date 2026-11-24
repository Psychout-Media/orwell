import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER_TOOLS, PLAYER_AGENT_LEVERS } from "../../src/surfaces/tools/registry";
import type { AdvanceView, RetrospectiveView } from "../../src/ports/GameSession";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

/**
 * ORW-807 (0200 your edit): the narrator's authored episode titles, written back to the engine after the crown (an FE-driven write-back: the four-place rule in CLAUDE.md)
 * and carried on each episode of the edit in the retrospective. Before the crown nothing is accepted; the first title for a week stands; a title is cleaned and capped;
 * an error payload or a raw id is refused. Unit lane: the season is auto-driven and marked played once over (as tests/unit/yourEdit.test.ts does). Roles only.
 */
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
}
type Seam = { live: { playedGame?: boolean } };
function season(user: string, seed = 7, finish = true) {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  if (finish) {
    for (let i = 0; i < 4000; i++) { const v = sb.session.advanceGame(); if (v.pending) resolve(sb.session, v.pending); if (v.finished) break; }
    (sb.session as unknown as Seam).live.playedGame = true;
  }
  return sb;
}
const episodes = (s: GameSessionAdapter) => (s.seasonRetrospective() as RetrospectiveView).yourEdit!.episodes;

describe("ORW-807: authored episode titles", () => {
  it("before the crown nothing is accepted and no episode carries one", () => {
    const sb = season("ept-live", 7, false);
    expect(sb.session.recordEpisodeTitles({ titles: [{ week: 1, title: "Week one" }] })).toEqual({ accepted: false, recorded: 0, reason: "not-finished" });
    expect(sb.session.seasonRetrospective()).toBeNull();
  });

  it("after the crown each titled episode carries its authored title beside the floor; the first title stands; a replay records nothing", () => {
    const sb = season("ept-done");
    const eps = episodes(sb.session);
    expect(eps.length).toBeGreaterThan(1);
    const [a, b] = [eps[0]!, eps[1]!];
    const r = sb.session.recordEpisodeTitles({ titles: [{ week: a.week, title: "  The Long Night\u0007 " }, { week: b.week, title: "Blindside" }] });
    expect(r).toEqual({ accepted: true, recorded: 2 });
    const after = episodes(sb.session);
    expect(after.find((e) => e.week === a.week)!.authoredTitle).toBe("The Long Night");
    expect(after.find((e) => e.week === a.week)!.title).toBe(a.title); // the floor stays
    expect(after.filter((e) => e.authoredTitle).length).toBe(2);
    expect(sb.session.recordEpisodeTitles({ titles: [{ week: a.week, title: "A rewrite" }] })).toEqual({ accepted: true, recorded: 0 });
    expect(episodes(sb.session).find((e) => e.week === a.week)!.authoredTitle).toBe("The Long Night");
  });

  it("refuses an unknown week, an empty title, an error payload and a raw id; caps the length", () => {
    const sb = season("ept-guard");
    const w = episodes(sb.session)[0]!.week;
    expect(sb.session.recordEpisodeTitles({ titles: [{ week: 999, title: "Nope" }] }).reason).toBe("empty");
    expect(sb.session.recordEpisodeTitles({ titles: [{ week: w, title: "   " }] }).reason).toBe("empty");
    expect(sb.session.recordEpisodeTitles({ titles: [{ week: w, title: 'event: error data: {"x":1}' }] }).reason).toBe("empty");
    expect(sb.session.recordEpisodeTitles({ titles: [{ week: w, title: "The fall of npc:3" }] }).reason).toBe("empty");
    expect(sb.session.recordEpisodeTitles({ titles: [{ week: w, title: "x".repeat(400) }] }).accepted).toBe(true);
    expect(episodes(sb.session)[0]!.authoredTitle!.length).toBeLessThanOrEqual(90);
  });

  it("survives a save and restore", () => {
    const sb = season("ept-save");
    const w = episodes(sb.session)[0]!.week;
    sb.session.recordEpisodeTitles({ titles: [{ week: w, title: "Kept" }] });
    const loaded = new GameSessionRegistry().sandboxFor("ept-save-load").session;
    loaded.restore(JSON.parse(JSON.stringify(sb.session.snapshot())));
    expect(episodes(loaded).find((e) => e.week === w)!.authoredTitle).toBe("Kept");
  });

  it("is an FE-driven write-back: on the player channel, not a model lever; dispatched through McpServer.callTool, refusing malformed args", async () => {
    expect(PLAYER_TOOLS.map((t) => t.name)).toContain("recordEpisodeTitles");
    expect(PLAYER_AGENT_LEVERS).not.toContain("recordEpisodeTitles");
    const sb = season("ept-wire");
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session: sb.session });
    const w = episodes(sb.session)[0]!.week;
    const res = (await server.callTool("recordEpisodeTitles", { titles: [{ week: w, title: "Via the wire" }] })) as { accepted: boolean; recorded: number };
    expect(res).toEqual({ accepted: true, recorded: 1 });
    expect(episodes(sb.session)[0]!.authoredTitle).toBe("Via the wire");
    await expect(server.callTool("recordEpisodeTitles", { titles: "x" })).rejects.toThrow(/titles/);
    await expect(server.callTool("recordEpisodeTitles", { titles: [{ week: "1", title: "x" }] })).rejects.toThrow(/titles/);
  });
});
