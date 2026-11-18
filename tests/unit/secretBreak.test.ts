import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import {
  SECRET_BREAK, breakDecision, detonateChance, holdersNeeded, isDue, pickSpoken, spokenForm, standingMove, breakLine, type BreakInput,
} from "../../src/engine/secretBreak";

/** 0204 / ORW-647 - the night it all comes out. Roles only: a subject, holders, kept-out houseguests, the player. */
const base: BreakInput = { seed: 7, subject: "s", factId: "f", week: 2, day: 4, holders: 6, pool: 10, volatility: 0.9, steadiness: 0.1, onTheBlock: true, coldness: 0.8, playerSubject: false };

describe("the pure break rule", () => {
  it("a fact is due once enough of the others hold it, never fewer than the floor", () => {
    expect(holdersNeeded(10)).toBe(6);
    expect(holdersNeeded(3)).toBe(SECRET_BREAK.minHolders);
    expect(isDue(5, 10)).toBe(false);
    expect(isDue(6, 10)).toBe(true);
    expect(isDue(0, 0)).toBe(false);
  });
  it("a pressured volatile subject can blow it up; a calm steady one never does; the player never does by the engine's hand", () => {
    expect(detonateChance(base)).toBeGreaterThan(0.2);
    expect(detonateChance({ ...base, volatility: 0, steadiness: 1 })).toBe(0);
    expect(detonateChance({ ...base, playerSubject: true })).toBe(0);
    expect(detonateChance({ ...base, holders: 1 })).toBe(0); // not closing in yet
    let hot = 0, calm = 0;
    for (let d = 0; d < 200; d++) {
      if (breakDecision({ ...base, holders: 4, day: d }) === "detonated") hot++;
      if (breakDecision({ ...base, holders: 4, day: d, volatility: 0, steadiness: 1 }) === "detonated") calm++;
    }
    expect(hot).toBeGreaterThan(5);
    expect(calm).toBe(0);
  });
  it("is deterministic and keyed (same inputs same answer, a different night can differ)", () => {
    expect(breakDecision(base)).toBe(breakDecision({ ...base }));
    const kinds = new Set(Array.from({ length: 60 }, (_, d) => String(breakDecision({ ...base, day: d }))));
    expect(kinds.size).toBeGreaterThan(1);
  });
  it("a self-detonation costs the subject less than being caught; the floor line carries only names and the fact as spoken", () => {
    const a = standingMove(0.6, "exposed"), b = standingMove(0.6, "detonated");
    expect(Math.abs(b.trust)).toBeLessThan(Math.abs(a.trust));
    expect(spokenForm("they hid it · maybe#123")).toBe("they hid it");
    expect(pickSpoken([{ holder: "b", content: "x · h#1", confidence: 0.5 }, { holder: "a", content: "y", confidence: 0.9 }])).toBe("y");
    const line = breakLine("exposed", "Subject", "they hid it", "two");
    expect(line).toContain("they hid it");
    expect(line).not.toMatch(/\d\.\d/);
  });
});

type S = {
  secretBreakTick(k: unknown): void;
  setSecretBreaksEnabled(on: boolean): void;
  livingIds(): string[];
  live: { playedGame?: boolean; secretBreaks?: string[]; dayNumber?: number; nominees?: string[]; grudges?: Record<string, unknown> };
  rel: { peek(a: string, b: string): { affinity: number; trust: number } };
  house: { npcs: Array<{ id: string; soul: { volatility: number; emotionalState: number } }> };
  snapshot(): { live?: { secretBreaks?: string[] } };
  getGameState(): unknown;
  getMomentPrompt(o: object): unknown;
};
async function game(seed: number, tag: string, opts: { on?: boolean } = {}) {
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const user = `secret-break-${tag}-${seed}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" });
  const sb = reg.sandboxFor(user);
  const s = sb.session as unknown as S;
  s.setSecretBreaksEnabled(opts.on ?? true);
  const npcs = s.livingIds().filter((i) => i !== PLAYER);
  return { s, sb, npcs, k: sb.engine.knowledge };
}
const hold = (g: Awaited<ReturnType<typeof game>>, holders: string[], subject: string, factId: string, content: string): void => {
  for (const h of holders) g.k.seedBelief(h, { content, factId, subject, confidence: 0.8, hops: 1, distortion: 0 }, "told-by:x");
};
const nights = (g: Awaited<ReturnType<typeof game>>, n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    g.s.live.dayNumber = (g.s.live.dayNumber ?? 1) + 1;
    const before = g.sb.engine.events.count();
    g.s.secretBreakTick(g.k);
    for (const e of g.sb.engine.events.queryAll().slice(before)) if (e.type === "secret-break") out.push(e.content);
  }
  return out;
};
const events = (g: Awaited<ReturnType<typeof game>>) => g.sb.engine.events.queryAll().filter((e) => e.type === "secret-break");

describe("the night it all comes out, in a played game", () => {
  it("a secret held by enough of the house breaks in front of the room: a witnessed event, everyone present holds it, once only", async () => {
    const g = await game(5, "out");
    const [subject, ...others] = g.npcs;
    const calm = g.s.house.npcs.find((n) => n.id === subject)!.soul; calm.volatility = 0; calm.emotionalState = 1;
    const need = holdersNeeded(others.length);
    const holders = others.slice(0, need);
    hold(g, holders, subject!, "fact:out", "the subject hid a past · hedge#9");
    const said = nights(g, 40);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("the subject hid a past");
    expect(said[0]).not.toContain("hedge");
    const ev = events(g)[0]!;
    expect(ev.hidden).toBe(false);
    expect(ev.witnessSet).toContain(PLAYER);
    for (const o of others) expect(g.k.knownTo(o).some((f) => f.factId === "fact:out")).toBe(true);
    const keptOut = others.find((o) => !holders.includes(o));
    if (keptOut) expect(g.k.knownTo(keptOut).find((f) => f.factId === "fact:out")!.pathway).toBe("public");
    expect(nights(g, 10)).toHaveLength(0); // once per fact
    expect(g.s.snapshot().live!.secretBreaks).toEqual(["fact:out"]);
  }, 120_000);

  it("the room re-reads the subject, and a houseguest kept out holds it against the holder they trusted most", async () => {
    const g = await game(5, "fold");
    const [subject, ...others] = g.npcs;
    const calm = g.s.house.npcs.find((n) => n.id === subject)!.soul; calm.volatility = 0; calm.emotionalState = 1;
    const holders = others.slice(0, holdersNeeded(others.length));
    const keptOut = others.find((o) => !holders.includes(o));
    if (!keptOut) return; // a house where everyone holds it has no one to be kept out
    const before = g.s.rel.peek(keptOut, subject!).trust;
    hold(g, holders, subject!, "fact:fold", "a thing");
    expect(nights(g, 40)).toHaveLength(1);
    expect(g.s.rel.peek(keptOut, subject!).trust).toBeLessThan(before);
    expect(Math.abs(g.s.rel.peek(keptOut, subject!).trust - before)).toBeLessThan(0.2); // bounded
    const grudges = JSON.stringify(g.s.live.grudges ?? {});
    expect(grudges).toContain(keptOut);
  }, 120_000);

  it("a pressured, volatile subject blows up their own secret before it is due; a calm one does not", async () => {
    const hot = await game(5, "hot");
    const [subject, ...others] = hot.npcs;
    const soul = hot.s.house.npcs.find((n) => n.id === subject)!.soul; soul.volatility = 1; soul.emotionalState = 0;
    hot.s.live.nominees = [subject!, others[0]!];
    const some = others.slice(0, Math.max(1, Math.ceil(others.length * SECRET_BREAK.closingShare)));
    expect(isDue(some.length, others.length)).toBe(false);
    hold(hot, some, subject!, "fact:hot", "the subject's own thing");
    const said = nights(hot, 60);
    expect(said.length).toBe(1);
    expect(said[0]).toContain("blew up their own secret");

    const cool = await game(5, "cool");
    const s2 = cool.npcs[0]!;
    const soul2 = cool.s.house.npcs.find((n) => n.id === s2)!.soul; soul2.volatility = 0; soul2.emotionalState = 1;
    hold(cool, cool.npcs.slice(1, 1 + some.length), s2, "fact:cool", "the subject's own thing");
    expect(nights(cool, 60)).toHaveLength(0);
  }, 120_000);

  it("the player as the subject: the room hears what was said, the engine never detonates for them, and nothing else crosses", async () => {
    const g = await game(5, "pl");
    hold(g, g.npcs, PLAYER, "fact:pl", "the player kept a thing quiet");
    hold(g, g.npcs.slice(0, 1), g.npcs[1]!, "fact:other", "SENTINEL_UNSPOKEN_SECRET");
    const said = nights(g, 40);
    expect(said.length).toBeGreaterThanOrEqual(1);
    expect(said.every((c) => !c.includes("blew up"))).toBe(true);
    const surfaces = JSON.stringify(g.s.getGameState()) + JSON.stringify(g.s.getMomentPrompt({})) + JSON.stringify(events(g));
    expect(surfaces).not.toContain("SENTINEL_UNSPOKEN_SECRET");
    const otherNames = g.s.house.npcs.map((n) => (n as unknown as { character: { name: string } }).character.name);
    const spoken = events(g).map((e) => e.content).join(" ");
    for (const nm of otherNames) expect(spoken).not.toContain(nm); // the line names the subject (the player) only: no holder list
    expect(said.join(" ")).not.toMatch(/\d\.\d/);
    // The player is a witness (not a holder): no belief was written for them by the break.
    expect(g.k.knownTo(PLAYER).some((f) => f.pathway === "public")).toBe(false);
  }, 120_000);

  it("flag off and a headless game (seeds 3 and 11) record and save nothing", async () => {
    const off = await game(5, "off", { on: false });
    hold(off, off.npcs.slice(1), off.npcs[0]!, "fact:off", "x");
    expect(nights(off, 20)).toHaveLength(0);
    expect(off.s.live.secretBreaks).toBeUndefined();
    for (const seed of [3, 11]) {
      const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
      const user = `secret-break-headless-${seed}`;
      const mcp = reg.resolver()("player", user);
      await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
      const sb = reg.sandboxFor(user);
      const s = sb.session as unknown as S;
      const npcs = s.livingIds().filter((i) => i !== PLAYER);
      for (const h of npcs.slice(1)) sb.engine.knowledge.seedBelief(h, { content: "x", factId: "fact:h", subject: npcs[0]! }, "told-by:x");
      const before = JSON.stringify(sb.engine.events.queryAll());
      s.secretBreakTick(sb.engine.knowledge);
      expect(JSON.stringify(sb.engine.events.queryAll())).toBe(before);
      expect(s.live.secretBreaks).toBeUndefined();
    }
  }, 240_000);
});
