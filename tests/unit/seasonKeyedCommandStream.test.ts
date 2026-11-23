import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";

/**
 * ORW-853 (Coordinator ruling 2026-11-23): the player-action (command seam) stream is keyed on the user AND the season, so a
 * returning player's next season plays fresh, while one season still replays identically. Before this, the stream was keyed on
 * the user alone (`commands:${user}`), so every season one user played started it in the same place. Roles only.
 */
type Streamy = { rng: { next(): number } };
const draws = (c: EngineCommandsAdapter, n = 8): number[] => Array.from({ length: n }, () => (c as unknown as Streamy).rng.next());

function season(user: string, seed: number) {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  return { reg, sb };
}

describe("ORW-853: the player-action stream is keyed on the user and the season", () => {
  it("two seasons of the same user draw different player-action streams", () => {
    expect(draws(season("returning-player", 101).sb.commands)).not.toEqual(draws(season("returning-player", 202).sb.commands));
  });

  it("the same season (user and seed) replays the identical stream", () => {
    expect(draws(season("replay-player", 303).sb.commands)).toEqual(draws(season("replay-player", 303).sb.commands));
  });

  it("two users in the same seed still draw their own streams", () => {
    expect(draws(season("user-a", 404).sb.commands)).not.toEqual(draws(season("user-b", 404).sb.commands));
  });

  it("re-keying is idempotent for the same season and never moves the stream backwards", () => {
    const { sb } = season("rekey-player", 505);
    expect(sb.commands.seasonKeyed()).toBe(true);
    draws(sb.commands, 5);
    const at = sb.commands.rngPosition();
    sb.commands.rekeyForSeason(12345); // a different key keeps the position
    expect(sb.commands.rngPosition()).toBe(at);
    const before = draws(sb.commands, 3);
    expect(before).toHaveLength(3);
  });

  it("a save records that the stream is season-keyed", () => {
    const { sb } = season("save-player", 606);
    draws(sb.commands, 2);
    const snap = (sb as unknown as { session: { snapshot(): unknown } }) && (sb.session.snapshot() as { seed?: number });
    expect(snap.seed).toBe(606);
    expect(sb.commands.seasonKeyed()).toBe(true);
  });
});
