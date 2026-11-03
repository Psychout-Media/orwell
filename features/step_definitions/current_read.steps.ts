import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import type { RelationshipModel } from "../../src/engine/relationships";
import { CURRENT_READ } from "../../src/engine/relationshipConstants";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { resolvePending } from "../support/answerPending";

/**
 * Feature 0088 — living current read of the player. Drives the REAL session (factory cast, the live NPC->player edge,
 * the `npcVoice` projection the narrator is handed) and asserts what that projection actually carries — never a pure
 * helper called with hand-made numbers. Role-only.
 */

interface CRState {
  crSb?: UserSandbox;
  crIds?: EntityId[];
  crNpc?: EntityId;
  crBefore?: string;          // the carriage word before the player's conduct
  crDayOne?: string;          // the sealed day-one read of the player (deep profile), as written at move-in
  crInitialToward?: string;   // the carriage word at move-in
}
const cr = (w: BbWorld): CRState => w as unknown as CRState;

/** The carriage ladder, coolest to warmest (the engine's own words). */
const LADDER: readonly string[] = [CURRENT_READ.words.wary, CURRENT_READ.words.guarded, CURRENT_READ.words.neutral, CURRENT_READ.words.friendly, CURRENT_READ.words.warm];

let users = 0;
function started(seed: number): { sb: UserSandbox; ids: EntityId[] } {
  const sb = new GameSessionRegistry().sandboxFor(`cr-${users++}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return { sb, ids: (sb.session.snapshot().house?.npcs ?? []).map((n) => n.id) };
}

const relOf = (sb: UserSandbox): RelationshipModel => sb.engine.relationships;
/** What the narrator is actually handed about how this houseguest carries themselves toward the player. */
const readOf = (w: BbWorld): { toward: string; drift: "warming" | "cooling" | "steady" } => {
  const view = cr(w).crSb!.session.npcVoice(cr(w).crNpc!);
  assert.ok(view?.currentRead, "the voicing projection carries a current read for an active houseguest");
  return view!.currentRead!;
};
const bondOf = (sb: UserSandbox, id: EntityId): number => {
  const e = relOf(sb).edge(id, PLAYER);
  return (e.trust + e.affinity) / 2;
};
/** Fix the reference point the drift word is measured from (what the engine does at each week roll). */
function anchorNow(sb: UserSandbox, id: EntityId): void {
  (sb.session as unknown as { readAnchors: Map<EntityId, number> }).readAnchors.set(id, bondOf(sb, id));
}
const dayOneRead = (sb: UserSandbox, id: EntityId): string => sb.session.snapshot().deepProfiles?.[id]?.dayOnePerception?.read ?? "";

function begin(w: BbWorld, bond?: number): void {
  const { sb, ids } = started(2026);
  const s = cr(w);
  s.crSb = sb; s.crIds = ids; s.crNpc = ids[0];
  assert.ok(s.crNpc, "must have an NPC");
  if (bond !== undefined) { const e = relOf(sb).edge(s.crNpc!, PLAYER); e.trust = bond; e.affinity = bond; }
  anchorNow(sb, s.crNpc!);
  s.crBefore = readOf(w).toward;
}

const conduct = (w: BbWorld, kind: "bonding" | "conflict", times: number): void => {
  const rng = new SeededRandom(42);
  for (let i = 0; i < times; i++) relOf(cr(w).crSb!).applyDirected(cr(w).crNpc!, PLAYER, kind, rng);
};

// ── Given ──────────────────────────────────────────────────────────────────────────────────

Given("a houseguest whose day-one read of the player is wary", function (this: BbWorld) {
  begin(this, 0.1);
  assert.equal(cr(this).crBefore, CURRENT_READ.words.wary, "the fixture starts wary");
});

Given("a houseguest whose day-one read of the player is friendly", function (this: BbWorld) {
  begin(this, 0.55);
  assert.ok(LADDER.indexOf(cr(this).crBefore!) >= LADDER.indexOf(CURRENT_READ.words.friendly) - 1, "the fixture starts friendly-ish");
});

Given("a houseguest with a sealed day-one read of the player", function (this: BbWorld) {
  begin(this);
  const s = cr(this);
  s.crInitialToward = s.crBefore;
  s.crDayOne = dayOneRead(s.crSb!, s.crNpc!);
  assert.ok(s.crDayOne.length > 0, "the houseguest has a sealed day-one read in their deep profile");
});

Given("the player has built a strong reputation with a houseguest", function (this: BbWorld) {
  begin(this);
  const e = relOf(cr(this).crSb!).edge(cr(this).crNpc!, PLAYER);
  e.trust = 0.8731; e.affinity = 0.8419; e.threat = 0.1137; // distinctive magnitudes an admin surface must never echo
});

Given("a houseguest whose current read of the player has warmed", function (this: BbWorld) {
  begin(this, 0.2);
  conduct(this, "bonding", 8);
  assert.notEqual(readOf(this).drift, "steady", "the read has genuinely moved");
});

When("the voicing projection for a houseguest is read through the current read path", function (this: BbWorld) {
  begin(this);
});

// ── When ──────────────────────────────────────────────────────────────────────────────────

When("the player accumulates favorable conduct toward that houseguest over several recorded scenes", function (this: BbWorld) {
  conduct(this, "bonding", 6);
});

When("the player acts against that houseguest in recorded scenes", function (this: BbWorld) {
  conduct(this, "conflict", 6);
});

When("the player's conduct moves that houseguest's current read across the season", function (this: BbWorld) {
  conduct(this, "bonding", 4);
  conduct(this, "conflict", 8);
});

When("the current read is snapshotted and restored", function (this: BbWorld) {
  const s = cr(this);
  s.crSb!.session.restore(s.crSb!.session.snapshot());
});

When("an admin inspects the available game state", function (this: BbWorld) {
  (this as unknown as { crAdminView?: string }).crAdminView = JSON.stringify(cr(this).crSb!.admin.inspect());
});

When("that houseguest is voiced toward the player", function (this: BbWorld) {
  (this as unknown as { crVoice?: string }).crVoice = JSON.stringify(cr(this).crSb!.session.npcVoice(cr(this).crNpc!));
});

// ── Then: living read ──────────────────────────────────────────────────────────────────────

Then("that houseguest's current read of the player carries a warmer carriage toward the player", function (this: BbWorld) {
  const after = readOf(this).toward;
  assert.ok(LADDER.indexOf(after) > LADDER.indexOf(cr(this).crBefore!), `warmed from '${cr(this).crBefore}' but reads '${after}'`);
});

Then("the carriage reads as warming since an earlier reference point", function (this: BbWorld) {
  assert.equal(readOf(this).drift, "warming");
});

Then("the player is never shown a number for that read", function (this: BbWorld) {
  const read = readOf(this);
  assert.ok(!/[0-9]/.test(JSON.stringify(read)), "the current read carries no digit");
  assert.equal(typeof read.toward, "string");
});

Then("that houseguest's current read of the player carries a cooler, more guarded carriage", function (this: BbWorld) {
  const after = readOf(this).toward;
  assert.ok(LADDER.indexOf(after) < LADDER.indexOf(cr(this).crBefore!), `cooled from '${cr(this).crBefore}' but reads '${after}'`);
});

Then("the carriage reads as cooling since an earlier reference point", function (this: BbWorld) {
  assert.equal(readOf(this).drift, "cooling");
});

// ── Then: frozen day-one read ──────────────────────────────────────────────────────────────

Then("the sealed day-one read of the player is unchanged", function (this: BbWorld) {
  const s = cr(this);
  assert.equal(dayOneRead(s.crSb!, s.crNpc!), s.crDayOne, "the frozen first impression was rewritten by the player's conduct");
});

Then("the current read may disagree with the day-one read", function (this: BbWorld) {
  const s = cr(this);
  // Push the live read hard the other way: it follows the conduct (not the first impression) and the sealed read stays put.
  conduct(this, "conflict", 12);
  const now = readOf(this);
  assert.ok(LADDER.indexOf(now.toward) < LADDER.indexOf(s.crInitialToward!) || now.drift === "cooling",
    `the live read ('${now.toward}', ${now.drift}) did not move off the move-in carriage ('${s.crInitialToward}')`);
  assert.equal(dayOneRead(s.crSb!, s.crNpc!), s.crDayOne, "the sealed day-one read held while the live read moved");
});

Then("the gap between the first impression and the current read is itself voiceable", function (this: BbWorld) {
  const s = cr(this);
  // Both halves exist at once, as distinct things: the sealed first impression (Vault) and the live carriage word the
  // narrator is handed — so the engine can hand over a "was wary, now warm" arc without ever naming a number.
  const voice = JSON.stringify(s.crSb!.session.npcVoice(s.crNpc!));
  assert.ok(readOf(this).toward.length > 0 && readOf(this).drift.length > 0, "a live carriage + drift is handed to the voicer");
  assert.ok(s.crDayOne!.length > 0 && !voice.includes(s.crDayOne!), "the sealed first impression stays in the Vault, distinct from the live read");
});

// ── Then: Vault Wall ───────────────────────────────────────────────────────────────────────

Then("any current read of the player is a carriage word, not a signal value", function (this: BbWorld) {
  const read = readOf(this);
  assert.ok(LADDER.includes(read.toward), `'${read.toward}' is one of the engine's carriage words`);
  assert.ok(["warming", "cooling", "steady"].includes(read.drift));
});

Then("the projection carries no trust, affinity, or threat number toward the player", function (this: BbWorld) {
  const s = cr(this);
  const view = s.crSb!.session.npcVoice(s.crNpc!)!;
  const e = relOf(s.crSb!).edge(s.crNpc!, PLAYER);
  const blob = JSON.stringify(view);
  for (const v of [e.trust, e.affinity, e.threat]) assert.ok(!blob.includes(String(v)), `the projection echoes an edge value (${v})`);
  assert.ok(!/"(trust|affinity|threat|confidence|alignment|reliability)"\s*:\s*[0-9.]/.test(blob), "no signal field with a number rides the projection");
  assert.ok(!/[0-9]/.test(JSON.stringify(view.currentRead)), "the read itself carries no digit");
});

Then("the projection carries no hidden cause for the read", function (this: BbWorld) {
  const read = readOf(this);
  assert.deepStrictEqual(Object.keys(read).sort(), ["drift", "toward"]);
  const blob = JSON.stringify(cr(this).crSb!.session.npcVoice(cr(this).crNpc!));
  assert.ok(!blob.includes(cr(this).crDayOne ?? dayOneRead(cr(this).crSb!, cr(this).crNpc!)), "the sealed day-one read leaked into the projection");
});

Then("no admin surface exposes the NPC-to-player relationship signals", function (this: BbWorld) {
  const s = cr(this);
  const admin = (this as unknown as { crAdminView: string }).crAdminView;
  const e = relOf(s.crSb!).edge(s.crNpc!, PLAYER);
  for (const v of [e.trust, e.affinity, e.threat]) assert.ok(!admin.includes(String(v)), `the admin view echoes an edge value (${v})`);
  assert.ok(!/"(trust|affinity|threat)"/.test(admin), "the admin view carries a relationship-signal field");
});

Then("no admin surface exposes a number for any houseguest's read of the player", function (this: BbWorld) {
  const admin = (this as unknown as { crAdminView: string }).crAdminView;
  assert.ok(!/currentRead|"toward"|"drift"/.test(admin), "the admin view carries the read at all");
  assert.ok(!/(warm and open|guarded|wary)/.test(admin), "the admin view carries a carriage word for the read");
});

// ── Then: the engine never asserts it ──────────────────────────────────────────────────────

Then("the houseguest's warmer conduct is shown", function (this: BbWorld) {
  const voice = (this as unknown as { crVoice: string }).crVoice;
  const read = (JSON.parse(voice) as { currentRead: { toward: string; drift: string } }).currentRead;
  assert.equal(read.drift, "warming");
  assert.ok(LADDER.indexOf(read.toward) >= LADDER.indexOf(CURRENT_READ.words.neutral), `a warmed houseguest still reads '${read.toward}'`);
});

Then("the engine never asserts that the player trusts or likes that houseguest", function (this: BbWorld) {
  // The read is the HOUSEGUEST's carriage toward the player — the projection holds no claim about the player's own feelings.
  const voice = JSON.parse((this as unknown as { crVoice: string }).crVoice) as Record<string, unknown>;
  assert.ok(!/(you|player)\s+(trust|like|love|are close)/i.test(JSON.stringify(voice.currentRead)), "the read states the player's feelings");
  assert.deepStrictEqual(Object.keys(voice.currentRead as object).sort(), ["drift", "toward"]);
  assert.ok(!("playerFeels" in voice) && !("playerTrust" in voice), "no field states the player's own feelings");
});

Then("the engine never labels the relationship for the player", function (this: BbWorld) {
  const read = readOf(this);
  // A carriage word and a movement cue — never an "ally / friend / enemy" label.
  assert.ok(LADDER.includes(read.toward));
  assert.ok(!/ally|friend\b|enemy|rival|best/i.test(read.toward), `'${read.toward}' labels the relationship`);
});

// ── Determinism ────────────────────────────────────────────────────────────────────────────

/** Play a fixed history; optionally read every houseguest's voice (and so the current read) after every beat. */
function playHistory(seed: number, readVoices: boolean): { reads: string[]; trail: string } {
  const { sb, ids } = started(seed);
  const reads: string[] = [];
  const trail: string[] = [];
  for (let i = 0; i < 80; i++) {
    const v = sb.session.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => sb.session.submitDecision(req));
    trail.push(`${v.status.week}:${v.status.phase}:${v.status.hoh?.id}:${v.status.nominees.map((n) => n.id).join("+")}`);
    if (readVoices) for (const id of ids) reads.push(`${id}=${JSON.stringify(sb.session.npcVoice(id)?.currentRead)}`);
    if (v.finished) break;
  }
  const core = sb.session.snapshot();
  trail.push(JSON.stringify(core.live?.evictionOrder));
  return { reads, trail: trail.join("|") };
}

Given("two games seeded identically and played through the same history", function (this: BbWorld) {
  (this as unknown as { crRuns: ReturnType<typeof playHistory>[] }).crRuns = [playHistory(77, true), playHistory(77, true), playHistory(77, false)];
});

Then("each houseguest's current read of the player is the same carriage in both games", function (this: BbWorld) {
  const [a, b] = (this as unknown as { crRuns: ReturnType<typeof playHistory>[] }).crRuns;
  assert.ok(a!.reads.length > 0 && a!.reads.some((r) => !r.endsWith("=undefined")), "carriage words were actually read");
  assert.deepStrictEqual(a!.reads, b!.reads);
});

Then("the seeded competition and eviction outcomes are byte-identical to a game without the read surfaced", function (this: BbWorld) {
  const [a, , quiet] = (this as unknown as { crRuns: ReturnType<typeof playHistory>[] }).crRuns;
  assert.equal(a!.trail, quiet!.trail, "reading the current read changed the game's seeded outcomes");
});
