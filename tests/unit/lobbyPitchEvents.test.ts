import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/** B38 (#2017 slice 3, ORWELL_LOBBYING): pitches are real events. Each is recorded (hidden unless the player witnessed it), a trusted safety pitch seals an NPC-NPC deal, nothing is projected to the player as a lobby log. Flag off => nothing. Roles only. */
type Internals = {
  rel: { edge(a: EntityId, b: EntityId): { threat: number; trust: number; affinity: number } };
  setLobbyingEnabled(on: boolean): void; recordLobbyPitches(hoh: EntityId): void; presence?: Map<EntityId, string>;
};
function game(on: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(`b38-${Math.random()}`);
  sb.session.createCharacter({ playerName: "P", archetype: "floater", seed: 7 });
  const s = sb.session as unknown as Internals;
  s.setLobbyingEnabled(on);
  const npcs = sb.session.livingIds().filter((i) => i !== PLAYER) as EntityId[];
  const hoh = npcs[0]!;
  // every other NPC reads as a threat to the HOH and is trusted by them: they have a stake and a credible voice
  for (const n of npcs) if (n !== hoh) { s.rel.edge(hoh, n).threat = 0.6; s.rel.edge(hoh, n).trust = 0.9; }
  return { sb, s, hoh, npcs };
}
const pitchEvents = (g: ReturnType<typeof game>) => g.sb.engine.events.queryAll().filter((e) => e.type === "lobbying");

describe("pitches are recorded events", () => {
  it("ON: each pitch becomes an event with the pitcher and the HOH as witnesses; a trusted safety pitch also seals an NPC-NPC deal; the call is idempotent per (week, HOH)", () => {
    const g = game(true);
    g.s.recordLobbyPitches(g.hoh);
    const evs = pitchEvents(g);
    expect(evs.length).toBeGreaterThan(0);
    for (const e of evs) expect(e.witnessSet).toContain(g.hoh);
    const deals = g.sb.engine.events.queryAll().filter((e) => e.type === "deal");
    expect(deals.length, "a trusted safety pitch seals a pact").toBeGreaterThan(0);
    g.s.recordLobbyPitches(g.hoh);
    expect(pitchEvents(g).length, "a second call the same week records nothing new").toBe(evs.length);
  });
  it("OFF: no pitch event and no deal (flag-off byte-identical)", () => {
    const g = game(false);
    const before = g.sb.engine.events.queryAll().length;
    g.s.recordLobbyPitches(g.hoh);
    expect(g.sb.engine.events.queryAll().length).toBe(before);
  });
  it("Vault sentinel: a pitch the player did not witness is hidden and absent from the player's knowledge; one they witnessed is theirs", () => {
    const g = game(true);
    g.s.recordLobbyPitches(g.hoh);
    const evs = pitchEvents(g);
    const unwitnessed = evs.filter((e) => !e.witnessSet.includes(PLAYER));
    const witnessed = evs.filter((e) => e.witnessSet.includes(PLAYER));
    for (const e of unwitnessed) expect(e.hidden, "an unwitnessed pitch is Vault-held").toBe(true);
    for (const e of witnessed) expect(e.hidden, "a witnessed pitch is the player's knowledge, never mislabelled secret").toBe(false);
    const seen = g.sb.engine.events.query({ witnessedBy: PLAYER }).filter((e) => e.type === "lobbying");
    expect(seen.map((e) => e.id).sort()).toEqual(witnessed.map((e) => e.id).sort());
    // no raw numbers or labels in any recorded pitch line
    for (const e of evs) expect(e.content).not.toMatch(/\d|threat score|credib|tilt/i);
  });
});

describe("gates", () => {
  it("a pitch from someone the HOH does not trust is recorded but seals no deal", () => {
    const g = game(true);
    for (const n of g.npcs) if (n !== g.hoh) g.s.rel.edge(g.hoh, n).trust = 0.05;
    g.s.recordLobbyPitches(g.hoh);
    expect(pitchEvents(g).length).toBeGreaterThan(0);
    expect(g.sb.engine.events.queryAll().filter((e) => e.type === "deal").length).toBe(0);
  });
  it("source pin: the recorder runs when the HOH is crowned (the pitches precede nominations)", () => {
    const src = readFileSync("src/adapters/engine/GameSessionAdapter.ts", "utf8");
    expect(src).toMatch(/ev\.beat === "hoh-competition" && ev\.participants\[0\]\) this\.recordLobbyPitches\(ev\.participants\[0\]\)/);
  });
});
