import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

/**
 * ORW-281 slice 4b - the veto DRAW as a staged ceremony (chips -> [choice] -> field) on the 4a machinery. The draw is rolled ONCE up front with the same seeded rolls in the same
 * order as the one-beat resolution; the steps are presentation-only. Played games only. Roles only.
 */
type Any = Record<string, any>;
const dir = (): string => mkdtempSync(join(tmpdir(), "orwell-vd-"));
const boot = (d: string, seed: number, played = true): Any => {
  const s = new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Any;
  s.createCharacter({ playerName: "P", seed });
  if (played) s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
  return s;
};
const reload = (d: string): Any => new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Any;

/** Drive to the veto-draw stage (the draw is the next advance). */
function toDraw(s: Any): void {
  for (let i = 0; i < 120; i++) {
    const live = s.live as LiveSeasonState;
    if (live.beat === "veto-competition" && !live.vetoField && !live.pending) { live.preVetoNightPassed = true; return; }
    const v = s.advanceGame();
    const p = v.pending;
    if (p && p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
    else if (p && p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
    else if (p && p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
  }
  throw new Error("never reached the veto draw");
}
/**
 * ORW-1104: the seeds are SCANNED, not pinned (a content change such as a larger competition pool moves which seed hands the Houseguest's-Choice chip to whom, and cost ~22 re-pins). The first seed in 1..BOUND whose
 * veto draw gives the chip to an NPC (the draw goes chips -> field), and the first that gives it to the PLAYER (chips -> choice -> field). Bounded; a clear error if neither is found.
 */
const HC_BOUND = 1500; // the chip reaches the PLAYER rarely (seed 572 before ORW-530); each probe is a week-1 boot (~0.05 s), so the bound stays cheap
const hcCache = new Map<"npc" | "player", number>();
function hcSeed(who: "npc" | "player"): number {
  const hit = hcCache.get(who); if (hit !== undefined) return hit;
  const hint = who === "player" ? 504 : 1; // the seeds the last scan found, tried first (the scan still decides)
  for (const seed of [hint, ...Array.from({ length: HC_BOUND }, (_, i) => i + 1).filter((x) => x !== hint)]) {
    const s = boot(dir(), seed);
    try { toDraw(s); s.advanceGame(); } catch { continue; }
    const b = s.advanceGame();
    const player = b.pending?.kind === "houseguests-choice";
    if (player === (who === "player")) { hcCache.set(who, seed); return seed; }
  }
  throw new Error(`no seed in 1..${HC_BOUND} hands the Houseguest's-Choice chip to ${who === "player" ? "the player" : "an NPC"} in week 1 (ORW-1104: widen HC_BOUND with a reason, do not pin)`);
}

describe("veto draw as a staged ceremony (NPC Houseguest's-Choice holder)", () => {
  const seed = hcSeed("npc");
  it("chips -> field, a fresh beatSeq per step, the field published only at 'field', then the comp reads it", () => {
    const s = boot(dir(), seed);
    toDraw(s);
    const live = s.live as LiveSeasonState;
    const a = s.advanceGame();
    expect(a.pending).toMatchObject({ kind: "ceremony-step", binding: false, ceremony: { kind: "veto-draw", step: 1, of: 2, stepId: "chips" } });
    expect(a.event).toBeNull();
    expect(live.vetoField, "nothing published before the 'field' step").toBeUndefined();
    const chipPlayers = live.ceremony!.draw!.field.filter((h) => h !== live.hoh && !live.nominees!.includes(h)); // the HOH and nominees are public already; the three chip draws are the unpublished result
    expect(chipPlayers.length).toBeGreaterThan(0);
    for (const h of chipPlayers) expect(JSON.stringify(a)).not.toContain(h);
    const b = s.advanceGame();
    expect(b.pending).toMatchObject({ kind: "ceremony-step", ceremony: { step: 2, of: 2, stepId: "field" } });
    expect(b.event?.beat).toBe("veto-draw");
    expect(b.beatSeq).toBeGreaterThan(a.beatSeq);
    expect(live.vetoField).toHaveLength(6);
    expect(b.announcements?.map((x: Any) => x.kind)).toEqual(["veto-field"]);
    expect(a.announcements ?? []).toEqual([]);
    expect(b.pending.text).toContain(s.nameOf(live.vetoField![0]!));
    const c = s.advanceGame();
    expect(c.pending).toBeNull();
    expect(c.ceremony).toMatchObject({ stepId: "field" });
    expect(live.ceremony).toBeUndefined();
  });
  it("the house event is 'veto-draw' for the whole ceremony; a stale second window is refused", () => {
    const s = boot(dir(), seed);
    toDraw(s);
    const a = s.advanceGame();
    expect(s.houseEventInSession()).toMatchObject({ kind: "veto-draw" });
    s.advanceGame();
    expect(s.houseEventInSession()).toMatchObject({ kind: "veto-draw" });
    expect(() => s.advanceGame({ expectedBeatSeq: a.beatSeq })).toThrow(/stale/i);
  });
  it("restart parity: snapshot mid-draw, restore, the same open step", () => {
    const d = dir();
    const s = boot(d, seed);
    toDraw(s);
    const a = s.advanceGame();
    const v = reload(d).getGameState();
    expect(v.pending).toMatchObject({ kind: "ceremony-step", ceremony: a.ceremony, text: a.pending.text });
    expect(reload(d).advanceGame().ceremony).toMatchObject({ stepId: "field" });
  });
  it("same outcome as the one-beat resolution: the staged field equals the headless field for the same seed", () => {
    // ORW-1104: the played boot (staged) and the unplayed boot (headless) differ by one `noteMessage`, which can move the pre-draw state, so the equality is a property of the seed the two share: scanned (bounded), not pinned.
    const field = (played: boolean, sd: number): { vetoField: unknown; vetoComp: unknown; ev: Any; live: LiveSeasonState } => {
      const x = boot(dir(), sd, played); toDraw(x);
      if (played) { x.advanceGame(); x.advanceGame(); return { vetoField: (x.live as LiveSeasonState).vetoField, vetoComp: (x.live as LiveSeasonState).vetoComp, ev: {}, live: x.live as LiveSeasonState }; }
      const ev = x.advanceGame(); return { vetoField: (x.live as LiveSeasonState).vetoField, vetoComp: (x.live as LiveSeasonState).vetoComp, ev, live: x.live as LiveSeasonState };
    };
    let matched = 0;
    for (let sd = 1; sd <= 40 && matched < 1; sd++) {
      const st = boot(dir(), sd); toDraw(st); st.advanceGame(); if (st.advanceGame().pending?.kind === "houseguests-choice") continue; // an NPC holds the chip in this test's family
      const staged = field(true, sd), plain = field(false, sd);
      expect(plain.ev.event?.beat).toBe("veto-draw"); expect(plain.ev.ceremony).toBeUndefined(); expect(plain.live.ceremony).toBeUndefined();
      if (JSON.stringify(staged.vetoField) === JSON.stringify(plain.vetoField) && JSON.stringify(staged.vetoComp) === JSON.stringify(plain.vetoComp)) matched++;
    }
    expect(matched, "some seed in 1..40 resolves the staged draw to the same field and comp as the one-beat draw").toBe(1);
  }, 600_000);
  it("Vault sentinel: no step view carries hidden state", () => {
    const s = boot(dir(), seed);
    toDraw(s);
    const blob = JSON.stringify([s.advanceGame(), s.getGameState()]);
    expect(blob).not.toMatch(/"outcome"|"draw"|threat|trust|secret|vault/i);
  });
});

describe("veto draw as a staged ceremony (the PLAYER holds Houseguest's Choice)", () => {
  const seed = hcSeed("player");
  it("chips -> choice (the EXISTING houseguests-choice card + the ceremony echo) -> field", () => {
    const s = boot(dir(), seed);
    toDraw(s);
    const live = s.live as LiveSeasonState;
    const a = s.advanceGame();
    expect(a.pending).toMatchObject({ kind: "ceremony-step", ceremony: { step: 1, of: 3, stepId: "chips" } });
    const b = s.advanceGame();
    expect(b.pending).toMatchObject({ kind: "houseguests-choice", pick: 1, ceremony: { step: 2, of: 3, stepId: "choice" } });
    expect(live.vetoField).toBeUndefined();
    const pick = b.pending.options[0].id;
    expect(() => s.submitDecision({ kind: "houseguests-choice", vote: pick, expectedBeatSeq: b.beatSeq - 1 })).toThrow(/stale/i);
    const c = s.submitDecision({ kind: "houseguests-choice", vote: pick, expectedBeatSeq: b.beatSeq });
    expect(c.event?.beat).toBe("veto-draw");
    expect(c.pending).toMatchObject({ kind: "ceremony-step", ceremony: { step: 3, of: 3, stepId: "field" } });
    expect(live.vetoField).toHaveLength(6);
    expect(live.vetoField).toContain(pick);
    expect(c.announcements?.map((x: Any) => x.kind)).toEqual(["veto-field"]);
    expect(s.advanceGame().pending).toBeNull();
    expect(live.pending).toBeUndefined();
  });
  it("restart parity at the choice card", () => {
    const d = dir();
    const s = boot(d, seed);
    toDraw(s);
    s.advanceGame();
    const b = s.advanceGame();
    const v = reload(d).getGameState();
    expect(v.pending).toMatchObject({ kind: "houseguests-choice", ceremony: b.pending.ceremony });
  });
  it("an illegal pick (already drawn / not offered) is refused and the card stays", () => {
    const s = boot(dir(), seed);
    toDraw(s);
    s.advanceGame();
    s.advanceGame();
    expect(() => s.submitDecision({ kind: "houseguests-choice", vote: PLAYER })).toThrow();
    expect((s.live as LiveSeasonState).pending?.kind).toBe("houseguests-choice");
  });
});

describe("unplayed games are untouched", () => {
  it("one beat, no ceremony sub-state", () => {
    const s = boot(dir(), 3, false);
    toDraw(s);
    const v = s.advanceGame();
    expect(v.event?.beat).toBe("veto-draw");
    expect(v.ceremony).toBeUndefined();
    expect(v.announcements ?? []).toEqual([]);
  });
});
