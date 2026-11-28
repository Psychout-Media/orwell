import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { renderGameContext } from "../../src/engine/momentPrompts";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

/**
 * ORW-715 - the ceremony facts the narrator is handed. A played season's narrator stated a veto decision a day before the engine made one, and got the announced one wrong, because the context said
 * only "held by X" (`used` reads false both for "not used" and for "not decided yet"). Each case drives a REAL seeded session through a staged veto week and reads the same view + context the narrator
 * receives. Roles only.
 */
type Any = Record<string, any>;
const dir = (): string => mkdtempSync(join(tmpdir(), "orwell-cf-"));
const boot = (): Any => {
  const s = new GameSessionRegistry(new FileSaveStore(dir())).sandboxFor("u").session as unknown as Any;
  s.createCharacter({ playerName: "P", seed: 5 });
  s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
  return s;
};

function toVetoCeremony(s: Any): void {
  for (let i = 0; i < 200; i++) {
    const live = s.live as LiveSeasonState;
    if (live.beat === "veto-ceremony" && !live.pending && !live.ceremony) break;
    const p = s.advanceGame().pending;
    if (p && p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
    else if (p && p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
    else if (p && p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
    else if (p && p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", pick: p.options[0].id });
  }
  const live = s.live as LiveSeasonState;
  const others = live.active.filter((h) => h !== PLAYER);
  live.hoh = others[0]!;
  live.nominees = [others[1]!, others[2]!];
  live.vetoHolder = others[3]!;
  live.preVetoCeremonyNightPassed = true;
  s.ceremony = { ...s.ceremony, hoh: live.hoh, nominees: [...live.nominees], vetoHolder: live.vetoHolder };
}

afterEach(() => { delete process.env.ORWELL_CEREMONY_FACTS; });

describe("the veto decision is a fact the narrator is handed", () => {
  it("before the ceremony publishes it the view and the context say it is NOT made, and name no one", () => {
    const s = boot();
    toVetoCeremony(s);
    s.advanceGame(); // the convene step: the engine has planned the outcome, nothing is published
    const v = s.getGameState();
    expect(v.ceremony.veto.holder).not.toBeNull();
    expect(v.ceremony.veto.decision).toEqual({ made: false });
    const ctx = renderGameContext(v);
    expect(ctx).toMatch(/Veto decision: NOT MADE YET/);
    const planned = (s.live as LiveSeasonState).ceremony!.vetoOutcome!;
    for (const id of [planned.saved, planned.replacement].filter((x): x is string => !!x)) expect(JSON.stringify(v.ceremony)).not.toContain(id);
  });

  it("after the result step the view and the context carry the engine's decision, who came down and who went up", () => {
    const s = boot();
    toVetoCeremony(s);
    s.advanceGame();
    const planned = { ...(s.live as LiveSeasonState).ceremony!.vetoOutcome! };
    s.advanceGame(); // result
    const live = s.live as LiveSeasonState;
    const v = s.getGameState();
    const d = v.ceremony.veto.decision;
    expect(d.made).toBe(true);
    expect(d.used).toBe(!!planned.used);
    const ctx = renderGameContext(v);
    if (planned.used) {
      expect(d.saved.id).toBe(live.saved);
      expect(d.replacement.id).toBe(live.replacement);
      expect(ctx).toContain(d.saved.id === live.vetoHolder ? "used it on THEMSELF" : `used it to save ${d.saved.name}`);
      expect(ctx).toContain(`named ${d.replacement.name} as the replacement`);
    } else {
      expect(ctx).toMatch(/did NOT use it/);
    }
    expect(ctx).not.toMatch(/NOT MADE YET/);
  });

  it("ORW-1052: a holder who is a nominee and saves themself is stated as a self-save, with the other nominee staying and the final two named", () => {
    const s = boot();
    toVetoCeremony(s);
    const live = s.live as LiveSeasonState;
    const [self, other] = live.nominees as [string, string];
    live.vetoHolder = self;
    s.ceremony = { ...s.ceremony, vetoHolder: self };
    s.advanceGame(); // convene
    s.advanceGame(); // result
    expect(live.vetoUsed).toBe(true);
    expect(live.saved).toBe(self);
    const v = s.getGameState();
    const nm = (id: string) => v.house.find((h: Any) => h.id === id)?.name as string;
    const repl = v.ceremony.veto.decision.replacement.name as string;
    const ctx = renderGameContext(v);
    expect(ctx).toContain(`${nm(self)} holds the veto and USED it. ${nm(self)} used it on THEMSELF`);
    expect(ctx).toContain(`The holder did NOT save anyone else`);
    expect(ctx).toContain(`as the replacement nominee`);
    expect(ctx).toContain(`The two on the block now are ${nm(other)} and ${repl}`);
    expect(ctx).not.toContain(`to save ${nm(other)}`);
  });

  it("with the flag off neither fact is on the view or in the context (byte-identical)", () => {
    process.env.ORWELL_CEREMONY_FACTS = "0";
    const s = boot();
    toVetoCeremony(s);
    s.advanceGame();
    const v = s.getGameState();
    expect(v.ceremony.veto.decision).toBeUndefined();
    expect(v.ceremony.competition).toBeUndefined();
    expect(renderGameContext(v)).not.toMatch(/Veto decision|Competition floor/);
  });
});

describe("a staged competition's floor is a fact the narrator is handed", () => {
  it("names who is still in and who is already out after each announced drop", () => {
    const s = boot();
    let seen = false;
    for (let i = 0; i < 300 && !seen; i++) {
      const live = s.live as LiveSeasonState;
      const p = s.advanceGame().pending;
      if (p && p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
      else if (p && p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
      else if (p && p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
      else if (p && p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", pick: p.options[0].id });
      const c = live.competition;
      if (c && c.eliminated.length >= 1 && c.stillIn.length >= 2) {
        const v = s.getGameState();
        const f = v.ceremony.competition;
        expect(f.out.map((x: Any) => x.id)).toEqual(c.eliminated);
        expect(f.stillIn.map((x: Any) => x.id)).toEqual(c.stillIn);
        const ctx = renderGameContext(v);
        expect(ctx).toContain("Competition floor: still in ");
        for (const o of f.out) expect(ctx.split("already out")[1]).toContain(o.name);
        seen = true;
      }
    }
    expect(seen, "a staged competition with a drop was reached").toBe(true);
  });
});
