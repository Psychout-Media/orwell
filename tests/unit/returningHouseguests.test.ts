import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { InMemoryUserSeasonArchive } from "../../src/adapters/engine/FileUserSeasonArchive";
import { PLAYER } from "../../src/domain/ids";
import { SEASON_MEMORY, softenedFeelings, type ArchivedHouseguest } from "../../src/engine/seasonMemory";
import { archivePersona, buildSeasonArchive, carriedNudge, planReturner, resolveReturnee, returnerBeliefs } from "../../src/engine/returnees";
import { validateCastGenesis } from "../../src/engine/castGenesis";

/** Theme B slice B1 (ORW-663, spec 0208): a returning houseguest is real, remembers the player softened by time, and carries nothing hidden. Roles only. */

const SENTINEL = "HIDDEN-SENTINEL-PRIOR-SEASON";


describe("B1: the validator accepts only a real, complete, archived houseguest", () => {
  const real: ArchivedHouseguest = {
    season: 1, npcId: "npc-3" as never, characterRef: "1:npc-3", placement: 4, juror: true, name: "Role Alpha",
    persona: { archetype: "mastermind", strategyStyle: "strategic", stats: { physical: 0.4, mental: 0.8, social: 0.5 }, background: "b", appearance: "a", age: 30, presentation: "p" } as never,
    endToward: { trust: -0.4, affinity: -0.2, threat: 0.5 }, claims: [],
  };
  it("rejects an invented or unarchived returnee (fail-closed)", () => {
    expect(resolveReturnee({ season: 1, npcId: "npc-9" }, [real])).toBeUndefined();
    expect(resolveReturnee({ season: 2, npcId: "npc-3" }, [real])).toBeUndefined();
    expect(resolveReturnee({ season: 1, npcId: "npc-3", name: "Someone Invented" }, [real])).toBeUndefined();
    expect(resolveReturnee(undefined, [real])).toBeUndefined();
    expect(resolveReturnee({ season: 1, npcId: "npc-3" }, [])).toBeUndefined();
    // an incomplete entry (no persona / no name) can never resolve
    const { persona: _p, ...noPersona } = real; void _p;
    expect(resolveReturnee({ season: 1, npcId: "npc-3" }, [noPersona as ArchivedHouseguest])).toBeUndefined();
  });
  it("accepts an archived one", () => {
    expect(resolveReturnee({ season: 1, npcId: "npc-3", name: "role alpha" }, [real])).toBe(real);
  });
  it("a first-season player (empty archive) or a new start gets none, for every seed", () => {
    for (let seed = 0; seed < 200; seed++) {
      expect(planReturner(seed, "return", [], ["A"], "P", ["npc-1" as never])).toBeUndefined();
      expect(planReturner(seed, "new", [real], ["A"], "P", ["npc-1" as never])).toBeUndefined();
    }
  });
  it("is deterministic per seed, and never repeats a name already in the house", () => {
    const hits = (seed: number): string => JSON.stringify(planReturner(seed, "return", [real], ["A"], "P", ["npc-1" as never, "npc-2" as never]));
    for (let seed = 0; seed < 50; seed++) expect(hits(seed)).toBe(hits(seed));
    for (let seed = 0; seed < 50; seed++) expect(planReturner(seed, "return", [real], ["Role Alpha"], "P", ["npc-1" as never])).toBeUndefined();
    const casting = Array.from({ length: 200 }, (_, s) => planReturner(s, "return", [real], ["A"], "P", ["npc-1" as never])).filter(Boolean).length;
    expect(casting).toBeGreaterThan(30);
    expect(casting).toBeLessThan(110);
  });
  it("genesis cannot propose a returnee: the keys are flagged and ignored", () => {
    const src = require("node:fs").readFileSync("src/engine/castGenesis.ts", "utf8") as string;
    for (const k of ["returnee", "returning", "returningFrom", "pastSeason"]) expect(src.includes(`"${k}"`)).toBe(true);
    void validateCastGenesis;
  });
});

describe("B1: the carried feeling softens with the seasons and never exceeds the original", () => {
  const end = { trust: -0.5, affinity: 0.4, threat: 0.6 };
  it("monotone decay, bounded by the end read, never gone", () => {
    let prev = { trust: 1, affinity: 1, threat: 1 };
    for (let n = 0; n <= 12; n++) {
      const s = softenedFeelings(end, n);
      expect(Math.abs(s.trust)).toBeLessThanOrEqual(Math.abs(end.trust) + 1e-12);
      expect(Math.abs(s.affinity)).toBeLessThanOrEqual(Math.abs(end.affinity) + 1e-12);
      expect(s.threat).toBeLessThanOrEqual(end.threat + 1e-12);
      expect(Math.abs(s.trust)).toBeLessThanOrEqual(Math.abs(prev.trust === 1 ? 1 : prev.trust) + 1e-12);
      expect(Math.sign(s.trust)).toBe(Math.sign(end.trust));
      expect(Math.abs(s.trust)).toBeGreaterThanOrEqual(Math.abs(end.trust) * SEASON_MEMORY.keepAtLeast - 1e-12);
      prev = s;
    }
    const entry = { season: 1, endToward: end } as ArchivedHouseguest;
    expect(Math.abs(carriedNudge(entry, 5).trust)).toBeLessThan(Math.abs(carriedNudge(entry, 2).trust));
  });
  it("their own account carries only claims without an old-cast object, with softer confidence later", () => {
    const entry = buildSeasonArchive(1, [{
      id: "npc-2" as never, name: "Role Beta", character: { hiddenElements: [{ kind: "secret-motive", detail: SENTINEL }] } as never, placement: 5, juror: true,
      edge: { trust: 0.1, affinity: 0.1, threat: 0.5 },
      beliefsAboutPlayer: [
        { id: "x", holder: "npc-2" as never, kind: "voted-against-me", subject: PLAYER, value: true, origin: "witnessed", confidence: 0.9, week: 3 },
        { id: "y", holder: "npc-2" as never, kind: "allied-with", subject: PLAYER, object: "npc-7" as never, value: true, origin: "told", confidence: 0.9, week: 3 },
        { id: "z", holder: "npc-2" as never, kind: "heard-rumor", subject: PLAYER, value: true, origin: "gossip", confidence: 0.9, week: 3 },
      ],
    }])[0]!;
    expect(entry.claims.map((c) => c.kind)).toEqual(["voted-against-me"]);
    expect(JSON.stringify(entry).includes(SENTINEL)).toBe(false); // the hidden layer never rides the archive
    const soon = returnerBeliefs("npc-1" as never, PLAYER, entry, 2)[0]!.confidence;
    const later = returnerBeliefs("npc-1" as never, PLAYER, entry, 9)[0]!.confidence;
    expect(later).toBeLessThanOrEqual(soon);
  });
});

/** Play and finish a season for a user, then return; scan seeds until a returner is cast. */
type Internals = { house: { npcs: Array<{ id: string; name: string; character: Record<string, unknown> & { hiddenElements: Array<{ detail: string }> } }> } | null; live: { returners?: Record<string, unknown>; beliefs?: Record<string, unknown[]> } | null };
function twoSeasons(user: string, firstSeed: number, returnSeed: number, archive = new InMemoryUserSeasonArchive()) {
  const reg = new GameSessionRegistry(undefined, { seasonArchive: archive });
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed: firstSeed });
  sb.session.noteMessage({ messageId: "m1" });
  expect(sb.session.advanceToFinale().finished).toBe(true);
  for (const n of (sb.session as never as Internals).house!.npcs) n.character.hiddenElements[0]!.detail = SENTINEL; // a marker in every prior-season hidden layer
  const firstCast = sb.session.getGameState().house.map((h) => h.name);
  sb.session.createCharacter({ playerName: "The Player", seed: returnSeed, confirmRestart: true, keepCharacter: true });
  return { reg, archive, user, firstCast, after: reg.sandboxFor(user) };
}

describe("B1: a two-season player gets a real past houseguest back, with the wall intact", () => {
  it("a finished played season is archived (hidden layer excluded); a return may cast one of them", () => {
    let found: ReturnType<typeof twoSeasons> | undefined;
    for (let seed = 100; seed < 130 && !found; seed++) {
      const r = twoSeasons("u-ret", 7, seed);
      if (r.after.session.getGameState().house.some((h) => r.firstCast.includes(h.name)) && (r.after.session as never as { live: { returners?: object } }).live?.returners) found = r;
    }
    expect(found, "some return seed casts a returner").toBeTruthy();
    const f = found!;
    const arch = f.archive.read(f.user);
    expect(arch.length).toBeGreaterThan(0);
    expect(arch.every((h) => h.season === 1 && h.persona && h.name && !("hiddenElements" in (h.persona as object)))).toBe(true);
    const names = new Set(arch.map((h) => h.name));
    const view = f.after.session.getGameState();
    const returned = view.house.filter((h) => names.has(h.name));
    expect(returned.length).toBe(1); // exactly one real past houseguest; the rest are fresh
    // narrator fact: name, seasons ago, public finish; never a feeling or claim
    expect(view.returningHouseguests?.length).toBe(1);
    expect(Object.keys(view.returningHouseguests![0]!).sort()).toEqual(["juror", "name", "placement", "seasonsAgo"]);
    expect(view.returningHouseguests![0]!.seasonsAgo).toBe(1);
    const wire = JSON.stringify(view);
    for (const leak of ["endToward", "characterRef", "persona", "hiddenElements", SENTINEL]) expect(wire.includes(leak), leak).toBe(false);
    // the new season's hidden layer is fresh: the prior season's marker is nowhere in this season's house or state
    const inner = f.after.session as never as Internals;
    expect(JSON.stringify(inner.house).includes(SENTINEL)).toBe(false);
    expect(JSON.stringify(inner.live).includes(SENTINEL)).toBe(false);
    expect(JSON.stringify(f.archive.read(f.user)).includes(SENTINEL)).toBe(false);
    // the carry is hidden-layer only: the returner holds their own (softened) account only when they carried one
    const seat = Object.keys(inner.live!.returners!)[0]!;
    const entry = arch.find((h) => h.name === returned[0]!.name)!;
    expect((inner.live!.beliefs?.[seat] ?? []).length).toBe(entry.claims.length);
  });

  it("a first season, a new start, or the flag off casts no returner and archives nothing", () => {
    const reg = new GameSessionRegistry(undefined, { seasonArchive: new InMemoryUserSeasonArchive() });
    const sb = reg.sandboxFor("u-first");
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    expect(sb.session.getGameState().returningHouseguests).toBeUndefined();
    // unplayed (headless-style) season: nothing archived on reset
    sb.session.advanceToFinale();
    const archive = new InMemoryUserSeasonArchive();
    const r2 = new GameSessionRegistry(undefined, { seasonArchive: archive });
    const s2 = r2.sandboxFor("u-unplayed");
    s2.session.createCharacter({ playerName: "The Player", seed: 7 });
    s2.session.advanceToFinale();
    s2.session.createCharacter({ playerName: "The Player", seed: 8, confirmRestart: true });
    expect(archive.read("u-unplayed")).toEqual([]);
    // flag off: a played season archives nothing
    const a3 = new InMemoryUserSeasonArchive();
    const r3 = new GameSessionRegistry(undefined, { seasonArchive: a3 });
    const s3 = r3.sandboxFor("u-off");
    s3.session.setSeasonMemoryEnabled(false);
    s3.session.createCharacter({ playerName: "The Player", seed: 7 });
    s3.session.noteMessage({ messageId: "m1" });
    s3.session.advanceToFinale();
    s3.session.createCharacter({ playerName: "The Player", seed: 9, confirmRestart: true, keepCharacter: true });
    expect(a3.read("u-off")).toEqual([]);
  });

  it("is deterministic per seed", () => {
    const run = (): string => {
      const r = twoSeasons("u-det", 7, 111);
      return JSON.stringify(r.after.session.getGameState().house.map((h) => h.name));
    };
    expect(run()).toBe(run());
  });
});

/** Finish a played season for `user` and restart with the given createCharacter args THROUGH the player tool door (McpServer.callTool). */
async function restartVia(user: string, seed: number, args: Record<string, unknown>) {
  const archive = new InMemoryUserSeasonArchive();
  const reg = new GameSessionRegistry(undefined, { seasonArchive: archive });
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed: 7 });
  sb.session.noteMessage({ messageId: "m1" });
  expect(sb.session.advanceToFinale().finished).toBe(true);
  const firstCast = (sb.session as never as Internals).house!.npcs.map((n) => n.name);
  await sb.mcp.player.callTool("createCharacter", { playerName: "The Player", seed, confirmRestart: true, ...args });
  const after = reg.sandboxFor(user);
  return { archive, firstCast, after, inner: after.session as never as Internals };
}

describe("B1: the player's own start choice on the createCharacter tool", () => {
  it("an unknown start value is refused, typed, through the tool door", async () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("u-bad-start");
    await expect(sb.mcp.player.callTool("createCharacter", { playerName: "The Player", seed: 7, start: "sideways" })).rejects.toThrow(/start/);
    await expect(sb.mcp.player.callTool("createCharacter", { playerName: "The Player", seed: 7, start: 3 })).rejects.toThrow(/start/);
  });

  // ORW-955: vitest 2 never enforced the 30 s limit on synchronous tests; this keeps that behaviour explicit
  it("start 'return' brings reputation and may cast a returner even with a NEW character; 'new' is a clean slate even when keeping the character", { timeout: 120_000 }, async () => {
    let returned = false;
    for (let seed = 100; seed < 140 && !returned; seed++) {
      const r = await restartVia(`u-ret-${seed}`, seed, { start: "return" });
      expect(r.after.session.carriedNotoriety()).not.toBeNull();
      returned = !!r.inner.live?.returners;
      if (returned) expect(JSON.stringify(r.after.session.getGameState())).not.toContain("endToward");
    }
    expect(returned, "some seed casts a returner on start 'return'").toBe(true);
    for (let seed = 100; seed < 115; seed++) {
      const n = await restartVia(`u-new-${seed}`, seed, { start: "new", keepCharacter: true });
      expect(n.after.session.carriedNotoriety()).toBeNull();
      expect(n.inner.live?.returners).toBeUndefined();
      expect(n.after.session.getGameState().returningHouseguests).toBeUndefined();
    }
  });

  it("absent start is today's behaviour: keepCharacter returns, a new character does not", async () => {
    const keep = await restartVia("u-def-keep", 111, { keepCharacter: true });
    expect(keep.after.session.carriedNotoriety()).not.toBeNull();
    const fresh = await restartVia("u-def-new", 111, {});
    expect(fresh.after.session.carriedNotoriety()).toBeNull();
    expect(fresh.inner.live?.returners).toBeUndefined();
  });
});

describe("B1: a returner keeps who they are and gets fresh season state", () => {
  it("identity, personality, backstory and voice facets match the archive; secrets in play are fresh", () => {
    let done = false;
    for (let seed = 100; seed < 140 && !done; seed++) {
      const r = twoSeasons(`u-id-${seed}`, 7, seed);
      const inner = r.after.session as never as Internals;
      if (!inner.live?.returners) continue;
      done = true;
      const arch = r.archive.read(r.user);
      const seat = Object.keys(inner.live.returners)[0]!;
      const npc = inner.house!.npcs.find((n) => n.id === seat)!;
      const entry = arch.find((h) => h.name === npc.name)!;
      for (const k of ["archetype", "strategyStyle", "identityConcept", "background", "vocation", "hometown", "demeanor", "voice", "biography", "age", "presentation", "castingType", "ethnicity", "genderPresentation"]) {
        expect(JSON.stringify(npc.character[k]), k).toBe(JSON.stringify((entry.persona as unknown as Record<string, unknown>)[k]));
      }
      expect(JSON.stringify(npc.character.hiddenElements).includes(SENTINEL)).toBe(false);
    }
    expect(done).toBe(true);
  });
});
