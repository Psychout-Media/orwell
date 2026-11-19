import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

/**
 * ORW-705 / PT-11: the status panel's "Last out" row read a `lastEviction` the engine never projected, so it stayed empty after an eviction. The public status now names who was voted
 * out most recently (name only: no tally, no ballot, nothing about how anyone voted). Drives the REAL staged eviction; roles only.
 */
type Any = Record<string, any>;
function boot(): Any {
  const s = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-lastout-")))).sandboxFor("u").session as unknown as Any;
  s.createCharacter({ playerName: "P", seed: 5 });
  s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
  return s;
}
function toEviction(s: Any): void {
  for (let i = 0; i < 300; i++) {
    const live = s.live as LiveSeasonState;
    if (live.beat === "eviction" && !live.pending && !live.ceremony && !live.eviction) break;
    const p = s.advanceGame().pending;
    if (!p) continue;
    if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
    else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
    else if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
    else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", pick: p.options[0].id });
    else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  }
}
function playOut(s: Any): void {
  for (let i = 0; i < 80; i++) {
    const live = s.live as LiveSeasonState;
    if (live.evictionOrder.length && !live.ceremony && !live.eviction && !live.pending) break;
    const p = live.pending as Any | undefined;
    const target = p?.nominees ? (p.nominees.find((n: string) => n !== PLAYER) ?? p.nominees[0]) : undefined;
    if (p?.kind === "eviction-vote") s.submitDecision({ kind: "eviction-vote", vote: target });
    else if (p?.kind === "tie-break") s.submitDecision({ kind: "tie-break", vote: target });
    else if (p?.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: "warm" });
    else if (p?.kind === "exit-interview") s.submitDecision({ kind: "exit-interview", vote: "gracious" });
    else if (p?.kind === "spectator-choice") s.submitDecision({ kind: "spectator-choice", vote: "watch" });
    else s.advanceGame();
  }
}

describe("PT-11: the public status names who went out last", () => {
  it("no eviction yet: no lastEviction; after the eviction it names the evictee (name only)", () => {
    const s = boot();
    expect(s.gameStatus().lastEviction).toBeUndefined();
    toEviction(s);
    expect(s.gameStatus().lastEviction).toBeUndefined();
    playOut(s);
    const live = s.live as LiveSeasonState;
    expect(live.evictionOrder.length).toBeGreaterThan(0);
    const last = live.evictionOrder[live.evictionOrder.length - 1];
    const le = s.gameStatus().lastEviction;
    expect(le?.evictee.id).toBe(last);
    expect(le?.evictee.name).toBeTruthy();
    expect(Object.keys(le!)).toEqual(["evictee"]); // no tally, no ballot, no voter
    expect(Object.keys(le!.evictee).sort()).toEqual(["id", "name"]);
  });
});
