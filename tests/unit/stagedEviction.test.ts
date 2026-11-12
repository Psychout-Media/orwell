import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

/**
 * ORW-281 slice 4d - EVICTION as a staged ceremony: speeches (watch) -> votes (the existing anonymized batched reveal) -> result (commit .. goodbyes .. exit interview .. leaves).
 * The tally is decided once by the same rolls; played games only; headless stays one-beat; ORW-291 (A) twist weeks + double evictions stage the same way. Roles only.
 */
type Any = Record<string, any>;
const dir = (): string => mkdtempSync(join(tmpdir(), "orwell-ev-"));
const boot = (d: string, played = true): Any => {
  const s = new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Any;
  s.createCharacter({ playerName: "P", seed: 5 });
  if (played) s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
  return s;
};
const reload = (d: string): Any => new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Any;

/** Drive to the eviction beat (next advance), seating the HOH as asked. */
function toEviction(s: Any, hoh: "player" | "npc"): void {
  for (let i = 0; i < 300; i++) {
    const live = s.live as LiveSeasonState;
    if (live.beat === "eviction" && !live.pending && !live.ceremony && !live.eviction) break;
    const v = s.advanceGame();
    const p = v.pending;
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
  live.hoh = hoh === "player" ? PLAYER : others[0]!;
  const pool = others.filter((h) => h !== live.hoh);
  live.finalNominees = [pool[0]!, pool[1]!];
  live.nominees = [pool[0]!, pool[1]!];
  live.preEvictionNightPassed = true;
}

/** Advance (answering the player's own pendings) until the ceremony closes; returns every advance view. */
function playOut(s: Any, first?: Any): Any[] {
  const views: Any[] = first ? [first] : [];
  for (let i = 0; i < 80; i++) {
    const live = s.live as LiveSeasonState;
    const last = views[views.length - 1];
    if (last && !live.ceremony && !live.eviction && !live.pending) break;
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

describe("eviction as a staged ceremony - NPC HOH, player votes", () => {
  it("speeches names nothing; the vote is a binding card with the echo; reveals stay anonymized; the evictee is named only at commit; result closes the ceremony", () => {
    const s = boot(dir());
    toEviction(s, "npc");
    const live = s.live as LiveSeasonState;
    const a = s.advanceGame();
    expect(a.pending).toMatchObject({ kind: "ceremony-step", binding: false, ceremony: { kind: "eviction", step: 1, stepId: "speeches" } }); // ORW-291 (B): `of` = speeches + card + one step per ballot + result
    expect(a.event).toBeNull();
    expect(live.eviction).toBeUndefined();
    expect(s.houseEventInSession()).toMatchObject({ kind: "eviction" });
    const b = s.advanceGame();
    expect(b.pending).toMatchObject({ kind: "eviction-vote", ceremony: { stepId: "votes", step: 2 } });
    expect(b.beatSeq).toBeGreaterThan(a.beatSeq);
    const c = s.submitDecision({ kind: "eviction-vote", vote: b.pending.options[0].id });
    expect(c.event?.beat).toBe("eviction-reveal");
    expect(c.ceremony).toMatchObject({ stepId: "ballot" });
    const views = playOut(s, c);
    for (const v of views.filter((x) => x.event?.beat === "eviction-reveal")) {
      expect(v.event.content).toMatch(/a vote to evict/);
      expect(JSON.stringify(v)).not.toMatch(/ballot sentinel/);
    }
    const committed = views.findIndex((v) => v.event?.beat === "eviction");
    expect(committed).toBeGreaterThan(0);
    expect(views.slice(0, committed).some((v) => /is evicted|leaves the house/.test(v.event?.content ?? ""))).toBe(false);
    expect(views[committed].ceremony).toBeDefined();
    const last = views[views.length - 1];
    expect(last.event?.beat).toBe("eviction-result");
    expect(last.ceremony).toMatchObject({ stepId: "result" });
    expect(last.ceremony.step).toBe(last.ceremony.of);
    expect(live.ceremony).toBeUndefined();
    expect(live.eviction).toBeUndefined();
    const seqs = views.map((v) => v.beatSeq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
  it("same evictee as the headless one-beat path (one rng order)", () => {
    const staged = boot(dir());
    toEviction(staged, "npc");
    const headless = boot(dir(), false);
    toEviction(headless, "npc");
    const sl = staged.live as LiveSeasonState, hl = headless.live as LiveSeasonState;
    expect(sl.finalNominees).toEqual(hl.finalNominees);
    const ev = (s: Any): string | undefined => { const l = s.live as LiveSeasonState; return l.voteRecord?.[l.voteRecord.length - 1]?.evictee; };
    staged.advanceGame(); // speeches
    const p = staged.advanceGame().pending;
    playOut(staged, staged.submitDecision({ kind: "eviction-vote", vote: p.options[0].id }));
    const hp = headless.advanceGame().pending;
    expect(hl.ceremony).toBeUndefined();
    playOut(headless, headless.submitDecision({ kind: "eviction-vote", vote: hp.options[0].id }));
    expect(ev(staged)).toBe(ev(headless));
    expect(sl.week).toBe(hl.week);
  });
  it("stale beat refused on the speeches step; restart parity", () => {
    const d = dir();
    const s = boot(d);
    toEviction(s, "npc");
    const a = s.advanceGame();
    expect(() => s.advanceGame({ expectedBeatSeq: a.beatSeq - 1 })).toThrow(/stale/i);
    const v = reload(d).getGameState();
    expect(v.pending).toMatchObject({ kind: "ceremony-step", ceremony: a.ceremony, text: a.pending.text });
    expect(reload(d).advanceGame().pending).toMatchObject({ kind: "eviction-vote", ceremony: { stepId: "votes" } });
  });
});

describe("eviction as a staged ceremony - player HOH / headless / twist", () => {
  it("player HOH: speeches then straight into the reveals (no vote card)", () => {
    const s = boot(dir());
    toEviction(s, "player");
    s.advanceGame();
    const b = s.advanceGame();
    expect(b.event?.beat).toBe("eviction-reveal");
    expect(b.ceremony).toMatchObject({ stepId: "ballot", step: 2 });
    playOut(s, b);
    expect((s.live as LiveSeasonState).ceremony).toBeUndefined();
  });
  it("headless (unplayed) stays one beat: no ceremony, the first advance already reveals", () => {
    const s = boot(dir(), false);
    toEviction(s, "player");
    const a = s.advanceGame();
    expect((s.live as LiveSeasonState).ceremony).toBeUndefined();
    expect(a.event?.beat).toBe("eviction-reveal");
  });
  it("a twist week (double eviction armed) stages the first eviction: speeches -> votes -> result, then the twist still fires after the result", () => {
    const s = boot(dir());
    toEviction(s, "npc");
    const live = s.live as LiveSeasonState;
    live.twist = { kind: "double-eviction", phase: "pending" } as never;
    const a = s.advanceGame();
    expect(a.pending).toMatchObject({ kind: "ceremony-step", ceremony: { kind: "eviction", stepId: "speeches" } });
    expect(live.eviction).toBeUndefined();
    const b = s.advanceGame();
    expect(b.pending).toMatchObject({ kind: "eviction-vote", ceremony: { stepId: "votes" } });
    expect(b.beatSeq).toBeGreaterThan(a.beatSeq);
    playOut(s, s.submitDecision({ kind: "eviction-vote", vote: b.pending.options[0].id }));
    expect(live.ceremony).toBeUndefined();
    expect(live.twist).toMatchObject({ phase: "running" }); // the twist fired at the same point (rollWeek after the result)
    expect(live.beat).toBe("twist-reveal");
  });
  it("a twist week: restart parity mid-ceremony and the stale-409 refusal", () => {
    const d = dir();
    const s = boot(d);
    toEviction(s, "npc");
    (s.live as LiveSeasonState).twist = { kind: "double-eviction", phase: "pending" } as never;
    const a = s.advanceGame();
    expect(() => s.advanceGame({ expectedBeatSeq: a.beatSeq - 1 })).toThrow(/stale/i);
    const v = reload(d).getGameState();
    expect(v.pending).toMatchObject({ kind: "ceremony-step", ceremony: a.ceremony, text: a.pending.text });
    expect(JSON.stringify(v.pending)).not.toMatch(/voteRecord|voteOf|secret/i); // Vault sentinel on the step text
  });
  it("a double eviction night stages BOTH evictions in order (speeches -> votes -> result, twice)", () => {
    const s = boot(dir());
    toEviction(s, "npc");
    const live = s.live as LiveSeasonState;
    live.twist = { kind: "double-eviction", phase: "pending" } as never;
    const opened: number[] = []; // week-agnostic: the evictee count at each speeches opening
    let seenStep = "";
    for (let i = 0; i < 600 && opened.length < 2; i++) {
      const p = live.pending as Any | undefined;
      if (p?.kind === "ceremony-step" && live.ceremony?.kind === "eviction" && live.ceremony.at === 0 && seenStep !== `${live.voteRecord?.length ?? 0}`) {
        opened.push(live.voteRecord?.length ?? 0); seenStep = `${live.voteRecord?.length ?? 0}`;
      }
      if (!p) { s.advanceGame(); continue; }
      if (p.kind === "ceremony-step") s.advanceGame();
      else if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
      else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", pick: p.options[0].id });
      else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
      else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0].id });
      else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
      else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
      else if (p.kind === "eviction-vote") s.submitDecision({ kind: "eviction-vote", vote: p.nominees[0] });
      else if (p.kind === "tie-break") s.submitDecision({ kind: "tie-break", vote: p.nominees[0] });
      else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: "warm" });
      else if (p.kind === "exit-interview") s.submitDecision({ kind: "exit-interview", vote: "gracious" });
      else if (p.kind === "spectator-choice") s.submitDecision({ kind: "spectator-choice", vote: "watch" });
      else s.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id } as never);
    }
    expect(opened).toEqual([0, 1]); // second speeches opens after exactly one eviction has been recorded
    expect(live.week).toBe(1); // same night, same week number
  });
});
