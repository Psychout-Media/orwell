import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import {
  HOUSE_ROOMS, HOUSE_ADJACENCY, areAdjacent, areVisible, isPrivateRoom, isZonedRoom,
  WALKABLE_ROOMS, ROOM_ZONES,
} from "../../src/domain/house";
import type { Room } from "../../src/domain/house";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

// Feature 0077 — house map, privacy & eyeshot. HARD rule: roles only — no names.
// The floor plan is pure data; the privacy payoff (tracked occupancy, conspicuousness, zone-scoped
// earshot) is driven through the real engine seams: controlled occupancy via snapshot/restore, a
// witnessed movement via `recordHouseguestMove`, and zone-scoped witnessing via the command adapter.

let pmUsers = 0;
function newGame(w: BbWorld, seed: number): void {
  const reg = new GameSessionRegistry();
  const user = `pm${pmUsers++}`;
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  // 0111: close the premiere champagne circle so whereabouts/movePlayer read the seated presence these
  // privacy/floor-plan scenarios drive — not the opening gathered toast (which pins the whole house).
  sb.session.advanceGame();
  w.pmRegistry = reg;
  w.pmUser = user;
  w.pmSandbox = sb;
}

/** Force the live occupancy (and, optionally, the presence-tick clock) directly — controlled fog-of-war. */
function place(w: BbWorld, occ: Map<EntityId, Room>, tick?: number): void {
  const sb = w.pmSandbox!;
  const core = sb.session.snapshot();
  core.presence = Object.fromEntries(occ) as Record<EntityId, Room>;
  if (tick !== undefined) core.presenceTickCount = tick;
  sb.session.restore(core);
}

/** Age every existing tracked sighting by `ticks` without moving anyone (bump the presence clock only). */
function age(w: BbWorld, ticks: number): void {
  const sb = w.pmSandbox!;
  const core = sb.session.snapshot();
  core.presenceTickCount = (core.presenceTickCount ?? 0) + ticks;
  sb.session.restore(core);
}

function whereabouts(w: BbWorld) {
  w.pmWhereabouts = w.pmSandbox!.session.whereabouts()!;
  return w.pmWhereabouts;
}

// ── Background ───────────────────────────────────────────────────────────────
Given("a started season on the recent-BB floor plan", function (this: BbWorld) {
  newGame(this, 77);
});

// ── Rule: The floor plan matches the owner's layout ──────────────────────────
Then("the bathroom is not adjacent to any bedroom", function () {
  for (const bed of ["bedroom-a", "bedroom-b", "bedroom-c"] as const) {
    assert.ok(!areAdjacent("bathroom", bed), `bathroom must not adjoin ${bed}`);
  }
});

Then("the bathroom is reachable through the living room", function () {
  // ORW-711 (owner ruling 2026-11-19): the bathroom is an off-shoot of the living room (the front door), not of the hallway.
  assert.ok(areAdjacent("bathroom", "living-room"), "the bathroom opens off the living room");
});

Then("the kitchen, living room, dining room, and backyard are mutually in sightline", function () {
  const core: readonly Room[] = ["kitchen", "living-room", "dining-room", "backyard"];
  for (const a of core) for (const b of core) {
    if (a === b) continue;
    assert.ok(areVisible(a, b), `${a} should see across the open core to ${b}`);
  }
});

Then("every room is reachable from every other room", function () {
  // BFS over the movement graph from one room; the whole house must be one connected component.
  const seen = new Set<Room>(["kitchen"]);
  const queue: Room[] = ["kitchen"];
  while (queue.length) {
    const r = queue.shift()!;
    for (const n of HOUSE_ADJACENCY.get(r) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  }
  assert.equal(seen.size, HOUSE_ROOMS.length, "the floor plan is fully connected");
});

Then("the diary room adjoins only the living room and cannot be overheard", function () {
  assert.deepEqual([...(HOUSE_ADJACENCY.get("diary-room") ?? [])], ["living-room"], "diary adjoins only the living room");
  assert.ok(isPrivateRoom("diary-room"), "the diary room is a sealed, opaque booth");
  // Unhearable by data: it is not a hangout (nobody lingers there to be overheard), and no room sees in.
  assert.ok(!WALKABLE_ROOMS.includes("diary-room"), "no one mills in the diary room");
  for (const r of HOUSE_ROOMS) assert.ok(!areVisible(r, "diary-room"), `${r} cannot see into the diary room`);
});

// ── Rule: Eyeshot is gated by sightline, never by raw adjacency ───────────────
Given("two houseguests are alone in a private bedroom", function (this: BbWorld) {
  this.pmBedroom = "bedroom-a";
  this.pmSubjects = [npc(1), npc(2)];
  // The player starts in the living room (adjacent to the hallway); the pair are sealed in the bedroom.
  place(this, new Map<EntityId, Room>([
    [PLAYER, "living-room"], [npc(1), "bedroom-a"], [npc(2), "bedroom-a"],
  ]));
});

Given("the player walks into the room adjacent to that bedroom", function (this: BbWorld) {
  // The bedroom adjoins only the hallway — walk there. No tracking exists (the player saw nothing).
  this.pmSandbox!.session.movePlayer("hallway");
  whereabouts(this);
});

Then("the player does not learn who is in the bedroom", function (this: BbWorld) {
  const w = this.pmWhereabouts!;
  const inBedroom = new Set(this.pmSubjects!);
  assert.ok(!w.present.some((p) => inBedroom.has(p.id)), "the pair are not in the player's room");
  assert.ok(!w.tracked.some((t) => inBedroom.has(t.id)), "no tracked belief without a witnessed pathway");
});

Then("the bedroom's occupants do not appear in the player's visible occupants", function (this: BbWorld) {
  const w = this.pmWhereabouts!;
  const inBedroom = new Set(this.pmSubjects!);
  // `nearby` is the sightline-scoped VISIBLE set — the closed bedroom is never in it.
  for (const n of w.nearby) {
    assert.ok(!areVisible(w.room as Room, "bedroom-a"), "no sightline penetrates the closed bedroom");
    assert.ok(!n.present.some((p) => inBedroom.has(p.id)), `the pair never appear in visible room ${n.room}`);
  }
});

Given("houseguests are spread across the kitchen, dining room, and backyard", function (this: BbWorld) {
  place(this, new Map<EntityId, Room>([
    [PLAYER, "living-room"], [npc(1), "kitchen"], [npc(2), "dining-room"], [npc(3), "backyard"], [npc(4), "hallway"],
  ]));
});

When("the player stands in the living room", function (this: BbWorld) {
  this.pmSandbox!.session.movePlayer("living-room");
  whereabouts(this);
});

Then("the player sees the occupants of the kitchen, dining room, and backyard", function (this: BbWorld) {
  const w = this.pmWhereabouts!;
  const roomOf = (r: string) => (w.nearby.find((n) => n.room === r)?.present ?? []).map((p) => p.id);
  assert.ok(roomOf("kitchen").includes(npc(1)), "sees the kitchen across the open core");
  assert.ok(roomOf("dining-room").includes(npc(2)), "sees the dining room across the open core");
  assert.ok(roomOf("backyard").includes(npc(3)), "sees the backyard across the open core");
});

Then("the player sees who is loitering in the hallway", function (this: BbWorld) {
  const w = this.pmWhereabouts!;
  const hall = w.nearby.find((n) => n.room === "hallway");
  assert.ok(hall, "the hallway mouth is visible from the living room");
  assert.ok(hall!.present.some((p) => p.id === npc(4)), "sees who is loitering in the hallway");
});

// ── Rule: Who is behind a closed door must be tracked, and can go stale ───────
Given("the player sees two houseguests head down the hallway into a bedroom", function (this: BbWorld) {
  this.pmSubjects = [npc(1), npc(2)];
  // The player is in the living room (sightline into the hallway mouth); the pair start in the hallway and
  // are watched heading into the bedroom — a real witnessed movement (the engine records the tracking).
  place(this, new Map<EntityId, Room>([
    [PLAYER, "living-room"], [npc(1), "hallway"], [npc(2), "hallway"],
  ]));
  this.pmSandbox!.session.recordHouseguestMove(npc(1), "bedroom-a");
  this.pmSandbox!.session.recordHouseguestMove(npc(2), "bedroom-a");
  whereabouts(this);
});

Then("the player holds a tracked belief that those two are in that bedroom", function (this: BbWorld) {
  const w = this.pmWhereabouts!;
  const inBed = w.tracked.filter((t) => t.room === "bedroom-a").map((t) => t.id).sort();
  assert.deepEqual(inBed, [...this.pmSubjects!].sort(), "both are tracked into the bedroom");
});

Then("that belief carries a pathway and a confidence", function (this: BbWorld) {
  const w = this.pmWhereabouts!;
  for (const t of w.tracked) {
    assert.ok(typeof t.pathway === "string" && t.pathway.length > 0, "the belief carries a pathway");
    assert.ok(typeof t.confidence === "number" && t.confidence > 0 && t.confidence <= 1, "and a confidence");
  }
});

Given("the player tracked two houseguests into a private room", function (this: BbWorld) {
  this.pmSubjects = [npc(1), npc(2)];
  place(this, new Map<EntityId, Room>([
    [PLAYER, "living-room"], [npc(1), "hallway"], [npc(2), "hallway"],
  ]));
  this.pmSandbox!.session.recordHouseguestMove(npc(1), "bedroom-a");
  this.pmSandbox!.session.recordHouseguestMove(npc(2), "bedroom-a");
});

When("one of them slips out unseen", function (this: BbWorld) {
  // npc(1) moves bedroom-a → bedroom-c. The origin (bedroom-a) is NOT in the player's eyeshot, so the
  // player never sees them leave — no correcting pathway lands; the stale belief must persist.
  this.pmSandbox!.session.recordHouseguestMove(npc(1), "bedroom-c");
  whereabouts(this);
});

Then("the player still believes both are inside until a new pathway corrects it", function (this: BbWorld) {
  const w = this.pmWhereabouts!;
  const stillBelieved = w.tracked.filter((t) => t.room === "bedroom-a").map((t) => t.id).sort();
  assert.deepEqual(stillBelieved, [...this.pmSubjects!].sort(), "the belief is NOT the live map — both still believed inside");
});

Given("two houseguests are alone in a private room", function (this: BbWorld) {
  this.pmSubjects = [npc(1), npc(2)];
  place(this, new Map<EntityId, Room>([
    [PLAYER, "living-room"], [npc(1), "bedroom-a"], [npc(2), "bedroom-a"],
  ]));
});

Given("no one has observed them enter", function (this: BbWorld) {
  // No witnessed movement was recorded — the engine holds no tracked belief for them.
  whereabouts(this);
});

Then("the player has no knowledge of who is in that room", function (this: BbWorld) {
  const w = this.pmWhereabouts!;
  const pair = new Set(this.pmSubjects!);
  assert.ok(!w.tracked.some((t) => pair.has(t.id)), "no pathway ⇒ no tracked belief");
  assert.ok(!w.present.some((p) => pair.has(p.id)), "not co-present");
  for (const n of w.nearby) assert.ok(!n.present.some((p) => pair.has(p.id)), "not visible");
});

// ── Rule: A big room holds multiple groups — eyeshot room-wide, earshot by zone ─
Given("one group talks by the pool and another at the workout corner of the backyard", function (this: BbWorld) {
  // Two groups in ONE room, different far zones. The player + npc(1) by the pool; npc(2) + npc(3) at the
  // workout corner. Eyeshot is room-wide (all in the backyard); earshot is zone-scoped.
  this.pmSubjects = [npc(2), npc(3)];
  const occ = new Map<EntityId, Room>([
    [PLAYER, "backyard"], [npc(1), "backyard"], [npc(2), "backyard"], [npc(3), "backyard"],
  ]);
  place(this, occ);
  const zones = new Map<EntityId, string>([
    [PLAYER, "poolside"], [npc(1), "poolside"], [npc(2), "workout"], [npc(3), "workout"],
  ]);
  this.pmSandbox!.commands.setPresenceProvider(() => occ);
  this.pmSandbox!.commands.setZoneProvider((id) => zones.get(id));
  // The player's group has a scene by the pool.
  const { eventId } = this.pmSandbox!.commands.recordInteraction({
    initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a quiet poolside scheme",
  });
  this.pmEventId = eventId;
  const ev = this.pmSandbox!.engine.events.queryAll().find((e) => e.id === eventId)!;
  this.pmWitnessSet = [...ev.witnessSet];
});

Then("neither group can overhear the other", function (this: BbWorld) {
  // The far-zone group is NOT auto-witnessed (zone-scoped earshot) and gains no overheard pathway.
  for (const id of this.pmSubjects!) {
    assert.ok(!this.pmWitnessSet!.includes(id), "a far-zone houseguest does not witness the scene");
    const overheard = this.pmSandbox!.engine.knowledge.knownTo(id).some((f) => f.pathway === `overheard:${this.pmEventId}`);
    assert.ok(!overheard, "and never overhears across the yard (different zone)");
  }
});

Then("each group can see that the other group is gathered across the yard", function (this: BbWorld) {
  // Eyeshot is room-wide: standing in the backyard, the player sees the other group in the same room.
  const w = whereabouts(this);
  assert.equal(w.room, "backyard");
  for (const id of this.pmSubjects!) {
    assert.ok(w.present.some((p) => p.id === id), "the other group is visible across the yard (same room)");
  }
});

// ── Rule: Two alone too long is a tell — without leaking the content ──────────
Given("the player tracked two houseguests into a private room together", function (this: BbWorld) {
  this.pmSubjects = [npc(1), npc(2)];
  place(this, new Map<EntityId, Room>([
    [PLAYER, "living-room"], [npc(1), "hallway"], [npc(2), "hallway"],
  ]));
  this.pmSandbox!.session.recordHouseguestMove(npc(1), "lounge");
  this.pmSandbox!.session.recordHouseguestMove(npc(2), "lounge");
  // Record (Vault-only) what they are actually doing in there — it must NEVER reach the player.
  this.pmHiddenContent = "SEALED-0077-the-pair-cut-a-secret-final-two-deal";
  this.pmSandbox!.engine.events.record({
    id: "pm:sealed:scene", ts: 9_000_001, type: "conversation",
    initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: this.pmHiddenContent,
  });
});

Given("they have remained there alone for a while", function (this: BbWorld) {
  age(this, 3); // past the conspicuousness tenure threshold
  whereabouts(this);
});

Then("the player receives a read that those two have been holed up together", function (this: BbWorld) {
  const reads = this.pmSandbox!.session.conspicuousReads();
  assert.equal(reads.length, 1, "exactly one conspicuousness read for the pair");
  this.pmWhereabouts = this.pmSandbox!.session.whereabouts()!;
  assert.ok((this.pmWhereabouts.conspicuous ?? []).length >= 1, "the read also rides the whereabouts view");
});

Then("that read names who and where and how long, never what was said", function (this: BbWorld) {
  const read = this.pmSandbox!.session.conspicuousReads()[0]!;
  const nameOf = (id: EntityId) => this.pmSandbox!.session.publicName(id);
  for (const id of this.pmSubjects!) {
    const name = nameOf(id);
    assert.ok(name && read.includes(name), "the read names who");
  }
  assert.ok(/lounge/i.test(read), "the read names where");
  assert.ok(/a while/i.test(read), "the read says how long");
  assert.ok(!read.includes(this.pmHiddenContent!), "the read never carries what was said");
});

Then("the houseguests' actual conversation never reaches the player", function (this: BbWorld) {
  for (const f of this.pmSandbox!.engine.knowledge.knownTo(PLAYER)) {
    assert.ok(!f.content.includes(this.pmHiddenContent!), "the sealed scene never crosses to the player");
  }
});

Given("a third houseguest witnessed the pair slip away together", function (this: BbWorld) {
  // The pair's actual scene is Vault-only (witness set excludes everyone else); the content must never
  // leak. The third houseguest holds only a Vault-free POSITION suspicion — who slipped off, not what.
  this.pmSubjects = [npc(1), npc(2)];
  this.pmSuspectId = npc(3);
  this.pmHiddenContent = "SEALED-0077-what-the-pair-actually-said";
  this.pmSandbox!.engine.events.record({
    id: "pm:diffuse:scene", ts: 9_000_002, type: "conversation",
    initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: this.pmHiddenContent,
  });
  this.pmSuspicionPathway = "witnessed-pair:pm:diffuse:scene";
  this.pmSandbox!.engine.knowledge.seedBelief(
    npc(3), { content: "(saw two of them slip off together)", factId: "pm:suspicion", confidence: 0.5 }, this.pmSuspicionPathway!,
  );
});

Then("that observation can diffuse to other houseguests as suspicion", function (this: BbWorld) {
  // It travels NPC-to-NPC like any belief — the witness passes the position suspicion along the social
  // graph (the 0038 gossip currency), reaching a houseguest who never saw the meeting.
  this.pmSandbox!.engine.knowledge.transmitGossip(
    this.pmSuspectId!, npc(4),
    { content: "(heard two of them slipped off together)", factId: "pm:suspicion", confidence: 0.4 }, this.pmSuspicionPathway!,
  );
  const fact = this.pmSandbox!.engine.knowledge.knownTo(npc(4)).find((f) => f.pathway === this.pmSuspicionPathway);
  assert.ok(fact, "the suspicion diffused to another houseguest");
  assert.ok(fact!.confidence! < 1, "and stayed suspicion (partial confidence), never certainty");
});

Then("no one learns the content of the private scene", function (this: BbWorld) {
  const everyone = [PLAYER, ...this.pmSandbox!.session.livingIds()];
  for (const id of everyone) {
    for (const f of this.pmSandbox!.engine.knowledge.knownTo(id)) {
      assert.ok(!f.content.includes(this.pmHiddenContent!), `the sealed content never reaches ${id}`);
    }
  }
});

// ── Rule: Privacy is scarce in the public core (the early-game crunch) ────────
Given("the player pulls a houseguest aside in the kitchen", function (this: BbWorld) {
  const occ = new Map<EntityId, Room>([
    [PLAYER, "kitchen"], [npc(1), "kitchen"], [npc(2), "kitchen"],
  ]);
  place(this, occ);
  this.pmSandbox!.commands.setPresenceProvider(() => occ);
  const { eventId } = this.pmSandbox!.commands.recordInteraction({
    initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a hushed kitchen aside",
  });
  this.pmEventId = eventId;
  this.pmSuspectId = npc(2); // the bystander in the open core
});

Given("other houseguests are present in the open-plan core", function (this: BbWorld) {
  // Already seated above (npc(2) is in the kitchen, the open public core — no privacy there).
  assert.ok(this.pmSuspectId, "a bystander is present in the core");
});

Then("those houseguests can see the one-on-one is happening", function (this: BbWorld) {
  // The un-zoned public core has no earshot subdivision: a co-present bystander witnesses the scene —
  // a 1:1 there is never private (by construction, the early-game privacy crunch).
  const ev = this.pmSandbox!.engine.events.queryAll().find((e) => e.id === this.pmEventId)!;
  assert.ok(ev.witnessSet.includes(this.pmSuspectId!), "the co-present bystander sees the one-on-one");
  assert.ok(!isZonedRoom("kitchen"), "the kitchen is open plan — no private corner to slip into");
  assert.ok(ROOM_ZONES.size > 0, "zones exist, but only in the big rooms (not the public core)");
});
