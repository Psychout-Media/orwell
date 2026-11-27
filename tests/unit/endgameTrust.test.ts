import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { ENDGAME, beatShare, endgamePush, endgameFakeLean, isEndgame } from "../../src/engine/endgameTrust";
import { voteChoice, VOTE_TERM_NAMES, type SeasonCtx } from "../../src/engine/liveSeason";

/**
 * 0193 (ORW-623): the endgame changes the rules of trust. At four left or fewer each houseguest weighs "can I beat you?" (their OWN read of the jury), it pushes
 * their nominations and vote, tilts reassurances toward faking, and old final twos get tested out loud. The player in both directions. Roles only.
 */
type Seam = {
  live: { playedGame?: boolean; week: number; active: string[]; evictionOrder: string[]; resume?: Record<string, number>; pending?: unknown; endgameTested?: number[]; assurances?: { items: Array<{ from: string; to: string; kind: string; sincerity: number }> } };
  deals: { make(p: [string, string], k: string, t: string, e?: string, w?: number): { id: string } };
  rel: { applyImpactDirected(h: string, o: string, i: Record<string, number>, rng: { next(): number }): void };
  endgameFor(t: string, d: string): number; endgameTests(): void; setEndgameTrustEnabled(on: boolean): void; setDealPlansEnabled?(on: boolean): void;
  recordAssurance(a: { from: string; to: string; kind: "vote"; sincerity: number; source: "npc" }): void;
  onPlayerEvent?: (c: string, w: string[], k?: string) => string | undefined;
};
const flat = { next: () => 0.5 };
function finalFour(seed: number, on = true) {
  const sb = new GameSessionRegistry().sandboxFor(`endgame-${seed}-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as Seam;
  g.setEndgameTrustEnabled(on);
  g.live.playedGame = true; g.live.pending = undefined;
  const npcs = g.live.active.filter((i) => i !== PLAYER);
  const [a, b, c, ...out] = npcs as [string, string, string, ...string[]];
  g.live.active = [PLAYER, a, b, c];
  g.live.evictionOrder = [...g.live.evictionOrder, ...out]; // the rest are gone (the later ones on the jury)
  const jurors = out.slice(-5);
  return { g, a, b, c, jurors };
}
const warm = (g: Seam, from: string, to: string, n = 3) => { for (let i = 0; i < n; i++) g.rel.applyImpactDirected(from, to, { trust: 0.3, affinity: 0.3 }, flat); };
/**
 * The jury reads close to `fav` in a way each decider can SEE (ORW-574 own-view: a decider reads only what they saw, and a juror's warmth to them is their own bond):
 * bonding scenes between each juror and `fav` the deciders watched, and `fav`'s own warm bond to each juror.
 */
const juryLoves = (g: Seam, fav: string, jurors: string[], watchers: string[]) => {
  const scenes = jurors.flatMap((j, i) => [0, 1, 2].map((k) => ({ id: `jl${i}${k}`, ts: i * 3 + k, type: "bonding", initiator: j, witnessSet: [j, fav], hidden: true, content: "", houseLife: { seenBy: watchers } })));
  (g as unknown as { record?: { events(): unknown[] } }).record = { events: () => scenes };
  for (const j of jurors) warm(g, fav, j);
};

describe("0193 pure: can I beat you?", () => {
  it("jurors closer to me make my odds better; the comp record counts; no jurors = the record alone", () => {
    const bond = (j: string, f: string) => (f === "me" ? 0.8 : 0.3);
    expect(beatShare("me", "rival", ["j1", "j2"], bond, () => 0)).toBeGreaterThan(0.5);
    expect(beatShare("rival", "me", ["j1", "j2"], bond, () => 0)).toBeLessThan(0.5);
    expect(beatShare("me", "rival", [], () => 0.5, (id) => (id === "rival" ? 3 : 0))).toBeLessThan(0.5);
    expect(endgamePush(0.2)).toBeGreaterThan(0); // can't beat them: push them out
    expect(endgamePush(0.8)).toBeLessThan(0); // can beat them: keep them
    expect(endgameFakeLean(0.8)).toBe(0);
    expect(endgameFakeLean(0.2)).toBeGreaterThan(0);
    expect([isEndgame(5), isEndgame(4), isEndgame(3), isEndgame(2)]).toEqual([false, true, true, false]);
    expect(ENDGAME.atOrBelow).toBe(4);
  });
  it("the vote reads it as a named term (after the herd; ORW-1079 appended the steer term after it); an absent hook is byte-identical", () => {
    expect(VOTE_TERM_NAMES.indexOf("endgame")).toBe(VOTE_TERM_NAMES.indexOf("herd") + 1);
  });
});

describe("0193 in the live adapter", () => {
  it("an NPC who can't beat a rival with the jury pushes them out; one who can keeps them (their own read)", () => {
    const { g, a, b, jurors } = finalFour(21);
    juryLoves(g, b, jurors, [a]); // the jury loves b, as a can see
    expect(g.endgameFor(b, a)).toBeGreaterThan(0);
    expect(g.endgameFor(a, b)).toBeLessThan(0);
  });

  it("the player's own play moves the house: the player's comp wins make NPCs read them as harder to beat", () => {
    const { g, a } = finalFour(22);
    const before = g.endgameFor(PLAYER, a);
    g.live.resume = { ...(g.live.resume ?? {}), [PLAYER]: (g.live.resume?.[PLAYER] ?? 0) + 4 };
    expect(g.endgameFor(PLAYER, a)).toBeGreaterThan(before);
  });

  it("the player is never pushed: the player decides their own vote; and outside the endgame (or flag off) the term is 0", () => {
    const { g, a } = finalFour(23);
    expect(g.endgameFor(a, PLAYER)).toBe(0);
    g.live.active = [...g.live.active, g.live.evictionOrder.pop()!]; // five left: not yet
    expect(g.endgameFor(PLAYER, a)).toBe(0);
    const off = finalFour(24, false);
    expect(off.g.endgameFor(PLAYER, off.a)).toBe(0);
  });

  it("a voter at the final four votes out the one they can't beat, through voteChoice's endgame term", () => {
    const { g, a, b, c, jurors } = finalFour(25);
    juryLoves(g, b, jurors, [a]);
    const rel = (g as unknown as { rel: SeasonCtx["rel"] }).rel;
    const why: Array<{ options: Array<{ option: string; terms: Array<[string, number]> }> }> = [];
    const pick = voteChoice(a, [b, c], { player: PLAYER, statsOf: () => ({ physical: 0.5, mental: 0.5, social: 0.5 }), rel, endgameFor: (t: string, d: string) => g.endgameFor(t, d) } as unknown as SeasonCtx, [], undefined, (w) => why.push(w as never));
    const chosen = why[0]!.options.find((o) => o.option === pick)!;
    expect(chosen.terms.some(([n]) => n === "endgame")).toBe(true);
    const termOf = (o: string) => why[0]!.options.find((x) => x.option === o)!.terms.find(([n]) => n === "endgame")?.[1] ?? 0;
    expect(termOf(b)).toBeGreaterThan(termOf(c));
  });

  it("final twos get tested out loud once a week: an NPC partner reassures on the ledger; a player partner is asked to their face", () => {
    const { g, a, b, c } = finalFour(26);
    g.deals.make([a, b], "final-two", "t", undefined, g.live.week);
    g.deals.make([c, PLAYER], "final-two", "t", undefined, g.live.week);
    const heard: Array<{ c: string; w: string[] }> = [];
    const prior = g.onPlayerEvent; g.onPlayerEvent = (content, w, k) => { heard.push({ c: content, w: [...w] }); return prior?.(content, w, k); };
    g.endgameTests();
    const items = g.live.assurances?.items ?? [];
    expect(items.filter((x) => x.kind === "vote" && ((x.from === a && x.to === b) || (x.from === b && x.to === a)))).toHaveLength(2);
    const asked = heard.filter((h) => /final two still stands/.test(h.c));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.w).toEqual([c, PLAYER]);
    expect(asked[0]!.c).not.toMatch(/\d/);
    expect(items.some((x) => x.from === PLAYER)).toBe(false); // the player's answer is their own words, never engine-authored
    g.endgameTests(); // once a week
    expect((g.live.assurances?.items ?? []).length).toBe(items.length);
    expect(heard.filter((h) => /final two still stands/.test(h.c))).toHaveLength(1);
  });

  it("a reassurance to someone the giver can't beat is no more sincere than outside the endgame (the lean only adds faking)", () => {
    const run = (on: boolean, seed: number) => {
      const { g, a, b, jurors } = finalFour(seed, on);
      g.setDealPlansEnabled?.(true);
      juryLoves(g, b, jurors, [a]);
      g.recordAssurance({ from: a, to: b, kind: "vote", sincerity: 0, source: "npc" });
      return g.live.assurances!.items.at(-1)!.sincerity;
    };
    const pairs = Array.from({ length: 30 }, (_, i) => [run(true, 40 + i), run(false, 40 + i)] as const); // the tilt is ~0.15 here (own-view reads), so 30 seasons keep a miss under 1%
    for (const [on, off] of pairs) expect(on).toBeLessThanOrEqual(off);
    expect(pairs.some(([on, off]) => on < off), "the endgame never tilted a reassurance").toBe(true);
  });
});
