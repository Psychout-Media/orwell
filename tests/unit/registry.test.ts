import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { SoulStore } from "../../src/adapters/engine/SoulStore";
import { npc } from "../../src/domain/ids";
import type { UserSaveStore } from "../../src/ports/UserSaveStore";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

describe("0021 — per-user game sandboxes", () => {
  it("creates one isolated sandbox per user, resumed on return", () => {
    const reg = new GameSessionRegistry();
    const a1 = reg.sandboxFor("A");
    const a2 = reg.sandboxFor("A");
    expect(a1).toBe(a2); // same ongoing sandbox on return
    expect(reg.sandboxFor("B")).not.toBe(a1); // a different user → a different sandbox
    expect(reg.userCount()).toBe(2);
  });

  it("isolates games across users — distinct houses, no shared state", () => {
    const reg = new GameSessionRegistry();
    reg.sandboxFor("A").session.createCharacter({ playerName: "Player A", seed: 1 });
    reg.sandboxFor("B").session.createCharacter({ playerName: "Player B", seed: 2 });
    const a = reg.sandboxFor("A").session.getGameState();
    const b = reg.sandboxFor("B").session.getGameState();
    expect(a.player!.name).toBe("Player A");
    expect(b.player!.name).toBe("Player B");
    const aNames = new Set(a.house.map((h) => h.name));
    expect(b.house.some((h) => !aNames.has(h.name))).toBe(true);
  });

  it("a new game replaces only that user's sandbox", () => {
    const reg = new GameSessionRegistry();
    reg.sandboxFor("A").session.createCharacter({ playerName: "Player A", seed: 1 });
    const bBefore = reg.sandboxFor("B");
    bBefore.session.createCharacter({ playerName: "Player B", seed: 2 });
    const replaced = reg.resetUser("A");
    expect(replaced).not.toBe(undefined);
    expect(reg.sandboxFor("A")).toBe(replaced); // A replaced
    expect(reg.sandboxFor("B")).toBe(bBefore);  // B untouched
  });

  it("cross-user isolation: A's data never appears in B's sandbox", () => {
    const reg = new GameSessionRegistry();
    const a = reg.sandboxFor("A");
    a.session.createCharacter({ playerName: "PlayerA-SENTINEL", seed: 11 });
    a.engine.vault.writeHidden({ id: "v", kind: "hidden-thread", content: "A-SECRET" });
    const b = reg.sandboxFor("B");
    b.session.createCharacter({ playerName: "Player B", seed: 22 });
    const bView = JSON.stringify(b.session.getGameState());
    expect(bView.includes("PlayerA-SENTINEL")).toBe(false);
    expect(bView.includes("A-SECRET")).toBe(false);
    // B's vault is its own — A's secret is not in it.
    expect(b.engine.vault.readHidden().some((r) => r.content.includes("A-SECRET"))).toBe(false);
  });
});

/** A minimal in-memory durable store (FORMAT only — real snapshots, no canned content). */
function memorySaveStore(): UserSaveStore & { snaps: Map<string, SessionSnapshot> } {
  const snaps = new Map<string, SessionSnapshot>();
  return {
    snaps,
    saveFor: (u, s) => { snaps.set(u, s); },
    hasSave: (u) => snaps.has(u),
    loadLatest: (u) => snaps.get(u) ?? null,
  };
}

describe("G12 — dropping/replacing a sandbox discards its queued soul-index work", () => {
  // The breathing lane is process-wide (G12). Drain it BEFORE each test too: an EARLIER describe
  // block (with no lane hygiene) now leaves a creation-time backlog on the shared lane (0058 seeds
  // each NPC's deep-profile recall index at createCharacter), so the absolute pendingTotal() checks
  // below must start from a known-empty lane regardless of what ran first.
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 5_000 && SoulStore.pendingTotal() > 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(SoulStore.pendingTotal()).toBe(0);
  };
  beforeEach(drain);
  // The breathing lane is process-wide (G12): leave it empty for whoever runs next.
  afterEach(drain);

  /** Put a live (queued, not-yet-embedded) backlog on the sandbox's soul store — the state any
   *  burst site (fold, confessional, off-screen scene) leaves behind mid-drain (G8). 0058 now seeds
   *  each NPC's deep-profile authored detail into the soul at createCharacter (full-fidelity recall,
   *  L27b), so the store ALREADY carries a creation-time backlog; discard it first so this helper
   *  measures exactly the `n` it deliberately seeds (the same lane-hygiene the afterEach performs). */
  function seedBacklog(reg: GameSessionRegistry, user: string, n: number): SoulStore {
    const soul = reg.sandboxFor(user).engine.soul as SoulStore;
    soul.discardPending(); // drop the 0058 creation-time deep-profile index backlog
    for (let i = 0; i < n; i++) soul.recordToSoul(npc(1), `a consequential beat ${i}`);
    expect(soul.pendingCount()).toBe(n); // queued on the breathing lane, never inline
    return soul;
  }

  it("resetUser drops the dead season's backlog from the shared lane (and tolerates an unknown user)", () => {
    const reg = new GameSessionRegistry();
    reg.sandboxFor("A").session.createCharacter({ playerName: "Player A", seed: 1 });
    const deadSoul = seedBacklog(reg, "A", 4);
    reg.resetUser("A");
    expect(deadSoul.pendingCount()).toBe(0); // the dead season's derived work died with it
    expect(SoulStore.pendingTotal()).toBe(0); // …and the fresh (pre-game) sandbox queued nothing
    expect(() => reg.resetUser("never-seen")).not.toThrow(); // no sandbox yet — nothing to discard
  });

  it("a rollback restore() discards the aborted graph's backlog; the rebuild re-floods breathing", () => {
    const reg = new GameSessionRegistry();
    reg.sandboxFor("A").session.createCharacter({ playerName: "Player A", seed: 3 });
    const snap = reg.snapshot("A");
    // The snapshot carries a deepened arc (0030): its resume MUST re-derive the index, breathing.
    snap.house!.npcs[0]!.soul.memory.push("a season arc note", "another arc inflection");
    const aborted = seedBacklog(reg, "A", 3);
    const rebuilt = reg.restore("A", snap);
    expect(aborted.pendingCount()).toBe(0); // the rolled-back graph's queue died with it
    const rebuiltSoul = rebuilt.engine.soul as SoulStore;
    expect(rebuiltSoul.pendingCount()).toBeGreaterThan(0);             // rebuildSoulIndex queued…
    expect(SoulStore.pendingTotal()).toBe(rebuiltSoul.pendingCount()); // …and ONLY the live graph is on the lane
    // A user with no live sandbox restores cleanly too (the rollback path's first touch).
    const reg2 = new GameSessionRegistry();
    expect(() => reg2.restore("fresh", snap)).not.toThrow();
    (reg2.sandboxFor("fresh").engine.soul as SoulStore).discardPending(); // keep the lane clean for afterEach
  });

  it("the LRU unload parks the sandbox and drops its backlog (the resume re-derives the index)", () => {
    const store = memorySaveStore();
    const reg = new GameSessionRegistry(store, { maxResident: 1 });
    reg.sandboxFor("A").session.createCharacter({ playerName: "Player A", seed: 5 });
    const parkedSoul = seedBacklog(reg, "A", 4);
    reg.sandboxFor("B"); // a second resident → A is least-recently-used → parked to disk
    expect(store.hasSave("A")).toBe(true); // the authoritative state was saved first…
    expect(parkedSoul.pendingCount()).toBe(0); // …then the derived backlog died with the graph
    expect(SoulStore.pendingTotal()).toBe(0);
  });

  it("a user's God-Mode behavioral-flag dial survives an LRU unload/resume and a rollback restore, and stays per-user (#1925)", () => {
    const store = memorySaveStore();
    const reg = new GameSessionRegistry(store, { maxResident: 1 });
    const defaults = reg.sandboxFor("fresh").admin.behavioralFlags(); // the env default, whatever it is
    reg.sandboxFor("A").session.createCharacter({ playerName: "Player A", seed: 5 });
    const flipped = {
      campaigns: !defaults.campaigns, trajectories: !defaults.trajectories, triggers: !defaults.triggers,
      secretPacing: !defaults.secretPacing, juryHouse: !defaults.juryHouse,
      seededTieSurfacing: !defaults.seededTieSurfacing, mythMaking: !defaults.mythMaking, showrunner: !defaults.showrunner,
    };
    reg.sandboxFor("A").admin.setBehavioralFlags(flipped);

    reg.sandboxFor("B"); // a second resident → A is least-recently-used → saved and dropped from memory
    expect(store.hasSave("A")).toBe(true);
    expect(reg.sandboxFor("A").admin.behavioralFlags(), "the resumed sandbox keeps the dial").toEqual(flipped);
    expect(reg.sandboxFor("B").admin.behavioralFlags(), "user B never inherits user A's dial").toEqual(defaults);

    reg.restore("A", store.snaps.get("A")!); // a rollback rebuilds A's sandbox from a snapshot
    expect(reg.sandboxFor("A").admin.behavioralFlags(), "the restored sandbox keeps the dial").toEqual(flipped);
  });

  it("a refused resume (corrupt save) discards the half-restored graph's flood with it", () => {
    const store = memorySaveStore();
    const reg = new GameSessionRegistry(store);
    reg.sandboxFor("A").session.createCharacter({ playerName: "Player A", seed: 7 });
    // 0058 seeds the deep-profile recall index at createCharacter; discard that creation backlog so
    // this test measures ONLY the corrupt-resume flood it sets up below (the global lane is shared).
    (reg.sandboxFor("A").engine.soul as SoulStore).discardPending();
    const saved = store.snaps.get("A")!;
    // The save genuinely carries soul memories — the resume's rebuildSoulIndex WILL flood the lane —
    // and is corrupted PAST the session-restore step, so the import throws AFTER the flood.
    saved.house!.npcs[0]!.soul.memory.push("a season arc note", "another arc inflection");
    store.snaps.set("A", { ...saved, events: null as unknown as SessionSnapshot["events"] });
    const reg2 = new GameSessionRegistry(store);
    const sb = reg2.sandboxFor("A"); // tolerant load: rejects into a fresh sandbox (B40/B35)
    expect(sb.session.getGameState().started).toBe(false);
    expect(SoulStore.pendingTotal()).toBe(0); // the dead flood was discarded, not left to drain
  });
});
