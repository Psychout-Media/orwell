import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { CEREMONY_STEP_TEXT, CEREMONY_STEPS, spreadClockHours } from "../../src/engine/liveSeason";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

/**
 * ORW-281 slice 4a - the GENERIC staged ceremony (Ryne 2026-11-11: ceremonies are play by play like comps, each decision its own step and its own message), nominations first.
 * The outcome is decided once up front and played out as presentation-only steps; ONE clock-spread helper paces them; a played game only (headless is byte-identical elsewhere). Roles only.
 */
type Any = Record<string, any>;
const dir = (): string => mkdtempSync(join(tmpdir(), "orwell-cer-"));
const boot = (d: string, played = true): Any => {
  const s = new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Any;
  s.createCharacter({ playerName: "P", seed: 5 });
  if (played) s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true; // the test drives the beats directly, not the day schedule
  return s;
};
const reload = (d: string): Any => new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Any;

/** Drive the season to the point the nominations beat is next (no pending), then seat the HOH as asked. */
function toNominations(s: Any, hoh: "player" | "npc"): void {
  for (let i = 0; i < 80; i++) {
    const live = s.live as LiveSeasonState;
    if (live.beat === "nominations" && !live.pending) break;
    const v = s.advanceGame();
    const p = v.pending;
    if (p && p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
    else if (p && p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
  }
  const live = s.live as LiveSeasonState;
  expect(live.beat).toBe("nominations");
  live.hoh = hoh === "player" ? PLAYER : live.active.find((h) => h !== PLAYER)!;
  live.preNomsNightPassed = true; // the night gate is its own earlier beat
}

describe("nominations as a staged ceremony (NPC HOH)", () => {
  it("steps hoh-speech -> named, one result each, a fresh beatSeq every step, the outcome published only at 'named'", () => {
    const s = boot(dir());
    toNominations(s, "npc");
    const a = s.advanceGame();
    expect(a.pending).toMatchObject({ kind: "ceremony-step", binding: false, ceremony: { kind: "nominations", step: 1, of: 2, stepId: "hoh-speech" } });
    expect(a.ceremony).toMatchObject({ stepId: "hoh-speech" });
    expect(a.event).toBeNull();
    expect((s.live as LiveSeasonState).nominees, "nothing is published before the 'named' step").toBeUndefined();
    const b = s.advanceGame();
    expect(b.pending).toMatchObject({ kind: "ceremony-step", ceremony: { step: 2, of: 2, stepId: "named" } });
    expect(b.event?.beat).toBe("nominations");
    expect(b.beatSeq).toBeGreaterThan(a.beatSeq);
    expect((s.live as LiveSeasonState).nominees).toHaveLength(2);
    const c = s.advanceGame(); // the closing Continue
    expect(c.pending).toBeNull();
    expect(c.ceremony).toMatchObject({ stepId: "named" });
    expect(c.beatSeq).toBeGreaterThan(b.beatSeq);
    expect((s.live as LiveSeasonState).ceremony).toBeUndefined();
  });
  it("a second window answering a past step gets the structured stale-beat refusal", () => {
    const s = boot(dir());
    toNominations(s, "npc");
    const a = s.advanceGame();
    s.advanceGame();
    expect(() => s.advanceGame({ expectedBeatSeq: a.beatSeq })).toThrow(/stale/i);
  });
  it("the house event stays 'nominations' for the WHOLE ceremony (the gathering never dissolves between steps)", () => {
    const s = boot(dir());
    toNominations(s, "npc");
    s.advanceGame();
    expect(s.houseEventInSession()).toMatchObject({ kind: "nominations" });
    s.advanceGame();
    expect(s.houseEventInSession()).toMatchObject({ kind: "nominations" });
  });
  it("restart parity: snapshot mid-ceremony, restore into a fresh adapter, the open step is identical", () => {
    const d = dir();
    const s = boot(d);
    toNominations(s, "npc");
    const a = s.advanceGame();
    const fresh = reload(d);
    const v = fresh.getGameState();
    expect(v.pending).toMatchObject({ kind: "ceremony-step", ceremony: a.ceremony, text: a.pending.text });
    expect(fresh.advanceGame().ceremony).toMatchObject({ stepId: "named" });
  });
});

describe("nominations as a staged ceremony (player HOH)", () => {
  it("hoh-speech -> choose (the EXISTING binding pending) -> named", () => {
    const s = boot(dir());
    toNominations(s, "player");
    const a = s.advanceGame();
    expect(a.pending).toMatchObject({ kind: "ceremony-step", ceremony: { step: 1, of: 3, stepId: "hoh-speech" } });
    const b = s.advanceGame();
    expect(b.pending).toMatchObject({ kind: "nominations", pick: 2, ceremony: { step: 2, of: 3, stepId: "choose" } });
    const [x, y] = b.pending.options;
    const c = s.submitDecision({ kind: "nominations", choice: [x.id, y.id], expectedBeatSeq: b.beatSeq });
    expect(c.event?.beat).toBe("nominations");
    expect(c.pending).toMatchObject({ kind: "ceremony-step", ceremony: { step: 3, of: 3, stepId: "named" } });
    expect((s.live as LiveSeasonState).nominees).toEqual([x.id, y.id]);
    expect(s.advanceGame().pending).toBeNull();
  });
  it("submitDecision refuses the watch step with a typed error", () => {
    const s = boot(dir());
    toNominations(s, "player");
    s.advanceGame();
    expect(() => s.submitDecision({ kind: "ceremony-step" })).toThrow(/advanceGame/);
  });
});

describe("headless / unplayed games are untouched", () => {
  it("an unplayed game resolves nominations in ONE beat exactly as before (no ceremony sub-state)", () => {
    const s = boot(dir(), false);
    toNominations(s, "npc");
    const v = s.advanceGame();
    expect(v.event?.beat).toBe("nominations");
    expect(v.pending).toBeNull();
    expect(v.ceremony).toBeUndefined();
    expect((s.live as LiveSeasonState).ceremony).toBeUndefined();
  });
});

describe("Vault sentinel", () => {
  it("no step view carries hidden state, the step text is public-only, and the outcome is absent until 'named'", () => {
    const s = boot(dir());
    toNominations(s, "npc");
    const live = s.live as LiveSeasonState;
    const a = s.advanceGame();
    const blob = JSON.stringify(a);
    expect(a.pending.text).toBe(CEREMONY_STEP_TEXT["nominations/hoh-speech"]!.replace("{hoh}", s.nameOf(live.hoh!)));
    const [n1, n2] = live.ceremony!.outcome!.nominees;
    expect(blob).not.toContain(n1);
    expect(blob).not.toContain(n2);
    expect(blob).not.toMatch(/outcome|threat|trust|secret|vault|vote/i);
    expect(JSON.stringify(s.getGameState())).not.toContain('"outcome"');
  });
});

describe("the one clock-spread helper", () => {
  const st = (): LiveSeasonState => ({} as LiveSeasonState);
  it("spreads an event budget over its steps, the closing step settles the remainder, and the total is the budget", () => {
    const s = st();
    const hours = [0, 1, 2].map((i) => spreadClockHours(s, "event", "k", 3, 3, i === 2));
    expect(hours).toEqual([1, 1, 1]);
    expect(hours.reduce((a, b) => a + b, 0)).toBe(3);
  });
  it("steps <= 0 front-loads the whole budget; comp and event slots do not collide", () => {
    const s = st();
    expect(spreadClockHours(s, "comp", "c", 3, 0, false)).toBe(3);
    expect(spreadClockHours(s, "event", "e", 2, 4, false)).toBe(0.5);
    expect(s.compClock?.spent).toBe(3);
    expect(s.eventClock?.spent).toBe(0.5);
  });
  it("every step list has a text row for each watch step (4b-4d add rows, not machinery)", () => {
    for (const [kind, lists] of Object.entries(CEREMONY_STEPS)) {
      if (!lists) continue;
      for (const id of new Set([...lists.withChoice, ...lists.npc])) if (id !== "choose") expect(CEREMONY_STEP_TEXT[`${kind}/${id}`], `${kind}/${id}`).toBeTruthy();
    }
  });
});
