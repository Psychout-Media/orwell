import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * B2 (2026-07-05 activation lane) — the God-Mode runtime dial for the "living house" behavioral-
 * fidelity layers (0085 campaigns, 0087 trajectories, 0091 triggers, 0092 secret pacing, 0100 jury
 * house, 0059 §5 seeded-tie surfacing) that ship OPT-IN behind their own `ORWELL_*` deploy env flag.
 * Mirrors `timeOfDayToggle.test.ts` (ADR 0006's precedent): the admin `setBehavioralFlags` tool flips
 * one or more layers at runtime through the composition delegate, with NO engine restart; an absent
 * field leaves that layer untouched; `getBehavioralFlags` is the read-side companion.
 */

afterEach(() => {
  // Never leak the process-global overrides (secretPacing/seededTieSurfacing) across other test files.
  GameSessionAdapter.setSecretPacingEnabled(null);
  GameSessionAdapter.setSeededTieSurfacingEnabled(null);
});

describe("B2 — GameSessionAdapter.setBehavioralFlags / behavioralFlagsSnapshot", () => {
  it("defaults every flag to off with no env set", () => {
    const s = new GameSessionAdapter();
    expect(s.behavioralFlagsSnapshot()).toEqual({
      campaigns: false, trajectories: false, triggers: false,
      secretPacing: false, juryHouse: false, seededTieSurfacing: false, mythMaking: false, showrunner: false,
    });
  });

  it("flips only the named flags, leaving the rest untouched", () => {
    const s = new GameSessionAdapter();
    s.setBehavioralFlags({ campaigns: true, juryHouse: true });
    expect(s.behavioralFlagsSnapshot()).toEqual({
      campaigns: true, trajectories: false, triggers: false,
      secretPacing: false, juryHouse: true, seededTieSurfacing: false, mythMaking: false, showrunner: false,
    });
    // A second, disjoint patch doesn't clobber the first patch's flags.
    s.setBehavioralFlags({ trajectories: true });
    expect(s.behavioralFlagsSnapshot()).toEqual({
      campaigns: true, trajectories: true, triggers: false,
      secretPacing: false, juryHouse: true, seededTieSurfacing: false, mythMaking: false, showrunner: false,
    });
  });

  it("turns every flag on, including the two process-global overrides", () => {
    const s = new GameSessionAdapter();
    s.setBehavioralFlags({
      campaigns: true, trajectories: true, triggers: true,
      secretPacing: true, juryHouse: true, seededTieSurfacing: true, mythMaking: true, showrunner: true,
    });
    expect(s.behavioralFlagsSnapshot()).toEqual({
      campaigns: true, trajectories: true, triggers: true,
      secretPacing: true, juryHouse: true, seededTieSurfacing: true, mythMaking: true, showrunner: true,
    });
  });
});

describe("B2 — the admin setBehavioralFlags/getBehavioralFlags tools (composition delegate)", () => {
  it("flips per-sandbox instance flags through admin.setBehavioralFlags and reads them back", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("behavioral-flags-user");
    sb.session.createCharacter({ playerName: "The Player", seed: 11 });

    expect(sb.admin.behavioralFlags().campaigns).toBe(false);
    sb.admin.setBehavioralFlags({ campaigns: true, trajectories: true });
    expect(sb.admin.behavioralFlags()).toEqual({
      campaigns: true, trajectories: true, triggers: false,
      secretPacing: false, juryHouse: false, seededTieSurfacing: false, mythMaking: false, showrunner: false,
    });
    // An absent field on a later call leaves the earlier flip in place.
    sb.admin.setBehavioralFlags({ juryHouse: true });
    expect(sb.admin.behavioralFlags()).toEqual({
      campaigns: true, trajectories: true, triggers: false,
      secretPacing: false, juryHouse: true, seededTieSurfacing: false, mythMaking: false, showrunner: false,
    });
  });

  it("dispatches through the real MCP admin channel, and the player channel cannot reach it", async () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("behavioral-flags-mcp-user");
    sb.session.createCharacter({ playerName: "The Player", seed: 12 });

    await sb.mcp.admin.callTool("setBehavioralFlags", { triggers: true, secretPacing: true });
    const flags = await sb.mcp.admin.callTool("getBehavioralFlags", {});
    expect(flags).toMatchObject({ triggers: true, secretPacing: true });

    await expect(sb.mcp.player.callTool("setBehavioralFlags", { campaigns: true })).rejects.toThrow();
    await expect(sb.mcp.player.callTool("getBehavioralFlags", {})).rejects.toThrow();
  });

  it("is per-sandbox: flipping every flag on user A's game never changes user B's game (cross-user isolation)", async () => {
    // The tool promises an override "for this sandbox". Two of the eight layers (secretPacing,
    // seededTieSurfacing) used to write a PROCESS-GLOBAL static, so an admin adjusting one user's game
    // silently changed it for every user on the server. Every field must stay inside its own sandbox.
    const reg = new GameSessionRegistry();
    const a = reg.sandboxFor("behavioral-flags-iso-a");
    const b = reg.sandboxFor("behavioral-flags-iso-b");
    a.session.createCharacter({ playerName: "The Player", seed: 14 });
    b.session.createCharacter({ playerName: "The Player", seed: 15 });
    const before = b.admin.behavioralFlags();

    await a.mcp.admin.callTool("setBehavioralFlags", {
      campaigns: true, trajectories: true, triggers: true,
      secretPacing: true, juryHouse: true, seededTieSurfacing: true, mythMaking: true, showrunner: true,
    });

    expect(a.admin.behavioralFlags()).toEqual({
      campaigns: true, trajectories: true, triggers: true,
      secretPacing: true, juryHouse: true, seededTieSurfacing: true, mythMaking: true, showrunner: true,
    });
    expect(b.admin.behavioralFlags(), "user B's game must be untouched by an admin flip on user A's").toEqual(before);
    // A sandbox composed AFTER the flip starts from the env default too — the flip never leaks into it.
    const c = reg.sandboxFor("behavioral-flags-iso-c");
    expect(c.admin.behavioralFlags().secretPacing).toBe(before.secretPacing);
    expect(c.admin.behavioralFlags().seededTieSurfacing).toBe(before.seededTieSurfacing);
  });

  it("refuses a non-boolean field by name (E31/D10/R6 shape-guard discipline)", async () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("behavioral-flags-shape-user");
    sb.session.createCharacter({ playerName: "The Player", seed: 13 });

    await expect(sb.mcp.admin.callTool("setBehavioralFlags", { campaigns: "yes" })).rejects.toThrow(/campaigns/);
  });

  it("no game/sandbox composed ⇒ getBehavioralFlags returns the all-off default, never throws", () => {
    const reg = new GameSessionRegistry();
    // A brand-new sandbox with no createCharacter call yet still wires the provider at sandboxFor time.
    const sb = reg.sandboxFor("behavioral-flags-fresh-user");
    expect(sb.admin.behavioralFlags()).toEqual({
      campaigns: false, trajectories: false, triggers: false,
      secretPacing: false, juryHouse: false, seededTieSurfacing: false, mythMaking: false, showrunner: false,
    });
  });
});
