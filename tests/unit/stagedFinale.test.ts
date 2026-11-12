import { describe, it, expect } from "vitest";
import { mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import { resolvePending } from "../../features/support/answerPending";

/**
 * ORW-291 slice (C) - THE FINALE. The Final HOH's three comp parts and the jury's statements / questions / ballots were ALREADY separate advances (one comp per part,
 * one beat per statement / answer / ballot / winner); the one COLLAPSED beat was the Final HOH's own eviction (an NPC Final HOH decided and evicted inside a single advance).
 * It is now a staged ceremony (decision -> result; the player-Final-HOH's choice is the binding first step), played games only. Roles only.
 */
type Any = Record<string, any>;
const dir = (): string => mkdtempSync(join(tmpdir(), "orwell-fin-"));
const boot = (d: string, seed: number, played: boolean): Any => {
  const s = new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Any;
  s.createCharacter({ playerName: "P", seed });
  s.setFinalHohThreePartEnabled(true);
  if (played) s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
  return s;
};
const reload = (d: string): Any => new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Any;

/** Drive until the Final HOH is crowned (beat final-eviction, nothing pending) with the player still in; returns null if the player left earlier. */
function toFinalEviction(s: Any): LiveSeasonState | null {
  for (let i = 0; i < 9000; i++) {
    const live = s.live as LiveSeasonState;
    if (live.finished) return null;
    if (live.beat === "final-eviction" && !live.pending && !live.ceremony) return live.active.includes(PLAYER) ? live : null;
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (r: any) => void s.submitDecision(r));
  }
  return null;
}
const memo = new Map<string, { d: string; seed: number }>();
/** A season replay is slow, so each (played) variant is driven to the crowned Final HOH ONCE and copied per test. */
function seatedAt(hoh: "player" | "npc", played = true): { s: Any; live: LiveSeasonState; d: string; seed: number } {
  const key = String(played);
  if (!memo.has(key)) {
    for (let seed = 1; seed <= 25 && !memo.has(key); seed++) {
      const d = dir();
      if (toFinalEviction(boot(d, seed, played))) memo.set(key, { d, seed });
    }
  }
  const m = memo.get(key);
  if (!m) throw new Error("no seed kept the player in the Final 3");
  const d = dir(); cpSync(m.d, d, { recursive: true });
  const s = reload(d);
  s.setFinalHohThreePartEnabled(true); s.scheduleGateBypass = true;
  const live = s.live as LiveSeasonState;
  const others = live.active.filter((h) => h !== PLAYER);
  live.hoh = hoh === "player" ? PLAYER : others[0]!;
  return { s, live, d, seed: m.seed };
}
const find = seatedAt;

describe("the Final HOH's eviction as a staged ceremony - NPC Final HOH", () => {
  it("decision (names nothing) -> result (publishes, once) -> closes; beatSeq bumps per step; the house event holds throughout", () => {
    const { s, live } = find("npc");
    const before = [...live.active];
    const a = s.advanceGame();
    expect(a.event).toBeNull();
    expect(a.pending).toMatchObject({ kind: "ceremony-step", binding: false, ceremony: { kind: "final-eviction", step: 1, of: 2, stepId: "decision" } });
    expect(live.active).toEqual(before); // nothing decided in public yet
    expect(JSON.stringify(a.pending)).not.toMatch(/evict(s|ed) /);
    expect(s.houseEventInSession()).toMatchObject({ kind: "eviction" });
    const b = s.advanceGame();
    expect(b.beatSeq).toBeGreaterThan(a.beatSeq);
    expect(b.event).toMatchObject({ beat: "final-eviction" });
    expect(b.pending).toMatchObject({ kind: "ceremony-step", ceremony: { stepId: "result", step: 2, of: 2 } });
    expect(live.active.length).toBe(2);
    expect(live.beat).toBe("finale");
    const c = s.advanceGame();
    expect(c.beatSeq).toBeGreaterThan(b.beatSeq);
    expect(c.event?.beat).not.toBe("final-eviction");
    expect(live.ceremony).toBeUndefined();
  });

  it("a ceremony step is refused by submitDecision; a stale beatSeq is refused before any write", () => {
    const { s, live } = find("npc");
    const a = s.advanceGame();
    expect(() => s.submitDecision({ kind: "ceremony-step" })).toThrow();
    expect(() => s.advanceGame({ expectedBeatSeq: a.beatSeq - 1 })).toThrow();
    expect(live.active.length).toBe(3);
  });

  it("restart mid-ceremony resumes the same step and lands the same evictee as an uninterrupted run", () => {
    const { s, live, d } = find("npc");
    const a = s.advanceGame();
    expect(a.pending.ceremony.stepId).toBe("decision");
    const r = reload(d);
    expect((r.live as LiveSeasonState).ceremony).toMatchObject({ kind: "final-eviction", at: 0 });
    const rb = r.advanceGame();
    const other = seatedAt("npc");
    other.s.advanceGame();
    const ob = other.s.advanceGame();
    expect(rb.event.content).toBe(ob.event.content);
    expect(s.advanceGame().event.content).toBe(ob.event.content);
    expect(live.finished).toBe(false);
  });

  it("headless (not a played game) keeps the one-beat resolution", () => {
    const { s, live } = find("npc", false);
    const a = s.advanceGame();
    expect(a.event).toMatchObject({ beat: "final-eviction" });
    expect(live.ceremony).toBeUndefined();
    expect(live.active.length).toBe(2);
  });

  it("the evictee is decided once at the ceremony's opening and published unchanged", () => {
    const { s, live } = find("npc");
    s.advanceGame();
    const decided = live.ceremony!.finalEvictee;
    expect(decided).toBeDefined();
    const b = s.advanceGame();
    expect(b.event.participants.map((p: Any) => p.id)[1]).toBe(decided);
    expect(live.active).not.toContain(decided);
  });
});

describe("the Final HOH's eviction as a staged ceremony - player is the Final HOH", () => {
  it("the choice is the binding first step; the result step publishes it; Continue closes", () => {
    const { s, live } = find("player");
    const a = s.advanceGame();
    expect(a.pending).toMatchObject({ kind: "final-eviction", ceremony: { kind: "final-eviction", step: 1, of: 2, stepId: "choose" } });
    expect(() => s.submitDecision({ kind: "final-eviction", vote: PLAYER })).toThrow();
    expect(live.active.length).toBe(3);
    const pick = a.pending.options[0].id;
    const b = s.submitDecision({ kind: "final-eviction", vote: pick, expectedBeatSeq: a.beatSeq });
    expect(b.event).toMatchObject({ beat: "final-eviction" });
    expect(b.event.participants.map((p: Any) => p.id)).toEqual([PLAYER, pick]);
    expect(b.pending).toMatchObject({ kind: "ceremony-step", ceremony: { stepId: "result" } });
    expect(() => s.submitDecision({ kind: "final-eviction", vote: pick, expectedBeatSeq: a.beatSeq })).toThrow(); // stale
    s.advanceGame();
    expect(live.ceremony).toBeUndefined();
    expect(live.beat).toBe("finale");
  });
});

describe("the Final HOH's eviction - the player is the one evicted", () => {
  it("publishes at the result step with nothing left to watch (no stranded ceremony-step)", () => {
    const base = seatedAt("npc");
    let checked = false;
    for (const hoh of base.live.active.filter((h) => h !== PLAYER)) {
      const t = seatedAt("npc"); t.live.hoh = hoh;
      t.s.advanceGame(); const v = t.s.advanceGame();
      if (v.event?.participants?.[1]?.id === PLAYER) {
        expect(t.live.pending?.kind).not.toBe("ceremony-step");
        expect(t.live.ceremony).toBeUndefined();
        checked = true;
      }
    }
    if (!checked) { // the rival read never picked the player from this seat: force it (the commit path is the same)
      const t = seatedAt("npc"); t.s.advanceGame(); t.live.ceremony!.finalEvictee = PLAYER;
      const v = t.s.advanceGame();
      expect(v.event.participants.map((p: Any) => p.id)).toContain(PLAYER);
      expect(t.live.pending?.kind).not.toBe("ceremony-step");
      expect(t.live.ceremony).toBeUndefined();
    }
  });
});

describe("the jury reveal - one ballot per advance, then the winner (unchanged, pinned)", () => {
  it("'the jury casts their votes' -> one public ballot per advance (beatSeq bumps) -> the winner only after the last", () => {
    const r = find("npc");
    const { s, live } = r;
    const views: Any[] = [];
    for (let i = 0; i < 400 && !live.finished; i++) {
      const v = s.advanceGame();
      views.push(v);
      if (v.pending && v.pending.kind !== "ceremony-step") resolvePending(v.pending, (q: any) => void s.submitDecision(q));
    }
    const ballots = views.filter((v) => v.event?.beat === "finale-reveal");
    const win = views.findIndex((v) => v.event?.beat === "finale-result");
    expect(ballots.length).toBeGreaterThan(0);
    expect(new Set(ballots.map((v) => v.beatSeq)).size).toBe(ballots.length);
    expect(views.slice(0, win).filter((v) => v.event?.beat === "finale-reveal").length).toBe(ballots.length); // no ballot after the winner
    expect(views.slice(0, views.findIndex((v) => v.event?.beat === "finale-reveal")).some((v) => v.event?.beat === "finale-result")).toBe(false);
    expect(live.winner).toBeDefined();
    // each ballot names a juror and one of the two finalists only
    for (const b of ballots) expect(live.finale!.finalists).toContain(b.event.participants[1].id);
  });
});
