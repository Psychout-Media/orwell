import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { RelationshipModel } from "../../src/engine/relationships";
import type { ConfideResult } from "../../src/ports/GameSession";
import { ORIENTATION_DISCLOSURE } from "../../src/engine/diversity";
import { livePlayerSurfaces, liveAdminSurface } from "../support/liveSweep";
import { answerPending } from "../support/answerPending";
import { outcomeOf, type SeasonOutcome } from "../support/seasonOutcome";

/**
 * Feature 0141 — a private orientation reaches the player ONLY by the houseguest's own choice (ORW-261). Roles only:
 * the player, a houseguest (the one holding the sealed orientation). Drives the REAL registry sandbox, so the confide
 * pathway is wired exactly as the composition root wires it (`setOnConfide` -> the knowledge store's `told-by` pathway)
 * and every player / admin surface the sweep reads is the live game's own. The "ask" is the confide press — the engine
 * lever; an ask's wording never reaches the engine. The orientation is a unique marker string so a leak is unmistakable.
 */

interface Game { sb: UserSandbox; npc: EntityId; marker: string }
interface OState {
  oGame?: Game;
  oMarker?: string;
  oSeed?: number;
  oTrust?: number;
  oPerSeed?: boolean[];
  oRepeat?: boolean[];
  oResults?: ConfideResult[];
  oTwinResults?: ConfideResult[];
  oTwin?: Game;
  oRates?: { low: number; high: number; below: number };
  oPreSurfaces?: string;
  oPreAdmin?: string;
  oOn?: { outcome: SeasonOutcome; trail: string[]; told: boolean };
  oOff?: { outcome: SeasonOutcome; trail: string[]; told: boolean };
  oSweep?: string[];
}
const os = (w: BbWorld): OState => w as unknown as OState;

let users = 0;
const MARKER = "ORIENT-MARKER-0141";
const HIGH = 0.95;

/**
 * A live, PLAYED season (the first announced message is noted — disclosure routing runs in played games only) whose
 * first secret-holding houseguest holds `marker` as a private orientation, sealed through the persisted snapshot.
 */
function liveGame(seed: number, marker: string, opts: { trust?: number; sealed?: boolean; closed?: boolean } = {}): Game {
  const sb = new GameSessionRegistry().sandboxFor(`orw0141-${seed}-${++users}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const core = sb.session.snapshot();
  const npc = core.house!.npcs.find((n) => (n.character.hiddenElements ?? []).length > 0)!.id;
  const priv: Record<string, string> = { ...(core.privateOrientations ?? {}) };
  if (opts.sealed === false) delete priv[npc];
  else priv[npc] = marker;
  core.privateOrientations = priv as never;
  sb.session.restore(core);
  const g: Game = { sb, npc, marker };
  if (opts.trust !== undefined) trust(g, opts.trust);
  seatAlone(g);
  sb.session.noteMessage({ messageId: "first" });
  if (opts.closed) {
    // The disclosure path CLOSED for every houseguest through the engine's own told-once gate (the only reader of it).
    const live = (sb.session as unknown as { live: { orientationTold?: Record<string, true> } }).live;
    live.orientationTold = Object.fromEntries(core.house!.npcs.map((n) => [n.id, true as const]));
  }
  return g;
}

/** Both directed edges between the player and the houseguest, plus three banked pacts (the 0075 goodwill). */
function trust(g: Game, t: number): void {
  const rel = (g.sb.session as unknown as { rel: RelationshipModel }).rel;
  for (const [a, b] of [[g.npc, PLAYER], [PLAYER, g.npc]] as const) { const e = rel.edge(a, b); e.trust = t; e.affinity = t; e.threat = 0.05; }
  for (let i = 0; i < 3; i++) g.sb.session.makeDeal({ with: g.npc, kind: "final-two", terms: "ride or die" });
}

/** The player and the houseguest share one room; everyone else is elsewhere ("alone together"). */
function seatAlone(g: Game): void {
  const p = (g.sb.session as unknown as { presence?: Map<string, string> }).presence;
  if (!p) throw new Error("seatAlone: the session has no presence map, so the 'alone together' precondition cannot be set up");
  const rooms = [...new Set(p.values())];
  const here = p.get(PLAYER) ?? rooms[0]!;
  const away = rooms.find((r) => r !== here) ?? here;
  for (const id of p.keys()) p.set(id, id === PLAYER || id === g.npc ? here : away);
}

/** The player's told-by facts carrying the marker. */
const toldFacts = (g: Game) => g.sb.engine.knowledge.knownTo(PLAYER).filter((f) => f.content.includes(g.marker));
const heard = (g: Game): boolean => toldFacts(g).length > 0;
const routeOf = (g: Game): string | undefined => {
  const m = (g.sb.session as unknown as { orientationRoutes: Map<string, string> }).orientationRoutes;
  return [...m.entries()].find(([k]) => k.startsWith(`${g.npc}:`))?.[1];
};

function shareRate(t: number, n = 40): number {
  let c = 0;
  for (let seed = 1; seed <= n; seed++) { const g = liveGame(seed, MARKER, { trust: t }); g.sb.session.confide(g.npc); if (heard(g)) c++; }
  return c / n;
}

// ── Background ───────────────────────────────────────────────────────────────────────────────────

Given("a live, played season in which a houseguest holds a private orientation sealed in the Vault", function (this: BbWorld) {
  const g = liveGame(1, MARKER);
  // Precondition: it is genuinely held engine-side (persisted with the season) and the player knows nothing of it.
  assert.equal(g.sb.session.snapshot().privateOrientations?.[g.npc], MARKER, "the private orientation is sealed with the season");
  assert.equal(heard(g), false);
  os(this).oGame = g;
  os(this).oMarker = MARKER;
});

// ── Scenario: trusted press, some seeds, reproducible ─────────────────────────────────────────────

Given("the player is trusted by that houseguest and they are alone together", function (this: BbWorld) {
  os(this).oTrust = HIGH;
});

When("the player presses that houseguest to open up across many seeds", function (this: BbWorld) {
  const run = (): boolean[] => Array.from({ length: 40 }, (_, i) => {
    const g = liveGame(i + 1, MARKER, { trust: os(this).oTrust! });
    g.sb.session.confide(g.npc);
    return heard(g);
  });
  os(this).oPerSeed = run();
  os(this).oRepeat = run();
});

Then("on some seeds the houseguest tells the player, and on others they do not", function (this: BbWorld) {
  const told = os(this).oPerSeed!.filter(Boolean).length;
  assert.ok(told > 0, "no seed ever told — the path is dead");
  assert.ok(told < os(this).oPerSeed!.length, "every seed told — it is forced, not the houseguest's choice");
});

Then("the same seed gives the same answer on a repeat", function (this: BbWorld) {
  assert.deepEqual(os(this).oRepeat, os(this).oPerSeed);
});

// ── Scenario: a hold is final and indistinguishable from nothing-to-tell ──────────────────────────

Given("the engine's decision for that houseguest and moment is to hold", function (this: BbWorld) {
  // Probe seeds for a moment where the confidence itself went through (so the orientation decision was really
  // consulted) and the engine's orientation route for this houseguest and beat is `hold`.
  for (let seed = 1; seed <= 80; seed++) {
    const probe = liveGame(seed, MARKER, { trust: HIGH });
    const r = probe.sb.session.confide(probe.npc);
    if (r?.disclosed && r.truthful && routeOf(probe) === "hold") { os(this).oSeed = seed; return; }
  }
  assert.fail("no seed in 1..80 produced a consulted-and-held orientation decision");
});

When("the player presses them six times in that moment", function (this: BbWorld) {
  const seed = os(this).oSeed!;
  const g = liveGame(seed, MARKER, { trust: HIGH });
  // The twin: the same seed and setup, but this houseguest holds NO private orientation (nothing to disclose).
  const twin = liveGame(seed, MARKER, { trust: HIGH, sealed: false });
  os(this).oResults = Array.from({ length: 6 }, () => g.sb.session.confide(g.npc)!);
  os(this).oTwinResults = Array.from({ length: 6 }, () => twin.sb.session.confide(twin.npc)!);
  os(this).oGame = g; os(this).oTwin = twin;
});

Then("the player learns nothing about the private orientation", function (this: BbWorld) {
  const g = os(this).oGame!;
  assert.equal(heard(g), false, "a held orientation reached the player's knowledge");
  assert.ok(!JSON.stringify(os(this).oResults).includes(MARKER), "a held orientation rode the confide result");
  assert.ok(!livePlayerSurfaces(g.sb).includes(MARKER), "a held orientation reached a player surface");
});

Then("the narrator is handed exactly what it gets for a houseguest with nothing to disclose", function (this: BbWorld) {
  const g = os(this).oGame!; const t = os(this).oTwin!;
  assert.equal(JSON.stringify(os(this).oResults), JSON.stringify(os(this).oTwinResults), "the confide results differ from the nothing-to-tell twin");
  assert.equal(JSON.stringify(g.sb.session.npcVoice(g.npc)), JSON.stringify(t.sb.session.npcVoice(t.npc)), "the voicing projection differs");
  assert.equal(JSON.stringify(g.sb.session.getMomentPrompt({ moment: "social" })), JSON.stringify(t.sb.session.getMomentPrompt({ moment: "social" })), "the moment prompt differs");
  const known = (x: Game) => JSON.stringify(x.sb.engine.knowledge.knownTo(PLAYER).map((f) => [f.pathway, f.content]));
  assert.equal(known(g), known(t), "the player's knowledge differs");
});

// ── Scenario: monotone in trust ───────────────────────────────────────────────────────────────────

When("the same press is made across many seeds at low trust and at high trust", function (this: BbWorld) {
  os(this).oRates = { low: shareRate(0.55), high: shareRate(HIGH), below: shareRate(ORIENTATION_DISCLOSURE.trustBar - 0.3) };
});

Then("the share rate at high trust is greater than at low trust", function (this: BbWorld) {
  const r = os(this).oRates!;
  assert.ok(r.high > r.low, `high-trust rate ${r.high} is not above low-trust rate ${r.low}`);
});

Then("below the trust bar the houseguest never tells", function (this: BbWorld) {
  assert.equal(os(this).oRates!.below, 0);
});

// ── Scenario: a recorded, witnessed told-by fact ──────────────────────────────────────────────────

Given("a unique marker as the private orientation", function (this: BbWorld) {
  os(this).oMarker = `${MARKER}-UNIQUE`;
});

Given("a moment in which the houseguest chooses to tell", function (this: BbWorld) {
  for (let seed = 1; seed <= 80; seed++) {
    const probe = liveGame(seed, os(this).oMarker!, { trust: HIGH });
    probe.sb.session.confide(probe.npc);
    if (heard(probe)) { os(this).oSeed = seed; break; }
  }
  assert.ok(os(this).oSeed !== undefined, "no seed in 1..80 told");
  const g = liveGame(os(this).oSeed!, os(this).oMarker!, { trust: HIGH });
  os(this).oGame = g;
  os(this).oPreSurfaces = livePlayerSurfaces(g.sb);
  os(this).oPreAdmin = liveAdminSurface(g.sb);
});

When("the player presses that houseguest to open up", function (this: BbWorld) {
  const g = os(this).oGame!;
  g.sb.session.confide(g.npc);
});

Then("before the telling the marker was on no player surface and no admin surface", function (this: BbWorld) {
  const g = os(this).oGame!;
  // The sweep bites: the marker IS in the live hidden state the surfaces are built from.
  assert.equal(g.sb.session.snapshot().privateOrientations?.[g.npc], g.marker);
  assert.ok(!os(this).oPreSurfaces!.includes(g.marker), "the sealed orientation was on a player surface before it was told");
  assert.ok(!os(this).oPreAdmin!.includes(g.marker), "the sealed orientation was on the admin surface");
});

Then("the knowledge store holds a told-by fact carrying the marker whose source is that houseguest", function (this: BbWorld) {
  const g = os(this).oGame!;
  const facts = toldFacts(g);
  assert.equal(facts.length, 1, "exactly one fact carries the orientation");
  assert.equal(facts[0]!.pathway, `told-by:${g.npc}`);
  assert.equal(facts[0]!.subject, g.npc);
});

Then("the fact is the player's own, visible in their journal", function (this: BbWorld) {
  const g = os(this).oGame!;
  assert.ok(g.sb.player.renderLog().includes(g.marker), "the told orientation is not in the player's journal");
  assert.ok(JSON.stringify(g.sb.player.getVisibleState().knowledge).includes(g.marker), "the told orientation is not in the player's visible knowledge");
});

// ── Scenario: the marker sweep — nothing outside the told path ────────────────────────────────────

When("a played season runs many beats without the player ever pressing that houseguest", function (this: BbWorld) {
  const g = liveGame(7, os(this).oMarker!, { trust: HIGH });
  os(this).oGame = g;
  g.sb.session.setPerConversationClockEnabled(false); // drive beat by beat (see playPressing)
  const sweeps: string[] = [];
  for (let i = 0; i < 240; i++) {
    const v = g.sb.session.advanceGame();
    if (v.pending) { const req = answerPending(v.pending); if (req) g.sb.session.submitDecision(req); }
    if (i % 30 === 0) sweeps.push(livePlayerSurfaces(g.sb), liveAdminSurface(g.sb));
    if (v.finished) break;
  }
  sweeps.push(livePlayerSurfaces(g.sb), liveAdminSurface(g.sb));
  const week = (g.sb.session.snapshot().live as { week: number }).week;
  assert.ok(week >= 4, `the season genuinely ran (reached week ${week})`);
  os(this).oSweep = sweeps;
});

Then("the marker appears on no player surface and no admin surface", function (this: BbWorld) {
  const g = os(this).oGame!;
  assert.equal(g.sb.session.snapshot().privateOrientations?.[g.npc], g.marker, "the marker is still sealed in the live game (the sweep bites)");
  for (const s of os(this).oSweep!) assert.ok(!s.includes(g.marker), "the private orientation leaked outside the told-by path");
});

Then("the player holds no told-by fact carrying the marker", function (this: BbWorld) {
  assert.equal(heard(os(this).oGame!), false);
});

// ── Scenario: no competition outcome moves ────────────────────────────────────────────────────────

function playPressing(seed: number, closed: boolean): { outcome: SeasonOutcome; trail: string[]; told: boolean } {
  const g = liveGame(seed, MARKER, { trust: HIGH, closed });
  const trail: string[] = [];
  const s = g.sb.session;
  // A played game holds each beat for the in-game day schedule (~5 in-game minutes a message); pin the per-conversation clock off
  // so the season can be driven beat by beat (identically in both runs — the disclosure path never reads the clock).
  s.setPerConversationClockEnabled(false);
  for (let i = 0; i < 6000; i++) {
    const evicted = new Set((s.snapshot().live as { evictionOrder?: string[] } | undefined)?.evictionOrder ?? []);
    if (!evicted.has(g.npc)) { seatAlone(g); s.confide(g.npc); }
    const v = s.advanceGame();
    if (v.pending) { const req = answerPending(v.pending); if (req) s.submitDecision(req); }
    const live = s.snapshot().live as { week: number; hoh?: string; nominees?: string[] } | undefined;
    const row = `${live?.week}:${live?.hoh ?? "-"}:${(live?.nominees ?? []).join(",")}`;
    if (trail[trail.length - 1] !== row) trail.push(row);
    if (v.finished) return { outcome: outcomeOf(s), trail, told: heard(g) };
  }
  throw new Error("the pressed season did not finish");
}

When("the same seeded, played season is run with the disclosure open and with it closed, the player pressing that houseguest at every beat", function (this: BbWorld) {
  for (const seed of [3, 5, 8, 11]) {
    const on = playPressing(seed, false);
    if (!on.told) continue;
    os(this).oOn = on;
    os(this).oOff = playPressing(seed, true);
    return;
  }
  assert.fail("no seed produced a telling in the open run");
});

Then("the houseguest told the player in the open run and not in the closed run", function (this: BbWorld) {
  assert.equal(os(this).oOn!.told, true);
  assert.equal(os(this).oOff!.told, false);
});

Then("every competition, nomination and eviction outcome is identical", function (this: BbWorld) {
  assert.deepEqual(os(this).oOn!.trail, os(this).oOff!.trail, "an HOH or nomination differed");
  assert.deepEqual(os(this).oOn!.outcome, os(this).oOff!.outcome, "an eviction, competition tally or finale outcome differed");
});
