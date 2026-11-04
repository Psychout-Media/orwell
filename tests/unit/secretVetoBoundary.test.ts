import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView } from "../../src/ports/GameSession";

// Feature 0025 (ORWELL_REACTIVE_TWISTS — default-ON since 2026-11-03) — the player's secret-veto pending is
// answerable over the MCP boundary the front-end uses. The audit's "latent break" was that the FE
// could not submit this kind; #1911 fixed the FE relays, and this pins the ENGINE end of that seam:
// advanceGame raises the pending, submitDecision (via McpServer.callTool, like every FE relay) resolves
// it for both play and hold, a malformed answer is refused, and the season keeps moving afterwards.
// Roles only — no names from any corpus.

function playerServer(): { server: McpServer; session: GameSessionAdapter } {
  const sb = buildSandbox(1);
  const session = new GameSessionAdapter();
  const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
  const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
  return { server, session };
}

/** A started season parked at the eviction gate with the PLAYER on the block holding the secret veto. */
function playerOnBlockHoldingSecretVeto(seed: number): { server: McpServer; session: GameSessionAdapter } {
  const { server, session } = playerServer();
  session.setReactiveTwistsEnabled(true);
  session.createCharacter({ playerName: "The Player", seed });
  session.advanceGame(); // the first advance is the free-roam premiere; the live loop starts after it
  const core = session.snapshot();
  const live = core.live!;
  const others = live.active.filter((h) => h !== PLAYER);
  live.beat = "eviction";
  live.hoh = others[0]!;
  live.finalNominees = [PLAYER, others[1]!];
  live.pending = undefined;
  live.secretVeto = { holder: PLAYER, used: false };
  session.restore(core);
  return { server, session };
}

const call = (server: McpServer, name: string, args: Record<string, unknown>) => server.callTool(name, args) as Promise<AdvanceView>;

describe("0025 — the secret-veto pending is answerable over the MCP boundary", () => {
  // The hand-placed "eviction" beat has no clock state, so with the in-game clock ON (default flip 2026-11-03)
  // the first advance emits a day-break beat before the pending. Pin the clock OFF for this boundary pin.
  beforeEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));
  afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
  it("advanceGame raises a secret-veto pending for the player holder on the block", async () => {
    const { server } = playerOnBlockHoldingSecretVeto(21);
    const v = await call(server, "advanceGame", {});
    expect(v.pending?.kind).toBe("secret-veto");
  });

  it("submitDecision use:true plays it — the holder leaves the block and the season moves on", async () => {
    const { server, session } = playerOnBlockHoldingSecretVeto(22);
    await call(server, "advanceGame", {});
    const after = await call(server, "submitDecision", { kind: "secret-veto", use: true });
    expect(after.pending?.kind).not.toBe("secret-veto");
    const live = session.snapshot().live!;
    expect(live.secretVeto?.used).toBe(true);
    expect(live.finalNominees).not.toContain(PLAYER);
    expect((live.firedTwists ?? []).map((t) => t.kind)).toContain("secret-veto");
  });

  it("P5d — playing it BROADCASTS a secret-veto chyron then the HOH's replacement nominee (and holding it announces nothing)", async () => {
    const { server, session } = playerOnBlockHoldingSecretVeto(26);
    await call(server, "advanceGame", {});
    const after = await call(server, "submitDecision", { kind: "secret-veto", use: true });
    const kinds = (after.announcements ?? []).map((a) => a.kind);
    expect(kinds).toContain("secret-veto");
    expect(kinds).toContain("replacement-nominee");
    expect(kinds.indexOf("secret-veto"), "the reveal precedes the replacement").toBeLessThan(kinds.indexOf("replacement-nominee"));
    const sv = (after.announcements ?? []).find((a) => a.kind === "secret-veto")!;
    expect(sv.headline).toMatch(/plays a secret veto and comes off the block/);
    const live = session.snapshot().live!;
    expect(sv.subjects.map((x) => x.id)).toEqual([PLAYER]);
    expect(live.finalNominees).not.toContain(PLAYER);
    // holding it announces no secret veto
    const held = playerOnBlockHoldingSecretVeto(27);
    await call(held.server, "advanceGame", {});
    const afterHold = await call(held.server, "submitDecision", { kind: "secret-veto", use: false });
    expect((afterHold.announcements ?? []).map((a) => a.kind)).not.toContain("secret-veto");
  });

  it("submitDecision use:false holds it — still on the block, safety kept, no re-prompt this week", async () => {
    const { server, session } = playerOnBlockHoldingSecretVeto(23);
    await call(server, "advanceGame", {});
    const after = await call(server, "submitDecision", { kind: "secret-veto", use: false });
    expect(after.pending?.kind).not.toBe("secret-veto");
    const live = session.snapshot().live!;
    expect(live.secretVeto?.used).toBe(false);
    expect(live.finalNominees).toContain(PLAYER);
    const again = await call(server, "advanceGame", {});
    expect(again.pending?.kind).not.toBe("secret-veto"); // held this week ⇒ not asked again
  });

  // The engine reads a missing / non-boolean `use` as a falsy HOLD (and then suppresses the re-offer for
  // the week), which would silently decline the player's one-time safety. The boundary refuses it instead
  // (McpServer.requireShape), so nothing is dispatched and the pending stays open.
  it("a malformed secret-veto answer (no boolean `use`) is refused with a clear error", async () => {
    const { server } = playerOnBlockHoldingSecretVeto(24);
    await call(server, "advanceGame", {});
    await expect(call(server, "submitDecision", { kind: "secret-veto" })).rejects.toThrow(/use/);
    await expect(call(server, "submitDecision", { kind: "secret-veto", use: "yes" })).rejects.toThrow(/boolean/);
    await expect(call(server, "submitDecision", { kind: "secret-veto", use: null })).rejects.toThrow(/boolean/);
  });

  it("after a refused secret-veto answer the pending is still offered and the safety is untouched", async () => {
    const { server, session } = playerOnBlockHoldingSecretVeto(25);
    await call(server, "advanceGame", {});
    await expect(call(server, "submitDecision", { kind: "secret-veto" })).rejects.toThrow();
    const v = await call(server, "advanceGame", {});
    expect(v.pending?.kind).toBe("secret-veto");
    const live = session.snapshot().live!;
    expect(live.secretVeto?.used).toBe(false);
    expect(live.secretVeto?.declinedWeek).toBeUndefined();
    expect(live.finalNominees).toContain(PLAYER);
    // …and an explicit answer still works afterwards.
    const done = await call(server, "submitDecision", { kind: "secret-veto", use: false });
    expect(done.pending?.kind).not.toBe("secret-veto");
  });
});
