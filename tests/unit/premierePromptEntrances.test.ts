import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { buildSystemPrompt, MOMENT_PROMPTS, renderGameContext } from "../../src/engine/momentPrompts";
import type { GameStateView } from "../../src/ports/GameSession";

/** A9 H2 - the premiere prompt switches on `premiere.entrance`; absent => the old champagne-circle text, byte-identical. Roles only. */
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const PREMIERE_SHA = "d4316fbbc165847346e139d2da490694dd24f1cd6249cd4abf0dc88592f0f516";

function board(): GameStateView {
  const s = new GameSessionAdapter();
  s.createCharacter({ playerName: "P", seed: 5 });
  return s.getGameState();
}
const withEntrance = (v: GameStateView, entrance: unknown): GameStateView =>
  ({ ...v, premiere: { ...v.premiere!, entrance } }) as unknown as GameStateView;

describe("premiere prompt - entrances (flag-off byte identity)", () => {
  it("the static premiere fragment is pinned byte-for-byte", () => {
    expect(sha(MOMENT_PROMPTS["premiere"]!)).toBe(PREMIERE_SHA);
  });
  it("no entrance on the board => the old fragment is used verbatim and no entrance lines render", () => {
    const v = board();
    expect(v.premiere, "precondition: a live premiere view").toBeTruthy();
    const p = buildSystemPrompt("premiere", v);
    expect(p).toContain(MOMENT_PROMPTS["premiere"]!);
    expect(p).not.toContain("ENTRANCES");
    expect(renderGameContext(v)).toContain("THE CHAMPAGNE CIRCLE (engine truth)");
  });
});

describe("premiere prompt - entrance stage", () => {
  const v = board();
  const guest = v.premiere!.met[0]!.houseguest;
  const entrances = withEntrance(v, {
    stage: "entrances", index: 3, total: 16, playerPosition: 9,
    arrivedNames: ["Inside One", "Inside Two"], justArrived: { id: guest.id, name: guest.name },
  });

  it("swaps beats (1)/(2) for entrances/toast, keeps the bedroom pick", () => {
    const p = buildSystemPrompt("premiere", entrances);
    expect(p).toContain("(1) ENTRANCES");
    expect(p).toContain("SHORT vignette");
    expect(p).toContain("(3) PICK A BEDROOM");
    expect(p).not.toContain("(1) INTRODUCTIONS");
    expect(p).not.toContain("THE GAME HAS ALREADY GATHERED THE WHOLE HOUSE");
  });
  it("entrances: names the arriver and the inside list; no roll-call gate on talking", () => {
    const ctx = renderGameContext(entrances);
    expect(ctx).toContain(`JUST ARRIVED: ${guest.name}`);
    expect(ctx).toContain("Inside One, Inside Two");
    expect(ctx).not.toContain("THE CHAMPAGNE CIRCLE (engine truth)");
    expect(buildSystemPrompt("premiere", entrances)).toMatch(/Never gate on the player talking/);
  });
  it("the player's own entrance is narrated from their POV", () => {
    const ctx = renderGameContext(withEntrance(v, { stage: "entrances", index: 9, total: 16, playerPosition: 9, arrivedNames: ["Inside One"], playerEntrance: true }));
    expect(ctx).toContain("THEIR point of view");
    expect(ctx).not.toContain("JUST ARRIVED");
  });
  it("toast: host first, generic voice, speakers as facts, player slot invited not forced", () => {
    const toast = withEntrance(v, { stage: "toast", index: 16, total: 16, playerPosition: 9, arrivedNames: [], speakers: [{ name: "Speaker One" }, { name: "Speaker Two" }] });
    const ctx = renderGameContext(toast);
    expect(ctx).toContain("Speakers this batch, in order: Speaker One, Speaker Two");
    expect(ctx).toContain("never force it");
    const p = buildSystemPrompt("premiere", toast);
    expect(p).toMatch(/HOST opens it first, in a generic production voice/);
    expect(p).toMatch(/your turn/);
  });
  it("sentinel: the entrance fragment and lines carry no ids or numeric-score strings", () => {
    const frag = buildSystemPrompt("premiere", entrances);
    const lines = renderGameContext(entrances).split("\n").filter((l) => /PREMIERE . (ENTRANCES|JUST ARRIVED|THE TOAST)/.test(l)).join("\n");
    expect(lines).not.toContain(guest.id);
    expect(lines).not.toMatch(/\b(trust|affinity|threat)\b/i);
    expect(frag).not.toMatch(/npc:\w+/);
  });
});
