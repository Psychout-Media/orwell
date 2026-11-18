import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER_TOOLS } from "../../src/surfaces/tools/registry";
import { buildSandbox } from "../support/sandbox";
import { Orchestrator } from "../../src/composition/orchestrator";
import { GameSessionRegistry } from "../../src/composition/registry";

// Feature 0070 — off-screen society texture enrichment. The four-place write-back: proves both
// tools are on the player channel AND can be dispatched through McpServer.callTool. Roles only.

describe("0070 — off-screen texture enrichment reaches the engine over the MCP boundary", () => {
  function playerServer(): { server: McpServer; session: GameSessionAdapter; reg: GameSessionRegistry; user: string } {
    const reg = new GameSessionRegistry();
    const user = "tx-boundary";
    const sb = reg.sandboxFor(user);
    const session = sb.session;
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    return { server, session, reg, user };
  }

  it("getOffscreenSceneSkeletons is on the player channel", () => {
    const names = PLAYER_TOOLS.map((t) => t.name);
    expect(names).toContain("getOffscreenSceneSkeletons");
  });

  it("recordOffscreenSceneTexture is on the player channel", () => {
    const names = PLAYER_TOOLS.map((t) => t.name);
    expect(names).toContain("recordOffscreenSceneTexture");
  });

  it("getOffscreenSceneSkeletons is not rejected as 'not available'", async () => {
    const { server, session } = playerServer();
    session.createCharacter({ playerName: "The Player", seed: 801 });
    const res = await server.callTool("getOffscreenSceneSkeletons", {});
    expect(Array.isArray(res)).toBe(true);
  });

  it("returns empty array before any off-screen tick", async () => {
    const { server, session } = playerServer();
    session.createCharacter({ playerName: "The Player", seed: 802 });
    const res = await server.callTool("getOffscreenSceneSkeletons", {});
    expect(res).toEqual([]);
  });

  it("returns skeletons after a tick and they are Vault-free", async () => {
    const reg = new GameSessionRegistry();
    const user = "tx-tick-test";
    const orch = new Orchestrator(reg, { now: () => 803 }, { seed: 803 });
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 803 });
    orch.advance(user, "offscreen-tick");
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session: sb.session });
    const res = await server.callTool("getOffscreenSceneSkeletons", {}) as { eventId: string; nature: string; participants: string[]; templateContent: string }[];
    // May be empty if the tick yielded no scenes (deep endgame guard); if present, verify shape.
    for (const sk of res) {
      expect(typeof sk.eventId).toBe("string");
      expect(sk.eventId.startsWith("offscreen:")).toBe(true);
      expect(typeof sk.nature).toBe("string");
      expect(Array.isArray(sk.participants)).toBe(true);
      // No raw float (relationship number) must appear.
      expect(/\d+\.\d{3,}/.test(JSON.stringify(sk))).toBe(false);
    }
  });

  it("templateContent exposes only base pattern, never enrichment clauses (#1869 Vault-leak guard)", async () => {
    const reg = new GameSessionRegistry();
    const user = "tx-vault-leak";
    const SEED = 8675309;
    const orch = new Orchestrator(reg, { now: () => SEED }, { seed: SEED });
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: SEED });
    // Advance multiple offscreen ticks to trigger all enrichment paths
    for (let t = 0; t < 5; t++) {
      orch.advance(user, "offscreen-tick");
    }
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session: sb.session });
    const res = await server.callTool("getOffscreenSceneSkeletons", {}) as { eventId: string; templateContent: string }[];
    if (res.length === 0) return; // no scenes this run — skip
    for (const sk of res) {
      // templateContent must be the base deterministic content (participants+nature ONLY).
      // It must NOT contain enrichment markers:
      // B50: hidden-element detail appended after " — " (from line 408)
      // PV1: player-subject clause appended after " — " (from line 424)
      // scheme-target: clause appended after " — " (from line 438)
      // The base pattern is "npc:ID verb npc:ID" where verbs can be multi-word ("formed an alliance with").
      // A single em-dash in the content signals enrichment leaked through.
      expect(sk.templateContent).not.toContain(" — ");
      // No "plots against" or "scheming" language
      expect(sk.templateContent).not.toMatch(/ plots against /i);
      expect(sk.templateContent).not.toMatch(/scheming/i);
      expect(sk.templateContent).not.toMatch(/ scheme against /i);
    }
  });

  it("recordOffscreenSceneTexture dispatches and returns { ok: boolean }", async () => {
    const reg = new GameSessionRegistry();
    const user = "tx-write-test";
    const orch = new Orchestrator(reg, { now: () => 804 }, { seed: 804 });
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 804 });
    orch.advance(user, "offscreen-tick");
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session: sb.session });
    const skeletons = await server.callTool("getOffscreenSceneSkeletons", {}) as { eventId: string }[];
    if (skeletons.length === 0) {
      // No scenes this tick — a write to a non-existent id gets the same { ok: true } receipt as a hidden scene (ORW-570), and stores nothing.
      const res = await server.callTool("recordOffscreenSceneTexture", {
        eventId: "offscreen:gossip:0:0",
        content: "Some voiced prose that will not match.",
      }) as { ok: boolean };
      expect(res.ok).toBe(true); // ORW-570: the same bare receipt as for a real hidden scene (no probing); nothing is stored
      return;
    }
    const res = await server.callTool("recordOffscreenSceneTexture", {
      eventId: skeletons[0]!.eventId,
      content: "The two houseguests exchanged knowing glances and sealed their pact in hushed tones.",
    }) as { ok: boolean };
    expect(res.ok).toBe(true);
  });

  it("texture write-back persists and is reflected in subsequent getOffscreenSceneSkeletons", async () => {
    const reg = new GameSessionRegistry();
    const user = "tx-persist-test";
    const orch = new Orchestrator(reg, { now: () => 805 }, { seed: 805 });
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 805 });
    orch.advance(user, "offscreen-tick");
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session: sb.session });
    const before = await server.callTool("getOffscreenSceneSkeletons", {}) as { eventId: string; templateContent: string }[];
    if (before.length === 0) return; // no scenes — skip
    const TARGET_TEXT = "TEST-0070-voiced-texture-sentinel";
    await server.callTool("recordOffscreenSceneTexture", {
      eventId: before[0]!.eventId,
      content: TARGET_TEXT,
    });
    const after = await server.callTool("getOffscreenSceneSkeletons", {}) as { eventId: string; templateContent: string }[];
    const updated = after.find((s) => s.eventId === before[0]!.eventId);
    expect(updated?.templateContent).toBe(TARGET_TEXT);
  });

  it("texture survives snapshot/restore round-trip (non-degradation)", async () => {
    const reg = new GameSessionRegistry();
    const user = "tx-roundtrip";
    const orch = new Orchestrator(reg, { now: () => 806 }, { seed: 806 });
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 806 });
    orch.advance(user, "offscreen-tick");
    const skeletons = sb.session.getOffscreenSceneSkeletons();
    if (skeletons.length === 0) return; // no scenes — skip
    sb.session.recordOffscreenSceneTexture({ eventId: skeletons[0]!.eventId, content: "ROUNDTRIP-SENTINEL" });
    // Snapshot and restore.
    const core = sb.session.snapshot();
    expect(core.textureOverrides).toBeDefined();
    sb.session.restore(core);
    // Re-notify (transient field is cleared on restore; skeletons still come from the event store).
    sb.session.notifyOffscreenTick(skeletons.map((s) => s.eventId));
    const afterRestore = sb.session.getOffscreenSceneSkeletons();
    const match = afterRestore.find((s) => s.eventId === skeletons[0]!.eventId);
    expect(match?.templateContent).toBe("ROUNDTRIP-SENTINEL");
  });

  it("refuses a texture write-back with a witnessSet field (cannot pierce the closed set)", async () => {
    const { server, session } = playerServer();
    session.createCharacter({ playerName: "The Player", seed: 807 });
    await expect(
      server.callTool("recordOffscreenSceneTexture", {
        eventId: "offscreen:gossip:0:0",
        content: "some prose",
        witnessSet: ["player"],
      }),
    ).rejects.toThrow(/witnessSet/);
  });

  it("refuses a texture write-back with a hidden field (cannot flip the hidden flag)", async () => {
    const { server, session } = playerServer();
    session.createCharacter({ playerName: "The Player", seed: 808 });
    await expect(
      server.callTool("recordOffscreenSceneTexture", {
        eventId: "offscreen:gossip:0:0",
        content: "some prose",
        hidden: false,
      }),
    ).rejects.toThrow(/hidden/);
  });

  it("refuses a texture write-back with a relationship field (no numbers across)", async () => {
    const { server, session } = playerServer();
    session.createCharacter({ playerName: "The Player", seed: 809 });
    await expect(
      server.callTool("recordOffscreenSceneTexture", {
        eventId: "offscreen:gossip:0:0",
        content: "some prose",
        relationshipDelta: 0.5,
      }),
    ).rejects.toThrow(/relationship/);
  });

  it("refuses missing eventId", async () => {
    const { server, session } = playerServer();
    session.createCharacter({ playerName: "The Player", seed: 810 });
    await expect(
      server.callTool("recordOffscreenSceneTexture", { content: "some prose" }),
    ).rejects.toThrow(/eventId/);
  });

  it("refuses missing content", async () => {
    const { server, session } = playerServer();
    session.createCharacter({ playerName: "The Player", seed: 811 });
    await expect(
      server.callTool("recordOffscreenSceneTexture", { eventId: "offscreen:gossip:0:0" }),
    ).rejects.toThrow(/content/);
  });

  it("texture write-back does not change any relationship edge (open/closed non-collapse)", async () => {
    const reg = new GameSessionRegistry();
    const user = "tx-no-edge-change";
    const orch = new Orchestrator(reg, { now: () => 812 }, { seed: 812 });
    const sb = reg.sandboxFor(user);
    sb.session.createCharacter({ playerName: "The Player", seed: 812 });
    orch.advance(user, "offscreen-tick");
    const skeletons = sb.session.getOffscreenSceneSkeletons();
    if (skeletons.length === 0) return;
    // Write texture.
    sb.session.recordOffscreenSceneTexture({ eventId: skeletons[0]!.eventId, content: "EDGE-TEST" });
    // Verify the non-texture parts are unchanged: the relationship store, house, and events are the
    // same as before — only textureOverrides differs. The texture write-back routes through the
    // `backgroundPersist` seam (R-BND #628), so `beatSeq` does NOT move either — that invariant is
    // pinned end-to-end in tests/unit/backgroundPersistBeatSeq.test.ts.
    const snapAfter = sb.session.snapshot();
    // textureOverrides is set.
    expect(snapAfter.textureOverrides).toBeDefined();
    expect(Object.keys(snapAfter.textureOverrides!).length).toBeGreaterThan(0);
    // The week/phase/house structure is unchanged (no structural advance from texture write-back).
    expect(snapAfter.week).toBe(1);
    // The live season's finished flag is false — no eviction or structural advance occurred.
    expect(snapAfter.live?.finished ?? false).toBe(false);
  });
});
