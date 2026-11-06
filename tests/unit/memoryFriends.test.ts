import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { FRIEND_MEMORY, friendSeverity, NPC_MEMORY, SCENE_MEMORY_SEVERITY } from "../../src/engine/npcMemory";

/**
 * B25 (flag ORWELL_MEMORY_FRIENDS, off by default) - treatment of friends: a recorded player scene that touches a houseguest is also remembered by that houseguest's CLOSEST ties, smaller and bond-weighted,
 * within the per-pair cap; only RECORDED witnessed scenes reach this writer (a hidden/sealed event never calls it); flag off => nothing extra is written. Deterministic, no rng. Roles only.
 */
describe("friendSeverity", () => {
  it("is 0 below the closeness bar, then monotone in bond, always under the scene's own severity", () => {
    expect(friendSeverity(0.6, FRIEND_MEMORY.minBond - 0.01)).toBe(0);
    let prev = 0;
    for (const b of [0.55, 0.65, 0.75, 0.85, 1]) { const v = friendSeverity(0.6, b); expect(v).toBeGreaterThanOrEqual(prev); expect(v).toBeLessThan(0.6); prev = v; }
    expect(friendSeverity(0.6, 1)).toBeCloseTo(0.6 * FRIEND_MEMORY.factor, 9);
  });
});

type G = { rememberPlayerScene(holders: string[], kind: string): void; setMemoryFriendsEnabled(on: boolean): void };
type Ledger = Record<string, Record<string, { kind: string; severity: number }[]>>;
function game() {
  const sb = new GameSessionRegistry().sandboxFor(`friends-${Math.random()}`);
  sb.session.createCharacter({ playerName: "P", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const npcs = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  const ledger = (): Ledger => ((sb.session.snapshot().live as { npcMemory?: Ledger }).npcMemory ?? {});
  return { sb, g: sb.session as unknown as G, npcs, ledger, rel: sb.engine.relationships };
}
describe("through the real session", () => {
  it("flag off: only the touched houseguest remembers (today's behaviour)", () => {
    const { g, npcs, ledger, rel } = game();
    g.setMemoryFriendsEnabled(false); // pinned OFF explicitly: the flag now defaults ON
    const [touched, friend] = npcs;
    for (const [a, b] of [[friend!, touched!], [touched!, friend!]] as const) { rel.edge(a, b).trust = 0.95; rel.edge(a, b).affinity = 0.95; }
    g.rememberPlayerScene([touched!], "betrayal");
    expect(Object.keys(ledger())).toEqual([touched]);
  });
  it("on: a close friend remembers it smaller than the touched one, a distant one not at all, and a closer friend remembers more", () => {
    const { g, npcs, ledger, rel } = game();
    g.setMemoryFriendsEnabled(true);
    const [touched, close, closer, far] = npcs;
    const bond = (f: string, v: number): void => { rel.edge(f, touched!).trust = v; rel.edge(f, touched!).affinity = v; };
    bond(close!, 0.7); bond(closer!, 0.95); bond(far!, 0.1);
    g.rememberPlayerScene([touched!], "betrayal");
    const L = ledger();
    const own = L[touched!]![PLAYER]![0]!.severity;
    const sc = L[close!]?.[PLAYER]?.[0], sr = L[closer!]?.[PLAYER]?.[0];
    expect(sc && sr, "both friends remember").toBeTruthy();
    expect(sc!.kind).toBe("scene-betrayal");
    expect(sc!.severity).toBeLessThan(own);
    expect(sr!.severity).toBeGreaterThan(sc!.severity);
    expect(L[far!]?.[PLAYER]).toBeUndefined();
    expect(own).toBe(SCENE_MEMORY_SEVERITY["betrayal"]!.severity);
  });
  it("a friend who is also a touched houseguest is not double-counted; the per-pair cap holds under repeated scenes", () => {
    const { g, npcs, ledger, rel } = game();
    g.setMemoryFriendsEnabled(true);
    const [a, b] = npcs;
    for (const [x, y] of [[a!, b!], [b!, a!]] as const) { rel.edge(x, y).trust = 0.95; rel.edge(x, y).affinity = 0.95; }
    for (let i = 0; i < 20; i++) g.rememberPlayerScene([a!, b!], "betrayal");
    const L = ledger();
    expect(L[a!]![PLAYER]!.length).toBeLessThanOrEqual(NPC_MEMORY.maxEntriesPerPair);
    expect(L[b!]![PLAYER]!.length).toBeLessThanOrEqual(NPC_MEMORY.maxEntriesPerPair);
  });
  it("kinds that write nothing (a strategy chat) write nothing for friends either", () => {
    const { g, npcs, ledger, rel } = game();
    g.setMemoryFriendsEnabled(true);
    const [touched, friend] = npcs;
    rel.edge(friend!, touched!).trust = 0.95; rel.edge(friend!, touched!).affinity = 0.95;
    g.rememberPlayerScene([touched!], "strategy");
    expect(ledger()).toEqual({});
  });
});
