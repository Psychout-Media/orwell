import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parsePlayerMoveIntent, parsePlayerPersonIntent, parsePlayerOwnBedMove, matchHouseguestName } from "../../src/engine/playerMoveIntent";
import { parsePlayerBedIntent, bedroomNames } from "../../src/engine/bedClaims";
import { themedRoomAliases } from "../../src/engine/roomLabels";
import { roomDisplayName, type Room } from "../../src/domain/house";

/**
 * ORW-1008 / audit A3 (ORW-1031, 1033-1040): the player-move and bed parsers against audit A3's synthetic corpora (tests/fixtures/orw1008). Rows are `class|here|text|expMove|expPerson`,
 * bed rows `class|text|exp`, probes `text|here|exp`. The count of misreads is a ratchet: it may only go DOWN as the parsers are fixed (the ceilings below are the measured values).
 * Set ORW1008_LIST=1 to print every misread.
 */
const FX = path.join(__dirname, "..", "fixtures", "orw1008");
const lines = (f: string) => fs.readFileSync(path.join(FX, f), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
const R: Record<string, Room> = { L: "living-room", K: "kitchen", Y: "backyard", H: "hallway", A: "bedroom-a", B: "bedroom-b", C: "bedroom-c", T: "bathroom", G: "lounge", D: "dining-room", O: "hoh-room", S: "storage-room", R: "diary-room", P: "landing" };
const themed = [...themedRoomAliases("ocean-depths"), ["palmetto room", "bedroom-b"], ["the palmetto room", "bedroom-b"], ["palmetto", "bedroom-b"], ["the palmetto", "bedroom-b"]] as ReadonlyArray<readonly [string, Room]>;
const list = (xs: string[]) => { if (process.env.ORW1008_LIST) console.log(xs.join("\n")); };

// the measured ceilings (misreads allowed); lower them as each slice lands
export const CEILING = { move: 0, person: 0, bed: 0, probes: 0 }; // every row passes; rows whose answer is a product rule are in needs-ryne.txt // A3 baseline on main: move 76, person 129, bed 19, probes 88. What is left is mostly rows where the corpus and the probes disagree (sprint/dash/come), the person parser (the engine matches its phrase to the roster, so a stray phrase moves nobody), and themed names the season does not have

describe("ORW-1008 audit A3 corpus", () => {
  it("move parser: misreads on the corpus", () => {
    const bad: string[] = [];
    for (const l of lines("corpus.txt")) {
      const [cls, h, text, em] = l.split("|");
      const exp = em === "-" || em === undefined ? null : em;
      if (cls === "bedgo") { if (!parsePlayerOwnBedMove(text!)) bad.push(`${cls} ${text}`); continue; } // the engine's own-bed seam reads these
      const got = parsePlayerMoveIntent(text!, R[h!]!, themed);
      if (got !== exp) bad.push(`${cls} @${h} ${text} exp=${exp} got=${got}`);
    }
    list(bad); console.log("move misreads", bad.length);
    expect(bad.length).toBeLessThanOrEqual(CEILING.move);
  });
  it("person parser: the houseguest the engine would resolve (the phrase is matched to the roster, so a stray phrase moves nobody)", () => {
    const roster = [["dana", "Dana Reyes"], ["jake", "Jake Morrison"], ["kit", "Kit Alvarez"], ["lou", "Lou Park"], ["hal", "Hal Brandt"], ["dia", "Dia Santos"]].map(([, n]) => ({ name: n! }));
    const bad: string[] = [];
    for (const l of lines("corpus.txt")) {
      const [cls, h, text, , ep] = l.split("|");
      const want = ep && ep !== "-" ? matchHouseguestName(ep, roster)?.name ?? null : null;
      const gp = parsePlayerPersonIntent(text!, R[h!]!, themed);
      const got = gp === null ? null : matchHouseguestName(gp, roster)?.name ?? null;
      if (got !== want) bad.push(`${cls} @${h} ${text} exp=${want} got=${got}`);
    }
    list(bad); console.log("person misreads", bad.length);
    expect(bad.length).toBeLessThanOrEqual(CEILING.person);
  });
  it("the 'my bed' fallback never moves a non-move (ORW-1031)", () => {
    const bad: string[] = [];
    for (const l of lines("corpus.txt")) {
      const [cls, h, text, em] = l.split("|");
      if (!/\bmy (?:own )?bed\b/i.test(text!)) continue;
      const exp = em === "-" || em === undefined ? null : em;
      if (exp === null && parsePlayerOwnBedMove(text!)) bad.push(`${cls} ${text}`);
    }
    list(bad); expect(bad.length).toBe(0);
  });
  it("bed parser: misreads on the bed corpus", () => {
    const people = [["dana", "Dana Reyes"], ["jake", "Jake Morrison"], ["kit", "Kit Alvarez"], ["lou", "Lou Park"], ["hal", "Hal Brandt"], ["dia", "Dia Santos"]].map(([id, n]) => ({ id: id!, names: [n!, n!.split(" ")[0]!] }));
    const rooms = (["bedroom-a", "bedroom-b", "bedroom-c"] as const).map((r) => ({ room: r as Room, names: [...new Set([...bedroomNames(r, roomDisplayName(r)), ...themed.filter(([, x]) => x === r).map(([a]) => a)])] }));
    const bad: string[] = [];
    for (const l of lines("bedcorpus.txt")) {
      const [cls, text, exp] = l.split("|");
      const g = parsePlayerBedIntent(text!, rooms, people);
      const gs = g === null ? "-" : g.kind === "claim" ? `claim:${g.room}${g.prefer ? ":" + g.prefer : ""}` : `${g.kind}:${people.find((p) => p.id === (g as { who: string }).who)!.names[1]}`;
      if (gs !== exp) bad.push(`${cls} ${text} exp=${exp} got=${gs}`);
    }
    list(bad); console.log("bed misreads", bad.length);
    expect(bad.length).toBeLessThanOrEqual(CEILING.bed);
  });
  it("probes: structure misreads", () => {
    const bad: string[] = [];
    for (const l of lines("probes.txt")) {
      const [t, h, e] = l.split("|");
      const exp = e === "-" ? null : e;
      const g = parsePlayerMoveIntent(t!, (R[h!] ?? h) as Room);
      if (g !== exp) bad.push(`${t} @${h} exp=${exp} got=${g}`);
    }
    list(bad); console.log("probe misreads", bad.length);
    expect(bad.length).toBeLessThanOrEqual(CEILING.probes);
  });
});
