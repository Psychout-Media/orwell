import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { DESIRE } from "../../src/engine/desireClock";
import { heldApproachReaction, heldSheetOf, HELD_REACTIONS } from "../../src/engine/heldApproach";

/** ORW-452 point 2: what a houseguest the approach cap held back does next comes from THEIR sheet. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

describe("the pure sheet rule", () => {
  it("each reaction is what a particular sheet produces", () => {
    expect(heldApproachReaction(heldSheetOf("hothead", 0.5))).toBe("comes-straight-back");   // persistent and impatient
    expect(heldApproachReaction(heldSheetOf("analyst", 0.5))).toBe("waits");                 // patient
    expect(heldApproachReaction(heldSheetOf("villain", 0.1))).toBe("gives-up");              // proud and cold to the player
    expect(new Set(HELD_REACTIONS).size).toBe(3);
  });
  it("the same archetype changes its mind with how it feels about the player", () => {
    expect(heldApproachReaction(heldSheetOf("villain", 0.1))).toBe("gives-up");
    expect(heldApproachReaction(heldSheetOf("villain", 0.95))).not.toBe("gives-up");
  });
});

type Priv = { live: { playedGame?: boolean; desireApproachedAt?: Record<string, number>; goalApproaches?: Record<string, unknown>; approachStreak?: unknown }; absHour(): number; noteApproach(npc: string, desire: string | undefined, capped?: boolean): void; agendaCharacterOf: unknown; rel: unknown };
let n = 0;
function game(archetype: string, affinity: number, played = true) {
  const s = new GameSessionRegistry().sandboxFor(`held452-${n++}`).session;
  s.createCharacter({ playerName: "P", seed: 9 });
  const p = s as unknown as Priv;
  p.live.playedGame = played;
  p.agendaCharacterOf = () => ({ archetype, strategyStyle: "social" });
  p.rel = { edge: () => ({ affinity, trust: 0.5, threat: 0 }) };
  const npc = s.livingIds().find((id) => id !== (s.getGameState() as unknown as { player: { id: string } }).player.id)!;
  p.live.goalApproaches = { [npc]: { desire: "campaign", goalId: "g", hour: 0 } };
  return { s, p, npc };
}

describe("a held-back houseguest decides from their sheet", () => {
  it("comes straight back: the want is kept (no cooldown stamped, the goal that brought them stands)", () => {
    const { p, npc } = game("hothead", 0.5);
    p.noteApproach(npc, "campaign", true);
    expect(p.live.desireApproachedAt?.[npc]).toBeUndefined();
    expect(p.live.goalApproaches?.[npc]).toBeDefined();
  });
  it("waits: the want is spent with the normal 3-hour cooldown", () => {
    const { p, npc } = game("analyst", 0.5);
    p.noteApproach(npc, "campaign", true);
    expect(p.live.desireApproachedAt?.[npc]).toBe(p.absHour());
    expect(p.live.goalApproaches?.[npc]).toBeUndefined();
  });
  it("gives up: a second cooldown on top of the normal one", () => {
    const { p, npc } = game("villain", 0.1);
    p.noteApproach(npc, "campaign", true);
    expect(p.live.desireApproachedAt?.[npc]).toBe(p.absHour() + DESIRE.cooldownHours);
    expect(p.live.goalApproaches?.[npc]).toBeUndefined();
  });
  it("is deterministic", () => {
    const a = game("floater", 0.4); const b = game("floater", 0.4);
    a.p.noteApproach(a.npc, "campaign", true); b.p.noteApproach(b.npc, "campaign", true);
    expect(JSON.stringify(a.p.live.desireApproachedAt ?? {})).toBe(JSON.stringify(b.p.live.desireApproachedAt ?? {}));
  });
  it("a shown approach (not held) and a headless game are exactly as before: the want is spent", () => {
    const shown = game("hothead", 0.5);
    shown.p.noteApproach(shown.npc, "campaign", false);
    expect(shown.p.live.desireApproachedAt?.[shown.npc]).toBe(shown.p.absHour());
    const headless = game("hothead", 0.5, false);
    headless.p.noteApproach(headless.npc, "campaign", true);
    expect(headless.p.live.desireApproachedAt?.[headless.npc], "no cap in a headless game; the old path").toBe(headless.p.absHour());
  });
});
