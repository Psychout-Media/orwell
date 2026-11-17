import { describe, it, expect } from "vitest";
import { HOH_ROOM, actingSkill, backstoryFacets, decideVisit, feelingAgainst, pickBackstoryFact, snubChance, type GuestInput } from "../../src/engine/hohRoom";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";

/** ORW-629 the HOH room reveal (spec 0199). Roles only. */
const HOH = "npc:1";
const guest = (n: number, over: Partial<GuestInput> = {}): GuestInput => ({ id: `npc:${n + 10}`, social: 0.5, affinity: 0.25, threat: 0.1, grudge: 0, ...over });
const cast = (k: number, over: Partial<GuestInput> = {}): GuestInput[] => Array.from({ length: k }, (_, i) => guest(i, over));

describe("the HOH room visit (pure)", () => {
  it("everyone is invited: the invited list is the whole guest list, attended + snubbed account for all of it", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const g = cast(14);
      const v = decideVisit(seed, 2, HOH, g);
      expect(v.invited.sort()).toEqual(g.map((x) => x.id).sort());
      expect([...v.attended, ...v.snubbed].sort()).toEqual(v.invited.sort());
    }
  });

  it("skipping is rare: a bounded share over many seeds for ordinary feelings, and not zero for strong ones", () => {
    let skips = 0, total = 0, strongSkips = 0, strongTotal = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const v = decideVisit(seed, 3, HOH, cast(14));
      skips += v.snubbed.length; total += 14;
      const s = decideVisit(seed, 3, HOH, cast(14, { affinity: -0.25, grudge: 1 }));
      strongSkips += s.snubbed.length; strongTotal += 14;
    }
    expect(skips / total).toBeLessThan(0.04);
    expect(strongSkips / strongTotal).toBeGreaterThan(0.1);
    expect(strongSkips / strongTotal).toBeLessThanOrEqual(HOH_ROOM.snubCap + 0.05);
    expect(snubChance(0)).toBe(HOH_ROOM.snubBase);
  });

  it("a perfect actor hides a strong feeling; a poor one leaks it; the direction is the feeling's own", () => {
    const hostile = { affinity: -0.2, threat: 0.1 };
    const slips = (social: number, shape: Partial<GuestInput>): number => {
      let n = 0;
      for (let seed = 1; seed <= 300; seed++) n += decideVisit(seed, 2, HOH, [guest(0, { social, ...hostile, ...shape })]).slipped.length;
      return n;
    };
    // the keyed per-person roll still varies who is good: compare through the skill itself
    const skillOf = (social: number): number => actingSkill(5, "npc:10", social);
    expect(skillOf(1)).toBeGreaterThan(skillOf(0));
    expect(slips(1, {})).toBeLessThan(slips(0, {}));
    expect(slips(0, {})).toBeGreaterThan(30);
    // a houseguest with nothing against the HOH has nothing to slip
    expect(slips(0, { affinity: 0.9, threat: 0 })).toBe(0);
    const f = feelingAgainst({ affinity: 0.25, threat: 0.9 });
    expect(f.kind).toBe("fear");
    expect(feelingAgainst({ affinity: -0.2, threat: 0.1 }).kind).toBe("resentment");
    for (let seed = 1; seed <= 100; seed++) for (const s of decideVisit(seed, 2, HOH, cast(10, { affinity: -0.2 })).slipped) expect(["resentment", "fear"]).toContain(s.direction);
  });

  it("acting is per person, never flat: the same Social stat gives different skill to different people; deterministic and order-free", () => {
    const skills = new Set(Array.from({ length: 12 }, (_, i) => actingSkill(9, `npc:${i}`, 0.5).toFixed(4)));
    expect(skills.size).toBeGreaterThan(8);
    const g = cast(8, { affinity: -0.1 });
    expect(decideVisit(4, 2, HOH, g)).toEqual(decideVisit(4, 2, HOH, [...g].reverse()));
  });

  it("the slip never carries the strength: an outcome holds ids and a direction only", () => {
    const v = decideVisit(3, 2, HOH, cast(14, { affinity: -0.2, social: 0.1 }));
    for (const s of v.slipped) expect(Object.keys(s).sort()).toEqual(["direction", "id"]);
    expect(JSON.stringify(v)).not.toMatch(/\d\.\d/);
  });
});

describe("the photos and the letter (pure)", () => {
  const c = { vocation: "ER nurse", hometown: "Dayton, OH", background: "", biography: "She grew up caring for her brothers. She never finished the degree she started. Short.", biographyDraft: false };
  it("every fact is one the character itself carries (true, public) and nothing else", () => {
    const facets = backstoryFacets(c);
    expect(facets.map((f) => f.field).sort()).toEqual(["biography", "biography", "hometown", "vocation"]);
    const own = [c.vocation, c.hometown, c.biography].join(" ");
    for (let seed = 1; seed <= 50; seed++) {
      const f = pickBackstoryFact(seed, HOH, 2, facets, new Set())!;
      expect(own).toContain(f.text);
    }
  });
  it("a keyed pick varies by seed and week, never repeats a used fact, and is undefined when none is left; a draft biography is not used", () => {
    const facets = backstoryFacets(c);
    const picks = new Set(Array.from({ length: 40 }, (_, i) => pickBackstoryFact(i, HOH, 2, facets, new Set())!.text));
    expect(picks.size).toBeGreaterThan(1);
    const used = new Set<string>();
    for (let i = 0; i < facets.length; i++) { const f = pickBackstoryFact(1, HOH, i, facets, used)!; expect(used.has(f.text)).toBe(false); used.add(f.text); }
    expect(pickBackstoryFact(1, HOH, 9, facets, used)).toBeUndefined();
    expect(backstoryFacets({ ...c, biographyDraft: true }).some((f) => f.field === "biography")).toBe(false);
  });
});

type S = {
  recordHohRoom(hoh: string): void;
  setHohRoomEnabled(on: boolean): void;
  livingIds(): string[];
  live: { hohRoom?: { done: string[]; used: string[] } };
  rel: { edge(a: string, b: string): { affinity: number; trust: number; threat: number } };
  snapshot(): { live?: { hohRoom?: unknown } };
  getGameState(): unknown;
  getMomentPrompt(o: object): unknown;
};
async function played(seed: number, on: boolean, hostile: boolean) {
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const user = `hoh-room-${seed}-${on}-${hostile}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" });
  const sb = reg.sandboxFor(user);
  const s = sb.session as unknown as S;
  s.setHohRoomEnabled(on);
  const npcs = s.livingIds().filter((i) => i !== PLAYER);
  const hoh = npcs[0]!;
  if (hostile) for (const id of npcs.slice(1)) { const e = s.rel.edge(id, hoh); e.affinity = -0.25; e.threat = 0.7; }
  const before = sb.engine.events.count();
  s.recordHohRoom(hoh);
  const events = sb.engine.events.queryAll().slice(before).filter((e) => e.type === "hoh-room");
  return { s, sb, hoh, events, npcs };
}

describe("the HOH room in a played game", () => {
  it("opens to the whole house with the player a guest; photos and a letter reveal a true public fact; idempotent per week", async () => {
    const r = await played(5, true, false);
    expect(r.events.length).toBeGreaterThan(1);
    expect(r.events[0]!.witnessSet).toContain(PLAYER);
    expect(r.events[0]!.hidden).toBe(false);
    const letter = r.events.find((e) => e.content.includes("photos and letter"));
    expect(letter, "a fact is revealed to a player who came up").toBeDefined();
    const npc = (r.sb.session as unknown as { house: { npcs: Array<{ id: string; character: Record<string, string | undefined> }> } }).house.npcs.find((n) => n.id === r.hoh)!;
    const own = [npc.character.vocation, npc.character.hometown, npc.character.background, npc.character.biography].join(" ");
    const text = letter!.content.split(": ").slice(1).join(": ");
    expect(own).toContain(text);
    const n = r.sb.engine.events.count();
    r.s.recordHohRoom(r.hoh);
    expect(r.sb.engine.events.count()).toBe(n);
  }, 120_000);

  it("flag off writes nothing and saves nothing (byte-identical)", async () => {
    const r = await played(5, false, true);
    expect(r.events).toHaveLength(0);
    expect(r.s.live.hohRoom).toBeUndefined();
  }, 120_000);

  it("a house with strong feelings against the HOH produces snubs and slips as observable facts; the player is a witness", async () => {
    let snubs = 0, slips = 0;
    for (const seed of [2, 5, 7]) {
      const r = await played(seed, true, true);
      for (const e of r.events) { if (e.content.includes("did not come up")) snubs++; if (e.content.includes("slipped")) slips++; expect(e.witnessSet).toContain(PLAYER); }
    }
    expect(snubs + slips).toBeGreaterThan(0);
  }, 240_000);

  it("save/restore: the visit record survives and is not repeated; the wall holds (no true feeling, no mask, no numbers on any surface)", async () => {
    const r = await played(5, true, true);
    const saved = JSON.parse(JSON.stringify(r.s.snapshot()));
    expect(saved.live.hohRoom.done.length).toBe(1);
    expect(Object.keys(saved.live.hohRoom).sort()).toEqual(["done", "used"]);
    const surfaces = JSON.stringify(r.s.getGameState()) + JSON.stringify(r.s.getMomentPrompt({})) + JSON.stringify(r.events);
    expect(surfaces).not.toMatch(/acting|mask|feelingAgainst|"affinity"|"threat"/i);
    expect(r.events.map((e) => e.content).join(" ")).not.toMatch(/\d\.\d/);
  }, 120_000);

  it("a headless game (never played) is untouched on seeds 3 and 11: nothing recorded, nothing saved, whatever the flag", async () => {
    for (const seed of [3, 11]) {
      const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
      const user = `hoh-room-headless-${seed}`;
      const mcp = reg.resolver()("player", user);
      await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
      const sb = reg.sandboxFor(user);
      const s = sb.session as unknown as S;
      const hoh = s.livingIds().find((i) => i !== PLAYER)!;
      const before = JSON.stringify(sb.engine.events.queryAll());
      s.setHohRoomEnabled(true);
      s.recordHohRoom(hoh);
      expect(JSON.stringify(sb.engine.events.queryAll())).toBe(before);
      expect(s.live.hohRoom).toBeUndefined();
    }
  }, 120_000);
});
