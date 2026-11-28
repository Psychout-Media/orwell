import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { allBeds } from "../../src/engine/beds"; // exists on main too: this file runs against main's source
import { resolvePending } from "../../features/support/answerPending";

/** ORW-1153: the narrator's only bed facts are an engine per-bed table (each single, each half of a double, its owner or "free", the free count), and a named-room double claim lands there or is refused with what is free. Roles only. */
type Live = { premiereEntrance?: { stage: string }; beds: { owner: Record<string, string>; claims: unknown[] }; bedRush?: { tick: number; done?: boolean } };
type Priv = { live: Live; livingIds(): string[]; roomName(r: string): string; resolvePlayerBed(t: string): boolean; bedsLine(): string | undefined; playerBedNote: string | null };
const priv = (s: GameSessionAdapter) => s as unknown as Priv;
const step = (s: GameSessionAdapter) => { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); };
let n = 0;
function circleClosed(seed: number): GameSessionAdapter {
  const s = new GameSessionRegistry().sandboxFor(`orw1153-${n++}`).session as GameSessionAdapter;
  s.setPremiereEntrancesEnabled(true);
  s.setBedRushEnabled(true);
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" });
  for (let i = 0; i < 60 && priv(s).live.premiereEntrance!.stage !== "done"; i++) step(s);
  expect(priv(s).live.premiereEntrance!.stage).toBe("done");
  step(s); // the first heat starts the rush
  return s;
}
/** Hand the board a fixed state: every spot owned by an NPC except the `free` spots; the player owns none. The rest of the NPCs hold nothing (still racing). */
function board(s: GameSessionAdapter, free: string[]): void {
  const npcs = priv(s).livingIds().filter((id) => id !== "player");
  const spots = allBeds().filter((b) => !free.includes(b));
  const owner: Record<string, string> = {};
  spots.forEach((b, i) => { if (npcs[i]) owner[npcs[i]!] = b; });
  priv(s).live.beds.owner = owner;
  priv(s).live.beds.claims = [];
}
const presentIn = (s: GameSessionAdapter, room: string): void => { (s as unknown as { presence: Map<string, string> }).presence.set("player", room); };
const bedsFact = (s: GameSessionAdapter): string => (s.getMomentPrompt({}) as { systemPrompt: string }).systemPrompt.split("\n").find((l) => l.startsWith("- BEDS")) ?? "";

describe("ORW-1153: a mid-rush board where one room's double has a free half", () => {
  it("the BEDS fact says exactly that, lists halves separately and gives the free count; no flat roster of the room", () => {
    const s = circleClosed(7);
    expect(priv(s).live.bedRush?.done ?? false).toBe(false);
    board(s, ["bedroom-c#d1:2", "bedroom-a#s1"]);
    const fact = bedsFact(s);
    const c = priv(s).roomName("bedroom-c");
    expect(fact).toContain("double 1 half 2: free");
    expect(fact).toMatch(new RegExp(`${c} \\([^)]*\\): single 1: [^;]+; single 2: [^;]+; single 3: [^;]+; double 1 half 1: [^;]+; double 1 half 2: free`));
    expect(fact).toContain("FREE SPOTS HOUSE-WIDE: 2 of 16");
    expect(fact).toMatch(/only when FREE SPOTS HOUSE-WIDE is 0/);
    expect(fact).toMatch(/never put more than one in a single or more than two in a double/);
    expect(fact).not.toMatch(/Beds already claimed|sleeping there:/);
  });
  it("with nothing free the count is 0 (the only time 'the last bed' is allowed)", () => {
    const s = circleClosed(7);
    board(s, []);
    priv(s).live.beds.owner["player"] = allBeds().find((b) => !Object.values(priv(s).live.beds.owner).includes(b))!;
    expect(bedsFact(s)).toContain("FREE SPOTS HOUSE-WIDE: 0 of 16");
  });
});

describe("ORW-1153: the player's claim of a named room's double", () => {
  it("lands on the free half in THAT room", () => {
    const s = circleClosed(7);
    board(s, ["bedroom-c#d1:2", "bedroom-a#s1"]);
    presentIn(s, "bedroom-c"); // mid-rush: the claim needs the player in the room
    const room = priv(s).roomName("bedroom-c").toLowerCase().replace(/ bedroom$/, "");
    expect(priv(s).resolvePlayerBed(`I will pick the double in the ${room} room.`)).toBe(true);
    expect(priv(s).live.beds.owner["player"]).toBe("bedroom-c#d1:2");
  });
  it("a double that is full in that room is refused, naming what is free (never a silent single)", () => {
    const s = circleClosed(7);
    board(s, ["bedroom-c#s1", "bedroom-a#d1:2"]);
    presentIn(s, "bedroom-c");
    const room = priv(s).roomName("bedroom-c").toLowerCase().replace(/ bedroom$/, "");
    expect(priv(s).resolvePlayerBed(`I will pick the double in the ${room} room.`)).toBe(false);
    expect(priv(s).live.beds.owner["player"], "no single handed over in place of the double").toBeUndefined();
    expect(priv(s).playerBedNote).toMatch(/none free there/);
    expect(priv(s).playerBedNote).toContain("single 1");
    expect(priv(s).playerBedNote).toContain(priv(s).roomName("bedroom-a"));
    expect(bedsFact(s)).toMatch(/BED REQUEST REFUSED|PER-BED TABLE/);
  });
  it("a player who already owns a bed still gets the table on a turn that asks about beds", () => {
    const s = circleClosed(7);
    board(s, ["bedroom-c#d1:2", "bedroom-a#s1"]);
    priv(s).live.beds.owner["player"] = "bedroom-a#s1"; 
    priv(s).live.bedRush!.done = true; // the rush is over, the player already seated
    priv(s).resolvePlayerBed("What beds are still open?");
    expect(priv(s).bedsLine()).toMatch(/double 1 half 1: [^;]+; double 1 half 2: [^;.]+[\s\S]*FREE SPOTS HOUSE-WIDE: \d+ of 16/);
  });
});
