import { describe, it, expect, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { walkInLine, walkInReaction, isPrivateTalk, WALK_IN_REACTIONS } from "../../src/engine/walkIn";
import { resolvePending } from "../../features/support/answerPending";

/** ORW-473: walking in on a private talk. Each houseguest's reaction comes from their own sheet; the narrator is told the manner, never the content; both remember. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));

const SHEETS = {
  "pulls-the-player-in": { candor: 0.9, affinityToPlayer: 0.9, affinityToOther: 0.5 },
  "carries-on-guarded": { candor: 0.8, affinityToPlayer: 0.5, affinityToOther: 0.7 },
  "moves-the-talk": { candor: 0.1, affinityToPlayer: 0.3, affinityToOther: 0.1 },
  "goes-quiet": { candor: 0.3, affinityToPlayer: 0.05, affinityToOther: 0.4 },
} as const;

describe("the pure sheet rule", () => {
  it("each of the four reactions is what a particular sheet produces", () => {
    for (const k of WALK_IN_REACTIONS) expect(walkInReaction(SHEETS[k], 0), k).toBe(k);
  });
  it("only a spoken strategic talk with a partner is a private talk; ", () => {
    expect(isPrivateTalk("pitch")).toBe(true);
    expect(isPrivateTalk("drive-a-wedge")).toBe(true);
    expect(isPrivateTalk("cook")).toBe(false);
    expect(isPrivateTalk("nap")).toBe(false);
  });
});

let n = 0;
function toNominations(): GameSessionAdapter {
  for (let seed = 1; seed <= 40; seed++) {
    const s = new GameSessionRegistry().sandboxFor(`walkin473-${n++}`).session;
    s.createCharacter({ playerName: "P", seed });
    for (let i = 0; i < 4000; i++) {
      const v = s.advanceGame();
      if (s.getGameState().phase === "nominations" && s.livingIds().length >= 14) return s;
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
      if (v.finished) break;
    }
  }
  throw new Error("never");
}
type Hack = {
  presence: Map<EntityId, string>; awakeNow: () => Set<EntityId> | null; live: { playedGame?: boolean }; walkIn: unknown;
  agendaCharacterOf: (id: EntityId) => unknown; rel: { edge: (a: EntityId, b: EntityId) => { affinity: number } };
};
type Ev = { id: string; ts: number; type: string; initiator: string; witnessSet: string[]; hidden: boolean; content: string; houseLife?: Record<string, unknown> };

/** The player is in the backyard; A and B are in the kitchen and a hidden private talk between them is on the record; everyone else is asleep in a bed. */
function stage(action = "pitch", played = true, group = 2, nightOwl = false) {
  const s = toNominations();
  const h = s as unknown as Hack;
  const npcs = s.livingIds().filter((id) => id !== PLAYER);
  const [A, B] = [npcs[0]!, npcs[1]!];
  const crew = npcs.slice(0, group); // two = a pair; more = a group talk
  const seats: Array<[EntityId, string]> = [[PLAYER, "backyard"], ...crew.map((id): [EntityId, string] => [id, "kitchen"])];
  for (const id of npcs) if (!seats.some(([x]) => x === id)) seats.push([id, "bedroom-c"]);
  h.presence = new Map(seats);
  h.awakeNow = () => new Set<EntityId>([PLAYER, ...crew]);
  h.live.playedGame = played;
  // ORW-709: a houseguest who steps up to the player now walks over to the player's room, which would move one of the pair out of the kitchen on the message. These pins are about the walk-in, not approaches, so the desire clock is off here.
  s.setDesireClockEnabled(false);
  const orig = (s as unknown as { record: { events: () => Ev[]; hidden: unknown } }).record;
  const talk: Ev = { id: "offscreen:strategy:test", ts: 1, type: "strategy", initiator: A, witnessSet: crew, hidden: true, content: "A and B plotted against C SENTINEL-HIDDEN", houseLife: { ...(nightOwl ? { nightOwl: true } : {}), action, place: "kitchen", manner: "low", truthful: true, stretch: 1, at: s.inGameAbsHour() } };
  s.setRecordProviders({ events: () => [...orig.events(), talk] as never, hidden: orig.hidden as never });
  return { s, h, A, B, crew };
}
const sheet = (h: Hack, by: Record<string, { candor: number; ap: number; ao: number }>, A: EntityId, B: EntityId): void => {
  const arch = (c: number) => (c > 0.7 ? { archetype: "hothead", strategyStyle: "emotional" } : c > 0.3 ? { archetype: "floater", strategyStyle: "social" } : { archetype: "villain", strategyStyle: "strategic" });
  const of = (id: string) => by[id] ?? { candor: 0.5, ap: 0.5, ao: 0.5 };
  h.agendaCharacterOf = (id) => arch(of(id).candor);
  const real = h.rel; // keep the real relationship graph for everything but the one edge read this rule uses
  h.rel = new Proxy(real, { get: (t, k, r) => (k === "edge" ? (x: EntityId, y: EntityId) => ({ affinity: y === PLAYER ? of(x).ap : of(x).ao }) : Reflect.get(t, k, r)) });
  void A; void B;
};

describe("walking in on a private talk", () => {
  it("the same interruption gives different reactions for different pairs, traceable to their sheets", () => {
    const one = stage(); const two = stage();
    sheet(one.h, { [one.A]: { candor: 0.9, ap: 0.9, ao: 0.5 }, [one.B]: { candor: 0.1, ap: 0.2, ao: 0.1 } }, one.A, one.B);
    sheet(two.h, { [two.A]: { candor: 0.1, ap: 0.2, ao: 0.1 }, [two.B]: { candor: 0.9, ap: 0.9, ao: 0.5 } }, two.A, two.B);
    one.s.movePlayer("kitchen"); two.s.movePlayer("kitchen");
    const w1 = one.s.getGameState().walkedIn!; const w2 = two.s.getGameState().walkedIn!;
    const by = (w: typeof w1, id: EntityId) => w.reactions.find((r) => r.id === id)!.line; // the view carries the manner only
    expect(by(w1, one.A)).toBe(walkInLine("pulls-the-player-in"));
    expect(by(w1, one.B)).not.toBe(walkInLine("pulls-the-player-in"));
    expect(by(w2, two.B)).toBe(walkInLine("pulls-the-player-in"));
    expect(by(w2, two.A)).toBe(by(w1, one.B)); // the same sheet gives the same reaction in either seat
  });

  it("is deterministic, names the pair, tells the manner and never the content or the kind of talk", () => {
    const { s, h, A, B } = stage("drive-a-wedge");
    sheet(h, { [A]: { candor: 0.1, ap: 0.3, ao: 0.5 }, [B]: { candor: 0.3, ap: 0.05, ao: 0.4 } }, A, B);
    s.movePlayer("kitchen");
    const w = s.getGameState().walkedIn!;
    expect(w.with.map((x) => x.id).sort()).toEqual([A, B].sort());
    for (const r of w.reactions) expect(r.line.length).toBeGreaterThan(10);
    const text = JSON.stringify(w);
    expect(text).not.toMatch(/plotted|wedge|pitch|strategy|against/i);
    expect(JSON.stringify(s.getGameState().walkedIn)).toBe(JSON.stringify(w));
  });

  it("both houseguests remember the player walked in", () => {
    const { s, h, A, B } = stage();
    sheet(h, { [A]: { candor: 0.5, ap: 0.5, ao: 0.5 }, [B]: { candor: 0.5, ap: 0.5, ao: 0.5 } }, A, B);
    s.movePlayer("kitchen");
    const mem = (id: EntityId) => (s as unknown as { house: { npcs: { id: string; soul: { memory: string[] } }[] } }).house.npcs.find((x) => x.id === id)!.soul.memory;
    expect(mem(A).some((m) => m.includes("walked in on my private talk"))).toBe(true);
    expect(mem(B).some((m) => m.includes("walked in on my private talk"))).toBe(true);
  });

  it("only a private talk, with both still in the room, in a played game, on the message it happened on", () => {
    const cook = stage("cook"); sheet(cook.h, { [cook.A]: { candor: 0.5, ap: 0.5, ao: 0.5 }, [cook.B]: { candor: 0.5, ap: 0.5, ao: 0.5 } }, cook.A, cook.B);
    cook.s.movePlayer("kitchen");
    expect(cook.s.getGameState().walkedIn, "a cook-out is not a private strategy talk").toBeUndefined();
    const headless = stage("pitch", false);
    headless.s.movePlayer("kitchen");
    expect(headless.s.getGameState().walkedIn, "headless games never trigger it").toBeUndefined();
    const gone = stage();
    gone.h.presence.set(gone.B, "living-room"); // one of them has left the room
    gone.s.movePlayer("kitchen");
    expect(gone.s.getGameState().walkedIn).toBeUndefined();
    const t = stage(); sheet(t.h, { [t.A]: { candor: 0.5, ap: 0.5, ao: 0.5 }, [t.B]: { candor: 0.5, ap: 0.5, ao: 0.5 } }, t.A, t.B);
    t.s.noteMessage({ messageId: "m1" });
    t.s.movePlayer("kitchen");
    expect(t.s.getGameState().walkedIn).toBeDefined();
    t.s.noteMessage({ messageId: "m2" });
    expect(t.s.getGameState().walkedIn, "the next turn does not carry it").toBeUndefined();
  });

  const calm = (x: ReturnType<typeof stage>) => sheet(x.h, { [x.A]: { candor: 0.5, ap: 0.5, ao: 0.5 }, [x.B]: { candor: 0.5, ap: 0.5, ao: 0.5 } }, x.A, x.B);

  it("fires once: leaving the room and coming back on a later message does not fire it again", () => {
    const x = stage(); calm(x);
    x.s.noteMessage({ messageId: "m1" });
    x.s.movePlayer("kitchen");
    expect(x.s.getGameState().walkedIn).toBeDefined();
    x.s.noteMessage({ messageId: "m2" });
    x.s.movePlayer("backyard");
    x.s.noteMessage({ messageId: "m3" });
    x.s.movePlayer("kitchen");
    expect(x.s.getGameState().walkedIn, "the same talk is not walked in on twice").toBeUndefined();
  });

  it("the consumed talk survives a save and restore", () => {
    const x = stage(); // real sheets: restore needs the real relationship graph
    x.s.movePlayer("kitchen");
    const core = JSON.parse(JSON.stringify(x.s.snapshot()));
    expect(core.walkInDone).toEqual(["offscreen:strategy:test"]);
    x.s.restore(core);
    x.s.noteMessage({ messageId: "m9" });
    x.s.movePlayer("backyard"); x.s.noteMessage({ messageId: "m10" }); x.s.movePlayer("kitchen");
    expect(x.s.getGameState().walkedIn).toBeUndefined();
  });

  it("a stale talk does not fire: it must be recent in game time, not only by event count", () => {
    const x = stage(); calm(x);
    const now = x.s.inGameAbsHour()!;
    const evs = (x.s as unknown as { record: { events: () => Ev[] } }).record.events();
    const talk = evs[evs.length - 1]!;
    (talk.houseLife as { at: number }).at = now - 3; // three game hours ago
    x.s.movePlayer("kitchen");
    expect(x.s.getGameState().walkedIn, "three hours old").toBeUndefined();
    (talk.houseLife as { at: number }).at = now - 24 * 4; // days ago, still within the last 40 events
    x.s.movePlayer("backyard"); x.s.movePlayer("kitchen");
    expect(x.s.getGameState().walkedIn, "days old").toBeUndefined();
    (talk.houseLife as { at: number }).at = now - 1; // the hour before
    x.s.movePlayer("backyard"); x.s.movePlayer("kitchen");
    expect(x.s.getGameState().walkedIn, "an hour old").toBeDefined();
  });

  it("the player-facing view carries no raw reaction value, not even in its nested objects", () => {
    const x = stage(); calm(x);
    x.s.movePlayer("kitchen");
    const w = x.s.getGameState().walkedIn!;
    expect(w).toBeDefined();
    const text = JSON.stringify(w);
    for (const k of WALK_IN_REACTIONS) expect(text).not.toContain(k);
    expect(text).not.toContain('"reaction"');
    for (const r of w.reactions) expect(Object.keys(r).sort()).toEqual(["id", "line", "name"]);
  });

  it("the visible reaction does not depend on the kind of talk: the same people give the same manner after an attack, an alliance check-in and gossip", () => {
    const lines = ["drive-a-wedge", "pitch", "gossip"].map((kind) => {
      const x = stage(kind); calm(x);
      x.s.movePlayer("kitchen");
      return JSON.stringify(x.s.getGameState().walkedIn!.reactions.map((r) => r.line));
    });
    expect(new Set(lines).size, lines.join(" | ")).toBe(1);
  });

  it("over many random sheets the reaction mix is one distribution, with no input for the kind of talk", () => {
    let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const count = new Map<string, number>();
    for (let i = 0; i < 4000; i++) { const r = walkInReaction({ candor: rnd(), affinityToPlayer: rnd(), affinityToOther: rnd() }, 0); count.set(r, (count.get(r) ?? 0) + 1); }
    for (const k of WALK_IN_REACTIONS) expect(count.get(k) ?? 0, k).toBeGreaterThan(200); // all four stay reachable
    expect(Object.keys({ candor: 0, affinityToPlayer: 0, affinityToOther: 0 })).not.toContain("stakes");
  });
});

describe("walking in on a group talk (ORW-473 amendment, 0192)", () => {
  const groupSheet = (x: ReturnType<typeof stage>) => { x.h.agendaCharacterOf = () => ({ archetype: "floater", strategyStyle: "social" }); };
  afterEach(() => { delete process.env.ORWELL_WALKIN_GROUPS; });

  it("a night-owl trio is caught: all three are named, each plays it off with a manner, and each remembers it", () => {
    const x = stage("bed-talk", true, 3, true); groupSheet(x);
    x.s.noteMessage({ messageId: "g1" });
    x.s.movePlayer("kitchen");
    const w = x.s.getGameState().walkedIn!;
    expect(w).toBeDefined();
    expect(w.with.map((p) => p.id).sort()).toEqual([...x.crew].sort());
    expect(w.reactions.map((r) => r.id).sort()).toEqual([...x.crew].sort());
    for (const r of w.reactions) expect(r.line.length).toBeGreaterThan(10);
    const npcs = (x.s as unknown as { house: { npcs: { id: string; soul: { memory: string[] } }[] } }).house.npcs;
    for (const id of x.crew) expect(npcs.find((n) => n.id === id)!.soul.memory.some((m) => m.includes("walked in on my private talk")), id).toBe(true);
  });

  it("an ordinary gathering of four is caught once, and not again", () => {
    const x = stage("pitch", true, 4); groupSheet(x);
    x.s.noteMessage({ messageId: "g1" });
    x.s.movePlayer("kitchen");
    expect(x.s.getGameState().walkedIn!.with).toHaveLength(4);
    x.s.noteMessage({ messageId: "g2" }); x.s.movePlayer("backyard"); x.s.noteMessage({ messageId: "g3" }); x.s.movePlayer("kitchen");
    expect(x.s.getGameState().walkedIn).toBeUndefined();
  });

  it("the same guards apply: one of the group gone, headless, a non-private action, or a stale talk is not caught", () => {
    const gone = stage("pitch", true, 3); groupSheet(gone); gone.h.presence.set(gone.crew[2]!, "living-room"); gone.s.movePlayer("kitchen");
    expect(gone.s.getGameState().walkedIn, "one has left").toBeUndefined();
    const asleep = stage("pitch", true, 3); groupSheet(asleep); asleep.h.awakeNow = () => new Set<EntityId>([PLAYER, ...asleep.crew.slice(0, 2)]); asleep.s.movePlayer("kitchen");
    expect(asleep.s.getGameState().walkedIn, "one is asleep").toBeUndefined();
    const headless = stage("pitch", false, 3); headless.s.movePlayer("kitchen");
    expect(headless.s.getGameState().walkedIn).toBeUndefined();
    const cook = stage("cook", true, 3); cook.s.movePlayer("kitchen");
    expect(cook.s.getGameState().walkedIn).toBeUndefined();
    const old = stage("pitch", true, 3); groupSheet(old);
    const evs = (old.s as unknown as { record: { events: () => Ev[] } }).record.events();
    (evs[evs.length - 1]!.houseLife as { at: number }).at = old.s.inGameAbsHour()! - 3;
    old.s.movePlayer("kitchen");
    expect(old.s.getGameState().walkedIn, "three hours old").toBeUndefined();
  });

  it("flag off (ORWELL_WALKIN_GROUPS=0): a group is not caught, a pair still is", () => {
    process.env.ORWELL_WALKIN_GROUPS = "0";
    const trio = stage("pitch", true, 3); groupSheet(trio); trio.s.movePlayer("kitchen");
    expect(trio.s.getGameState().walkedIn).toBeUndefined();
    const pair = stage(); groupSheet(pair); pair.s.movePlayer("kitchen");
    expect(pair.s.getGameState().walkedIn).toBeDefined();
  });

  it("wall: the group's view carries only the participants and manner lines - no hidden content, no number, no raw reaction", () => {
    const x = stage("drive-a-wedge", true, 3, true); groupSheet(x);
    x.s.movePlayer("kitchen");
    const w = x.s.getGameState().walkedIn!;
    expect(w).toBeDefined();
    const text = JSON.stringify(w);
    expect(text).not.toMatch(/SENTINEL-HIDDEN|plotted|wedge|pitch|strategy|nightOwl|bed-talk|\d\.\d/i);
    for (const r of WALK_IN_REACTIONS) expect(text.includes(`"${r}"`), r).toBe(false);
    expect(JSON.stringify(x.s.getGameState())).not.toContain("SENTINEL-HIDDEN");
  });
});

describe("ORW-1077: the one who moves the talk elsewhere really leaves", () => {
  it("they are out of the room the player walked into, next door, and the view says they left; the others stay", () => {
    const x = stage();
    sheet(x.h, { [x.A]: { candor: 0.1, ap: 0.3, ao: 0.1 }, [x.B]: { candor: 0.9, ap: 0.9, ao: 0.5 } }, x.A, x.B);
    x.s.movePlayer("kitchen");
    const w = x.s.getGameState().walkedIn!;
    const a = w.reactions.find((r) => r.id === x.A)!, b = w.reactions.find((r) => r.id === x.B)!;
    expect(a.line).toBe(walkInLine("moves-the-talk"));
    expect(a.left).toBe(true);
    expect(b.left).toBeUndefined();
    expect(x.h.presence.get(x.A)).not.toBe("kitchen");
    expect(x.h.presence.get(x.A)).not.toBe("diary-room");
    expect(x.h.presence.get(x.B)).toBe("kitchen");
  });
  it("nobody leaves on the other reactions", () => {
    const x = stage();
    sheet(x.h, { [x.A]: { candor: 0.9, ap: 0.9, ao: 0.5 }, [x.B]: { candor: 0.5, ap: 0.5, ao: 0.7 } }, x.A, x.B);
    x.s.movePlayer("kitchen");
    expect(x.s.getGameState().walkedIn!.reactions.some((r) => r.left)).toBe(false);
    expect([x.h.presence.get(x.A), x.h.presence.get(x.B)]).toEqual(["kitchen", "kitchen"]);
  });
});
