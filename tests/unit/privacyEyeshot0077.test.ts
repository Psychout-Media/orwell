import { describe, it, expect, vi } from "vitest";
// ORW-212: tracks who moved where; the calm re-seat (ORW-212) changes how often anyone moves; this test pins the previous (non-calm) movement so its seeded premise holds. The calm movement has its own tests (calmPresence.test.ts).
vi.hoisted(() => { process.env.ORWELL_CALM_PRESENCE = "0"; });
import { rollOverhears } from "../../src/engine/presence";
import { PRESENCE, PRIVACY } from "../../src/engine/presenceConstants";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Room, Occupancy } from "../../src/domain/house";
import type { RandomnessSource } from "../../src/ports/RandomnessSource";
import { adrFixture } from "../support/adr0003";

/**
 * Feature 0077 Phase 2 — the privacy payoff at the unit level. The load-bearing guarantee is
 * CALIBRATION NEUTRALITY: the new behaviors are opt-in and read-side, so the off-screen society /
 * juryReach spine (which passes NONE of the new params) is byte-identical. Plus tracked-occupancy
 * persistence (0007 non-degradation) and the Vault-safety of the conspicuousness read. Roles only.
 */

/** Wraps an rng to COUNT draws, so we can prove a no-op muffle changes no draw consumption. */
class CountingRng implements RandomnessSource {
  draws = 0;
  constructor(private readonly inner: RandomnessSource) {}
  next(): number { this.draws++; return this.inner.next(); }
  int(maxExclusive: number): number { this.draws++; return this.inner.int(maxExclusive); }
  pick<T>(items: readonly T[]): T { this.draws++; return this.inner.pick(items); }
  fork(label: string): RandomnessSource { return this.inner.fork(label); }
}

const SCENE_CONTENT = "a long quiet scheme by the pair";

/** A scheme inside a closed bedroom; the only listener is an NPC next door (adjacent), plus a
 *  non-adjacent NPC who must NEVER hear. NPC listeners (not the player) so the ear-pick int() draw —
 *  the conditional draw that desyncs a stream if mishandled — is actually exercised. A knowledge
 *  service wired to an event store holding the scene (so the `overheard:` surfacing is anchored). */
function scene(): { occ: Occupancy; knowledge: InMemoryKnowledgeService } {
  const occ: Occupancy = new Map<EntityId, Room>([
    [npc(1), "bedroom-a"], [npc(2), "bedroom-a"],   // the schemers
    [npc(3), "hallway"],                            // adjacent to bedroom-a — a possible overhearer
    [npc(4), "kitchen"],                            // not adjacent — never hears
  ]);
  const events = new InMemoryEventStore();
  events.record({ id: "e", ts: 1, type: "conversation", initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: SCENE_CONTENT });
  return { occ, knowledge: new InMemoryKnowledgeService(events) };
}

describe("0077 door-muffle — opt-in and calibration-neutral", () => {
  it("no muffle param consumes byte-identical draws AND returns the same result as muffle:1", () => {
    for (let seed = 0; seed < 60; seed++) {
      const a = scene(); const b = scene();
      const rngA = new CountingRng(new SeededRandom(seed));
      const rngB = new CountingRng(new SeededRandom(seed));
      const resA = rollOverhears({ eventId: "e", room: "bedroom-a", content: SCENE_CONTENT, participants: [npc(1), npc(2)], occupancy: a.occ, knowledge: a.knowledge, rng: rngA });
      const resB = rollOverhears({ eventId: "e", room: "bedroom-a", content: SCENE_CONTENT, participants: [npc(1), npc(2)], occupancy: b.occ, knowledge: b.knowledge, rng: rngB, muffle: 1 });
      expect(resA).toEqual(resB);          // same listener chosen (or none)
      expect(rngA.draws).toBe(rngB.draws); // and the SAME number of draws consumed — no stream desync
    }
  });

  it("muffle < 1 lowers the overhear hit rate but never changes WHO can hear (only the probability)", () => {
    let openNoMuffle = 0, openMuffled = 0;
    const N = 600;
    for (let seed = 0; seed < N; seed++) {
      const plain = rollOverhears({ eventId: "e", room: "bedroom-a", content: SCENE_CONTENT, participants: [npc(1), npc(2)], occupancy: scene().occ, knowledge: scene().knowledge, rng: new SeededRandom(seed) });
      const muff = rollOverhears({ eventId: "e", room: "bedroom-a", content: SCENE_CONTENT, participants: [npc(1), npc(2)], occupancy: scene().occ, knowledge: scene().knowledge, rng: new SeededRandom(seed), muffle: PRESENCE.doorMuffle });
      if (plain.length) { openNoMuffle++; expect(plain).toEqual([npc(3)]); }    // only the adjacent NPC ever hears
      if (muff.length) { openMuffled++; expect(muff).toEqual([npc(3)]); }       // never the non-adjacent one
    }
    expect(openMuffled).toBeLessThan(openNoMuffle);   // a closed door is harder to hear into
    expect(openMuffled).toBeGreaterThan(0);           // but not impossible
  });
});

describe("0077 tracked occupancy — persists across a save/restore (0007 non-degradation)", () => {
  it("a witnessed closed-door sighting survives a snapshot → JSON round-trip → restore", () => {
    const s = adrFixture("u-track", 7).sb.session;
    // Pin the player where they can SEE the hallway, and an NPC in the hallway, then watch them slip in.
    const core0 = s.snapshot();
    const subject = npc(1);
    core0.presence = { [PLAYER]: "living-room", [subject]: "hallway" } as Record<EntityId, Room>;
    // 0111: clear the premiere's gathered champagne-circle flag so whereabouts reads the seated presence
    // (and the tracked/eyeshot layer), not the opening toast (which pins the whole house co-present).
    (core0.live as { champagneCircle?: string }).champagneCircle = undefined;
    s.restore(core0);
    s.recordHouseguestMove(subject, "bedroom-a"); // witnessed (living-room sees the hallway mouth)
    const before = s.whereabouts()!.tracked;
    expect(before.some((t) => t.id === subject && t.room === "bedroom-a")).toBe(true);

    // Round-trip the snapshot through "disk" and load it into a FRESH session instance.
    const core = JSON.parse(JSON.stringify(s.snapshot()));
    expect(core.trackedSightings, "the belief is serialized").toBeTruthy();
    const s2 = adrFixture("u-track-2", 7).sb.session;
    s2.restore(core);
    const after = s2.whereabouts()!.tracked;
    const restored = after.find((t) => t.id === subject);
    expect(restored, "belief survives the restart").toBeTruthy();
    expect(restored!.room).toBe("bedroom-a");
    expect(restored!.pathway.length).toBeGreaterThan(0);          // pathway preserved
    expect(restored!.confidence).toBe(PRIVACY.trackedConfidence); // confidence preserved
  });
});

describe("0077 conspicuousness — Vault-safe (who/where/how-long, never the content)", () => {
  it("the read names where, fires for a tracked pair, and leaks no hidden-layer state", () => {
    const s = adrFixture("u-consp", 7).sb.session;
    const core0 = s.snapshot();
    core0.presence = { [PLAYER]: "living-room", [npc(1)]: "hallway", [npc(2)]: "hallway" } as Record<EntityId, Room>;
    (core0.live as { champagneCircle?: string }).champagneCircle = undefined; // 0111: see the note above
    s.restore(core0);
    s.recordHouseguestMove(npc(1), "lounge");
    s.recordHouseguestMove(npc(2), "lounge");
    // Age the sightings past the conspicuousness tenure threshold (bump the presence clock only).
    const aged = s.snapshot();
    aged.presenceTickCount = (aged.presenceTickCount ?? 0) + 4;
    s.restore(aged);

    const reads = s.conspicuousReads();
    expect(reads.length).toBe(1);
    expect(/lounge/i.test(reads[0]!)).toBe(true);
    // No hidden-layer keys ever ride the view (the conspicuous read is who/where/how-long only).
    const blob = JSON.stringify(s.whereabouts());
    expect(/trust|threat|affinity|motive|soul|hiddenElement/i.test(blob)).toBe(false);
  });
});
