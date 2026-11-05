import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbWorld } from "../support/world";
import { ConsequenceEngine } from "../../src/engine/consequence";
import { RelationshipModel } from "../../src/engine/relationships";
import { nominationPlan } from "../../src/engine/season";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { startLiveSweep, setLive, liveOf as sweepLiveOf, livePlayerSurfaces, livePlayerProse, livePlayerProjections } from "../support/liveSweep";
import { assertNoNumericRelationshipFields, assertNoRelationshipValueProse, assertNoOpinionChangedProse } from "../support/relationshipLeakChecks";
import { resolveLegally } from "../support/liveDecision";

// Reuses: "a running game sandbox with a fully populated Producer's Vault" (Background),
// "any player-facing surface is produced" (vault_wall), "no Vault sentinel value appears" (god_mode).
//
// PAT-5 (#1982): `ConsequenceEngine` / `restoreMemory` (src/engine/consequence.ts) have NO production caller.
// The live game folds a player action's hidden impact through `EngineCommandsAdapter.recordInteraction`
// (sharing `foldHiddenImpact`) into `sb.engine.relationships` / `sb.engine.events`, and persists/resumes through
// the registry's `snapshot` / `restore` / `FileSaveStore`. These scenarios therefore drive THAT live path, except
// "Wins and votes are recorded and consequential" (the live game records wins/votes as `house-event`s with its own
// folds, never via `recordCompetitionWin`/`recordVoteAgainstPlayer`), which keeps the standalone engine and is
// tagged @standalone-module in the feature.

function freshEngine(seed = 1): ConsequenceEngine {
  return new ConsequenceEngine(new InMemoryEventStore(), new RelationshipModel(0.5), new SeededRandom(seed));
}

// --- the LIVE game under test (per scenario) ------------------------------------

interface Live { reg: GameSessionRegistry; user: string; sb: UserSandbox; mates: EntityId[]; ally?: EntityId; eventsBefore?: unknown[]; edgesBefore?: unknown; }
const lives = new WeakMap<object, Live>();
/** The hidden edge as it stood at move-in, before any fold — so a persistence check can prove a REAL (non-baseline) read survived. */
const baselines = new WeakMap<object, Edge>();
const liveOf = (w: BbWorld): Live => lives.get(w)!;
type Edge = { trust: number; affinity: number; threat: number };

function startLive(w: BbWorld, seed: number, reg = new GameSessionRegistry()): Live {
  const user = `pat5-${seed}`;
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "Player One", seed });
  const live: Live = { reg, user, sb, mates: sb.session.snapshot().house!.npcs.map((n) => n.id) };
  lives.set(w, live);
  return live;
}
const interact = (l: Live, mate: EntityId, kind: string, content: string): void => {
  l.sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, mate], content, kind, toward: [mate] });
};
const edge = (l: Live, mate: EntityId): Edge => ({ ...l.sb.engine.relationships.edge(mate, PLAYER) });
/** The live save -> resume path: export the registry snapshot (JSON, as the disk store writes it) into a NEW registry. */
function reloadLive(w: BbWorld): Live {
  const l = liveOf(w);
  const snap = JSON.parse(JSON.stringify(l.reg.snapshot(l.user)));
  const reg2 = new GameSessionRegistry();
  const sb = reg2.restore(l.user, snap);
  const next: Live = { ...l, reg: reg2, sb };
  lives.set(w, next);
  return next;
}
const eventsOf = (l: Live): unknown[] => JSON.parse(JSON.stringify(l.sb.engine.events.queryAll()));
const edgesOf = (l: Live): unknown => JSON.parse(JSON.stringify(l.sb.engine.relationships.serialize()));

// --- (the helpers above drive the LIVE game) ---

// --- An action changes the hidden opinion (LIVE seam) -----------------------------

Given("an NPC's hidden read of the player", function (this: BbWorld) {
  const l = startLive(this, 1);
  this.npc = l.mates[0]!;
  this.relBefore = { ...l.sb.engine.relationships.edge(this.npc, PLAYER) };
});

When("the player has a warm, bonding interaction with that NPC", function (this: BbWorld) {
  interact(liveOf(this), this.npc!, "bonding", "a warm kitchen chat");
});

Then("the NPC's hidden trust and affinity toward the player increase", function (this: BbWorld) {
  const e = edge(liveOf(this), this.npc!);
  assert.ok(e.trust > this.relBefore!.trust, "trust up");
  assert.ok(e.affinity > this.relBefore!.affinity, "affinity up");
  this.relBefore = { ...liveOf(this).sb.engine.relationships.edge(this.npc!, PLAYER) }; // baseline for the betrayal step
});

When("the player betrays that NPC", function (this: BbWorld) {
  interact(liveOf(this), this.npc!, "betrayal", "a cold betrayal");
});

Then("the NPC's hidden trust drops and their hidden threat read rises", function (this: BbWorld) {
  const e = edge(liveOf(this), this.npc!);
  assert.ok(e.trust < this.relBefore!.trust, "trust dropped");
  assert.ok(e.threat > this.relBefore!.threat, "threat rose");
});

Then("the same actions under the same seed produce the same shifts", function (this: BbWorld) {
  const run = (): Edge => {
    const l = startLive(this, 1);
    interact(l, l.mates[0]!, "bonding", "a warm kitchen chat");
    interact(l, l.mates[0]!, "betrayal", "a cold betrayal");
    return edge(l, l.mates[0]!);
  };
  const first = run();
  assert.deepEqual(run(), first);
});


// --- Persistence: lossless, monotonic (LIVE registry snapshot -> restore) -----------

Given("a game with many recorded events", function (this: BbWorld) {
  const l = startLive(this, 2);
  const [a, b, c] = l.mates;
  interact(l, a!, "strategy", "scheme");
  interact(l, b!, "gossip", "off-screen plot");
  for (let i = 0; i < 3; i++) interact(l, c!, "bonding", "bond");
  l.eventsBefore = eventsOf(l);
});

When("the game is saved and reloaded from the long-term store", function (this: BbWorld) {
  reloadLive(this);
});

Then("every event's content, witnesses, hidden flag, timestamp, and kind survive unchanged", function (this: BbWorld) {
  assert.deepEqual(eventsOf(liveOf(this)), liveOf(this).eventsBefore);
});

Then("the total event count after reload is at least what it was before", function (this: BbWorld) {
  assert.ok(eventsOf(liveOf(this)).length >= liveOf(this).eventsBefore!.length);
});

Then("no event detail is thinned or dropped", function (this: BbWorld) {
  assert.equal(eventsOf(liveOf(this)).length, liveOf(this).eventsBefore!.length);
});

// --- Recall after leaving / restart -------------------------------------------

Given("the player wronged a houseguest several weeks ago", function (this: BbWorld) {
  const l = startLive(this, 3);
  const [wronged, ally] = l.mates;
  this.npc = wronged!;
  l.ally = ally!;
  baselines.set(this, edge(l, wronged!));
  interact(l, wronged!, "betrayal", "an old betrayal");
  for (let i = 0; i < 5; i++) interact(l, ally!, "alliance", "alliance");
  l.eventsBefore = eventsOf(l);
  this.relBefore = { ...l.sb.engine.relationships.edge(wronged!, PLAYER) };
});

When("the player leaves and the game is reloaded from the long-term store", function (this: BbWorld) {
  reloadLive(this);
});

Then("the full event history is restored", function (this: BbWorld) {
  assert.deepEqual(eventsOf(liveOf(this)), liveOf(this).eventsBefore);
});

Then("that houseguest's hidden read of the player equals what it was before leaving", function (this: BbWorld) {
  const after = liveOf(this).sb.engine.relationships.edge(this.npc!, PLAYER);
  assert.deepEqual(after, this.relBefore);
  // ...and that read is the soured one, not merely the move-in baseline (a restore that lost the fold would also be "equal" to a baseline).
  assert.ok(after.trust < baselines.get(this)!.trust, "the wronged houseguest's trust is still below its move-in level");
});

Then("an alliance the player built is still intact", function (this: BbWorld) {
  assert.ok(liveOf(this).sb.engine.relationships.bondStrength(liveOf(this).ally!, PLAYER) > 0.5, "the alliance bond survived");
});

// --- Restart (a NEW registry over the SAME on-disk store) ------------------------

Given("a game persisted to the long-term store", function (this: BbWorld) {
  this.saveDir = mkdtempSync(join(tmpdir(), "orwell-0023-"));
  const l = startLive(this, 4, new GameSessionRegistry(new FileSaveStore(this.saveDir)));
  baselines.set(this, edge(l, l.mates[0]!));
  for (let i = 0; i < 4; i++) interact(l, l.mates[0]!, "bonding", "bond"); // every mutation commits a durable save
  l.eventsBefore = eventsOf(l);
  l.edgesBefore = edgesOf(l);
});

When("the engine process is restarted and the game is loaded fresh", function (this: BbWorld) {
  const l = liveOf(this);
  const reg2 = new GameSessionRegistry(new FileSaveStore(this.saveDir!)); // brand-new process state, same disk
  lives.set(this, { ...l, reg: reg2, sb: reg2.sandboxFor(l.user) });
});

Then("the events and the hidden relationship state are restored as a superset", function (this: BbWorld) {
  assert.ok(eventsOf(liveOf(this)).length >= liveOf(this).eventsBefore!.length);
  assert.deepEqual(edgesOf(liveOf(this)), liveOf(this).edgesBefore);
  const l = liveOf(this);
  assert.ok(edge(l, l.mates[0]!).trust > baselines.get(this)!.trust, "the warmed read survived the restart, not just the move-in baseline");
});

// --- A hidden change drives behavior ------------------------------------------

Given("the player has quietly earned a houseguest's distrust", function (this: BbWorld) {
  const l = startLive(this, 5);
  this.npc = l.mates[0]!;
  // Enough betrayals that the player outranks every other houseguest on this HOH's hidden threat read.
  for (let i = 0; i < 6; i++) interact(l, this.npc, "betrayal", "a quiet betrayal");
});

/** The LIVE nomination function (0044) for this HOH, over the live roster with the player listed LAST (so a ranking that
 *  ignores the hidden read cannot "find" the player just by list order). */
const planFor = (l: Live, hoh: EntityId): ReturnType<typeof nominationPlan> =>
  nominationPlan(hoh, [...l.mates, PLAYER], l.sb.engine.relationships);
const plans = new WeakMap<object, ReturnType<typeof nominationPlan>>();

When("houseguest behavior is resolved later", function (this: BbWorld) {
  const l = liveOf(this);
  const plan = planFor(l, this.npc!); // the live nomination function, not the test-only `chooseNominations`
  plans.set(this, plan);
  this.noms = plan.nominees;
});

Then("that houseguest is more likely to seek the player out warily or target them", function (this: BbWorld) {
  const l = liveOf(this);
  assert.equal(plans.get(this)!.target, PLAYER, "the distrustful HOH's TARGET is the player");
  assert.ok(this.noms!.includes(PLAYER), "and the player is on the block");
  // Control: the SAME house (same seed, same HOH) WITHOUT the betrayals does not make the player the target, so it is the
  // hidden opinion, not roster order or a constant, that drives the choice.
  const control = startLive(this, 5);
  assert.notEqual(planFor(control, control.mates[0]!).target, PLAYER, "without the betrayals the player is not the HOH's target");
  lives.set(this, l); // back to the scenario's own game
});

Then("this happens without any opinion value ever being shown to the player", function (this: BbWorld) {
  // The same two layers as the PAT-2 sweep: the structured walk over the live projections, and the full prose backstop
  // (trust/affinity/threat/opinion/relationship bound to a number, in any rendered form — not just `key: number`).
  const sb = liveOf(this).sb;
  assertNoNumericRelationshipFields(livePlayerProjections(sb));
  assertNoRelationshipValueProse(livePlayerProse(sb));
});

// --- The whole loop, end to end -----------------------------------------------

Given("a multi-step game of conversations, a competition, and a vote", function (this: BbWorld) {
  // A live season: real conversations through the command seam, then the live loop runs its own
  // competitions and votes (advanceGame) until the house has voted at least once.
  const l = startLive(this, 6);
  // A11: a chat during the gathered champagne circle is now a real witnessed record (the witness grounding reads the same whole-house overlay the player sees), so the ten scenes below would
  // all fold at once, before the house has settled. Close the circle first (a pure close earns no tick), as the real game does, so this scenario measures the settled loop it is about.
  l.sb.session.advanceGame();
  const [ally, wronged] = l.mates;
  l.ally = ally!;
  this.npc = wronged!;
  for (let i = 0; i < 4; i++) interact(l, ally!, "bonding", "bond");
  // Enough betrayals that the player outranks every other houseguest on the wronged one's hidden threat read (the live week
  // that follows adds its own folds, which must not undo that).
  for (let i = 0; i < 6; i++) interact(l, wronged!, "betrayal", "betrayal");
  const startWeek = l.sb.session.snapshot().week;
  for (let i = 0; i < 3000 && l.sb.session.snapshot().week === startWeek; i++) {
    const v = l.sb.session.advanceGame();
    if (v.finished) break;
    if (v.pending) resolveLegally(l.sb, v.pending);
  }
  assert.ok(l.sb.session.snapshot().week > startWeek, "the live loop ran a full week (competition + vote)");
});

When("everything is recorded, applied, saved, and reloaded", function (this: BbWorld) {
  const l = liveOf(this);
  l.eventsBefore = eventsOf(l);
  l.edgesBefore = edgesOf(l);
  reloadLive(this);
});

Then("the house's later behavior is consistent with everything that happened", function (this: BbWorld) {
  const l = liveOf(this);
  // The reloaded live game reads exactly as the saved one did: the same hidden edges, and so the same behavior.
  assert.deepEqual(edgesOf(l), l.edgesBefore);
  const r = l.sb.engine.relationships;
  assert.ok(r.bondStrength(l.ally!, PLAYER) > r.bondStrength(this.npc!, PLAYER), "the bonded ally reads warmer than the betrayed houseguest");
  // ...and the betrayed houseguest, as HOH, targets the player: the LIVE nomination function over the reloaded game's
  // hidden relationship model (player listed LAST, so roster order cannot "find" them).
  const plan = planFor(l, this.npc!);
  assert.equal(plan.target, PLAYER, "the betrayed houseguest's nomination TARGET is the player");
  assert.ok(plan.nominees.includes(PLAYER), "and the player is on the block");
});

Then("nothing the player legitimately changed was lost", function (this: BbWorld) {
  // Superset, never a thinning (0007/0023): every persisted event is preserved exactly, and the full edge set matches.
  assert.deepEqual(eventsOf(liveOf(this)), liveOf(this).eventsBefore);
  assert.deepEqual(edgesOf(liveOf(this)), liveOf(this).edgesBefore);
});

// --- The change is invisible --------------------------------------------------

When("the player's action shifts a houseguest's hidden opinion", function (this: BbWorld) {
  // PAT-2: drive the action through the LIVE game's own command seam (which folds the hidden opinion in the
  // engine's relationship model), with sentinels planted in that game's hidden state. The reused
  // "no Vault sentinel value appears" sweep then reads THAT game's surfaces (not a fresh engine's/the canary's).
  const live = startLiveSweep({ seed: 1, user: "pat2-opinion" });
  setLive(this, live);
  const mate = live.sb.session.snapshot().house!.npcs[0]!.id;
  live.sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, mate], content: "a chat", kind: "bonding", toward: [mate] });
  // ONE moment-prompt read for the whole scenario: getMomentPrompt consumes the one-shot Producer Read, so the
  // sentinel sweep, the structured walk and the prose backstop must all look at this same prompt.
  live.momentPrompt = live.sb.session.getMomentPrompt({});
  this.lastView = livePlayerSurfaces(live.sb, live.momentPrompt);
});

/** The live game this scenario drove — the PAT-2 sweep game or this file's own live game (both carry `.sb`). */
const drivenLive = (w: BbWorld): { sb?: any; momentPrompt?: any } | undefined => sweepLiveOf(w) ?? lives.get(w);
/** The text to prose-sweep: the live game's ENGINE-GENERATED player text (the moment prompt's fixed instruction template is cut out; its dynamic context is swept). */
const proseOf = (w: BbWorld): string => {
  const live = drivenLive(w);
  return live?.sb ? livePlayerProse(live.sb, live.momentPrompt) : w.lastOutput;
};

Then("no opinion number or relationship value appears", function (this: BbWorld) {
  // PAT-2: (1) the STRONG check walks the live game's STRUCTURED player projections (HUD, npcVoice, whereabouts,
  // journal, moment prompt) and fails on ANY numeric value under a trust/affinity/threat/opinion/relationship/edge
  // key; (2) the prose regex is the backstop for a value rendered into text ("trust 7", "threat (8)", "trust: 0.8").
  // The prose is the live game's engine-generated text (the fixed moment-prompt template is cut out, its dynamic context swept) — its plain words ("can I trust you?", a speech tell
  // "makes a threat sound like small talk") are legitimate, and the fixed moment-prompt template is not swept.
  const live = drivenLive(this);
  assert.ok(live?.sb, "the scenario drives a live game, so its structured projections can be walked");
  assertNoNumericRelationshipFields(livePlayerProjections(live.sb!, live.momentPrompt));
  assertNoRelationshipValueProse(proseOf(this));
});

Then("no message states that the houseguest's opinion changed", function (this: BbWorld) {
  // PAT-2: clause-bounded (no `.*` across the text) so unrelated sentences don't match; covers "soured", "softened",
  // "warmed", "cooled", "thinks less of you", "no longer trusts you", "likes you more", ... Engine text only.
  assertNoOpinionChangedProse(proseOf(this));
});

// --- Wins and votes are consequential -----------------------------------------
// @standalone-module (PAT-5): `ConsequenceEngine.recordCompetitionWin` / `recordVoteAgainstPlayer` have no production
// caller. The live game records competition wins and votes as `house-event`s and folds their consequences in the
// season loop; those are proven by tests/unit/evictionConsequence.test.ts and tests/unit/ceremonyConsequence.test.ts
// (and the live 0034/0037 BDDs). This scenario covers the standalone module only.

When("a competition is won", function (this: BbWorld) {
  this.consequence = freshEngine(1);
  this.consequence.recordCompetitionWin(npc(1), "endurance");
});

Then("the win is recorded as an event", function (this: BbWorld) {
  assert.ok(this.consequence!.snapshot().events.some((e) => e.type === "competition"));
});

When("a houseguest votes to evict the player's ally", function (this: BbWorld) {
  this.threatBefore = this.consequence!.relationships().edge(npc(2), PLAYER).threat;
  this.consequence!.recordVoteAgainstPlayer(npc(2), npc(3));
});

Then("that vote is recorded as an event", function (this: BbWorld) {
  assert.ok(this.consequence!.snapshot().events.some((e) => e.type === "vote"));
});

Then("the responsible houseguest's hidden threat read toward the player rises", function (this: BbWorld) {
  assert.ok(this.consequence!.relationships().edge(npc(2), PLAYER).threat > this.threatBefore!);
});

