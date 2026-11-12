import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { npc, PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { PLAYER_TOOLS } from "../../src/surfaces/tools/registry";
import { buildSandbox, type Sandbox } from "../../tests/support/sandbox";
import { ARCHETYPES, isPlausibleArchetype, startNewGame } from "../../src/engine/characterFactory";
import { GIVEN_NAMES } from "../../src/engine/data/givenNames";
import {
  validateCastGenesis, hitsLegacyDenyList, generateSeasonBrief, renderSeasonBrief, LEGACY_BIBLE_NAMES,
} from "../../src/engine/castGenesis";
import type {
  CastGenesisProposal, GenesisContext, GenesisNpcProposal, CastGenesisResult, SeasonBrief,
} from "../../src/engine/castGenesis";
import { GENESIS_TOTAL_BAND, GENESIS_STAT_CLAMP, GENESIS_TIE_BUDGET, GENESIS_HIDDEN_ELEMENT_RANGE } from "../../src/engine/genesisConstants";
import { nextTieExposure, tieExposureOf, TIE_AFFINITY_BIAS } from "../../src/engine/seededRelationships";
import type { PreGameTie, TieExposure } from "../../src/engine/seededRelationships";
import { toGameState } from "../../src/engine/sessionSnapshot";
import { isSuperset } from "../../src/domain/saveState";
import { repairDiversityLayer, generateDiversityLayer } from "../../src/engine/diversity";
import { MIN_BIPOC, MIN_PER_BINARY_GENDER } from "../../src/engine/diversityConstants";
import type { RecordCastGenesisResult } from "../../src/ports/GameSession";

/**
 * Feature 0116 — model-authored cast genesis. HARD rule: roles only, never names — every display name
 * in a fixture is an OBVIOUSLY-SYNTHETIC military-phonetic token (NEVER a corpus/legacy cast), exactly
 * as the vitest `castGenesis*` suite does. These executable steps mirror that suite 1:1 against the real
 * engine API: the pure ENVELOPE (`validateCastGenesis` + the genesis constants), the production MCP
 * write-back (`McpServer.callTool` → `recordCastGenesis`), the 0095 tie-exposure lifecycle
 * (`nextTieExposure`), the inherited 0063 diversity pipeline (`repairDiversityLayer`), the Vault-wall
 * projection sweeps (player AND admin), the byte-neutral floor, and the non-degradation superset gate.
 */

// ── Obviously-synthetic fixtures (roles only) ────────────────────────────────────────────────────────
const NATO = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India",
  "Juliet", "Kilo", "Lima", "Mike", "Oscar", "Papa", "Quebec", "Romeo", "Sierra", "Tango", "Uniform",
  "Victor", "Whiskey", "Yankee", "Zulu", "Nova", "Onyx", "Perry", "Reed", "Sable", "Vesper"];
const synthName = (i: number): string => `${NATO[i % NATO.length]} ${NATO[(i + 7) % NATO.length]}`;
const fullName = (i: number): string => `${NATO[i % NATO.length]} ${NATO[(i + 11) % NATO.length]}`;
const biasOf = (a: number): { physical: number; mental: number; social: number } => ARCHETYPES[a % ARCHETYPES.length]!.bias;

/** A warmed floor-cast context of 15 NPCs (npc:1..15) — the per-NPC fallback source for the envelope. */
function mkCtx(extra: Partial<GenesisContext> = {}): GenesisContext {
  const npcs = Array.from({ length: 15 }, (_, i) => ({
    id: npc(i + 1),
    floorArchetype: ARCHETYPES[i % ARCHETYPES.length]!.archetype,
    floorStats: { ...biasOf(i) },
    floorName: synthName(i),
  }));
  return { npcs, playerId: PLAYER, ...extra };
}

/** A full 15-NPC proposal, one field-set overridden per NPC by `perNpc`. */
function mkProposal(ctx: GenesisContext, perNpc: (i: number, id: EntityId) => GenesisNpcProposal): CastGenesisProposal {
  return { npcs: ctx.npcs.map((c, i) => ({ id: c.id, ...perNpc(i, c.id) })) };
}

/** A spread of in-band stats so a whole-cast proposal clears the variance floor by default. */
function variedStats(i: number): { physical: number; mental: number; social: number } {
  const base = 0.3 + ((i * 37) % 55) / 100;
  return {
    physical: Math.min(0.9, Math.max(0.2, base + 0.2)),
    mental: Math.min(0.9, Math.max(0.2, 0.9 - base)),
    social: Math.min(0.9, Math.max(0.2, 0.3 + ((i * 53) % 50) / 100)),
  };
}

/** A full, envelope-CLEAN 15-NPC proposal off warmed roster ids (the adapter/boundary path). */
function fullProposal(ids: readonly EntityId[]): { npcs: Record<string, unknown>[]; ties: Record<string, unknown>[] } {
  return {
    npcs: ids.map((id, i) => ({
      id,
      name: fullName(i),
      identity: `a distinct model-authored houseguest, slot ${i}`,
      stats: { physical: 0.3 + ((i * 7) % 55) / 100, mental: 0.9 - ((i * 5) % 60) / 100, social: 0.35 + ((i * 11) % 50) / 100 },
      hiddenElements: [
        { kind: "divergent-persona", detail: `wears a mask, slot ${i}` },
        { kind: "pre-game-tie", detail: `a quiet pre-show pact, slot ${i}` },
        { kind: "secret-motive", detail: `a private reason to win, slot ${i}` },
      ],
    })),
    ties: [{ a: ids[0], b: ids[1], nature: "casting-callback" }],
  };
}

/** A fresh player-channel MCP server + its GameSessionAdapter (the boundary-test rig). */
function playerServer(): { server: McpServer; session: GameSessionAdapter } {
  const sb = buildSandbox(1);
  const session = new GameSessionAdapter();
  const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
  const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
  return { server, session };
}

let cgUsers = 0;

// ── World scratch (cg-prefixed; a local cast avoids touching world.ts, mirroring character_voice.steps) ─
interface CgState {
  cgModelWired?: boolean;
  cgServer?: McpServer;
  cgSession?: GameSessionAdapter;
  cgWarmIds?: EntityId[];
  cgCtx?: GenesisContext;
  cgProposal?: CastGenesisProposal;
  cgProposalRaw?: { npcs: Record<string, unknown>[]; ties: Record<string, unknown>[] };
  cgResult?: CastGenesisResult;
  cgCallResult?: RecordCastGenesisResult;
  cgTarget?: EntityId;
  cgConcept?: string;
  cgRosterA?: string;
  cgSeed?: number;
  cgPlayerName?: string;
  cgBriefA?: SeasonBrief;
  cgBriefB?: SeasonBrief;
  cgPromptText?: string;
  cgPriorNames?: string[];
  cgTie?: PreGameTie;
  cgExposure?: TieExposure;
  cgSandbox?: UserSandbox;
  cgSentinel?: string;
  cgSweep?: string;
  cgPublicStrings?: string;
  cgReloaded?: GameSessionAdapter;
  cgReg?: GameSessionRegistry;
  cgRegUser?: string;
  cgDvSeed?: number;
  cgDvNpcs?: ReturnType<typeof startNewGame>["npcs"];
  cgDvProposed?: Record<string, { ethnicity?: string }>;
  cgDvLayer?: ReturnType<typeof repairDiversityLayer>;
}
const cg = (w: BbWorld): CgState => w as unknown as CgState;

// ── Background ───────────────────────────────────────────────────────────────────────────────────────

Given("a fresh game sandbox awaiting its cast", function (this: BbWorld) {
  const { server, session } = playerServer();
  cg(this).cgServer = server;
  cg(this).cgSession = session;
  cg(this).cgCtx = mkCtx();
});

Given("a genesis-capable model is wired unless a scenario says otherwise", function (this: BbWorld) {
  cg(this).cgModelWired = true;
});

// ── Rule: the model proposes; the engine validates, clamps, and commits ──────────────────────────────

Given("a cast proposal of exactly fifteen NPCs that satisfies every envelope validator", function (this: BbWorld) {
  const session = new GameSessionAdapter();
  const ids = session.preSeedCast({ seed: 116 }).house.map((h) => h.id);
  cg(this).cgSession = session;
  cg(this).cgWarmIds = ids;
  cg(this).cgProposalRaw = fullProposal(ids);
});

When("the engine validates and commits the proposal", function (this: BbWorld) {
  const s = cg(this);
  s.cgCallResult = s.cgSession!.recordCastGenesis(s.cgProposalRaw as never);
  s.cgSession!.createCharacter({ playerName: "The Player" });
  s.cgRosterA = JSON.stringify(s.cgSession!.getGameState().house);
});

Then("the committed cast carries the proposed names, identities, personas, and voices", function (this: BbWorld) {
  const s = cg(this);
  const house = s.cgSession!.getGameState().house;
  assert.equal(house.length, 15, "15 committed houseguests");
  const names = house.map((h) => h.name);
  const proposed = s.cgProposalRaw!.npcs.map((n) => n["name"] as string);
  assert.ok(proposed.some((nm) => names.includes(nm)), "authored names crossed onto the roster");
  assert.ok(house.every((h) => typeof (h as { identityConcept?: string }).identityConcept === "string"), "freeform identities present");
  assert.ok(house.every((h) => (h as { voice?: unknown }).voice !== undefined), "voice fingerprints present");
});

Then("the committed cast is byte-stable from the moment of commit", function (this: BbWorld) {
  const s = cg(this);
  const revived = new GameSessionAdapter();
  revived.restore(s.cgSession!.snapshot());
  assert.equal(JSON.stringify(revived.getGameState().house), s.cgRosterA, "the committed cast never drifts across a round-trip");
});

Then("the archetype tag on each NPC is a member of the canonical archetype enum", function (this: BbWorld) {
  for (const h of cg(this).cgSession!.getGameState().house) {
    assert.ok(isPlausibleArchetype((h as { archetype: string }).archetype), `archetype ${(h as { archetype: string }).archetype} not in the enum`);
  }
});

Given("a proposed NPC whose freeform identity matches no single canonical archetype cleanly", function (this: BbWorld) {
  const session = new GameSessionAdapter();
  const ids = session.preSeedCast({ seed: 202 }).house.map((h) => h.id);
  cg(this).cgSession = session;
  cg(this).cgWarmIds = ids;
  cg(this).cgConcept = "a chaos-agent podcaster who treats the house like a live show";
  const proposal = fullProposal(ids);
  (proposal.npcs[0] as { identity: string; archetype: string }).identity = cg(this).cgConcept!;
  (proposal.npcs[0] as { identity: string; archetype: string }).archetype = "villain";
  cg(this).cgProposalRaw = proposal;
});

When("the engine commits the proposal", function (this: BbWorld) {
  const s = cg(this);
  s.cgCallResult = s.cgSession!.recordCastGenesis(s.cgProposalRaw as never);
  s.cgSession!.createCharacter({ playerName: "The Player" });
});

Then("the NPC's freeform identity is stored byte-equal to the proposal", function (this: BbWorld) {
  const s = cg(this);
  const card = s.cgSession!.getGameState().house.find((h) => h.id === s.cgWarmIds![0]) as { identityConcept?: string };
  assert.equal(card.identityConcept, s.cgConcept, "the freeform identity is stored verbatim");
});

Then("the derived archetype tag rides alongside it as a mechanical coupling key only", function (this: BbWorld) {
  const s = cg(this);
  const card = s.cgSession!.getGameState().house.find((h) => h.id === s.cgWarmIds![0]) as { archetype: string; identityConcept?: string };
  assert.ok(isPlausibleArchetype(card.archetype), "the archetype tag is a valid enum coupling key");
  assert.notEqual(card.identityConcept, card.archetype, "the identity is distinct from the bare tag");
});

Then("player-facing narration voices the freeform identity, never the bare tag", function (this: BbWorld) {
  const s = cg(this);
  // The player-facing roster (the narrator's per-person voice anchor) carries the freeform identity
  // concept verbatim — the identity is not reduced to the bare archetype tag.
  const card = s.cgSession!.getGameState().house.find((h) => h.id === s.cgWarmIds![0]) as { archetype: string; identityConcept?: string };
  assert.equal(card.identityConcept, s.cgConcept, "narration is handed the freeform identity to voice");
  assert.notEqual(card.identityConcept, card.archetype, "never the bare archetype tag as the identity");
});

Given("a valid cast proposal delivered through the genesis write-back tool", async function (this: BbWorld) {
  const s = cg(this);
  const warm = (await s.cgServer!.callTool("preSeedCast", { seed: 303 })) as { house: { id: EntityId }[] };
  s.cgWarmIds = warm.house.map((h) => h.id);
  s.cgProposalRaw = fullProposal(s.cgWarmIds);
});

When("the tool is dispatched through the MCP server's callTool path, not the adapter directly", async function (this: BbWorld) {
  const s = cg(this);
  s.cgCallResult = (await s.cgServer!.callTool("recordCastGenesis", s.cgProposalRaw as never)) as RecordCastGenesisResult;
});

Then("the call is accepted at the boundary, never silently rejected", function (this: BbWorld) {
  const s = cg(this);
  // The four-place-rule proof: the tool is on the player channel AND dispatches without a "not available" reject.
  assert.ok(PLAYER_TOOLS.map((t) => t.name).includes("recordCastGenesis"), "recordCastGenesis is on the player channel");
  assert.equal(s.cgCallResult!.accepted, true, "the boundary accepted the proposal");
  assert.equal(s.cgCallResult!.committed, 15, "all 15 warmed slots folded");
});

Then("the committed cast contains the proposal's content", function (this: BbWorld) {
  const s = cg(this);
  s.cgSession!.createCharacter({ playerName: "The Player" });
  const house = s.cgSession!.getGameState().house;
  const names = house.map((h) => h.name);
  const proposed = s.cgProposalRaw!.npcs.map((n) => n["name"] as string);
  assert.ok(proposed.some((nm) => names.includes(nm)), "authored names crossed onto the started roster");
  assert.ok(house.every((h) => typeof (h as { identityConcept?: string }).identityConcept === "string"), "authored identity concepts crossed");
});

Then("the committed cast stays byte-stable afterward", function (this: BbWorld) {
  const s = cg(this);
  const a = JSON.stringify(s.cgSession!.getGameState().house);
  const revived = new GameSessionAdapter();
  revived.restore(s.cgSession!.snapshot());
  assert.equal(JSON.stringify(revived.getGameState().house), a, "the committed cast is byte-stable");
});

// ── Shared: validate the pure-envelope proposal set up by the scenario's Given ────────────────────────

When("the engine validates the proposal", function (this: BbWorld) {
  const s = cg(this);
  s.cgResult = validateCastGenesis(s.cgProposal!, s.cgCtx!);
});

// ── Rule: stats are point-buy — banded variable totals; no model number escapes the clamp ────────────

Given("a proposed NPC whose stat total exceeds the engine's total band", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgTarget = npc(1);
  cg(this).cgProposal = mkProposal(ctx, (i, id) => (id === npc(1)
    ? { stats: { physical: 0.9, mental: 0.8, social: 0.7 } } // total 2.4 > band.hi
    : { stats: variedStats(i) }));
});

Then("the committed stat total lands inside the engine-owned band", function (this: BbWorld) {
  const st = cg(this).cgResult!.npcs.find((n) => n.id === cg(this).cgTarget)!.stats!;
  const total = st.physical + st.mental + st.social;
  assert.ok(total >= GENESIS_TOTAL_BAND.lo - 1e-6 && total <= GENESIS_TOTAL_BAND.hi + 1e-6, `total ${total} out of band`);
});

Then("the committed distribution preserves the proposal's relative shape", function (this: BbWorld) {
  const st = cg(this).cgResult!.npcs.find((n) => n.id === cg(this).cgTarget)!.stats!;
  assert.ok(st.physical > st.mental && st.mental > st.social, "relative shape (physical > mental > social) preserved");
});

Then("no raw proposed number is committed unclamped", function (this: BbWorld) {
  const st = cg(this).cgResult!.npcs.find((n) => n.id === cg(this).cgTarget)!.stats!;
  for (const v of [st.physical, st.mental, st.social]) {
    assert.ok(v >= GENESIS_STAT_CLAMP.min - 1e-9 && v <= GENESIS_STAT_CLAMP.max + 1e-9, `stat ${v} escaped the clamp`);
  }
});

Given("a proposal with one NPC at the top of the total band and one at the bottom", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgProposal = mkProposal(ctx, (i) => {
    if (i === 0) return { stats: { physical: 0.9, mental: 0.7, social: 0.5 } }; // 2.1 top of band
    if (i === 1) return { stats: { physical: 0.5, mental: 0.5, social: 0.47 } }; // 1.47 bottom of band
    return { stats: variedStats(i) };
  });
});

Then("both NPCs commit without repair", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  assert.ok(r.varianceOk, "the cast cleared the variance floor");
  assert.deepEqual(r.npcs[0]!.stats, { physical: 0.9, mental: 0.7, social: 0.5 }, "the comp beast commits unchanged");
  assert.deepEqual(r.npcs[1]!.stats, { physical: 0.5, mental: 0.5, social: 0.47 }, "the floater commits unchanged");
  assert.ok(!r.violations.some((v) => v.npcId === npc(1) && v.field.startsWith("stat")), "no stat re-roll for either");
});

Given("a proposal whose fifteen NPCs carry near-identical stat totals and shapes", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgProposal = mkProposal(ctx, () => ({ stats: { physical: 0.6, mental: 0.6, social: 0.6 } }));
});

Then("the proposal fails the cast-wide variance validator", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  assert.equal(r.varianceOk, false, "a flat cast fails the variance floor");
  assert.ok(r.npcs.every((n) => n.stats === undefined), "the guaranteed-varied floor stats stand");
});

Then("a re-roll is requested with the violation named", function (this: BbWorld) {
  assert.ok(cg(this).cgResult!.violations.some((v) => v.scope === "cast" && v.field === "stats.variance" && v.action === "re-roll"),
    "a cast-scope variance re-roll is named");
});

// ── Rule: names are validated, never pooled ──────────────────────────────────────────────────────────

Given("a proposal in which two NPCs share a given name or a surname", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgTarget = npc(2);
  cg(this).cgProposal = mkProposal(ctx, (i, id) => {
    if (id === npc(1)) return { name: "Nova Sable" };
    if (id === npc(2)) return { name: "Nova Vesper" }; // duplicate given "Nova"
    return {};
  });
});

Then("the offending NPC is re-rolled and the violation names the colliding field", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  assert.equal(r.npcs.find((n) => n.id === npc(1))!.name, "Nova Sable", "the first NPC keeps its name");
  assert.equal(r.npcs.find((n) => n.id === npc(2))!.name, undefined, "the colliding NPC's name is dropped");
  assert.ok(r.violations.some((v) => v.npcId === npc(2) && v.field === "name"), "the violation names the colliding field");
});

Given("a proposal containing a name from the legacy deny-list", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgTarget = npc(1);
  cg(this).cgProposal = mkProposal(ctx, (i, id) => (id === npc(1) ? { name: `${LEGACY_BIBLE_NAMES[1]} Onyx` } : {}));
});

Then("the proposal is refused for that NPC", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  assert.equal(r.npcs.find((n) => n.id === npc(1))!.name, undefined, "the legacy-named NPC's name is dropped");
  assert.ok(r.violations.some((v) => v.npcId === npc(1) && v.field === "name" && v.action === "re-roll"), "a name re-roll is named");
});

Then("the deny-list gate holds on the genesis path exactly as it holds on the floor", function () {
  // The validator catches a legacy name in any token...
  assert.ok(hitsLegacyDenyList(`${LEGACY_BIBLE_NAMES[0]} Bravo`), "the genesis validator catches a legacy name");
  assert.ok(!hitsLegacyDenyList("Alpha Bravo"), "a clean name is not falsely flagged");
  // ...AND the SAME names are excluded from the vendored corpus (the deterministic floor path).
  for (const n of LEGACY_BIBLE_NAMES) assert.ok(!GIVEN_NAMES.includes(n), `${n} must be absent from the corpus`);
});

Given("a proposal containing an NPC whose name collides with the player's name", function (this: BbWorld) {
  const ctx = mkCtx({ playerName: "Sable Reed" });
  cg(this).cgCtx = ctx;
  cg(this).cgTarget = npc(1);
  cg(this).cgProposal = mkProposal(ctx, (i, id) => (id === npc(1) ? { name: "Sable Reed" } : {}));
});

Then("the offending NPC is re-rolled", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  assert.equal(r.npcs.find((n) => n.id === cg(this).cgTarget)!.name, undefined, "the offending NPC's name is dropped");
  assert.ok(r.violations.some((v) => v.npcId === cg(this).cgTarget && v.field === "name" && v.action === "re-roll"), "a name re-roll is named");
});

Given("a proposal containing an NPC whose name is a single token", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgTarget = npc(1);
  cg(this).cgProposal = mkProposal(ctx, (i, id) => (id === npc(1) ? { name: "Solo" } : {}));
});

Then("the offending NPC is re-rolled and the violation names the shape rule", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  assert.equal(r.npcs.find((n) => n.id === cg(this).cgTarget)!.name, undefined, "the offending NPC's name is dropped");
  assert.ok(r.violations.some((v) => v.npcId === cg(this).cgTarget && v.field === "name" && /shape|length|markup/.test(v.rule)),
    "the violation names the shape/length/markup rule");
});

Given("a proposal containing an NPC whose name contains digits or markup characters", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgTarget = npc(1);
  cg(this).cgProposal = mkProposal(ctx, (i, id) => (id === npc(1) ? { name: "Alpha 2Bravo" } : {}));
});

Given("a proposal containing an NPC whose name exceeds the length cap", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgTarget = npc(1);
  cg(this).cgProposal = mkProposal(ctx, (i, id) => (id === npc(1) ? { name: `Alpha ${"B".repeat(40)}ravo` } : {}));
});

Then("the offending NPC is re-rolled and the violation names the length cap", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  assert.equal(r.npcs.find((n) => n.id === cg(this).cgTarget)!.name, undefined, "the over-length NPC's name is dropped");
  assert.ok(r.violations.some((v) => v.npcId === cg(this).cgTarget && v.field === "name" && /shape|length|markup/.test(v.rule)),
    "the violation names the length cap");
});

Given("a completed prior season whose cast names are on record", function (this: BbWorld) {
  cg(this).cgPriorNames = ["Perry Quondam"];
});

Given("a proposal containing an NPC whose name repeats a prior season's houseguest", function (this: BbWorld) {
  const ctx = mkCtx({ priorSeasonNames: cg(this).cgPriorNames });
  cg(this).cgCtx = ctx;
  cg(this).cgTarget = npc(1);
  cg(this).cgProposal = mkProposal(ctx, (i, id) => (id === npc(1) ? { name: "Perry Nova" } : {})); // given "Perry" repeats
});

// ── Rule: genesis is player-blind; the season brief is seeded ────────────────────────────────────────

Given("the player has answered casting-interview questions", function (this: BbWorld) {
  cg(this).cgPlayerName = "Zzyzx Playerson"; // a distinctive sentinel we assert never bleeds into a prompt
  cg(this).cgSeed = 1414;
});

When("the cast-sketch and deep-authoring prompts are assembled", function (this: BbWorld) {
  const s = cg(this);
  s.cgBriefA = generateSeasonBrief(s.cgSeed!);
  s.cgPromptText = renderSeasonBrief(s.cgBriefA);
});

Then("no player field appears in any genesis prompt", function (this: BbWorld) {
  const s = cg(this);
  // The engine's entire genesis-prompt payload is the SEEDED season brief (the FE assembles the sketch/
  // deep prompts FROM this player-blind brief). It is player-INDEPENDENT by construction (arity 1) and
  // carries no player field — a cast cannot be bent toward a player it never saw.
  // ORW-286 item 9: not `generateSeasonBrief.length === 1` (function arity proves nothing about what the result depends on). Behaviour: the brief and its rendered prompt for a seed are
  // identical whatever player-ish value is offered alongside, and carry neither the player's name nor any of a spread of plausible player names.
  const seeds = [s.cgSeed!, 1, 42, 999];
  for (const seed of seeds) {
    const base = generateSeasonBrief(seed);
    for (const player of [s.cgPlayerName!, "The Player", "Avery Quinn", "ER nurse from Austin"]) {
      assert.deepEqual((generateSeasonBrief as unknown as (a: number, b: string) => unknown)(seed, player), base, `the brief for seed ${seed} changed when offered a player value`);
      assert.ok(!JSON.stringify(base).includes(player) && !renderSeasonBrief(base).includes(player), `the player value ${JSON.stringify(player)} appears in the seed ${seed} brief`);
    }
  }
  assert.ok(!s.cgPromptText!.includes(s.cgPlayerName!), "a player field leaked into the genesis prompt");
});

Given("a committed-candidate NPC who by chance mirrors the player's vocation and hometown", function (this: BbWorld) {
  const ctx = mkCtx({ playerVocation: "ER nurse", playerHometown: "Austin, TX" });
  cg(this).cgCtx = ctx;
  cg(this).cgProposal = mkProposal(ctx, (i, id) => (id === npc(1)
    ? { vocation: "ER nurse", hometown: "Austin, TX", identity: "a warm floor-nurse", biography: "a real bio" }
    : {}));
});

When("the post-hoc near-duplicate validator runs", function (this: BbWorld) {
  cg(this).cgResult = validateCastGenesis(cg(this).cgProposal!, cg(this).cgCtx!);
});

Then("the colliding facet of that NPC is re-rolled", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  assert.equal(r.npcs.find((n) => n.id === npc(1))!.vocation, undefined, "the colliding vocation facet is dropped");
  assert.ok(r.violations.some((v) => v.npcId === npc(1) && v.field === "vocation" && v.action === "re-roll"), "the vocation re-roll is named");
});

Then("the rest of the NPC's identity is preserved", function (this: BbWorld) {
  const n = cg(this).cgResult!.npcs.find((x) => x.id === npc(1))!;
  assert.equal(n.hometown, "Austin, TX", "the hometown is preserved");
  assert.equal(n.identityConcept, "a warm floor-nurse", "the freeform identity is preserved");
});

Given("two fresh sandboxes created with the same seed", function (this: BbWorld) {
  cg(this).cgSeed = 4242;
});

When("each engine derives its seeded season brief", function (this: BbWorld) {
  cg(this).cgBriefA = generateSeasonBrief(cg(this).cgSeed!);
  cg(this).cgBriefB = generateSeasonBrief(cg(this).cgSeed!);
});

Then("the two briefs are byte-equal", function (this: BbWorld) {
  assert.deepEqual(cg(this).cgBriefA, cg(this).cgBriefB, "same seed ⇒ byte-equal brief");
});

Then("the brief derives from the seed alone, independent of the player", function () {
  // ORW-286 item 9: behavioural, not arity. The same seed yields the same brief however many unrelated arguments follow; a different seed yields a (usually) different one.
  for (const seed of [0, 7, 108108, 2147483647]) {
    const base = generateSeasonBrief(seed);
    assert.deepEqual(base, generateSeasonBrief(seed), "the same seed is reproducible");
    assert.deepEqual((generateSeasonBrief as unknown as (a: number, ...r: unknown[]) => unknown)(seed, { playerName: "Someone Else", vocation: "ER nurse" }, "x"), base, "extra player-ish arguments changed the brief");
  }
  const distinct = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => JSON.stringify(generateSeasonBrief(seed))));
  assert.ok(distinct.size > 1, "the seed actually steers the brief");
});

Given("a proposal that ignores the season brief but satisfies every envelope validator", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgProposal = mkProposal(ctx, (i) => ({
    stats: variedStats(i),
    hiddenElements: [
      { kind: "divergent-persona", detail: `plays a role, number ${i}` },
      { kind: "pre-game-tie", detail: `a quiet pre-show pact, number ${i}` },
      { kind: "secret-motive", detail: `a private reason, number ${i}` },
    ],
  }));
});

Then("the proposal commits", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  assert.ok(r.varianceOk, "the cast cleared the variance floor");
  assert.equal(r.violations.filter((v) => v.action === "re-roll").length, 0, "no re-roll violations — only the engine's caps/floors bind");
  assert.ok(r.npcs.every((n) => n.stats !== undefined), "every NPC committed its clamped stats");
});

// ── Rule: hidden material routes to the Vault; the tie graph is validated for sanity ─────────────────

Given("a committed cast whose proposal carried hidden elements, tie backstories, and a private orientation", function (this: BbWorld) {
  // A seed whose warmed cast seals >=1 private orientation (so the "no private orientation leaks" sweep is meaningful) AND whose committed ties include >=1 SECRET one (ORW-132 marks each tie secret or
  // public at season start; the sealed-state rule is about the secret ones).
  let built = false;
  for (let sd = 1; sd <= 200 && !built; sd++) {
    const layer = generateDiversityLayer(sd, startNewGame({ seed: sd, playerName: "The Player" }).npcs);
    if (Object.keys(layer.privateOrientations).length === 0) continue;
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor(`cg-seal-${cgUsers++}`);
    const ids = sb.session.preSeedCast({ seed: sd }).house.map((h) => h.id);
    const sentinel = `SENTINEL-0116-SEAL-${cgUsers}`;
    const proposal = fullProposal(ids);
    (proposal.npcs[0] as { hiddenElements: { detail: string }[] }).hiddenElements[0]!.detail = `secret ${sentinel}`;
    (proposal.ties[0] as { backstory?: string }).backstory = `they met at ${sentinel}`;
    sb.session.recordCastGenesis(proposal as never);
    sb.session.createCharacter({ playerName: "The Player" });
    const ties = sb.session.snapshot().seededRelationships?.ties ?? [];
    if (!ties.some((t) => (t as { visibility?: string }).visibility !== "public")) continue;
    sb.syncAdmin();
    cg(this).cgSentinel = sentinel;
    cg(this).cgSandbox = sb;
    built = true;
  }
  assert.ok(built, "no seed sealed a private orientation with a secret committed tie");
});

Given("every committed tie's exposure is sealed and no reveal pathway has fired", function (this: BbWorld) {
  const ties = cg(this).cgSandbox!.session.snapshot().seededRelationships?.ties ?? [];
  // ORW-132: each tie is marked secret or public at season start, and a PUBLIC tie is meant to be known (it starts exposed and is announced on Day 1). The hidden-info rule is about the SECRET ones: every
  // secret tie must still be sealed (no pathway fired). The leak sweep below is unchanged and still covers EVERY tie backstory (a public tie's backstory text stays off the surfaces too).
  const secret = ties.filter((t) => (t as { visibility?: string }).visibility !== "public");
  assert.ok(secret.length > 0, "the scenario needs at least one SECRET tie to be meaningful");
  assert.ok(secret.every((t) => tieExposureOf(t) === "sealed"), "every SECRET committed tie is sealed (no pathway fired)");
  assert.ok(ties.filter((t) => (t as { visibility?: string }).visibility === "public").every((t) => tieExposureOf(t) === "public"), "a public tie starts exposed");
});

When("the player and admin projections are assembled", function (this: BbWorld) {
  const sb = cg(this).cgSandbox!;
  sb.syncAdmin();
  let sweep = JSON.stringify(sb.session.getGameState()) + JSON.stringify(sb.session.gameStatus());
  for (const h of sb.session.getGameState().house) sweep += JSON.stringify(sb.session.npcVoice(h.id) ?? {});
  sweep += JSON.stringify(sb.admin.inspect());
  cg(this).cgSweep = sweep;
  // Route the scenario's final Then through the CANONICAL shared Vault-sentinel sweep owned by
  // god_mode.steps.ts ("no Vault sentinel value appears" = `assertNoSentinels(lastView, sandbox.sentinels)`):
  // feed it THIS scenario's assembled projection + sentinel via the shared World (the idiomatic cucumber
  // way to reuse a shared step, rather than redefining it and colliding).
  this.lastView = sweep;
  this.sandbox = { sentinels: [cg(this).cgSentinel!] } as unknown as Sandbox;
});

Then("no hidden element detail appears on any surface", function (this: BbWorld) {
  assert.ok(!cg(this).cgSweep!.includes(cg(this).cgSentinel!), "a hidden-element detail leaked onto a surface");
});

Then("no tie backstory or private orientation appears on any surface", function (this: BbWorld) {
  const sweep = cg(this).cgSweep!;
  assert.ok(!sweep.includes(cg(this).cgSentinel!), "a tie backstory leaked onto a surface");
  assert.ok(!sweep.includes("private-orientation "), "a private-orientation record leaked onto a surface");
});

Given("a committed model-proposed tie whose exposure is sealed", function (this: BbWorld) {
  const ctx = mkCtx();
  const proposal: CastGenesisProposal = {
    npcs: ctx.npcs.map((c) => ({ id: c.id })),
    ties: [{ a: npc(1), b: npc(2), nature: "shared-hometown" }],
  };
  const tie = validateCastGenesis(proposal, ctx).ties[0]!;
  assert.equal(tieExposureOf(tie), "sealed", "a genesis tie commits sealed");
  cg(this).cgTie = tie;
  cg(this).cgExposure = tieExposureOf(tie);
});

When("an overhear pathway fires for that tie", function (this: BbWorld) {
  cg(this).cgExposure = nextTieExposure(cg(this).cgExposure!, "overhear");
});

Then("the tie's exposure advances to surfaced-to-house", function (this: BbWorld) {
  assert.equal(cg(this).cgExposure, "surfaced-to-house", "the sealed tie advances one step on an overhear");
});

When("an accusation pathway lands for that tie", function (this: BbWorld) {
  cg(this).cgExposure = nextTieExposure(cg(this).cgExposure!, "accusation");
});

Then("the tie's exposure advances to public", function (this: BbWorld) {
  assert.equal(cg(this).cgExposure, "public", "an accusation carries the tie to public");
});

Then("only then may the narrator name the pair openly", function (this: BbWorld) {
  // Naming the pair openly is gated on `public` — the genesis tie inherits the 0095 lifecycle verbatim.
  assert.equal(cg(this).cgExposure, "public", "the narrator may name the pair openly only at `public`");
});

Given("a proposed hidden element whose kind is not a canonical hidden-element kind", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgProposal = mkProposal(ctx, (i, id) => (id === npc(1) ? {
    hiddenElements: [
      { kind: "made-up-kind", detail: "x" },
      { kind: "divergent-persona", detail: "smiles through a grudge" },
      { kind: "pre-game-tie", detail: "knew a producer" },
      { kind: "secret-motive", detail: "wants the fame" },
    ],
  } : {}));
});

Then("the element is refused and the violation names the field", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  assert.ok(r.violations.some((v) => v.npcId === npc(1) && v.field === "hiddenElements.kind"), "the bad kind is named as a violation");
  const els = r.npcs.find((n) => n.id === npc(1))!.hiddenElements ?? [];
  assert.ok(els.every((e) => (e.kind as string) !== "made-up-kind"), "the non-canonical kind is stripped");
});

Given("a proposed NPC carrying more hidden elements than the engine's range allows", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgProposal = mkProposal(ctx, (i, id) => {
    if (id === npc(1)) return { hiddenElements: Array.from({ length: 9 }, (_, k) => ({ kind: "divergent-persona", detail: `distinct secret ${k}` })) };
    if (id === npc(2)) return { hiddenElements: [{ kind: "secret-motive", detail: "wants fame" }, { kind: "bogus", detail: "x" }] }; // shortfall
    return {};
  });
});

Given("a proposed NPC carrying fewer hidden elements than the engine's range requires", function (this: BbWorld) {
  // npc:2 (set up in the step above) carries only one valid element — below the 3-element floor.
  const shortfall = cg(this).cgProposal!.npcs.find((n) => n.id === npc(2))!;
  assert.ok((shortfall.hiddenElements ?? []).filter((e) => e.kind === "secret-motive").length < GENESIS_HIDDEN_ELEMENT_RANGE.min,
    "the shortfall NPC carries fewer valid elements than the floor");
});

Then("each committed NPC carries a hidden-element count inside the engine's range", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  const over = r.npcs.find((n) => n.id === npc(1))!.hiddenElements ?? [];
  assert.ok(over.length <= GENESIS_HIDDEN_ELEMENT_RANGE.max, "an over-count is trimmed to the cap");
  assert.ok(over.length >= GENESIS_HIDDEN_ELEMENT_RANGE.min, "the trimmed set still clears the floor");
  // The shortfall NPC drops the whole authored set to the floor (the guaranteed 3–6 floor stands).
  assert.equal(r.npcs.find((n) => n.id === npc(2))!.hiddenElements, undefined, "a shortfall drops to the floor, never a sub-floor commit");
});

Given("a proposed NPC with a concealed-aptitude element their committed stats do not back", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgProposal = mkProposal(ctx, (i, id) => (id === npc(1) ? {
    stats: { physical: 0.8, mental: 0.25, social: 0.5 }, // a low MENTAL stat does not back a puzzle aptitude
    hiddenElements: [
      { kind: "concealed-aptitude", detail: "is far sharper at puzzles than they pretend" },
      { kind: "divergent-persona", detail: "acts like a harmless floater while reading the whole house" },
      { kind: "pre-game-tie", detail: "shares a hometown with someone" },
      { kind: "secret-motive", detail: "is here for redemption" },
    ],
  } : { stats: variedStats(i) }));
});

Then("the element is stripped or re-rolled with the violation named", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  assert.ok(r.violations.some((v) => v.npcId === npc(1) && v.field === "hiddenElements.concealed-aptitude"), "the unbacked aptitude is named");
  const els = r.npcs.find((n) => n.id === npc(1))!.hiddenElements ?? [];
  assert.ok(!els.some((e) => e.kind === "concealed-aptitude"), "the unbacked concealed aptitude is stripped");
});

Given("a proposed NPC carrying two secret-motive elements", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgProposal = mkProposal(ctx, (i, id) => (id === npc(1) ? {
    hiddenElements: [
      { kind: "secret-motive", detail: "wants the fame far more than the prize" },
      { kind: "secret-motive", detail: "is here for redemption after a public failure" },
      { kind: "divergent-persona", detail: "seems naive but clocks every move" },
      { kind: "pre-game-tie", detail: "once crossed paths with a houseguest" },
    ],
  } : {}));
});

Then("only one secret motive commits and the excess is stripped with the violation named", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  const motives = (r.npcs.find((n) => n.id === npc(1))!.hiddenElements ?? []).filter((e) => e.kind === "secret-motive");
  assert.equal(motives.length, 1, "at most one secret motive commits");
  assert.ok(r.violations.some((v) => v.npcId === npc(1) && v.field === "hiddenElements.secret-motive"), "the excess motive is named");
});

Given("a committed model-authored cast", function (this: BbWorld) {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`cg-leak-${cgUsers++}`);
  const ids = sb.session.preSeedCast({ seed: 2424 }).house.map((h) => h.id);
  sb.session.recordCastGenesis(fullProposal(ids) as never);
  sb.session.createCharacter({ playerName: "The Player" });
  sb.syncAdmin();
  cg(this).cgSandbox = sb;
});

When("every public-facing string of the committed cast is swept", function (this: BbWorld) {
  const sb = cg(this).cgSandbox!;
  const parts: string[] = [];
  for (const h of sb.session.getGameState().house) {
    const c = h as unknown as Record<string, unknown>;
    for (const k of ["name", "identityConcept", "biography", "vocation", "hometown", "demeanor", "appearance", "background", "presentation", "archetype", "ethnicity"]) {
      if (typeof c[k] === "string") parts.push(c[k] as string);
    }
    parts.push(JSON.stringify(sb.session.npcVoice(h.id)?.persona?.voice ?? {}));
  }
  cg(this).cgPublicStrings = parts.join("\n");
});

Then("no public string contains a stat-key substring or a bare float", function (this: BbWorld) {
  const s = cg(this).cgPublicStrings!;
  // The deepProfile no-leak discipline: the Vault scans hunt for stat-key/float SERIALIZATION, so public
  // prose may never carry a stat key adjacent to a number, nor a bare float.
  assert.ok(!/(physical|mental|social)["'\s]*[:=]\s*-?\d/i.test(s), "a stat-key serialization leaked into public prose");
  assert.ok(!/\d+\.\d+/.test(s), "a bare float leaked into public prose");
});

// ── Rule: identity facets run the inherited 0063 diversity pipeline unchanged ────────────────────────

Given("a proposal whose identity facets violate a diversity floor", function (this: BbWorld) {
  const seed = 555;
  cg(this).cgDvSeed = seed;
  cg(this).cgDvNpcs = startNewGame({ seed, playerName: "The Player" }).npcs;
  // A MONOCHROME proposal — force every NPC to the SAME non-BIPOC heritage (violates the BIPOC floor).
  const proposed: Record<string, { ethnicity?: string }> = {};
  for (const n of cg(this).cgDvNpcs!) proposed[n.id] = { ethnicity: "Irish American" };
  cg(this).cgDvProposed = proposed;
  // A sandbox at a seed known to seal a private orientation AND carry a publicly-out one.
  let chosen: UserSandbox | undefined;
  const reg = new GameSessionRegistry();
  for (let sd = 1; sd <= 120; sd++) {
    const layer = generateDiversityLayer(sd, startNewGame({ seed: sd, playerName: "The Player" }).npcs);
    const hasPrivate = Object.keys(layer.privateOrientations).length > 0;
    const hasOut = Object.values(layer.public).some((p) => p.outOrientation);
    if (hasPrivate && hasOut) {
      const sb = reg.sandboxFor(`cg-dv-${cgUsers++}`);
      sb.session.createCharacter({ playerName: "The Player", seed: sd });
      chosen = sb;
      break;
    }
  }
  assert.ok(chosen, "no seed produced both a private and a publicly-out orientation");
  cg(this).cgSandbox = chosen;
});

When("the engine runs the inherited diversity validation and repair", function (this: BbWorld) {
  cg(this).cgDvLayer = repairDiversityLayer(cg(this).cgDvSeed!, cg(this).cgDvNpcs!, cg(this).cgDvProposed!);
});

Then("the committed cast meets the floors and caps", function (this: BbWorld) {
  const pub = Object.values(cg(this).cgDvLayer!.public);
  assert.ok(pub.filter((p) => p.bipoc).length >= MIN_BIPOC, "the BIPOC floor is repaired even from a monochrome proposal");
  assert.ok(pub.filter((p) => p.genderPresentation === "man").length >= MIN_PER_BINARY_GENDER, "the men floor holds");
  assert.ok(pub.filter((p) => p.genderPresentation === "woman").length >= MIN_PER_BINARY_GENDER, "the women floor holds");
});

Then("each committed skin tone is re-grounded from the final committed heritage", function (this: BbWorld) {
  // skinTone is a pure function of the FINAL (repaired) heritage — every NPC sharing a heritage shares its tone.
  const byHeritage = new Map<string, Set<string>>();
  for (const p of Object.values(cg(this).cgDvLayer!.public)) {
    assert.ok(p.skinTone && p.skinTone.length > 0, "a skin tone is present");
    (byHeritage.get(p.ethnicity) ?? byHeritage.set(p.ethnicity, new Set()).get(p.ethnicity)!).add(p.skinTone);
  }
  for (const [, tones] of byHeritage) assert.equal(tones.size, 1, "a heritage mapped to more than one skin tone (not re-grounded)");
});

Then("a privately held orientation lands sealed in the Vault", function (this: BbWorld) {
  assert.ok(Object.keys(cg(this).cgSandbox!.session.snapshot().privateOrientations ?? {}).length > 0, "a private orientation is sealed");
});

Then("that private orientation is excluded from the public record and every outward projection", function (this: BbWorld) {
  const sb = cg(this).cgSandbox!;
  const sentinel = `SENTINEL-0116-DV-${cgUsers}`;
  const core = sb.session.snapshot();
  for (const id of Object.keys(core.privateOrientations!)) {
    core.privateOrientations![id] = `${core.privateOrientations![id]} ${sentinel}` as never;
  }
  sb.session.restore(core);
  sb.syncAdmin();
  let sweep = JSON.stringify(sb.session.getGameState()) + JSON.stringify(sb.session.gameStatus()) + JSON.stringify(sb.admin.inspect());
  for (const h of sb.session.getGameState().house) sweep += JSON.stringify(sb.session.npcVoice(h.id) ?? {});
  assert.ok(!sweep.includes(sentinel), "a private orientation leaked to a surface");
  assert.ok(!sweep.includes("private-orientation "), "a private-orientation record leaked to a surface");
});

Then("a publicly out orientation rides the public record like any other public facet", function (this: BbWorld) {
  const out = cg(this).cgSandbox!.session.getGameState().house.filter((h) => (h as { outOrientation?: string }).outOrientation);
  assert.ok(out.length > 0, "no publicly-out orientation on the public record");
});

Given("a proposal carrying more pre-show ties than the seeded-relationship budget allows", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgProposal = {
    npcs: ctx.npcs.map((c) => ({ id: c.id })),
    ties: [
      { a: npc(1), b: npc(2), nature: "shared-hometown" },
      { a: npc(3), b: npc(4), nature: "mutual-friend" },
      { a: npc(5), b: npc(6), nature: "old-acquaintance" }, // over the budget (2)
    ],
  };
});

Then("the committed tie graph holds at most the budgeted ties", function (this: BbWorld) {
  assert.equal(cg(this).cgResult!.ties.length, GENESIS_TIE_BUDGET, "the tie graph is dropped to the budget");
});

Then("every committed tie seals with sealed exposure", function (this: BbWorld) {
  assert.ok(cg(this).cgResult!.ties.every((t) => t.exposure === "sealed"), "every committed tie is sealed");
});

Then("the tie's standing affinity fold magnitude is the engine's own constant", function (this: BbWorld) {
  // The engine owns the fold magnitude (`TIE_AFFINITY_BIAS`); the proposal never sets it. A committed tie
  // carries only the pair + nature + sealed exposure — no magnitude field crosses.
  assert.ok(typeof TIE_AFFINITY_BIAS === "number" && TIE_AFFINITY_BIAS > 0 && TIE_AFFINITY_BIAS < 1, "the fold magnitude is the engine constant");
  for (const t of cg(this).cgResult!.ties) {
    assert.deepEqual(Object.keys(t).sort(), ["a", "b", "exposure", "nature"], "no magnitude field crosses on the committed tie");
  }
});

Given("a proposal with a tie involving the player and a houseguest carrying two ties", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgProposal = {
    npcs: ctx.npcs.map((c) => ({ id: c.id })),
    ties: [
      { a: npc(1), b: PLAYER },   // to the player
      { a: npc(2), b: npc(2) },   // self
      { a: npc(3), b: npc(4) },   // valid
      { a: npc(3), b: npc(5) },   // npc:3 doubled
    ],
  };
});

Then("both violations are named and the tie-graph slice is re-rolled", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  assert.equal(r.ties.length, 1, "only the single valid tie commits");
  assert.deepEqual({ a: r.ties[0]!.a, b: r.ties[0]!.b }, { a: npc(3), b: npc(4) }, "the valid tie is the one committed");
  assert.ok(r.violations.filter((v) => v.field === "ties").length >= 3, "the invalid tie slice is re-rolled");
  assert.ok(r.violations.some((v) => v.field === "ties" && /player|self|unknown/.test(v.rule)), "the player/self endpoint is named");
  assert.ok(r.violations.some((v) => v.field === "ties" && /more than one tie/.test(v.rule)), "the doubled houseguest is named");
});

// ── Rule: hidden game weights are never proposable ───────────────────────────────────────────────────

Given("a proposal that includes influence values, a trigger volatility, and a day-one read of the player", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgProposal = mkProposal(ctx, (i, id) => (id === npc(1) ? {
    influence: { persuasiveness: 0.99 },
    volatility: 0.9,
    dayOnePerception: { trustLean: 0.9, threatLean: -0.9 },
  } as GenesisNpcProposal : {}));
});

Then("those fields are ignored and flagged, never committed", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  const committed = r.npcs.find((n) => n.id === npc(1))! as unknown as Record<string, unknown>;
  for (const k of ["influence", "volatility", "dayOnePerception", "persuasiveness"]) {
    assert.equal(committed[k], undefined, `${k} must never commit`);
  }
  assert.ok(r.violations.some((v) => v.npcId === npc(1) && v.action === "ignored" && v.field === "influence"), "influence is flagged ignored");
  assert.ok(r.violations.some((v) => v.npcId === npc(1) && v.action === "ignored" && v.field === "volatility"), "volatility is flagged ignored");
});

Then("the engine seeds every hidden weight off the committed cast exactly as today", function (this: BbWorld) {
  // The committed skeleton carries NO hidden game weight — the engine seeds those from the committed cast
  // at game start (byte-identical to the no-proposal floor), never from the model.
  const committed = cg(this).cgResult!.npcs.find((n) => n.id === npc(1))! as unknown as Record<string, unknown>;
  for (const k of ["influence", "volatility", "dayOnePerception", "persuasiveness", "susceptibility", "trigger"]) {
    assert.equal(committed[k], undefined, `${k} is engine-seeded, never proposable`);
  }
});

// ── Rule: invalid proposals re-roll bounded, then fail LOUD before finalize under the strict policy ──

Given("a proposal in which one NPC fails a validator and fourteen pass", function (this: BbWorld) {
  const ctx = mkCtx();
  cg(this).cgCtx = ctx;
  cg(this).cgTarget = npc(1);
  cg(this).cgProposal = mkProposal(ctx, (i, id) => (id === npc(1) ? { name: "Solo" } : { name: synthName(i + 3) }));
});

When("the engine requests a re-roll", function (this: BbWorld) {
  cg(this).cgResult = validateCastGenesis(cg(this).cgProposal!, cg(this).cgCtx!);
});

Then("only the failing NPC is re-proposed", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  assert.equal(r.npcs.find((n) => n.id === npc(1))!.name, undefined, "the failing NPC's name is dropped (re-roll)");
  const nameRerolls = r.violations.filter((v) => v.field === "name" && v.action === "re-roll");
  assert.equal(nameRerolls.length, 1, "exactly one NPC is re-rolled");
  assert.equal(nameRerolls[0]!.npcId, npc(1), "the re-roll targets only the failing NPC");
  assert.equal(r.npcs.filter((n) => n.id !== npc(1) && n.name !== undefined).length, 14, "the other fourteen commit their names");
});

Then("the violation set is echoed to the model with the re-roll", function (this: BbWorld) {
  const r = cg(this).cgResult!;
  assert.ok(r.violations.length > 0, "structured violations are returned for the bounded FE re-roll");
  assert.ok(r.violations.some((v) => v.npcId === npc(1) && v.rule.length > 0), "the violation names the failing NPC + rule");
});

Given("genesis has exhausted its re-roll budget under the strict enrichment policy", function (this: BbWorld) {
  const session = new GameSessionAdapter();
  const ids = session.preSeedCast({ seed: 3030 }).house.map((h) => h.id);
  cg(this).cgSession = session;
  // A FLAT cast fails the cast-wide variance floor — which cannot be clamped in place, only re-rolled. After
  // the FE's bounded re-roll budget is spent, this is the LAST, still-failing result.
  const proposal = { npcs: ids.map((id) => ({ id, stats: { physical: 0.6, mental: 0.6, social: 0.6 } })) };
  cg(this).cgCallResult = session.recordCastGenesis(proposal as never);
});

When("the player attempts to finalize casting", function () {
  // Under the STRICT enrichment policy the FE HOLDS finalize (it never calls createCharacter) — modeled
  // here by NOT starting the game, so the engine is asked only for the material the hold surface renders.
  // The FE hold surface + visible refusal live in `frontend/src/enrichment_policy.py`, gated FE-side by its
  // own pytest suite; the ENGINE half — the named last-violation set + never auto-starting — is asserted here.
});

Then("the finalize is held with a visible refusal naming the last violation set", function (this: BbWorld) {
  const r = cg(this).cgCallResult!;
  assert.equal(r.varianceOk, false, "the last attempt still fails the variance floor");
  const named = r.violations.filter((v) => v.action === "re-roll");
  assert.ok(named.length > 0, "the last violation set is present for the refusal");
  assert.ok(named.some((v) => v.rule.length > 0), "the refusal names the last violation");
});

Then("the game does not start on the deterministic floor", function (this: BbWorld) {
  // The engine never auto-starts — createCharacter (finalize) is a separate, explicit call the FE withheld.
  assert.equal(cg(this).cgSession!.getGameState().started, false, "no season started on the floor");
});

Then("the operator-facing hold surface shows why", function (this: BbWorld) {
  // The hold surface renders the engine's structured, Vault-free violation set (which NPC / field / rule).
  const r = cg(this).cgCallResult!;
  assert.ok(r.violations.every((v) => typeof v.rule === "string" && typeof v.field === "string"), "violations are structured + Vault-free");
  assert.ok(r.violations.some((v) => v.field === "stats.variance"), "the why is named (the variance floor)");
});

// ── Rule: the test floor is unchanged; the committed genesis is the recorded world-gen artifact ──────

Given("a committed model-authored cast persisted to the save", function (this: BbWorld) {
  // A registry sandbox so the durable SessionSnapshot (events/relationships/vault — the 0031 checkpoint's
  // projection) is available for the superset gate; the bare-adapter restore below demonstrates the reload.
  const reg = new GameSessionRegistry();
  const user = `cg-reload-${cgUsers++}`;
  const sb = reg.sandboxFor(user);
  const ids = sb.session.preSeedCast({ seed: 3232 }).house.map((h) => h.id);
  sb.session.recordCastGenesis(fullProposal(ids) as never);
  sb.session.createCharacter({ playerName: "The Player" }); // persists the started season
  cg(this).cgReg = reg;
  cg(this).cgRegUser = user;
  cg(this).cgSession = sb.session;
  cg(this).cgRosterA = JSON.stringify(sb.session.getGameState().house);
  cg(this).cgBriefA = sb.session.snapshot().seasonBrief ?? undefined;
});

When("the engine restarts and the game resumes", function (this: BbWorld) {
  const revived = new GameSessionAdapter();
  revived.restore(cg(this).cgSession!.snapshot()); // reads from the store, never the model
  cg(this).cgReloaded = revived;
});

Then("the cast \\(season brief included) is read from the store byte-equal", function (this: BbWorld) {
  const revived = cg(this).cgReloaded!;
  assert.equal(JSON.stringify(revived.getGameState().house), cg(this).cgRosterA, "the committed cast is read back byte-equal");
  assert.deepEqual(revived.snapshot().seasonBrief, cg(this).cgBriefA, "the seeded season brief survives the restart byte-equal");
});

Then("no genesis call is made on resume", function (this: BbWorld) {
  // The revived adapter has NO warmed cast and no model, yet the authored identity concepts are present —
  // proof they were read from the store, not regenerated by a genesis call.
  assert.ok(cg(this).cgReloaded!.getGameState().house.every((h) => typeof (h as { identityConcept?: string }).identityConcept === "string"),
    "the authored identities came from the store, not a fresh genesis call");
});

Then("a later write that thins the committed cast is refused by the superset gate", function (this: BbWorld) {
  // The durable SessionSnapshot (events/relationships included) — the exact projection the 0031 integrity
  // checkpoint runs its non-degradation superset gate over.
  cg(this).cgReg!.invalidateSnapshot(cg(this).cgRegUser!);
  const snap = cg(this).cgReg!.snapshot(cg(this).cgRegUser!);
  const baseline = toGameState(snap);
  // A thinned candidate — one committed houseguest dropped from the cast.
  const thinnedSnap = JSON.parse(JSON.stringify(snap)) as typeof snap;
  thinnedSnap.house!.npcs.pop();
  assert.equal(isSuperset(toGameState(thinnedSnap), baseline), false, "the superset gate refuses a thinned cast");
  // The gate is not vacuously false: an untouched re-projection IS a superset of itself.
  assert.equal(isSuperset(toGameState(JSON.parse(JSON.stringify(snap)) as typeof snap), baseline), true, "an intact cast passes the gate");
});
