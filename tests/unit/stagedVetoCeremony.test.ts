import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

/**
 * ORW-281 slice 4c - the VETO CEREMONY as a staged ceremony (convene -> [decide] -> [replacement] -> result) on the 4a machinery. The outcome (use / saved / replacement) is decided once
 * (up front for an NPC holder, at 'decide' for the player), the same reads in the same order as the one-beat resolution; nothing is published (BeatEvent, folds, announcements) before
 * 'result'. Played games only; the headless path is byte-identical. Roles only.
 */
type Any = Record<string, any>;
const dir = (): string => mkdtempSync(join(tmpdir(), "orwell-vc-"));
const boot = (d: string, played = true): Any => {
  const s = new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Any;
  s.createCharacter({ playerName: "P", seed: 5 });
  if (played) s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
  return s;
};
const reload = (d: string): Any => new GameSessionRegistry(new FileSaveStore(d)).sandboxFor("u").session as unknown as Any;

/** Drive to the veto-ceremony beat (next advance), then seat the HOH / veto holder as asked (an NPC for "npc"). */
function toVetoCeremony(s: Any, hoh: "player" | "npc", holder: "player" | "npc"): void {
  for (let i = 0; i < 200; i++) {
    const live = s.live as LiveSeasonState;
    if (live.beat === "veto-ceremony" && !live.pending && !live.ceremony) break;
    const v = s.advanceGame();
    const p = v.pending;
    if (p && p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
    else if (p && p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
    else if (p && p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
    else if (p && p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", pick: p.options[0].id });
  }
  const live = s.live as LiveSeasonState;
  expect(live.beat).toBe("veto-ceremony");
  const others = live.active.filter((h) => h !== PLAYER);
  live.hoh = hoh === "player" ? PLAYER : others[0]!;
  live.nominees = [others.find((h) => h !== live.hoh)!, others.filter((h) => h !== live.hoh)[1]!];
  live.vetoHolder = holder === "player" ? PLAYER : others.find((h) => h !== live.hoh && !live.nominees!.includes(h))!;
  live.preVetoCeremonyNightPassed = true;
}

describe("veto ceremony as a staged ceremony - NPC holder, NPC HOH", () => {
  it("convene -> result: nothing published before 'result', then the board is set and the beat is eviction", () => {
    const s = boot(dir());
    toVetoCeremony(s, "npc", "npc");
    const live = s.live as LiveSeasonState;
    const a = s.advanceGame();
    expect(a.pending).toMatchObject({ kind: "ceremony-step", binding: false, ceremony: { kind: "veto-ceremony", step: 1, of: 2, stepId: "convene" } });
    expect(a.event).toBeNull();
    expect(a.announcements ?? []).toEqual([]);
    expect(live.finalNominees, "nothing published before 'result'").toBeUndefined();
    expect(live.vetoUsed).not.toBe(true);
    const o = live.ceremony!.vetoOutcome!;
    const secret = [o.saved, o.replacement].filter((x): x is string => !!x);
    for (const id of secret) expect(JSON.stringify(a)).not.toContain(id); // the Vault-free step view never carries the unpublished outcome (ids; names resolve from them)
    expect(JSON.stringify(a.pending.text ?? "")).not.toMatch(/uses|replacement/i);
    const b = s.advanceGame();
    expect(b.pending).toMatchObject({ kind: "ceremony-step", ceremony: { step: 2, of: 2, stepId: "result" } });
    expect(b.event?.beat).toBe("veto-ceremony");
    expect(b.beatSeq).toBeGreaterThan(a.beatSeq);
    expect(live.finalNominees).toHaveLength(2);
    expect(live.beat).toBe("eviction");
    expect(b.announcements?.some((x: Any) => x.kind === "veto-decision")).toBe(true);
    expect(b.pending.text).toContain(s.nameOf(live.finalNominees![0]!));
    const c = s.advanceGame();
    expect(c.pending).toBeNull();
    expect(live.ceremony).toBeUndefined();
  });
  it("same outcome as the one-beat resolution (headless): final nominees, use, saved, replacement all match", () => {
    const staged = boot(dir());
    toVetoCeremony(staged, "npc", "npc");
    const headless = boot(dir(), false);
    toVetoCeremony(headless, "npc", "npc");
    const sl = staged.live as LiveSeasonState, hl = headless.live as LiveSeasonState;
    expect(sl.nominees).toEqual(hl.nominees);
    staged.advanceGame(); staged.advanceGame(); // convene, result
    headless.advanceGame(); // one beat
    expect(hl.ceremony).toBeUndefined();
    expect(sl.vetoUsed).toBe(hl.vetoUsed);
    expect(sl.saved).toBe(hl.saved);
    expect(sl.replacement).toBe(hl.replacement);
    expect(sl.finalNominees).toEqual(hl.finalNominees);
  });
  it("the house event is 'veto-ceremony' for the whole ceremony; a stale second window is refused; restart parity", () => {
    const d = dir();
    const s = boot(d);
    toVetoCeremony(s, "npc", "npc");
    const a = s.advanceGame();
    expect(s.houseEventInSession()).toMatchObject({ kind: "veto-ceremony" });
    expect(() => s.advanceGame({ expectedBeatSeq: a.beatSeq - 1 })).toThrow(/stale/i);
    const v = reload(d).getGameState();
    expect(v.pending).toMatchObject({ kind: "ceremony-step", ceremony: a.ceremony, text: a.pending.text });
    expect(reload(d).advanceGame().ceremony).toMatchObject({ stepId: "result" });
  });
});

describe("veto ceremony as a staged ceremony - player holder", () => {
  it("convene -> decide (binding veto-decision with the echo) -> result; the decision publishes only at 'result'", () => {
    const s = boot(dir());
    toVetoCeremony(s, "npc", "player");
    const live = s.live as LiveSeasonState;
    const a = s.advanceGame();
    expect(a.pending).toMatchObject({ kind: "ceremony-step", ceremony: { kind: "veto-ceremony", step: 1, of: 3, stepId: "convene" } });
    const b = s.advanceGame();
    expect(b.pending).toMatchObject({ kind: "veto-decision", ceremony: { stepId: "decide", step: 2, of: 3 } });
    expect(b.event).toBeNull();
    expect(() => s.advanceGame({ expectedBeatSeq: a.beatSeq })).toThrow(/stale/i);
    const save = b.pending.options[0].id;
    const r = s.submitDecision({ kind: "veto-decision", use: true, save });
    expect(r.pending).toMatchObject({ kind: "ceremony-step", ceremony: { stepId: "result" } });
    expect(r.event?.beat).toBe("veto-ceremony");
    expect(live.vetoUsed).toBe(true);
    expect(live.saved).toBe(save);
    expect(live.finalNominees).toHaveLength(2);
    expect(live.finalNominees).not.toContain(save);
    expect(live.beat).toBe("eviction");
    expect(r.announcements?.map((x: Any) => x.kind)).toEqual(["veto-decision", "replacement-nominee"]);
  });
  it("not using the veto leaves the nominees standing", () => {
    const s = boot(dir());
    toVetoCeremony(s, "npc", "player");
    const live = s.live as LiveSeasonState;
    const nominees = [...live.nominees!];
    s.advanceGame(); s.advanceGame();
    const r = s.submitDecision({ kind: "veto-decision", use: false });
    expect(r.event?.content).toMatch(/does not use/);
    expect(live.finalNominees).toEqual(nominees);
    expect(live.vetoUsed).toBe(false);
  });
  it("player holder AND HOH: using the veto splices a binding 'replacement' step before 'result'", () => {
    const s = boot(dir());
    toVetoCeremony(s, "player", "player");
    const live = s.live as LiveSeasonState;
    s.advanceGame();
    const b = s.advanceGame();
    const save = b.pending.options[0].id;
    const r = s.submitDecision({ kind: "veto-decision", use: true, save });
    expect(r.pending).toMatchObject({ kind: "replacement", ceremony: { stepId: "replacement", of: 4 } });
    expect(r.event).toBeNull();
    expect(live.finalNominees, "not published before 'result'").toBeUndefined();
    expect(live.vetoUsed).not.toBe(true);
    const pick = r.pending.options[0].id;
    const r2 = s.submitDecision({ kind: "replacement", replacement: pick });
    expect(r2.pending).toMatchObject({ kind: "ceremony-step", ceremony: { stepId: "result", step: 4, of: 4 } });
    expect(r2.event?.beat).toBe("veto-ceremony");
    expect(live.replacement).toBe(pick);
    expect(live.beat).toBe("eviction");
  });
});

describe("veto ceremony as a staged ceremony - NPC holder, player HOH", () => {
  it("a used veto asks the player for the replacement (binding), published at 'result'", () => {
    // find a seating where the NPC holder uses the veto (the holder saves a nominee they favour, or themselves if nominated)
    const s = boot(dir());
    toVetoCeremony(s, "player", "npc");
    const live = s.live as LiveSeasonState;
    live.nominees = [live.vetoHolder!, live.nominees![0]!]; // the holder is a nominee: they save themselves
    s.advanceGame();
    const b = s.advanceGame();
    expect(b.pending).toMatchObject({ kind: "replacement", ceremony: { stepId: "replacement" } });
    expect(live.finalNominees).toBeUndefined();
    const r = s.submitDecision({ kind: "replacement", replacement: b.pending.options[0].id });
    expect(r.pending).toMatchObject({ kind: "ceremony-step", ceremony: { stepId: "result" } });
    expect(r.announcements?.map((x: Any) => x.kind)).toEqual(["veto-decision", "replacement-nominee"]);
    expect(live.vetoUsed).toBe(true);
  });
});
