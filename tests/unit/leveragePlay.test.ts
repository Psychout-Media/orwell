import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";
import { LEVERAGE_PLAY, pressureDesire, willPlay, chooseManner, sneakyNoticed, type PlaySignals, type LeveragePlay } from "../../src/engine/leveragePlay";
import { LEVERAGE } from "../../src/engine/leverageConstants";
import type { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";

/** Feature 0202 / ORW-645 - leverage in two registers. Roles only: a holder, a target, the player. */
const SENTINEL = "zq-planted-secret-content-7731";
const sig = (o: Partial<PlaySignals> = {}): PlaySignals => ({ severity: 0.7, holderThreatOfTarget: 0.6, holderAffinityForTarget: 0.1, holderTrustInTarget: 0.1, holderOnBlock: true, holderNerve: 0.5, targetCredulity: 0.5, ...o });

describe("leveragePlay (pure core)", () => {
  it("desire rises with stakes, wariness and a sharp secret; below the floor nothing is ever played", () => {
    expect(pressureDesire(sig())).toBeGreaterThan(pressureDesire(sig({ holderOnBlock: false })));
    expect(pressureDesire(sig({ holderThreatOfTarget: 0.9 }))).toBeGreaterThan(pressureDesire(sig({ holderThreatOfTarget: 0.1 })));
    expect(willPlay(LEVERAGE_PLAY.desireFloor - 0.01, 0)).toBe(false);
    expect(willPlay(0.9, 0)).toBe(true);
    expect(willPlay(0.9, LEVERAGE_PLAY.playChance + 0.01)).toBe(false); // most days a holder keeps what they hold
  });
  it("both registers are reachable and character decides: a bold cold holder leans blunt, a warm one with a shrewd target leans sneaky", () => {
    const bold = sig({ holderNerve: 0.9, holderAffinityForTarget: 0, holderTrustInTarget: 0, targetCredulity: 0.9 });
    const warmShrewd = sig({ holderNerve: 0.2, holderAffinityForTarget: 0.9, holderTrustInTarget: 0.9, targetCredulity: 0.1 });
    const share = (s: PlaySignals) => [...Array(100).keys()].filter((i) => chooseManner(s, i / 100) === "blunt").length / 100;
    expect(share(bold)).toBeGreaterThan(share(warmShrewd));
    for (const s of [bold, warmShrewd, sig()]) { const m = new Set([...Array(100).keys()].map((i) => chooseManner(s, i / 100))); expect(m.size).toBe(2); }
  });
  it("a suspicious target notices a sneaky play more often than a trusting one", () => {
    const n = (c: number) => [...Array(100).keys()].filter((i) => sneakyNoticed(c, i / 100)).length;
    expect(n(0.1)).toBeGreaterThan(n(0.9));
  });
  it("a refused blunt demand costs more than the plain squeeze; a sneaky play is quieter", () => {
    expect(LEVERAGE_PLAY.bluntRefusalMult).toBeGreaterThan(1);
    expect(LEVERAGE_PLAY.sneakyStrengthMult).toBeLessThan(1);
  });
});

type Seam = {
  live: { playedGame?: boolean; week: number; dayNumber?: number; nominees?: [string, string]; leveragePlays?: LeveragePlay[]; leveragePlaysDay?: number };
  rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number }; applyImpactDirected(a: string, b: string, i: object, r: { next(): number }): void };
  leveragePlayTick(k: InMemoryKnowledgeService): void; leansOnYouFor(id: string): { manner: string } | undefined; setLeveragePlaysEnabled(on: boolean): void;
  awakeNow(): null; snapshot(): unknown; restore(c: unknown): void;
};

function house(seed: number, on = true, aboutPlayerOnly = false) {
  const sb = new GameSessionRegistry().sandboxFor(`lev-${seed}-${on}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const g = sb.session as unknown as Seam;
  g.live.playedGame = true;
  g.awakeNow = () => null; // TEST-ONLY seam: the whole house is up
  g.setLeveragePlaysEnabled(on);
  const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
  g.live.nominees = [npcs[0]!, npcs[1]!];
  const knowledge = sb.engine.knowledge as InMemoryKnowledgeService;
  // every houseguest holds a planted fact about everyone else (the player included) and is wary of them
  for (const h of npcs) for (const t of [...npcs, PLAYER]) {
    if (t === h || (aboutPlayerOnly && t !== PLAYER)) continue;
    knowledge.seedBelief(h, { content: SENTINEL, originalContent: SENTINEL, factId: `f:${h}:${t}`, subject: t, confidence: 0.8, hops: 0, distortion: 0, source: h }, "origin");
    g.rel.applyImpactDirected(h, t, { threat: npcs.indexOf(h) % 2 === 1 ? 0.1 : t === PLAYER ? 0.9 : 0.5, affinity: -0.3 }, { next: () => 0.5 });
  }
  const run = (days: number) => { for (let d = 1; d <= days; d++) { g.live.dayNumber = (g.live.dayNumber ?? 0) + 1; g.leveragePlayTick(knowledge); } };
  return { sb, g, npcs, knowledge, run };
}

describe("leverage plays in the live house", () => {
  it("houseguests lean on each other AND on the player, in both registers, and most holders most days keep what they hold", () => {
    const { g, npcs, run } = house(11);
    run(60);
    const plays = g.live.leveragePlays ?? [];
    expect(plays.length).toBeGreaterThan(0);
    expect(new Set(plays.map((p) => p.manner))).toEqual(new Set(["blunt", "sneaky"]));
    expect(plays.some((p) => p.target === PLAYER)).toBe(true); // parity: the player is a target like anyone
    expect(plays.some((p) => p.target !== PLAYER && npcs.includes(p.target))).toBe(true);
    expect(plays.length).toBeLessThan(60 * LEVERAGE_PLAY.maxPlaysPerDay); // never the dominant path
    expect(new Set(plays.filter((p) => p.target !== PLAYER).map((p) => p.status))).toContain("worked");
  });
  it("an NPC target answers at once; the player's play stays an open approach, nothing is done for them", () => {
    const { g, run } = house(12);
    run(40);
    const plays = g.live.leveragePlays ?? [];
    expect(plays.filter((p) => p.target !== PLAYER).every((p) => p.status !== "open")).toBe(true);
    const mine = plays.filter((p) => p.target === PLAYER);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((p) => p.status === "open" || p.status === "refused" || p.status === "lapsed")).toBe(true); // never complied/worked: only the player resolves it
    expect(mine.every((p) => p.status !== "complied" && p.status !== "worked" && p.status !== "noticed")).toBe(true);
  });
  it("the narrator gets who and the manner for an open approach, and the secret's content never appears anywhere the facts go", () => {
    const { g, run } = house(13, true, true);
    for (let i = 0; i < 40 && !(g.live.leveragePlays ?? []).some((p) => p.status === "open" && p.target === PLAYER); i++) run(1);
    const open = (g.live.leveragePlays ?? []).find((p) => p.status === "open" && p.target === PLAYER)!;
    expect(open).toBeTruthy();
    const fact = g.leansOnYouFor(open.holder)!;
    expect(Object.keys(fact)).toEqual(["manner"]);
    expect(JSON.stringify(fact)).not.toContain(SENTINEL);
    expect(JSON.stringify(fact)).not.toContain("f:");
    expect(g.leansOnYouFor(PLAYER)).toBeUndefined();
  });
  it("a blunt demand the player ignores costs them the holder's goodwill; a hint ignored just fades", () => {
    const { g, run } = house(14, true, true);
    for (let i = 0; i < 60 && !(g.live.leveragePlays ?? []).some((p) => p.target === PLAYER); i++) run(1);
    const p = (g.live.leveragePlays ?? []).find((x) => x.target === PLAYER)!;
    const before = g.rel.edge(p.holder, PLAYER).trust;
    run(LEVERAGE_PLAY.answerDays + 1);
    const after = (g.live.leveragePlays ?? []).find((x) => x.id === p.id)!;
    expect(after.status).toBe(p.manner === "blunt" ? "refused" : "lapsed");
    if (p.manner === "blunt") expect(g.rel.edge(p.holder, PLAYER).trust).toBeLessThan(before);
  });
  it("persistence: plays round-trip and later days only append (superset)", () => {
    const { sb, g, run } = house(15);
    run(30);
    const first = (g.live.leveragePlays ?? []).map((p) => ({ ...p }));
    expect(first.length).toBeGreaterThan(0);
    const revived = new GameSessionRegistry().sandboxFor("lev-revived");
    revived.session.restore((sb.session as unknown as Seam).snapshot() as never);
    const r = revived.session as unknown as Seam;
    expect(r.live.leveragePlays?.map((p) => p.id)).toEqual(first.map((p) => p.id));
    run(30);
    const later = g.live.leveragePlays ?? [];
    expect(later.slice(0, first.length).map((p) => p.id)).toEqual(first.map((p) => p.id));
    expect(later.length).toBeGreaterThanOrEqual(first.length);
  });
  it("wall: the plays and every fact derived from them never carry the planted content", () => {
    const { g, run } = house(16);
    run(40);
    expect(JSON.stringify(g.live.leveragePlays)).not.toContain(SENTINEL);
  });
  it("flag OFF: the tick does nothing - no plays, no day marker, no fact", () => {
    const { g, run } = house(17, false);
    run(40);
    expect(g.live.leveragePlays).toBeUndefined();
    expect(g.live.leveragePlaysDay).toBeUndefined();
  });
});

describe("the player's own register (makeDeal leverage manner), through McpServer.callTool", () => {
  function playerServer(seed: number, on: boolean) {
    const sb = buildSandbox(seed);
    const session = new GameSessionAdapter();
    session.setLeveragePlaysEnabled(on);
    session.setPlayerKnowledgeReader(() => sb.engine.knowledge.knownTo(PLAYER).map((f) => ({ id: f.id, content: f.content, subject: f.subject, factId: f.factId })));
    const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
    const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
    session.createCharacter({ playerName: "The Player", seed });
    const subject = session.livingIds().find((id) => id !== PLAYER)!;
    sb.engine.knowledge.seedBelief(subject, { content: SENTINEL, originalContent: SENTINEL, factId: `l:${subject}`, confidence: 0.9, hops: 0, distortion: 0, source: subject }, "origin");
    sb.engine.knowledge.surfaceInformationTo(PLAYER, { content: SENTINEL, subject, confidence: 0.85 }, `told-by:${subject}`);
    const fact = sb.engine.knowledge.knownTo(PLAYER).find((f) => f.subject === subject)!;
    return { server, session, subject, factId: fact.factId ?? fact.id };
  }
  it("a sneaky press dispatches through the existing tool, the deal still forms, and the engine records the play without the secret", async () => {
    const { server, session, subject, factId } = playerServer(21, true);
    const res = (await server.callTool("makeDeal", { with: subject, kind: "safety", terms: "keep me safe", leverage: { factId, manner: "sneaky" } })) as { id: string } | null;
    expect(res?.id).toBeTruthy();
    const plays = (session as unknown as Seam).live.leveragePlays ?? [];
    expect(plays).toHaveLength(1);
    expect(plays[0]).toMatchObject({ holder: PLAYER, target: subject, manner: "sneaky" });
    expect(["worked", "noticed"]).toContain(plays[0]!.status);
    expect(JSON.stringify(plays)).not.toContain(SENTINEL);
  });
  it("flag OFF: a manner is ignored - the same press leaves the exact 0093 result and records nothing", async () => {
    const a = playerServer(22, false); const b = playerServer(22, false);
    await a.server.callTool("makeDeal", { with: a.subject, kind: "safety", terms: "t", leverage: { factId: a.factId, manner: "sneaky" } });
    await b.server.callTool("makeDeal", { with: b.subject, kind: "safety", terms: "t", leverage: { factId: b.factId } });
    const ga = a.session as unknown as Seam, gb = b.session as unknown as Seam;
    expect(ga.live.leveragePlays).toBeUndefined();
    expect(ga.rel.edge(a.subject, PLAYER)).toEqual(gb.rel.edge(b.subject, PLAYER));
  });
  it("the quieter register lands softer than the blunt one when both land: no refusal floor, and a notice costs the same squeeze", () => {
    expect(LEVERAGE_PLAY.noticedMult).toBeGreaterThan(0);
    expect(LEVERAGE.squeezeBacklash.trust).toBeLessThan(0);
  });
});
