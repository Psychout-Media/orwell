import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * N-17 vs 0092 (AMEND 3a item 0): a secret the engine delivers to the player OFF the tool path (the confidant slip / gossip chain, run inside the orchestrator tick) leaves a small
 * Vault-free delivery MARKER on the state read - the source's public id and a counter, never content - so the front-end can tell "the engine just surfaced something to the player" from
 * "the narrator invented a confession". Absent until a delivery happens (byte-identical). Roles only.
 */
function season(user: string, seed: number): UserSandbox {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return sb;
}
const marker = (sb: UserSandbox): { n: number; sourceId: string } | undefined =>
  (sb.session.getGameState() as unknown as { surfacedToPlayer?: { n: number; sourceId: string } }).surfacedToPlayer;

describe("the engine records a delivery marker when a thread surfaces to the player", () => {
  it("no marker before any delivery", () => {
    expect(marker(season("ddm-none", 4))).toBeUndefined();
  });

  it("a forced player-channel surface sets the marker with the source id and a counter, no content", () => {
    const sb = season("ddm-on", 4);
    const s = sb.session as unknown as {
      storyThreads: Array<{ sourceId: string; id: string; status: string }>;
      surfaceThread: (t: unknown, pos: unknown, rng: unknown, force?: "player" | "gossip") => void;
      seasonPositionForTest?: () => unknown;
    };
    const t = s.storyThreads[0]!;
    // drive the private surface path directly with the player channel forced (the same call pacingDrip makes)
    const pos = { evicted: new Set<string>() };
    s.surfaceThread(t, pos, { next: () => 0.5, int: () => 0 }, "player");
    const m = marker(sb);
    expect(m, "a delivery to the player leaves a marker").toBeDefined();
    expect(m!.sourceId).toBe(t.sourceId);
    expect(m!.n).toBe(1);
    expect(JSON.stringify(m)).not.toMatch(/secret|truth|premise/i); // ids and a counter only
    expect(m!.sourceId).not.toBe(PLAYER);
  });

  it("a gossip-only surface (NPC to NPC) leaves NO marker", () => {
    const sb = season("ddm-gossip", 4);
    const s = sb.session as unknown as {
      storyThreads: Array<{ sourceId: string }>;
      surfaceThread: (t: unknown, pos: unknown, rng: unknown, force?: "player" | "gossip") => void;
    };
    s.surfaceThread(s.storyThreads[0]!, { evicted: new Set<string>() }, { next: () => 0.5, int: () => 0 }, "gossip");
    expect(marker(sb)).toBeUndefined();
  });
});
