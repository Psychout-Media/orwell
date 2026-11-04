import { describe, it, expect, vi, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { resolvePending } from "../../features/support/answerPending";
import { PLAYER } from "../../src/domain/ids";

/**
 * B2 follow-on (#2017): the 0024 memory ledger is almost never WRITTEN in a season (measured: ~5 `remember()` calls, all veto-saved holder===subject, dropped), so no read
 * can ever tilt a decision. `ORWELL_NPC_MEMORY_WRITERS` (default OFF, never-flipped) adds the writer every week actually produces: an NPC remembers being NOMINATED by the HOH, whatever
 * their prior trust (graded by it — a betrayal by a friend weighs more). OFF ⇒ byte-identical. Roles only.
 */
type S = ReturnType<GameSessionRegistry["sandboxFor"]>["session"];
const mk = (writers: boolean, standalone = false): S => {
  const s = new GameSessionRegistry().sandboxFor(`mw-${writers}-${standalone}-${Math.random()}`).session;
  (s as unknown as { setNpcMemoryWritersEnabled(on: boolean): void }).setNpcMemoryWritersEnabled(writers);
  (s as unknown as { setNpcMemoryStandaloneEnabled(on: boolean): void }).setNpcMemoryStandaloneEnabled(standalone);
  return s;
};
function playUntilNominated(s: S, seed: number): void {
  s.createCharacter({ playerName: "P", seed });
  for (let i = 0; i < 4000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (r) => void s.submitDecision(r));
    const live = s.snapshot().live!;
    if (live.nominees && live.nominees.length === 2 && live.beat !== "nominations") return;
    if (v.finished) return;
  }
}
afterEach(() => vi.unstubAllEnvs());

describe("ORWELL_NPC_MEMORY_WRITERS", () => {
  it("ON: every NPC nominee remembers the HOH who nominated them (a grudge entry the standalone read can then act on)", () => {
    const s = mk(true);
    playUntilNominated(s, 3);
    const live = s.snapshot().live!;
    const hoh = live.hoh!;
    const npcNoms = (live.nominees ?? []).filter((n) => n !== PLAYER);
    expect(npcNoms.length).toBeGreaterThan(0);
    for (const n of npcNoms) {
      const entries = live.npcMemory?.[n]?.[hoh] ?? [];
      expect(entries.some((e) => e.kind === "nominated-by-hoh"), `${n} remembers being nominated`).toBe(true);
    }
  });
  it("OFF: no such entry is written (byte-identical ledger)", () => {
    const s = mk(false);
    playUntilNominated(s, 3);
    const live = s.snapshot().live!;
    const all = Object.values(live.npcMemory ?? {}).flatMap((row) => Object.values(row).flat());
    expect(all.some((e) => e.kind === "nominated-by-hoh")).toBe(false);
  });
  it("a deeper prior trust makes the remembered nomination weigh MORE (graded, never flat)", async () => {
    const { nominationMemorySeverity } = await import("../../src/engine/npcMemory");
    expect(nominationMemorySeverity(0.9)).toBeGreaterThan(nominationMemorySeverity(0.1));
    expect(nominationMemorySeverity(-1)).toBeGreaterThan(0);
    expect(nominationMemorySeverity(5)).toBeLessThanOrEqual(1);
  });
  it("ON + standalone: the remembered nominator is tilted against by the nominee (the first non-zero read in a plain season)", () => {
    const s = mk(true, true);
    playUntilNominated(s, 3);
    const live = s.snapshot().live!;
    const hoh = live.hoh!;
    const n = (live.nominees ?? []).find((x) => x !== PLAYER)!;
    const tilt = (s as unknown as { memoryTiltFor(subject: string, holder: string): number }).memoryTiltFor(hoh, n);
    expect(tilt).toBeGreaterThan(0);
  });
});

describe("B2 writers — the positive and the withheld-veto writers", () => {
  it("pure severities are bounded and graded by trust", async () => {
    const m = await import("../../src/engine/npcMemory");
    expect(m.vetoWithheldSeverity(1)).toBeGreaterThan(m.vetoWithheldSeverity(0));
    expect(m.vetoWithheldSeverity(5)).toBeLessThanOrEqual(0.4 + 1e-9);
    expect(m.nominationMemorySeverity(1)).toBeGreaterThan(m.vetoWithheldSeverity(1)); // a nomination is a bigger slight than a veto not used
  });
  it("deal-kept is a FAVOR (lowers the odds against the partner), veto-withheld a GRUDGE (raises them)", async () => {
    const m = await import("../../src/engine/npcMemory");
    expect(m.memoryTiltStandalone([{ kind: "deal-kept", week: 3, severity: 0.5 }], 3, 1)).toBeLessThan(0);
    expect(m.memoryTiltStandalone([{ kind: "veto-withheld", week: 3, severity: 0.3 }], 3, 1)).toBeGreaterThan(0);
  });
  it("over a whole season with the writers ON, the ledger carries more than just nominations, the per-pair cap holds, and OFF writes none of the new kinds", () => {
    const run = (on: boolean) => {
      const s = mk(on);
      s.createCharacter({ playerName: "P", seed: 5 });
      for (let i = 0; i < 9000; i++) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (r) => void s.submitDecision(r)); if (v.finished) break; }
      return Object.values(s.snapshot().live!.npcMemory ?? {}).flatMap((row) => Object.values(row));
    };
    const on = run(true), off = run(false);
    expect(on.length).toBeGreaterThan(0);
    for (const list of on) expect(list.length).toBeLessThanOrEqual(6);                   // NPC_MEMORY.maxEntriesPerPair
    const kinds = new Set(on.flat().map((e) => e.kind));
    expect(kinds.has("nominated-by-hoh")).toBe(true);
    const NEW = new Set(["nominated-by-hoh", "veto-withheld", "deal-kept"]);
    expect(off.flat().some((e) => NEW.has(e.kind)), "OFF writes none of the new kinds").toBe(false);
  });
});

describe("default-ON (2026-11-04, PO: 'memories should be turned on') — a remembered grudge shows up in a NOMINATION", () => {
  it("a fresh session needs no flag: the writers and the standalone read are ON by default", () => {
    const s = new GameSessionRegistry().sandboxFor(`dflt-${Math.random()}`).session as unknown as { npcMemoryWritersEnabled: boolean; npcMemoryStandaloneEnabled: boolean };
    expect(s.npcMemoryWritersEnabled).toBe(true);
    expect(s.npcMemoryStandaloneEnabled).toBe(true);
  });
  it("forced check: with the memory planted, the HOH nominates the houseguest they remember a grudge against in a case where, without the memory, they would not", () => {
    // Sweep seeds/candidates deterministically for a board where the planted memory is DECISIVE: OFF nominates the grudge's target never, ON always.
    let decisive = 0;
    for (let seed = 1; seed <= 12 && decisive === 0; seed++) {
      const probe = (planted: string | null, on: boolean): string[] => {
        const s = mk(on, on);
        s.createCharacter({ playerName: "P", seed });
        for (let i = 0; i < 4000; i++) {
          const live = s.snapshot().live!;
          if (live.beat === "nominations" && live.hoh && live.hoh !== PLAYER) break;
          const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (r) => void s.submitDecision(r)); if (v.finished) return [];
        }
        const core = JSON.parse(JSON.stringify(s.snapshot()));
        const hoh = core.live.hoh as string;
        if (planted) core.live.npcMemory = { [hoh]: { [planted]: [{ kind: "nominated-by-hoh", week: core.live.week, severity: 1 }, { kind: "nominated-by-hoh", week: core.live.week, severity: 1 }] } };
        s.restore(core);
        for (let k = 0; k < 4 && (s.snapshot().live!.nominees ?? []).length < 2; k++) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (r) => void s.submitDecision(r)); } // a day-break may come first; then the HOH nominates
        return [...(s.snapshot().live!.nominees ?? [])];
      };
      const base = probe(null, false);
      const living = (): string[] => { const s = mk(false); s.createCharacter({ playerName: "P", seed }); return (s.snapshot().live!.active as string[]).filter((x) => x !== PLAYER); };
      for (const cand of living()) {
        if (base.includes(cand)) continue;                 // already nominated without any memory — not a decisive case
        if (probe(cand, true).includes(cand)) { decisive++; break; }
      }
    }
    expect(decisive, "at least one board where a remembered grudge DECIDES the nomination").toBeGreaterThan(0);
  });
});
