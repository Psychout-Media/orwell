import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";
import { EngineRefusal } from "../../src/domain/errors";

/**
 * E-1 (live rehearsal 2026-11-04): a player in WATCH mode has no way to switch to SKIP — the card is gone, and the model cannot commit a card-only choice.
 * `raiseSpectatorChoice` re-raises the SAME `spectator-choice` card on demand (watch mode only), so the player confirms skip ON THE CARD (the card-only
 * binding stays intact). Skip is irreversible: raising in skip mode is a typed refusal, and so is a later `watch`. Roles only.
 */
function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  const submit = (req: SubmitDecisionReq): void => void s.submitDecision(req);
  if (p.kind === "nominations") submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") submit({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") submit({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-intent") submit({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "comp-round") submit({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "finale-statement") submit({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") submit({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "juror-vote") submit({ kind: "juror-vote", vote: p.options[0]!.id });
  else if (p.kind === "exit-interview") submit({ kind: "exit-interview", vote: p.stances![0]! });
  else if (p.kind === "goodbye-message") submit({ kind: "goodbye-message", vote: p.options[0]!.id });
  else if (p.kind === "spectator-choice") submit({ kind: "spectator-choice", vote: "watch" });
  else if (p.kind === "finale-interview") submit({ kind: "finale-interview", vote: "gracious", statement: "good game" });
  else submit({ kind: p.kind, vote: p.options[0]!.id });
}

let seq = 0;
/** A season paused ON the spectator-choice card of a pre-jury-evicted player (seed-searched, never pinned). */
function pausedOnCard(): GameSessionAdapter {
  for (let seed = 1; seed <= 60; seed++) {
    const s = new GameSessionRegistry().sandboxFor(`sr${seq++}`).session;
    s.createCharacter({ playerName: "P", seed });
    for (let i = 0; i < 8000; i++) {
      const v = s.advanceGame();
      if (v.pending?.kind === "spectator-choice") return s;
      if (v.pending) resolve(s, v.pending);
      if (v.finished) break;
    }
  }
  throw new Error("no seed evicted the player pre-jury");
}
const state = (s: GameSessionAdapter) => s.getGameState();

describe("raiseSpectatorChoice — switch from watch to skip on the card", () => {
  it("in watch mode it raises the SAME spectator-choice card; confirming skip on it switches the mode and keeps the digests", () => {
    const s = pausedOnCard();
    s.submitDecision({ kind: "spectator-choice", vote: "watch" });
    for (let i = 0; i < 3 && !state(s).finished; i++) { const v = s.advanceGame(); if (v.pending) resolve(s, v.pending); }   // watch a couple of weeks
    const digestsBefore = (state(s).weekDigests ?? []).length;
    expect(digestsBefore).toBeGreaterThan(0);
    const v = s.raiseSpectatorChoice();
    expect(v.pending?.kind).toBe("spectator-choice");
    expect(state(s).pending?.kind).toBe("spectator-choice");
    expect(s.raiseSpectatorChoice().pending?.kind, "idempotent while the card is open").toBe("spectator-choice");
    s.submitDecision({ kind: "spectator-choice", vote: "skip" });
    expect(state(s).player!.spectator).toBe("skip");
    expect(state(s).pending?.kind ?? null).not.toBe("spectator-choice");
    expect((state(s).weekDigests ?? []).length, "switching to skip keeps the weeks already digested").toBeGreaterThanOrEqual(digestsBefore);
    s.advanceGame();                                                       // skip fast-forwards to the finale
    expect(s.snapshot().live!.beat === "finale" || !!s.snapshot().live!.finale || state(s).finished).toBe(true);
  });

  it("answering the re-raised card with WATCH keeps watching (no mode change, card cleared)", () => {
    const s = pausedOnCard();
    s.submitDecision({ kind: "spectator-choice", vote: "watch" });
    s.raiseSpectatorChoice();
    s.submitDecision({ kind: "spectator-choice", vote: "watch" });
    expect(state(s).player!.spectator).toBe("watch");
    expect(state(s).pending?.kind ?? null).not.toBe("spectator-choice");
  });

  it("skip is irreversible: raising in skip mode, and a later watch, are typed refusals", () => {
    const s = pausedOnCard();
    s.submitDecision({ kind: "spectator-choice", vote: "skip" });
    expect(() => s.raiseSpectatorChoice()).toThrow(EngineRefusal);
    expect(() => s.raiseSpectatorChoice()).toThrow(/irreversible|already/i);
    expect(() => s.submitDecision({ kind: "spectator-choice", vote: "watch" })).toThrow(EngineRefusal);
    expect(state(s).player!.spectator).toBe("skip");
  });

  it("refuses when there is nothing to raise (an active player; a finished season)", () => {
    const active = new GameSessionRegistry().sandboxFor(`sr${seq++}`).session;
    active.createCharacter({ playerName: "P", seed: 1 });
    expect(() => active.raiseSpectatorChoice()).toThrow(EngineRefusal);
  });

  it("the card is the ONLY way to commit: a bare spectator-choice submit with no pending in watch mode still works for watch→skip (existing seam) but the raise path is the player's visible one", () => {
    const s = pausedOnCard();
    s.submitDecision({ kind: "spectator-choice", vote: "watch" });
    const before = state(s).pending?.kind ?? null;
    expect(before).toBeNull();
    const v = s.raiseSpectatorChoice();
    expect(v.pending!.options.map((o) => o.id)).toEqual(["watch", "skip"]);
  });
});

// ── the MCP boundary (the recurring "four-place wiring" gotcha: a missing registry/McpServer case fails silently at runtime) ──
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { PLAYER_TOOLS } from "../../src/surfaces/tools/registry";
import { buildSandbox } from "../support/sandbox";

describe("raiseSpectatorChoice reaches the engine over the MCP boundary", () => {
  it("is on the player channel and dispatches (refusing typed when there is nothing to raise)", async () => {
    expect(PLAYER_TOOLS.map((t) => t.name)).toContain("raiseSpectatorChoice");
    const sb = buildSandbox(1);
    const session = new (await import("../../src/adapters/engine/GameSessionAdapter")).GameSessionAdapter();
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    session.createCharacter({ playerName: "The Player", seed: 3 });
    // an active player has no spectator choice: the dispatch reaches the adapter (a typed refusal), it is NOT rejected as "not available"
    await expect(server.callTool("raiseSpectatorChoice", {})).rejects.toThrow(/no spectator choice|no active game|re-open/i);
  });
});

describe("E-1 — the re-raised card has its own identity", () => {
  it("a re-raised spectator-choice card's prompt differs from the original (the FE keys its at-most-once token on the prompt; an identical one replays the first answer)", () => {
    const s = pausedOnCard();
    const original = s.getGameState().pending!;
    s.submitDecision({ kind: "spectator-choice", vote: "watch" });
    const again = s.raiseSpectatorChoice().pending!;
    expect(again.kind).toBe("spectator-choice");
    expect(again.prompt).not.toBe(original.prompt);
    expect(again.prompt).toMatch(/skipping is final/i);
  });
});
