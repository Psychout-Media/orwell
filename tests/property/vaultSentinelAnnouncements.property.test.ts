import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { assertNoSentinels, assertNoneAppear } from "../support/assertions";
import type {
  AdvanceView,
  BeatAnnouncementView,
  PendingDecisionView,
} from "../../src/ports/GameSession";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { HiddenKind } from "../../src/ports/VaultStore";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";

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

interface VaultDatum {
  id: string;
  content: string;
  sentinel: string;
}

interface AnnouncementSandbox {
  session: GameSessionAdapter;
  sentinels: string[];
  hiddenContents: string[];
}

function buildAnnouncementSandbox(seed: number): AnnouncementSandbox {
  const runtime = composeRuntime({ clock: new FakeClock() });
  const user = `vsa-${seed}-${Math.random().toString(36).slice(2)}`;
  const sandbox = runtime.registry.sandboxFor(user);

  // --- Vault sentinel seeding (exact pattern from sandbox.ts) ---
  const rng = new SeededRandom(seed);
  const sentinels: string[] = [];
  const hiddenContents: string[] = [];
  let sc = 0;
  let evid = 0;
  const nextEvId = (): string => `evt:${++evid}`;

  const freshSentinel = (prefix = "S"): string => {
    const s = `SENTINEL-${prefix}-${seed}-${++sc}-${Math.floor(rng.next() * 1e9)}`;
    sentinels.push(s);
    return s;
  };

  const addVault = (kind: string, subject?: string): VaultDatum => {
    const sentinel = freshSentinel(kind);
    const id = `vault:${sc}`;
    const content = `[${kind}]${subject ? ` ${subject}` : ""} secret-detail ${sentinel}`;
    sandbox.engine.vault.writeHidden({ id, kind: kind as HiddenKind, content, ...(subject ? { subject } : {}) });
    hiddenContents.push(content);
    return { id, content, sentinel };
  };

  const recordOffscreen = (a: string, b: string, verb: string, prefix: string): VaultDatum => {
    const sentinel = freshSentinel(prefix);
    const id = `vault:${sc}`;
    const content = `[offscreen] ${a} ${verb} ${b} ${sentinel}`;
    sandbox.engine.events.record({
      id: nextEvId(), ts: sc, type: "conversation",
      initiator: a, witnessSet: [a, b], hidden: true, content,
    });
    sandbox.engine.vault.writeHidden({ id, kind: "offscreen-event", content });
    hiddenContents.push(content);
    return { id, content, sentinel };
  };

  const recordNpcDeal = (a: string, b: string): VaultDatum => {
    const sentinel = freshSentinel("npc-deal");
    const id = `vault:${sc}`;
    const content = `[npc-deal] ${a} and ${b} struck a hidden final-two pact ${sentinel}`;
    sandbox.engine.events.record({
      id: nextEvId(), ts: sc, type: "conversation",
      initiator: a, witnessSet: [a, b], hidden: true, content,
    });
    sandbox.engine.vault.writeHidden({ id, kind: "hidden-thread", content });
    hiddenContents.push(content);
    return { id, content, sentinel };
  };

  // --- Fully populate the Vault with sentinels (same counts as sandbox.ts) ---
  for (let i = 1; i <= 4; i++) addVault("hidden-attribute", npc(i));
  for (let i = 1; i <= 3; i++) {
    const d = addVault("confessional", npc(i));
    sandbox.engine.events.record({
      id: nextEvId(), ts: sc, type: "confessional",
      initiator: npc(i), witnessSet: [npc(i)], hidden: true, content: d.content,
    });
  }
  addVault("hidden-thread");
  addVault("hidden-thread");
  recordNpcDeal(npc(2), npc(3));
  for (let i = 1; i <= 3; i++) recordOffscreen(npc(i), npc(i + 1), "schemed with", "offscreen");
  addVault("reserved-twist");

  // --- Create character on the session ---
  sandbox.session.createCharacter({ playerName: "P", seed });

  return { session: sandbox.session, sentinels, hiddenContents };
}

/**
 * Does the engine's bare beatSeq counter appear in a human-facing headline? A PUBLIC count the headline states on purpose ("; 7 remain" in a comp-round result, "Part 2" of the final HOH) is NOT
 * a leak even when it coincides with the counter (seq 7 vs "7 remain" tripped the old substring check). Strip those sanctioned public-count phrases, then require the counter to be absent as a
 * standalone number. Roles only.
 */
export function leaksBeatSeq(headline: string, beatSeq: number): boolean {
  const stripped = headline.replace(/;\s*\d+\s+remain\b/g, "").replace(/\bPart\s+\d+\b/g, "");
  return new RegExp(`(?<![\\w.])${beatSeq}(?![\\w])`).test(stripped);
}

describe("leaksBeatSeq (the check itself)", () => {
  it("a public remaining-count that coincides with the counter is not a leak; a spilled counter is", () => {
    expect(leaksBeatSeq("A, B and C are out of the competition; 7 remain.", 7)).toBe(false);
    expect(leaksBeatSeq("A wins Part 2 of the final Head of Household competition.", 2)).toBe(false);
    expect(leaksBeatSeq("A wins the HOH (beat 7).", 7)).toBe(true);
    expect(leaksBeatSeq("A wins the HOH #7", 7)).toBe(true);
    expect(leaksBeatSeq("A, B are out of the competition; 7 remain. seq 7", 7)).toBe(true);
    expect(leaksBeatSeq("A wins the HOH.", 7)).toBe(false);
    expect(leaksBeatSeq("A wins 17 rounds", 7)).toBe(false); // 17 is not 7
  });
});

describe("Vault Wall — property over seeds & BeatAnnouncement announcements", () => {
  it("no Vault sentinel or hidden content ever reaches any BeatAnnouncement chyron", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (seed) => {
        const { session, sentinels, hiddenContents } = buildAnnouncementSandbox(seed);
        const { all } = driveWholeSeason(session);

        // Serialize every announcement's every field into one searchable blob
        const announcementBlob = all.map((a) => {
          const subjectsBlob = (a.subjects ?? []).map((n) => `${n.id}|${n.name}`).join("|");
          const detailBlob = a.detail ? JSON.stringify(a.detail) : "";
          return `${a.id}|${a.kind}|${a.week}|${a.beatSeq}|${a.headline}|${subjectsBlob}|${detailBlob}`;
        }).join("\n---\n");

        // Also collect from the delta catch-up path
        const delta = session.stateDelta(0);
        const deltaBlob = (delta.announcements ?? []).map((a) => {
          const subjectsBlob = (a.subjects ?? []).map((n) => `${n.id}|${n.name}`).join("|");
          const detailBlob = a.detail ? JSON.stringify(a.detail) : "";
          return `${a.id}|${a.kind}|${a.week}|${a.beatSeq}|${a.headline}|${subjectsBlob}|${detailBlob}`;
        }).join("\n---\n");

        const blob = `${announcementBlob}\n=== DELTA ===\n${deltaBlob}`;

        assertNoSentinels(blob, sentinels);
        assertNoneAppear(blob, hiddenContents);

        // Additional: no raw engine machinery in human-facing text
        for (const a of all) {
          // the bare beatSeq number not spilled into headline
          expect(leaksBeatSeq(a.headline, a.beatSeq), `beatSeq ${a.beatSeq} spilled into headline: ${a.headline}`).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
