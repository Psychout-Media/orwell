import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import {
  DEBUG_VAULT_TOOLS, ADMIN_TOOLS, PLAYER_TOOLS, PLAYER_AGENT_LEVERS, toolsFor,
} from "../../src/surfaces/tools/registry";
import { npc } from "../../src/domain/ids";

/**
 * producerVault — the owner-ruled DEBUG override of mandate #2. Admin/God Mode is otherwise WALLED from
 * the Vault; this one tool deliberately UNSEALS the LIVE hidden layer for operator debugging, behind an
 * explicit FE "unseal". These tests prove (1) the breach is quarantined to one grep-able tool (the normal
 * allowlists stay Vault-free), (2) the post-season retrospective gate is unchanged, (3) the override
 * actually surfaces the live hidden layer through the admin MCP channel, and (4) the player channel can
 * never reach it. HARD rule: roles only — no fixture names.
 */

const SENTINEL = "SENTINEL-producer-vault-hidden";

function plantHidden(sb: ReturnType<GameSessionRegistry["sandboxFor"]>, tag: string): void {
  // A hidden, player-excluded off-screen scene + a sealed Vault record — the secret layer.
  sb.engine.events.record({
    id: `pv-hidden:${tag}`, ts: 9_100_000, type: "conversation",
    initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: `${SENTINEL}-scene-${tag}`,
  });
  sb.engine.vault.writeHidden({ id: `pv-vault:${tag}`, kind: "hidden-attribute", content: `${SENTINEL}-vault-${tag}` });
}

function liveGame(user: string, seed: number) {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return { reg, sb };
}

describe("producerVault — the owner-ruled DEBUG live-Vault unseal (override of mandate #2)", () => {
  it("is the SOLE Vault-reading tool — quarantined, admin-only, and not an agent lever", () => {
    // The normal allowlists stay Vault-free: the `readsVault: false` literal-type guard still holds.
    for (const t of ADMIN_TOOLS) expect(t.readsVault).toBe(false);
    for (const t of PLAYER_TOOLS) expect(t.readsVault).toBe(false);
    // The ONLY Vault reader in the system is producerVault, on the admin/God-Mode channel.
    expect(DEBUG_VAULT_TOOLS.map((t) => t.name)).toEqual(["producerVault"]);
    for (const t of DEBUG_VAULT_TOOLS) {
      expect(t.readsVault).toBe(true);
      expect(t.channel).toBe("admin/God Mode");
    }
    // DELIBERATELY NOT in the advertised allowlist (it's an out-of-band debug capability, not a tool)
    // — so every "admin allowlist is Vault-free" guarantee stays literally true.
    expect(toolsFor("admin/God Mode").some((t) => t.name === "producerVault")).toBe(false);
    expect(toolsFor("player").some((t) => t.name === "producerVault")).toBe(false);
    expect(PLAYER_AGENT_LEVERS).not.toContain("producerVault");
  });

  it("leaves the post-season retrospective gate UNCHANGED — null while the season is live", () => {
    const { sb } = liveGame("pv-gate", 7);
    expect(sb.session.seasonRetrospective()).toBeNull(); // still gated on the terminal `finished` state
  });

  it("UNSEALS the LIVE hidden layer — through the engine and the admin MCP channel", async () => {
    const { sb } = liveGame("pv-unseal", 7);
    plantHidden(sb, "x");
    // The override returns the live hidden layer even though the season has NOT finished.
    const dump = sb.session.producerVaultDump();
    expect(dump).not.toBeNull();
    expect(JSON.stringify(dump)).toContain(SENTINEL);
    // And the same through the gated admin MCP seam the FE "unseal" calls.
    const viaMcp = await sb.mcp.admin.callTool("producerVault", {});
    expect(JSON.stringify(viaMcp)).toContain(SENTINEL);
  });


  // ORW-313: the NPC agendas (goals, reasons, history) ride the DEBUG dump ONLY - through the sanctioned door, never the post-season view and never an advertised tool.
  it("ORW-313: every NPC's agenda is in the UNSEALED dump (name-resolved, no raw ids) - and in nothing else", async () => {
    const { sb } = liveGame("pv-agenda", 7);
    const session = sb.session as unknown as { noteMessage(a: { messageId: string }): unknown };
    session.noteMessage({ messageId: "pv-agenda-1" }); // a played game seeds every NPC's agenda
    const dump = sb.session.producerVaultDump()!;
    expect(dump.agendas).toHaveLength(15);
    for (const a of dump.agendas) {
      expect(a.houseguest.length).toBeGreaterThan(0);
      expect(a.goals.some((g) => g.horizon === "season")).toBe(true);
      for (const g of a.goals) {
        expect(typeof g.test).toBe("string");
        expect(g.commitment).toBeGreaterThanOrEqual(0);
        expect(g.commitment).toBeLessThanOrEqual(100);
        expect(Array.isArray(g.why)).toBe(true);
      }
    }
    expect(JSON.stringify(dump.agendas), "names only: no raw npc:/player ids cross").not.toMatch(/\bnpc:\d|\bplayer\b:/);
    // through the admin MCP seam the FE unseal calls
    const viaMcp = (await sb.mcp.admin.callTool("producerVault", {})) as { agendas?: unknown[] };
    expect(viaMcp.agendas).toHaveLength(15);
  });

  it("ORW-313: the agendas are NOT in the post-season retrospective view, and a plain admin/player surface never carries them", async () => {
    const { sb } = liveGame("pv-agenda-wall", 7);
    (sb.session as unknown as { noteMessage(a: { messageId: string }): unknown }).noteMessage({ messageId: "pv-wall-1" });
    expect((sb.session as unknown as { buildVaultUnseal(): object }).buildVaultUnseal()).not.toHaveProperty("agendas"); // the shared render the retrospective uses has no agendas
    const pubState = JSON.stringify(sb.session.getGameState());
    expect(pubState).not.toContain("commitment"); // an agenda field never reaches the player-facing state
    expect(toolsFor("admin/God Mode").some((t) => t.name === "producerVault")).toBe(false); // the admin allowlist stays Vault-free
    expect(toolsFor("player").some((t) => t.name === "producerVault")).toBe(false);
  });

  it("returns null when there is no game at all (nothing to unseal)", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("pv-empty");
    expect(sb.session.producerVaultDump()).toBeNull();
  });

  it("is REFUSED on the player channel — admin/God-Mode only (the player can never unseal)", async () => {
    const { sb } = liveGame("pv-refuse", 7);
    await expect(sb.mcp.player.callTool("producerVault", {})).rejects.toThrow();
  });
});
