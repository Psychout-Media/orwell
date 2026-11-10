import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { buildSystemPrompt, MOMENT_PROMPTS } from "../../src/engine/momentPrompts";
import type { GameStateView } from "../../src/ports/GameSession";

/**
 * ORW-249 / ORW-248 - COMMIT BEFORE VOICE, slice 1: the ceremony SCRIPT (the nominations key ritual, the veto ceremony/draw grammar, the eviction reveal) rides the narrator's prompt only once the engine has
 * committed what it scripts. Prod 2026-11-07: with production holding nominations, a narrator that still had the key-ritual script in its context voiced a whole ceremony the engine never ran. While the outcome is
 * UNCOMMITTED and the engine is not asking the player for a decision, the narrator gets the social moment plus a plain "has NOT happened" line instead of the script. Roles only.
 */
const base = (): GameStateView => new GameSessionAdapter().createCharacter({ playerName: "P", seed: 11 });
const withPhase = (v: GameStateView, phase: string, patch: Partial<GameStateView> = {}): GameStateView =>
  ({ ...v, phase, pending: null, ...patch } as GameStateView);

const RITUAL_MARK = "PLAY THE CEREMONY AS A LIVE SET-PIECE";

describe("nominations: the key-ritual script is gated on the commit", () => {
  it("no nominees committed + no player decision pending: the script is ABSENT and the narrator is told it has not happened", () => {
    const v = withPhase(base(), "nominations", { ceremony: { hoh: { id: "npc:1", name: "HOH" }, nominees: [], veto: { holder: null, used: false, players: [] } } });
    const p = buildSystemPrompt("nominations", v);
    expect(p).not.toContain(RITUAL_MARK);
    expect(p).not.toContain("turns a key");
    expect(p).toMatch(/has NOT happened/);
    expect(p).toMatch(/call advanceGame/i);
  });
  it("nominees committed: the script is delivered so the narrator can voice the committed ceremony", () => {
    const v = withPhase(base(), "nominations", { ceremony: { hoh: { id: "npc:1", name: "HOH" }, nominees: [{ id: "npc:2", name: "A" }, { id: "npc:3", name: "B" }], veto: { holder: null, used: false, players: [] } } });
    expect(buildSystemPrompt("nominations", v)).toContain(RITUAL_MARK);
  });
  it("the player is the HOH and the engine is asking them to name nominees (a pending card): the script stays", () => {
    const v = withPhase(base(), "nominations", {
      ceremony: { hoh: { id: "player", name: "P" }, nominees: [], veto: { holder: null, used: false, players: [] } },
      pending: { kind: "nominations", by: { id: "player", name: "P" }, prompt: "name two", options: [] } as never,
    });
    expect(buildSystemPrompt("nominations", v)).toContain(RITUAL_MARK);
  });
});

describe("veto and eviction: the same gate", () => {
  it("veto competition with no draw yet: the draw ritual is absent", () => {
    const v = withPhase(base(), "veto-competition", { ceremony: { hoh: null, nominees: [], veto: { holder: null, used: false, players: [] } } });
    const p = buildSystemPrompt("veto-competition", v);
    expect(p).not.toContain("VOICE THE CHIP DRAW AS ITS OWN RITUAL BEAT");
    expect(p).toMatch(/has NOT happened/);
  });
  it("veto competition with the draw committed but no winner: the draw is voiced, the winner is not", () => {
    const players = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `npc:${n}`, name: `P${n}` }));
    const v = withPhase(base(), "veto-competition", { ceremony: { hoh: null, nominees: [], veto: { holder: null, used: false, players } } });
    const p = buildSystemPrompt("veto-competition", v);
    expect(p).toContain("VOICE THE CHIP DRAW AS ITS OWN RITUAL BEAT");
    expect(p).toMatch(/winner has NOT been decided/);
  });
  it("eviction not run (no staged reveal, no card): the reveal script is absent", () => {
    const v = withPhase(base(), "eviction", { eviction: null });
    const p = buildSystemPrompt("eviction", v);
    expect(p).toMatch(/has NOT happened/);
  });
});

describe("nothing else changes", () => {
  it("other moments are byte-identical (the gate touches only nominations / veto-competition / eviction)", () => {
    const v = withPhase(base(), "social");
    expect(buildSystemPrompt("social", v)).toContain(MOMENT_PROMPTS["social"]!.slice(0, 60));
  });
});

describe("ORW-252: a competition that is not due has not started - its fragment (venue, rounds) is withheld", () => {
  const sched = (next: string, due: boolean) => ({ next, phase: "morning", due, minutesUntil: due ? 0 : 45 }) as never;
  const drawn = { hoh: { id: "npc:1", name: "HOH" }, nominees: [{ id: "npc:2", name: "A" }, { id: "npc:3", name: "B" }], veto: { holder: null, used: false, players: [{ id: "npc:1", name: "HOH" }, { id: "npc:2", name: "A" }, { id: "npc:3", name: "B" }, { id: "npc:4", name: "C" }, { id: "npc:5", name: "D" }, { id: "npc:6", name: "E" }] } };
  it("veto: the draw is done, the competition not due: the competition fragment is replaced and the note says it has NOT started", () => {
    const notDue = buildSystemPrompt("veto-competition", withPhase(base(), "veto-competition", { ceremony: drawn, daySchedule: sched("veto-competition", false) }));
    const due = buildSystemPrompt("veto-competition", withPhase(base(), "veto-competition", { ceremony: drawn, daySchedule: sched("veto-competition", true) }));
    expect(notDue).toMatch(/veto competition has NOT started/);
    expect(due).not.toMatch(/veto competition has NOT started/);
    expect(notDue.length).toBeLessThan(due.length);
  });
  it("hoh: not due -> the note; due -> the normal fragment; a player's own pending card keeps its script", () => {
    const notDue = buildSystemPrompt("hoh-competition", withPhase(base(), "hoh-competition", { daySchedule: sched("hoh-competition", false) }));
    const due = buildSystemPrompt("hoh-competition", withPhase(base(), "hoh-competition", { daySchedule: sched("hoh-competition", true) }));
    const pend = buildSystemPrompt("hoh-competition", withPhase(base(), "hoh-competition", { daySchedule: sched("hoh-competition", false), pending: { kind: "comp-round", by: { id: "player", name: "P" }, prompt: "x", options: [] } as never }));
    expect(notDue).toMatch(/Head of Household competition has NOT started/);
    expect(due).not.toMatch(/has NOT started/);
    expect(pend).not.toMatch(/has NOT started/);
  });
});
