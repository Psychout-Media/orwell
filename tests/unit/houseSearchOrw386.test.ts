import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionAdapter as Adapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { headcountLines } from "../../src/engine/momentPrompts";
import { linger } from "../support/linger";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { resolvePending } from "../../features/support/answerPending";

/** ORW-386: "Look for Miguel. Where is he?" - the house search hands the narrator each houseguest's ROOM (and whether the player can walk in), and the headcounts. Roles only. */
let n = 0;
function fresh(seed = 1): GameSessionAdapter {
  const s = new GameSessionRegistry().sandboxFor(`hs386-${n++}`).session;
  s.createCharacter({ playerName: "P", seed });
  return s;
}
function toNominations(): GameSessionAdapter {
  for (let seed = 1; seed <= 40; seed++) {
    const s = fresh(seed);
    for (let i = 0; i < 4000; i++) {
      const v = s.advanceGame();
      if (s.getGameState().phase === "nominations" && s.livingIds().length >= 14) return s;
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
      if (v.finished) break;
    }
  }
  throw new Error("never");
}
type Hack = { presence: Map<EntityId, string>; awakeNow: () => Set<EntityId> | null; ceremony: { hoh?: EntityId } };

/** Day 2 morning: 11 asleep, one in the backyard with the player, one in the living room, two awake in `hidden` (bedroom A, or the HOH room). */
function stage(hidden: string): { s: GameSessionAdapter; npcs: EntityId[] } {
  const s = toNominations();
  const npcs = s.livingIds().filter((id) => id !== PLAYER).slice(0, 15);
  expect(npcs.length).toBeGreaterThanOrEqual(15);
  const h = s as unknown as Hack;
  const asleep = npcs.slice(0, 11);
  const [inYard, inLiving, h1, h2] = npcs.slice(11);
  const beds = ["bedroom-a", "bedroom-b", "bedroom-c"];
  const seats: Array<[EntityId, string]> = [[PLAYER, "backyard"], [inYard!, "backyard"], [inLiving!, "living-room"], [h1!, hidden], [h2!, hidden]];
  asleep.forEach((id, i) => seats.push([id, beds[i % 3]!]));
  // every other living NPC (beyond the 15 staged) is asleep in a bed too
  for (const id of s.livingIds()) if (id !== PLAYER && !seats.some(([x]) => x === id)) seats.push([id, "bedroom-c"]);
  h.presence = new Map(seats);
  const up = new Set<EntityId>([PLAYER, inYard!, inLiving!, h1!, h2!]);
  h.awakeNow = () => up;
  h.ceremony.hoh = npcs[0]; // someone else holds the crown
  return { s, npcs };
}

describe("ORW-386 house search (engine)", () => {
  type Priv462 = { trackedSightings: Map<EntityId, unknown> | null; lastSeenAt: Map<EntityId, unknown> | null; presenceTickCount: number; live: { dayNumber?: number } };
  const clearRecords = (s: GameSessionAdapter): void => { const p = s as unknown as Priv462; p.trackedSightings = null; p.lastSeenAt = null; };
  const find = (v: ReturnType<GameSessionAdapter["whereabouts"]>, id: EntityId) => v!.search!.houseguests.find((e) => e.id === id)!;

  it("ORW-462: two awake houseguests behind a bedroom door are unseen in a plain search (no room named); asking for one with nothing known gets `unknown`, never the room", () => {
    const { s, npcs } = stage("bedroom-a");
    clearRecords(s);
    const [, , , , , , , , , , , , , h1, h2] = npcs;
    const wa = s.whereabouts({ search: true })!;
    const listed = [...wa.present, ...wa.nearby.flatMap((r) => r.present)].map((p) => p.id);
    expect(listed).not.toContain(h1);
    expect(listed).not.toContain(h2);
    for (const id of [h1!, h2!]) {
      expect(find(wa, id)).toMatchObject({ status: "unseen" });
      expect(find(wa, id).room, "a closed room's occupants are not named").toBeUndefined();
    }
    expect(wa.search!.rooms.map((r) => r.room), "no room behind a door is listed").not.toContain("bedroom-a");
    // what the player CAN see is still named
    expect(find(wa, npcs[11]!)).toMatchObject({ status: "here", room: "backyard" });
    expect(find(wa, npcs[12]!)).toMatchObject({ status: "awake", room: "living-room", access: "open" });
    expect(find(wa, npcs[0]!).status).toBe("asleep");
    expect(find(wa, npcs[0]!).room, "a sleeper behind a door is not located either").toBeUndefined();
    // looking for h1: the player has no way to know, so the game does not say
    const wl = s.whereabouts({ search: true, lookingFor: find(wa, h1!).name })!;
    expect(find(wl, h1!)).toMatchObject({ status: "unknown" });
    expect(find(wl, h1!).room).toBeUndefined();
    expect(find(wl, h1!).fact).toContain("look around the house or ask around");
    expect(find(wl, h2!).status, "only the named houseguest is resolved").toBe("unseen");
  });

  it("ORW-462: a sleeper, the HOH room and the diary room are `unknown` too when the player has no record (no loophole through any closed door)", () => {
    for (const hidden of ["bedroom-a", "hoh-room", "diary-room"]) {
      const { s, npcs } = stage(hidden);
      clearRecords(s);
      for (const id of [npcs[0]!, npcs[13]!]) {
        const e = find(s.whereabouts({ search: true, lookingFor: id }), id);
        expect(e.status, `${hidden} ${id}`).toBe("unknown");
        expect(e.room).toBeUndefined();
      }
    }
    const { s, npcs } = stage("hoh-room");
    clearRecords(s);
    (s as unknown as Hack).ceremony.hoh = PLAYER; // even the player's own HOH room is not confirmed by the game
    expect(find(s.whereabouts({ search: true, lookingFor: npcs[13]! }), npcs[13]!).status).toBe("unknown");
  });

  it("ORW-462: a full roster sweep with no prior sightings reveals only what is in view", () => {
    const { s, npcs } = stage("bedroom-a");
    clearRecords(s);
    const wa = s.whereabouts()!;
    const inView = new Set([...wa.present, ...wa.nearby.flatMap((r) => r.present)].map((p) => p.id));
    for (const id of npcs) {
      const e = find(s.whereabouts({ search: true, lookingFor: id }), id);
      if (e.room !== undefined) expect(inView.has(id), `${id} is named in ${e.room} but is not in view`).toBe(true);
      else expect(["unseen", "unknown", "asleep", "arriving"]).toContain(e.status);
    }
  });

  it("ORW-462: the player's record of a witnessed 'walked into X' is a LEAD, never a confirmation", () => {
    const { s, npcs } = stage("bedroom-a");
    clearRecords(s);
    const h1 = npcs[13]!;
    const p = s as unknown as Priv462;
    p.trackedSightings = new Map([[h1, { room: "bedroom-a", tick: p.presenceTickCount, pathway: "tracked:test", confidence: 0.5 }]]);
    const e = find(s.whereabouts({ search: true, lookingFor: h1 }), h1);
    expect(e).toMatchObject({ status: "lead", room: "bedroom-a" });
    expect(e.fact).toContain("last seen heading into the bedroom A");
    expect(e.fact).toContain("not confirmed");
    expect(find(s.whereabouts({ search: true }), h1).status, "without asking for them the record is not volunteered").toBe("unseen");
  });

  it("ORW-462: a last-known sighting in view is a lead with the part of the day; a different day says the day", () => {
    const { s, npcs } = stage("bedroom-a");
    clearRecords(s);
    const h1 = npcs[13]!;
    const p = s as unknown as Priv462;
    const day = p.live.dayNumber ?? 1;
    p.lastSeenAt = new Map([[h1, { room: "kitchen", tick: 1, day, part: "afternoon" }]]);
    expect(find(s.whereabouts({ search: true, lookingFor: h1 }), h1).fact).toContain("last seen in the kitchen around the afternoon - not confirmed");
    p.lastSeenAt = new Map([[h1, { room: "kitchen", tick: 1, day: day - 1 || 7, part: "evening" }]]);
    expect(find(s.whereabouts({ search: true, lookingFor: h1 }), h1).fact).toMatch(/last seen in the kitchen on day \d+/);
  });

  it("ORW-462: a first name shared by two active houseguests resolves nobody", () => {
    const { s, npcs } = stage("bedroom-a");
    clearRecords(s);
    const h = s as unknown as { house: { npcs: { id: string; name: string }[] } };
    const [a, b] = [npcs[13]!, npcs[14]!];
    h.house.npcs.find((x) => x.id === a)!.name = "Alex Smith";
    h.house.npcs.find((x) => x.id === b)!.name = "Alex Jones";
    const wl = s.whereabouts({ search: true, lookingFor: "Alex" })!;
    expect(find(wl, a).status).toBe("unseen");
    expect(find(wl, b).status).toBe("unseen");
    expect(find(s.whereabouts({ search: true, lookingFor: "Alex Jones" }), b).status).toBe("unknown");
  });

  it("asleep = 11 and the living room roster = that houseguest, in the counts and the narrator's terminal block", () => {
    const { s, npcs } = stage("bedroom-a");
    const wa = s.whereabouts()!;
    expect(wa.search).toBeUndefined(); // only on a search turn
    expect(wa.counts!.asleep).toBe(11);
    expect(wa.search ?? s.whereabouts({ search: true })!.search!.asleepCount).toBe(11);
    const living = wa.nearby.find((r) => r.room === "living-room")!;
    expect(living.present.map((p) => p.id)).toEqual([npcs[12]]);
    const hc = s.getMomentPrompt({}).hardConstraints ?? "";
    expect(hc).toContain("Asleep right now: 11 houseguests have turned in");
    expect(hc).toContain(`living room: ${living.present[0]!.name}`);
    expect(hc).toContain("kitchen: empty");
  });

  it("headcountLines: asleep and the rooms in view, and nothing extra when the view lacks them", () => {
    const l = headcountLines({ counts: { room: 2, others: 1, house: 16, asleep: 11 }, nearby: [{ room: "living-room", present: [{ name: "Jett Wooten" }] }, { room: "kitchen", present: [] }] }).join("\n");
    expect(l).toContain("Asleep right now: 11 houseguests");
    expect(l).toContain("Rooms in view right now: living room: Jett Wooten; kitchen: empty");
    expect(headcountLines({ counts: { room: 1, others: 0, house: 3 } }).join("\n")).not.toContain("Asleep");
  });

  it("is a read: a search leaves the state identical", () => {
    const { s } = stage("bedroom-a");
    const a = JSON.stringify(s.getGameState());
    s.whereabouts({ search: true }); s.whereabouts({ search: true });
    expect(JSON.stringify(s.getGameState())).toBe(a);
  });

  it("carries no Vault field: only room, access, status, name, id and the ready sentence", () => {
    const { s } = stage("hoh-room");
    const sv = s.whereabouts({ search: true })!.search!;
    expect(Object.keys(sv).sort()).toEqual(["asleepCount", "houseguests", "rooms"]);
    for (const e of sv.houseguests) expect(Object.keys(e).every((k) => ["id", "name", "status", "room", "access", "fact", "action", "toldBy"].includes(k))).toBe(true);
    for (const r of sv.rooms) expect(Object.keys(r).sort()).toEqual(["access", "present", "room"]);
    expect(JSON.stringify(sv)).not.toMatch(/secret|vault|soul|suspic|affinity|trust|plot|scheme/i);
  });
});

describe("ORW-386 invariant: every living houseguest is somewhere", () => {
  it("each living NPC is seated in exactly one room, and the search lists each exactly once (asleep or in a room), across seeds and a night", () => {
    Adapter.setTimeOfDayEnabled(true);
    try {
      for (const seed of [3, 5, 8, 13, 21]) {
        const s = fresh(seed);
        for (let i = 0; i < 40; i++) {
          const v = s.advanceGame();
          if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
          if (i % 5 === 0) linger(s);
          const wa = s.whereabouts({ search: true });
          if (!wa?.search) continue;
          const pres = (s as unknown as Hack).presence;
          const ids = wa.search.houseguests.map((e) => e.id);
          expect(new Set(ids).size, `seed ${seed} step ${i}: a houseguest listed twice`).toBe(ids.length);
          for (const id of s.livingIds()) {
            if (id === PLAYER || wa.houseEvent) continue;
            expect(pres.has(id), `seed ${seed} step ${i}: ${id} is in no room`).toBe(true);
          }
          if (!wa.houseEvent) {
            const living = s.livingIds().filter((id) => id !== PLAYER);
            const notArrived = living.filter((id) => !ids.includes(id));
            expect(notArrived, `seed ${seed} step ${i}: living houseguests the search lost`).toEqual([]);
          }
        }
      }
    } finally { Adapter.setTimeOfDayEnabled(null); }
  });
});

describe("ORW-386: houseguests held outside by the staged entrances, and sleepers shown as tracked", () => {
  type Pe = { live: { premiereEntrance?: { order: EntityId[]; arrived: number; stage: string } } };
  function atEntrances(leftOut: number): { s: GameSessionAdapter; late: EntityId[] } {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const s = new GameSessionRegistry().sandboxFor(`hs386-pe-${n++}`).session;
      s.setPremiereEntrancesEnabled(true);
      s.createCharacter({ playerName: "P", seed });
      const pe = () => (s as unknown as Pe).live.premiereEntrance;
      if (!pe() || pe()!.stage !== "entrances") continue;
      for (let i = 0; i < 40 && pe()?.stage === "entrances" && pe()!.arrived < pe()!.order.length - leftOut; i++) s.advanceGame();
      if (pe()?.stage === "entrances" && pe()!.arrived === pe()!.order.length - leftOut) return { s, late: pe()!.order.slice(pe()!.arrived).filter((id) => id !== PLAYER) };
    }
    throw new Error("no staged entrances to stop in");
  }

  it("houseguests who have not walked in yet (staged entrances) are in NO room and not asleep, though the house count includes them; the search says so", () => {
    const { s, late } = atEntrances(2);
    expect(late.length).toBeGreaterThanOrEqual(1);
    const wa = s.whereabouts({ search: true })!;
    const listed = [...wa.present, ...wa.nearby.flatMap((r) => r.present)].map((p) => p.id);
    const asleep = (s.getGameState() as { asleep?: Array<{ id: EntityId }> }).asleep ?? [];
    for (const id of late) {
      expect(listed).not.toContain(id); // the plain view cannot find them (by design: A9)
      expect(asleep.map((a) => a.id)).not.toContain(id);
      const e = wa.search!.houseguests.find((x) => x.id === id)!;
      expect(e.status).toBe("arriving");
      expect(e.fact).toContain("has not walked into the house yet");
      expect(e.room).toBeUndefined();
    }
    expect(wa.counts!.house).toBeGreaterThan(wa.search!.houseguests.filter((x) => x.status !== "arriving").length); // the count still includes them
  });

  it("someone who has turned in is not also 'tracked' behind the HOH room door", () => {
    const { s, npcs } = stage("bedroom-a");
    const gwen = npcs[0]!; // asleep in the staged morning
    const h = s as unknown as { trackedSightings: Map<EntityId, unknown>; presenceTickCount: number };
    h.trackedSightings = new Map([[gwen, { room: "hoh-room", tick: h.presenceTickCount - 5, pathway: "watched", confidence: 1 }]]) as never;
    expect(s.whereabouts()!.tracked.map((t) => t.id)).not.toContain(gwen);
    // ...and the belief is read again once they are up (kept, not deleted)
    const up = new Set<EntityId>([PLAYER, gwen]);
    (s as unknown as Hack).awakeNow = () => up;
    expect(s.whereabouts()!.tracked.map((t) => t.id)).toContain(gwen);
  });
});

describe("ORW-386: turnsHere means consecutive presence ticks in THIS room (it was never reset by an off-screen walk), and a restart keeps everything", () => {
  type L = { presence: Map<EntityId, string>; presenceTenure: Map<EntityId, number>; live: { nightDepth?: number }; houseLifeStretch(e: unknown, awake: readonly EntityId[], i: number): unknown[] };
  it("a houseguest who walks to another room between ticks starts at 0 there; one who stays keeps counting", async () => {
    let movers = 0;
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const reg = composeRuntime({ clock: new FakeClock(), seed }).registry as GameSessionRegistry;
      const user = `tenure386-${seed}`;
      const mcp = reg.resolver()("player", user);
      await mcp.callTool("createCharacter", { playerName: "P", seed, archetype: "floater" });
      await mcp.callTool("noteMessage", { messageId: "first" });
      const sb = reg.sandboxFor(user);
      const s = sb.session as unknown as L & { livingIds(): EntityId[] };
      const npcs = s.livingIds().filter((i) => i !== PLAYER);
      s.presence.set(PLAYER, "kitchen");
      s.presenceTenure = new Map([...s.presence.keys()].map((id) => [id, 22] as [EntityId, number]));
      for (let i = 0; i < 14; i++) {
        s.live.nightDepth = (s.live.nightDepth ?? 8) + 1;
        const before = new Map(s.presence);
        const priorTenure = new Map(s.presenceTenure); // snapshot BEFORE the stretch: a stayer's tenure is compared with it, never with itself
        s.houseLifeStretch(sb.engine.events, [...npcs, PLAYER], i);
        for (const id of npcs) {
          const moved = before.get(id) !== s.presence.get(id);
          if (moved) movers++;
          expect(s.presenceTenure.get(id), `${id} ${moved ? "walked to" : "stayed in"} ${s.presence.get(id)}`).toBe(moved ? 0 : priorTenure.get(id));
          if (moved) expect(s.presenceTenure.get(id)).toBe(0);
        }
        for (const id of npcs) if (before.get(id) === s.presence.get(id)) s.presenceTenure.set(id, 22);
      }
      if (movers > 0) break;
    }
    expect(movers, "no seed produced an off-screen walk to test").toBeGreaterThan(0);
  });

  it("recordHouseguestMove resets that houseguest to 0 and leaves the others' counts alone", () => {
    const s = toNominations();
    const npcs = s.livingIds().filter((id) => id !== PLAYER);
    const h = s as unknown as Hack & { presenceTenure: Map<EntityId, number> };
    h.presence.set(PLAYER, "kitchen"); h.presence.set(npcs[0]!, "kitchen"); h.presence.set(npcs[1]!, "kitchen");
    h.presenceTenure = new Map([[npcs[0]!, 22], [npcs[1]!, 22]]);
    s.recordHouseguestMove(npcs[0]!, "backyard");
    expect(h.presenceTenure.get(npcs[0]!)).toBe(0);
    expect(h.presenceTenure.get(npcs[1]!)).toBe(22);
  });

  it("a restart mid-day (snapshot, JSON, a NEW session) keeps every houseguest's room, the roster in view, the asleep list and turnsHere", () => {
    Adapter.setTimeOfDayEnabled(true);
    try {
      for (const seed of [3, 8]) {
        const reg = new GameSessionRegistry();
        const a = reg.sandboxFor(`reload386a-${seed}`).session;
        a.createCharacter({ playerName: "P", seed });
        for (let i = 0; i < 12; i++) { const v = a.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void a.submitDecision(req)); if (i % 4 === 0) linger(a); a.presenceTick(); }
        const rooms = (x: GameSessionAdapter) => JSON.stringify([...(x as unknown as Hack).presence].sort());
        const view = (x: GameSessionAdapter) => JSON.stringify({ wa: x.whereabouts({ search: true }), asleep: (x.getGameState() as { asleep?: unknown }).asleep });
        const before = { rooms: rooms(a), view: view(a) };
        const core = JSON.parse(JSON.stringify(a.snapshot()));
        const b = new GameSessionRegistry().sandboxFor(`reload386b-${seed}`).session;
        b.restore(core);
        expect(rooms(b)).toBe(before.rooms);
        expect(view(b)).toBe(before.view);
      }
    } finally { Adapter.setTimeOfDayEnabled(null); }
  });
});
