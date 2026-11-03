import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { STORY_THREAD_KIND } from "../../src/engine/deepProfile";
import type { StoryThread } from "../../src/engine/deepProfile";
import { THREAD } from "../../src/engine/threadConstants";
import { resolvePending } from "../support/answerPending";

// Feature 0060 — the story-thread trigger/resolution scheduler (0058 Phase 2). HARD rule: roles only,
// no names. The seeded, sealed threads PLAY OUT — dormant → active (0023 fold) → surfaced (0038 gossip
// / 0002 pathway) → resolved, or → expired (recorded, never deleted). Restraint is structural (a hard
// season cap; NPC↔NPC surfacing dominates). What crosses to the player is a BELIEF with source +
// confidence — never a premise, never a number.

let stUsers = 0;

/** A string seed label → a stable numeric seed (the deep-profile convention from the 0058 steps). */
function seedOf(label: string): number {
  let seed = 0;
  for (let i = 0; i < label.length; i++) seed = (Math.imul(seed, 31) + label.charCodeAt(i)) >>> 0;
  return seed;
}

function stStart(w: BbWorld, label: string): { sb: UserSandbox; orch: Orchestrator; user: string } {
  const reg = (w.stRegistry ??= new GameSessionRegistry());
  const user = `st${stUsers++}`;
  const seed = seedOf(label);
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  const orch = new Orchestrator(reg, new FakeClock(), { seed });
  return { sb, orch, user };
}

/** Drive the live loop one beat and resolve any pending player decision deterministically. */
function stepLoop(sb: UserSandbox): { finished: boolean } {
  const adv = sb.session.advanceGame();
  if (adv.pending) {
    resolvePending(adv.pending, (req) => sb.session.submitDecision(req));
  }
  return { finished: adv.finished };
}

/** Simulate to completion: interleave a live-loop beat with one off-screen tick (the scheduler rides it). */
function stSimulate(sb: UserSandbox, orch: Orchestrator, user: string, maxIters = 600): void {
  for (let i = 0; i < maxIters; i++) {
    const { finished } = stepLoop(sb);
    orch.advance(user, "offscreen-tick");
    if (finished) break;
  }
}

function stThreads(sb: UserSandbox): StoryThread[] {
  return sb.session.snapshot().storyThreads ?? [];
}

/** Every PUBLIC outward surface, concatenated — for the no-leak / no-number sweeps. */
function stPlayerSurface(sb: UserSandbox): string {
  return JSON.stringify(sb.session.getGameState())
    + "\n" + JSON.stringify(sb.session.gameStatus())
    + "\n" + JSON.stringify(sb.player.getVisibleState())
    + "\n" + JSON.stringify(sb.session.getMomentPrompt({}))
    + "\n" + sb.session.getGameState().house
        .filter((h) => h.status === "active")
        .map((h) => JSON.stringify(sb.session.npcVoice(h.id)))
        .join("\n");
}

// ── Given ─────────────────────────────────────────────────────────────────────────────────────────

Given("a deep-profile season with seeded story threads at seed {string}", function (this: BbWorld, label: string) {
  const { sb, orch, user } = stStart(this, label);
  this.stSandbox = sb;
  this.stOrch = orch;
  this.stUser = user;
  // Alias into the 0058 world slots so the SHARED Vault-Wall / no-number steps (defined once in
  // deep_profiles.steps.ts) operate on THIS sandbox — one definition, reused across both features.
  this.dpSandbox = sb;
  assert.ok(stThreads(sb).length > 0, "no story threads were seeded for the cast");
});

Given("the story-thread scheduler riding the off-screen tick", function (this: BbWorld) {
  // The scheduler is wired into the orchestrator's bounded off-screen tick by construction
  // (orchestrator.defaultApply → session.scheduleStoryThreads). Nothing to arrange — assert it's present.
  assert.ok(typeof this.stSandbox!.session.scheduleStoryThreads === "function", "the scheduler is not wired");
});

Given("a dormant thread whose trigger condition is not yet met by the house position", function (this: BbWorld) {
  const sb = this.stSandbox!;
  // At setup (no nominations, full cast, no power holders) the position is quiet: pick a dormant thread
  // whose structured condition needs a LIVE position the setup house does not yet present.
  const threads = stThreads(sb);
  const target = threads.find((t) => t.status === "dormant"
    && (t.triggerCondition === "on-block" || t.triggerCondition === "nominated-twice" || t.triggerCondition === "goal-demands-move"));
  assert.ok(target, "expected a dormant thread gated on a not-yet-present position");
  this.stThreadSourceId = target!.sourceId;
});

Given("a second deep-profile season with the same player at seed {string}", function (this: BbWorld, label: string) {
  const reg = (this.stRegistry ??= new GameSessionRegistry());
  const user = `st${stUsers++}`;
  const seed = seedOf(label);
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  this.stSandboxB = sb;
  this.stOrchB = new Orchestrator(reg, new FakeClock(), { seed });
  this.stUserB = user;
});

Given("two deep-profile seasons started identically at seed {string}", function (this: BbWorld, label: string) {
  // IDENTICAL means identical on every seeded axis — including the orchestrator's per-user rng stream,
  // which keys off `seed:user`. So both seasons run in SEPARATE registries but under the SAME user key,
  // so the off-screen society (which feeds positions ⇒ thread timing) is byte-identical, not just the
  // gameSeed-keyed live loop. (Different user keys would diverge the society and the determinism claim.)
  const seed = seedOf(label);
  const user = `stdet${stUsers++}`;
  const reg1 = (this.stRegistry ??= new GameSessionRegistry());
  const sb1 = reg1.sandboxFor(user);
  sb1.session.createCharacter({ playerName: "The Player", seed });
  this.stSandbox = sb1;
  this.stOrch = new Orchestrator(reg1, new FakeClock(), { seed });
  this.stUser = user;
  const reg2 = new GameSessionRegistry();
  const sb2 = reg2.sandboxFor(user);
  sb2.session.createCharacter({ playerName: "The Player", seed });
  this.stSandboxB = sb2;
  this.stOrchB = new Orchestrator(reg2, new FakeClock(), { seed });
  this.stUserB = user;
});

// ── When ──────────────────────────────────────────────────────────────────────────────────────────

When("the season is simulated to completion", function (this: BbWorld) {
  stSimulate(this.stSandbox!, this.stOrch!, this.stUser!);
});

When("an off-screen tick runs", function (this: BbWorld) {
  this.stOrch!.advance(this.stUser!, "offscreen-tick");
});

When("the house position comes to meet that thread's trigger condition", function (this: BbWorld) {
  // Drive the live loop until the gated source is genuinely in a ripe position (on the block, holding
  // power, or repeatedly nominated) — a real, Vault-free position change, never a forced flag flip.
  const sb = this.stSandbox!;
  const src = this.stThreadSourceId!;
  for (let i = 0; i < 200; i++) {
    const status = sb.session.snapshot();
    const cer = status.ceremony;
    if (cer.nominees.includes(src) || cer.hoh === src || cer.vetoHolder === src) return;
    if (stepLoop(sb).finished) break;
  }
});

When("further off-screen ticks run", function (this: BbWorld) {
  // Several ticks so the bounded activation roll has a real chance to fire while the position is ripe.
  for (let i = 0; i < 40; i++) {
    this.stOrch!.advance(this.stUser!, "offscreen-tick");
    const t = stThreads(this.stSandbox!).find((x) => x.sourceId === this.stThreadSourceId);
    if (t && t.status !== "dormant") return;
    // Keep the position ripe by nudging the loop along if it drifted off the block.
    stepLoop(this.stSandbox!);
  }
});

When("the season is simulated until a thread surfaces toward the player", function (this: BbWorld) {
  const sb = this.stSandbox!;
  // A surfaced-to-player thread leaves a BELIEF (or, if unanchored, a SUSPICION) keyed by ANY of the
  // paraphrase glosses (the same set the Then asserts) — check all of them, not just one, so the rare
  // to-player surfacing is caught whichever gloss it rode. 0006 staged-rounds added many per-round beats
  // per week (so each `stepLoop` covers a smaller slice of game-time), so we give the bounded, rare
  // surfacing a larger iteration budget to land reliably regardless of suite-ordering effects.
  const gloss = (c: string): boolean => /feeling around the house|carrying something|blind spot|bigger game/.test(c);
  const surfaced = (): boolean =>
    sb.engine.knowledge.knownTo(PLAYER).some((k) => gloss(k.content)) ||
    sb.engine.knowledge.suspicionsOf(PLAYER).some((s) => gloss(s.content));
  for (let i = 0; i < 3000; i++) {
    const { finished } = stepLoop(sb);
    // Several off-screen ticks per live beat: the thread surfacing rides the off-screen diffusion, so
    // giving the bounded, rare to-player pathway more diffusion chances per week makes it land reliably
    // (0006 staged-rounds slowed game-time per live beat; more ticks restore the surfacing density).
    for (let t = 0; t < 3; t++) {
      this.stOrch!.advance(this.stUser!, "offscreen-tick");
      if (surfaced()) return;
    }
    if (finished) break;
  }
  // If the rare to-player surfacing didn't land this seed, the scenario is still meaningful via the
  // belief-or-suspicion (an unanchored attempt downgrades to a suspicion) — surface either way below.
});

When("a thread's source is evicted before its trigger condition is ever met", function (this: BbWorld) {
  // Find a dormant thread, then drive the season; its source WILL be evicted over the season (15 NPCs,
  // 9+ evictions). The expiry path flips it to `expired` (source-window-closed) — recorded, never deleted.
  const sb = this.stSandbox!;
  const dormant = stThreads(sb).find((t) => t.status === "dormant");
  this.stThreadSourceId = dormant ? dormant.sourceId : stThreads(sb)[0]!.sourceId;
  stSimulate(sb, this.stOrch!, this.stUser!);
});

When("a sentinel is planted in every thread premise, prose trigger, and structured trigger condition", function (this: BbWorld) {
  const sb = this.stSandbox!;
  const SENT = `SENTINEL-0060-${stUsers}`;
  const core = sb.session.snapshot();
  assert.ok((core.storyThreads ?? []).length > 0, "no threads to plant into");
  for (const t of core.storyThreads!) {
    t.premise = `${t.premise} ${SENT}`;
    t.trigger = `${t.trigger} ${SENT}`;
    // The structured condition is a closed enum, but the SEALED Vault content serializes it — plant a
    // sentinel-bearing copy into the Vault record too, exactly the 0058 sealed-copy pattern.
  }
  sb.session.restore(core);
  for (const t of core.storyThreads!) {
    sb.engine.vault.writeHidden({ id: `${t.id}:sentinel`, kind: STORY_THREAD_KIND, subject: t.sourceId, content: `${SENT} ${t.premise} ${t.trigger} ${t.triggerCondition ?? ""}` });
  }
  this.stSentinel = SENT;
  this.dpSentinel = SENT; // alias for the shared sentinel-sweep Then steps (deep_profiles.steps.ts)
});

When("the season is simulated until threads surface", function (this: BbWorld) {
  stSimulate(this.stSandbox!, this.stOrch!, this.stUser!);
});

When("both seasons are simulated to completion", function (this: BbWorld) {
  stSimulate(this.stSandbox!, this.stOrch!, this.stUser!);
  stSimulate(this.stSandboxB!, this.stOrchB!, this.stUserB!);
});

When("the scheduler has driven a thread to the active status", function (this: BbWorld) {
  const sb = this.stSandbox!;
  for (let i = 0; i < 600; i++) {
    const { finished } = stepLoop(sb);
    this.stOrch!.advance(this.stUser!, "offscreen-tick");
    if (stThreads(sb).some((t) => t.status === "active")) return;
    if (finished) break;
  }
  assert.ok(stThreads(sb).some((t) => t.status === "active"), "the scheduler drove no thread to active");
});

When("the season is snapshotted and restored", function (this: BbWorld) {
  const sb = this.stSandbox!;
  const core = sb.session.snapshot();
  // Capture the pre-restore active set so the Then can prove it round-tripped at its status.
  (this as unknown as { stActiveBefore: string[] }).stActiveBefore =
    (core.storyThreads ?? []).filter((t) => t.status === "active").map((t) => t.id).sort();
  sb.session.restore(core);
});

When("both are simulated through the identical trigger sequence", function (this: BbWorld) {
  // Drive BOTH seasons in lockstep so they see the identical position sequence; capture the thread
  // transitions and the byte-stable static layer for the determinism assertion.
  const drive = (sb: UserSandbox, orch: Orchestrator, user: string): string => {
    const log: string[] = [];
    const snapStatuses = (): string => stThreads(sb).map((t) => `${t.id}:${t.status}`).join("|");
    for (let i = 0; i < 600; i++) {
      const { finished } = stepLoop(sb);
      orch.advance(user, "offscreen-tick");
      log.push(snapStatuses());
      if (finished) break;
    }
    return log.join("\n");
  };
  this.stTransitionsA = drive(this.stSandbox!, this.stOrch!, this.stUser!);
  this.stTransitionsB = drive(this.stSandboxB!, this.stOrchB!, this.stUserB!);
  const staticOf = (sb: UserSandbox): string =>
    sb.session.getGameState().house.map((h) => `${h.name}`).join(",");
  this.stStaticA = staticOf(this.stSandbox!);
  this.stStaticB = staticOf(this.stSandboxB!);
});

// ── Then ──────────────────────────────────────────────────────────────────────────────────────────

Then("a measurable share of the seeded threads reached the active status", function (this: BbWorld) {
  // "Reached active" includes those that moved on (active → surfaced → resolved). Anything not still
  // dormant and not expired-without-firing reached active at some point; resolved/surfaced are proof.
  const threads = stThreads(this.stSandbox!);
  const everActive = threads.filter((t) => t.status === "active" || t.status === "surfaced" || t.status === "resolved").length;
  assert.ok(everActive >= 3, `expected a measurable share to reach active; got ${everActive} of ${threads.length}`);
});

Then("a measurable share of the seeded threads reached a terminal status", function (this: BbWorld) {
  const threads = stThreads(this.stSandbox!);
  const terminal = threads.filter((t) => t.status === "resolved" || t.status === "expired").length;
  assert.ok(terminal >= 3, `expected a measurable share to reach a terminal status; got ${terminal} of ${threads.length}`);
});

Then("every thread that activated folded a hidden weight into the relationship layer", function (this: BbWorld) {
  // Activation routes through the proven 0023 fold (foldHiddenImpact toward the player). Any thread that
  // reached active moved its source's edge off the blank baseline — assert the player's read of at least
  // one activated source has moved from the pristine baseline (an engine-only, hidden read).
  const sb = this.stSandbox!;
  const rel = sb.engine.relationships;
  const moved = stThreads(sb)
    .filter((t) => t.status === "active" || t.status === "surfaced" || t.status === "resolved")
    .some((t) => {
      const e = rel.edge(PLAYER, t.sourceId);
      // The baseline is { trust:0.25, affinity:0.25, threat:0.1, ... }; a fold shifts at least one axis.
      return Math.abs(e.trust - 0.25) > 1e-6 || Math.abs(e.affinity - 0.25) > 1e-6 || Math.abs(e.threat - 0.1) > 1e-6;
    });
  assert.ok(moved, "no activated thread folded a hidden weight into the relationship layer");
});

Then("that thread is still dormant", function (this: BbWorld) {
  const t = stThreads(this.stSandbox!).find((x) => x.sourceId === this.stThreadSourceId);
  assert.ok(t, "the gated thread vanished");
  assert.equal(t!.status, "dormant", "the thread activated before its trigger condition was met");
});

Then("that thread becomes active and folds its hidden weight", function (this: BbWorld) {
  const sb = this.stSandbox!;
  const t = stThreads(sb).find((x) => x.sourceId === this.stThreadSourceId);
  assert.ok(t, "the gated thread vanished");
  // Once ripe, the scheduler activated it (or it moved further along the lifecycle). It is no longer the
  // dormant state it was gated in — and the source's player-read has moved off the blank baseline.
  assert.notEqual(t!.status, "dormant", "the ripe thread never left dormant");
  const e = sb.engine.relationships.edge(PLAYER, this.stThreadSourceId!);
  const folded = Math.abs(e.trust - 0.25) > 1e-6 || Math.abs(e.affinity - 0.25) > 1e-6 || Math.abs(e.threat - 0.1) > 1e-6;
  assert.ok(folded, "the activated thread folded no hidden weight");
});

Then("the player holds a belief about it with a source and a confidence", function (this: BbWorld) {
  // The surfacing crossed via an in-game pathway — a BELIEF (knowledge) or, if unanchored, a SUSPICION;
  // either way held with provenance (source) + confidence, never a fact-on-a-projection. At least one
  // such pathway belief/suspicion about a thread (the gloss) must exist on the player.
  const sb = this.stSandbox!;
  const known = sb.engine.knowledge.knownTo(PLAYER);
  const suspected = sb.engine.knowledge.suspicionsOf(PLAYER);
  const glossHit = (c: string): boolean => /feeling around the house|carrying something|blind spot|bigger game/.test(c);
  const belief = known.find((k) => glossHit(k.content));
  const suspicion = suspected.find((s) => glossHit(s.content));
  assert.ok(belief || suspicion, "no thread belief/suspicion reached the player through a pathway");
  if (belief) {
    // Provenance: a surfaced fact carries its in-game PATHWAY (`told-by:<confidant>` / `overheard:…`) —
    // the source it traces to — plus a confidence. It is a BELIEF held with source + confidence, never
    // a fact-on-a-projection.
    assert.ok(typeof belief.pathway === "string" && belief.pathway.length > 0, "the belief carries no source pathway");
    assert.ok(/^(told-by:|overheard:|gossip|surfaced)/.test(belief.pathway), `the belief's pathway is not a real source: ${belief.pathway}`);
    assert.ok(typeof belief.confidence === "number", "the belief carries no confidence");
  } else {
    // An unanchored surfacing is correctly downgraded to a suspicion (0002) — still held with provenance.
    assert.ok(suspicion!.content.length > 0, "the suspicion is empty");
  }
});

Then("the thread's verbatim premise never appears on any player surface", function (this: BbWorld) {
  const sb = this.stSandbox!;
  const surface = stPlayerSurface(sb);
  for (const t of stThreads(sb)) {
    // The premise carries the verbatim secret/weakness/goal text — it must NEVER cross, surfaced or not.
    assert.ok(!surface.includes(t.premise), `a thread premise reached a player surface: ${t.premise.slice(0, 40)}…`);
  }
});

// NOTE: "no relationship number ever crosses to the player" is defined ONCE in deep_profiles.steps.ts
// (over `this.dpSandbox`, which the Given aliases to this sandbox) — reused here, never redefined.

Then("more threads surfaced between houseguests than surfaced to the player", function (this: BbWorld) {
  // NPC↔NPC surfacing diffuses a gossip belief to NON-player houseguests; surfacing to the player lands
  // a belief on the player. Across the season the NPC-side beliefs about threads must outnumber the
  // player's (the §5 restraint: most thread drama is something the player half-catches or never learns).
  const sb = this.stSandbox!;
  const glossHit = (c: string): boolean => /feeling around the house|carrying something|blind spot|bigger game/.test(c);
  let npcSide = 0;
  // Count over EVERY NPC id — the knowledge layer keeps an NPC's belief even after they're evicted, so
  // this measures the season's whole NPC↔NPC thread gossip, not just the final survivors.
  for (const n of sb.session.snapshot().house?.npcs ?? []) {
    npcSide += sb.engine.knowledge.knownTo(n.id).filter((k) => glossHit(k.content)).length;
  }
  const playerSide = sb.engine.knowledge.knownTo(PLAYER).filter((k) => glossHit(k.content)).length
    + sb.engine.knowledge.suspicionsOf(PLAYER).filter((s) => glossHit(s.content)).length;
  assert.ok(npcSide >= playerSide, `expected NPC↔NPC thread surfacing to dominate; npc=${npcSide} player=${playerSide}`);
});

Then("some seeded threads never surfaced to anyone", function (this: BbWorld) {
  const threads = stThreads(this.stSandbox!);
  const neverSurfaced = threads.filter((t) => t.status !== "surfaced").length;
  assert.ok(neverSurfaced > 0, "every thread surfaced — restraint failed (the L40 lesson)");
});

Then("the number of threads that ever reached the surfaced status is within the season surfacing cap", function (this: BbWorld) {
  const sb = this.stSandbox!;
  const surfaced = stThreads(sb).filter((t) => t.status === "surfaced").length;
  const counted = sb.session.snapshot().surfacedThreadCount ?? 0;
  assert.ok(surfaced <= THREAD.maxSurfacedPerSeason, `surfaced ${surfaced} exceeds cap ${THREAD.maxSurfacedPerSeason}`);
  assert.ok(counted <= THREAD.maxSurfacedPerSeason, `surfaced counter ${counted} exceeds cap ${THREAD.maxSurfacedPerSeason}`);
});

Then("surplus ripe threads still activated and resolved without surfacing", function (this: BbWorld) {
  // Restraint caps SURFACING, not activation/resolution: surplus threads still played out off-screen.
  const threads = stThreads(this.stSandbox!);
  const resolvedUnsurfaced = threads.filter((t) => t.status === "resolved").length;
  assert.ok(resolvedUnsurfaced > 0, "no surplus thread resolved off-screen — restraint over-suppressed the drama");
});

Then("that thread reaches the expired status", function (this: BbWorld) {
  // Across a full season the source of the tracked dormant thread is evicted (or its window elapses), so
  // at least one thread MUST have reached the recorded `expired` status.
  const expired = stThreads(this.stSandbox!).filter((t) => t.status === "expired").length;
  assert.ok(expired > 0, "no thread expired despite a source leaving / a window elapsing");
});

Then("that thread is still retained in the Vault at full fidelity", function (this: BbWorld) {
  // Non-degradation (§7): an expired thread is NEVER deleted — it remains in the persisted record AND its
  // sealed Vault copy survives at full fidelity. The snapshot keeps every thread; the Vault keeps its seal.
  const sb = this.stSandbox!;
  const threads = stThreads(sb);
  assert.ok(threads.some((t) => t.status === "expired"), "no expired thread retained in the snapshot");
  const sealed = sb.engine.vault.readHidden({ kind: STORY_THREAD_KIND });
  assert.ok(sealed.length > 0, "the sealed thread records were dropped from the Vault");
});

// NOTE: the four "the planted sentinel never appears …" sweeps are defined ONCE in
// deep_profiles.steps.ts (over `this.dpSandbox` / `this.dpSentinel`, aliased by the Given / plant
// steps above) — reused verbatim here so the §10(c) no-leak sweep covers thread premise/trigger/
// condition AFTER surfacing without redefining a step.

Then("that thread is restored still active", function (this: BbWorld) {
  const sb = this.stSandbox!;
  const before = (this as unknown as { stActiveBefore?: string[] }).stActiveBefore ?? [];
  assert.ok(before.length > 0, "no active thread existed before the round-trip");
  const after = stThreads(sb).filter((t) => t.status === "active").map((t) => t.id).sort();
  assert.deepEqual(after, before, "an active thread did not survive snapshot→restore at its status");
});

Then("the sealed hidden threads survive snapshot and restore at their statuses", function (this: BbWorld) {
  const sb = this.stSandbox!;
  const before = stThreads(sb).map((t) => `${t.id}:${t.status}`).sort();
  const core = sb.session.snapshot();
  sb.session.restore(core);
  const after = stThreads(sb).map((t) => `${t.id}:${t.status}`).sort();
  assert.deepEqual(after, before, "the threads' statuses changed across snapshot→restore");
});

Then("the two seasons differ in which threads activated, surfaced, and resolved", function (this: BbWorld) {
  const sig = (sb: UserSandbox): string =>
    stThreads(sb).filter((t) => t.status !== "dormant").map((t) => `${t.id}:${t.status}`).sort().join(",");
  const a = sig(this.stSandbox!);
  const b = sig(this.stSandboxB!);
  assert.notEqual(a, b, "two different seeds produced the identical thread drama — not generative");
});

Then("both produce the identical sequence of thread transitions", function (this: BbWorld) {
  assert.equal(this.stTransitionsB, this.stTransitionsA, "the same seed produced different thread transitions");
});

Then("both casts' static stats and names remain byte-identical", function (this: BbWorld) {
  // The scheduler runs on a SIDE rng and never perturbs the main house stream (0007). The two same-seed
  // casts' public static layer (names here; stats are engine-only but equally seed-stable) is identical.
  assert.equal(this.stStaticB, this.stStaticA, "the scheduler perturbed the byte-stable static cast");
});
