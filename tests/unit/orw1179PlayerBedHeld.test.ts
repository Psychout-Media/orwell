import { describe, it, expect, vi } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import { freeBeds, roomOfBed, type BedsState } from "../../src/engine/beds";
import { parsePlayerBedIntent, bedroomNames } from "../../src/engine/bedClaims";
import { roomDisplayName } from "../../src/domain/house";

/**
 * ORW-1179: the player's bed changes only on the player's own act (a claim, a trade they asked for and the owner agreed, the leftover at their first bedtime). A remark, a look, a seat, someone
 * else's trade or a question never moves them; a stray change is put back; every change writes a journal line. Roles only.
 */
type Live = { playedGame?: boolean; beds?: BedsState };
const liveOf = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const relOf = (s: GameSessionAdapter) => (s as unknown as { rel: { edge(a: string, b: string): { affinity: number; trust: number } } }).rel;
const phaseOf = (s: GameSessionAdapter) => (s as unknown as { phase: string }).phase;
const nameOf = (s: GameSessionAdapter, id: string) => s.getGameState().house.find((h) => h.id === id)!.name;

function seated() {
  const s = new GameSessionRegistry().sandboxFor(`orw1179-${Math.random()}`).session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 7 });
  liveOf(s).playedGame = true;
  for (let i = 0; i < 40 && phaseOf(s) === "premiere"; i++) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); }
  s.setBedMoveChance(0);
  s.bedsTick();
  const living = new Set(s.livingIds());
  const room = roomOfBed(freeBeds(liveOf(s).beds!, living)[0]!);
  s.resolvePlayerMove({ text: `I'll take a bed in ${roomDisplayName(room)}.` });
  const beds = liveOf(s).beds!;
  expect(beds.owner["player"], "positive control: the player's own claim lands").toBeDefined();
  const owner = Object.keys(beds.owner).find((o) => o !== "player" && roomOfBed(beds.owner[o]!) === roomOfBed(beds.owner["player"]!))!;
  for (const o of Object.keys(beds.owner)) if (o !== "player") relOf(s).edge(o, "player").affinity = 0.95; // everyone would say yes to a swap
  return { s, beds, owner };
}

const rooms = [{ room: "bedroom-c" as never, names: bedroomNames("bedroom-c" as never, "barrel bedroom") }];
const people = [{ id: "npc:3", names: ["Victor", "Victor Burdette"] }, { id: "npc:8", names: ["Daphne", "Daphne Chance"] }];

describe("ORW-1179: the parser reads the player's own ask, never a remark or a question", () => {
  for (const text of ["Victor's bed looks nice", "I sit on Victor's bed", "Is that Victor's bed?", "Whose bed is Victor's?", "Tell Victor to swap beds with Daphne", "Does Victor's bed have a view?", "I lie on Victor's bed and talk to him"]) {
    it(`never swaps on: ${text}`, () => { expect(parsePlayerBedIntent(text, rooms, people)).toBeNull(); });
  }
  for (const text of ["Im staying in the Barrel room right?", "Am I in the barrel bedroom bed?", "Are we all staying in the barrel bedroom?", "Is the double in the barrel bedroom still free?"]) {
    it(`a question about one's bed never claims: ${text}`, () => { expect(parsePlayerBedIntent(text, rooms, people)).toBeNull(); });
  }
  it("positive control: a plain first-person ask still reads", () => {
    expect(parsePlayerBedIntent("Can I swap beds with Victor?", rooms, people)).toMatchObject({ kind: "swap", who: "npc:3" });
    expect(parsePlayerBedIntent("I want Victor's bed", rooms, people)).toMatchObject({ kind: "swap", who: "npc:3" });
    expect(parsePlayerBedIntent("I'll take a bed in the barrel bedroom.", rooms, people)).toMatchObject({ kind: "claim", room: "bedroom-c" });
  });
});

describe("ORW-1179: the engine never moves the player without their act", () => {
  it("a remark, a seat or a question about a houseguest's bed leaves the player's bed alone, even when that houseguest would say yes", () => {
    const { s, beds, owner } = seated();
    const mine = beds.owner["player"], claims = beds.claims.length;
    const who = nameOf(s, owner);
    for (const text of [`${who}'s bed looks nice`, `I sit on ${who}'s bed`, `Is that ${who}'s bed?`, `Tell ${who} to swap beds with someone`]) s.resolvePlayerMove({ text });
    expect(beds.owner["player"]).toBe(mine);
    expect(beds.claims.length).toBe(claims);
  });

  it("a stray change to the player's bed (no act of theirs) is put back, the other side with it, and logged", () => {
    const { s, beds, owner } = seated();
    const mine = beds.owner["player"]!, theirs = beds.owner[owner]!;
    s.resolvePlayerMove({ text: "I look around the room." }); // a turn with the guard armed
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    beds.owner["player"] = theirs; beds.owner[owner] = mine; // what a stray writer did in prod: a swap nobody asked for
    s.resolvePlayerMove({ text: "I look around the room." });
    expect(beds.owner["player"]).toBe(mine);
    expect(beds.owner[owner]).toBe(theirs);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/bed-change UNAUTHORIZED who=player from=\S+ to=\S+ why=no-player-act/);
    warn.mockRestore();
  });

  it("a trade the player asks for and the owner agrees to is theirs: it stays, and its journal lines name who, from, to and why", () => {
    const { s, beds, owner } = seated();
    const mine = beds.owner["player"]!, theirs = beds.owner[owner]!;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    s.resolvePlayerMove({ text: `Can I swap beds with ${nameOf(s, owner)}?` });
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[orwell] bed-change"));
    log.mockRestore();
    expect(beds.owner["player"], "positive control: an asked, agreed trade happens").toBe(theirs);
    expect(lines.some((l) => l.includes(`who=player from=${mine} to=${theirs} why=swap by=player-ask:${owner}`))).toBe(true);
    expect(lines.some((l) => l.includes(`who=${owner} from=${theirs} to=${mine} why=swap`))).toBe(true);
    s.resolvePlayerMove({ text: "I look around the room." });
    expect(beds.owner["player"], "the engine does not undo a trade the player asked for").toBe(theirs);
  });
});
