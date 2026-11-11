import { describe, it, expect, vi } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import type { HealthRecord } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PersistFailureError } from "../../src/domain/errors";
import type { UserSaveStore } from "../../src/ports/UserSaveStore";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * #1106 follow-through — the integrity circuit's SEMANTICS (issue ask (a), audit E7 completed).
 *
 * The breaker (B58/E6) exists to stop off-screen ticks from BLINDLY RETRYING a deterministic
 * state-integrity fault, and it doubles as God Mode's "state corrupted repeatedly" alarm. E7 split
 * `persist-failure` into its own fault class so a disk failure is never misread as degradation —
 * but the breaker still counted BOTH kinds in one streak, so N transient I/O blips lit the same
 * corruption alarm a real degradation burst does. These tests pin the completed split:
 *
 *   - N consecutive persist-failures (clean state, sick disk) NEVER open the circuit — each is
 *     still fail-closed (rolled back, typed, recorded in health);
 *   - a persist blip neither ADVANCES nor RESETS a real corruption streak;
 *   - real corruption still opens the circuit at BREAKER_THRESHOLD, a read-only AUDIT cannot
 *     close it (#1380 review — it compares the rolled-back baseline to itself and proves nothing
 *     about the sandbox's ability to COMMIT), and a clean player-turn commit closes it;
 *   - a SUPPLEMENTARY-TICK save failure is contained: the already-committed player turn STANDS
 *     (no throw, no FE retry bait, no raw ENOSPC path crossing the boundary), the tick rolls back
 *     so memory matches the durable save, and the fault is recorded as persist-failure;
 *   - the recent-fault ring SURVIVES the next clean commit (#1106's forensics were minable only
 *     from stderr; now God Mode's health keeps the capped ring).
 *
 * HARD rule: roles only — no names (the player fixture is the bare role placeholder "P").
 */

/**
 * An in-memory save store whose saves can be made to fail (transient disk trouble). Snapshots are
 * JSON round-tripped on BOTH seams — like the real `FileSaveStore` — so an aliasing bug (a test or
 * the engine mutating a "saved" object in place) cannot hide (#1380 review).
 */
class FlakyStore implements UserSaveStore {
  failing = false;
  calls = 0;
  failAtCall = -1; // exact-call arming (the tick-save containment case)
  private readonly saves = new Map<string, string>();
  saveFor(user: string, snapshot: SessionSnapshot): void {
    this.calls++;
    if (this.failing || this.calls === this.failAtCall) {
      throw new Error("ENOSPC: no space left on device, write '/var/lib/orwell/.orwell-data/x'");
    }
    this.saves.set(user, JSON.stringify(snapshot));
  }
  hasSave(user: string): boolean { return this.saves.has(user); }
  loadLatest(user: string): SessionSnapshot | null {
    const blob = this.saves.get(user);
    return blob === undefined ? null : (JSON.parse(blob) as SessionSnapshot);
  }
}

/** A deep, alias-free capture for FULL-state equality assertions — JSON round-tripped exactly like
 *  the store's own seams, so `toEqual` compares persisted shape to persisted shape. */
const deepCapture = (snap: SessionSnapshot): SessionSnapshot =>
  JSON.parse(JSON.stringify(snap)) as SessionSnapshot;

describe("#1106/E7 — transient persist-failures never open the integrity circuit", () => {
  it("N consecutive disk blips: every commit fail-closed + typed, circuit stays CLOSED, disk recovery commits clean", () => {
    const store = new FlakyStore();
    const runtime = composeRuntime({ saveStore: store, clock: new FakeClock() });
    const user = "disk-trouble";
    const sb = runtime.registry.sandboxFor(user);
    sb.session.createCharacter({ playerName: "P", seed: 3 });
    sb.session.advanceGame(); // one clean beat so a real baseline exists
    // The FULL pre-failure baseline — live in-memory state AND durable save (#1380: every failed
    // call below must leave BOTH deep-equal to this, not merely the same event count).
    const goodMemory = deepCapture(runtime.registry.snapshot(user));
    const goodDurable = store.loadLatest(user)!;
    expect(goodMemory.events.length).toBeGreaterThan(0);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      store.failing = true;
      // FIVE consecutive transient failures — well past BREAKER_THRESHOLD. Each one is fail-closed
      // (the unsaved turn rolls back, typed error out) and recorded — but the CIRCUIT NEVER OPENS:
      // the state passed the checkpoint every time; only the environment failed (E7's split).
      for (let i = 0; i < 5; i++) {
        expect(() =>
          runtime.registry.sandboxFor(user).commands.recordInteraction({
            initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: `doomed chat ${i}`, kind: "bonding",
          }),
        ).toThrowError(PersistFailureError);
        const health = runtime.orchestrator.sandboxHealth(user) as HealthRecord;
        expect(health.circuitOpen).toBe(false); // NEVER opens on transient I/O
        expect(health.lastIntegrity).toBe("fault");
        expect(health.faults.at(-1)!.kind).toBe("persist-failure");
        // Fail-closed held IN FULL on every blip: the WHOLE in-memory state rolled back to the
        // pre-failure baseline, and the durable save was never touched.
        expect(deepCapture(runtime.registry.snapshot(user))).toEqual(goodMemory);
        expect(store.loadLatest(user)!).toEqual(goodDurable);
      }

      // Disk recovers ⇒ the very next turn commits clean — no wedge, no stuck circuit.
      store.failing = false;
      runtime.registry.sandboxFor(user).commands.recordInteraction({
        initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a chat that lands", kind: "bonding",
      });
      const recovered = runtime.orchestrator.sandboxHealth(user) as HealthRecord;
      expect(recovered.lastIntegrity).toBe("ok");
      expect(recovered.circuitOpen).toBe(false);
      // #1106 forensics: the ring RETAINS the blip history across the clean commit (capped).
      expect(recovered.faults.filter((f) => f.kind === "persist-failure").length).toBeGreaterThanOrEqual(5);
      expect(recovered.faults.length).toBeLessThanOrEqual(20);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a persist blip neither ADVANCES nor RESETS a corruption streak; corruption opens at 3; an AUDIT cannot close it; a clean turn can", () => {
    const store = new FlakyStore();
    const runtime = composeRuntime({ saveStore: store, clock: new FakeClock() });
    const user = "mixed-faults";
    const sb = runtime.registry.sandboxFor(user);
    sb.session.createCharacter({ playerName: "P", seed: 4 });
    sb.session.advanceGame();
    const good = runtime.registry.snapshot(user);
    const degraded: SessionSnapshot = { ...good, events: good.events.slice(0, 1) };

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Two REAL degradations — streak 2, circuit still closed.
      for (let i = 0; i < 2; i++) {
        runtime.registry.restore(user, degraded);
        expect(() => runtime.orchestrator.commitPlayerTurn(user)).toThrowError(/turn refused/);
      }
      expect((runtime.orchestrator.sandboxHealth(user) as HealthRecord).circuitOpen).toBe(false);

      // A transient blip on a HEALTHY candidate: does not ADVANCE the streak to 3 (circuit stays
      // closed)…
      runtime.registry.restore(user, good);
      store.failing = true;
      expect(() => runtime.orchestrator.commitPlayerTurn(user)).toThrowError(PersistFailureError);
      store.failing = false;
      expect((runtime.orchestrator.sandboxHealth(user) as HealthRecord).circuitOpen).toBe(false);

      // …and does not RESET it either: the third REAL degradation opens the circuit — the breaker
      // still means what it says about corruption.
      runtime.registry.restore(user, degraded);
      expect(() => runtime.orchestrator.commitPlayerTurn(user)).toThrowError(/turn refused/);
      expect((runtime.orchestrator.sandboxHealth(user) as HealthRecord).circuitOpen).toBe(true);

      // A read-only AUDIT must NOT close it (#1380 review): after the fault's rollback the audit
      // compares the healthy baseline to itself — clean, but ZERO evidence the sandbox can COMMIT.
      // Before the gate, this reset the streak and silently re-enabled off-screen ticks.
      expect(runtime.orchestrator.advance(user, "audit").integrity).toBe("ok");
      expect((runtime.orchestrator.sandboxHealth(user) as HealthRecord).circuitOpen).toBe(true);

      // A clean player-turn COMMIT closes it (recovery unchanged).
      runtime.registry.sandboxFor(user).commands.recordInteraction({
        initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "back on track", kind: "bonding",
      });
      const recovered = runtime.orchestrator.sandboxHealth(user) as HealthRecord;
      expect(recovered.circuitOpen).toBe(false);
      expect(recovered.lastIntegrity).toBe("ok");
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("#1106/E7 — a supplementary-tick save failure is CONTAINED (the committed turn stands)", () => {
  it("turn save lands, tick save fails: no throw, beatSeq advanced durably, memory matches the durable save, persist-failure recorded, circuit closed, next turn clean", () => {
    const store = new FlakyStore();
    const runtime = composeRuntime({ saveStore: store, clock: new FakeClock() });
    const user = "tick-disk";
    const sb = runtime.registry.sandboxFor(user);
    sb.session.createCharacter({ playerName: "P", seed: 5 });
    // Drive until a real pending decision is up — resolving it is a guaranteed BEAT commit (the
    // live loop moves), which is exactly the commit whose supplementary tick we want to sabotage.
    let view = sb.session.advanceGame();
    for (let i = 0; i < 10 && !view.pending; i++) view = sb.session.advanceGame();
    // ORW-232 slice 3: a commit inside a running competition earns no off-screen tick (everyone is out in it), so the commit whose tick we sabotage must be a NON-competition decision:
    // play the competition's approach and rounds through, then take the first ceremony decision.
    for (let i = 0; i < 40 && (!view.pending || view.pending.kind === "comp-round" || view.pending.kind === "comp-intent"); i++) {
      if (view.pending) sb.session.submitDecision({ kind: view.pending.kind, intent: "compete" } as never);
      view = sb.session.advanceGame();
    }
    expect(view.pending).toBeTruthy();
    const pending = view.pending!;
    // #1380: the discriminator between "the player turn STOOD and only the tick rolled back" and
    // "both rolled back" is the beat counter — the turn's commit bumps it exactly once (the tick
    // never routes through the commit funnel), and the bumped value must reach the DURABLE save.
    const beatSeqBefore = runtime.registry.snapshot(user).beatSeq!;

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Arm the SECOND save of the next beat commit: save #1 is the player turn's (must land),
      // save #2 is the supplementary off-screen tick's (made to fail).
      store.failAtCall = store.calls + 2;
      // Before the guard, this THREW the raw ENOSPC error (path and all) out of a request whose
      // player turn had ALREADY durably committed — an unclassified failure inviting an FE retry
      // of a landed turn. Now the tick fails closed on its own; the request succeeds.
      expect(() => runtime.registry.sandboxFor(user).session.submitDecision(
        pending.kind === "nominations"
          ? { kind: "nominations", choice: [pending.options[0]!.id, pending.options[1]!.id] }
          : { kind: pending.kind, intent: "compete", vote: pending.options?.[0]?.id ?? "" },
      )).not.toThrow();
      expect(store.calls).toBeGreaterThanOrEqual(store.failAtCall); // the tick save WAS attempted

      // The player turn STANDS — durably: the committed beatSeq (+1, exactly one commit) reached
      // disk. The tick rolled back, so memory and disk agree on the WHOLE state, deep-equal.
      const durable = store.loadLatest(user)!;
      expect(durable.beatSeq).toBe(beatSeqBefore + 1);
      expect(deepCapture(runtime.registry.snapshot(user))).toEqual(durable);

      // The blip is VISIBLE (persist-failure in the ring) but the turn's health verdict is ok and
      // the corruption circuit never opened (E7: environmental, not degradation).
      const health = runtime.orchestrator.sandboxHealth(user) as HealthRecord;
      expect(health.lastIntegrity).toBe("ok"); // the player turn had the last word
      expect(health.circuitOpen).toBe(false);
      expect(health.faults.some((f) => f.kind === "persist-failure")).toBe(true);
      expect(health.faults.some((f) => f.kind === "degradation")).toBe(false);

      // Self-heals: the next beat commits AND ticks clean; the durable save advances again.
      const durableEventsBefore = durable.events.length;
      runtime.registry.sandboxFor(user).session.advanceGame();
      expect((runtime.orchestrator.sandboxHealth(user) as HealthRecord).lastIntegrity).toBe("ok");
      expect(store.loadLatest(user)!.events.length).toBeGreaterThan(durableEventsBefore);
    } finally {
      errSpy.mockRestore();
    }
  });
});
