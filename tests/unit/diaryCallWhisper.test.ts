import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { whisperLongDiaryStay } from "../../src/engine/houseSuspicion";
import type { RandomnessSource } from "../../src/ports/RandomnessSource";

/**
 * ORW-694 / B1-11 (spec 0210 C2, "both ways"; Coordinator ruling 2026-11-25, options A + C): a LONG Diary Room stay is something the house notices. The onlooker most drawn to the one who
 * was in there starts a Vault-free POSITION whisper ("was in the Diary Room a long while" - never what was said) that spreads along the affinity graph like the pairing whisper: its own
 * rng, no relationship fold (texture, calibration-neutral). The player's own long stays feed the same channel among the houseguests; the player is never told about themselves.
 * Roles only.
 */
type Any = Record<string, any>;
const LONG = "in the Diary Room a long while";
/** The gate roll is `gate`; everything after it (the diffusion's own forks) is a real seeded stream. */
const rngAlways = (gate = 0): RandomnessSource => {
  const real = new SeededRandom(7);
  let first = true;
  return { next: () => (first ? ((first = false), gate) : real.next()), int: (n: number) => real.int(n), fork: (l: string) => real.fork(l) } as unknown as RandomnessSource;
};
const kn = (): InMemoryKnowledgeService => new InMemoryKnowledgeService(new InMemoryEventStore());
const knows = (k: InMemoryKnowledgeService, who: string, needle: string): boolean => k.knownTo(who).some((f) => f.content.includes(needle));

describe("B1-11 - the pure whisper", () => {
  const npcs = ["npc:1", "npc:2", "npc:3", "npc:4"];
  const deps = (k: InMemoryKnowledgeService, rng = rngAlways()) => ({
    occupancy: new Map(), tenureOf: () => 0, npcs, player: PLAYER, affinity: () => 0.9, nameOf: (id: string) => (id === PLAYER ? "The Player" : `Role ${id.slice(4)}`),
    knowledge: k, rng,
  });

  it("an NPC's long stay spreads from the onlooker most drawn to them, position only", () => {
    const k = kn();
    const out = whisperLongDiaryStay(deps(k) as never, { who: "npc:1", onlookers: ["npc:2", "npc:3"] });
    expect(out?.origin).toBeDefined();
    expect(knows(k, out!.origin, `Role 1 was ${LONG}`)).toBe(true);
    for (const id of [...npcs, PLAYER]) for (const f of k.knownTo(id)) expect(f.content).not.toMatch(/said|told|confess/i);
  });

  it("the player's long stay spreads among the houseguests and never reaches the player", () => {
    const k = kn();
    const out = whisperLongDiaryStay(deps(k) as never, { who: PLAYER, onlookers: ["npc:2", "npc:3"] });
    expect(out).toBeDefined();
    expect(npcs.some((id) => knows(k, id, `The Player was ${LONG}`))).toBe(true);
    expect(knows(k, PLAYER, LONG)).toBe(false);
  });

  it("occasional, like every house whisper; no onlooker, no whisper", () => {
    const k = kn();
    expect(whisperLongDiaryStay(deps(k, rngAlways(0.99)) as never, { who: "npc:1", onlookers: ["npc:2"] })).toBeUndefined();
    expect(whisperLongDiaryStay(deps(k) as never, { who: "npc:1", onlookers: [] })).toBeUndefined();
    expect(whisperLongDiaryStay(deps(k) as never, { who: "npc:1", onlookers: ["npc:1"] })).toBeUndefined();
  });
});

function boot(seed = 5): { sb: Any; s: Any } {
  const reg = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-dcw-"))));
  const sb = reg.sandboxFor("u") as unknown as Any;
  const s = sb.session as Any;
  s.setDiaryCallsEnabled(true);
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
  s.phase = "social";
  (s.live as Any).champagneCircle = "done"; (s.live as Any).pending = undefined; (s.live as Any).ceremony = undefined;
  return { sb, s };
}

describe("B1-11 - wired in the live house", () => {
  it("an NPC back from a LONG call is whispered about (queued at the return, spread on the whisper tick), and no relationship edge moves for it", () => {
    let found = false;
    for (const seed of [5, 7, 11, 13]) {
      const { sb, s } = boot(seed);
      const live = s.live as LiveSeasonState;
      for (let d = 1; d <= 10 && !found; d++) {
        for (let h = 9; h <= 22; h++) {
          live.dayNumber = d; live.nightDepth = h;
          const ids = s.livingIds().filter((x: string) => x !== PLAYER);
          s.houseLifeStretch(sb.engine.events, ids, (d - 1) * 24 + h, sb.engine.knowledge);
          const queued: Array<{ who: string }> = [...(s.diaryStaySightings ?? [])];
          if (queued.length === 0) { s.whisperPairings(sb.engine.knowledge); continue; }
          const edges = JSON.stringify(s.rel.serialize());
          s.whisperDiaryStays(sb.engine.knowledge);
          expect(JSON.stringify(s.rel.serialize()), "the whisper moves no relationship edge").toBe(edges);
          const name = s.nameOf(queued[0]!.who);
          if (s.livingIds().some((id: string) => id !== queued[0]!.who && sb.engine.knowledge.knownTo(id).some((f: Any) => f.content.includes(`${name} was ${LONG}`)))) found = true;
        }
      }
      if (found) break;
    }
    expect(found, "a long Diary Room call never started a whisper in forty played days").toBe(true);
  });

  it("the player's stay that runs into a second in-game hour is queued like an NPC's long call (both ways), once per stay", () => {
    const { sb, s } = boot(5);
    const live = s.live as LiveSeasonState;
    const npcs = s.livingIds().filter((x: string) => x !== PLAYER).slice(0, 3);
    for (const id of npcs) s.presence.set(id, "living-room");
    live.dayNumber = 2; live.nightDepth = 14;
    s.noteDiaryVisit(sb.engine.events);
    expect((s.diaryStaySightings ?? []).filter((x: Any) => x.who === PLAYER)).toHaveLength(0);
    live.nightDepth = 15;
    s.noteDiaryVisit(sb.engine.events);
    live.nightDepth = 16;
    s.noteDiaryVisit(sb.engine.events);
    const mine = (s.diaryStaySightings ?? []).filter((x: Any) => x.who === PLAYER);
    expect(mine, "one sighting for one long stay").toHaveLength(1);
    expect(mine[0].onlookers.every((id: string) => id !== PLAYER)).toBe(true);
  });
});

describe("B1-11 option (c) - held copies are inert (Coordinator ruling: the 12-season mix moved late bonding -3.0 with them live)", () => {
  it("the whisper is recorded under a diary-stay lineage, for the player's stays and an NPC's alike", async () => {
    const { DIARY_STAY_FACT_PREFIX } = await import("../../src/engine/heldFacts");
    for (const who of ["npc:1", PLAYER]) {
      const k = kn();
      const out = whisperLongDiaryStay({ occupancy: new Map(), tenureOf: () => 0, npcs: ["npc:1", "npc:2", "npc:3"], player: PLAYER, affinity: () => 0.9, nameOf: (id: string) => id, knowledge: k, rng: rngAlways() } as never,
        { who, onlookers: ["npc:2", "npc:3"], key: `${who}:40` });
      expect(out).toBeDefined();
      const held = ["npc:1", "npc:2", "npc:3"].flatMap((id) => k.knownTo(id)).filter((f) => f.content.includes("a long while"));
      expect(held.length).toBeGreaterThan(0);
      for (const f of held) expect(String(f.factId).startsWith(DIARY_STAY_FACT_PREFIX), `${who}: ${f.factId}`).toBe(true);
    }
  });

  it("a holder never re-tells it or moves toward an audience for it: heldCandidates leaves it out, other facts stay", async () => {
    const { heldCandidates, DIARY_STAY_FACT_PREFIX } = await import("../../src/engine/heldFacts");
    const fact = (factId: string, content: string) => ({ id: factId, factId, content, confidence: 1, hops: 1, distortion: 0, source: "npc:9" }) as never;
    const out = heldCandidates([fact(`${DIARY_STAY_FACT_PREFIX}npc:1:40`, "word in the house: Role 1 was in the Diary Room a long while"), fact("fact:npc:2:7", "word in the house: Role 2 and Role 3 keep slipping off together")], []);
    expect(out.map((c) => c.factId)).toEqual(["fact:npc:2:7"]);
  });
});
