import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { renderVetoDrawBeatBlock } from "../../src/engine/momentPrompts";

/**
 * ORW-924: a Continue press through the veto DRAW gets a short narrated beat, like the eviction vote's (ORW-771). The engine hands the narrator third-person FACTS per press
 * (`vetoDrawBeat` on the advance result, `ceremony.veto.drawBeat` on the state view): the open step, the HOH, the nominees, and the six only once the field step has published them.
 * No winner, no result. Real path: a played season driven by the engine's own advance/decision calls to the veto draw, then pressed ONE STEP AT A TIME as the Continue button does.
 * Roles only; no state is set by hand.
 */
type Any = Record<string, any>;
afterEach(() => { GameSessionAdapter.setTimeOfDayEnabled(null); });

function driveToTheDraw(seed: number, flagOn: boolean): { s: Any; views: Any[]; states: Any[] } {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orw924-")))).sandboxFor("u").session as unknown as Any;
  s.setVoteBeatEnabled(flagOn);
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
  for (let i = 0; i < 900; i++) {
    if (s.live.ceremony?.kind === "veto-draw") break;
    const p = s.advanceGame().pending ?? s.live.pending;
    if (!p) continue;
    if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
    else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
    else if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
    else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", vote: p.options[0].id });
    else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
    else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0].id });
    else if (p.kind === "eviction-vote") s.submitDecision({ kind: "eviction-vote", vote: s.live.nominees[0] });
  }
  const views: Any[] = [], states: Any[] = [];
  for (let i = 0; i < 6 && s.live.ceremony?.kind === "veto-draw"; i++) {
    states.push(s.getGameState());
    views.push(s.advanceGame());
  }
  return { s, views, states };
}

describe("ORW-924: the veto draw's Continue presses carry a beat fact", () => {
  it("every draw press carries the beat (the open step, HOH, nominees), the six appear only once the field step publishes them, and there is no winner or result in it", () => {
    let found: ReturnType<typeof driveToTheDraw> | undefined;
    for (const seed of [5, 6, 7, 8, 9, 10, 11, 12]) { const r = driveToTheDraw(seed, true); if (r.views.length >= 2) { found = r; break; } }
    expect(found, "a played season reaches the veto draw's watch steps (scan 5..12)").toBeDefined();
    const { views, states } = found!;
    const beats = views.map((v) => v.vetoDrawBeat).filter(Boolean);
    expect(beats.length).toBe(views.length);
    for (const b of beats) {
      expect(Object.keys(b).every((k) => ["step", "stepNumber", "of", "closed", "hoh", "nominees", "field", "gathered", "timeOfDay"].includes(k))).toBe(true);
      expect(JSON.stringify(b)).not.toMatch(/winner|holder|result|used/i);
      expect(b.nominees.length).toBe(2);
    }
    const chips = beats.find((b) => b.step === "chips");
    if (chips) expect(chips.field, "the six are not shown before the game publishes them").toBeUndefined();
    const field = beats.find((b) => b.step === "field");
    expect(field?.field?.length, "the six, once the field step publishes them").toBe(6);
    // the state view the narrator reads while the step is open carries the same fact
    expect(states.some((st) => st.ceremony?.veto?.drawBeat)).toBe(true);
  });

  it("flag off: no beat fact on any press and none in the state view (the banner-only press, byte for byte)", () => {
    let r: ReturnType<typeof driveToTheDraw> | undefined;
    for (const seed of [5, 6, 7, 8, 9, 10, 11, 12]) { const x = driveToTheDraw(seed, false); if (x.views.length >= 2) { r = x; break; } }
    expect(r).toBeDefined();
    for (const v of r!.views) expect(v.vetoDrawBeat).toBeUndefined();
    for (const st of r!.states) expect(st.ceremony?.veto?.drawBeat).toBeUndefined();
  });

  it("the rendered block names the HOH, the block and, only when published, the six; no winner; no stock example phrasing", () => {
    const base = { step: "chips", stepNumber: 1, of: 2, closed: false, hoh: { id: "h", name: "Role Two" }, nominees: [{ id: "n1", name: "Role Three" }, { id: "n2", name: "Role Four" }], gathered: 15 };
    const chips = renderVetoDrawBeatBlock({ ceremony: { veto: { drawBeat: base } } } as never).join("\n");
    expect(chips).toMatch(/the chips are being drawn and the six are not yet shown/);
    expect(chips).toMatch(/Role Two is the Head of Household/);
    expect(chips).toMatch(/no veto winner/);
    const six = [1, 2, 3, 4, 5, 6].map((i) => ({ id: `p${i}`, name: `Role ${i + 10}` }));
    const field = renderVetoDrawBeatBlock({ ceremony: { veto: { drawBeat: { ...base, step: "field", stepNumber: 2, closed: true, field: six } } } } as never).join("\n");
    expect(field).toMatch(/the draw has set its six: Role 11, Role 12/);
    expect(field).toMatch(/competition itself has not started/);
    expect(chips + field).not.toMatch(/e\.g\.|for example|such as/i);
    expect(renderVetoDrawBeatBlock({ ceremony: { veto: {} } } as never)).toEqual([]);
  });
});
