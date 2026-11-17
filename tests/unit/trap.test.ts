import { describe, it, expect } from "vitest";
import { TRAP, canaryReturned, canarySubject, doubtsDiscretionOf } from "../../src/engine/trap";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";

/** Feature 0188 - the trap. Roles only: a setter (s), a suspect (t), a canary subject (x), a go-between (y), the player. */
const belief = (holder: string, extra: Partial<BeliefClaim>): BeliefClaim =>
  ({ id: `${holder}|${extra.kind}|${extra.subject}|${extra.source ?? ""}|${extra.nature ?? ""}`, holder, value: true, origin: "told", confidence: 0.4, week: 2, ...extra }) as BeliefClaim;

describe("the trap (trap.ts)", () => {
  it("a doubt about someone's discretion is one the holder is still testing: a rumor they talk or lie, or an unsure lie", () => {
    const held = [
      belief("s", { kind: "heard-rumor", nature: "talking-about", subject: "t", object: "q" }),
      belief("s", { kind: "heard-rumor", nature: "going-after", subject: "u", object: "q" }), // not about discretion
      belief("s", { kind: "lied-to-me", subject: "v", confidence: 0.9 }), // already a fact: not a doubt
    ];
    expect(doubtsDiscretionOf(held, "s")).toEqual(["t"]);
  });
  it("the canary is made up: about the one the setter fears most among those it would be FALSE about", () => {
    const threat: Record<string, number> = { a: 0.9, b: 0.6, c: 0.3 };
    expect(canarySubject("s", "t", ["s", "t", "a", "b", "c"], (x) => threat[x] ?? 0, (x) => x === "a")).toBe("b");
    expect(canarySubject("s", "t", ["s", "t", "a"], () => 0.5, () => true)).toBeUndefined();
  });
  it("it comes back when the setter is told it by anyone but the suspect", () => {
    const trap = { setter: "s", suspect: "t", subject: "x", week: 2 };
    const told = (source: string) => belief("s", { kind: "heard-rumor", nature: "going-after", subject: "x", object: "s", source });
    expect(canaryReturned(trap, [told("t")])).toBeUndefined(); // the suspect telling it back is not a leak
    expect(canaryReturned(trap, [told("y")])).toBe("y");
  });
});

describe("the trap in the live house", () => {
  type Seam = {
    live: { playedGame?: boolean; week: number; dayNumber?: number; beliefs?: Record<string, BeliefClaim[]>; traps?: Array<{ setter: string; suspect: string; subject: string; status: string; factId: string }>; trapsDay?: number; claims?: { items: Array<{ speaker: string; listener: string }> } };
    rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number } };
    trapTick(k: InMemoryKnowledgeService): void; credulityOf(id: string): number; claimsToPlayerFor(id: string): unknown; disclosureEpoch: number;
  };
  function house(seed: number, suspectIsPlayer: boolean) {
    const sb = new GameSessionRegistry().sandboxFor(`trap-${seed}-${suspectIsPlayer}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    const g = sb.session as unknown as Seam;
    g.live.playedGame = true;
    const [setter, npcSuspect, y] = sb.session.livingIds().filter((id) => id !== PLAYER);
    const suspect = suspectIsPlayer ? PLAYER : npcSuspect!;
    g.credulityOf = (id) => (id === setter ? 0.2 : 0.6); // TEST-ONLY seam: only the setter is suspicious
    g.live.beliefs = { [setter!]: [belief(setter!, { kind: "heard-rumor", nature: "talking-about", subject: suspect, object: y!, week: g.live.week })] };
    const knowledge = new InMemoryKnowledgeService(new InMemoryEventStore());
    // set the trap (the setter's daily roll: try days until it fires)
    for (let d = 1; d <= 40 && !(g.live.traps ?? []).length; d++) { g.live.dayNumber = d; g.trapTick(knowledge); }
    return { g, setter: setter!, suspect, y: y!, knowledge, trap: () => g.live.traps![0]! };
  }
  it("a suspicious houseguest who doubts a houseguest's discretion sets a trap: a made-up secret told to them alone", () => {
    const { g, setter, suspect, knowledge, trap } = house(51, false);
    expect(trap().setter).toBe(setter);
    expect(trap().suspect).toBe(suspect);
    expect(trap().status).toBe("open");
    const told = (g.live.claims?.items ?? []).filter((c) => c.speaker === setter);
    expect(told.map((c) => c.listener)).toEqual([suspect]); // only the suspect was told
    expect(knowledge.knownTo(suspect).some((f) => f.factId === trap().factId)).toBe(true); // they hold it, so the house can carry it on
  });
  it("when it comes back from someone else, the setter knows who leaked: trust falls and they hold that the suspect talks", () => {
    const { g, setter, suspect, y, knowledge, trap } = house(52, false);
    const before = g.rel.edge(setter, suspect).trust;
    knowledge.transmitGossip(y, setter, { content: "it came back", factId: trap().factId, subject: trap().subject, confidence: 0.6, source: y, hops: 2, distortion: 0 }, `told-by:${y}`);
    g.live.dayNumber = (g.live.dayNumber ?? 0) + 1; g.trapTick(knowledge);
    expect(trap().status).toBe("sprung");
    expect(g.rel.edge(setter, suspect).trust).toBeLessThan(before);
    expect((g.live.beliefs?.[setter] ?? []).some((b) => b.kind === "heard-rumor" && b.nature === "talking-about" && b.subject === suspect && b.confidence >= TRAP.springConfidence)).toBe(true);
  });
  it("if it never comes back, the suspect passed: the setter trusts them a little more", () => {
    const { g, setter, suspect, knowledge, trap } = house(53, false);
    const before = g.rel.edge(setter, suspect).trust;
    for (let i = 0; i < TRAP.watchDays; i++) { g.live.dayNumber = (g.live.dayNumber ?? 0) + 1; g.trapTick(knowledge); }
    expect(trap().status).toBe("held");
    expect(g.rel.edge(setter, suspect).trust).toBeGreaterThan(before);
  });
  it("the player can be trapped: the canary is said to them the next time the setter is with them, as an ordinary confidence; repeated through someone back to the setter, it springs", () => {
    const { g, setter, y, knowledge, trap } = house(54, true);
    expect(trap().status).toBe("pending");
    g.disclosureEpoch += 1;
    const tells = g.claimsToPlayerFor(setter) as Record<string, unknown>;
    expect(tells).toBeTruthy();
    expect(Object.keys(tells).sort()).toEqual(["certainty", "kind", "object", "subject"]); // the same fields as any confidence: no tell that it is a trap
    expect(trap().status).toBe("open");
    // the player repeats it to someone, who tells the setter
    (g.live.beliefs![setter] ??= []).push(belief(setter, { kind: "heard-rumor", nature: "going-after", subject: trap().subject, object: setter, source: y, week: g.live.week }));
    const before = g.rel.edge(setter, PLAYER).trust;
    g.live.dayNumber = (g.live.dayNumber ?? 0) + 1; g.trapTick(knowledge);
    expect(trap().status).toBe("sprung");
    expect(g.rel.edge(setter, PLAYER).trust).toBeLessThan(before);
  });
});

describe("0188 part 2 / ORW-627: a planted story can be overheard", () => {
  it("only awake bystanders in the room, never the two speaking, each on their own roll", async () => {
    const { overhearers } = await import("../../src/engine/trap");
    const rolls: Record<string, number> = { a: 0.1, b: 0.9, c: 0.1, s: 0, l: 0 };
    expect(overhearers(["s", "l", "a", "b", "c"], "s", "l", (id) => id !== "c", (id) => rolls[id]!)).toEqual(["a"]);
  });
  it("in the live house: a houseguest who overhears holds that the planter talks behind the target's back; the player who overhears hears the words", () => {
    const sb = new GameSessionRegistry().sandboxFor("overhear-plant");
    sb.session.createCharacter({ playerName: "The Player", seed: 61 });
    const g = sb.session as unknown as { live: { playedGame?: boolean; week: number; beliefs?: Record<string, BeliefClaim[]> }; overhearPlant(c: unknown, place: string, presence: Map<string, string>, salt: string): void; onPlayerEvent?: (c: string, w: string[], k: string) => void };
    g.live.playedGame = true;
    (g as unknown as { awakeNow(): null }).awakeNow = () => null; // TEST-ONLY seam: the whole house is up
    const [planter, listener, target, ...rest] = sb.session.livingIds().filter((id) => id !== PLAYER);
    const events: Array<{ content: string; witnesses: string[] }> = [];
    const prior = g.onPlayerEvent; g.onPlayerEvent = (content, witnesses, kind) => { events.push({ content, witnesses }); prior?.(content, witnesses, kind); };
    const presence = new Map<string, string>([[planter!, "kitchen"], [listener!, "kitchen"], [PLAYER, "kitchen"], ...rest.map((id) => [id, "kitchen"] as [string, string])]);
    const claim = { id: "c1", speaker: planter!, listener: listener!, kind: "going-after", subject: target!, object: listener!, week: g.live.week };
    let heardBy: string[] = [];
    for (let k = 0; k < 30 && (heardBy.length === 0 || !events.some((e) => e.witnesses.includes(PLAYER))); k++) {
      g.overhearPlant({ ...claim, id: `c${k}` }, "kitchen", presence, `salt-${k}`);
      heardBy = Object.entries(g.live.beliefs ?? {}).filter(([, bs]) => bs.some((b) => b.origin === "overheard" && b.subject === planter && b.object === target)).map(([h]) => h);
    }
    expect(heardBy.length).toBeGreaterThan(0);
    expect(heardBy).not.toContain(planter); expect(heardBy).not.toContain(listener);
    const mine = events.filter((e) => e.witnesses.includes(PLAYER) && /overhears/.test(e.content));
    expect(mine.length).toBeGreaterThan(0); // the player in the room overheard it at least once
    expect(mine.every((e) => !/\b(true|false|lie|lying)\b/i.test(e.content.split(" that ")[1] ?? ""))).toBe(true); // the words, never whether they are true
  });
});
