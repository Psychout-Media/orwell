import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GameSessionRegistry } from "../../src/composition/registry";
import { HEART, heartAgainstGame, keepAfterHeart, romancePairKey, sentimentOf, shakenKey } from "../../src/engine/heartAgainstGame";
import { ANSWER_BAR, npcDrawnToPlayer, playerInShowmanceWith, playerStartedShowmanceScenes, type SceneLike } from "../../src/engine/playerShowmance";
import { BOND, emptyBond, foldBreak, foldBreakup, bondKey, type BondStore } from "../../src/engine/bondRecord";
import { GRUDGES } from "../../src/engine/grudges";
import { voteChoice } from "../../src/engine/liveSeason";
import type { Orientation, GenderPresentation } from "../../src/engine/diversityConstants";

/** Theme A slices A3 + A4 (0207, ORW-660/661): heart against game, the worst rupture, the player's own showmance. Roles only. */
const PLAYER = "player";

describe("A3 pure: sentiment and the heart-against-game weighing", () => {
  it("sentiment follows who the houseguest is, and stays inside 0..1", () => {
    const s = (style: string, volatility = 0.5, keeper = false, bonding = 1) => sentimentOf({ style, volatility, keeper, bonding });
    expect(s("emotional")).toBeGreaterThan(s("strategic"));
    expect(s("strategic")).toBeGreaterThan(s("aggressive") - 0.0001);
    expect(s("social", 0.9)).toBeGreaterThan(s("social", 0.1));
    expect(s("loyal", 0.5, true)).toBeLessThan(s("loyal", 0.5, false));
    expect(s("loyal", 0.5, false, 1.3)).toBeGreaterThan(s("loyal", 0.5, false, 1));
    expect(sentimentOf({ volatility: 0.5, keeper: false })).toBeCloseTo(0.7 * HEART.styleDefault + 0.3 * 0.5, 9);
    for (const style of ["emotional", "aggressive", "unknown"]) for (const v of [-5, 0, 1, 9, NaN]) for (const b of [0, 1, 99]) {
      const x = sentimentOf({ style, volatility: v, keeper: true, bonding: b });
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1);
    }
  });
  it("no conflict unless both ties are real; then the same ties go different ways by nature, deterministically", () => {
    const base = { romanceTie: 0.9, allianceTie: 0.8, mutual: true };
    expect(heartAgainstGame({ ...base, romanceTie: HEART.romanceBar - 0.01, sentiment: 0.5 }).conflict).toBe(false);
    expect(heartAgainstGame({ ...base, allianceTie: HEART.allianceBar - 0.01, sentiment: 0.5 }).conflict).toBe(false);
    const soft = heartAgainstGame({ ...base, sentiment: sentimentOf({ style: "emotional", volatility: 0.5, keeper: false }) });
    const hard = heartAgainstGame({ ...base, sentiment: sentimentOf({ style: "aggressive", volatility: 0.5, keeper: true }) });
    expect(soft).toMatchObject({ conflict: true, heartWon: true });
    expect(hard).toMatchObject({ conflict: true, heartWon: false });
    expect(heartAgainstGame({ ...base, sentiment: 0.7 })).toEqual(heartAgainstGame({ ...base, sentiment: 0.7 }));
    expect(heartAgainstGame({ ...base, sentiment: 0.5, loyalty: 1.3 }).margin).not.toBe(heartAgainstGame({ ...base, sentiment: 0.5, loyalty: 1 }).margin);
  });
  it("the nudge is bounded: a winning heart adds at most the boost, a winning game never strips the whole hold", () => {
    expect(keepAfterHeart(0.1, { conflict: false, heartWon: true, margin: 1 })).toBe(0.1);
    for (const m of [0, 0.3, 1]) {
      expect(keepAfterHeart(0.1, { conflict: true, heartWon: true, margin: m })).toBeLessThanOrEqual(0.1 + HEART.boost + 1e-12);
      expect(keepAfterHeart(0.1, { conflict: true, heartWon: false, margin: m })).toBeGreaterThan(0);
      expect(keepAfterHeart(0.1, { conflict: true, heartWon: false, margin: m })).toBeLessThanOrEqual(0.1);
    }
    expect(HEART.cut).toBeLessThan(1);
    expect(romancePairKey("b", "a")).toBe(romancePairKey("a", "b"));
    expect(shakenKey(2, "h", "p")).toBe("heart:2:h:p");
  });
});

describe("A3 pure: a breakup is deeper than a broken deal", () => {
  it("the grudge, the strain and the warmth lost all exceed a broken deal's; history and the romance count are kept", () => {
    expect(GRUDGES.HEARTBREAK_SEVERITY).toBeGreaterThan(GRUDGES.DEAL_BREAK_SEVERITY);
    expect(BOND.breakupStrain).toBeGreaterThan(BOND.strainPerBreak);
    expect(BOND.breakerBreakupStrain).toBeGreaterThan(BOND.breakerStrain);
    expect(BOND.breakupWarmthLoss).toBeGreaterThan(BOND.breakerWarmthLoss);
    const mk = (): BondStore => ({ [bondKey("w", "l")]: { ...emptyBond(), warmth: 0.8, romance: 3, history: 5 }, [bondKey("l", "w")]: { ...emptyBond(), warmth: 0.8, romance: 3, history: 5 } });
    const a = mk(), b = mk();
    foldBreakup(a, "l", "w", { bookHoldsWrong: true });
    foldBreak(b, "l", "w", { bookHoldsWrong: true });
    expect(a["w|l"]!.strain).toBeGreaterThan(b["w|l"]!.strain);
    expect(a["w|l"]!.warmth).toBeLessThan(b["w|l"]!.warmth);
    expect(a["l|w"]!.strain).toBeGreaterThan(b["l|w"]!.strain);
    expect(a["w|l"]!.romance).toBe(3); expect(a["w|l"]!.history).toBe(6); // never degraded
    expect(a["w|l"]!.resentment).toBe(0); // the book holds the wrong
    const c = mk(); foldBreakup(c, "l", "w");
    expect(c["w|l"]!.resentment).toBeGreaterThan(BOND.resentPerBreak); // without the book, the record carries the grudge, heavier than a break's
  });
});

describe("A4 pure: the player's showmance is only by their own acts", () => {
  const ev = (o: Partial<SceneLike>): SceneLike => ({ type: "conversation", initiator: PLAYER, interactionKind: "showmance", witnessSet: [PLAYER, "n"], ...o });
  it("only scenes the player started, filed as a showmance, with that houseguest, count", () => {
    expect(playerStartedShowmanceScenes([ev({}), ev({}), ev({ initiator: "n" }), ev({ interactionKind: "bonding" }), ev({ type: "showmance" }), ev({ witnessSet: [PLAYER, "m"] })], "n")).toBe(2);
    expect(playerInShowmanceWith([ev({ initiator: "n" })], "n", true)).toBe(false); // a houseguest's own scene never makes the player romantic
    expect(playerInShowmanceWith([ev({})], "n", false)).toBe(false);
    expect(playerInShowmanceWith([ev({})], "n", true)).toBe(true);
  });
  it("nobody is drawn to a player who has not said their gender, whatever the orientation; once said, only by the houseguest's own orientation", () => {
    const orientations: Orientation[] = ["straight", "gay", "lesbian", "bisexual", "pansexual", "queer"];
    const genders: GenderPresentation[] = ["man", "woman", "nonbinary"];
    for (const o of orientations) for (const g of genders) expect(npcDrawnToPlayer({ orientation: o, gender: g }, undefined, 1)).toBe(false);
    expect(npcDrawnToPlayer({ orientation: "straight", gender: "man" }, "woman", 1)).toBe(true);
    expect(npcDrawnToPlayer({ orientation: "straight", gender: "man" }, "man", 1)).toBe(false);
    expect(npcDrawnToPlayer({ orientation: "pansexual", gender: "man" }, "nonbinary", 1)).toBe(true);
    expect(npcDrawnToPlayer({ orientation: "pansexual", gender: "man" }, "nonbinary", ANSWER_BAR - 0.01)).toBe(false); // not answered in kind
  });
});

// ---------------------------------------------------------------- the live adapter

type Live = {
  active: string[]; week: number; dayNumber?: number; playedGame?: boolean; hoh: string | null; nominees: string[]; evictionOrder: string[];
  bonds?: BondStore; romances?: Record<string, number>; breakups?: string[]; breakupCursor?: number; feelingsSeen?: string[];
  grudges?: Record<string, { kind: string; severity: number; day: number; week: number; peak: number; eased: number; refKey: string }>;
  voteRecord?: Array<{ week: number; evictee: string; voteOf: Record<string, string> }>;
};
type Internals = {
  live: Live;
  house: { player: { character: { genderPresentation?: string } }; npcs: Array<{ id: string; character: { strategyStyle: string; genderPresentation?: string; outOrientation?: string } }> };
  alliances: { add(name: string, founder: string, members: string[], beat: number): unknown };
  deals: { make(p: [string, string], k: string, t: string, e?: string, w?: number): { status: string; brokenBy?: string } };
  feelingKeepOf(o: string, h: string): number;
  grudgeOf(h: string, s: string): { kind: string; severity: number; weight: number } | null;
  grievanceOf(h: string, o: string): number;
  juryGrudgeFor(j: string, f: string): number;
  bondReader(): { bond(h: string, o: string): { strands: Record<string, number> } };
  evolveFromBeat(ev: { beat: string; content: string; participants: string[] }): void;
  ctx(): Parameters<typeof voteChoice>[2];
  setShowmancesEnabled(on: boolean): void;
  snapshot(): unknown; restore(c: unknown): void; npcVoice(id: string): unknown;
};
let n = 0;
const start = (seed: number, opts: { on?: boolean; played?: boolean } = {}) => {
  const sb = new GameSessionRegistry().sandboxFor(`a34-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  (sb.session as unknown as Internals).setShowmancesEnabled(opts.on ?? true);
  if (opts.played !== false) sb.session.noteMessage({ messageId: "m1" });
  return { sb, s: sb.session as unknown as Internals };
};
const npcs = (s: Internals): string[] => s.live.active.filter((x) => x.startsWith("npc:"));
const couple = (s: Internals, a: string, b: string): void => {
  for (const [h, o] of [[a, b], [b, a]] as const) (s.live.bonds ??= {})[bondKey(h, o)] = { ...emptyBond(), warmth: 0.8, romance: 3, history: 4 };
  s.bondReader(); // the fold notes the showmance
};
const style = (s: Internals, id: string, st: string): void => { s.house.npcs.find((x) => x.id === id)!.character.strategyStyle = st; };

describe("A3 live: heart against game", () => {
  const setup = (st: string, withAlliance = true) => {
    const { s } = start(3);
    const [holder, partner, ally, other] = npcs(s);
    couple(s, holder!, partner!);
    (s.live.bonds ??= {})[bondKey(holder!, ally!)] = { ...emptyBond(), warmth: 0.8, history: 4 };
    if (withAlliance) s.alliances.add("a pact", ally!, [ally!, holder!], 1);
    s.live.hoh = ally!; s.live.nominees = [partner!, other!];
    style(s, holder!, st);
    return { s, holder: holder!, partner: partner!, ally: ally!, other: other! };
  };
  it("the showmance is noted once the record reads as one", () => {
    const { s, holder, partner } = setup("emotional");
    expect(Object.keys(s.live.romances ?? {})).toEqual([romancePairKey(holder, partner)]);
  });
  it("with no alliance pulling the other way the keep is untouched; with one, partner vs alliance chooses differently by nature", () => {
    const calm = setup("emotional", false);
    const free = calm.s.feelingKeepOf(calm.partner, calm.holder);
    const soft = setup("emotional"), hard = setup("aggressive");
    const keepSoft = soft.s.feelingKeepOf(soft.partner, soft.holder), keepHard = hard.s.feelingKeepOf(hard.partner, hard.holder);
    expect(keepSoft).toBeGreaterThan(free);
    expect(keepHard).toBeLessThan(free);
    expect(keepHard).toBeGreaterThan(0);
    expect(keepSoft).toBeLessThanOrEqual(free + HEART.boost);
    expect(soft.s.feelingKeepOf(soft.partner, soft.holder)).toBe(keepSoft); // deterministic
    const off = start(3, { on: false }); const [h, p, a, o] = npcs(off.s);
    couple(off.s, h!, p!); (off.s.live.bonds ??= {})[bondKey(h!, a!)] = { ...emptyBond(), warmth: 0.8, history: 4 };
    off.s.alliances.add("a pact", a!, [a!, h!], 1); off.s.live.hoh = a!; off.s.live.nominees = [p!, o!]; style(off.s, h!, "emotional");
    expect(off.s.live.romances).toBeUndefined(); // flag off: nothing noted
    expect(off.s.feelingKeepOf(p!, h!)).toBe(free);
  });
  it("the vote itself follows: the same house, the soft voter's feeling term for their partner is heavier than the hard voter's", () => {
    const term = (st: string): number => {
      const { s, holder, partner, other } = setup(st);
      let feeling = NaN;
      voteChoice(holder, [partner, other], s.ctx(), [], s.live.hoh ?? undefined, (e) => {
        const o = (e as { options: Array<{ option: string; terms: Array<[string, number]> }> }).options.find((x) => x.option === partner);
        if (o) feeling = o.terms.find(([k]) => k === "feeling")![1];
      });
      return feeling;
    };
    expect(term("emotional")).toBeLessThan(term("aggressive")); // a more negative term keeps the nominee
    expect(term("aggressive")).toBeLessThan(0);
  });
  it("after the vote both are shaken: the heart that lost strains toward the partner, the heart that won toward the ally; once", () => {
    const lost = setup("aggressive");
    lost.s.live.voteRecord = [{ week: lost.s.live.week, evictee: lost.partner, voteOf: { [lost.holder]: lost.partner } }];
    const s0 = lost.s.live.bonds![bondKey(lost.holder, lost.partner)]!.strain;
    lost.s.evolveFromBeat({ beat: "eviction", content: "", participants: [lost.partner] });
    expect(lost.s.live.bonds![bondKey(lost.holder, lost.partner)]!.strain).toBeCloseTo(s0 + HEART.shaken, 9);
    lost.s.evolveFromBeat({ beat: "eviction", content: "", participants: [lost.partner] });
    expect(lost.s.live.bonds![bondKey(lost.holder, lost.partner)]!.strain).toBeCloseTo(s0 + HEART.shaken, 9);
    const won = setup("emotional");
    won.s.live.voteRecord = [{ week: won.s.live.week, evictee: won.other, voteOf: { [won.holder]: won.other, [won.ally]: won.partner } }];
    const a0 = won.s.live.bonds![bondKey(won.holder, won.ally)]!.strain;
    won.s.evolveFromBeat({ beat: "eviction", content: "", participants: [won.other] });
    expect(won.s.live.bonds![bondKey(won.holder, won.ally)]!.strain).toBeCloseTo(a0 + HEART.shaken, 9);
  });
});

describe("A3 live: an in-house breakup is the worst rupture", () => {
  const broken = (withRomance: boolean) => {
    const { s } = start(3);
    const [w, l] = npcs(s);
    if (withRomance) couple(s, w!, l!); else for (const [h, o] of [[w!, l!], [l!, w!]] as const) (s.live.bonds ??= {})[bondKey(h, o)] = { ...emptyBond(), warmth: 0.8, history: 4 };
    const d = s.deals.make([w!, l!], "safety", "terms", undefined, 1);
    d.status = "broken"; d.brokenBy = l!;
    return { s, w: w!, l: l! };
  };
  it("a broken deal between a showmance's two writes a heartbreak above any deal grudge, once, and the bond takes the deepest strain", () => {
    const rom = broken(true), plain = broken(false);
    const g = rom.s.grudgeOf(rom.w, rom.l)!, p = plain.s.grudgeOf(plain.w, plain.l)!;
    expect(p).toMatchObject({ kind: "deal-broken", severity: GRUDGES.DEAL_BREAK_SEVERITY });
    expect(g).toMatchObject({ kind: "heartbreak", severity: GRUDGES.HEARTBREAK_SEVERITY });
    expect(g.weight).toBeGreaterThan(p.weight);
    expect(rom.s.live.breakups).toEqual([romancePairKey(rom.w, rom.l)]);
    rom.s.grudgeOf(rom.w, rom.l); rom.s.bondReader();
    expect(rom.s.live.breakups!.length).toBe(1);
    expect(rom.s.live.bonds![bondKey(rom.w, rom.l)]!.strain).toBeGreaterThan(plain.s.live.bonds![bondKey(plain.w, plain.l)]!.strain);
    expect(rom.s.grievanceOf(rom.w, rom.l)).toBeGreaterThan(plain.s.grievanceOf(plain.w, plain.l)); // the one grievance every reader takes (revenge, the room)
  });
  it("it reaches the jury: an evicted partner keeps the heartbreak against whoever sent them out, and the bitter-juror read is heavier than for a plain wrong", () => {
    const run = (romance: boolean): number => {
      const { s } = start(3);
      const [w, l] = npcs(s);
      if (romance) couple(s, w!, l!);
      s.live.evictionOrder = [w!];
      (s.live as unknown as { mannerByEvictee: unknown }).mannerByEvictee = { [w!]: { [l!]: { betrayed: true, intensity: 0.5 } } };
      s.grudgeOf(w!, l!); // the fold (the jury read itself does not fold)
      return s.juryGrudgeFor(w!, l!);
    };
    expect(run(false)).toBeLessThan(0);
    expect(run(true)).toBeLessThan(run(false)); // a more negative lean at the final vote
  });
  it("a clash scene between the two ends it too: the one who started it is the one who left", () => {
    const { sb, s } = start(3);
    const [w, l] = npcs(s);
    couple(s, w!, l!);
    sb.engine.events.record({ id: "x-clash", ts: 9_300_001, type: "conflict", initiator: l!, witnessSet: [w!, l!], hidden: true, content: "a clash", houseLife: true } as never);
    expect(s.grudgeOf(w!, l!)).toMatchObject({ kind: "heartbreak", severity: GRUDGES.HEARTBREAK_SEVERITY });
    expect(s.grudgeOf(l!, w!)).toBeNull();
  });
  it("no showmance, no heartbreak; and it survives a save and restore without ending twice", () => {
    const { s, w, l } = broken(true);
    s.grudgeOf(w, l);
    const snap = JSON.parse(JSON.stringify(s.snapshot()));
    const sb2 = new GameSessionRegistry().sandboxFor(`a34-rt-${n++}`);
    sb2.session.restore(snap);
    const t = sb2.session as unknown as Internals;
    expect(t.live.romances).toEqual(s.live.romances);
    expect(t.live.breakups).toEqual(s.live.breakups);
    t.grudgeOf(w, l); t.bondReader();
    expect(t.live.breakups!.length).toBe(1);
    expect(t.live.grudges![`${w}|${l}`]!.severity).toBe(GRUDGES.HEARTBREAK_SEVERITY);
  });
});

describe("A4 live: the player is in a showmance only by their own acts", () => {
  const say = (sb: ReturnType<typeof start>["sb"], initiator: string, who: string, kind: string, times = 3): void => {
    for (let i = 0; i < times; i++) sb.commands.recordInteraction({ initiator, witnessSet: [PLAYER, who], content: "a quiet word", kind } as never);
  };
  const cast = (s: Internals, id: string, gender: string, orientation: string): void => {
    const hg = s.house.npcs.find((x) => x.id === id)!; hg.character.genderPresentation = gender; hg.character.outOrientation = orientation;
  };
  it("the player's own scenes, answered by a houseguest drawn to them, make one; nothing else does", () => {
    const own = start(3); const [A] = npcs(own.s);
    cast(own.s, A!, "man", "straight"); own.s.house.player.character.genderPresentation = "woman";
    say(own.sb, PLAYER, A!, "showmance"); own.s.bondReader();
    expect(own.s.live.romances?.[romancePairKey(A!, PLAYER)]).toBeDefined();

    const theirs = start(3); const [B] = npcs(theirs.s); // the houseguest started every scene: the engine never decides the player is in one
    cast(theirs.s, B!, "man", "straight"); theirs.s.house.player.character.genderPresentation = "woman";
    say(theirs.sb, B!, B!, "showmance"); theirs.s.bondReader();
    expect(theirs.s.live.romances).toBeUndefined();
  });
  it("never assumed: a player who has set nothing is nobody's attraction, and a houseguest outside their own orientation does not answer", () => {
    const unset = start(3); const [A] = npcs(unset.s);
    cast(unset.s, A!, "man", "pansexual");
    say(unset.sb, PLAYER, A!, "showmance"); unset.s.bondReader();
    expect(unset.s.live.romances).toBeUndefined();
    expect(unset.s.house.player.character.genderPresentation).toBeUndefined(); // nothing was filled in for them
    const mismatch = start(3); const [B] = npcs(mismatch.s);
    cast(mismatch.s, B!, "man", "gay"); mismatch.s.house.player.character.genderPresentation = "woman";
    say(mismatch.sb, PLAYER, B!, "showmance"); mismatch.s.bondReader();
    expect(mismatch.s.live.romances).toBeUndefined();
  });
  it("the partner expects loyalty: a clash the player starts ends it, and the houseguest holds the heartbreak against the player", () => {
    const { sb, s } = start(3); const [A] = npcs(s);
    cast(s, A!, "woman", "bisexual"); s.house.player.character.genderPresentation = "man";
    say(sb, PLAYER, A!, "showmance"); s.bondReader();
    say(sb, PLAYER, A!, "conflict", 1);
    expect(s.grudgeOf(A!, PLAYER)).toMatchObject({ kind: "heartbreak", severity: GRUDGES.HEARTBREAK_SEVERITY });
  });
});

describe("flag off and headless are byte-identical; the wall holds; no new rng", () => {
  it("a headless game's snapshot is the same with the flag on or off, seeds 3 and 11", () => {
    const run = (seed: number, on: boolean): string => {
      const sb = new GameSessionRegistry().sandboxFor(`a34-h-${n++}`);
      (sb.session as unknown as Internals).setShowmancesEnabled(on);
      sb.session.createCharacter({ playerName: "The Player", seed });
      sb.session.advanceGame({}); sb.session.advanceGame({});
      return JSON.stringify(sb.session.snapshot());
    };
    for (const seed of [3, 11]) expect(run(seed, true)).toBe(run(seed, false));
  });
  it("a played game with no showmance writes nothing new, flag on or off", () => {
    const snap = (on: boolean): string => { const { s } = start(11, { on }); return JSON.stringify(s.snapshot()); };
    expect(snap(true)).toBe(snap(false));
  });
  it("the new code draws no rng of its own", () => {
    for (const f of ["src/engine/heartAgainstGame.ts", "src/engine/playerShowmance.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(/Math\.random|\.next\(\)|SeededRandom|agendaRoll/.test(src), f).toBe(false);
    }
  });
  it("no romance, breakup or heartbreak field reaches a projection, a prompt or the admin view", async () => {
    const { sb, s } = start(21);
    const [w, l] = npcs(s);
    couple(s, w!, l!);
    const d = s.deals.make([w!, l!], "safety", "terms", undefined, 1); d.status = "broken"; d.brokenBy = l!;
    s.grudgeOf(w!, l!);
    expect(s.live.breakups?.length).toBe(1);
    const surfaces = [
      await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
      await sb.mcp.player.callTool("seasonRecap", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {}), npcs(s).map((id) => s.npcVoice(id)),
    ];
    const blob = JSON.stringify(surfaces).toLowerCase();
    for (const k of ["romances", "breakups", "breakupcursor", "heartbreak", "heartagainst", "sentiment", "romancetie", "playershowmance", "feelingsseen"]) expect(blob.includes(k), `a live surface carries ${k}`).toBe(false);
  });
});
