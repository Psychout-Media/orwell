import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

/**
 * ORW-291 (B) - the eviction 'votes' step plays ONE BALLOT per step: speeches -> [player's card] -> ballot x N -> result. Presentation only: same rolls, same order, same
 * evictee; E12 anonymity (no voter in any step text / view). Played games only. Roles only.
 */
type Any = Record<string, any>;
const dir = (): string => mkdtempSync(join(tmpdir(), "orwell-evb-"));
const boot = (d: string, played = true): Any => {
  const s = new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Any;
  s.createCharacter({ playerName: "P", seed: 5 });
  if (played) s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
  return s;
};
const reload = (d: string): Any => new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Any;

function toEviction(s: Any, hoh: "player" | "npc"): void {
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
  const others = live.active.filter((h) => h !== PLAYER);
  live.hoh = hoh === "player" ? PLAYER : others[0]!;
  const pool = others.filter((h) => h !== live.hoh);
  live.finalNominees = [pool[0]!, pool[1]!];
  live.nominees = [pool[0]!, pool[1]!];
  live.preEvictionNightPassed = true;
}

/** Drive the vote to the committed 'eviction' beat, collecting every view; answers the player's own pendings. */
function drive(s: Any, first: Any): Any[] {
  const views: Any[] = [first];
  for (let i = 0; i < 80; i++) {
    const live = s.live as LiveSeasonState;
    if (views[views.length - 1].event?.beat === "eviction-result") break;
    const p = live.pending as Any | undefined;
    if (p?.kind === "eviction-vote") views.push(s.submitDecision({ kind: "eviction-vote", vote: p.nominees[0] }));
    else if (p?.kind === "tie-break") views.push(s.submitDecision({ kind: "tie-break", vote: p.nominees[0] }));
    else if (p?.kind === "goodbye-message") views.push(s.submitDecision({ kind: "goodbye-message", vote: "warm" }));
    else if (p?.kind === "exit-interview") views.push(s.submitDecision({ kind: "exit-interview", vote: "gracious" }));
    else if (p?.kind === "spectator-choice") views.push(s.submitDecision({ kind: "spectator-choice", vote: "watch" }));
    else views.push(s.advanceGame());
  }
  return views;
}
const voterCount = (live: LiveSeasonState): number => live.voteRecord![live.voteRecord!.length - 1]
  ? Object.keys(live.voteRecord![live.voteRecord!.length - 1]!.voteOf).length : 0;

describe("eviction ballots - one per step", () => {
  it("player voter: card, then one reveal per ballot (steps count up, N = voters), then the commit and result; one beatSeq per step", () => {
    const s = boot(dir());
    toEviction(s, "npc");
    const live = s.live as LiveSeasonState;
    const a = s.advanceGame();
    const b = s.advanceGame();
    expect(b.pending).toMatchObject({ kind: "eviction-vote", ceremony: { stepId: "votes", step: 2 } });
    const of: number = b.pending.ceremony.of;
    const first = s.submitDecision({ kind: "eviction-vote", vote: b.pending.options[0].id });
    const views = drive(s, first);
    const reveals = views.filter((v) => v.event?.beat === "eviction-reveal");
    const n = voterCount(live);
    expect(n).toBeGreaterThan(2);
    expect(reveals).toHaveLength(n);                                          // one ballot per step
    expect(of).toBe(n + 3);                                                   // speeches + card + N ballots + result
    reveals.forEach((v, i) => {
      expect(v.event.content.match(/a vote to evict/g)).toHaveLength(1);      // exactly one ballot in the beat
      expect(v.ceremony).toMatchObject({ stepId: "ballot", step: 3 + i, of });
    });
    const committed = views.findIndex((v) => v.event?.beat === "eviction");
    expect(committed).toBe(views.findIndex((v) => v === reveals[n - 1]) + 1);  // the commit lands right after the last ballot (no early outcome)
    expect(views.slice(0, committed).some((v) => /is evicted|leaves the house/.test(v.event?.content ?? ""))).toBe(false);
    expect(views[views.length - 1].ceremony).toMatchObject({ stepId: "result", step: of, of });
    const seqs = [a, b, ...views].map((v) => v.beatSeq);
    expect(new Set(seqs).size).toBe(seqs.length);                             // beatSeq bumps once per step
  });
  it("player HOH (no card): speeches then one ballot per step; anonymity sweep over every view", () => {
    const s = boot(dir());
    toEviction(s, "player");
    const live = s.live as LiveSeasonState;
    const a = s.advanceGame();
    const first = s.advanceGame();
    expect(first.ceremony).toMatchObject({ stepId: "ballot", step: 2 });
    const views = [a, ...drive(s, first)];
    const rec = live.voteRecord![live.voteRecord!.length - 1]!;
    const voters = Object.keys(rec.voteOf);
    const reveals = views.filter((v) => v.event?.beat === "eviction-reveal");
    expect(reveals).toHaveLength(voters.length);
    // E12: no voter id may appear paired with a ballot in any step text / view / event content / eviction view
    for (const v of reveals) {
      const txt = JSON.stringify([v.event, v.pending, v.ceremony, v.status?.eviction, v.announcements]);
      for (const voter of voters) expect(txt).not.toContain(`${voter} votes`);
      expect(v.event.content).toMatch(/^a vote to evict \S.*\.$/);
    }
    expect(live.ceremony).toBeUndefined();
  });
  it("same evictee, same ballot order, same week as the headless one-beat path (rolls unchanged)", () => {
    const staged = boot(dir()), headless = boot(dir(), false);
    toEviction(staged, "player"); toEviction(headless, "player");
    const rec = (s: Any): Any => { const l = s.live as LiveSeasonState; return l.voteRecord![l.voteRecord!.length - 1]; };
    staged.advanceGame();
    drive(staged, staged.advanceGame());
    drive(headless, headless.advanceGame());
    expect(rec(staged)).toEqual(rec(headless));
    expect((staged.live as LiveSeasonState).week).toBe((headless.live as LiveSeasonState).week);
  });
  it("restart parity mid-reveal and stale-409 refusal", () => {
    const d = dir();
    const s = boot(d);
    toEviction(s, "player");
    s.advanceGame();
    const r1 = s.advanceGame();
    const r2 = s.advanceGame();
    expect(() => s.advanceGame({ expectedBeatSeq: r1.beatSeq })).toThrow(/stale/i);
    const r = reload(d);
    expect((r.live as LiveSeasonState).ceremony?.at).toBe((s.live as LiveSeasonState).ceremony?.at);
    expect((r.live as LiveSeasonState).eviction?.revealIx).toBe(2);
    r.scheduleGateBypass = true;
    const next = r.advanceGame();
    expect(next.ceremony).toMatchObject({ stepId: "ballot", step: r2.ceremony.step + 1 });
  });
});
