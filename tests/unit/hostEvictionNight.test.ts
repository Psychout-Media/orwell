import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import { hostRegister, registerWords, countShape, countFact, hostQuestionTexts, playerRoles } from "../../src/engine/productionHost";

/** ORW-667 (0210 C1): the host of eviction night. The host block carries only public facts; it changes no outcome. Roles only. */
type Any = Record<string, any>;
const boot = (seed = 5, host = true, played = true): Any => {
  const s = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-host-")))).sandboxFor("u").session as unknown as Any;
  s.setHostEnabled(host);
  s.createCharacter({ playerName: "P", seed });
  if (played) s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
  return s;
};
function toEviction(s: Any, playerNominated: boolean): void {
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
  const live = s.live as LiveSeasonState;
  const others = live.active.filter((h) => h !== PLAYER);
  live.hoh = others[0]!;
  const pool = others.filter((h) => h !== live.hoh);
  live.finalNominees = playerNominated ? [PLAYER, pool[0]!] : [pool[0]!, pool[1]!];
  live.nominees = [...live.finalNominees];
  live.preEvictionNightPassed = true;
}
/** Plays the eviction out, handing back every game-state eviction view and moment block seen on the way. */
function playOut(s: Any, evictPlayer = false): Array<{ ev: Any | null | undefined; block: string }> {
  const seen: Array<{ ev: Any | null | undefined; block: string }> = [];
  const snap = (): void => { seen.push({ ev: s.getGameState().eviction, block: s.getMomentPrompt({}).hardConstraints ?? "" }); };
  for (let i = 0; i < 80; i++) {
    const live = s.live as LiveSeasonState;
    if (seen.length && !live.ceremony && !live.eviction && !live.pending) break;
    const p = live.pending as Any | undefined;
    const target = p?.nominees ? (evictPlayer && p.nominees.includes(PLAYER) ? PLAYER : p.nominees.find((n: string) => n !== PLAYER) ?? p.nominees[0]) : undefined;
    if (p?.kind === "eviction-vote") s.submitDecision({ kind: "eviction-vote", vote: target });
    else if (p?.kind === "tie-break") s.submitDecision({ kind: "tie-break", vote: target });
    else if (p?.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: "warm" });
    else if (p?.kind === "exit-interview") s.submitDecision({ kind: "exit-interview", vote: "gracious" });
    else if (p?.kind === "spectator-choice") s.submitDecision({ kind: "spectator-choice", vote: "watch" });
    else s.advanceGame();
    snap();
  }
  return seen;
}

describe("the host's manner is a stable, seeded character", () => {
  it("is deterministic per seed, differs across seeds, and is composed words with no number", () => {
    expect(hostRegister(7)).toEqual(hostRegister(7));
    const words = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) words.add(registerWords(hostRegister(seed)));
    expect(words.size).toBeGreaterThan(40);
    for (const w of words) expect(w).not.toMatch(/\d/);
    expect(hostRegister(7, "host")).not.toEqual(hostRegister(7, "producer"));
  });
  it("count shapes read from the public ballots only", () => {
    expect(countShape(6, 0)).toBe("unanimous");
    expect(countShape(4, 4)).toBe("tie-broken");
    expect(countShape(5, 4)).toBe("one-vote");
    expect(countShape(8, 1)).toBe("lopsided");
    expect(countFact("close")).not.toMatch(/\d/);
  });
  it("questions keep the evictee's own choices first and never a hidden fact", () => {
    const base = { public: true, hidden: false, week: 1, drama: 0.5 };
    const qs = hostQuestionTexts([
      { id: "a", actor: "x", ...base, text: "public thing" },
      { id: "b", actor: "e", ...base, drama: 0.1, text: "own choice" },
      { id: "c", actor: "e", ...base, hidden: true, drama: 1, text: "SENTINEL_HIDDEN" },
    ], "e");
    expect(qs).toEqual(["own choice", "public thing"]);
  });
  it("the player's own public seat", () => {
    expect(playerRoles({ player: "p", hoh: "p", nominees: ["a", "b"], vetoHolder: "a", evictee: "a" })).toEqual(["the Head of Household who named the block"]);
    expect(playerRoles({ player: "p", hoh: "h", nominees: ["p", "b"], vetoHolder: "p", vetoUsed: true, evictee: "p" })).toEqual(["on the block", "the veto holder, who used it", "the one voted out"]);
  });
});

describe("the host block on a played eviction night", () => {
  it("rides every eviction-night view, holds only public facts, and survives save/restore with the same manner", () => {
    const s = boot();
    toEviction(s, true);
    (s.live as Any).hiddenSentinel = "SENTINEL_HIDDEN_FACT";
    const seen = playOut(s, false);
    expect(seen.length).toBeGreaterThan(2);
    const withEv = seen.filter((x) => x.ev);
    expect(withEv.length).toBeGreaterThan(1);
    const registers = new Set<string>();
    for (const { ev, block } of withEv) {
      expect(ev!.host, "host block missing").toBeTruthy();
      registers.add(ev!.host.register);
      const dump = JSON.stringify(ev!.host) + block;
      expect(dump).not.toContain("SENTINEL");
      expect(JSON.stringify(ev!.host)).not.toMatch(/npc:|\d/);
      expect(Object.keys(ev!.host).every((k) => ["register", "hoh", "vetoHolder", "vetoUsed", "playerRoles", "questions"].includes(k))).toBe(true);
      expect(block).toContain("HOST (production's voice");
      expect(ev!.host.playerRoles).toEqual(["on the block"]); // the player's own public seat is reflected
    }
    expect(registers.size).toBe(1); // one stable host for the night
    expect(seen.some((x) => x.block.includes("The count, in the open:"))).toBe(true);
    expect(seen.some((x) => /Public record the host may raise/.test(x.block))).toBe(true);
    // the same seed gives the same host in another process/save: the manner is a pure function of the persisted seed
    expect(registerWords(hostRegister(5))).toBe([...registers][0]);
  });
  it("is absent with the flag off, and for a game nobody played (byte-identical)", () => {
    const off = boot(5, false);
    toEviction(off, false);
    for (const { ev, block } of playOut(off)) { if (ev) expect(ev.host).toBeUndefined(); expect(block).not.toContain("HOST (production"); }
    const headless = boot(5, true, false);
    toEviction(headless, false);
    for (const { ev } of playOut(headless)) if (ev) expect(ev.host).toBeUndefined();
  });
  it("changes no outcome: the evictee and the eviction order match with the host off", () => {
    const run = (host: boolean): unknown => { const s = boot(11, host); toEviction(s, false); playOut(s); return [(s.live as LiveSeasonState).evictionOrder, (s.live as LiveSeasonState).active]; };
    expect(run(true)).toEqual(run(false));
  });
});
