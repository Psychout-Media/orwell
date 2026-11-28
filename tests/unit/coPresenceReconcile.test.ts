import { describe, it, expect } from "vitest";
import { RelationshipModel } from "../../src/engine/relationships";
import { RELATIONSHIP_CONSTANTS } from "../../src/engine/relationshipConstants";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Room, Zone, Occupancy } from "../../src/domain/house";

/**
 * BL-014 — CO-PRESENCE RECONCILIATION (the fix dropped from PR #1721 for fighting the beatSeq spine +
 * the M0-9 seating-freeze; rebuilt ENGINE-SIDE). The model / FE belts (`_auto_record_scene`, the E22
 * fallback) can name a `withIds` participant the engine's OWN occupancy places in a DIFFERENT room — a
 * PHANTOM co-presence. Recorded, it makes engine truth internally inconsistent (the EventStore says they
 * witnessed a scene presence says they weren't in), and that contradiction re-injects on every recall +
 * relationship fold — a non-degradation breach we must NOT persist. `recordInteraction` reconciles at the
 * fold boundary: when the scene is GROUNDED (occupancy known AND the initiator has a room), drop any
 * caller-named non-player witness the occupancy positively places elsewhere, BEFORE the witness set / the
 * directed relationship fold / the premiere hot-read read it — never the player or the initiator, and
 * failing OPEN (no provider / placeless / unplaced initiator ⇒ keep everyone, so a presence hiccup never
 * zeroes the 0055 consequence-recording safety net). Roles only (no names — testing rule).
 */

const BASELINE_EDGE = { ...RELATIONSHIP_CONSTANTS.baseline, confidence: 0 };

interface Harness {
  commands: EngineCommandsAdapter;
  rel: RelationshipModel;
  events: InMemoryEventStore;
  knowledge: InMemoryKnowledgeService;
  /** The reconciled partner ids handed to the premiere hot-read sink on the last recorded scene. */
  reads: EntityId[][];
  /** Every (houseguest, content) pair indexed into semantic recall on the last recorded scene. */
  memos: EntityId[];
}

/**
 * A minimal, standalone command port with a STEERABLE occupancy (the presence provider seam), the
 * premiere hot-read sink, and the semantic-recall memo sink wired so a test can observe that ALL of the
 * reconciled reads (witness set, fold, hot-read, recall) use the SAME reconciled set. `occupancy === null`
 * ⇒ no provider ⇒ the fail-open path.
 */
function harness(occupancy: Occupancy | null, seed = 5, zones?: ReadonlyMap<EntityId, Zone>): Harness {
  const rel = new RelationshipModel(0.5);
  const events = new InMemoryEventStore();
  const knowledge = new InMemoryKnowledgeService(events);
  const commands = new EngineCommandsAdapter(events, knowledge, rel, new SeededRandom(seed));
  const reads: EntityId[][] = [];
  const memos: EntityId[] = [];
  commands.setPresenceProvider(() => occupancy);
  if (zones) commands.setZoneProvider((id) => zones.get(id));
  commands.setPlayerReadSink((ids) => reads.push([...ids]));
  commands.setSoulMemo((hg) => memos.push(hg));
  return { commands, rel, events, knowledge, reads, memos };
}

const witnessOf = (h: Harness, eventId: string): readonly EntityId[] =>
  h.events.queryAll().find((e) => e.id === eventId)!.witnessSet;

describe("BL-014 — co-presence reconciliation (engine-side, at the fold boundary)", () => {
  it("DROPS a caller-named non-player witness the occupancy places in a DIFFERENT room", () => {
    // The scene is in the backyard; the belt also named npc(2), whom the engine knows is in the kitchen.
    const occ = new Map<EntityId, Room>([
      [PLAYER, "backyard"], [npc(1), "backyard"], [npc(2), "kitchen"],
    ]);
    const h = harness(occ);
    const before = { ...h.rel.edge(npc(2), PLAYER) };
    const { eventId } = h.commands.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, npc(1), npc(2)], kind: "bonding",
      content: "a quiet talk by the pool",
    });
    const ws = witnessOf(h, eventId);
    expect(ws).toContain(npc(1));       // same room ⇒ a legitimate co-witness, kept
    expect(ws).not.toContain(npc(2));   // phantom (kitchen ≠ backyard) ⇒ dropped BEFORE it is recorded
    expect(ws).toContain(PLAYER);
    // The directed relationship fold used the reconciled set: the phantom's edge toward the initiator
    // never moved (recording a scene they weren't in must not fold their hidden opinion).
    expect(h.rel.edge(npc(2), PLAYER)).toEqual(before);
    expect(h.rel.edge(npc(2), PLAYER)).toEqual(BASELINE_EDGE);
    // The same-room partner's edge DID move — the real scene still has its real consequence.
    expect(h.rel.edge(npc(1), PLAYER)).not.toEqual(BASELINE_EDGE);
  });

  it("DROPS a same-room named witness in a far zone (ORW-1167: earshot is the witness set) and KEEPS a same-zone one", () => {
    // npc(1) is in the SAME room (backyard) but the far sub-zone, out of earshot: a named participant the
    // player could not be heard by is not a witness and takes no fold. npc(2) shares the player's zone and stays.
    const occ = new Map<EntityId, Room>([[PLAYER, "backyard"], [npc(1), "backyard"], [npc(2), "backyard"]]);
    const zones = new Map<EntityId, Zone>([[PLAYER, "poolside"], [npc(1), "workout"], [npc(2), "poolside"]]);
    const h = harness(occ, 9, zones);
    const { eventId } = h.commands.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, npc(1), npc(2)], kind: "strategy", content: "a confidence at the pool",
    });
    expect(witnessOf(h, eventId)).not.toContain(npc(1));
    expect(witnessOf(h, eventId)).toContain(npc(2));
    expect(h.rel.edge(npc(1), PLAYER)).toEqual(BASELINE_EDGE);
    expect(h.rel.edge(npc(2), PLAYER)).not.toEqual(BASELINE_EDGE);
  });

  it("NEVER drops the player or the initiator, even when the occupancy places THEM elsewhere", () => {
    // An NPC-initiated scene the player witnessed: the scene room is the initiator's (kitchen), and the
    // player's own occupancy says backyard. Neither the player (their knowledge is the game) nor the
    // initiator may be dropped — only a THIRD phantom (npc(2), in the living-room) is.
    const occ = new Map<EntityId, Room>([
      [npc(1), "kitchen"], [PLAYER, "backyard"], [npc(2), "living-room"],
    ]);
    const h = harness(occ, 11);
    const { eventId } = h.commands.recordInteraction({
      initiator: npc(1), witnessSet: [PLAYER, npc(1), npc(2)], kind: "conflict",
      content: "a heated exchange",
    });
    const ws = witnessOf(h, eventId);
    expect(ws).toContain(PLAYER);       // never dropped, whatever the occupancy says
    expect(ws).toContain(npc(1));       // the initiator is never dropped
    expect(ws).not.toContain(npc(2));   // the third-party phantom is
  });

  it("fails OPEN when the scene is PLACELESS (the initiator is unplaced) — every named witness kept", () => {
    // The provider is wired, but the initiator has no occupancy entry ⇒ the scene isn't grounded ⇒ prior
    // behavior: nothing is reconciled, so even a differently-placed named witness stays (never zero the net).
    const occ = new Map<EntityId, Room>([[npc(1), "backyard"], [npc(2), "kitchen"]]); // PLAYER (initiator) absent
    const h = harness(occ, 13);
    const { eventId } = h.commands.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, npc(1), npc(2)], kind: "bonding", content: "an ungrounded scene",
    });
    const ws = witnessOf(h, eventId);
    expect(ws).toContain(npc(1));
    expect(ws).toContain(npc(2)); // kept despite the different-room occupancy — the scene wasn't grounded
    expect(h.rel.edge(npc(2), PLAYER)).not.toEqual(BASELINE_EDGE); // and it still takes its fold
  });

  it("fails OPEN when NO presence provider is wired at all — prior behavior, every witness kept", () => {
    const h = harness(null, 17); // occupancy === null ⇒ no provider
    const { eventId } = h.commands.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, npc(1), npc(2)], kind: "bonding", content: "no-provider scene",
    });
    const ws = witnessOf(h, eventId);
    expect(ws).toEqual(expect.arrayContaining([PLAYER, npc(1), npc(2)]));
  });

  it("the RECORDED witness set, the directed FOLD, the premiere HOT-READ, and semantic RECALL all use the reconciled set", () => {
    // One grounded scene with a phantom (npc(3) in the hoh-room): assert the reconciled set flows to
    // every downstream consumer — nothing derived from the scene may reference the phantom.
    const occ = new Map<EntityId, Room>([
      [PLAYER, "backyard"], [npc(1), "backyard"], [npc(3), "hoh-room"],
    ]);
    const h = harness(occ, 23);
    const before3 = { ...h.rel.edge(npc(3), PLAYER) };
    const { eventId } = h.commands.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, npc(1), npc(3)], kind: "alliance", content: "a real bond forms",
    });
    // 1) recorded witness set
    expect(witnessOf(h, eventId)).not.toContain(npc(3));
    // 2) directed relationship fold
    expect(h.rel.edge(npc(3), PLAYER)).toEqual(before3);
    // 3) premiere hot-read sink (caller-named partners, minus the player) — phantom absent, real read present
    const lastRead = h.reads.at(-1) ?? [];
    expect(lastRead).toContain(npc(1));
    expect(lastRead).not.toContain(npc(3));
    // 4) semantic-recall memo — indexed only for the reconciled witnesses (never the phantom)
    expect(h.memos).toContain(npc(1));
    expect(h.memos).not.toContain(npc(3));
    // Vault-free by construction: the reconciliation reads only the Vault-free occupancy (rooms). The
    // dropped phantom is handed NO knowledge of the scene through any pathway (nothing routed to it).
    expect(h.knowledge.knownTo(npc(3))).toEqual([]);
  });

  it("still ADDS true co-present occupants (co-presence expansion is untouched — reconciliation only DROPS named phantoms)", () => {
    // An unnamed same-room occupant (npc(4)) is still promoted to a witness; a named phantom (npc(2)) is
    // still dropped. Reconciliation narrows the caller's NAMED set; presence grounding still widens it.
    const occ = new Map<EntityId, Room>([
      [PLAYER, "kitchen"], [npc(4), "kitchen"], [npc(2), "backyard"],
    ]);
    const h = harness(occ, 29);
    const { eventId } = h.commands.recordInteraction({
      initiator: PLAYER, witnessSet: [PLAYER, npc(2)], kind: "gossip", content: "kitchen chatter",
    });
    const ws = witnessOf(h, eventId);
    expect(ws).toContain(npc(4));      // co-present, unnamed ⇒ added by presence grounding
    expect(ws).not.toContain(npc(2));  // named phantom ⇒ reconciled away
  });
});
