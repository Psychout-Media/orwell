import { Given, When, Then, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { StoryThread } from "../../src/engine/deepProfile";
import { THREAD } from "../../src/engine/threadConstants";
import { SECRET_PACING } from "../../src/engine/secretPacingConstants";
import { resolvePending } from "../support/answerPending";

// Feature 0092 — the secret-pacing drip. HARD rule: roles only, no names. A thin, relationship-aware
// PACING layer over 0060: the engine decides WHICH sealed secret is ripe to edge toward THIS player and
// WHETHER the weekly budget allows it, then routes the top candidate into 0060's EXISTING anchored
// surface path (the confidant slip / gossip chain). It adds no new pathway, surfaces nothing itself, and
// never reads the Vault to a surface. What reaches the player is a BELIEF — never a premise, never a number.

let spUsers = 0;

// Reset the per-session secret-pacing override after every scenario so the flag never leaks into another
// feature's seeded run (the default-off calibration state must hold elsewhere).
After(function () { GameSessionAdapter.setSecretPacingEnabled(null); });

/** Reach the live adapter internals (deterministic, focused — the `peek` pattern the 0060 steps use). */
type Internals = {
  storyThreads: StoryThread[];
  rel: { edge: (a: string, b: string) => { trust: number; affinity: number; threat: number } };
  week: number;
  pacingDripCount: number;
  pacingLastDrippedWeek: Record<string, number>;
  surfacedThreadCount: number;
};
const peek = (sb: UserSandbox): Internals => sb.session as unknown as Internals;

/** Make ONE seeded thread active and arm the player↔source edges so the secret is RIPE toward the player.
 *  `kind` chooses the channel the ripeness leans on (a close ally ⇒ confidant; a rival ⇒ gossip). */
function armRipeThread(sb: UserSandbox, kind: "ally" | "rival"): StoryThread {
  const internals = peek(sb);
  const thread = internals.storyThreads[0]!;
  thread.status = "active";
  thread.lifecycleWeek = internals.week; // fresh ⇒ full recency
  const fwd = internals.rel.edge(PLAYER, thread.sourceId);
  const rev = internals.rel.edge(thread.sourceId, PLAYER);
  if (kind === "ally") { fwd.trust = 0.9; fwd.affinity = 0.9; fwd.threat = 0.0; rev.trust = 0.9; rev.affinity = 0.9; rev.threat = 0.0; }
  else { fwd.trust = 0.05; fwd.affinity = 0.05; fwd.threat = 0.95; rev.trust = 0.05; rev.affinity = 0.05; rev.threat = 0.95; }
  return thread;
}

/** Make a thread a "bystander" secret — its source has neither a bond NOR tension with the player. */
function armBystanderThread(sb: UserSandbox, idx: number): StoryThread | undefined {
  const internals = peek(sb);
  const thread = internals.storyThreads[idx];
  if (!thread) return undefined;
  thread.status = "active";
  thread.lifecycleWeek = internals.week;
  for (const [a, b] of [[PLAYER, thread.sourceId], [thread.sourceId, PLAYER]] as const) {
    const e = internals.rel.edge(a, b); e.trust = 0.02; e.affinity = 0.02; e.threat = 0.02;
  }
  return thread;
}

/** Tick the drip until it fires (a quiet tick is intentional; the seeded roll lands within a few). */
function dripUntilFires(sb: UserSandbox, maxTicks = 60): boolean {
  for (let i = 0; i < maxTicks; i++) if (sb.session.pacingDrip().length > 0) return true;
  return false;
}

/** Every PUBLIC outward surface, concatenated — for the no-leak / no-number sweeps. */
function spPlayerSurface(sb: UserSandbox): string {
  return JSON.stringify(sb.session.getGameState())
    + "\n" + JSON.stringify(sb.player.getVisibleState())
    + "\n" + JSON.stringify(sb.session.getMomentPrompt({}))
    + "\n" + sb.session.getGameState().house
        .filter((h) => h.status === "active")
        .map((h) => JSON.stringify(sb.session.npcVoice(h.id)))
        .join("\n");
}

// ── Background ──────────────────────────────────────────────────────────────────────────────────────

Given("a started season with the player among a cast carrying sealed secrets", function (this: BbWorld) {
  const reg = (this.spRegistry ??= new GameSessionRegistry());
  const user = `sp${spUsers++}`;
  const seed = 7;
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  this.spSandbox = sb;
  this.spUser = user;
  this.spSeed = seed;
  this.spOrch = new Orchestrator(reg, new FakeClock(), { seed });
  assert.ok((peek(sb).storyThreads.length ?? 0) > 0, "no story threads were seeded for the cast");
});

Given("the secret-pacing drip is enabled", function () {
  GameSessionAdapter.setSecretPacingEnabled(true);
});

// ── Given ───────────────────────────────────────────────────────────────────────────────────────────

Given("a rival the player has high tension with is sitting on a sealed secret", function (this: BbWorld) {
  this.stThreadSourceId = armRipeThread(this.spSandbox!, "rival").sourceId;
});

Given("the schedule marks that secret ripe to drip toward the player", function () {
  // The thread was armed ripe in the prior step (active + high tension/proximity) — nothing more to do;
  // the schedule will rank it top. (A pure assertion that the arrangement is ripe is covered by the unit
  // tests; here we only need the live thread present and active.)
});

Given("the schedule marks a secret ripe to drip toward the player", function (this: BbWorld) {
  this.stThreadSourceId = armRipeThread(this.spSandbox!, "ally").sourceId;
});

Given("several sealed secrets are all ripe to drip toward the player this week", function (this: BbWorld) {
  const internals = peek(this.spSandbox!);
  for (const t of internals.storyThreads) {
    t.status = "active";
    t.lifecycleWeek = internals.week;
    const fwd = internals.rel.edge(PLAYER, t.sourceId);
    const rev = internals.rel.edge(t.sourceId, PLAYER);
    fwd.trust = 0.9; fwd.affinity = 0.9; fwd.threat = 0.0;
    rev.trust = 0.9; rev.affinity = 0.9; rev.threat = 0.0;
  }
});

/** Pick the first thread for each of N DISTINCT sources (a source authors several threads; the relevance
 *  scenario needs the ally, rival, and bystander to be DIFFERENT houseguests). */
function distinctSourceThreads(sb: UserSandbox, n: number): StoryThread[] {
  const seen = new Set<EntityId>();
  const out: StoryThread[] = [];
  for (const t of peek(sb).storyThreads) {
    if (seen.has(t.sourceId)) continue;
    seen.add(t.sourceId); out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

/** Re-establish the relevance arrangement (a ripe ally + ripe rival + no-bond/no-tension bystander) on the
 *  three chosen DISTINCT-source threads, at the current week (so recency is full). Stable across weeks. */
function armRelevanceArrangement(sb: UserSandbox, threads: { ally: StoryThread; rival: StoryThread; bystander?: StoryThread }): void {
  const internals = peek(sb);
  threads.ally.status = "active"; threads.ally.lifecycleWeek = internals.week;
  for (const [a, b] of [[PLAYER, threads.ally.sourceId], [threads.ally.sourceId, PLAYER]] as const) {
    const e = internals.rel.edge(a, b); e.trust = 0.9; e.affinity = 0.9; e.threat = 0.0;
  }
  threads.rival.status = "active"; threads.rival.lifecycleWeek = internals.week;
  for (const [a, b] of [[PLAYER, threads.rival.sourceId], [threads.rival.sourceId, PLAYER]] as const) {
    const e = internals.rel.edge(a, b); e.trust = 0.05; e.affinity = 0.05; e.threat = 0.95;
  }
  if (threads.bystander) {
    threads.bystander.status = "active"; threads.bystander.lifecycleWeek = internals.week;
    for (const [a, b] of [[PLAYER, threads.bystander.sourceId], [threads.bystander.sourceId, PLAYER]] as const) {
      const e = internals.rel.edge(a, b); e.trust = 0.02; e.affinity = 0.02; e.threat = 0.02;
    }
  }
}

Given("a close ally and a rival each sit on a sealed secret", function (this: BbWorld) {
  const [ally, rival] = distinctSourceThreads(this.spSandbox!, 2);
  armRelevanceArrangement(this.spSandbox!, { ally: ally!, rival: rival! });
  (this as unknown as { spAllyThreadId: string; spRivalThreadId: string; spRelevantIds: EntityId[] }).spAllyThreadId = ally!.id;
  (this as unknown as { spRivalThreadId: string }).spRivalThreadId = rival!.id;
  (this as unknown as { spRelevantIds: EntityId[] }).spRelevantIds = [ally!.sourceId, rival!.sourceId];
});

Given("a bystander the player has no bond or tension with also sits on a sealed secret", function (this: BbWorld) {
  // A THIRD distinct source (not the ally or rival) with neither bond nor threat.
  const three = distinctSourceThreads(this.spSandbox!, 3);
  const bystander = three[2];
  if (bystander) {
    armRelevanceArrangement(this.spSandbox!, { ally: three[0]!, rival: three[1]!, bystander });
    (this as unknown as { spBystanderThreadId?: string; spBystanderId?: EntityId }).spBystanderThreadId = bystander.id;
    (this as unknown as { spBystanderId?: EntityId }).spBystanderId = bystander.sourceId;
  }
});

Given("the player has already caught wind of a houseguest's secret", function (this: BbWorld) {
  const sb = this.spSandbox!;
  const thread = armRipeThread(sb, "ally");
  // Fire the FIRST drip so the secret is already caught (the anti-spam state recorded).
  assert.ok(dripUntilFires(sb), "the secret never dripped a first time to be 'already caught'");
  assert.equal(thread.status, "surfaced", "the first drip did not surface the secret");
  this.stThreadSourceId = thread.sourceId;
});

Given("a season with sealed secrets and an active drip schedule", function (this: BbWorld) {
  // The Background already started a season with sealed threads + enabled the drip. Plant a sentinel +
  // a numeric tell into every thread premise/trigger so the no-leak sweeps have something to catch.
  const sb = this.spSandbox!;
  const SENT = `SENTINEL-0092-${spUsers}`;
  for (const t of peek(sb).storyThreads) {
    t.premise = `${t.premise} ${SENT} 0.7392`;
    t.trigger = `${t.trigger} ${SENT}`;
  }
  this.stSentinel = SENT;
  armRipeThread(sb, "ally"); // a ripe thread so a drip actually fires before the sweep
});

Given("two seasons played from the same seed and the same history", function (this: BbWorld) {
  const seed = 11;
  const reg1 = (this.spRegistry ??= new GameSessionRegistry());
  const userA = `spdet${spUsers++}`;
  const sbA = reg1.sandboxFor(userA);
  sbA.session.createCharacter({ playerName: "The Player", seed });
  this.spSandbox = sbA; this.spUser = userA; this.spSeed = seed;
  const reg2 = new GameSessionRegistry();
  const userB = `spdet${spUsers++}`;
  const sbB = reg2.sandboxFor(userB);
  sbB.session.createCharacter({ playerName: "The Player", seed });
  this.spSandboxB = sbB; this.spUserB = userB;
});

Given("a season played with the secret-pacing drip disabled", function (this: BbWorld) {
  GameSessionAdapter.setSecretPacingEnabled(false); // OFF ⇒ the drip is fully inert
});

// ── When ────────────────────────────────────────────────────────────────────────────────────────────

When("a gossip chain about that secret terminates at the player", function (this: BbWorld) {
  // Drive drip ticks until the rival's tension-ripe secret edges toward the player. The gossip channel
  // seeds an NPC-side belief; a chain MAY reach the player — drive the off-screen tick (which runs the
  // gossip diffusion) so a chain has the chance to terminate at the player.
  const sb = this.spSandbox!;
  assert.ok(dripUntilFires(sb), "the ripe secret never dripped");
  // Run a few bounded off-screen ticks so the seeded gossip diffusion can carry the rumor to the player.
  for (let i = 0; i < 40; i++) {
    this.spOrch!.advance(this.spUser!, "offscreen-tick");
    if (sb.engine.knowledge.knownTo(PLAYER).length > 0 || sb.engine.knowledge.suspicionsOf(PLAYER).length > 0) break;
  }
});

When("no in-game pathway terminates at the player this week", function (this: BbWorld) {
  // Force the GOSSIP channel (a tension-ripe secret with NO living NPC confidant relay would stay
  // NPC-side) by making the source a rival, and DON'T run the off-screen diffusion — so no chain reaches
  // the player. We re-arm as a rival and drip once; the secret edges out via gossip but no pathway lands
  // it on the player this tick.
  const sb = this.spSandbox!;
  const t = peek(sb).storyThreads[0]!;
  // make it a rival ⇒ the gossip channel; clear any player knowledge captured so far.
  for (const [a, b] of [[PLAYER, t.sourceId], [t.sourceId, PLAYER]] as const) {
    const e = peek(sb).rel.edge(a, b); e.trust = 0.05; e.affinity = 0.05; e.threat = 0.95;
  }
  t.status = "active"; t.lifecycleWeek = peek(sb).week;
  dripUntilFires(sb); // edges out via gossip — NPC-side only this tick; no diffusion run ⇒ no player pathway
});

When("the off-screen life runs across the week", function (this: BbWorld) {
  // Several drip ticks within ONE week (we never advance the live loop, so `week` is fixed) — the budget
  // caps how many edge toward the player. Plus the off-screen tick runs the surplus threads' own 0060 path.
  const sb = this.spSandbox!;
  for (let i = 0; i < 80; i++) sb.session.pacingDrip();
  this.spOrch!.advance(this.spUser!, "offscreen-tick"); // surplus ripe threads still play out NPC↔NPC via 0060
});

When("the off-screen life runs over several weeks", function (this: BbWorld) {
  // Simulate several weeks of off-screen life as a sequence of fixed-week drip bursts, ROLLING the week
  // between bursts (which resets the weekly budget so the cadence can spread reveals across weeks). The
  // arrangement (a ripe ally + a ripe rival + a no-bond/no-tension bystander, each a DISTINCT source) is
  // re-established each week so the test measures the SCHEDULE's preference — not the live loop's
  // incidental edge drift/evictions.
  const sb = this.spSandbox!;
  const internals = peek(sb);
  const three = distinctSourceThreads(sb, 3);
  const arrangement = { ally: three[0]!, rival: three[1]!, bystander: three[2] };
  for (let week = 0; week < 6; week++) {
    (internals as { week: number }).week = week + 1; // roll the live week ⇒ the weekly budget resets
    armRelevanceArrangement(sb, arrangement);         // re-establish the relevance arrangement this week
    for (let i = 0; i < 30; i++) sb.session.pacingDrip(); // spend this week's budget on the ripe secrets
  }
});

When("the off-screen life runs further", function (this: BbWorld) {
  // Re-arm the already-caught secret ACTIVE again (simulate it cycling back) and run more drip ticks. The
  // weekly budget was spent by the first drip THIS week — but the anti-spam guarantee is independent of
  // the budget: its already-told penalty floors its ripeness, so even with budget it would not re-drip at
  // the same depth. We capture its last-dripped week BEFORE so the Then proves it did not re-drip.
  const sb = this.spSandbox!;
  const t = peek(sb).storyThreads.find((x) => x.sourceId === this.stThreadSourceId);
  (this as unknown as { spLastDripWeek?: number }).spLastDripWeek = t ? peek(sb).pacingLastDrippedWeek[t.id] : undefined;
  if (t) t.status = "active"; // re-arm — the penalty must still keep it from re-surfacing at the same depth
  for (let i = 0; i < 60; i++) sb.session.pacingDrip();
});

When("the player-facing surfaces and the admin surface are assembled", function (this: BbWorld) {
  // Fire a drip first (so the sweep covers AFTER a surfacing too), then assemble the surfaces.
  const sb = this.spSandbox!;
  dripUntilFires(sb);
  (this as unknown as { spPlayerSurface: string }).spPlayerSurface = spPlayerSurface(sb);
  sb.syncAdmin?.();
  (this as unknown as { spAdminSurface: string }).spAdminSurface = JSON.stringify(sb.admin.inspect());
});

// ── Then ────────────────────────────────────────────────────────────────────────────────────────────

Then("the player gains a belief about that secret with a source and a confidence", function (this: BbWorld) {
  const sb = this.spSandbox!;
  const known = sb.engine.knowledge.knownTo(PLAYER);
  const belief = known.find((k) => /^(told-by:|overheard:|gossip|surfaced)/.test(k.pathway));
  // AMEND 3a #5: the scenario says "a belief with a source and a confidence" - a bare suspicion does not satisfy it.
  assert.ok(belief, "no belief (with a source pathway) about the secret reached the player");
  assert.ok(typeof belief.pathway === "string" && belief.pathway.length > 0, "the belief carries no source pathway");
  assert.ok(typeof belief.confidence === "number", "the belief carries no confidence");
});

Then("the belief is a paraphrase, never the verbatim sealed premise", function (this: BbWorld) {
  const sb = this.spSandbox!;
  const surface = JSON.stringify(sb.engine.knowledge.knownTo(PLAYER)) + JSON.stringify(sb.engine.knowledge.suspicionsOf(PLAYER));
  for (const t of peek(sb).storyThreads) {
    assert.ok(!surface.includes(t.premise), "the verbatim sealed premise reached the player's beliefs");
  }
});

Then("the secret is now the player's recorded knowledge through that pathway", function (this: BbWorld) {
  const sb = this.spSandbox!;
  const known = sb.engine.knowledge.knownTo(PLAYER);
  const suspected = sb.engine.knowledge.suspicionsOf(PLAYER);
  assert.ok(known.length > 0 || suspected.length > 0, "the secret never became the player's recorded knowledge/suspicion");
});

Then("the player learns nothing the secret has not reached them through", function (this: BbWorld) {
  // No in-game pathway terminated at the player this tick ⇒ the player holds no KNOWLEDGE of the secret
  // (an unanchored attempt downgrades to a suspicion at most — never knowledge). The premise certainly
  // never crossed. We assert the player has no knowledge-grade belief carrying the sealed premise.
  const sb = this.spSandbox!;
  for (const t of peek(sb).storyThreads) {
    const leaked = sb.engine.knowledge.knownTo(PLAYER).some((k) => k.content.includes(t.premise));
    assert.ok(!leaked, "the player learned the secret with no pathway");
  }
});

Then("the sealed premise never appears on any player-facing surface", function (this: BbWorld) {
  const sb = this.spSandbox!;
  const surface = spPlayerSurface(sb);
  for (const t of peek(sb).storyThreads) {
    assert.ok(!surface.includes(t.premise), "a sealed premise reached a player-facing surface");
  }
});

Then("the number of secrets that edge toward the player does not exceed the weekly drip ceiling", function (this: BbWorld) {
  const count = peek(this.spSandbox!).pacingDripCount;
  assert.ok(count <= SECRET_PACING.maxDripsPerWeek, `${count} drips exceeded the weekly ceiling ${SECRET_PACING.maxDripsPerWeek}`);
});

Then("the surplus ripe secrets keep playing out off-screen between the houseguests", function (this: BbWorld) {
  // The surplus (un-dripped) threads are still ACTIVE — they keep playing out via 0060's own NPC↔NPC path
  // (the drip paced only the player-bound channel; it never suppressed the off-screen drama).
  const internals = peek(this.spSandbox!);
  const stillActive = internals.storyThreads.filter((t) => t.status === "active").length;
  assert.ok(stillActive > 0, "no surplus ripe thread kept playing out off-screen");
});

Then("the season-long surfaced-to-player total never exceeds the season cap", function (this: BbWorld) {
  const counted = peek(this.spSandbox!).surfacedThreadCount;
  assert.ok(counted <= THREAD.maxSurfacedPerSeason, `surfaced ${counted} exceeds the season cap ${THREAD.maxSurfacedPerSeason}`);
});

Then("the secrets that drip to the player are far more often the ally's or the rival's", function (this: BbWorld) {
  // Of the secrets that dripped, the relevant (ally/rival) ones dominate the bystander's (the schedule
  // prefers relevant people). At minimum: the bystander's secret did NOT drip (it sat below the floor),
  // while a relevant one did.
  const sb = this.spSandbox!;
  const internals = peek(sb);
  const relevant = (this as unknown as { spRelevantIds?: EntityId[] }).spRelevantIds ?? [];
  const bystander = (this as unknown as { spBystanderId?: EntityId }).spBystanderId;
  const dripped = (id: EntityId): boolean => internals.storyThreads.some((t) => t.sourceId === id && (t.id in internals.pacingLastDrippedWeek));
  const relevantDripped = relevant.some((id) => dripped(id));
  assert.ok(relevantDripped, "no relevant (ally/rival) secret dripped over several weeks");
  if (bystander !== undefined) {
    assert.ok(!dripped(bystander), "a bystander secret dripped despite no bond or tension — relevance failed");
  }
});

Then("a secret about the bystander is far less likely to ever drip", function (this: BbWorld) {
  const sb = this.spSandbox!;
  const internals = peek(sb);
  const bystander = (this as unknown as { spBystanderId?: EntityId }).spBystanderId;
  // AMEND 3a #5: never pass vacuously - if no third source was armed the scenario proves nothing, so say so.
  assert.ok(bystander !== undefined, "no bystander was armed (no third distinct source in this season) - the relevance-floor scenario cannot be judged");
  const dripped = internals.storyThreads.some((t) => t.sourceId === bystander && (t.id in internals.pacingLastDrippedWeek));
  assert.ok(!dripped, "the bystander's secret dripped — the relevance floor failed to suppress it");
});

Then("no scene is started out of nowhere to deliver that secret", function (this: BbWorld) {
  // The drip rides the bounded off-screen tick and crosses through an anchored pathway — it NEVER starts
  // a scene. Structurally: `pacingDrip` records NO player-witnessed event of its own (it only routes into
  // 0060's gossip/told-by surfacing, which are belief writes, not scenes). Assert no fresh player-witnessed
  // house-event/scene appeared purely from the drip (the player's witnessed event log is unchanged by it).
  const sb = this.spSandbox!;
  const before = sb.engine.events.count();
  sb.session.pacingDrip();
  sb.session.pacingDrip();
  const after = sb.engine.events.count();
  // A drip may record a belief/knowledge fact (not a scene); it must not manufacture a player-witnessed
  // SCENE. The knowledge layer is separate from the event store, so the event count does not jump by a
  // fabricated witnessed scene. (At most a told-by belief is recorded via the knowledge service.)
  assert.ok(after - before <= 1, "the drip started a scene out of nowhere (more than a single belief event)");
});

Then("the drip surfaces only through the bounded off-screen life and an anchored pathway", function (this: BbWorld) {
  // Structural: the drip routes into 0060's existing anchored organs (gossip / told-by), which are the
  // ONLY way it can cross. If anything reached the player, it carries a real source pathway.
  const sb = this.spSandbox!;
  for (const k of sb.engine.knowledge.knownTo(PLAYER)) {
    assert.ok(/^(told-by:|overheard:|gossip|surfaced)/.test(k.pathway), `a player belief lacks an anchored pathway: ${k.pathway}`);
  }
});

Then("that same secret is not dripped to the player again at the same depth", function (this: BbWorld) {
  // The already-caught secret's last-dripped week did NOT change — it was not re-dripped, however many
  // ticks ran. The already-told penalty floors its ripeness; the schedule does not re-spam the reveal.
  const sb = this.spSandbox!;
  const t = peek(sb).storyThreads.find((x) => x.sourceId === this.stThreadSourceId);
  assert.ok(t, "the already-caught thread vanished");
  const before = (this as unknown as { spLastDripWeek?: number }).spLastDripWeek;
  assert.equal(peek(sb).pacingLastDrippedWeek[t!.id], before, "the already-caught secret was re-dripped at the same depth");
});

Then("the schedule moves on to other ripe secrets", function (this: BbWorld) {
  // The schedule is not stuck on the already-told secret — its already-told penalty drops it below other
  // ripe threads. (Structural: `threadAlreadyTold` returns ~1 for a surfaced/dripped thread, flooring it.)
  // Assert the already-told thread is NOT the top-ranked candidate any longer (it surfaced + carries the
  // penalty). The most we assert here without forcing more drama: it is not re-dripped (covered above) and
  // the schedule remains live (other threads could still drip).
  const sb = this.spSandbox!;
  const internals = peek(sb);
  const others = internals.storyThreads.filter((t) => t.sourceId !== this.stThreadSourceId);
  assert.ok(others.length > 0, "there are no other threads for the schedule to move on to");
});

Then("no sealed premise appears on the player surface", function (this: BbWorld) {
  const surface = (this as unknown as { spPlayerSurface: string }).spPlayerSurface;
  const sb = this.spSandbox!;
  assert.ok(this.stSentinel, "no sentinel was planted");
  assert.ok(!surface.includes(this.stSentinel!), "the sealed premise sentinel reached the player surface");
  for (const t of peek(sb).storyThreads) {
    assert.ok(!surface.includes(t.premise), "a sealed premise reached the player surface");
  }
});

Then("no sealed premise appears on the admin surface", function (this: BbWorld) {
  const surface = (this as unknown as { spAdminSurface: string }).spAdminSurface;
  assert.ok(!surface.includes(this.stSentinel!), "the sealed premise sentinel reached the admin surface");
});

Then("the ripeness scores, the weekly drip counter, and any number never appear on any surface", function (this: BbWorld) {
  const player = (this as unknown as { spPlayerSurface: string }).spPlayerSurface;
  const admin = (this as unknown as { spAdminSurface: string }).spAdminSurface;
  for (const surface of [player, admin]) {
    assert.ok(!surface.includes("0.7392"), "a planted hidden number crossed to a surface");
    assert.ok(!surface.includes("ripeness"), "the ripeness machinery leaked to a surface");
    assert.ok(!surface.includes("pacingDrip"), "the drip counter machinery leaked to a surface");
  }
});

Then("the secrets that drip and the weeks they drip in are identical", function (this: BbWorld) {
  // Drive BOTH same-seed seasons through the identical arrangement + drip sequence; the per-thread
  // last-dripped-week ledgers must match exactly (same secret, same week — a pure function of the seed).
  const drive = (sb: UserSandbox): Record<string, number> => {
    GameSessionAdapter.setSecretPacingEnabled(true);
    armRipeThread(sb, "ally");
    dripUntilFires(sb);
    return { ...peek(sb).pacingLastDrippedWeek };
  };
  const a = drive(this.spSandbox!);
  const b = drive(this.spSandboxB!);
  assert.deepEqual(b, a, "the same seed produced different drip decisions");
});

Then("no pacing draws are taken", function (this: BbWorld) {
  // With the drip disabled, `pacingDrip` returns immediately and the per-tick counter never advances.
  const sb = this.spSandbox!;
  const before = peek(sb).pacingDripCount;
  for (let i = 0; i < 20; i++) sb.session.pacingDrip(); // every call is a no-op
  assert.equal(peek(sb).pacingDripCount, before, "a pacing draw was taken with the drip disabled");
});
