import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { LiveSeasonState } from "../../src/engine/liveSeason";

// Feature 0210 C1 (ORW-667) - the host on eviction night. Roles only. Module-local state (one scenario at a time).
type Any = Record<string, any>;
let s: Any;
let seen: Array<{ ev: Any | null | undefined; block: string; pending: string | undefined }> = [];

function boot(playerNominated: boolean): void {
  s = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-hostbdd-")))).sandboxFor("u").session as unknown as Any;
  s.createCharacter({ playerName: "P", seed: 5 });
  s.noteMessage({ messageId: "m1" });
  s.scheduleGateBypass = true;
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
  (live as Any).hiddenSentinel = "SENTINEL_HIDDEN_FACT";
  seen = [];
}

function play(stopAtExitInterview: boolean, evictPlayer: boolean): void {
  for (let i = 0; i < 80; i++) {
    const live = s.live as LiveSeasonState;
    if (seen.length && !live.ceremony && !live.eviction && !live.pending) break;
    const p = live.pending as Any | undefined;
    if (stopAtExitInterview && p?.kind === "exit-interview") return;
    const target = p?.nominees ? (evictPlayer && p.nominees.includes(PLAYER) ? PLAYER : p.nominees.find((n: string) => n !== PLAYER) ?? p.nominees[0]) : undefined;
    if (p?.kind === "eviction-vote") s.submitDecision({ kind: "eviction-vote", vote: target });
    else if (p?.kind === "tie-break") s.submitDecision({ kind: "tie-break", vote: target });
    else if (p?.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", vote: "warm" });
    else if (p?.kind === "exit-interview") s.submitDecision({ kind: "exit-interview", vote: "gracious" });
    else if (p?.kind === "spectator-choice") s.submitDecision({ kind: "spectator-choice", vote: "watch" });
    else s.advanceGame();
    seen.push({ ev: s.getGameState().eviction, block: s.getMomentPrompt({}).hardConstraints ?? "", pending: (s.live as LiveSeasonState).pending?.kind });
  }
}

Given("a played season reaches an eviction night", () => boot(false));
When("the house votes and an evictee goes out the door", () => play(false, false));
Then("the host's manner is the same all night and carries no number", () => {
  const withHost = seen.filter((x) => x.ev?.host);
  assert.ok(withHost.length > 1, "host block missing");
  assert.equal(new Set(withHost.map((x) => x.ev!.host.register)).size, 1);
  assert.doesNotMatch(withHost[0]!.ev!.host.register, /\d/);
});
Then("the host is handed the open of the night, the public board, the reading and the count in the open", () => {
  const all = seen.map((x) => x.block).join("\n");
  assert.match(all, /HOST \(production's voice/);
  assert.match(all, /the house is gathered and the vote has not begun|the reading is under way/);
  assert.match(all, /Public board:/);
  assert.match(all, /The count, in the open:/);
});
Then("the host's questions are about public events and that houseguest's own choices", () => {
  const qs = [...new Set(seen.flatMap((x) => x.ev?.host?.questions ?? []))];
  assert.ok(qs.length > 0 && qs.length <= 3, "no host questions");
  for (const q of qs) assert.match(q, /on the block|Head of Household|held the veto|survived the block/);
});
Then("no hidden fact or ballot-caster reaches the host", () => {
  const dump = seen.map((x) => JSON.stringify(x.ev?.host ?? {}) + x.block.split("HOST (")[1]).join("\n");
  assert.doesNotMatch(dump, /SENTINEL|npc:/);
  assert.doesNotMatch(dump, /voted to evict/); // a ballot is read as "a vote to evict", never attributed
});

Given("a played season reaches an eviction night with the player on the block", () => boot(true));
When("the night plays out", () => play(true, false));
Then("the host is told the player's own public seat", () => {
  const roles = seen.flatMap((x) => x.ev?.host?.playerRoles ?? []);
  assert.ok(roles.includes("on the block"));
});
Then("the game never records an exit interview for the player that the player did not give", () => {
  const live = s.live as LiveSeasonState;
  const pending = live.pending as Any | undefined;
  // an evicted player is stopped at their own pending (the run halts there); the engine never fills it in
  assert.ok(pending?.kind === "exit-interview" || !(live.exitInterviews ?? []).some((e) => e.evictee === PLAYER));
});
