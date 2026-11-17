import { describe, it, expect } from "vitest";
import { editWorthiness, EDIT_BASE } from "../../src/engine/editWorthiness";
import { AUDIENCE, crowdFor, emptyStanding, favoriteOf, foldMoment } from "../../src/engine/audience";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/** ORW-624 - the audience outside. Roles only: a winner (w), a villain (v), a quiet one (q), the player. */
const neutral = () => 1;

describe("edit-worthiness (shared with 'your edit')", () => {
  it("a blindside out-edits a routine eviction; a twist and a crowd raise it", () => {
    expect(editWorthiness({ kind: "blindside", week: 1, public: true })).toBeGreaterThan(editWorthiness({ kind: "eviction", week: 1, public: true }));
    expect(editWorthiness({ kind: "eviction", week: 1, twist: 1, public: true })).toBeGreaterThan(editWorthiness({ kind: "eviction", week: 1, public: true }));
    expect(editWorthiness({ kind: "blowup", week: 1, crowd: 8, public: true })).toBeGreaterThan(EDIT_BASE.blowup);
  });
});

describe("the public's view (audience.ts)", () => {
  it("wins are cheered, betrayals booed, and someone barely on screen walks out to silence", () => {
    const st = emptyStanding();
    for (let i = 0; i < 4; i++) foldMoment(st, { kind: "comp-win", actor: "w", week: i, public: true }, neutral);
    for (let i = 0; i < 4; i++) foldMoment(st, { kind: "betrayal", actor: "v", subject: "w", week: i, public: true }, neutral);
    expect(crowdFor(st, "w")).toBe("cheers");
    expect(crowdFor(st, "v")).toBe("boos");
    expect(crowdFor(st, "q")).toBe("silence");
    expect(favoriteOf(st, ["w", "v", "q"])).toBe("w");
  });
});

describe("the audience in the live house", () => {
  it("the crowd reads only what the house saw: a hidden betrayal moves the recap's view, never the crowd's during play", () => {
    const sb = new GameSessionRegistry().sandboxFor("audience-wall");
    sb.session.createCharacter({ playerName: "The Player", seed: 91 });
    const g = sb.session as unknown as { live: { playedGame?: boolean; week: number; finished?: boolean; weekDigests?: unknown[]; audience?: { live: { view: Record<string, number> }; full: { view: Record<string, number> } } }; record?: { events(): Array<{ type: string; initiator: string; witnessSet: string[]; hidden: boolean }> }; audienceAfterEviction(): void };
    g.live.playedGame = true;
    const [villain, victim] = sb.session.livingIds().filter((id) => id !== PLAYER);
    const hidden = Array.from({ length: 6 }, (_, i) => ({ id: `h${i}`, type: "betrayal", initiator: villain!, witnessSet: [villain!, victim!], hidden: true }));
    g.record = { events: () => hidden };
    g.audienceAfterEviction();
    expect(g.live.audience!.live.view[villain!] ?? 0).toBe(0); // the crowd never saw it
    expect(g.live.audience!.full.view[villain!]).toBeLessThan(0); // the recap counts it
  });
  it("the evictee walks out to the crowd's reaction (a scene the house hears), and America's Favorite waits for the crown", () => {
    const sb = new GameSessionRegistry().sandboxFor("audience-walkout");
    sb.session.createCharacter({ playerName: "The Player", seed: 92 });
    const g = sb.session as unknown as { live: { playedGame?: boolean; week: number; finished?: boolean; weekDigests?: unknown[] }; audienceAfterEviction(): void; onPlayerEvent?: (c: string, w: string[], k: string) => void; seasonRetrospective(): { americasFavorite?: { name: string } } | null };
    g.live.playedGame = true;
    const [hoh, n1, n2] = sb.session.livingIds().filter((id) => id !== PLAYER);
    g.live.weekDigests = [{ week: g.live.week, hoh, nominees: [n1, n2], vetoHolder: hoh, vetoUsed: false, evictee: n1, juryCount: 0 }];
    const events: string[] = [];
    const prior = g.onPlayerEvent; g.onPlayerEvent = (c, w, k) => { events.push(c); prior?.(c, w, k); };
    g.audienceAfterEviction();
    expect(events.some((c) => /walks out to/.test(c))).toBe(true);
    expect(events.join(" ")).not.toMatch(/\d/); // never a number
    expect(g.seasonRetrospective()).toBeNull(); // nothing before the crown
    g.live.finished = true;
    expect(g.seasonRetrospective()?.americasFavorite?.name).toBeTruthy();
  });
  it("the player is judged like anyone: their own win counts toward the public's view", () => {
    const sb = new GameSessionRegistry().sandboxFor("audience-player");
    sb.session.createCharacter({ playerName: "The Player", seed: 93 });
    const g = sb.session as unknown as { live: { playedGame?: boolean; week: number; weekDigests?: unknown[]; audience?: { live: { view: Record<string, number> } } }; audienceAfterEviction(): void };
    g.live.playedGame = true;
    const [n1, n2] = sb.session.livingIds().filter((id) => id !== PLAYER);
    g.live.weekDigests = [{ week: g.live.week, hoh: PLAYER, nominees: [n1, n2], vetoHolder: PLAYER, vetoUsed: true, evictee: n1, juryCount: 0 }];
    g.audienceAfterEviction();
    expect(g.live.audience!.live.view[PLAYER]).toBeGreaterThan(0);
    expect(AUDIENCE.perkWeeks.length).toBeGreaterThan(0);
  });
});
