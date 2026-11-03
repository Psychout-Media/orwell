import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { AdvanceView, RetrospectiveView } from "../../src/ports/GameSession";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { buildPullQuoteReel } from "../../src/engine/pullQuoteReel";

/**
 * Issue #1396 — the CALIBRATION-NEUTRALITY GATE for the pull-quote reel (the `triggerOutcomeNeutral` /
 * `stagedTrajectoryNeutral` sibling). The reel is a PURE, read-time SELECTION over already-recorded
 * confessionals: it draws NO rng, records NO event, and mutates NO state. So:
 *
 *   • Reading the retrospective (which BUILDS the reel) appends nothing and changes no seeded value — the
 *     recorded event stream is byte-identical before and after (ZERO new draws).
 *   • The seeded outcome spine AND the whole retrospective (incl. the reel) are a deterministic fixed
 *     point for a given seed — the reel is a pure function of the recorded season.
 *   • An EMPTY reel leaves the retrospective byte-identical: the field is purely additive, so every other
 *     field is untouched, and the pure builder returns `[]` when there is nothing to curate.
 *
 * HARD rule: roles only — no fixture names; all fixtures generated from a seed.
 */

function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "finale-statement") s.submitDecision({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") s.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.options[0]) s.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
}
function playToEnd(s: GameSessionAdapter): void {
  for (let i = 0; i < 4000; i++) {
    const v = s.advanceGame();
    if (v.pending) resolve(s, v.pending);
    if (v.finished) return;
  }
  throw new Error("the season did not finish within the drive budget");
}
type Sandbox = ReturnType<GameSessionRegistry["sandboxFor"]>;
/** A fresh registry + a played-to-a-seed sandbox. Same (user, seed) ⇒ byte-identical run (fresh registry). */
function finishedGame(user: string, seed: number): Sandbox {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  playToEnd(sb.session);
  return sb;
}

/** SHA256 of the SEEDED content signature of every recorded event (the id carries an rng nonce — hash the
 *  seeded content, exactly as `triggerOutcomeNeutral` does — so a real draw/record would change the hash). */
function streamHash(sb: Sandbox): string {
  const sig = (e: { type: string; initiator: string; witnessSet: readonly string[]; hidden: boolean; content: string }): string =>
    `${e.type}|${e.initiator}|${[...e.witnessSet].sort().join(",")}|${e.hidden ? 1 : 0}|${e.content}`;
  return createHash("sha256").update(sb.engine.events.queryAll().map(sig).join("\n")).digest("hex");
}

describe("#1396 — the pull-quote reel is calibration-neutral (read-only projection, zero new draws)", () => {
  it("reading the retrospective (building the reel) appends no event and mutates no seeded state", () => {
    const sb = finishedGame("reel-neutral-a", 7);
    const before = streamHash(sb);
    // Build the reel repeatedly through BOTH unseal paths.
    for (let i = 0; i < 3; i++) {
      sb.session.seasonRetrospective();
      sb.session.producerVaultDump();
    }
    expect(streamHash(sb), "the reel read records nothing and draws no rng").toBe(before);
    // …and the retrospective (incl. the reel) is idempotent read-to-read.
    expect(JSON.stringify(sb.session.seasonRetrospective())).toBe(JSON.stringify(sb.session.seasonRetrospective()));
  });

  it("the seeded spine AND the whole retrospective (incl. the reel) are a deterministic fixed point", () => {
    const a = finishedGame("reel-neutral-b", 13);
    const b = finishedGame("reel-neutral-b", 13); // SAME user + seed, fresh registry
    expect(streamHash(a), "same seed ⇒ byte-identical seeded event stream").toBe(streamHash(b));
    expect(JSON.stringify(a.session.seasonRetrospective()), "the whole retrospective is a pure function of the seed")
      .toBe(JSON.stringify(b.session.seasonRetrospective()));
    // Non-vacuous: a real reel was produced (so the determinism above is a real result).
    expect(a.session.seasonRetrospective()!.pullQuoteReel.length).toBeGreaterThan(0);
  });

  it("empty reel ⇒ byte-identical retrospective (purely additive; the pure builder is empty-safe)", () => {
    // Pure: nothing to curate ⇒ empty reel (no rng, no inputs).
    expect(buildPullQuoteReel([], { nameOf: (id) => id, scrub: (c) => c })).toEqual([]);

    // Integration: stripping the reel leaves EVERY other field byte-identical across identically-seeded
    // runs, and the ONLY key the feature adds to the retrospective is `pullQuoteReel`.
    const ra = finishedGame("reel-neutral-c", 21).session.seasonRetrospective()!;
    const rb = finishedGame("reel-neutral-c", 21).session.seasonRetrospective()!;
    const strip = (r: RetrospectiveView): Record<string, unknown> => {
      const o: Record<string, unknown> = { ...r };
      delete o.pullQuoteReel;
      return o;
    };
    expect(JSON.stringify(strip(ra)), "the non-reel retrospective is untouched by the reel").toBe(JSON.stringify(strip(rb)));
    // Includes "exitInterviews" (0130) and "finaleInterview" (0133, present for a pre-jury evictee) — separate additive keys, not the pull-quote reel's doing.
    const PRE_FEATURE_KEYS = new Set(["winner", "playerConfessionals", "hiddenStory", "twists", "evictionVotes", "juryVotes", "exitInterviews", "finaleInterview"]);
    for (const k of Object.keys(ra)) {
      if (k !== "pullQuoteReel") expect(PRE_FEATURE_KEYS.has(k), `unexpected new retrospective key "${k}"`).toBe(true);
    }
    expect(Object.keys(ra)).toContain("pullQuoteReel");
  });
});
