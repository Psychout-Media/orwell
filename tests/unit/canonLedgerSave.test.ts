import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyCanonLedger, recordCanon, retireCanon, serializeCanon, type CanonPolicy } from "../../src/engine/canonLedger";
import type { CanonProposal, PersistedCanon } from "../../src/domain/canon";
import { sessionCoreIsSuperset } from "../../src/engine/sessionSnapshot";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import type { UserSaveStore } from "../../src/ports/UserSaveStore";

/**
 * Showrunner memory, Phase 2 (K4 §2.5): the canon ledger rides in the save file, and the save-state
 * non-degradation check guards it. Canon is never deleted: an entry may not disappear, its words and provenance
 * never change, and only its status (forward, out of `active`) and reference counters (never back) may move.
 * Without the check, the first checkpoint after the field appears could refuse a player turn as "degradation"
 * (the 2026-07-13 deadlock class), or a save could thin the ledger unseen.
 *
 * Nothing writes canon yet (the FE write-back is the next PR), so a game with no canon saves exactly as before.
 * A restart is a fresh registry over the SAME durable store (0030). Roles only, no names.
 */

const policy: CanonPolicy = {
  leaksVault: () => false,
  forbiddenTerm: () => undefined,
  propCategoriesFor: () => ["drinkware", "book-magazine"],
  isHouseguest: (id) => /^npc:\d+$/.test(id),
};
const proposal = (over: Partial<CanonProposal> = {}): CanonProposal => ({
  text: "calls the hot tub 'the soup pot'", category: "nickname", scope: { kind: "houseguest", id: "npc:1" },
  speaker: "npc:1", witnesses: ["player", "npc:1"], room: "backyard",
  quote: "Last one in the soup pot buys dinner.", confidence: 0.9, ...over,
});
let key = 0;
const NICKNAMES = ["the office", "the den", "the nest", "the porch"]; // words, not digits: a number is engine-only
/** A real ledger with `n` recorded details, made by the engine's own write path (one scene each, within budget). */
function ledgerWith(n: number) {
  let ledger = emptyCanonLedger();
  for (let i = 0; i < n; i++) {
    const nick = NICKNAMES[i]!;
    ledger = recordCanon(ledger, {
      turn: 3 + i, beatSeq: 40 + i, sceneKey: `${3 + i}`, idempotencyKey: `s:${++key}`,
      proposals: [proposal({ text: `calls the hammock '${nick}'`, quote: `Meet me at ${nick}.` })],
    }, policy).ledger;
  }
  expect(ledger.entries).toHaveLength(n);
  return ledger;
}
const canonOf = (n: number): PersistedCanon => serializeCanon(ledgerWith(n));

function baseSnap(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { started: true, week: 3, phase: "livefeed", ceremony: { nominees: [], vetoUsed: false }, house: null,
    events: [], relationships: [], ...overrides };
}

describe("the superset rule guards the ledger (K4 §2.5)", () => {
  it("a pre-feature save growing its first canon passes; a later save that lost the whole ledger is caught", () => {
    expect(sessionCoreIsSuperset(baseSnap({ canon: canonOf(1) }), baseSnap())).toBe(true);
    expect(sessionCoreIsSuperset(baseSnap(), baseSnap({ canon: canonOf(1) }))).toBe(false);
    expect(sessionCoreIsSuperset(baseSnap(), baseSnap())).toBe(true);
  });

  it("growth passes; a removed entry is caught", () => {
    const two = canonOf(2);
    expect(sessionCoreIsSuperset(baseSnap({ canon: two }), baseSnap({ canon: { ...two, entries: two.entries.slice(0, 1) } }))).toBe(true);
    expect(sessionCoreIsSuperset(baseSnap({ canon: { ...two, entries: two.entries.slice(1) } }), baseSnap({ canon: two }))).toBe(false);
  });

  it("a changed word or provenance is caught; a status moving out of active and counters going up pass", () => {
    const before = canonOf(1);
    const e = before.entries[0]!;
    const reworded = { ...before, entries: [{ ...e, text: "calls the hammock 'the bunk'" }] };
    const moved = { ...before, entries: [{ ...e, provenance: { ...e.provenance, room: "kitchen" as const } }] };
    expect(sessionCoreIsSuperset(baseSnap({ canon: reworded }), baseSnap({ canon: before }))).toBe(false);
    expect(sessionCoreIsSuperset(baseSnap({ canon: moved }), baseSnap({ canon: before }))).toBe(false);

    const retired = retireCanon(ledgerWith(1), e.id);
    expect(retired.ok).toBe(true);
    const referenced = { ...before, entries: [{ ...e, referenceCount: e.referenceCount + 2, lastReferencedBeatSeq: e.lastReferencedBeatSeq + 5 }] };
    expect(sessionCoreIsSuperset(baseSnap({ canon: serializeCanon(retired.ledger!) }), baseSnap({ canon: before }))).toBe(true);
    expect(sessionCoreIsSuperset(baseSnap({ canon: referenced }), baseSnap({ canon: before }))).toBe(true);
    // ...and never back: a counter going down, or a retired entry made active again, is caught.
    expect(sessionCoreIsSuperset(baseSnap({ canon: before }), baseSnap({ canon: referenced }))).toBe(false);
    expect(sessionCoreIsSuperset(baseSnap({ canon: before }), baseSnap({ canon: serializeCanon(retired.ledger!) }))).toBe(false);
  });

  it("is wired into Orchestrator.checkpoint: a thinned ledger is a degradation fault; growth passes clean", () => {
    const registry = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-canon-save-"))));
    const orch = new Orchestrator(registry, new FakeClock(), { seed: 21 });
    const sandbox = registry.sandboxFor("u");
    const two = canonOf(2);
    const one = { ...two, entries: two.entries.slice(0, 1) };
    const thinned = orch.checkpoint(baseSnap({ canon: two }), baseSnap({ canon: one }), sandbox, "audit", { requireDailyEvent: false });
    expect(thinned.some((f) => f.kind === "degradation")).toBe(true);
    expect(orch.checkpoint(baseSnap({ canon: one }), baseSnap({ canon: two }), sandbox, "audit", { requireDailyEvent: false })).toEqual([]);
  });
});

// ── the save file: restart-safe, byte-stable, never silently thinned ───────────────────────────────────────────

class MemoryStore implements UserSaveStore {
  readonly saved = new Map<string, SessionSnapshot[]>();
  saveFor(user: string, s: SessionSnapshot): void { this.saved.set(user, [...(this.saved.get(user) ?? []), s]); }
  hasSave(user: string): boolean { return (this.saved.get(user)?.length ?? 0) > 0; }
  loadLatest(user: string): SessionSnapshot | null { const l = this.saved.get(user); return l?.length ? l[l.length - 1]! : null; }
  /** Stand in for a save that already carries canon (a later build's write-back), as a restart would find it. */
  plant(user: string, canon: unknown): void {
    const latest = JSON.parse(JSON.stringify(this.loadLatest(user))) as SessionSnapshot;
    (latest as { canon?: unknown }).canon = canon;
    this.saveFor(user, latest);
  }
}

function startedGame(user: string, seed: number) {
  const store = new MemoryStore();
  const reg = new GameSessionRegistry(store);
  new Orchestrator(reg, { now: () => seed }, { seed });
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return { store, reg, sb };
}

function restart(store: MemoryStore, user: string, seed: number) {
  const reg = new GameSessionRegistry(store);
  new Orchestrator(reg, { now: () => seed }, { seed });
  return { reg, sb: reg.sandboxFor(user) };
}

describe("the canon ledger rides in the save file", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a game that recorded no canon saves exactly as before: no canon key at all", () => {
    const { reg, store } = startedGame("canon-none", 5101);
    expect("canon" in reg.snapshot("canon-none")).toBe(false);
    expect("canon" in store.loadLatest("canon-none")!).toBe(false);
  });

  it("a save carrying canon survives a restart byte-stable, and the next committed turn is not refused", async () => {
    const user = "canon-restart";
    const { store } = startedGame(user, 5102);
    const canon = canonOf(2);
    store.plant(user, canon);

    const { reg, sb } = restart(store, user, 5102);
    expect(reg.snapshot(user).canon).toEqual(canon);

    // The first committed turn after the restart runs the integrity checkpoint with the ledger in both its baseline
    // and its candidate: it must commit (not be refused as "degradation") and save the ledger again, unchanged.
    const before = sb.session.gameStatus().beatSeq;
    const savesBefore = store.saved.get(user)!.length;
    // A player message step is one committed mutation through the single funnel (0065 Part A).
    const noted = (await sb.mcp.player.callTool("noteMessage", { messageId: "turn-after-restart" })) as { accepted: boolean };
    expect(noted.accepted).toBe(true);
    expect(sb.session.gameStatus().beatSeq).toBe(before + 1);
    expect(store.saved.get(user)!.length).toBeGreaterThan(savesBefore);
    expect(store.loadLatest(user)!.canon).toEqual(canon);
  });

  it("a save whose canon cannot be read is kept byte-for-byte and reported, never silently thinned", async () => {
    const user = "canon-malformed";
    const { store } = startedGame(user, 5103);
    const good = canonOf(1);
    const raw = { ...good, entries: [...good.entries, { id: "canon:2", text: "" }] }; // one entry fails the shape check
    store.plant(user, raw);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { reg, sb } = restart(store, user, 5103);
    expect(reg.snapshot(user).canon).toEqual(raw);
    expect(warn.mock.calls.some((c) => c.map(String).join(" ").includes("canon"))).toBe(true);
    // The warning names problems only, never a recorded word.
    expect(warn.mock.calls.some((c) => c.map(String).join(" ").includes("the office"))).toBe(false);

    const savesBefore = store.saved.get(user)!.length;
    await sb.mcp.player.callTool("noteMessage", { messageId: "turn-after-restart" });
    expect(store.saved.get(user)!.length).toBeGreaterThan(savesBefore);
    expect(store.loadLatest(user)!.canon).toEqual(raw);
  });
});
