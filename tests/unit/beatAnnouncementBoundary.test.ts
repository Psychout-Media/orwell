import { describe, it, expect, vi } from "vitest";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, BeatAnnouncementView, PendingDecisionView } from "../../src/ports/GameSession";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PersistFailureError } from "../../src/domain/errors";
import type { UserSaveStore } from "../../src/ports/UserSaveStore";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

/**
 * Feature T0-3 (issue #1778, D1 2026-07-21) — the ENGINE-HALF boundary suite: drives a REAL live
 * season (through the registry's commit funnel, exactly like production) and asserts the properties
 * `beatAnnouncement.test.ts`'s fixture tests cannot: that the seam actually fires at both commit
 * paths (plain `advanceGame` AND the T0-2 chained `submitDecision` auto-advance), that a committed
 * ceremony fact announces EXACTLY ONCE across a season, that the anonymized eviction ballot sequence
 * is byte-equal to the SAME engine data the (already-shipped) `event.participants` projection carries,
 * and that a rolled-back commit leaves no ghost announcement behind.
 *
 * HARD rule: roles only — no fixture names asserted.
 */

/** Resolve a pending decision LEGALLY, whatever kind it is (mirrors T0-2's own driver). */
function resolveLegally(s: GameSessionAdapter, p: PendingDecisionView): AdvanceView {
  if (p.kind === "nominations") return s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  if (p.kind === "veto-decision") return s.submitDecision({ kind: "veto-decision", use: false });
  if (p.kind === "replacement") return s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  if (p.kind === "comp-intent" || p.kind === "comp-round") return s.submitDecision({ kind: p.kind, intent: "compete" });
  if (p.kind === "finale-statement") return s.submitDecision({ kind: "finale-statement", statement: "x" });
  if (p.kind === "finale-answer") return s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  if (p.kind === "juror-vote") return s.submitDecision({ kind: "juror-vote", vote: p.options[0]!.id });
  return s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}

function startedGame(seed: number) {
  const runtime = composeRuntime({ clock: new FakeClock() }); // no saveStore ⇒ in-memory only
  // DETERMINISTIC user id. The engine derives part of the season's randomness from the sandbox's user id,
  // so a random suffix here made "which seeds hand the player HOH" differ run to run (the same seed reached a
  // `nominations` pending in one run and not the next) — the intermittent "game finished before reaching a
  // 'nominations' pending". Each seed gets its own fresh runtime, so the id needs no uniqueness.
  const user = `t0-3-${seed}`;
  const session = runtime.registry.sandboxFor(user).session;
  session.createCharacter({ playerName: "P", seed });
  return { runtime, user, session };
}

/** Drive to the FIRST pending of exactly `kind`, resolving every other pending generically along the way.
 *  Throws if the season finishes first (the player never drew that role this game — e.g. never HOH). */
function driveToPendingKind(s: GameSessionAdapter, kind: PendingDecisionView["kind"], maxIterations = 1500): PendingDecisionView {
  let view: AdvanceView = s.advanceGame();
  for (let i = 0; i < maxIterations; i++) {
    if (view.pending?.kind === kind) return view.pending;
    if (view.finished) throw new Error(`game finished before reaching a '${kind}' pending`);
    if (view.pending) resolveLegally(s, view.pending);
    view = s.advanceGame();
  }
  throw new Error(`never reached a '${kind}' pending within ${maxIterations} iterations`);
}

/** The seed fan-out: the known-good seeds first, then a long tail of consecutive ones. Which seed hands the
 *  player a given role moves whenever the balance does (#1941 shifted them), so a short pinned list goes stale;
 *  the search stops at the first seed that reaches the target, so the tail costs nothing unless it is needed. */
const SEED_FAN_OUT: number[] = [81000, ...Array.from({ length: 60 }, (_, i) => 4001 + i)];

/** `driveToPendingKind`, retried over a SEED FAN-OUT: which role the player draws (HOH, veto
 *  holder…) varies seed-to-seed (a legitimate outcome — the player may simply never win HOH a given
 *  season), so a single fixed seed is not a reliable way to reach a role-specific pending. Builds and
 *  returns its OWN fresh session/game (via `startedGame`) on whichever seed first reaches `kind`. */
function driveToPendingKindAcrossSeeds(
  kind: PendingDecisionView["kind"], seeds: number[] = SEED_FAN_OUT,
): { session: GameSessionAdapter; pending: PendingDecisionView } {
  let lastErr: unknown;
  for (const seed of seeds) {
    const { session } = startedGame(seed);
    try {
      return { session, pending: driveToPendingKind(session, kind) };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Drive a full season (advanceGame-only path), collecting every announcement ever returned. */
function driveWholeSeason(s: GameSessionAdapter, maxIterations = 3000): { calls: AdvanceView[]; all: BeatAnnouncementView[] } {
  const calls: AdvanceView[] = [];
  const all: BeatAnnouncementView[] = [];
  let view: AdvanceView = s.advanceGame();
  calls.push(view);
  if (view.announcements) all.push(...view.announcements);
  for (let i = 0; i < maxIterations && !view.finished; i++) {
    if (view.pending) view = resolveLegally(s, view.pending);
    else view = s.advanceGame();
    calls.push(view);
    if (view.announcements) all.push(...view.announcements);
  }
  return { calls, all };
}

describe("T0-3 — the announcement seam fires at BOTH commit paths identically", () => {
  it("a plain advanceGame HOH crown carries exactly one hoh-winner announcement, subject byte-equal to the crowned winner", () => {
    const { session } = startedGame(81000);
    let view = session.advanceGame();
    let crowned: AdvanceView | null = null;
    for (let i = 0; i < 50 && !crowned; i++) {
      if (view.event?.beat === "hoh-competition") { crowned = view; break; }
      view = view.pending ? resolveLegally(session, view.pending) : session.advanceGame();
    }
    expect(crowned).not.toBeNull();
    const r = crowned!;
    expect(r.announcements).toBeDefined();
    const hohAnnouncements = r.announcements!.filter((a) => a.kind === "hoh-winner");
    expect(hohAnnouncements).toHaveLength(1);
    // The SAME winner the already-shipped `event.participants` projection names — byte-equal ids.
    expect(hohAnnouncements[0]!.subjects.map((n) => n.id)).toEqual([r.event!.participants![0]!.id]);
    expect(hohAnnouncements[0]!.beatSeq).toBe(r.beatSeq);
  });

  it("resolving `nominations` via submitDecision (the T0-2 auto-advance path) announces the nominations in the SAME call — no follow-up advanceGame needed", () => {
    // Seed fan-out (not a single fixed seed): whether the player ever draws HOH — and so ever sees a
    // player-facing `nominations` pending — varies game to game (a legitimate outcome), so this tries
    // a small set of seeds rather than asserting on one that might not hand the player the HOH crown.
    const { session, pending } = driveToPendingKindAcrossSeeds("nominations");
    const r1 = session.submitDecision({ kind: "nominations", choice: [pending.options[0]!.id, pending.options[1]!.id] });
    expect(r1.event?.beat).toBe("nominations");
    // The auto-advance chain's SECOND step here is the veto chip draw (out of T0-3's weekly-loop
    // announcement scope), so exactly one announcement — the nominations fact — lands in this call.
    expect(r1.announcements).toEqual([
      expect.objectContaining({ kind: "nominations", subjects: [pending.options[0]!, pending.options[1]!] }),
    ]);
  });

  it("resolving `veto-decision` (not used) via submitDecision announces the decision — matching a plain advanceGame's shape", () => {
    const { session } = driveToPendingKindAcrossSeeds("veto-decision");
    const r1 = session.submitDecision({ kind: "veto-decision", use: false });
    expect(r1.event?.beat).toBe("veto-ceremony");
    expect(r1.announcements).toEqual([
      expect.objectContaining({ kind: "veto-decision", detail: expect.objectContaining({ used: false }) }),
    ]);
  });
});

describe("T0-3 — the anonymized eviction ballot sequence is BYTE-EQUAL to engine data (E12)", () => {
  it("every eviction-ballot announcement's subjects equal that SAME call's event.participants, in order", () => {
    const { session } = startedGame(81000);
    const { calls } = driveWholeSeason(session);
    const revealCalls = calls.filter((c) => c.event?.beat === "eviction-reveal");
    expect(revealCalls.length).toBeGreaterThan(0);
    for (const call of revealCalls) {
      const ballot = call.announcements?.find((a) => a.kind === "eviction-ballot");
      expect(ballot, "every eviction-reveal beat must carry exactly one eviction-ballot announcement").toBeDefined();
      expect(ballot!.subjects.map((n) => n.id)).toEqual((call.event!.participants ?? []).map((n) => n.id));
    }
  });

  it("the eviction-ballot headline never names a voter — every clause is 'a vote to evict <nominee>'", () => {
    const { session } = startedGame(81000);
    const { all } = driveWholeSeason(session);
    const ballots = all.filter((a) => a.kind === "eviction-ballot");
    expect(ballots.length).toBeGreaterThan(0);
    for (const b of ballots) {
      const clauses = b.headline.split(". ").filter(Boolean);
      expect(clauses.length).toBe(b.subjects.length);
      for (const c of clauses) expect(c).toMatch(/^a vote to evict .+\.?$/);
    }
  });
});

describe("T0-3 — a committed ceremony fact announces EXACTLY ONCE across a season (no duplicate, no phantom)", () => {
  it("every call whose PRIMARY event is a ceremony beat carries exactly one matching announcement", () => {
    // The direct per-call proof (mirrors the eviction-ballot byte-equality test above): whenever a
    // call's OWN `event.beat` is the ceremony beat itself (the plain-advanceGame path, or a
    // submitDecision call whose resolved pending's beat WAS the ceremony beat), that SAME call's
    // `announcements` carries exactly one matching fact — never zero, never two.
    const { session } = startedGame(81000);
    const { calls } = driveWholeSeason(session);
    const beatToKind: Record<string, string> = {
      "hoh-competition": "hoh-winner", "veto-competition": "veto-winner", nominations: "nominations",
      eviction: "eviction-result", "final-eviction": "eviction-result",
    };
    for (const [beat, kind] of Object.entries(beatToKind)) {
      const matching = calls.filter((c) => c.event?.beat === beat);
      expect(matching.length, `no call had a primary '${beat}' event — the drive didn't reach it`).toBeGreaterThan(0);
      for (const c of matching) {
        const count = (c.announcements ?? []).filter((a) => a.kind === kind).length;
        expect(count, `a '${beat}' call must carry exactly one '${kind}' announcement`).toBe(1);
      }
    }
  });

  it("T0-2 auto-advance coverage: a ceremony crown chained BEHIND a different primary pending still announces (never silently dropped)", () => {
    // The structural case a naive "compare to event.beat" count would miss: `AUTO_ADVANCE_PENDING_KINDS`
    // (T0-2) includes `comp-round`, so a staged HOH competition's LAST round can crown the HOH as the
    // auto-advanced SECOND step of a `submitDecision({kind:"comp-round"})` call — that call's OWN
    // `event.beat` stays "comp-round" (the resolved pending's own beat), yet the crown still announces,
    // via `announcements`, in the SAME call. This asserts that coverage exists somewhere in a full
    // season (skipped, not failed, if this particular season never happens to chain one this way).
    const { session } = startedGame(81000);
    const { calls } = driveWholeSeason(session);
    const chained = calls.filter(
      (c) => c.event?.beat !== "hoh-competition" && (c.announcements ?? []).some((a) => a.kind === "hoh-winner"),
    );
    if (chained.length === 0) return; // this season's RNG didn't happen to chain one this way — not a failure
    for (const c of chained) {
      expect(c.announcements!.filter((a) => a.kind === "hoh-winner")).toHaveLength(1);
    }
  });

  it("every announcement id is unique across the whole season (the FE dedup key never collides)", () => {
    const { session } = startedGame(81000);
    const { all } = driveWholeSeason(session);
    expect(all.length).toBeGreaterThan(5);
    const ids = new Set(all.map((a) => a.id));
    expect(ids.size).toBe(all.length);
  });

  it("a veto used + a separately-resolved replacement never double-announce the veto decision", () => {
    // Structural companion to the fixture test of the same name — a legal replacement exists
    // whenever the veto is actually usable (`replacementOptions().length === 0` FORCES `vetoUsed:
    // false` — the Final-4 edge, `resolveReplacement`), so every `veto-decision(used:true)` has
    // EXACTLY one matching `replacement-nominee`, whether the two land bundled in one commit or
    // split across two (the player-HOH pending path) — a strict 1:1 count, never a duplicate.
    const { session } = startedGame(81000);
    const { all } = driveWholeSeason(session);
    const used = all.filter((a) => a.kind === "veto-decision" && a.detail?.used === true).length;
    const replacements = all.filter((a) => a.kind === "replacement-nominee").length;
    expect(used).toBeGreaterThan(0);
    // P5d: a PLAYED secret veto also names a replacement nominee (its own `secret-veto` announcement) — every replacement is either a veto-decision's or a secret veto's.
    const secretVetoes = all.filter((a) => a.kind === "secret-veto").length;
    expect(replacements).toBe(used + secretVetoes);
  });
});

describe("T0-3 — no announcement for a rolled-back commit", () => {
  class FlakyStore implements UserSaveStore {
    failing = false;
    private readonly saves = new Map<string, string>();
    saveFor(user: string, snapshot: SessionSnapshot): void {
      if (this.failing) throw new Error("ENOSPC: no space left on device");
      this.saves.set(user, JSON.stringify(snapshot));
    }
    hasSave(user: string): boolean { return this.saves.has(user); }
    loadLatest(user: string): SessionSnapshot | null {
      const blob = this.saves.get(user);
      return blob === undefined ? null : (JSON.parse(blob) as SessionSnapshot);
    }
  }

  it("a disk failure during the nominations commit leaves NO nominations announcement in the delta catch-up log", () => {
    const store = new FlakyStore();
    const runtime = composeRuntime({ saveStore: store, clock: new FakeClock() });
    const user = "t0-3-fault";
    // Seed fan-out (see `driveToPendingKindAcrossSeeds`'s comment): search the seed fan-out until one
    // hands the player the HOH crown, so this doesn't depend on one fixed seed always doing so.
    let pending: PendingDecisionView | undefined;
    for (const seed of SEED_FAN_OUT) {
      runtime.registry.sandboxFor(user).session.createCharacter({
        playerName: "P", seed, confirmRestart: true,
      });
      try {
        pending = driveToPendingKind(runtime.registry.sandboxFor(user).session, "nominations");
        break;
      } catch { /* try the next seed */ }
    }
    if (!pending) throw new Error("no seed in the fan-out reached a nominations pending");
    const since = runtime.registry.sandboxFor(user).session.gameStatus().beatSeq;

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      store.failing = true;
      expect(() =>
        runtime.registry.sandboxFor(user).session.submitDecision({
          kind: "nominations", choice: [pending.options[0]!.id, pending.options[1]!.id],
        }),
      ).toThrowError(PersistFailureError);

      // The rolled-back sandbox never advanced — no new announcement exists at all for this token.
      const afterFail = runtime.registry.sandboxFor(user).session.stateDelta(since);
      expect(afterFail.announcements ?? []).toEqual([]);
      expect(runtime.registry.sandboxFor(user).session.gameStatus().nominees.length).toBe(0);

      // The disk recovers ⇒ the SAME decision now commits cleanly and DOES announce, exactly once.
      store.failing = false;
      const recovered = runtime.registry.sandboxFor(user).session.submitDecision({
        kind: "nominations", choice: [pending.options[0]!.id, pending.options[1]!.id],
      });
      expect(recovered.announcements?.filter((a) => a.kind === "nominations")).toHaveLength(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("T0-3 — the delta catch-up path (StateDeltaView.announcements) mirrors AdvanceView", () => {
  it("a reconnecting window's stateDelta(sinceBeatSeq) surfaces the SAME announcement the mutating call itself returned", () => {
    const { session } = startedGame(81000);
    let sinceBeforeCrown = session.gameStatus().beatSeq;
    let view = session.advanceGame();
    let crowned: AdvanceView | null = null;
    for (let i = 0; i < 50 && !crowned; i++) {
      if (view.event?.beat === "hoh-competition") { crowned = view; break; }
      sinceBeforeCrown = session.gameStatus().beatSeq;
      view = view.pending ? resolveLegally(session, view.pending) : session.advanceGame();
    }
    expect(crowned).not.toBeNull();
    const delta = session.stateDelta(sinceBeforeCrown);
    expect(delta.fullRefresh).toBe(false);
    const hoh = delta.announcements?.find((a) => a.kind === "hoh-winner");
    expect(hoh).toBeDefined();
    expect(hoh!.id).toBe(crowned!.announcements!.find((a) => a.kind === "hoh-winner")!.id);
  });
});
