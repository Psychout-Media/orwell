import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { buildSandbox } from "../support/sandbox";
import type { DeepProfile, StoryThread } from "../../src/engine/deepProfile";
import type { MomentPromptView } from "../../src/ports/GameSession";

/**
 * The Show Brief v1 skeleton through the real session and the MCP boundary: built ONLY when asked (flag off on the
 * FE ⇒ no request ⇒ byte-identical response), never touching `systemPrompt` (the cached prefix), Vault-free under a
 * planted-sentinel sweep, and reachable through `McpServer.callTool` with its argument guard. Roles only.
 */

function liveSession(user: string) {
  const sb = new GameSessionRegistry().sandboxFor(`${user}-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  return sb;
}

describe("getMomentPrompt + brief: opt-in, prefix-neutral", () => {
  it("without a brief request the response has no showBrief (byte-identical shape)", () => {
    const sb = liveSession("brief-off");
    const mp = sb.session.getMomentPrompt({});
    expect(mp).not.toHaveProperty("showBrief");
    expect(Object.keys(mp).sort()).toEqual(Object.keys(sb.session.getMomentPrompt({})).sort());
  });

  it("asking for a brief leaves systemPrompt and hardConstraints byte-identical (the cached prefix is untouched)", () => {
    const sb = liveSession("brief-prefix");
    const plain = sb.session.getMomentPrompt({});
    const withBrief = sb.session.getMomentPrompt({ brief: {} });
    expect(withBrief.systemPrompt).toBe(plain.systemPrompt);
    expect(withBrief.hardConstraints).toBe(plain.hardConstraints);
    expect(withBrief.producerName).toBe(plain.producerName);
    expect(withBrief.showBrief!.text.startsWith("SHOW BRIEF.")).toBe(true);
    expect(withBrief.showBrief!.sections.map((s) => s.id)).toEqual(["header", "now", "changed", "established"]);
    expect(withBrief.systemPrompt).not.toContain("SHOW BRIEF");
  });

  it("a brief read is pure: asking twice gives the same bytes and leaves beatSeq alone", () => {
    const sb = liveSession("brief-pure");
    const before = sb.session.getGameState().beatSeq;
    const a = sb.session.getMomentPrompt({ brief: {} }).showBrief!;
    const b = sb.session.getMomentPrompt({ brief: {} }).showBrief!;
    expect(b.text).toBe(a.text);
    expect(sb.session.getGameState().beatSeq).toBe(before);
  });

  it("the echoed seen state round-trips: an unchanged house says so; a forged echo is ignored", () => {
    const sb = liveSession("brief-echo");
    const first = sb.session.getMomentPrompt({ brief: {} }).showBrief!;
    const again = sb.session.getMomentPrompt({ brief: { seen: first.seen } }).showBrief!;
    expect(again.text).toContain("Nothing you could see has changed.");
    const forged = sb.session.getMomentPrompt({ brief: { seen: { ...first.seen, here: ["npc:404"] } } }).showBrief!;
    expect(forged.text).toContain("Unknown: this is the first brief of this conversation.");
    expect(forged.text).not.toContain("npc:404");
  });

  it("no brief before a season starts", () => {
    const sb = new GameSessionRegistry().sandboxFor(`brief-pregame-${Math.random()}`);
    expect(sb.session.getMomentPrompt({ brief: {} })).not.toHaveProperty("showBrief");
  });
});

describe("the brief is Vault-free (planted-sentinel sweep)", () => {
  it("no hidden premise, trigger, secret, goal or weakness ever reaches the brief", () => {
    const SENT = "SENTINEL-show-brief-hidden";
    const sb = liveSession("brief-vault");
    const core = sb.session.snapshot();
    for (const t of (core.storyThreads ?? []) as StoryThread[]) {
      t.premise = `${t.premise} ${SENT}`;
      t.trigger = `${t.trigger} ${SENT}`;
    }
    for (const p of Object.values((core.deepProfiles ?? {}) as Record<string, DeepProfile>)) {
      p.secrets = p.secrets.map((s) => `${s} ${SENT}`);
      p.trueGoals = p.trueGoals.map((g) => `${g} ${SENT}`);
      p.weakness = `${p.weakness} ${SENT}`;
    }
    sb.session.restore(core);
    // Non-vacuous: the sentinel really is in the hidden layer.
    expect(JSON.stringify(sb.session.snapshot())).toContain(SENT);
    const first = sb.session.getMomentPrompt({ brief: { askedAbout: ["npc:1", "npc:2"], lastShown: "A quiet line." } });
    const second = sb.session.getMomentPrompt({ brief: { seen: first.showBrief!.seen } });
    for (const mp of [first, second]) expect(JSON.stringify(mp.showBrief)).not.toContain(SENT);
  });
});

describe("the brief over the MCP boundary", () => {
  function playerServer(): { server: McpServer; session: GameSessionAdapter } {
    const sb = buildSandbox(1);
    const session = new GameSessionAdapter();
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    return { server, session };
  }

  it("callTool('getMomentPrompt', { brief }) returns the brief; without it, none", async () => {
    const { server, session } = playerServer();
    session.createCharacter({ playerName: "The Player", seed: 5 });
    const withBrief = (await server.callTool("getMomentPrompt", { brief: { askedAbout: ["npc:3"], lastShown: "The end." } })) as MomentPromptView;
    expect(withBrief.showBrief?.text).toContain("1. NOW");
    const plain = (await server.callTool("getMomentPrompt", {})) as MomentPromptView;
    expect(plain).not.toHaveProperty("showBrief");
    expect(plain.systemPrompt).toBe(withBrief.systemPrompt);
  });

  it.each([
    [{ brief: "yes" }, /"brief" must be an object/],
    [{ brief: { seen: [] } }, /"brief\.seen" must be an object/],
    [{ brief: { askedAbout: "npc:1" } }, /"brief\.askedAbout" must be an array/],
    [{ brief: { askedAbout: Array.from({ length: 33 }, (_, i) => `npc:${i}`) } }, /"brief\.askedAbout" must be an array of at most 32/],
    [{ brief: { lastShown: 7 } }, /"brief\.lastShown" must be a string/],
    [{ brief: { lastShown: "x".repeat(4001) } }, /"brief\.lastShown" must be a string of at most 4000/],
  ])("refuses a malformed brief request %#", async (args, msg) => {
    const { server, session } = playerServer();
    session.createCharacter({ playerName: "The Player", seed: 5 });
    await expect(server.callTool("getMomentPrompt", args as Record<string, unknown>)).rejects.toThrow(msg);
  });
});
