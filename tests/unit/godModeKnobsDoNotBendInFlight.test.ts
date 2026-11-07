import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameSessionRegistry } from "../../src/composition/registry";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import type { GameSession, AdvanceView } from "../../src/ports/GameSession";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";

/**
 * #2007 determinism question: the registry re-applies a user's God-Mode count knobs every time their sandbox is rebuilt (LRU resume / restore).
 * The docs say the knobs shape the NEXT season only. Prove a rebuild does not bend a season IN FLIGHT: same seed, knobs changed mid-season
 * (to values that differ from the defaults), the sandbox evicted and resumed from its save vs never rebuilt => an identical remaining trajectory.
 * (twistCount is read only at createCharacter; tieBudget/showmanceBudget at createCharacter and, on restore, only for a pre-0059 save that has
 * no persisted seeded layer. This pins that behaviour.) Roles only.
 */
const SEED = 17;

function resolve(s: GameSessionAdapter, p: NonNullable<AdvanceView["pending"]>): void {
  const submit = (req: Parameters<GameSession["submitDecision"]>[0]): void => void s.submitDecision(req);
  if (p.kind === "nominations") submit({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") submit({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") submit({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-intent") submit({ kind: "comp-intent", intent: "compete" });
  else if (p.kind === "comp-round") submit({ kind: "comp-round", intent: "compete" });
  else if (p.kind === "finale-statement") submit({ kind: "finale-statement", statement: "x" });
  else if (p.kind === "finale-answer") submit({ kind: "finale-answer", appeal: p.appeals![0]! });
  else if (p.kind === "juror-vote") submit({ kind: "juror-vote", vote: p.options[0]!.id });
  else submit({ kind: p.kind, vote: p.options[0]!.id } as never);
}

/** The full public trajectory: every advance view (comp winners, nominations, veto, votes, announcements) in order. */
let trace: string[] = [];
function drive(s: GameSessionAdapter, beats: number): boolean {
  for (let i = 0; i < beats; i++) {
    const v = s.advanceGame();
    trace.push(JSON.stringify(v));
    if (v.pending) resolve(s, v.pending);
    if (v.finished) return true;
  }
  return false;
}

function finish(s: GameSessionAdapter): { order: unknown; winner: unknown; reserve: number; ties: number } {
  for (let i = 0; i < 6000; i++) if (drive(s, 1)) break;
  const snap = s.snapshot() as SessionSnapshot;
  return { order: snap.live?.evictionOrder, winner: snap.live?.winner, reserve: snap.live?.reserve?.length ?? 0, ties: snap.seededRelationships?.ties.length ?? 0 };
}

const KNOBS = { reserveTwists: 0, tieBudget: 0, showmanceBudget: 0 };

describe("#2007 — a sandbox rebuild never bends a season in flight", () => {
  it("knobs changed mid-season, then the sandbox evicted and resumed: the remaining trajectory is identical to never rebuilding", () => {
    // A: never rebuilt
    trace = [];
    const regA = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "kn-a-"))), { maxResident: 1 });
    const a = regA.sandboxFor("player-a");
    a.session.createCharacter({ playerName: "The Player", seed: SEED });
    drive(a.session, 30);
    a.admin.configure(KNOBS);
    const fa = finish(regA.sandboxFor("player-a").session);
    const traceA = trace;

    trace = [];
    // B: same, but the sandbox is evicted (a second user displaces it, maxResident 1) and RESUMED from its save after the knobs were set
    const regB = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "kn-b-"))), { maxResident: 1 });
    const b = regB.sandboxFor("player-a");
    b.session.createCharacter({ playerName: "The Player", seed: SEED });
    drive(b.session, 30);
    const reservedBefore = (b.session.snapshot() as SessionSnapshot).live?.reserve?.length ?? 0;
    const tiesBefore = (b.session.snapshot() as SessionSnapshot).seededRelationships?.ties.length ?? 0;
    b.admin.configure(KNOBS);
    regB.sandboxFor("someone-else");                       // displaces player-a (LRU)
    const resumed = regB.sandboxFor("player-a");           // rebuilt from the save; the knobs are re-applied to it
    expect(resumed).not.toBe(b);
    const rb = resumed.session.snapshot() as SessionSnapshot;
    expect(rb.live?.reserve?.length ?? 0, "the in-flight season keeps the reserve twists it was dealt").toBe(reservedBefore);
    expect(rb.seededRelationships?.ties.length ?? 0, "…and the ties it was dealt").toBe(tiesBefore);
    const fb = finish(resumed.session);
    const traceB = trace;

    expect((fa.order as unknown[]).length, "a real multi-eviction season was played to the end").toBeGreaterThan(8);
    expect(fa.winner, "…and crowned").toBeTruthy();
    expect(traceA.length, "a real trajectory was recorded").toBeGreaterThan(100);
    expect(traceB, "every beat's public view (not just the end state) is identical after the rebuild").toEqual(traceA);
    expect(fb.order).toEqual(fa.order);
    expect(fb.winner).toEqual(fa.winner);
    expect(fb.reserve).toBe(fa.reserve);
    expect(fb.ties).toBe(fa.ties);
  }, 300_000);

  it("control: the SAME knobs DO change the next season dealt (so the test above is not vacuous)", () => {
    const reg = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "kn-c-"))), { maxResident: 1 });
    // Pre-show ties are rare now (ORW-132), so the default season for a given seed may deal nothing; find a seed in a window whose DEFAULT season deals a reserve twist or tie, then show the knobs remove them on that same seed.
    let seed = SEED, dealt = 0;
    for (; seed < SEED + 40; seed++) {
      const plain = new GameSessionRegistry().sandboxFor(`player-d-${seed}`);
      plain.session.createCharacter({ playerName: "The Player", seed });
      const ps = plain.session.snapshot() as SessionSnapshot;
      dealt = (ps.live?.reserve?.length ?? 0) + (ps.seededRelationships?.ties.length ?? 0);
      if (dealt > 0) break;
    }
    expect(dealt, "the default season deals some reserve twist or tie (on some seed in the window)").toBeGreaterThan(0);
    const sb = reg.sandboxFor("player-c");
    sb.admin.configure(KNOBS);
    sb.session.createCharacter({ playerName: "The Player", seed });
    const snap = sb.session.snapshot() as SessionSnapshot;
    expect(snap.live?.reserve?.length ?? 0).toBe(0);
    expect(snap.seededRelationships?.ties.length ?? 0).toBe(0);
  });
});
