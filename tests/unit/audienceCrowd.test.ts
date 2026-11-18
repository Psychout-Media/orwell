import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import { AUDIENCE, fanThreatFor } from "../../src/engine/audience";

/**
 * ORW-624 follow-up (0190): the crowd is decided as the exit interview begins, so the interview carries it; a player-evictee hears their own crowd; the walk out fires
 * once per eviction; a fan reward makes the house read the winner (the player included) as a bigger jury threat. Drives the REAL staged eviction. Roles only.
 */
type Any = Record<string, any>;
const boot = (audience = true): Any => {
  const s = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-crowd-")))).sandboxFor("u").session as unknown as Any;
  s.setAudienceEnabled(audience);
  s.createCharacter({ playerName: "P", seed: 5 });
  s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
  return s;
};
function toEviction(s: Any, playerNominated: boolean): void {
  for (let i = 0; i < 300; i++) {
    const live = s.live as LiveSeasonState;
    if (live.beat === "eviction" && !live.pending && !live.ceremony && !live.eviction) break;
    const p = s.advanceGame().pending;
    if (!p) continue;
    if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
    else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
    else if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
    else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", pick: p.options[0].id });
    else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  }
  const live = s.live as LiveSeasonState;
  expect(live.beat).toBe("eviction");
  const others = live.active.filter((h) => h !== PLAYER);
  live.hoh = others[0]!;
  const pool = others.filter((h) => h !== live.hoh);
  live.finalNominees = playerNominated ? [PLAYER, pool[0]!] : [pool[0]!, pool[1]!];
  live.nominees = [...live.finalNominees];
  live.preEvictionNightPassed = true;
}
function playOut(s: Any, evictPlayer: boolean): Any[] {
  const views: Any[] = [];
  for (let i = 0; i < 80; i++) {
    const live = s.live as LiveSeasonState;
    if (views.length && !live.ceremony && !live.eviction && !live.pending) break;
    const p = live.pending as Any | undefined;
    const target = p?.nominees ? (evictPlayer && p.nominees.includes(PLAYER) ? PLAYER : p.nominees.find((n: string) => n !== PLAYER) ?? p.nominees[0]) : undefined;
    if (p?.kind === "eviction-vote") views.push(s.submitDecision({ kind: "eviction-vote", vote: target }));
    else if (p?.kind === "tie-break") views.push(s.submitDecision({ kind: "tie-break", vote: target }));
    else if (p?.kind === "goodbye-message") views.push(s.submitDecision({ kind: "goodbye-message", vote: "warm" }));
    else if (p?.kind === "exit-interview") views.push(s.submitDecision({ kind: "exit-interview", vote: "gracious" }));
    else if (p?.kind === "spectator-choice") views.push(s.submitDecision({ kind: "spectator-choice", vote: "watch" }));
    else views.push(s.advanceGame());
  }
  return views;
}
const capture = (s: Any): Array<{ c: string; w: string[] }> => {
  const got: Array<{ c: string; w: string[] }> = [];
  const prior = s.onPlayerEvent;
  s.onPlayerEvent = (c: string, w: string[], k: string) => { got.push({ c, w: [...w] }); prior?.(c, w, k); };
  return got;
};

describe("ORW-624 follow-up: the crowd at the walk out and the exit interview", () => {
  it("an NPC evictee's exit interview carries the crowd they walked out to; the house hears it once; the retrospective keeps it", () => {
    const s = boot();
    toEviction(s, false);
    const got = capture(s);
    const views = playOut(s, false);
    const live = s.live as LiveSeasonState;
    const exit = views.find((v) => v.event?.beat === "exit-interview");
    expect(exit, "no exit-interview beat").toBeTruthy();
    expect(exit!.event.content).toMatch(/having walked out to/);
    expect(exit!.event.content).not.toMatch(/\d/);
    const rec = live.exitInterviews!.at(-1)!;
    expect(rec.crowd).toBeDefined();
    const walks = got.filter((g) => /walks out/.test(g.c));
    expect(walks).toHaveLength(1); // decided at the exit interview; the after-eviction step does not repeat it
    expect(walks[0]!.w).not.toContain(rec.evictee);
    expect(live.audience!.crowd.filter((c) => c.evictee === rec.evictee)).toHaveLength(1);
    live.finished = true;
    expect(s.seasonRetrospective()?.exitInterviews?.at(-1)?.crowd).toBe(rec.crowd);
  });

  it("a player who is evicted hears their OWN crowd as they walk out, before their exit interview; the house's line never reaches them", () => {
    const s = boot();
    toEviction(s, true);
    const got = capture(s);
    playOut(s, true);
    const live = s.live as LiveSeasonState;
    if (!live.evictionOrder.includes(PLAYER)) return; // the vote kept the player (the tally is the engine's): nothing to check on this seed
    const own = got.filter((g) => /walks out of the house/.test(g.c));
    expect(own).toHaveLength(1);
    expect(own[0]!.w).toEqual([PLAYER]);
    expect(got.filter((g) => /walks out/.test(g.c) && g !== own[0]).every((g) => !g.w.includes(PLAYER))).toBe(true);
    expect(live.exitInterviews!.find((x) => x.evictee === PLAYER)?.crowd).toBeDefined();
  });

  it("flag off: no crowd at the exit interview, byte-identical beat text", () => {
    const s = boot(false);
    toEviction(s, false);
    const exit = playOut(s, false).find((v) => v.event?.beat === "exit-interview");
    expect(exit!.event.content).not.toMatch(/walked out/);
    expect((s.live as LiveSeasonState).exitInterviews!.at(-1)!.crowd).toBeUndefined();
  });
});

describe("ORW-624 follow-up: the house reads the viewers' favorite as a jury threat", () => {
  const perkWeek = AUDIENCE.perkWeeks[0]!;
  const seat = (s: Any, favorite: string) => {
    const live = s.live as LiveSeasonState;
    const others = live.active.filter((h) => h !== PLAYER && h !== favorite);
    live.week = perkWeek;
    live.weekDigests = [{ week: perkWeek, hoh: favorite, nominees: [others[0]!, others[1]!], vetoHolder: favorite, vetoUsed: true, evictee: others[0]!, juryCount: 0 }];
    live.active = live.active.filter((h) => h !== others[0]);
    return others.slice(1);
  };

  it("the player as the favorite: every NPC who saw it reads the player as more of a threat, more as they play the social game", () => {
    const s = boot();
    (s.live as LiveSeasonState).playedGame = true;
    const watchers = seat(s, PLAYER);
    const before = new Map(watchers.map((h) => [h, s.rel.edge(h, PLAYER).threat]));
    s.audienceAfterEviction();
    expect((s.live as LiveSeasonState).audience!.perks).toEqual([{ week: perkWeek, to: PLAYER }]);
    for (const h of watchers) expect(s.rel.edge(h, PLAYER).threat, "a watcher did not read the favorite as a threat").toBeGreaterThan(before.get(h)!);
    expect(fanThreatFor(1)).toBeGreaterThan(fanThreatFor(0));
  });

  it("an NPC favorite: the player is told, and the player's own read is not moved for them", () => {
    const s = boot();
    (s.live as LiveSeasonState).playedGame = true;
    const fav = (s.live as LiveSeasonState).active.find((h) => h !== PLAYER)!;
    seat(s, fav);
    const got = capture(s);
    const mine = s.rel.edge(PLAYER, fav).threat;
    s.audienceAfterEviction();
    expect(got.some((g) => /viewers' vote/.test(g.c) && g.w.includes(PLAYER))).toBe(true);
    expect(s.rel.edge(PLAYER, fav).threat).toBe(mine);
  });
});
