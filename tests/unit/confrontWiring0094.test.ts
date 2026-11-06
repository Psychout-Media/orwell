import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER_TOOLS } from "../../src/surfaces/tools/registry";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0094 — the live WIRING: `confront` reaches the engine over the MCP boundary, resolves a
 * faithful belief as landed and a materially distorted one as a misfire (folding the SAME betrayal-
 * grade blow a real betrayal folds, onto the wrongly-confronted houseguest's read of the player),
 * validates the cited `factId` against what the player legitimately holds (the Vault bright line), and
 * never crosses a confidence/distortion number on any surface. Roles only.
 */

// The divergence is gated by `ORWELL_GOSSIP_CONSEQUENCE` (default OFF) — enable it for these tests
// (which exercise the divergence itself) and always restore to the default afterward.
beforeEach(() => GameSessionAdapter.setGossipConsequenceEnabled(true));
afterEach(() => GameSessionAdapter.setGossipConsequenceEnabled(null));

function startedGame(userSuffix: string, seed = 1): { reg: GameSessionRegistry; sb: ReturnType<GameSessionRegistry["sandboxFor"]> } {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`confront-${userSuffix}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return { reg, sb };
}

function seedBelief(sb: ReturnType<GameSessionRegistry["sandboxFor"]>, npcId: EntityId, factId: string, distortion: number, confidence: number): void {
  sb.engine.knowledge.seedBelief(
    PLAYER,
    { content: `word is ${npcId} is scheming against you`, factId, subject: npcId, distortion, confidence },
    "witnessed",
  );
}

type WithRel = { rel: { edge: (a: EntityId, b: EntityId) => { trust: number; threat: number } } };
const relOf = (s: GameSessionAdapter): WithRel["rel"] => (s as unknown as WithRel).rel;

describe("0094 confront — a faithful belief lands; a materially distorted one misfires", () => {
  it("a witnessed (faithful) belief lands — no divergence applied", () => {
    const { sb } = startedGame("lands");
    const npcId = sb.session.snapshot().house!.npcs[0]!.id;
    seedBelief(sb, npcId, "fact:lands", 0, 1); // witnessed: distortion 0, confidence 1
    const before = { ...relOf(sb.session).edge(npcId, PLAYER) };
    const res = sb.session.confront(npcId, "fact:lands");
    expect(res).toEqual({ landed: true });
    const after = relOf(sb.session).edge(npcId, PLAYER);
    expect(after.trust).toBe(before.trust); // no fold — the move plays out as expected
    expect(after.threat).toBe(before.threat);
  });

  it("a materially distorted (many-hops, low-confidence) belief misfires and folds a betrayal-grade blow", () => {
    const { sb } = startedGame("misfires");
    const npcId = sb.session.snapshot().house!.npcs[0]!.id;
    seedBelief(sb, npcId, "fact:misfires", 3, 0.35); // past the floor, under the ceiling
    const before = { ...relOf(sb.session).edge(npcId, PLAYER) };
    const res = sb.session.confront(npcId, "fact:misfires");
    expect(res).toEqual({ landed: false });
    const after = relOf(sb.session).edge(npcId, PLAYER);
    expect(after.trust).toBeLessThan(before.trust); // the wrongly-confronted ally's read of the player craters
    expect(after.threat).toBeGreaterThan(before.threat);
  });

  it("a faithful belief about a DIFFERENT houseguest is unaffected by a misfire elsewhere", () => {
    const { sb } = startedGame("isolated");
    const [npcA, npcB] = sb.session.snapshot().house!.npcs.map((n) => n.id);
    seedBelief(sb, npcA!, "fact:a", 3, 0.3);
    seedBelief(sb, npcB!, "fact:b", 0, 1);
    sb.session.confront(npcA!, "fact:a"); // misfires
    const beforeB = { ...relOf(sb.session).edge(npcB!, PLAYER) };
    const resB = sb.session.confront(npcB!, "fact:b"); // lands
    expect(resB).toEqual({ landed: true });
    expect(relOf(sb.session).edge(npcB!, PLAYER)).toEqual(beforeB);
  });
});

describe("0094 confront — the Vault bright line: only a legitimately-held factId is honored", () => {
  it("an unrecognized factId is refused (null) — no Vault-minting", () => {
    const { sb } = startedGame("no-fact");
    const npcId = sb.session.snapshot().house!.npcs[0]!.id;
    expect(sb.session.confront(npcId, "fact:does-not-exist")).toBeNull();
  });

  it("an unknown/evicted houseguest is refused", () => {
    const { sb } = startedGame("unknown-hg");
    seedBelief(sb, PLAYER, "fact:x", 0, 1);
    expect(sb.session.confront("npc:9999" as EntityId, "fact:x")).toBeNull();
  });
});

describe("0094 confront — Vault Wall: no surface ever shows a confidence/distortion number or a tell", () => {
  it("the result carries only { landed } — no number, no reason", () => {
    const { sb } = startedGame("no-tell");
    const npcId = sb.session.snapshot().house!.npcs[0]!.id;
    seedBelief(sb, npcId, "fact:tell", 3, 0.3);
    const res = sb.session.confront(npcId, "fact:tell");
    expect(Object.keys(res!).sort()).toEqual(["landed"]);
  });

  it("no player-facing surface reveals a distortion/confidence value", () => {
    const { sb } = startedGame("no-surface");
    const npcId = sb.session.snapshot().house!.npcs[0]!.id;
    seedBelief(sb, npcId, "fact:surface", 3, 0.3);
    sb.session.confront(npcId, "fact:surface");
    const ids = sb.session.snapshot().house!.npcs.map((n) => n.id);
    const blob = JSON.stringify([...ids.map((id) => sb.session.npcVoice(id)), sb.session.gameStatus(), sb.session.whereabouts()]);
    expect(blob).not.toMatch(/"distortion"|"confidence":\s*0\.\d/);
  });

  it("no admin/God-Mode surface reveals a distortion/confidence value", () => {
    const admin = buildSandbox(1).adminOutput();
    expect(admin).not.toMatch(/"distortion"|isMateriallyDistorted/);
  });
});

describe("0094 confront — reaches the engine over the MCP boundary", () => {
  it("is registered as a player tool and dispatches through McpServer.callTool", async () => {
    expect(PLAYER_TOOLS.map((t) => t.name)).toContain("confront");
    const { sb } = startedGame("mcp");
    const npcId = sb.session.snapshot().house!.npcs[0]!.id;
    seedBelief(sb, npcId, "fact:mcp", 3, 0.3);
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session: sb.session });
    const res = (await server.callTool("confront", { npcId, factId: "fact:mcp" })) as { landed: boolean };
    expect(res.landed).toBe(false);
  });
});

describe("0094 confront — OFF (the default) is calibration-neutral: no divergence, no fold", () => {
  it("with the flag off, even a materially distorted belief always lands with no fold", () => {
    GameSessionAdapter.setGossipConsequenceEnabled(null); // explicit: the default is OFF
    const { sb } = startedGame("off-default");
    const npcId = sb.session.snapshot().house!.npcs[0]!.id;
    seedBelief(sb, npcId, "fact:off", 3, 0.3); // would misfire if the flag were on
    const before = { ...relOf(sb.session).edge(npcId, PLAYER) };
    const res = sb.session.confront(npcId, "fact:off");
    expect(res).toEqual({ landed: true });
    expect(relOf(sb.session).edge(npcId, PLAYER)).toEqual(before);
  });

  it("the Vault bright line still holds when the flag is off — an unrecognized factId is still refused", () => {
    GameSessionAdapter.setGossipConsequenceEnabled(null);
    const { sb } = startedGame("off-bright-line");
    const npcId = sb.session.snapshot().house!.npcs[0]!.id;
    expect(sb.session.confront(npcId, "fact:never-seeded")).toBeNull();
  });
});

describe("0094 confront — deterministic and calibration-safe", () => {
  it("the same seed + same belief always classify and fold the same way", () => {
    const { sb: sbA } = startedGame("det-a", 42);
    const { sb: sbB } = startedGame("det-b", 42);
    const npcA = sbA.session.snapshot().house!.npcs[0]!.id;
    const npcB = sbB.session.snapshot().house!.npcs[0]!.id;
    expect(npcA).toBe(npcB);
    seedBelief(sbA, npcA, "fact:det", 3, 0.3);
    seedBelief(sbB, npcB, "fact:det", 3, 0.3);
    sbA.session.confront(npcA, "fact:det");
    sbB.session.confront(npcB, "fact:det");
    expect(relOf(sbA.session).edge(npcA, PLAYER)).toEqual(relOf(sbB.session).edge(npcB, PLAYER));
  });

  it("confront is a brand-new player-only lever — never invoked by the seeded calibration spine", () => {
    GameSessionAdapter.setGossipConsequenceEnabled(null); // default OFF for spine
    const { sb } = startedGame("spine-neutral", 1);
    const npcId = sb.session.snapshot().house!.npcs[0]!.id;
    // Seed some beliefs so confront could potentially fire
    seedBelief(sb, npcId, "fact:sp1", 3, 0.3);
    seedBelief(sb, npcId, "fact:sp2", 0, 1);
    // Spy on the confront method
    const spy = vi.spyOn(sb.session, "confront");
    // Run multiple advanceGame calls to exercise the calibration spine (vote, competition, off-screen ticks)
    for (let i = 0; i < 10; i++) {
      sb.session.advanceGame();
    }
    // confront should NEVER have been called by the seeded spine
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
