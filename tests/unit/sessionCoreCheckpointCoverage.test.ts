import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sessionCoreCounts, sessionCoreCountsNonDecreasing, sessionCoreIsSuperset,
} from "../../src/engine/sessionSnapshot";
import type { SessionCoreCounts, SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { npc } from "../../src/domain/ids";

/**
 * PERSIST-8 — the 0031 fail-closed non-degradation checkpoint's `GameState` projection predates
 * features 0058-0107 and never covered the newer `SessionCore` dimensions (deals, deep profiles,
 * confidences, secrets-as-power, nomination history, texture overrides, …). A regression in any of
 * them was invisible to the gate. `sessionCoreCounts`/`sessionCoreIsSuperset`
 * (`src/engine/sessionSnapshot.ts`), wired into `Orchestrator.checkpoint`, close that gap with the
 * SAME discipline `saveState.ts`'s `counts`/`isSuperset` already use. HARD rule: roles only, no names.
 */

const freshDir = (): string => mkdtempSync(join(tmpdir(), "orwell-persist8-"));

/** A minimal, valid `SessionSnapshot` — only the field under test is populated. */
function baseSnap(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    started: true,
    week: 3,
    phase: "livefeed",
    ceremony: { nominees: [], vetoUsed: false },
    house: null,
    events: [],
    relationships: [],
    ...overrides,
  };
}

describe("PERSIST-8 — sessionCoreCounts (the newer monotonic per-season counters)", () => {
  const fields: Array<keyof SessionCoreCounts> = [
    "campaignTickCount", "playerCampaignMoveCount", "juryHouseTickCount", "eruptionCount", "triggerTickCount",
    "pacingTickCount", "confideLieCount", "secretExposeCount", "secretTradeCount",
    "secretPlayerBluffCount", "playerTieSurfaceCount", "tieScheduleTickCount", "surfacedThreadCount",
    "tieExposureCount", "tieRevealTickCount",
    "legendTickCount", "legendCount", "legendLastActTick",
    "secretBarterTickCount", "secretBarterCount",
    "showrunnerReweightCount", // 0101/#1401 Phase-2 (#1455) — the reweight-fired monotonic count
    "presenceTickCount",
    "lastConfessionalSweepDay",
  ];

  for (const field of fields) {
    it(`${field}: growth passes, thinning is caught`, () => {
      const earlier = sessionCoreCounts(baseSnap({ [field]: 3 } as Partial<SessionSnapshot>));
      const grown = sessionCoreCounts(baseSnap({ [field]: 5 } as Partial<SessionSnapshot>));
      const thinned = sessionCoreCounts(baseSnap({ [field]: 1 } as Partial<SessionSnapshot>));

      expect(sessionCoreCountsNonDecreasing(grown, earlier)).toBe(true);
      expect(sessionCoreCountsNonDecreasing(thinned, earlier)).toBe(false);
    });
  }

  it("a healthy commit growing every counter at once still passes", () => {
    const earlier = sessionCoreCounts(baseSnap());
    const later = sessionCoreCounts(baseSnap(Object.fromEntries(fields.map((f) => [f, 1])) as Partial<SessionSnapshot>));
    expect(sessionCoreCountsNonDecreasing(later, earlier)).toBe(true);
  });
});

describe("PERSIST-8 — sessionCoreIsSuperset (the newer append-only maps/sets)", () => {
  it("deals (0039): a dropped deal id is caught; an added deal passes", () => {
    const deal = (id: string) => ({
      id, parties: [npc(1), npc(2)] as [ReturnType<typeof npc>, ReturnType<typeof npc>],
      kind: "safety" as const, terms: "t", condition: { protect: npc(1), promisors: [npc(2)] }, status: "open" as const,
    });
    const earlier = baseSnap({ deals: [deal("d1")] });
    const grown = baseSnap({ deals: [deal("d1"), deal("d2")] });
    const dropped = baseSnap({ deals: [deal("d2")] }); // d1 lost

    expect(sessionCoreIsSuperset(grown, earlier)).toBe(true);
    expect(sessionCoreIsSuperset(dropped, earlier)).toBe(false);
  });

  it("deals: a deal's STATUS mutating in place is not flagged as a drop", () => {
    const open = { id: "d1", parties: [npc(1), npc(2)] as [ReturnType<typeof npc>, ReturnType<typeof npc>], kind: "safety" as const, terms: "t", condition: { protect: npc(1), promisors: [npc(2)] }, status: "open" as const };
    const kept = { ...open, status: "kept" as const };
    const earlier = baseSnap({ deals: [open] });
    const later = baseSnap({ deals: [kept] });
    expect(sessionCoreIsSuperset(later, earlier)).toBe(true);
  });

  it("deepProfiles (0058): a dropped houseguest entry is caught; an added one passes", () => {
    const profile = { secrets: ["s"], trueGoals: ["g"], weakness: "w", dayOnePerception: { read: "wary", trustLean: 0, affinityLean: 0, threatLean: 0 } };
    const earlier = baseSnap({ deepProfiles: { [npc(1)]: profile } });
    const grown = baseSnap({ deepProfiles: { [npc(1)]: profile, [npc(2)]: profile } });
    const dropped = baseSnap({ deepProfiles: { [npc(2)]: profile } });

    expect(sessionCoreIsSuperset(grown, earlier)).toBe(true);
    expect(sessionCoreIsSuperset(dropped, earlier)).toBe(false);
  });

  it("confideState (0075): a forgotten confidence is caught; a new one passes; a lie->truth VALUE flip is not flagged", () => {
    const earlier = baseSnap({ confideState: { [npc(1)]: { tier: "tease", truthful: false } } });
    const grown = baseSnap({ confideState: { [npc(1)]: { tier: "tease", truthful: false }, [npc(2)]: { tier: "partial", truthful: true } } });
    const dropped = baseSnap({ confideState: {} });
    const caughtLie = baseSnap({ confideState: { [npc(1)]: { tier: "tease", truthful: true } } }); // value legitimately changed

    expect(sessionCoreIsSuperset(grown, earlier)).toBe(true);
    expect(sessionCoreIsSuperset(dropped, earlier)).toBe(false);
    expect(sessionCoreIsSuperset(caughtLie, earlier)).toBe(true);
  });

  it("jurorTold (0129 slice 4): a dropped juror telling is caught; a new one passes", () => {
    const earlier = baseSnap({ jurorTold: ["fact a"] });
    expect(sessionCoreIsSuperset(baseSnap({ jurorTold: ["fact a", "fact b"] }), earlier)).toBe(true);
    expect(sessionCoreIsSuperset(baseSnap({ jurorTold: [] }), earlier)).toBe(false);
    expect(sessionCoreIsSuperset(baseSnap({}), earlier)).toBe(false);
  });

  it("secretUsedAs (0093/0099): a forgotten wielded-secret record is caught; a traded->exposed VALUE flip is not flagged", () => {
    const earlier = baseSnap({ secretUsedAs: { f1: "traded" } });
    const grown = baseSnap({ secretUsedAs: { f1: "traded", f2: "exposed" } });
    const dropped = baseSnap({ secretUsedAs: {} });
    const upgraded = baseSnap({ secretUsedAs: { f1: "exposed" } });

    expect(sessionCoreIsSuperset(grown, earlier)).toBe(true);
    expect(sessionCoreIsSuperset(dropped, earlier)).toBe(false);
    expect(sessionCoreIsSuperset(upgraded, earlier)).toBe(true);
  });

  it("privateOrientations (0063): a dropped closeted entry is caught", () => {
    const earlier = baseSnap({ privateOrientations: { [npc(1)]: "gay" as const } });
    const grown = baseSnap({ privateOrientations: { [npc(1)]: "gay" as const, [npc(2)]: "bisexual" as const } });
    const dropped = baseSnap({ privateOrientations: {} });

    expect(sessionCoreIsSuperset(grown, earlier)).toBe(true);
    expect(sessionCoreIsSuperset(dropped, earlier)).toBe(false);
  });

  it("textureOverrides (0070): a dropped event's enriched prose is caught", () => {
    const earlier = baseSnap({ textureOverrides: { "ev:1": "prose" } });
    const grown = baseSnap({ textureOverrides: { "ev:1": "prose", "ev:2": "more prose" } });
    const dropped = baseSnap({ textureOverrides: {} });

    expect(sessionCoreIsSuperset(grown, earlier)).toBe(true);
    expect(sessionCoreIsSuperset(dropped, earlier)).toBe(false);
  });

  it("nominationWeeks (0060 §3): a forgotten nomination week is caught; a new week appended passes", () => {
    const earlier = baseSnap({ nominationWeeks: { [npc(1)]: [2, 3] } });
    const grown = baseSnap({ nominationWeeks: { [npc(1)]: [2, 3, 5] } });
    const dropped = baseSnap({ nominationWeeks: { [npc(1)]: [3] } }); // week 2 lost

    expect(sessionCoreIsSuperset(grown, earlier)).toBe(true);
    expect(sessionCoreIsSuperset(dropped, earlier)).toBe(false);
  });

  it("surfacedTieSubjects (0059 §5): an un-surfaced subject is caught", () => {
    const earlier = baseSnap({ surfacedTieSubjects: [npc(1)] });
    const grown = baseSnap({ surfacedTieSubjects: [npc(1), npc(2)] });
    const dropped = baseSnap({ surfacedTieSubjects: [] });

    expect(sessionCoreIsSuperset(grown, earlier)).toBe(true);
    expect(sessionCoreIsSuperset(dropped, earlier)).toBe(false);
  });

  it("seededRelationships ties (0095): a regressed exposure is caught; growth passes; unordered pair matches", () => {
    const tie = (exposure?: "sealed" | "surfaced-to-house" | "public") => ({ a: npc(1), b: npc(2), nature: "old-acquaintance" as const, ...(exposure ? { exposure } : {}) });
    const earlier = baseSnap({ seededRelationships: { ties: [tie("surfaced-to-house")], showmances: [] } });
    const grown = baseSnap({ seededRelationships: { ties: [{ ...tie("public"), a: npc(2), b: npc(1) }], showmances: [] } });
    const regressed = baseSnap({ seededRelationships: { ties: [tie("sealed")], showmances: [] } });
    const dropped = baseSnap({ seededRelationships: { ties: [], showmances: [] } });

    expect(sessionCoreIsSuperset(grown, earlier)).toBe(true);
    expect(sessionCoreIsSuperset(regressed, earlier)).toBe(false);
    expect(sessionCoreIsSuperset(dropped, earlier)).toBe(false);
  });

  it("pacingLastDrippedWeek (0092): a regressed or forgotten drip week is caught; a later week passes", () => {
    const earlier = baseSnap({ pacingLastDrippedWeek: { "thread:1": 4 } });
    const grown = baseSnap({ pacingLastDrippedWeek: { "thread:1": 6 } });
    const dropped = baseSnap({ pacingLastDrippedWeek: {} });
    const regressed = baseSnap({ pacingLastDrippedWeek: { "thread:1": 2 } });

    expect(sessionCoreIsSuperset(grown, earlier)).toBe(true);
    expect(sessionCoreIsSuperset(dropped, earlier)).toBe(false);
    expect(sessionCoreIsSuperset(regressed, earlier)).toBe(false);
  });

  it("a healthy commit growing every dimension at once still passes", () => {
    const earlier = baseSnap({
      deals: [], deepProfiles: {}, confideState: {}, secretUsedAs: {}, privateOrientations: {},
      textureOverrides: {}, nominationWeeks: {}, surfacedTieSubjects: [], pacingLastDrippedWeek: {},
    });
    const later = baseSnap({
      deals: [{ id: "d1", parties: [npc(1), npc(2)], kind: "safety", terms: "t", condition: { protect: npc(1), promisors: [npc(2)] }, status: "open" }],
      deepProfiles: { [npc(1)]: { secrets: [], trueGoals: [], weakness: "w", dayOnePerception: { read: "wary", trustLean: 0, affinityLean: 0, threatLean: 0 } } },
      confideState: { [npc(1)]: { tier: "tease", truthful: true } },
      secretUsedAs: { f1: "leverage" },
      privateOrientations: { [npc(1)]: "bisexual" as const },
      textureOverrides: { "ev:1": "prose" },
      nominationWeeks: { [npc(1)]: [3] },
      surfacedTieSubjects: [npc(1)],
      pacingLastDrippedWeek: { "thread:1": 3 },
    });
    expect(sessionCoreIsSuperset(later, earlier)).toBe(true);
  });
});

describe("PERSIST-8 — wired into Orchestrator.checkpoint (fail-closed, matches the existing mechanism)", () => {
  it("a candidate that thinned a newer dimension is flagged as a degradation fault", () => {
    const dir = freshDir();
    const registry = new GameSessionRegistry(new FileSaveStore(dir));
    const orch = new Orchestrator(registry, new FakeClock(), { seed: 11 });
    const sandbox = registry.sandboxFor("u"); // pre-game sandbox is fine — hidden.length stays 0

    const baseline = baseSnap({ secretUsedAs: { f1: "traded" }, secretTradeCount: 1 });
    const candidate = baseSnap({ secretUsedAs: {}, secretTradeCount: 1 }); // the record was dropped

    const faults = orch.checkpoint(baseline, candidate, sandbox, "audit", { requireDailyEvent: false });
    expect(faults.some((f) => f.kind === "degradation")).toBe(true);
  });

  it("a healthy candidate that only GROWS the newer dimensions passes clean", () => {
    const dir = freshDir();
    const registry = new GameSessionRegistry(new FileSaveStore(dir));
    const orch = new Orchestrator(registry, new FakeClock(), { seed: 12 });
    const sandbox = registry.sandboxFor("u");

    const baseline = baseSnap({ secretUsedAs: { f1: "traded" }, secretTradeCount: 1, nominationWeeks: { [npc(1)]: [2] } });
    const candidate = baseSnap({
      secretUsedAs: { f1: "traded", f2: "exposed" }, secretTradeCount: 1, secretExposeCount: 1,
      nominationWeeks: { [npc(1)]: [2, 3] },
    });

    const faults = orch.checkpoint(baseline, candidate, sandbox, "audit", { requireDailyEvent: false });
    expect(faults).toEqual([]);
  });
});
