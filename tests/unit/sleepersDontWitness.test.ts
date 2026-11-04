import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import { linger } from "../support/linger";

/**
 * ADR 0006 / BDD audit Round 1b: a houseguest who has turned in for the night neither WITNESSES nor
 * OVERHEARS a player scene, even when presence still seats them in the player's room (or next door).
 * The player's own `whereabouts` already hides them, and the off-screen society skips them; recording a
 * scene must agree. Roles only.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

function resolve(s: GameSession, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round" || p.kind === "comp-intent") s.submitDecision({ kind: p.kind, intent: "compete" });
  else s.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id } as never);
}

/** A started season at night with at least one houseguest asleep and at least two awake. */
function nightHouse(): { sb: ReturnType<GameSessionRegistry["sandboxFor"]>; asleep: EntityId; awake: EntityId[] } {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  for (const seed of [3, 5, 8, 13, 21, 34, 55]) {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor(`sleep-witness-${seed}`);
    const s = sb.session;
    s.createCharacter({ playerName: "The Player", seed });
    for (let i = 0; i < 40; i++) {
      const npcs = s.livingIds().filter((id) => id !== PLAYER);
      if (s.gameStatus().timeOfDay) {
        for (let pass = 0; pass < 2; pass++) {
          const up = s.awakeAmong(npcs);
          if (up.length < npcs.length && up.length >= 2) {
            return { sb, asleep: npcs.find((id) => !up.includes(id))!, awake: up };
          }
          if (pass === 0) linger(s);
        }
      }
      const v = s.advanceGame();
      if (v.pending) resolve(s, v.pending);
    }
  }
  throw new Error("no seed reached a thinned night — test setup");
}

type Seatable = { presence: Map<EntityId, string> | null };

function seat(session: GameSession, seats: Array<[EntityId, string]>): void {
  (session as unknown as Seatable).presence = new Map(seats);
}

function witnessesOf(sb: ReturnType<GameSessionRegistry["sandboxFor"]>, eventId: string): EntityId[] {
  const ev = sb.engine.events.queryAll().find((e) => e.id === eventId);
  if (!ev) throw new Error(`event ${eventId} not recorded`);
  return [...ev.witnessSet];
}

describe("ADR 0006 — a houseguest who has turned in neither witnesses nor overhears", () => {
  it("a sleeper seated in the player's room is NOT a co-present witness; an awake one is", () => {
    const { sb, asleep, awake } = nightHouse();
    seat(sb.session, [[PLAYER, "kitchen"], [asleep, "kitchen"], [awake[0]!, "kitchen"], [awake[1]!, "backyard"]]);
    const { eventId } = sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER], content: "a late-night word" });
    const w = witnessesOf(sb, eventId);
    expect(w).toContain(awake[0]); // positive control: co-presence still witnesses
    expect(w).not.toContain(asleep);
  });

  it("a sleeper NAMED as a witness by the caller is dropped (a phantom witness)", () => {
    const { sb, asleep, awake } = nightHouse();
    seat(sb.session, [[PLAYER, "kitchen"], [asleep, "kitchen"], [awake[0]!, "kitchen"]]);
    const { eventId } = sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, asleep, awake[0]!], content: "a whispered plan" });
    const w = witnessesOf(sb, eventId);
    expect(w).toContain(awake[0]);
    expect(w).not.toContain(asleep);
  });

  it("a sleeper in the room next door never overhears, across many scenes", () => {
    const { sb, asleep } = nightHouse();
    // Kitchen ↔ living room are adjacent in the house map; seat ONLY the sleeper next door.
    seat(sb.session, [[PLAYER, "kitchen"], [asleep, "living-room"]]);
    const before = sb.engine.knowledge.knownTo(asleep).length;
    for (let i = 0; i < 60; i++) {
      sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER], content: `a loud plan number ${i}` });
    }
    expect(sb.engine.knowledge.knownTo(asleep).length).toBe(before);
  });

  it("clock OFF ⇒ identity: everyone seated in the room witnesses (byte-identical to the prior behavior)", () => {
    const { sb, asleep } = nightHouse();
    GameSessionAdapter.setTimeOfDayEnabled(false);
    seat(sb.session, [[PLAYER, "kitchen"], [asleep, "kitchen"]]);
    const { eventId } = sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER], content: "a daytime word" });
    expect(witnessesOf(sb, eventId)).toContain(asleep);
  });
});
