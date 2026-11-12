import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import type { EdgeSignals } from "../../src/engine/relationshipConstants";
import type { Archetype, StrategyStyle } from "../../src/engine/characterFactory";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { jurorArchetypeFor } from "../../src/engine/juryMinds";
import type { EntityId } from "../../src/domain/ids";

/**
 * ORW-318 (ORW-253 slice 6, Ryne approved the NPC minds design 2026-11-12): in the LIVE game, (1) jurors vote by who they are and (2) an
 * NPC Final HOH weighs who they can beat in front of the jury. Real per-user sandbox restored to a crafted Final 3, driven through the
 * adapter. Roles only (HOH, ally, rival, juror).
 */
type Edge = { from: EntityId; to: EntityId } & EdgeSignals;
const edge = (from: EntityId, to: EntityId, s: Partial<EdgeSignals>): Edge =>
  ({ from, to, trust: 0.5, affinity: 0.5, threat: 0.3, alignment: 0, confidence: 0.5, reliability: 0.3, ...s });

async function finalThree(user: string, hohType: { archetype: Archetype; style: StrategyStyle }, mindsOn: boolean): Promise<EntityId> {
  const reg = new GameSessionRegistry();
  const player = reg.resolver()("player", user);
  await player.callTool("createCharacter", { playerName: "Player", seed: 31 });
  const snap = reg.snapshot(user) as SessionSnapshot;
  const npcs = (snap as unknown as { house: { npcs: Array<{ id: EntityId; character: { archetype: Archetype; strategyStyle: StrategyStyle } }> } }).house.npcs;
  const [hoh, ally, rival] = [npcs[0]!, npcs[1]!, npcs[2]!];
  hoh.character.archetype = hohType.archetype; hoh.character.strategyStyle = hohType.style;
  const out = [...npcs.slice(3).map((n) => n.id), "player"];
  const jurors = out.slice(out.length - 8);
  const live: LiveSeasonState = { week: 13, beat: "final-eviction", active: [hoh.id, ally.id, rival.id], hoh: hoh.id, vetoUsed: false, evictionOrder: out, finished: false };
  const edges: Edge[] = [
    // The HOH's bond with the ally is warm; the rival is the bigger threat.
    edge(hoh.id, ally.id, { trust: 0.85, affinity: 0.9, threat: 0.3 }),
    edge(hoh.id, rival.id, { trust: 0.2, affinity: 0.15, threat: 0.9 }),
  ];
  for (const j of jurors) {
    edges.push(edge(hoh.id, j, { trust: 0.5, affinity: 0.5 }));
    edges.push(edge(ally.id, j, { trust: 0.9, affinity: 0.9 })); // the ally is beloved: the HOH would lose to them
    edges.push(edge(rival.id, j, { trust: 0.1, affinity: 0.1 })); // the rival is disliked: the HOH would beat them
  }
  snap.live = live;
  snap.relationships = edges;
  reg.restore(user, snap);
  (reg.sandboxFor(user).session as GameSessionAdapter).setNpcMindsEndgameEnabled(mindsOn);
  await reg.resolver()("player", user).callTool("advanceGame", {});
  const after = reg.snapshot(user) as SessionSnapshot;
  const l = after.live as LiveSeasonState & { ceremony?: { finalEvictee?: EntityId } };
  const evicted = l.ceremony?.finalEvictee ?? l.evictionOrder[l.evictionOrder.length - 1]!;
  return evicted === ally.id ? "ally" : evicted === rival.id ? "rival" : evicted;
}

describe("the NPC Final HOH reasons from character (live)", () => {
  it("a strategist cuts the beloved ally they would lose to; a loyalist keeps the ally; the pre-ORW-318 rule cut the bigger threat", async () => {
    expect(await finalThree("orw318-a", { archetype: "mastermind", style: "strategic" }, true)).toBe("ally");
    expect(await finalThree("orw318-b", { archetype: "loyalist", style: "loyal" }, true)).toBe("rival");
    expect(await finalThree("orw318-c", { archetype: "mastermind", style: "strategic" }, false)).toBe("rival");
  });
});

describe("jurors vote by who they are (live ctx)", () => {
  it("every NPC's juror style comes from their own character, and is absent with the flag off", async () => {
    const reg = new GameSessionRegistry();
    const player = reg.resolver()("player", "orw318-j");
    await player.callTool("createCharacter", { playerName: "Player", seed: 7 });
    const s = reg.sandboxFor("orw318-j").session as GameSessionAdapter;
    const ctx = (s as unknown as { ctx(): { jurorArchetypeFor?: (j: EntityId) => string | undefined } }).ctx();
    const npcs = (reg.snapshot("orw318-j") as unknown as { house: { npcs: Array<{ id: EntityId }> } }).house.npcs;
    for (const n of npcs) expect(ctx.jurorArchetypeFor!(n.id)).toBe(jurorArchetypeFor(s.agendaCharacterOf(n.id)!, n.id, (s as unknown as { gameSeed: number }).gameSeed ?? 0));
    expect(ctx.jurorArchetypeFor!("player")).toBeUndefined();
    s.setNpcMindsEndgameEnabled(false);
    expect((s as unknown as { ctx(): { jurorArchetypeFor?: unknown } }).ctx().jurorArchetypeFor).toBeUndefined();
  });
});
