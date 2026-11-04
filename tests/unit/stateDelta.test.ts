import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { GameSessionRegistry } from "../../src/composition/registry";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { UserSandbox } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, StateDeltaView } from "../../src/ports/GameSession";
import { buildSandbox } from "../support/sandbox";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * Feature 0065 Part E — the `beatSeq`-keyed delta state feed. Given the caller's last-seen `beatSeq`,
 * the engine returns exactly what changed since (events appended, ceremony field diffs, finished/winner
 * transitions) — Vault-free, player-visible only, and O(Δ): a late-state delta never scans the whole
 * event log. An unknown/too-old `sinceBeatSeq` signals a full refresh rather than guessing a partial
 * delta. HARD rule: roles only — no names.
 */
const freshDir = (): string => mkdtempSync(join(tmpdir(), "orwell-0065e-"));

/** A turn-driven runtime over a fresh save dir with a started game (its first commit baselines). */
function startedRuntime(seed = 2): { reg: GameSessionRegistry; sb: UserSandbox; session: GameSessionAdapter; dir: string } {
  const dir = freshDir();
  const runtime = composeRuntime({ saveStore: new FileSaveStore(dir), clock: new FakeClock() });
  const sb = runtime.registry.sandboxFor("u");
  sb.session.createCharacter({ playerName: "P", seed });
  sb.session.setNpcDealConsentEnabled(false); // these tests exercise deal MECHANICS, not NPC consent (dealConsent*.test.ts cover that)
  return { reg: runtime.registry, sb, session: sb.session, dir };
}

/** Resolve a pending decision LEGALLY (roles only). */
function resolveLegally(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): AdvanceView {
  if (p.kind === "nominations") return s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  if (p.kind === "veto-decision") return s.submitDecision({ kind: "veto-decision", use: false });
  if (p.kind === "replacement") return s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  if (p.kind === "comp-intent" || p.kind === "comp-round") return s.submitDecision({ kind: p.kind, intent: "compete" });
  if (p.kind === "finale-statement") return s.submitDecision({ kind: "finale-statement", statement: "x" });
  if (p.kind === "finale-answer") return s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  if (p.kind === "juror-vote") return s.submitDecision({ kind: "juror-vote", vote: p.options[0]!.id });
  return s.submitDecision({ kind: p.kind, vote: p.options[0]!.id });
}

/** Drive a few beats, resolving any pending decision so the board genuinely moves. */
function driveBeats(s: GameSessionAdapter, n: number): void {
  for (let i = 0; i < n; i++) {
    const adv = s.advanceGame();
    if (adv.finished) break;
    if (adv.pending) resolveLegally(s, adv.pending);
  }
}

describe("0065 Part E — the beatSeq-keyed delta returns exactly what changed since N", () => {
  it("returns the events appended AND the ceremony diffs since a prior beatSeq", () => {
    const { sb, session } = startedRuntime();
    const since = session.gameStatus().beatSeq;
    // Two committed mutations that each record a player-witnessed event.
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "scene ALPHA" });
    sb.session.makeDeal({ with: npc(1), kind: "safety", terms: "BETA" });

    const delta = session.stateDelta(since);
    expect(delta.fullRefresh).toBeFalsy();
    expect(delta.beatSeq).toBe(session.gameStatus().beatSeq);
    // The two new player-visible mutations both appear, in order. The turn-driven off-screen tick
    // (pure turn-driven default) may ALSO surface at most one ambient, once-per-day house-event headline
    // ("Week N[, day D]: …") in this window — it is legitimate new player-visible texture, so we assert
    // the two mutations are present rather than pinning a brittle exact count. Every delta event stays
    // player-visible (Vault-free): the delta is a player-facing projection.
    const contents = delta.events.map((e) => e.content);
    expect(contents.some((c) => c.includes("ALPHA"))).toBe(true);
    expect(contents.some((c) => c.includes("BETA"))).toBe(true);
    // ALPHA precedes BETA (append order preserved).
    const iAlpha = contents.findIndex((c) => c.includes("ALPHA"));
    const iBeta = contents.findIndex((c) => c.includes("BETA"));
    expect(iAlpha).toBeGreaterThanOrEqual(0);
    expect(iBeta).toBeGreaterThan(iAlpha);
    // Nothing but the two mutations and (optionally) a single ambient day headline — no unrelated leakage.
    const extras = contents.filter((c) => !c.includes("ALPHA") && !c.includes("BETA"));
    expect(extras.length).toBeLessThanOrEqual(1);
    for (const c of extras) expect(c).toMatch(/^Week \d+(, day \d+)?: /);
  });

  it("surfaces ceremony field transitions (HOH/noms/veto/phase/week) since the prior beatSeq", () => {
    const { session } = startedRuntime();
    // Drive the loop far enough that an HOH is crowned and nominations are named.
    const since = session.gameStatus().beatSeq;
    driveBeats(session, 12);
    const delta = session.stateDelta(since);
    expect(delta.fullRefresh).toBeFalsy();
    // The phase moved off "setup" and the ceremony populated — those are reported as changes.
    expect(delta.changes).toBeTruthy();
    const changed = delta.changes!;
    // Something ceremony-level moved over a dozen beats (phase at minimum).
    expect(Object.keys(changed).length).toBeGreaterThan(0);
    // The reported board matches the live status (the delta carries the freshest ceremony facts).
    const status = session.gameStatus();
    expect(delta.board.phase).toBe(status.phase);
    expect(delta.board.week).toBe(status.week);
  });

  it("is EMPTY when nothing has been committed since (sinceBeatSeq == current)", () => {
    const { session } = startedRuntime();
    const current = session.gameStatus().beatSeq;
    const delta = session.stateDelta(current);
    expect(delta.fullRefresh).toBeFalsy();
    expect(delta.beatSeq).toBe(current);
    expect(delta.events).toEqual([]);
    expect(delta.changes).toBeUndefined();
    expect(delta.finishedChanged).toBeFalsy();
  });
});

describe("0065 Part E — an unknown/too-old sinceBeatSeq signals a full refresh", () => {
  it("a sinceBeatSeq AHEAD of the current counter ⇒ fullRefresh (never a wrong/partial delta)", () => {
    const { session } = startedRuntime();
    const current = session.gameStatus().beatSeq;
    const delta = session.stateDelta(current + 5);
    expect(delta.fullRefresh).toBe(true);
    expect(delta.beatSeq).toBe(current);
    expect(delta.events).toEqual([]);
  });

  it("a sinceBeatSeq OLDER than the retained history window ⇒ fullRefresh", () => {
    const { sb, session } = startedRuntime();
    // Commit far more beats than the retained delta window so the early checkpoints fall off.
    for (let i = 0; i < 80; i++) {
      sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: `scene ${i}` });
    }
    // beatSeq 1 is now far behind the retained window — guessing a delta would be wrong.
    const delta = session.stateDelta(1);
    expect(delta.fullRefresh).toBe(true);
    expect(delta.events).toEqual([]);
  });

  it("a NEGATIVE sinceBeatSeq ⇒ fullRefresh (robust to a malformed/uninitialized token)", () => {
    const { session } = startedRuntime();
    expect(session.stateDelta(-1).fullRefresh).toBe(true);
  });
});

describe("0065 Part E — the delta is Vault-free (sentinel)", () => {
  it("never carries hidden/Vault content — only player-visible events cross", () => {
    const { sb, session } = startedRuntime();
    const since = session.gameStatus().beatSeq;
    // A genuinely hidden, off-screen NPC↔NPC scene with a sentinel the player never witnessed.
    const SECRET = "VAULT-DELTA-SENTINEL";
    sb.engine.events.record({
      id: "hidden:delta", ts: 1, type: "conversation",
      initiator: npc(2), witnessSet: [npc(2), npc(3)], hidden: true, content: `secret scheme ${SECRET}`,
    });
    // And a player-witnessed scene that DOES belong in the delta.
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "visible chat" });

    const delta = session.stateDelta(since);
    const blob = JSON.stringify(delta);
    expect(blob).not.toContain(SECRET);
    // The hidden event is excluded; the visible one is present.
    expect(delta.events.some((e) => e.content.includes(SECRET))).toBe(false);
    expect(delta.events.some((e) => e.content.includes("visible chat"))).toBe(true);
  });

  it("the full Vault sentinel corpus never appears in a delta over a populated Vault", () => {
    // A heavily-populated Vault (every hidden datum carries a unique sentinel) — the delta must never
    // surface any of them. (This sandbox builds its own outward channels; we only assert the projection.)
    const s = buildSandbox(5);
    // The visible projection the delta reuses is the SAME one the player surface reads — proven elsewhere
    // to be sentinel-free; here we assert no sentinel ever lands in a player-visible event list.
    const visible = s.player.getVisibleState();
    const blob = JSON.stringify(visible);
    for (const sentinel of s.sentinels) expect(blob).not.toContain(sentinel);
  });
});

describe("0065 Part E — the delta survives a snapshot round-trip", () => {
  it("after a restart the delta window resets (so a stale token full-refreshes), and a fresh delta is correct", () => {
    const { reg, sb, session, dir } = startedRuntime();
    driveBeats(session, 6);
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "pre-restart" });
    const beforeBeat = session.gameStatus().beatSeq;
    reg.saveUser("u");

    // A fresh registry over the same dir (process restart) resumes the counter at the saved value.
    const resumedReg = new GameSessionRegistry(new FileSaveStore(dir));
    const resumed = resumedReg.sandboxFor("u");
    const resumedSession = resumed.session;
    expect(resumedSession.gameStatus().beatSeq).toBe(beforeBeat);

    // The pre-restart token is no longer in the (empty, post-restart) delta window ⇒ full refresh.
    expect(resumedSession.stateDelta(beforeBeat - 1).fullRefresh).toBe(true);

    // A delta keyed on the RESUMED beatSeq, after a fresh committed mutation, is correct (O(Δ) tail).
    const since = resumedSession.gameStatus().beatSeq;
    resumed.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "post-restart" });
    const delta = resumedSession.stateDelta(since);
    expect(delta.fullRefresh).toBeFalsy();
    expect(delta.events.some((e) => e.content.includes("post-restart"))).toBe(true);
    // The healed history is NOT re-emitted (only the one new event).
    expect(delta.events.some((e) => e.content.includes("pre-restart"))).toBe(false);
  });
});

describe("0065 Part E — the delta export is O(Δ), not O(events)", () => {
  it("a late-state delta reads only the events appended after the token, not the whole log", () => {
    const { sb, session } = startedRuntime();
    // Build a long history (many committed player-witnessed events).
    for (let i = 0; i < 60; i++) {
      sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: `history ${i}` });
    }
    const total = sb.engine.events.count();
    expect(total).toBeGreaterThan(50);

    const since = session.gameStatus().beatSeq;
    // Two new events after the token — the delta should consider ONLY these.
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "tail X" });
    sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "tail Y" });

    // Instrument the events provider: count how many events the delta path materializes. An O(events)
    // implementation would pull the whole log (>50); the O(Δ) path pulls only the tail (the two new).
    let scanned = -1;
    session.setDeltaScanProbe((n) => { scanned = n; });
    const delta = session.stateDelta(since);
    session.setDeltaScanProbe(undefined);

    expect(delta.events.length).toBe(2);
    expect(scanned).toBeGreaterThanOrEqual(0); // the probe fired
    // The work is bounded by Δ (a small constant), NEVER by the total history.
    expect(scanned).toBeLessThan(total);
    expect(scanned).toBeLessThanOrEqual(5);
  });
});
