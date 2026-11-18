import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { AssuranceLedger } from "../../src/engine/assurances";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import { renderGameContext } from "../../src/engine/momentPrompts";
import { pushbackFacts, renderPushbackLines, whenWords } from "../../src/engine/producerPushback";

/** ORW-669 (0210 C3): the producer who pushes back, in the player's own Diary Room. Roles only. */
type Any = Record<string, any>;
const SENTINEL = "SENTINEL_DR_WORDS_c3a9";

function boot(seed = 5, opts: { played?: boolean; flag?: boolean } = {}): { sb: Any; s: Any; ally: string } {
  const reg = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-pb-"))));
  const sb = reg.sandboxFor("u") as unknown as Any;
  const s = sb.session as Any;
  s.setProducerPushbackEnabled(opts.flag ?? true);
  s.createCharacter({ playerName: "P", seed });
  if (opts.played ?? true) s.noteMessage({ messageId: "m1" });
  s.phase = "social";
  const live = s.live as LiveSeasonState;
  Object.assign(live, { champagneCircle: "done", pending: undefined, ceremony: undefined, dayNumber: 2, nightDepth: 15 });
  return { sb, s, ally: s.livingIds().find((x: string) => x !== PLAYER) };
}
/** The player told `ally` they were safe (a recorded scene), then, as HOH, put them on the block. */
function contradict(s: Any, ally: string): void {
  const live = s.live as LiveSeasonState;
  const l = new AssuranceLedger();
  l.add({ from: PLAYER, to: ally, kind: "safe", week: live.week, sincerity: 1, source: "player" });
  live.assurances = l.toJSON();
  live.hoh = PLAYER;
  live.nominees = [ally, s.livingIds().find((x: string) => x !== PLAYER && x !== ally)];
}

describe("0210 C3 - the pure facts", () => {
  const nameOf = (id: string): string => `Name ${id}`;
  it("a said-vs-did mismatch names both in kind; deterministic; no digit or id", () => {
    const said = [{ claimId: "asr:1", to: "npc:2", promise: "safe" as const, week: 1 }];
    const did = [{ eventId: "nom:2:npc:2", act: "nominated" as const, target: "npc:2", week: 2 }];
    const f = pushbackFacts(said, did, (id) => (id === "npc:2" ? "the ally" : id), 2);
    expect(f).toEqual(pushbackFacts(said, did, (id) => (id === "npc:2" ? "the ally" : id), 2));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ name: "the ally", saidWhen: "last week", didWhen: "this week" });
    expect(f[0]!.said).toMatch(/safe/);
    expect(f[0]!.did).toMatch(/block/);
    expect(JSON.stringify(f)).not.toMatch(/\d|npc:/);
  });
  it("a consistent record raises nothing; an act against someone else raises nothing", () => {
    expect(pushbackFacts([{ claimId: "a", to: "x", promise: "safe", week: 1 }], [{ eventId: "e", act: "nominated", target: "y", week: 2 }], nameOf, 2)).toEqual([]);
    expect(pushbackFacts([{ claimId: "a", to: "x", promise: "safe", week: 3 }], [{ eventId: "e", act: "nominated", target: "x", week: 2 }], nameOf, 3)).toEqual([]);
    expect(pushbackFacts([], [], nameOf, 1)).toEqual([]);
    expect(renderPushbackLines(undefined)).toEqual([]);
  });
  it("the block hands facts and the producer's manner, gives the narrator no line to recite, and carries no sample or list marker", () => {
    const [line] = renderPushbackLines({ register: "dry and unhurried", facts: [{ name: "the ally", said: "told them they were safe with the player", saidWhen: "last week", did: "put them on the block", didWhen: "this week" }] });
    expect(line).toContain("the ally");
    expect(line).toContain("dry and unhurried");
    expect(line).toMatch(/author the producer's words yourself/);
    expect(line).not.toMatch(/e\.g\.|for example|such as/i);
    expect(whenWords(1, 4)).toBe("some weeks back");
  });
});

describe("0210 C3 - in the player's Diary Room", () => {
  it("the producer is handed the contradiction only once the player is in the Diary Room", () => {
    const { s, ally, sb } = boot();
    contradict(s, ally);
    expect(s.getGameState().producerPushback).toBeUndefined(); // not in the Diary Room yet
    sb.commands.diaryRoom({ entry: SENTINEL });
    const v = s.getGameState().producerPushback;
    expect(v.facts).toHaveLength(1);
    expect(v.facts[0].name).toBe(s.nameOf(ally));
    expect(v.register.length).toBeGreaterThan(0);
    expect(renderGameContext(s.getGameState() as never)).toContain("PRODUCER PUSHBACK");
    expect(JSON.stringify(v)).not.toMatch(/\d|npc:/);
    expect(JSON.stringify(s.getGameState().producerPushback)).toEqual(JSON.stringify(v)); // deterministic
  });
  it("a consistent player gets none", () => {
    const { s, sb, ally } = boot();
    const live = s.live as LiveSeasonState;
    const l = new AssuranceLedger();
    l.add({ from: PLAYER, to: ally, kind: "safe", week: live.week, sincerity: 1, source: "player" });
    live.assurances = l.toJSON();
    sb.commands.diaryRoom({ entry: SENTINEL });
    expect(s.getGameState().producerPushback).toBeUndefined();
  });
  it("what the player typed never lands in state, events or the view, and no houseguest's knowledge changes", () => {
    const { s, sb, ally } = boot();
    contradict(s, ally);
    const npcs = s.livingIds().filter((x: string) => x !== PLAYER);
    const before = JSON.stringify(npcs.map((id: string) => sb.engine.knowledge.knownTo(id)));
    const rel = JSON.stringify(npcs.map((id: string) => s.rel.edge(id, PLAYER)));
    sb.commands.diaryRoom({ entry: SENTINEL });
    s.getGameState();
    expect(JSON.stringify(npcs.map((id: string) => sb.engine.knowledge.knownTo(id)))).toBe(before);
    expect(JSON.stringify(npcs.map((id: string) => s.rel.edge(id, PLAYER)))).toBe(rel); // a pushback moves no relationship
    expect(JSON.stringify(s.live)).not.toContain(SENTINEL);
    expect(JSON.stringify(sb.engine.events.query({ type: "diary-call" }))).not.toContain(SENTINEL);
    expect(JSON.stringify(s.getGameState().producerPushback)).not.toContain(SENTINEL);
  });
  it("flag off and a game nobody is playing: byte-identical, no pushback", () => {
    for (const o of [{ flag: false }, { played: false }]) {
      const { s, sb, ally } = boot(11, o);
      contradict(s, ally);
      sb.commands.diaryRoom({ entry: SENTINEL });
      expect(s.getGameState().producerPushback).toBeUndefined();
    }
  });
});
