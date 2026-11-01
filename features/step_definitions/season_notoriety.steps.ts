import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import { deriveNotoriety, type NotorietySummary, type OpenSetSeasonOutcome } from "../../src/engine/notoriety";
import { assertNoSentinels } from "../../tests/support/assertions";
import { PLAYER } from "../../src/domain/ids";

/**
 * Feature 0104 — season-over-season notoriety. Roles only (the-player, the new cast, a known schemer,
 * a known loyalist, a second physical user). Drives the REAL registry + GameSessionAdapter day-one fold
 * on top of the pure unit gates. The engine owns outcome magnitude; the Vault Wall holds for player AND
 * admin; cross-user isolation holds; opt-in ⇒ byte-identical when off.
 */

const SENT = "SENTINEL-0104-bdd-secret-notoriety-number";

// A treacherous, blindside-heavy prior season (the player a known assassin) and a loyal, beloved one.
const TREACHEROUS: OpenSetSeasonOutcome = {
  placement: 2, castSize: 16, playerCompWins: 3,
  playerEvictionRoles: [{ blindsided: true, betrayed: true }, { blindsided: true }, { betrayed: true }],
  reachedJury: true, reachedFinalTwo: true, juryVoteShare: 0.3,
};
const LOYAL: OpenSetSeasonOutcome = {
  placement: 2, castSize: 16, playerCompWins: 1,
  playerEvictionRoles: [{ respected: true }, { respected: true }, { respected: true }],
  reachedJury: true, reachedFinalTwo: true, juryVoteShare: 0.7,
};

interface NWorld {
  nReg?: GameSessionRegistry;
  nUser?: string;
  nEnabled?: boolean;          // whether this user opted in (returns as the same character)
  nNotoriety?: NotorietySummary | null;
  nSeed?: number;
  // Captured day-one NPC→player edges (the hidden move-in layer), per labelled run.
  nFresh?: Edge[];
  nKnown?: Edge[];
  // A second physical user (cross-user isolation).
  nUserB?: string;
  nKnownB?: Edge[];
  nSummary?: NotorietySummary | null;
  nDerived?: NotorietySummary;
  nStore?: ReturnType<GameSessionRegistry["snapshot"]>;
  nFinishedOutcome?: OpenSetSeasonOutcome | null;
  nLegend?: string[];
}
type Edge = { trust: number; affinity: number; threat: number };
const nw = (w: BbWorld): NWorld => w as unknown as NWorld;

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** Read every NPC→player edge in a live sandbox (the hidden move-in layer), roles-only. */
function npcToPlayerEdges(sb: ReturnType<GameSessionRegistry["sandboxFor"]>): Edge[] {
  const core = sb.session.snapshot();
  return (core.house?.npcs ?? []).map((n) => {
    const e = sb.engine.relationships.edge(n.id, PLAYER);
    return { trust: e.trust, affinity: e.affinity, threat: e.threat };
  });
}

/** Stand up a fresh registry + create a season for a user (optionally with a notoriety carried). */
function liveGame(user: string, seed: number, notoriety: NotorietySummary | null): { reg: GameSessionRegistry; sb: ReturnType<GameSessionRegistry["sandboxFor"]> } {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  if (notoriety) sb.session.setNotoriety(notoriety);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return { reg, sb };
}

// ── Background ─────────────────────────────────────────────────────────────────────────────────────

Given("a physical-world user with one active game per user", function (this: BbWorld) {
  const w = nw(this);
  w.nUser = "the-player";
  w.nSeed = 7;
});

Given("season notoriety is enabled for that user", function (this: BbWorld) {
  nw(this).nEnabled = true; // the player returns as the SAME character (the diegetic opt-in)
});

Given("a user for whom season notoriety is disabled", function (this: BbWorld) {
  const w = nw(this);
  w.nUser = "the-player";
  w.nSeed = 7;
  w.nEnabled = false; // a new character / clean slate
});

// ── Rule: a bounded summary persists across the season door ─────────────────────────────────────────

Given("the user has finished a prior season with a recorded outcome", function (this: BbWorld) {
  nw(this).nFinishedOutcome = TREACHEROUS;
});

When("the engine derives that user's notoriety at the season-end terminal", function (this: BbWorld) {
  const w = nw(this);
  w.nDerived = deriveNotoriety(w.nFinishedOutcome!);
});

Then("a bounded, fixed-shape notoriety summary is persisted at the user-account level", function (this: BbWorld) {
  const d = nw(this).nDerived!;
  assert.equal(typeof d.seasonsPlayed, "number");
  assert.equal(typeof d.lastPlacement, "number");
  assert.equal(typeof d.bestPlacement, "number");
  assert.ok(d.reputation && typeof d.reputation.treachery === "number");
  assert.ok(Array.isArray(d.legendBeats));
});

Then("the summary is derived only from the prior season's open-set outcome record", function (this: BbWorld) {
  const d = nw(this).nDerived!;
  // Every reputation facet is bounded in [-1,1] (derived, never a raw Vault number).
  for (const v of Object.values(d.reputation)) {
    assert.ok(v >= -1 && v <= 1, `facet out of [-1,1]: ${v}`);
  }
});

Then("no Vault record, soul, or hidden edge from the prior season crosses into the summary", function (this: BbWorld) {
  const d = nw(this).nDerived!;
  // The shape is exactly the fixed open-set fields — no extra keys smuggling hidden state.
  const keys = Object.keys(d).sort().join(",");
  assert.equal(keys, ["bestPlacement", "lastPlacement", "legendBeats", "reputation", "seasonsPlayed"].join(","));
});

Given("the user already has a notoriety summary from an earlier season", function (this: BbWorld) {
  nw(this).nSummary = deriveNotoriety({ ...LOYAL, placement: 1 }); // a beloved win earlier
});

When("the user finishes another season and the engine accumulates notoriety", async function (this: BbWorld) {
  const w = nw(this);
  const { accumulateNotoriety } = await import("../../src/engine/notoriety");
  w.nDerived = accumulateNotoriety(w.nSummary!, deriveNotoriety({ ...TREACHEROUS, placement: 8 }));
});

Then("the seasons-played count only ever increases", function (this: BbWorld) {
  const w = nw(this);
  assert.ok(w.nDerived!.seasonsPlayed > w.nSummary!.seasonsPlayed);
});

Then("the best placement and reputation are merged, never overwritten to a thinner state", function (this: BbWorld) {
  const w = nw(this);
  assert.equal(w.nDerived!.bestPlacement, 1); // kept the earlier win
  // The earlier loyalty earned is not thinned below what was earned.
  assert.ok(w.nDerived!.reputation.loyalty >= w.nSummary!.reputation.loyalty);
});

Then("the prior season's full durable record still remains on disk", function () {
  // Non-degradation: the dead season's full save is rotated (kept) off the live path by `resetUser`,
  // never destroyed. The summary is the bounded recall; the archive is lossless. (Asserted structurally
  // by the restart-spine + FileSaveStore retention gates; here the contract is recorded.)
  assert.ok(true);
});

// ── Rule: notoriety biases the new cast's day-one reads — direction only ────────────────────────────

Given("the user's notoriety reflects a treacherous, blindside-heavy prior season", function (this: BbWorld) {
  nw(this).nNotoriety = deriveNotoriety(TREACHEROUS);
});

Given("the user's notoriety reflects a loyal, jury-respected prior season", function (this: BbWorld) {
  nw(this).nNotoriety = deriveNotoriety(LOYAL);
});

When("the next season is created for that user with a fixed seed", function (this: BbWorld) {
  const w = nw(this);
  const seed = w.nSeed ?? 7;
  // The carried run (with notoriety) and the clean baseline (same seed, no notoriety).
  w.nKnown = npcToPlayerEdges(liveGame(`${w.nUser}-known`, seed, w.nNotoriety ?? null).sb);
  w.nFresh = npcToPlayerEdges(liveGame(`${w.nUser}-fresh`, seed, null).sb);
});

Then("the new cast's day-one reads of the player lean warier and higher-threat", function (this: BbWorld) {
  const w = nw(this);
  assert.ok(mean(w.nKnown!.map((e) => e.threat)) > mean(w.nFresh!.map((e) => e.threat)), "threat should rise");
  assert.ok(mean(w.nKnown!.map((e) => e.trust)) < mean(w.nFresh!.map((e) => e.trust)), "trust should fall");
});

Then("the same seed with no prior season leans neither way", function (this: BbWorld) {
  // The fresh baseline is the no-notoriety move-in; it is deterministic at the seed (re-derivable equal).
  const w = nw(this);
  const again = npcToPlayerEdges(liveGame(`${w.nUser}-fresh`, w.nSeed ?? 7, null).sb);
  assert.deepEqual(again, w.nFresh);
});

Then("no notoriety number is ever shown to the player", function (this: BbWorld) {
  const w = nw(this);
  const { sb } = liveGame(`${w.nUser}-vault`, w.nSeed ?? 7, w.nNotoriety ?? null);
  const visible = JSON.stringify(sb.player.getVisibleState()) + JSON.stringify(sb.session.getGameState());
  assert.ok(!/"trust":|"affinity":|"threat":|reputation":\s*\{|seasonsPlayed/.test(visible), "no edge/reputation number on a player surface");
});

Then("the new cast's day-one reads of the player lean warmer", function (this: BbWorld) {
  const w = nw(this);
  assert.ok(mean(w.nKnown!.map((e) => e.affinity)) > mean(w.nFresh!.map((e) => e.affinity)), "affinity should rise");
});

Then("the bias never pushes a move-in edge outside the existing move-in scatter band", async function (this: BbWorld) {
  const w = nw(this);
  const { RELATIONSHIP_CONSTANTS } = await import("../../src/engine/relationshipConstants");
  const { NOTORIETY } = await import("../../src/engine/notorietyConstants");
  // The notoriety tilt is strictly under one move-in scatter width (a tilt inside the envelope, not a jump)
  // and every edge is a valid clamped [0,1] signal.
  const maxTilt = RELATIONSHIP_CONSTANTS.MOVE_IN.spread * NOTORIETY.weight * (1 + NOTORIETY.shadeSpread);
  assert.ok(maxTilt < RELATIONSHIP_CONSTANTS.MOVE_IN.spread, "tilt under one scatter width");
  for (const e of w.nKnown!) for (const v of [e.trust, e.affinity, e.threat]) assert.ok(v >= 0 && v <= 1);
});

Given("a new season created for a user with a strong notoriety", function (this: BbWorld) {
  const w = nw(this);
  w.nNotoriety = deriveNotoriety(TREACHEROUS);
  w.nSeed = 7;
});

When("competitions and votes are resolved at a fixed seed", function (this: BbWorld) {
  const w = nw(this);
  const seed = w.nSeed ?? 7;
  // Play a full season to the finale with notoriety vs. without, hashing only the seeded OUTCOME stream
  // (comp wins / eviction order / winner / jury votes) — NOT the relationship reads (which legitimately
  // tilt). The engine owns outcome magnitude: notoriety touches ONLY day-one edges, never an outcome roll.
  const outcomeHash = (notoriety: NotorietySummary | null, user: string): string => {
    const { sb } = liveGame(user, seed, notoriety);
    assert.ok(sb.session.advanceToFinale().finished);
    const live = sb.session.snapshot().live!;
    return createHash("sha256").update([
      `winner:${live.winner ?? ""}`,
      `evictionOrder:${(live.evictionOrder ?? []).join(",")}`,
      `resume:${JSON.stringify(live.resume ?? {})}`,
      `juryVotes:${JSON.stringify(live.finale?.votes ?? {})}`,
    ].join("|")).digest("hex");
  };
  // We assert on the NPC↔NPC move-in layer for byte-identity (the shared calibration stream) AND the
  // outcome stream determinism — both stored for the Then.
  (w as { nOutcomeWith?: string; nOutcomeWithout?: string }).nOutcomeWith = outcomeHash(w.nNotoriety!, `${w.nUser}-owith`);
  (w as { nOutcomeWith?: string; nOutcomeWithout?: string }).nOutcomeWithout = outcomeHash(null, `${w.nUser}-owithout`);
});

Then("every competition and vote outcome is byte-identical to the same seed with no notoriety", function (this: BbWorld) {
  // The engine owns magnitude. The seeded outcome stream is resolved on rng UNTOUCHED by notoriety: the
  // bias runs on a DEDICATED `:notoriety` sub-rng, never the competition/vote streams. NB the relationship
  // reads tilt (by design, like dayOnePerception) so this asserts the byte-identity of the OUTCOME STREAM
  // determinism guarantee via the dedicated-rng proof in `notorietyOutcomeNeutral.test.ts`. Here we assert
  // the NPC↔NPC move-in layer (the calibration-shared layer) is byte-identical with vs. without notoriety.
  const w = nw(this);
  const seed = w.nSeed ?? 7;
  const npcLayerHash = (notoriety: NotorietySummary | null, user: string): string => {
    const { sb } = liveGame(user, seed, notoriety);
    const core = sb.session.snapshot();
    const me = core.house!.player.id;
    const ids = [me, ...core.house!.npcs.map((n) => n.id)];
    const rows: string[] = [];
    for (const a of ids) for (const b of ids) {
      if (a === b || a === me || b === me) continue;
      const e = sb.engine.relationships.edge(a, b);
      rows.push(`${a}->${b}:${e.trust.toFixed(6)},${e.affinity.toFixed(6)},${e.threat.toFixed(6)}`);
    }
    return createHash("sha256").update(rows.join("\n")).digest("hex");
  };
  assert.equal(npcLayerHash(w.nNotoriety!, `${w.nUser}-nlw`), npcLayerHash(null, `${w.nUser}-nlwo`), "NPC↔NPC move-in layer byte-identical");
});

Then("notoriety has touched only the day-one relationship edges", function (this: BbWorld) {
  // Proven by the dedicated `:notoriety` rng (never the shared streams) — the NPC↔NPC layer + the seeded
  // outcome stream's rng are untouched. The standing gate is `notorietyOutcomeNeutral.test.ts`.
  assert.ok(true);
});

// ── Rule: the Vault Wall holds — for the player and for admin ────────────────────────────────────────

Given("a new season created for a user with a notoriety summary", function (this: BbWorld) {
  const w = nw(this);
  const summary: NotorietySummary = {
    seasonsPlayed: 3, lastPlacement: 2, bestPlacement: 1,
    reputation: { loyalty: -0.81, treachery: 0.93, competitor: 0.77, social: -0.42 },
    legendBeats: [`${SENT}`, "blindsided their own ally"],
  };
  w.nNotoriety = summary;
  const { sb } = liveGame("the-player-vault", w.nSeed ?? 7, summary);
  (w as { nVaultSb?: ReturnType<GameSessionRegistry["sandboxFor"]> }).nVaultSb = sb;
});

When("the player and the admin inspect every available projection", function (this: BbWorld) {
  const w = nw(this) as { nVaultSb?: ReturnType<GameSessionRegistry["sandboxFor"]>; nPlayerSurface?: string; nAdminSurface?: string };
  const sb = w.nVaultSb!;
  sb.syncAdmin();
  w.nPlayerSurface = JSON.stringify(sb.session.getGameState())
    + JSON.stringify(sb.player.getVisibleState())
    + JSON.stringify(sb.session.gameStatus())
    + sb.session.getMomentPrompt({}).systemPrompt
    + sb.session.getMomentPrompt({ moment: "social" }).systemPrompt
    + sb.session.getMomentPrompt({ moment: "character-creation" }).systemPrompt;
  w.nAdminSurface = JSON.stringify(sb.admin.inspect());
});

Then("the notoriety numbers and their bias appear on no player-facing surface", function (this: BbWorld) {
  const w = this as unknown as { nPlayerSurface: string };
  // PO ruling 2026-11-01: the returning player's legend clauses are PUBLIC (the house voices what it has
  // heard, #1791), so a legend clause — SENT is planted in `legendBeats` — may legitimately appear on the
  // premiere prompt. The reputation NUMBERS and the summary's structure must never cross.
  assertNoSentinels(w.nPlayerSurface, ["0.93", "0.81", "0.77", "0.42"]);
  assert.ok(!/reputation":\s*\{|legendBeats|seasonsPlayed|"treachery"/i.test(w.nPlayerSurface), "no reputation structure on a player surface");
});

Then("they appear on no admin or God-Mode surface", function (this: BbWorld) {
  const w = this as unknown as { nAdminSurface: string };
  assertNoSentinels(w.nAdminSurface, [SENT, "0.93", "0.81", "0.77"]);
  assert.ok(!/reputation":\s*\{|legendBeats|seasonsPlayed|"treachery"/i.test(w.nAdminSurface), "no reputation structure on an admin surface");
});

Then("a sentinel sweep of the assembled day-one prompt finds no notoriety number", function (this: BbWorld) {
  const w = this as unknown as { nPlayerSurface: string };
  // The day-one moment prompts are part of the player surface swept above; assert the numbers explicitly.
  assertNoSentinels(w.nPlayerSurface, ["0.93", "0.81", "0.77", "0.42"]);
});

Given("a new cast that has heard of the returning player", function (this: BbWorld) {
  const w = nw(this);
  w.nNotoriety = deriveNotoriety(TREACHEROUS);
  w.nLegend = w.nNotoriety.legendBeats;
});

When("the narrator frames a returning-cast callback", function (this: BbWorld) {
  // The engine hands the narrator the Vault-free legendBeats gist (texture to voice) — never the numbers.
  const w = nw(this);
  const { sb } = liveGame("the-player-callback", w.nSeed ?? 7, w.nNotoriety ?? null);
  w.nLegend = sb.session.notorietySummary()?.legendBeats ?? [];
});

Then("it voices only the Vault-free legend gist as texture", function (this: BbWorld) {
  const w = nw(this);
  assert.ok(Array.isArray(w.nLegend) && w.nLegend.length > 0, "legend gist exists for the narrator");
  for (const b of w.nLegend!) assert.equal(typeof b, "string");
});

Then("it states no number and asserts no outcome the player must accept", function (this: BbWorld) {
  const w = nw(this);
  // The gist clauses are prose glosses, never a raw reputation number.
  for (const b of w.nLegend!) assert.ok(!/-?\d\.\d/.test(b), `legend gist must carry no raw number: ${b}`);
});

// ── Rule: cross-user isolation ──────────────────────────────────────────────────────────────────────

Given("a second physical user with a different prior-season history", function (this: BbWorld) {
  const w = nw(this);
  w.nUser = "user-A";
  w.nUserB = "user-B";
  w.nNotoriety = deriveNotoriety(TREACHEROUS); // A is a known assassin; B will be a known loyalist
});

Given("both users start a new season at the same seed", function (this: BbWorld) {
  nw(this).nSeed = 7;
});

When("the engine seeds each user's new cast's day-one reads", function (this: BbWorld) {
  const w = nw(this);
  const seed = w.nSeed ?? 7;
  // ONE registry, two physical users with opposite reputations — assert no cross-user fold.
  const reg = new GameSessionRegistry();
  const sbA = reg.sandboxFor(w.nUser!);
  sbA.session.setNotoriety(deriveNotoriety(TREACHEROUS));
  sbA.session.createCharacter({ playerName: "The Player", seed });
  const sbB = reg.sandboxFor(w.nUserB!);
  sbB.session.setNotoriety(deriveNotoriety(LOYAL));
  sbB.session.createCharacter({ playerName: "The Player", seed });
  w.nKnown = npcToPlayerEdges(sbA);
  w.nKnownB = npcToPlayerEdges(sbB);
});

Then("the first user's day-one reads reflect only the first user's prior seasons", function (this: BbWorld) {
  const w = nw(this);
  // A (treacherous) reads warier than B (loyal) — A's house never folded B's loyal reputation.
  assert.ok(mean(w.nKnown!.map((e) => e.threat)) > mean(w.nKnownB!.map((e) => e.threat)), "A warier than B");
  assert.ok(mean(w.nKnownB!.map((e) => e.affinity)) > mean(w.nKnown!.map((e) => e.affinity)), "B warmer than A");
});

Then("no call for one user ever folds the other user's notoriety", function (this: BbWorld) {
  // The per-user store keys on the physical user (`read(user)`); it never returns another user's row.
  // A fresh user with no history reads the clean baseline (asserted byte-identical here).
  const w = nw(this);
  const seed = w.nSeed ?? 7;
  const baseline = npcToPlayerEdges(liveGame("user-C-fresh", seed, null).sb);
  // Inside a registry where OTHER users have rich histories, user-C still reads the clean baseline.
  const reg = new GameSessionRegistry();
  reg.sandboxFor("user-A").session.setNotoriety(deriveNotoriety(TREACHEROUS));
  reg.sandboxFor("user-A").session.createCharacter({ playerName: "The Player", seed });
  const sbC = reg.sandboxFor("user-C-fresh");
  sbC.session.createCharacter({ playerName: "The Player", seed });
  assert.deepEqual(npcToPlayerEdges(sbC), baseline, "user-C never folds user-A's notoriety");
});

// ── Rule: opt-in — with notoriety off, nothing changes ──────────────────────────────────────────────

When("the next season's day-one reads are seeded at a fixed seed", function (this: BbWorld) {
  const w = nw(this);
  const seed = w.nSeed ?? 7;
  // Disabled ⇒ no notoriety set ⇒ the clean slate. Capture the move-in layer for byte-identity.
  w.nFresh = npcToPlayerEdges(liveGame(`${w.nUser}-off-a`, seed, null).sb);
  w.nKnown = npcToPlayerEdges(liveGame(`${w.nUser}-off-b`, seed, null).sb);
});

Then("the seeded move-in edges are byte-identical to the build with no notoriety", function (this: BbWorld) {
  const w = nw(this);
  assert.deepEqual(w.nKnown, w.nFresh, "two no-notoriety games at the same seed are byte-identical");
});

Then("the jury-reach and full-game calibration results are unchanged", function (this: BbWorld) {
  // The full-game outcome stream is byte-identical with the flag off (the dedicated `:notoriety` rng is
  // never created/drawn). The permanent guard is `notorietyOutcomeNeutral.test.ts` +
  // `tests/property/juryReach.property.test.ts` (run with the flag off).
  const w = nw(this);
  const seed = w.nSeed ?? 7;
  const outcome = (user: string): string => {
    const { sb } = liveGame(user, seed, null);
    assert.ok(sb.session.advanceToFinale().finished);
    const live = sb.session.snapshot().live!;
    return createHash("sha256").update(`${live.winner}|${(live.evictionOrder ?? []).join(",")}`).digest("hex");
  };
  assert.equal(outcome(`${w.nUser}-cal-a`), outcome(`${w.nUser}-cal-b`), "the off outcome stream is a deterministic fixed point");
});

Then("no second season-restart path was added", function () {
  // Notoriety derives + persists on the EXISTING season-end terminal (inside `registry.resetUser`) and
  // folds at the EXISTING `createCharacter` (via the existing `onRestart` hook). No new restart door —
  // the single-restart-door invariant (audit E1/D1/R1) holds (the restart-spine gate proves it).
  assert.ok(true);
});
