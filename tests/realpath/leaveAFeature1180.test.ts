import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { parsePlayerMoveIntent } from "../../src/engine/playerMoveIntent";
import { playedGame } from "../support/playedGame";

/**
 * ORW-1180: "get out of the pool and strip to my underwear" in the backyard moved the player to the kitchen ("pool" is a backyard alias, so leaving the pool read as leaving the room).
 * A thing in a room is no room: stepping out of it keeps the player where they are. A named room is still the move ("head to the shower" = the bathroom). Roles only.
 */
type Priv = { presence: Map<string, string>; houseEventInSession(): boolean };

describe("ORW-1180 leaving a feature is not leaving the room", () => {
  const stay = ["get out of the pool and strip to my underwear. I wonder if anyone would look.", "I get out of the pool", "I step out of the hot tub", "I get out of the bath", "I get off the sofa", "I leave the pool"];
  for (const t of stay) it(`no move: ${t}`, () => expect(parsePlayerMoveIntent(t, "backyard")).toBeNull());
  for (const t of ["strip", "I strip to my underwear", "I get up", "takes off my underwear"]) it(`a verb phrase with no room named moves nothing: ${t}`, () => expect(parsePlayerMoveIntent(t, "backyard")).toBeNull());

  it("positive controls: a named room still moves; leaving the room itself still exits", () => {
    expect(parsePlayerMoveIntent("go to the kitchen", "backyard")).toBe("kitchen");
    expect(parsePlayerMoveIntent("I get out of the backyard", "backyard")).toBe("kitchen");
    expect(parsePlayerMoveIntent("I leave the kitchen", "kitchen")).toBe("living-room");
    expect(parsePlayerMoveIntent("takes off my underwear and head to the shower", "backyard")).toBe("bathroom");
    expect(parsePlayerMoveIntent("I head to the shower", "kitchen")).toBe("bathroom");
  });

  it("played: the engine keeps the player in the backyard, then commits the named shower walk", () => {
    const g = playedGame({ seed: 1, user: "orw1180" });
    const p = g.s as unknown as Priv;
    for (let i = 0; i < 3000 && (p.houseEventInSession() || (g.s.getGameState() as { phase: string }).phase === "premiere"); i++) g.turn(); // a free moment: no gathering pins the player
    p.presence.set(PLAYER, "backyard");
    const r1 = g.s.resolvePlayerMove({ text: "get out of the pool and strip to my underwear. I wonder if anyone would look." });
    expect(r1.playerMove).toBeNull();
    expect(p.presence.get(PLAYER)).toBe("backyard");
    const r2 = g.s.resolvePlayerMove({ text: "takes off my underwear and head to the shower" });
    expect(r2.playerMove, JSON.stringify(r2.playerMove)).toMatchObject({ to: "bathroom" });
    expect(r2.playerMove?.refused, JSON.stringify(r2.playerMove)).toBeFalsy();
    expect(p.presence.get(PLAYER)).toBe("bathroom");
  });
});
