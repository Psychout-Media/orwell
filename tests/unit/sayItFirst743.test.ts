import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { playedGame } from "../support/playedGame";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * ORW-743 (0204 part 2; Coordinator rulings 2026-11-26), REAL PATH: when a fact about the player is closing in (the same share an NPC's self-detonation uses), the narrator is told ONE bit
 * (people are talking about the player: never what, who or how many) and the player may say it first, in their own words: the words are the public event verbatim, the fact is broken, the
 * room learns it as the player said it, and the card closes. A blank answer is not coming clean. A season is played through the player's levers; the fact spreads through the house's own
 * gossip from one planted belief (built state, said below). Roles only.
 */
type K = { knownTo(id: string): Array<{ factId?: string; id: string; subject?: string; content: string }> };
type S = {
  live: { secretBreaks?: string[]; sayItFirst?: unknown }; livingIds(): string[]; getGameState(): { pending?: unknown };
  getMomentPrompt(r: object): { systemPrompt: string }; submitDecision(r: object): unknown;
};
const LINE = "PEOPLE ARE TALKING ABOUT THE PLAYER";

describe("ORW-743 (built state, then played): the player can say it first", () => {
  it("the narrator gets one bit; the player's own words become the room's event; blank words do nothing", () => {
    // BUILT STATE (the ORW-960 precedent; Coordinator 2026-11-26): no writer in a played season gives the house a HIDDEN fact about the player (12 seeds: none; the player has no lever to tell a
    // houseguest their own secret: ORW-988). So ONE houseguest is handed one belief about the player through the knowledge layer's own door (`seedBelief`, as a confidence lodges it); from
    // there the house's own gossip spreads it and the engine's own nightly pass opens the card. Nothing else is set by hand.
    const { at } = firstSeedWhereSync((seed, sandbox) => {
      const g = playedGame({ seed, user: sandbox });
      const s = g.s as unknown as S;
      const kn = g.sb.engine.knowledge as unknown as K & { seedBelief(id: string, f: object, pathway: string): unknown };
      g.playUntil(() => (s as unknown as { live: { week: number } }).live.week >= 2 && !s.getGameState().pending, 3000, "week 2");
      const fact = `t743:${seed}`, said = "the player has been hiding something about why they are really here";
      kn.seedBelief(s.livingIds().filter((id) => id !== PLAYER)[0]!, { content: said, originalContent: said, factId: fact, subject: PLAYER, confidence: 0.9, hops: 0, distortion: 0 }, "told");
      // the player is up, and so are a few houseguests to hear it (late at night the player may be the only one awake)
      const up = (): boolean => { const a = (s as unknown as { awakeIds(): ReadonlySet<string> | null }).awakeIds(); return !a || (a.has(PLAYER) && [...a].filter((id) => id !== PLAYER).length >= 3); };
      g.playUntil(() => (s.live.sayItFirst as { factId?: string } | undefined)?.factId === fact && !s.getGameState().pending && up(), 1500, "the house's gossip closing in on it and the card opening, the player and a few others up");
      expect(s.getMomentPrompt({}).systemPrompt, "the card is open: the narrator is told").toContain(LINE);
      return { g, s, kn, fact };
    }, { from: 1, to: 3, hint: [1], sandbox: (x) => `sif-${x}`, what: "a fact about the player closing in and the card opening" });
    const { g, s, kn, fact } = at;
    const prompt = s.getMomentPrompt({}).systemPrompt;
    const line = prompt.split("\n").find((l) => l.includes(LINE))!;
    // one bit: the line carries none of what the house holds
    for (const h of s.livingIds()) for (const f of kn.knownTo(h)) if (f.subject === PLAYER) expect(line).not.toContain(f.content.slice(0, 40));
    // blank words are not coming clean: nothing breaks and the card stays open
    s.submitDecision({ kind: "say-it-first", statement: "   " });
    expect(s.live.secretBreaks ?? []).not.toContain(fact);
    expect(s.getMomentPrompt({}).systemPrompt).toContain(LINE);
    // the player's own words
    const words = "Fine, I'll say it before anyone else does: I came here to win and I have not been straight with everyone.";
    const before = (g.sb.engine.events as unknown as { queryAll(): Array<{ content: string }> }).queryAll().length;
    s.submitDecision({ kind: "say-it-first", statement: words });
    const events = (g.sb.engine.events as unknown as { queryAll(): Array<{ content: string; witnessSet: string[] }> }).queryAll().slice(before);
    const said = events.find((e) => e.content.includes(words));
    expect(said, "the player's words are the room's event, verbatim").toBeDefined();
    expect(said!.witnessSet).toContain(PLAYER);
    expect(s.live.secretBreaks ?? [], "the fact is broken").toContain(fact);
    expect(s.getMomentPrompt({}).systemPrompt, "the card is closed").not.toContain(LINE);
    // the next tick: a houseguest in the room who did not hold it now holds it as the player said it
    g.turn();
    const learned = s.livingIds().filter((id) => id !== PLAYER && kn.knownTo(id).some((f) => (f.factId ?? f.id) === fact && f.content === words));
    expect(learned.length + said!.witnessSet.filter((id) => id !== PLAYER && kn.knownTo(id).some((f) => (f.factId ?? f.id) === fact)).length, "the room holds it").toBeGreaterThan(0);
  }, 900_000);
});
