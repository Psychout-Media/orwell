import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { renderGameContext } from "../../src/engine/momentPrompts";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

/**
 * ORW-863 - the narrator is told who casts the eviction vote. A speaker off the block said they had no vote to give; a nominee said "before I vote". A REAL seeded session is played
 * (no state set by hand) to the veto ceremony, and the context the narrator receives must name exactly the HOH and the two nominees as the people with no ballot. Roles only.
 */
type Any = Record<string, any>;
describe("the eviction vote is a fact the narrator is handed", () => {
  it("names the HOH and both nominees as casting no ballot, and says everyone else does", () => {
    const s = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-ev-")))).sandboxFor("u").session as unknown as Any;
    s.createCharacter({ playerName: "P", seed: 5 });
    s.noteMessage({ messageId: "m1" });
    s.scheduleGateBypass = true;
    for (let i = 0; i < 200; i++) {
      const live = s.live as LiveSeasonState;
      if (live.beat === "veto-ceremony" && !live.pending && !live.ceremony) break;
      const p = s.advanceGame().pending;
      if (p && p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
      else if (p && p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
      else if (p && p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
      else if (p && p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", pick: p.options[0].id });
    }
    const v = s.getGameState();
    expect(v.ceremony.nominees.length).toBe(2);
    const line = renderGameContext(v).split("\n").find((l) => l.includes("Eviction vote (engine truth)"));
    expect(line).toBeDefined();
    const named = (line as string).split("cast NO ballot:")[1]!.split(". The HOH")[0]!;
    for (const n of [v.ceremony.hoh, ...v.ceremony.nominees]) if (n) expect(named).toContain(n.name);
    const off = v.house.filter((h: Any) => ![v.ceremony.hoh?.id, ...v.ceremony.nominees.map((n: Any) => n.id)].includes(h.id));
    expect(off.length).toBeGreaterThan(0);
    for (const h of off) expect(named).not.toContain(h.name);
  });
});
