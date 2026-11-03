import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView, SubmitDecisionReq } from "../../src/ports/GameSession";

/** A simple, deterministic player policy: compete, take the first legal options, never use the veto. */
function resolvePending(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  const submit = (req: SubmitDecisionReq): void => void s.submitDecision(req);
  if (p.kind === "nominations") submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") submit({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") submit({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-intent") submit({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "finale-statement") submit({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") submit({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "juror-vote") submit({ kind: "juror-vote", vote: p.options[0]!.id });
  else submit({ kind: p.kind, vote: p.options[0]!.id });
}

describe("0015/agent — engine-owned live competition resolution", () => {
  it("no game in progress → started:false, no winner, no throw", () => {
    const s = new GameSessionAdapter();
    const r = s.runCompetition({ type: "endurance" });
    expect(r.started).toBe(false);
    expect(r.winner).toBeNull();
  });

  it("resolves over the live house and returns only the winner's name (Vault-free)", () => {
    const s = new GameSessionAdapter();
    // The mechanics-plus library surfaces a legit public comp `type` ("mental"/"physical"…) that this
    // stat-word scan would misread; pin the baseline OFF (default flip 2026-11-03).
    s.setCompMechanicsPlusEnabled(false);
    s.createCharacter({ playerName: "The Player", seed: 7 });
    const state = s.getGameState();
    const names = new Set([state.player!.name, ...state.house.map((h) => h.name)]);
    const ids = new Set([state.player!.id, ...state.house.map((h) => h.id)]);

    const r = s.runCompetition({ type: "endurance" });
    expect(r.started).toBe(true);
    expect(r.winner).not.toBeNull();
    expect(ids.has(r.winner!.id)).toBe(true);
    expect(names.has(r.winner!.name)).toBe(true);

    // The outcome carries ONLY {started,type,week,phase,winner:{id,name}} — no stats/scores/soul.
    const blob = JSON.stringify(r);
    for (const banned of ["physical", "mental", "social", "score", "soul", "stats", "emotional"]) {
      expect(blob.includes(banned)).toBe(false);
    }
  });

  it("is deterministic per moment (same week/phase/type → same winner)", () => {
    const a = new GameSessionAdapter(); a.createCharacter({ playerName: "P", seed: 42 });
    const b = new GameSessionAdapter(); b.createCharacter({ playerName: "P", seed: 42 });
    expect(a.runCompetition({ type: "puzzle" })).toEqual(b.runCompetition({ type: "puzzle" }));
  });

  it("an unknown competition type falls back to a valid one (no throw)", () => {
    const s = new GameSessionAdapter(); s.createCharacter({ playerName: "P", seed: 1 });
    const r = s.runCompetition({ type: "banana" });
    expect(r.started).toBe(true);
    expect(r.winner).not.toBeNull();
  });
});

describe("0037/B26 — finaleView read tool", () => {
  it("is null before a finale, mirrors AdvanceView.finale during one (Vault-free), and returns the final result once finished", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", seed: 2 });
    expect(s.finaleView()).toBeNull(); // no finale is staging yet

    let sawFinale = false;
    let finished = false;
    for (let i = 0; i < 6000 && !finished; i++) {
      const adv = s.advanceGame();
      if (adv.finale && !adv.finished) {
        sawFinale = true;
        // The read tool returns the SAME Vault-free projection the advance already carries.
        expect(s.finaleView()).toEqual(adv.finale);
        expect(s.finaleView()!.winner).toBeNull(); // no pre-reveal winner while staging
        const blob = JSON.stringify(s.finaleView());
        expect(/"votes"|"script"|"tally"|"lean"|"manner"/i.test(blob)).toBe(false); // no pre-reveal internals
      }
      if (adv.pending) resolvePending(s, adv.pending);
      finished = adv.finished;
    }
    expect(sawFinale).toBe(true);
    // S4-2: post-finish the read SURVIVES — it returns the completed finale plus the crowned winner
    // (not null), so a finale-panel client agrees with status/recap instead of hanging.
    const post = s.finaleView();
    expect(post).not.toBeNull();
    expect(post!.stage).toBe("reveal");
    expect(post!.reveals.length).toBeGreaterThan(0); // every juror's ballot is read post-finish
    expect(post!.winner).not.toBeNull(); // the crowned winner is a public fact once the season is over
  });
});

describe("S4-2 — finaleView/seasonRecap return the committed final result post-finish (every surface agrees)", () => {
  /** Drive a season to its finished, crowned-winner terminal state (seeded, deterministic). */
  function playToFinish(s: GameSessionAdapter): AdvanceView {
    let adv = s.advanceGame();
    for (let i = 0; i < 6000 && !adv.finished; i++) {
      if (adv.pending) resolvePending(s, adv.pending);
      adv = s.advanceGame();
    }
    return adv;
  }

  it("finaleView + seasonRecap + gameStatus + AdvanceView all name the SAME crowned winner post-finish", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", seed: 2 });
    const finalAdv = playToFinish(s);
    expect(finalAdv.finished).toBe(true);

    const fv = s.finaleView();
    const recap = s.seasonRecap();
    const status = s.gameStatus();

    // The finaleView no longer collapses to null the instant the season flips to finished.
    expect(fv).not.toBeNull();
    expect(fv!.winner).not.toBeNull();

    // Every public surface reports the season is over.
    expect(recap.finished).toBe(true);
    expect(status.finished).toBe(true);

    // …and every surface names the SAME crowned winner (no disagreement across status/finale/recap).
    const w = fv!.winner!;
    expect(finalAdv.winner).toEqual(w);
    expect(recap.winner).toEqual(w);
    expect(status.winner).toEqual(w);

    // The winner is one of the two finalists carried on the same projection.
    expect(fv!.finalists.some((f) => f.id === w.id)).toBe(true);
  });

  it("finaleView stays non-null with the same winner across a persistence round-trip (restart-safe)", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "P", seed: 5 });
    playToFinish(s);
    const before = s.finaleView();
    expect(before).not.toBeNull();
    expect(before!.winner).not.toBeNull();

    // Restore into a fresh adapter (simulates an engine restart) — the durable finale survives.
    const s2 = new GameSessionAdapter();
    s2.restore(s.snapshot());
    const after = s2.finaleView();
    expect(after).not.toBeNull();
    expect(after!.winner).toEqual(before!.winner);
    expect(s2.seasonRecap().winner).toEqual(before!.winner);
  });
});
