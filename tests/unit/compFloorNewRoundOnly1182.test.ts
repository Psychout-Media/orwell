import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { renderGameContext } from "../../src/engine/momentPrompts";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

/**
 * ORW-1182 - a competition is told once. The cumulative out-list was handed to the narrator on every advance, so earlier rounds were told again. The context now names only the round(s) that are new as the exits
 * to voice, and each exit an earlier reply voiced only as already told. Drives a REAL seeded session to a staged competition with drops, marks the first exit as told by an earlier reply (the engine's own
 * told list), and reads the same view + context the narrator receives. Roles only.
 */
type Any = Record<string, any>;
const boot = (): Any => {
  const s = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-1182-")))).sandboxFor("u").session as unknown as Any;
  s.createCharacter({ playerName: "P", seed: 5 });
  s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
  return s;
};

function toCompWithDrops(s: Any): boolean {
  for (let i = 0; i < 300; i++) {
    const live = s.live as LiveSeasonState;
    const p = s.advanceGame().pending;
    if (p && p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
    else if (p && p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
    else if (p && p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
    else if (p && p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", pick: p.options[0].id });
    const c = live.competition;
    if (c && c.eliminated.length >= 2 && c.stillIn.length >= 2) return true;
  }
  return false;
}

describe("the competition context voices only the new round", () => {
  it("an exit an earlier reply voiced is named only as already told; the new exits are the ones to voice", () => {
    const s = boot();
    expect(toCompWithDrops(s), "a staged competition with two drops was reached").toBe(true);
    const out0 = (s.live as LiveSeasonState).competition!.eliminated[0]!;
    delete (s.live as Any).compSilentOut; // (the approach press's silent drops are a separate fact)
    s.compToldOut = [out0]; // the engine's own told list: this one went out in an earlier reply
    const v = s.getGameState();
    const f = v.ceremony.competition;
    const toldName = f.told.map((x: Any) => x.name)[0] as string;
    const fresh = f.out.map((x: Any) => x.name).filter((n: string) => n !== toldName) as string[];
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    const lines = renderGameContext(v).split("\n");
    const toVoice = lines.find((l) => l.includes("voice only these exits")) ?? "";
    expect(toVoice, "the exits to voice are listed").not.toBe("");
    for (const n of fresh) expect(toVoice).toContain(n);
    expect(toVoice, "the earlier exit is not in the list to voice").not.toContain(toldName);
    const floor = lines.find((l) => l.includes("Competition floor")) ?? "";
    expect(floor, "the floor line no longer re-lists every exit").not.toContain(toldName);
    expect(lines.find((l) => l.includes("ALREADY VOICED")) ?? "").toContain(toldName);
  });

  it("the player's own exit is reported, never acted out", () => {
    const s = boot();
    expect(toCompWithDrops(s)).toBe(true);
    const ctx = renderGameContext(s.getGameState());
    expect(ctx).toMatch(/never write the player's own fall/);
  });
});
