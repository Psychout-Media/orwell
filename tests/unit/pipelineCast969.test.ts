import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER_TOOLS, PLAYER_AGENT_LEVERS, toolsFor } from "../../src/surfaces/tools/registry";

/** ORW-969: `pipelineCast` is the FULL cast for the front end's server-side casting jobs. `getGameState` keeps withholding the unarrived (ORW-710); the new read is not advertised to the narrator. */
let n = 0;
function start(seed: number, metOnly = true) {
  const sb = new GameSessionRegistry().sandboxFor(`pc969${n++}`);
  sb.session.setPremiereEntrancesEnabled(true);
  sb.session.setMetOnlyRosterEnabled(metOnly);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return { sb, s: sb.session as GameSessionAdapter };
}

describe("ORW-969 pipelineCast: every houseguest, arrived or not", () => {
  it("lists the whole cast while getGameState lists only the arrived, and the counts agree", () => {
    const { s } = start(11);
    const record = s.snapshot().house!.npcs;
    const pub = s.getGameState();
    expect((pub.unarrivedCount ?? 0)).toBeGreaterThan(0); // positive control: the premiere is hiding someone
    const pc = s.pipelineCast();
    expect(pc.started).toBe(true);
    expect(pc.house.map((h) => h.id).sort()).toEqual(record.map((x) => x.id).sort());
    expect(pc.total).toBe(record.length);
    expect(pc.unarrivedCount).toBe(pub.unarrivedCount);
    expect(pub.house.length + pc.unarrivedCount).toBe(pc.total);
  });

  it("does not change what getGameState returns (names of the unarrived stay out of it)", () => {
    const { s } = start(11);
    const before = JSON.stringify(s.getGameState());
    s.pipelineCast();
    expect(JSON.stringify(s.getGameState())).toBe(before);
    const pc = s.pipelineCast();
    const shown = new Set(s.getGameState().house.map((h) => h.id));
    const hidden = pc.house.filter((h) => !shown.has(h.id));
    expect(hidden.length).toBeGreaterThan(0);
    for (const h of hidden) expect(before.includes(h.name)).toBe(false);
  });

  it("carries the per-houseguest fields the casting jobs check", () => {
    const { s } = start(11);
    for (const h of s.pipelineCast().house) {
      expect(typeof h.id).toBe("string");
      expect(typeof h.name).toBe("string");
      expect(h.status).toBe("active");
    }
  });

  it("after the entrances nothing is unarrived and the two reads list the same ids", () => {
    const { s } = start(11);
    for (let i = 0; i < 60 && s.premiereIntros()?.entrance?.stage === "entrances"; i++) s.advanceGame();
    const pc = s.pipelineCast();
    expect(pc.unarrivedCount).toBe(0);
    expect(pc.house.map((h) => h.id)).toEqual(s.getGameState().house.map((h) => h.id));
  });

  it("is empty before a game starts", async () => {
    const sb = new GameSessionRegistry().sandboxFor("pc969-empty");
    expect(await sb.mcp.player.callTool("pipelineCast", {})).toEqual({ started: false, total: 0, unarrivedCount: 0, house: [] });
  });
});

describe("ORW-969 pipelineCast is an unadvertised infra read", () => {
  it("is not in the player tool list, the agent levers, or the advertised channel", () => {
    expect(PLAYER_TOOLS.some((t) => t.name === "pipelineCast")).toBe(false);
    expect(toolsFor("player").some((t) => t.name === "pipelineCast")).toBe(false);
    expect(PLAYER_AGENT_LEVERS).not.toContain("pipelineCast");
  });

  it("is still dispatchable by name over the MCP boundary", async () => {
    const { sb } = start(11);
    const r = (await sb.mcp.player.callTool("pipelineCast", {})) as { house: unknown[]; unarrivedCount: number };
    expect(r.house.length).toBeGreaterThan(r.unarrivedCount);
  });
});
