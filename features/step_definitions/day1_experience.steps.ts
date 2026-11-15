import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import {
  CASTING_FINALIZE_FLOOR, castingFinalizable, emptyIntake, mergeCastingUpdate,
} from "../../src/engine/castingIntake";
import { curiosityNeedle, CURIOSITY_NEEDLES, CURIOSITY_NEEDLE_INSTRUCTION } from "../../src/engine/curiosityNeedle";
import { ConsequenceEngine } from "../../src/engine/consequence";
import { RelationshipModel } from "../../src/engine/relationships";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { deriveNpcKnowledge } from "../../src/engine/diaryRoom";
import { npcExpress } from "../../src/engine/conversation";
import { chooseNominations } from "../../src/engine/season";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { answerPending, resolvePending } from "../support/answerPending";
import { playSeasonOutcome, type SeasonOutcome } from "../support/seasonOutcome";

/**
 * FEATURE 0111 — the Day-1 experience (roles only; the cast is procedurally generated).
 *
 * Five pillars, each tested STRUCTURALLY: casting probes the self (#905), the producer plants ONE
 * Vault-free curiosity needle (#909), house entry is fast + asymmetric so the first power arrives
 * quickly (#906), one early beat demonstrably folds a real read (#908), the Diary Room is enterable
 * on Day 1 (#907). The Vault Wall holds for player AND admin; the reframes are calibration-neutral.
 */

// A character-generating intake that is genuine CHARACTER (self-belief/tells) — NO declared kill-list.
// The optional `privateStrategy` is a player-only instinct, never a required committed target list.
const CHARACTER_INTAKE = {
  playerName: "The Interviewee",
  backstory: "grew up the underestimated one and learned to read a room before speaking",
  motivation: "to prove the quiet read wins over the loud move",
  personaArchetype: "the watcher who waits",
  personaStrategyStyle: "listen first, decide late",
} as const;

function bag(w: BbWorld): NonNullable<BbWorld["d1"]> {
  return (w.d1 ??= {});
}

function firstActiveNpc(sb: NonNullable<BbWorld["d1"]>["sandbox"]): EntityId {
  const active = sb!.session.getGameState().house.filter((h) => h.status === "active");
  return active[0]!.id;
}

/** Walk the player through the house until a houseguest is genuinely in their room (what the FE belt reads from whereabouts), and return them. */
function coPresentNpc(session: GameSessionAdapter): EntityId {
  let wa = session.whereabouts()!;
  for (const room of ["kitchen", "living room", "backyard", "bedroom A", "bedroom B", "bathroom", "HOH room", "dining room"]) {
    if (wa.present.length) break;
    wa = session.movePlayer(room) ?? wa;
  }
  assert.ok(wa.present.length > 0, "a houseguest is in the player's room");
  return wa.present[0]!.id;
}

/** Drive a started premiere sandbox to the FIRST crowned HOH, returning the winner's id. Bounded. */
function crownFirstHoh(session: GameSessionAdapter): string {
  for (let i = 0; i < 400; i++) {
    const st = session.gameStatus();
    if (st.hoh) return st.hoh.id;
    const v = session.advanceGame();
    if (v.pending) {
      resolvePending(v.pending, (req) => session.submitDecision(req));
    }
    if (v.finished) break;
  }
  return session.gameStatus().hoh?.id ?? "";
}

// --- Background ------------------------------------------------------------------

Given("a fresh player completing the casting interview into a new season", function (this: BbWorld) {
  const w = bag(this);
  w.seed = 111;
  w.reg = new GameSessionRegistry();
  w.user = "day1-user";
  w.sandbox = w.reg.sandboxFor(w.user);
  // Complete casting into a started season (the game opens in the premiere moment).
  w.sandbox.session.createCharacter({ ...CHARACTER_INTAKE, seed: w.seed });
  assert.equal(w.sandbox.session.getGameState().moment, "premiere");
});

// === Rule: Casting probes the self, not a declared strategy (#905) ================

When("the player completes the casting interview", function (this: BbWorld) {
  // The casting FRAMING is the same producer prompt every pre-game session sees.
  const w = bag(this);
  w.castPrompt = new GameSessionAdapter().getMomentPrompt({}).systemPrompt;
});

Then("the interview probes the player's self-belief and tells", function (this: BbWorld) {
  const p = bag(this).castPrompt!;
  // Probes the SELF (self-belief) and the TELLS…
  assert.match(p, /SELF-BELIEF/, "casting probes self-belief");
  assert.match(p, /THE TELLS/, "casting probes the tells");
  assert.match(p, /relationship to lying/i);
  // …and explicitly DROPS the declared kill-list (strategy is discovered live, not committed here).
  assert.match(p, /DISCOVERED live/i);
  assert.doesNotMatch(p, /Who do they cut, who do they keep, and when/);
});

Then("finalizing casting does not require a declared target list", function () {
  // The finalize floor is CHARACTER (name + backstory + motivation + one persona/strategy answer);
  // a declared kill-list (privateStrategy targets) is NEVER on it.
  assert.ok(!CASTING_FINALIZE_FLOOR.includes("privateStrategy"), "kill-list is not a finalize requirement");
  const intake = mergeCastingUpdate(emptyIntake(), { ...CHARACTER_INTAKE });
  assert.ok(castingFinalizable(intake), "character-only intake finalizes without a target list");
  // And createCharacter actually starts the season from that character-only intake.
  const s = new GameSessionAdapter();
  s.updateCasting({ ...CHARACTER_INTAKE });
  assert.equal(s.createCharacter({}).started, true, "the season starts with no declared kill-list");
});

Then("the recorded intake captures character, not a committed strategy", function () {
  // Every finalize-floor field is CHARACTER material — who they are, not a target board.
  for (const field of CASTING_FINALIZE_FLOOR) {
    assert.ok(["playerName", "backstory", "motivation"].includes(field), `finalize floor is character: ${field}`);
  }
  const s = new GameSessionAdapter();
  s.updateCasting({ ...CHARACTER_INTAKE });
  s.createCharacter({});
  const player = s.snapshot().house!.player;
  assert.equal(player.character.background, CHARACTER_INTAKE.backstory);
  assert.equal(player.motivation, CHARACTER_INTAKE.motivation);
});

// === Rule: The producer plants exactly one Vault-free curiosity needle (#909) =====

When("the producer frames the season during casting", function (this: BbWorld) {
  const w = bag(this);
  w.castPrompt = new GameSessionAdapter().getMomentPrompt({}).systemPrompt;
  w.needle = curiosityNeedle(w.seed ?? 111);
});

Then("exactly one curiosity needle signals that a hidden game exists", function (this: BbWorld) {
  const w = bag(this);
  const p = w.castPrompt!;
  // The casting framing carries the ONE-needle instruction, exactly once, and names the one-needle rule.
  assert.equal(p.indexOf("THE ONE CURIOSITY NEEDLE"), p.lastIndexOf("THE ONE CURIOSITY NEEDLE"), "exactly one needle instruction");
  assert.ok(p.includes("THE ONE CURIOSITY NEEDLE"), "the needle instruction is present");
  assert.match(p, /EXACTLY ONE/);
  // The needle line itself signals a hidden game already in motion.
  assert.match(w.needle!, /friction|carrying something|already .* in motion|playing a game|cast to collide|reads are already/i);
});

Then("the needle is sourced only from public or seeded framing", function (this: BbWorld) {
  const w = bag(this);
  // Deterministic off the seed (a public/seeded input), and always one of the fixed public pool lines.
  assert.equal(curiosityNeedle(w.seed ?? 111), w.needle);
  assert.ok(CURIOSITY_NEEDLES.includes(w.needle!), "the needle is from the public pool");
  // The instruction that produces it is Vault-free framing (facts to voice), not a script.
  assert.match(CURIOSITY_NEEDLE_INSTRUCTION, /public\/seeded framing|GENERIC/i);
});

// (The needle's Vault-freedom is pinned by tests/unit/curiosityNeedle.test.ts: it is a seed-only draw from the fixed public pool;
// a sentinel written to the Vault cannot reach a function that takes only a seed.)

// === Rule: The champagne circle meets the whole house at the toast (#906) ==========

Given("the producers convene the champagne circle at the premiere", function (this: BbWorld) {
  // The champagne circle fired at premiere entry (createCharacter): the engine deterministically
  // recorded the whole house as met at the toast. Capture the resulting tracker.
  bag(this).premiere = bag(this).sandbox!.session.premiereIntros()!;
});

Then("every houseguest is met at the champagne toast, with no manual roll-call", function (this: BbWorld) {
  const w = bag(this);
  const pr = w.premiere!;
  const active = w.sandbox!.session.getGameState().house.filter((h) => h.status === "active");
  // The whole house is met at the toast — nobody outstanding, no roll-call to grind through.
  assert.equal(pr.complete, true, "the whole house is met at the champagne toast");
  assert.deepEqual(pr.remaining, [], "no houseguest is left to introduce (no manual roll-call)");
  assert.equal(pr.metCount, active.length + 1, "every houseguest (and the player) is met");
});

Then("no houseguest is left invisible", function (this: BbWorld) {
  const w = bag(this);
  const pr = w.premiere!;
  const active = w.sandbox!.session.getGameState().house.filter((h) => h.status === "active").map((h) => h.id).sort();
  // Every active houseguest is accounted for on the premiere tracker — met at the circle, never absent.
  const accounted = [...pr.met.map((m) => m.houseguest.id), ...pr.remaining.map((r) => r.houseguest.id)].sort();
  assert.deepEqual(accounted, active, "every houseguest is met at the circle — nobody invisible");
});

Then("the first power is reachable the moment the toast is done", function (this: BbWorld) {
  const pr = bag(this).premiere!;
  assert.equal(pr.powerReachable, true, "the first power is reachable once the champagne circle has played");
  assert.equal(pr.complete, true, "reachable because the whole house is met at the toast (no roll-call)");
});

Then("the first power competition is a real seeded competition that is never gifted", function (this: BbWorld) {
  const w = bag(this);
  // Drive THIS started season to its first crowned HOH.
  w.firstHohWinnerA = crownFirstHoh(w.sandbox!.session);
  assert.ok(w.firstHohWinnerA.length > 0, "a first HOH is actually crowned by a competition");
  // Seeded / deterministic: a second season at the SAME seed crowns the SAME winner — the outcome is a
  // real seeded roll, not narration. Un-rigged: across seeds the player is NOT always handed the crown.
  const twin = new GameSessionRegistry().sandboxFor("day1-twin");
  twin.session.createCharacter({ ...CHARACTER_INTAKE, seed: w.seed });
  w.firstHohWinnerB = crownFirstHoh(twin.session);
  assert.equal(w.firstHohWinnerA, w.firstHohWinnerB, "same seed ⇒ same first HOH (seeded, deterministic)");
  const winners = new Set<string>();
  for (const seed of [11, 22, 33, 44, 55, 66]) {
    const s = new GameSessionRegistry().sandboxFor(`day1-rig-${seed}`);
    s.session.createCharacter({ ...CHARACTER_INTAKE, seed });
    winners.add(crownFirstHoh(s.session));
  }
  assert.ok(!(winners.size === 1 && winners.has(PLAYER)), "the first HOH is not gifted to the player every time");
});

// === Rule: One early social beat demonstrably folds a real read (#908) ============

Given("a Day-1 social beat between the player and a houseguest", function (this: BbWorld) {
  const w = bag(this);
  w.consequence = new ConsequenceEngine(new InMemoryEventStore(), new RelationshipModel(0.5), new SeededRandom(w.seed ?? 111));
  w.npc = npc(1);
  w.edgeBefore = { ...w.consequence.relationships().edge(w.npc, PLAYER) };
});

When("the player makes a consequential choice in that beat", function (this: BbWorld) {
  const w = bag(this);
  // The player betrays the houseguest in an early scene — recorded, and the engine folds its hidden
  // impact (0023). The fold is an unconditional property of `record`; whoever calls it (the model OR
  // the FE `_auto_record_scene` belt, 0055) triggers the SAME engine fold.
  w.consequence!.record({ initiator: PLAYER, witnessSet: [PLAYER, w.npc!], content: "a cold Day-1 betrayal", kind: "betrayal" });
  w.edgeAfter = { ...w.consequence!.relationships().edge(w.npc!, PLAYER) };
});

Then("the beat is recorded and folds a hidden first read", function (this: BbWorld) {
  const w = bag(this);
  assert.ok(w.consequence!.snapshot().events.some((e) => e.content.includes("Day-1 betrayal")), "the beat is recorded");
  assert.ok(w.edgeAfter!.trust < w.edgeBefore!.trust, "trust folded down");
  assert.ok(w.edgeAfter!.threat > w.edgeBefore!.threat, "threat folded up");
});

Then("the fold is guaranteed on the live game even when the model records nothing on a premiere turn", async function (this: BbWorld) {
  const w = bag(this);
  // A LIVE premiere game (the Background's), not two standalone engines. The model "under-calls": a premiere turn is taken
  // (its reads happen) and the model records NOTHING. Then the FE belt (`_auto_record_scene`, 0055; proven in Python by
  // frontend/tests/test_a10_forced_advance_records_scene.py) makes its one engine call — `recordInteraction` with initiator
  // "player", the witness set [player, ...ids] and the proposed `kind` — which we drive here through the player's MCP tool.
  const sb = w.sandbox!;
  // The toast is over (the premiere moment continues in free roam, before the premiere exit). The belt only ever names a houseguest the
  // engine's whereabouts places WITH the player, so find a room where one genuinely is.
  sb.session.advanceGame();
  assert.equal(sb.session.getGameState().moment, "premiere", "still the premiere moment");
  const target = coPresentNpc(sb.session);
  const edgeOf = () => JSON.stringify(sb.engine.relationships.edge(target, PLAYER)); // test seam only; never shown to the player
  const before = { ...sb.engine.relationships.edge(target, PLAYER) };
  const beforeJson = edgeOf();
  const eventsBefore = sb.engine.events.queryAll().length;

  // The premiere turn the model took: it narrated (reads only) and recorded nothing.
  sb.session.getGameState();
  sb.session.getMomentPrompt({ moment: "premiere" });
  sb.session.whereabouts();
  assert.equal(sb.engine.events.queryAll().length, eventsBefore, "a premiere turn that records nothing adds no event");
  assert.equal(edgeOf(), beforeJson, "with nothing recorded, no first read has folded");

  // The belt path: the live adapter's recordInteraction, exactly the belt's request shape.
  const ack = (await sb.mcp.player.callTool("recordInteraction", {
    initiator: PLAYER, witnessSet: [PLAYER, target], content: "a cold Day-1 betrayal", kind: "betrayal",
  })) as { eventId: string };
  assert.ok(ack.eventId, "the belt's record returns the event id");

  const after = { ...sb.engine.relationships.edge(target, PLAYER) };
  assert.notEqual(edgeOf(), beforeJson, "the first-read edge between the houseguest and the player moved");
  assert.ok(after.trust <= before.trust && after.threat >= before.threat, "a betrayal never warms the read: trust did not rise, threat did not fall");
  assert.ok(after.trust < before.trust || after.threat > before.threat, "and it genuinely cooled it (trust fell or threat rose)");

  // The fold is invisible: the player-facing ack, state and visible projection carry no relationship number.
  const surface = JSON.stringify(ack) + JSON.stringify(sb.session.getGameState()) + JSON.stringify(sb.player.getVisibleState());
  assert.doesNotMatch(surface, /"trust"|"affinity"|"threat"/, "the first read is never shown to the player");
});

Then("the change is recalled later only as observable behavior, never as a number", function (this: BbWorld) {
  const w = bag(this);
  // Later behavior reflects the fold — the wronged houseguest, as HOH, targets the player…
  const rel = w.consequence!.relationships();
  const noms = chooseNominations(w.npc!, [w.npc!, PLAYER, npc(2), npc(3)], rel);
  assert.ok(noms.includes(PLAYER), "the wronged houseguest later targets the player (behavior, not a number)");
  // …but no player-facing surface ever shows a number or a relationship word.
  const surface = JSON.stringify(w.sandbox!.session.getGameState()) + w.sandbox!.session.getMomentPrompt({ moment: "premiere" }).systemPrompt;
  assert.doesNotMatch(surface, /"trust"|"affinity"|"threat"/, "no relationship number crosses to the player");
});

Given("a Day-1 with no consequential social beat taken", function (this: BbWorld) {
  const w = bag(this);
  // PAT-3: two REAL sandboxes at the same seed. The baseline first day is left untouched; the other has the player's Day-1
  // surfaces read (the premiere moment prompt, the game state, the status — not the Diary Room or needle) but records NO beat. If any Day-1
  // reframe folded something on read, the hidden relationship layer would differ from the untouched baseline.
  const seed = w.seed ?? 111;
  const rels = (sb: ReturnType<GameSessionRegistry["sandboxFor"]>): string => JSON.stringify(sb.engine.relationships.serialize());
  const baseline = new GameSessionRegistry().sandboxFor("day1-fold-baseline");
  baseline.session.createCharacter({ ...CHARACTER_INTAKE, seed });
  const read = new GameSessionRegistry().sandboxFor("day1-fold-read");
  read.session.createCharacter({ ...CHARACTER_INTAKE, seed });
  read.session.getMomentPrompt({ moment: "premiere" });
  read.session.getMomentPrompt({});
  read.session.getGameState();
  read.session.gameStatus();
  w.baselineRel = rels(baseline);
  w.noBeatRel = rels(read);
  assert.ok(w.baselineRel.length > 100, "the baseline relationship layer is a real move-in layer, not empty");
});

Then("the relationship folds are byte-identical to the baseline first day", function (this: BbWorld) {
  const w = bag(this);
  assert.equal(w.noBeatRel, w.baselineRel, "no beat ⇒ reading Day-1 folds nothing: byte-identical to the untouched first day");
});

// === Rule: The Diary Room is an enterable room on Day 1 (#907) ====================

When("the player enters the Diary Room on Day 1 through the live diaryRoom tool", async function (this: BbWorld) {
  const w = bag(this);
  // Still the premiere moment (before any week-1 nomination). The player vents in the DR through the LIVE tool.
  assert.equal(w.sandbox!.session.getGameState().moment, "premiere");
  w.drConfession = "day-1 confession: I already don't trust the loud one, but I'll play nice.";
  w.drResult = await w.sandbox!.mcp.player.callTool("diaryRoom", { entry: w.drConfession });
});

Then("the Diary Room is available as a room before week-one nominations", function (this: BbWorld) {
  const w = bag(this);
  // Enterable on Day 1: the live tool accepted the entry while the premiere is running, before any HOH or nomination.
  assert.equal((w.drResult as { recorded?: boolean } | null)?.recorded, true, "the live diaryRoom tool accepted the Day-1 entry"); // A29: a committing tool also echoes the post-commit beatSeq
  const st = w.sandbox!.session.getGameState();
  assert.equal(st.moment, "premiere", "still the premiere moment");
  assert.equal(w.sandbox!.session.gameStatus().hoh, null, "no HOH yet");
  assert.deepEqual(w.sandbox!.session.gameStatus().nominees, [], "before week-one nominations");
  assert.ok((st.playerDiaryRoom ?? []).includes(w.drConfession!), "the entry shows in the player's own diary-room list");
});

Then("the confessional is the player's own knowledge", function (this: BbWorld) {
  const w = bag(this);
  const own = w.sandbox!.player.getVisibleState().knowledge.map((k) => k.content);
  assert.ok(own.includes(w.drConfession!), "the confessional landed as the player's knowledge");
  assert.ok(w.sandbox!.engine.knowledge.knownTo(PLAYER).some((k) => k.content === w.drConfession), "and in the player's knowledge store");
});

Then("nothing said in the Diary Room reaches any houseguest's behavior", function (this: BbWorld) {
  const w = bag(this);
  // The DR → NPC wall (0013): DR content is stripped from any NPC-knowledge derivation, no NPC knows it,
  // and it can play no part in an NPC's reasoning.
  const k = w.sandbox!.engine.knowledge;
  assert.ok(!deriveNpcKnowledge(k.knownTo(PLAYER)).some((f) => f.content === w.drConfession), "DR is stripped from NPC derivation");
  for (const hg of w.sandbox!.session.getGameState().house.filter((h) => h.status === "active")) {
    assert.ok(!k.knownTo(hg.id).some((f) => f.content === w.drConfession), "no houseguest knows the DR content");
    assert.equal(npcExpress({ content: w.drConfession! }, k.knownTo(hg.id), k.suspicionsOf(hg.id)).mode, "silent", "DR informs no NPC reasoning");
  }
});

Then("the Diary Room entry witnesses only the player", function (this: BbWorld) {
  const w = bag(this);
  const dr = w.sandbox!.engine.events.queryAll().filter((e) => e.type === "diary-room");
  assert.equal(dr.length, 1, "exactly the one Day-1 entry was recorded");
  assert.deepEqual(dr[0]!.witnessSet, [PLAYER], "no houseguest witnessed the entry");
});

// === Rule: The Vault Wall holds for player AND admin ==============================

Given("the player has finished a Day-1 with a curiosity needle and a consequential beat", async function (this: BbWorld) {
  const w = bag(this);
  w.needle = curiosityNeedle(w.seed ?? 111);
  w.sentinels = ["SENTINEL-0111-vault", "SENTINEL-0111-soul", "SENTINEL-0111-hidden"];
  // Poison every hidden surface.
  w.sandbox!.engine.vault.writeHidden({ id: "d1:vw", kind: "confessional", content: w.sentinels[0]! });
  const core = w.sandbox!.session.snapshot();
  core.house!.npcs[0]!.soul.memory.push(w.sentinels[1]!);
  core.house!.npcs[0]!.character.hiddenElements.push({ kind: "secret-motive", detail: w.sentinels[2]! });
  w.sandbox!.session.restore(core);
  // A Day-1 consequential beat folds a hidden read on the LIVE sandbox (through the same engine path).
  const target = firstActiveNpc(w.sandbox);
  w.sandbox!.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, target], content: "a Day-1 betrayal", kind: "betrayal" });
  // A Day-1 DR confession, too.
  w.drConfession = "day-1 DR: my real read on the house.";
  await w.sandbox!.mcp.player.callTool("diaryRoom", { entry: w.drConfession });
});

When("the Day-1 player-facing and admin-facing projections are assembled", function (this: BbWorld) {
  const w = bag(this);
  w.sandbox!.syncAdmin();
  w.playerSurface = JSON.stringify(w.sandbox!.session.getGameState())
    + w.sandbox!.session.getMomentPrompt({ moment: "premiere" }).systemPrompt
    + (w.needle ?? "");
  w.adminSurface = JSON.stringify(w.sandbox!.admin.inspect());
});

Then("the curiosity needle exposes no specific hidden fact on either surface", function (this: BbWorld) {
  const w = bag(this);
  for (const s of w.sentinels!) {
    assert.ok(!w.needle!.includes(s), `the needle must not carry ${s}`);
    assert.ok(!w.playerSurface!.includes(s), `player surface must not leak ${s}`);
    assert.ok(!w.adminSurface!.includes(s), `admin surface must not leak ${s}`);
  }
});

Then("no number from the consequence fold appears on either surface", function (this: BbWorld) {
  const w = bag(this);
  for (const [name, surface] of [["player", w.playerSurface!], ["admin", w.adminSurface!]] as const) {
    assert.doesNotMatch(surface, /"trust"|"affinity"|"threat"|"confidence"/, `${name} surface carries no relationship number`);
  }
});

Then("the Diary Room exposes no pathway from the player's confession to any NPC", function (this: BbWorld) {
  const w = bag(this);
  const k = w.sandbox!.engine.knowledge;
  assert.ok(!deriveNpcKnowledge(k.knownTo(PLAYER)).some((f) => f.content === w.drConfession), "DR stripped from NPC derivation");
  for (const hg of w.sandbox!.session.getGameState().house.filter((h) => h.status === "active")) {
    assert.ok(!k.knownTo(hg.id).some((f) => f.content === w.drConfession), "no NPC pathway from the DR confession");
  }
  // And the live entry's witness set is the player alone — no event carries it to any houseguest.
  const dr = w.sandbox!.engine.events.queryAll().filter((e) => e.type === "diary-room");
  assert.ok(dr.length >= 1, "the Day-1 DR entry was recorded through the live tool");
  for (const e of dr) assert.deepEqual(e.witnessSet, [PLAYER], "the DR event witnesses only the player");
});

// === Rule: With the in-game clock on, Day 1 has a social morning before the first HOH (P4b) ===
// (The exact ~48-message count of the morning block is asserted by the time-stack spec, not here.)

Given("a new Day-1 premiere with the in-game clock on", function (this: BbWorld) {
  const w = bag(this);
  // The Background's clock-off game is not used here: this scenario needs its own clock-on premiere. The `After` hook in
  // in_game_time_sleep.steps.ts restores the clock override to env after every scenario.
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor("day1-clock-on");
  sb.session.createCharacter({ ...CHARACTER_INTAKE, seed: 7 });
  sb.session.setPerConversationClockEnabled(true);
  // Production wiring: a recorded scene is a committed player turn, which is what paces the per-conversation clock.
  const orch = new Orchestrator(reg, new FakeClock(), { seed: 7, turnDriven: true, auxTicksNever: true });
  reg.setCommit((u) => orch.commitPlayerTurn(u));
  reg.setOnReset((u) => orch.forgetUser(u));
  w.sandbox = sb;
  w.fm = { session: sb.session };
});

Then("the toast seats and pins the whole house", function (this: BbWorld) {
  const { session } = bag(this).fm!;
  const active = session.getGameState().house.filter((h) => h.status === "active");
  const pr = session.premiereIntros()!;
  assert.equal(pr.champagneCircle, "gathered", "the toast is gathered");
  assert.equal(pr.complete, true, "the whole house is met at the toast");
  assert.equal(pr.metCount, active.length + 1, "every houseguest (and the player) is met");
  const wa = session.whereabouts()!;
  assert.equal(wa.houseEvent?.kind, "champagne-circle", "the toast is a house event");
  assert.equal(wa.nearby.length, 0, "nobody is out of the circle");
  assert.deepEqual(wa.present.map((p) => p.id).sort(), active.map((h) => h.id).sort(), "the whole house is seated together");
  session.movePlayer("kitchen");
  assert.equal(session.whereabouts()!.room, wa.room, "the player is pinned to the toast: a walk-off is a no-op");
});

When("the toast closes", function (this: BbWorld) {
  const fm = bag(this).fm!;
  const close = fm.session.advanceGame();
  assert.equal(close.pending ?? null, null, "closing the toast raises no decision");
  assert.equal(fm.session.getGameState().phase, "premiere", "the toast close does not leave the premiere");
});

When("the player socializes into the first night", function (this: BbWorld) {
  const fm = bag(this).fm!;
  for (let i = 0; i < 70; i++) fm.session.noteMessage({ messageId: `night-${i}` }); // the clock started at the afternoon entry; ~5 in-game minutes a message
  const live = fm.session.snapshot().live!;
  assert.ok((live.nightDepth ?? 0) > 20, "it is the premiere night");
  assert.equal(live.timeOfDay, "night");
  fm.hour = live.nightDepth;
});

Then("the premiere exit moves no time and rolls no night", function (this: BbWorld) {
  const fm = bag(this).fm!;
  for (let i = 0; i < 3; i++) {
    const v = fm.session.advanceGame();
    assert.ok(v.held, "the exit is held: the night is the player's to spend");
    assert.equal(v.event ?? null, null, "no overnight beat");
    assert.equal(v.pending ?? null, null, "no competition card on the first night");
  }
  const live = fm.session.snapshot().live!;
  assert.equal(live.nightDepth, fm.hour, "advancing moved no time");
  assert.equal(live.dayNumber ?? 1, 1, "still Day 1");
});

Then("the first HOH has not fired and is not yet due", function (this: BbWorld) {
  const { session } = bag(this).fm!;
  assert.equal(session.gameStatus().hoh, null, "no HOH is crowned");
  assert.equal(session.milestoneDue(), false, "the HOH is not due on the first night");
  // A7 (#2078) added `minutesUntil` to the schedule view; the claim here is WHICH event, WHEN, and that it is not due - not the countdown, so compare those fields.
  const ds = session.getGameState().daySchedule as { next?: string; phase?: string; due?: boolean; minutesUntil?: number } | undefined;
  assert.deepEqual({ next: ds?.next, phase: ds?.phase, due: ds?.due }, { next: "hoh-competition", phase: "afternoon", due: false });
  assert.ok(typeof ds?.minutesUntil === "number", "the countdown to the scheduled hour is reported (ORW-116: on the first night the afternoon slot is tomorrow, so it is not asserted positive)");
});

When("the player turns in for the premiere night", function (this: BbWorld) {
  bag(this).fm!.session.turnIn();
});

Then("it is Day 2 and the first HOH is not due in the morning", function (this: BbWorld) {
  const { session } = bag(this).fm!;
  const live = session.snapshot().live!;
  assert.equal(live.dayNumber, 2, "it is Day 2");
  assert.equal(session.gameStatus().hoh, null, "no HOH is crowned at dawn");
  assert.equal(session.milestoneDue(), false, "the HOH is not due in the morning");
});

When("the player spends the morning block in social scenes", function (this: BbWorld) {
  const sb = bag(this).sandbox!;
  // The player turned in at night, so they wake before 8am with most of the house asleep: the morning passes as player messages (5 in-game minutes each).
  for (let t = 0; t < 200 && !sb.session.milestoneDue(); t++) {
    // The HOH must still be unfired at every message of the morning block.
    assert.equal(sb.session.gameStatus().hoh, null, "no HOH fires while the morning block is being spent");
    sb.session.noteMessage({ messageId: `morning-${t}` });
  }
});

Then("the first HOH is now due in the afternoon", function (this: BbWorld) {
  const { session } = bag(this).fm!;
  assert.equal(session.milestoneDue(), true, "the morning block is spent: the HOH is due");
  assert.equal(session.getGameState().daySchedule!.due, true, "the view flag says due");
  assert.ok((session.inGameHour() ?? 0) >= 12 - 1e-6, "it is the afternoon");
  assert.equal(session.gameStatus().hoh, null, "being due does not crown anyone by itself");
});

Then("the first HOH fires only once it is due, and the day-break never repeats", function (this: BbWorld) {
  const { session } = bag(this).fm!;
  const first = session.advanceGame();
  assert.notEqual(first.event?.beat, "day-break", "the day-break is one-shot: the next advance starts the HOH");
  assert.ok(
    first.pending?.kind === "comp-round" || first.event?.beat === "hoh-competition" || first.event?.beat === "comp-elimination",
    "the next advance is where the first HOH competition begins",
  );
  const hohId = crownFirstHoh(session);
  assert.ok(hohId.length > 0, "a first HOH is crowned by the afternoon competition");
  assert.equal(session.gameStatus().week, 1, "the first HOH is the week-1 HOH");
});

// === Rule: Day-1 is deterministic and calibration-neutral =========================

Given("a full season is played with the Day-1 reframes inactive", function (this: BbWorld) {
  const w = bag(this);
  // PAT-3: "inactive" = the Day-1 surfaces (premiere prompt, game state, status) are never read; the baseline season. The
  // other season reads every Day-1 surface up front, THEN plays. Same seed, a real compare of the protected outcome.
  const play = (readDay1: boolean, user: string): SeasonOutcome => {
    const sb = new GameSessionRegistry().sandboxFor(user);
    sb.session.createCharacter({ ...CHARACTER_INTAKE, seed: w.seed });
    if (readDay1) {
      sb.session.getMomentPrompt({ moment: "premiere" });
      sb.session.getGameState();
      sb.session.gameStatus();
    }
    return playSeasonOutcome(sb.session);
  };
  w.seasonBaseline = play(false, "day1-season-baseline");
  w.seasonRead = play(true, "day1-season-read");
});

Then("the seeded competition and eviction outcomes are byte-identical to the baseline season", function (this: BbWorld) {
  const w = bag(this);
  assert.ok((w.seasonBaseline!.evictionOrder as unknown[]).length > 5, "a real multi-eviction season was played");
  assert.deepStrictEqual(w.seasonRead, w.seasonBaseline, "reading Day-1 must not move the seeded spine");
});
