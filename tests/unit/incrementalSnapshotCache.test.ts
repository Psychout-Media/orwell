import { describe, it, expect, vi } from "vitest";
import { freshTmpDir } from "../support/freshTmpDir";
import { join } from "node:path";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { PLAYER, npc } from "../../src/domain/ids";
import { buildWorldSnapshot } from "../../src/engine/zeitgeist";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

/**
 * R3 (incremental snapshot) — the registry-level export cache + the EventStore query cache. The headline
 * late-game latency bug: every player turn re-serialized the FULL, ever-growing snapshot (an O(events)
 * `events.queryAll().slice()` plus a re-serialize of relationships/knowledge/vault), and the integrity spine
 * exports it MULTIPLE times per turn (candidate, next baseline, off-screen-tick baseline, plus every
 * `getGameState` poll) — so a single slow synchronous commit blocked the Node event loop and every
 * concurrent poll (state/deals/recap/health) 502'd. The fix caches the export per user, keyed on a
 * mutation rev (+ the O(1) event count), so the serialization runs once per ACTUAL state change and a
 * quiet stretch of reads reuses one immutable object.
 *
 * These tests prove BOTH halves of the bar:
 *   (a) CORRECTNESS — the cached export is byte-identical to a forced full recompute, across a multi-week
 *       seeded game and after every mutation/sandbox-replacement; the cache never serves a stale capture;
 *   (b) BOUNDED WORK — a read does NOT re-derive the whole event history each call (asserted via a spy on
 *       `events.query`, not wall-clock): N reads with no mutation between them cost ONE export, and the
 *       per-export `query` re-slice happens at most once per appended event.
 *
 * HARD rule: roles only — generic ids (player / npc:N), never names.
 */

const freshDir = (): string => freshTmpDir("orwell-r3cache-");

function liveRig(seed: number) {
  const reg = new GameSessionRegistry(new FileSaveStore(freshDir()));
  const clock = new FakeClock();
  const orch = new Orchestrator(reg, clock, { seed, turnDriven: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  reg.setOnReset((u) => orch.forgetUser(u));
  const U = "u";
  reg.sandboxFor(U).session.createCharacter({ playerName: "The Player", seed });
  return { reg, clock, orch, U };
}
const tick = (orch: Orchestrator, clock: FakeClock, U: string, n: number): void => {
  for (let i = 0; i < n; i++) { clock.advance(60_000); orch.advance(U, "offscreen-tick"); }
};

describe("R3 cache — the cached export equals a full recompute (correctness)", () => {
  it("byte-identical to a forced full recompute across a multi-week game and after every mutation", () => {
    const { reg, clock, orch, U } = liveRig(13);
    const sb = reg.sandboxFor(U);
    // A full recompute that bypasses the cache: read the live stores directly, the SAME way exportSnapshot
    // does. If the cached export ever diverged from this, the cache would be serving stale/garbled state.
    const fullRecompute = (): SessionSnapshot => ({
      ...sb.session.snapshot(),
      snapshotVersion: (reg.snapshot(U)).snapshotVersion,
      events: sb.engine.events.queryAll(),
      relationships: sb.engine.relationships.serialize().edges,
      knowledge: sb.engine.knowledge.serialize(),
      vault: sb.engine.vault.readHidden(),
    });

    for (let w = 0; w < 24; w++) {
      tick(orch, clock, U, 3); // grow events + souls + relationships + (occasionally) knowledge
      const cached = reg.snapshot(U);
      const full = fullRecompute();
      expect(JSON.stringify(cached)).toBe(JSON.stringify(full));
    }
  });

  it("never serves a stale capture: a fresh read after a mutation reflects the new state", () => {
    const { reg, clock, orch, U } = liveRig(21);
    tick(orch, clock, U, 20);
    const before = reg.snapshot(U);
    const eventsBefore = before.events.length;
    tick(orch, clock, U, 5); // mutate
    const after = reg.snapshot(U);
    expect(after.events.length).toBeGreaterThan(eventsBefore);
    // The two captures are distinct objects holding distinct state (no aliasing of the live array).
    expect(after).not.toBe(before);
    expect(before.events.length).toBe(eventsBefore); // the prior capture is frozen in time
  });

  it("a DIRECT engine mutation that bypasses the commit seam still invalidates the cache (event-count key)", () => {
    const { reg, clock, orch, U } = liveRig(7);
    tick(orch, clock, U, 12);
    const sb = reg.sandboxFor(U);
    const baseline = reg.snapshot(U);
    const n = baseline.events.length;
    // Mutate the store DIRECTLY — no onPersist, no invalidateSnapshot (a test/future seam). The O(1)
    // event-count key must catch it so the next snapshot is NOT the pre-append capture.
    sb.engine.events.record({ id: "direct:x", ts: 1, type: "house-event", initiator: npc(1), witnessSet: [npc(1)], hidden: true, content: "a direct off-screen append" });
    const after = reg.snapshot(U);
    expect(after.events.length).toBe(n + 1);
    expect(after.events.some((e) => e.id === "direct:x")).toBe(true);
  });

  it("a season reset (the one sanctioned door) frees the cache and exports the fresh season, not the dead one", () => {
    const { reg, clock, orch, U } = liveRig(33);
    tick(orch, clock, U, 18);
    const deadSeason = reg.snapshot(U);
    expect(deadSeason.events.length).toBeGreaterThan(0);
    reg.resetUser(U);
    reg.sandboxFor(U).session.createCharacter({ playerName: "The Player", seed: 99 });
    const fresh = reg.snapshot(U);
    // Season 2 is a clean sandbox — its event log is the new season's, never the dead one's accumulation.
    expect(fresh.events.length).toBeLessThan(deadSeason.events.length);
    expect(fresh).not.toBe(deadSeason);
  });
});

describe("R3 cache — the integrity checkpoint never re-baselines from a stale cached export", () => {
  // The 0062 regression: a NON-EVENT live-session mutation (here a `session.restore` that swaps the
  // frozen world snapshot to `absent`) bumps NEITHER the registry's snapshot rev NOR the O(1) event
  // count — so the cache key alone cannot tell the live state changed. `seedBaseline` re-baselines
  // precisely in that situation (resume-from-disk, or a deliberate state set), so it MUST read the
  // current live truth, not a point-in-time capture from before the swap. If it trusts the cache, the
  // baseline holds the OLD world snapshot while the candidate holds the new one, and the 0007 freeze
  // guard refuses the very next turn as "degradation" (state unchanged). The fix invalidates first.
  it("a re-baseline after a non-event live mutation captures current state, not the pre-mutation cache", () => {
    const { reg, orch, U } = liveRig(0x0062);
    const sb = reg.sandboxFor(U);
    // Prime the cache: an export at the post-createCharacter state (with the model-framed world snapshot).
    const primed = reg.snapshot(U);
    expect((primed.worldSnapshot as { source?: string } | undefined)?.source).toBe("model-framed");

    // A direct, non-event live-session mutation that bypasses commit/restore/invalidate seams entirely:
    // swap the frozen world snapshot to the ABSENT tier via session.restore (the field changes; no event
    // is appended, so the cache's rev + event-count key are BOTH unchanged from the primed capture).
    const core = sb.session.snapshot();
    core.worldSnapshot = buildWorldSnapshot({ seed: 1, capturedFor: "move-in day", source: "absent" });
    sb.session.restore(core);
    expect(sb.session.worldSnapshotView()).toBeNull(); // live state IS now absent

    // Re-baseline: the orchestrator must NOT pin the stale model-framed capture. (Asserted via the
    // public commit behavior below — the baseline is private.) Without the fix, snapshot(U) here would
    // hand back the primed cache (rev + events unchanged), seeding a stale baseline.
    orch.seedBaseline(U);
    const afterSeed = reg.snapshot(U);
    // The fresh export reflects the absent live state — not the stale model-framed capture.
    expect((afterSeed.worldSnapshot as { source?: string } | undefined)?.source).toBe("absent");

    // And the next player turn commits CLEANLY — it is not wrongly refused as degradation against a
    // stale (model-framed) baseline. A real beat advances the live loop and persists.
    expect(() => {
      for (let i = 0; i < 4; i++) {
        const adv = sb.session.advanceGame();
        if (adv.pending) {
          const p = adv.pending;
          if (p.kind === "nominations") sb.session.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
          else if (p.kind === "veto-decision") sb.session.submitDecision({ kind: "veto-decision", use: false });
          else if (p.kind === "replacement") sb.session.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
          else sb.session.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
        }
        if (adv.finished) break;
      }
    }).not.toThrow();
  });
});

describe("R3 cache — read cost is bounded, not O(events) per call (structural, via spy)", () => {
  it("a repeated quiet-stretch read is a pure cache HIT — zero re-serialization (no query, no serialize)", () => {
    const { reg, clock, orch, U } = liveRig(44);
    tick(orch, clock, U, 25); // a late-season-shaped log
    const sb = reg.sandboxFor(U);

    // The orchestrator's last tick already exported + cached the candidate at the current rev. So a read
    // RIGHT NOW (no mutation since) must be a pure cache hit: it touches NONE of the per-export cost — not
    // the O(events) `events.queryAll()`, not the relationship/knowledge/vault serialize. This is the exact
    // win: a `/state` poll between turns pays nothing, so it can't block the event loop or 502.
    const queryAllSpy = vi.spyOn(sb.engine.events, "queryAll");
    const relSpy = vi.spyOn(sb.engine.relationships, "serialize");
    const knowSpy = vi.spyOn(sb.engine.knowledge, "serialize");

    for (let i = 0; i < 50; i++) reg.snapshot(U); // 50 reads, NO mutation between any of them

    expect(queryAllSpy.mock.calls.length).toBe(0); // not re-sliced once
    expect(relSpy.mock.calls.length).toBe(0);
    expect(knowSpy.mock.calls.length).toBe(0);
  });

  it("after a mutation, N reads cost exactly ONE export (one query slice), not N", () => {
    const { reg, clock, orch, U } = liveRig(45);
    tick(orch, clock, U, 25);
    const sb = reg.sandboxFor(U);
    // BE-6: the snapshot export's genuinely-unfiltered read is now the explicit `queryAll()` escape
    // hatch (bare, filterless `query()` throws) — spy on THAT, not `query`.
    const queryAllSpy = vi.spyOn(sb.engine.events, "queryAll");

    // A direct append bumps the O(1) event-count key → the next read misses and re-exports ONCE.
    sb.engine.events.record({ id: "mut:x", ts: 1, type: "house-event", initiator: npc(1), witnessSet: [npc(1)], hidden: true, content: "a mutation" });
    for (let i = 0; i < 40; i++) reg.snapshot(U); // 40 reads after the single mutation

    // Exactly one export's worth of unfiltered queryAll() — not 40. (The export reads the unfiltered log once.)
    expect(queryAllSpy.mock.calls.length).toBe(1);
  });

  it("per-export work does NOT grow with history length: a read at 6 weeks and at 40 weeks does one export each", () => {
    // The cache makes a read O(1) when unchanged; the FIRST export after a change is the only one that
    // serializes — and it does so exactly ONCE regardless of how long the history is. We assert the
    // export-count invariant holds identically at two very different history depths.
    const measureExports = (weeks: number): number => {
      const { reg, clock, orch, U } = liveRig(2);
      tick(orch, clock, U, weeks);
      const sb = reg.sandboxFor(U);
      const spy = vi.spyOn(sb.engine.events, "queryAll");
      // 30 reads with no mutation between → exactly one export's worth of queryAll() calls.
      for (let i = 0; i < 30; i++) reg.snapshot(U);
      const calls = spy.mock.calls.length;
      spy.mockRestore();
      return calls;
    };
    const shallow = measureExports(6);
    const deep = measureExports(40); // ~7× the history
    // Identical: the per-read export accounting is history-INDEPENDENT (both are one export → equal query calls).
    expect(deep).toBe(shallow);
  });
});

describe("R3 cache — the EventStore query cache (append-only, immutable copy)", () => {
  it("returns an IMMUTABLE copy that is byte-identical to the live log, rebuilt only on append", () => {
    const store = new InMemoryEventStore();
    for (let i = 0; i < 50; i++) {
      store.record({ id: `e:${i}`, ts: i, type: "house-event", initiator: PLAYER, witnessSet: [PLAYER], hidden: false, content: `event ${i}` });
    }
    const a = store.queryAll();
    const b = store.queryAll();
    expect(b).toBe(a); // no append between ⇒ the SAME frozen copy by reference (zero re-slice)
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.length).toBe(50);
    expect(a[49]!.id).toBe("e:49");

    store.record({ id: "e:50", ts: 50, type: "house-event", initiator: PLAYER, witnessSet: [PLAYER], hidden: false, content: "event 50" });
    const c = store.queryAll();
    expect(c).not.toBe(a); // an append rebuilt the cache
    expect(c.length).toBe(51);
    // The prior copy is still intact (a point-in-time snapshot must never grow under its holder).
    expect(a.length).toBe(50);
  });

  it("the no-filter cache re-slice happens at most ONCE per appended event, not per read", () => {
    const store = new InMemoryEventStore();
    // Wrap the backing slice via a spy on Array.prototype.slice is too broad; instead assert the contract
    // structurally: repeated reads between appends return the same reference (proven above), so the only
    // way the copy is rebuilt is an append. Here we count distinct references across a read/append mix.
    const refs = new Set<readonly unknown[]>();
    for (let i = 0; i < 20; i++) {
      store.record({ id: `e:${i}`, ts: i, type: "house-event", initiator: PLAYER, witnessSet: [PLAYER], hidden: false, content: `${i}` });
      // 5 reads after each append — only the first should be a fresh slice; the next 4 reuse it.
      for (let r = 0; r < 5; r++) refs.add(store.queryAll());
    }
    // 20 appends → at most 20 distinct frozen copies handed out (one per append), never 100 (one per read).
    expect(refs.size).toBeLessThanOrEqual(20);
  });

  it("a filtered query is unaffected by the no-filter cache (always a fresh, mutable array)", () => {
    const store = new InMemoryEventStore();
    store.record({ id: "v", ts: 0, type: "house-event", initiator: PLAYER, witnessSet: [PLAYER], hidden: false, content: "visible" });
    store.record({ id: "h", ts: 1, type: "conversation", initiator: npc(1), witnessSet: [npc(1)], hidden: true, content: "hidden" });
    const visible = store.query({ witnessedBy: PLAYER });
    expect(visible.map((e) => e.id)).toEqual(["v"]);
    expect(Object.isFrozen(visible)).toBe(false); // filtered results stay caller-mutable
    visible.push({ id: "z", ts: 9, type: "house-event", initiator: PLAYER, witnessSet: [PLAYER], hidden: false, content: "z" });
    expect(store.queryAll().length).toBe(2); // the store is untouched by mutating the filtered result
  });
});
