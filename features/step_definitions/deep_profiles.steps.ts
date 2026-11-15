import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { STORY_THREAD_KIND } from "../../src/engine/deepProfile";

// Feature 0058 — deep character profiles. HARD rule: roles only, no names. The PUBLIC depth
// (biography + structured physical facet) crosses to the player and is byte-stable; the HIDDEN
// depth (secrets / true goals / weakness / Day-1 perception) NEVER reaches the player OR the admin.

let dpUsers = 0;
const DP_SENTINEL = "SENTINEL-0058-bdd-deep-secret";

function dpStart(w: BbWorld, seedLabel: string, playerName = "The Player"): UserSandbox {
  const reg = (w.dpRegistry ??= new GameSessionRegistry());
  const user = `dp${dpUsers++}`;
  const sb = reg.sandboxFor(user);
  // A string seed label maps to a stable numeric seed via the seed slot (createCharacter accepts a
  // number); hash the label deterministically so the same label always yields the same cast.
  let seed = 0;
  for (let i = 0; i < seedLabel.length; i++) seed = (Math.imul(seed, 31) + seedLabel.charCodeAt(i)) >>> 0;
  sb.session.createCharacter({ playerName, seed });
  return sb;
}

/** Every PUBLIC outward surface, concatenated — for the no-leak sweeps. */
function dpPlayerSurface(sb: UserSandbox): string {
  return JSON.stringify(sb.session.getGameState())
    + "\n" + JSON.stringify(sb.session.gameStatus())
    + "\n" + JSON.stringify(sb.player.getVisibleState())
    + "\n" + JSON.stringify(sb.session.getMomentPrompt({}))
    // Every active houseguest's voicing projection.
    + "\n" + sb.session.getGameState().house
        .filter((h) => h.status === "active")
        .map((h) => JSON.stringify(sb.session.npcVoice(h.id)))
        .join("\n");
}

// --- Scenario: born deep (public) ---------------------------------------------------------------

Given("a deep-profile season started with seed {string}", function (this: BbWorld, label: string) {
  this.dpSandbox = dpStart(this, label);
});

Then("every active houseguest card carries a multi-sentence biography", function (this: BbWorld) {
  const active = this.dpSandbox!.session.getGameState().house.filter((h) => h.status === "active");
  assert.ok(active.length > 0, "expected active houseguests");
  for (const h of active) {
    assert.ok(typeof h.biography === "string" && h.biography.length > 0, "a houseguest card has no biography");
    // Multi-sentence: at least two sentence-terminators.
    assert.ok((h.biography!.match(/[.!?]/g) ?? []).length >= 2, "the biography is not multi-sentence");
  }
});

Then("every active houseguest card carries a structured physical-characteristics facet", function (this: BbWorld) {
  const active = this.dpSandbox!.session.getGameState().house.filter((h) => h.status === "active");
  for (const h of active) {
    const p = h.physicalCharacteristics;
    assert.ok(p, "a houseguest card has no physical-characteristics facet");
    for (const k of ["heightBuild", "skinTone", "hair", "facialFeatures", "distinguishingMark", "ageLook", "style"] as const) {
      assert.ok(typeof p![k] === "string" && p![k].length > 0, `physical facet missing ${k}`);
    }
  }
});

Then("no houseguest card carries a secret, a true goal, a weakness, or a perception number", function (this: BbWorld) {
  const blob = JSON.stringify(this.dpSandbox!.session.getGameState().house);
  for (const banned of ["secret", "trueGoal", "weakness", "dayOnePerception", "trustLean", "threatLean"]) {
    assert.ok(!blob.includes(banned), `a hidden-profile key leaked onto a houseguest card: ${banned}`);
  }
  // No bare float / stat key either (the 0001 canary on the public facet form).
  assert.ok(!/"physical":|"mental":|"social":/.test(blob), "a stat key serialized onto a houseguest card");
  assert.ok(!/\d+\.\d+/.test(blob), "a raw float serialized onto a houseguest card");
});

// --- Scenario: the Vault-Wall sentinel sweep ----------------------------------------------------

When("a sentinel is planted in every secret, weakness, true goal, and Day-1 perception field", function (this: BbWorld) {
  // Snapshot → mutate the ENGINE-ONLY hidden deep layer → restore (the same plant-and-restore pattern
  // the B65 npcVoice test uses). The sentinel goes into EVERY hidden field of EVERY NPC's profile.
  const sb = this.dpSandbox!;
  const core = sb.session.snapshot();
  assert.ok(core.deepProfiles && Object.keys(core.deepProfiles).length > 0, "no hidden deep profiles to plant into");
  for (const profile of Object.values(core.deepProfiles!)) {
    profile.secrets = profile.secrets.map((s) => `${s} ${DP_SENTINEL}`);
    profile.trueGoals = profile.trueGoals.map((g) => `${g} ${DP_SENTINEL}`);
    profile.weakness = `${profile.weakness} ${DP_SENTINEL}`;
    profile.dayOnePerception.read = `${profile.dayOnePerception.read} ${DP_SENTINEL}`;
  }
  // Also re-seal the planted profiles into the Vault so the test exercises the sealed copy too.
  sb.session.restore(core);
  for (const [id, profile] of Object.entries(core.deepProfiles!)) {
    sb.engine.vault.writeHidden({ id: `deep-profile:${id}`, kind: "hidden-attribute", subject: id, content: `${DP_SENTINEL} ${profile.secrets.join(" ")}` });
  }
  this.dpSentinel = DP_SENTINEL;
});

Then("the planted sentinel never appears on any player surface", function (this: BbWorld) {
  assert.ok(!dpPlayerSurface(this.dpSandbox!).includes(this.dpSentinel!), "a hidden secret reached a player surface");
});

Then("the planted sentinel never appears on the admin surface", function (this: BbWorld) {
  this.dpSandbox!.syncAdmin?.();
  const admin = JSON.stringify(this.dpSandbox!.admin.inspect());
  assert.ok(!admin.includes(this.dpSentinel!), "a hidden secret reached the admin / God-Mode surface");
});

Then("the planted sentinel never appears in any houseguest's voicing projection", function (this: BbWorld) {
  const voices = this.dpSandbox!.session.getGameState().house
    .filter((h) => h.status === "active")
    .map((h) => JSON.stringify(this.dpSandbox!.session.npcVoice(h.id)))
    .join("\n");
  assert.ok(!voices.includes(this.dpSentinel!), "a hidden secret reached a voicing projection");
});

Then("the planted sentinel never appears in the moment prompt", function (this: BbWorld) {
  const prompt = this.dpSandbox!.session.getMomentPrompt({ moment: "social" }).systemPrompt
    + this.dpSandbox!.session.getMomentPrompt({}).systemPrompt;
  assert.ok(!prompt.includes(this.dpSentinel!), "a hidden secret reached the moment prompt");
});

// --- Scenario: Day-1 perception seeds the NPC→player edge ----------------------------------------

Then("at move-in every houseguest with a Day-1 read has a seeded NPC to player edge that differs from the player to NPC edge", function (this: BbWorld) {
  // ORW-286 item 9: "some edges differ" passed on a single difference from any cause. The spec (0058 section 3): the Day-1 read seeds the NPC->player edge, NOT from zero. So for EVERY
  // houseguest whose deep profile carries a Day-1 read: the NPC->player edge is seeded (no signal is the blank zero start) and it differs from the player->NPC mirror.
  const sb = this.dpSandbox!;
  const rel = sb.engine.relationships;
  const profiles = (sb.session.snapshot().deepProfiles ?? {}) as unknown as Record<string, { dayOnePerception?: string }>;
  const withRead = sb.session.getGameState().house.filter((h) => h.status === "active" && profiles[h.id]?.dayOnePerception);
  assert.ok(withRead.length >= 10, `most of the cast carries a Day-1 read, so this sweep is not vacuous (found ${withRead.length})`);
  for (const h of withRead) {
    const toPlayer = rel.edge(h.id, PLAYER);
    const fromPlayer = rel.edge(PLAYER, h.id);
    assert.ok(toPlayer.trust > 0 && toPlayer.affinity > 0 && toPlayer.threat > 0, `${h.id}'s NPC→player edge is the blank zero start, not a seeded read: ${JSON.stringify(toPlayer)}`);
    const differs = Math.abs(toPlayer.trust - fromPlayer.trust) > 1e-9 || Math.abs(toPlayer.affinity - fromPlayer.affinity) > 1e-9 || Math.abs(toPlayer.threat - fromPlayer.threat) > 1e-9;
    assert.ok(differs, `${h.id}'s NPC→player edge equals its mirror, so the Day-1 read is not what shaped it`);
  }
});

Then("no relationship number ever crosses to the player", function (this: BbWorld) {
  const blob = dpPlayerSurface(this.dpSandbox!);
  // A RELATIONSHIP number is a hidden EDGE signal — trust / affinity / threat (an `EdgeSignals`
  // serialization always carries all three). Those NEVER cross. Note: a knowledge BELIEF the player
  // legitimately holds (a gossip/overhear/surfaced rumor) carries its OWN `confidence` by design (the
  // B27b "belief with source + confidence" model, CLAUDE.md) — that is the player's own belief, not a
  // hidden relationship number, so it is NOT banned here (0060: a surfaced thread reaches the player as
  // exactly such a belief). The edge keys remain the precise guard.
  assert.ok(!/"trust":|"affinity":|"threat":/.test(blob), "a relationship number reached the player");
});

// --- Scenario: story threads ---------------------------------------------------------------------

Then("hidden story threads are sealed in the Vault for the cast", function (this: BbWorld) {
  const threads = this.dpSandbox!.engine.vault.readHidden({ kind: STORY_THREAD_KIND });
  assert.ok(threads.length > 0, "no story threads were sealed in the Vault");
});

Then("no story thread premise appears on any player surface", function (this: BbWorld) {
  // Plant a sentinel into a sealed thread's content, then prove it never crosses.
  const sb = this.dpSandbox!;
  sb.engine.vault.writeHidden({ id: "thread:bdd:sentinel", kind: STORY_THREAD_KIND, content: `${DP_SENTINEL}-thread premise` });
  assert.ok(!dpPlayerSurface(sb).includes(`${DP_SENTINEL}-thread`), "a story thread premise reached a player surface");
});

When("a dormant story thread is activated for a houseguest", function (this: BbWorld) {
  const sb = this.dpSandbox!;
  const someone = sb.session.getGameState().house[0]!.id;
  const before = sb.engine.relationships.edge(PLAYER, someone);
  this.dpWriteResult = undefined;
  // Record the player's read of the source BEFORE the fold so the Then can prove it moved.
  (this as unknown as { dpEdgeBefore: { trust: number; affinity: number; threat: number } }).dpEdgeBefore = { ...before };
  (this as unknown as { dpActivated?: ReturnType<typeof sb.session.activateThread> }).dpActivated = sb.session.activateThread(someone);
  (this as unknown as { dpSource: string }).dpSource = someone;
});

Then("that thread is now active and its hidden weight folded into the relationship layer", function (this: BbWorld) {
  const sb = this.dpSandbox!;
  const activated = (this as unknown as { dpActivated?: { status: string } }).dpActivated;
  assert.ok(activated && activated.status === "active", "no dormant thread was activated");
  const source = (this as unknown as { dpSource: string }).dpSource;
  const before = (this as unknown as { dpEdgeBefore: { trust: number; affinity: number; threat: number } }).dpEdgeBefore;
  const after = sb.engine.relationships.edge(PLAYER, source);
  const moved = Math.abs(after.trust - before.trust) > 1e-9
    || Math.abs(after.affinity - before.affinity) > 1e-9
    || Math.abs(after.threat - before.threat) > 1e-9;
  assert.ok(moved, "the activated thread folded no hidden weight into the player's read of the source");
});

// --- Scenario: persistence + full-fidelity recall -----------------------------------------------

Then("a houseguest's biography established at cast time is held in full later", function (this: BbWorld) {
  const sb = this.dpSandbox!;
  const card = sb.session.getGameState().house.find((h) => h.status === "active")!;
  // PAT-5 (#1982): `SoulProvider.recall` has no production caller. The AUTHORED hidden detail the live game keeps
  // is in each NPC's persisted `soul.memory` (the mirror the soul index is rebuilt from on resume). Assert that
  // it is there, and that a live save -> resume restores it.
  const memOf = (s: UserSandbox): string[] => s.session.snapshot().house!.npcs.find((n) => n.id === card.id)!.soul.memory;
  const held = memOf(sb).find((m) => m.startsWith("deep-profile ") && m.includes("secrets:"));
  assert.ok(held, "no authored hidden detail is held in the soul");
  const reg = this.dpRegistry!;
  const user = reg.usernames().find((u) => reg.sandboxFor(u) === sb)!;
  const resumed = new GameSessionRegistry().restore(user, JSON.parse(JSON.stringify(reg.snapshot(user))));
  assert.ok(memOf(resumed).includes(held!), "the authored hidden detail survives save -> resume in full");
  // The full biography text persists byte-stable on the card (not flattened to a one-liner).
  assert.ok(card.biography!.length > 40, "the biography was flattened");
});

Then("the public profile survives snapshot and restore byte-identical", function (this: BbWorld) {
  const sb = this.dpSandbox!;
  const before = JSON.stringify(sb.session.getGameState().house);
  const core = sb.session.snapshot();
  sb.session.restore(core);
  const after = JSON.stringify(sb.session.getGameState().house);
  assert.equal(after, before, "the public deep profile changed across snapshot→restore");
});

Then("the sealed hidden threads survive snapshot and restore", function (this: BbWorld) {
  const sb = this.dpSandbox!;
  const core = sb.session.snapshot();
  assert.ok((core.storyThreads ?? []).length > 0, "no story threads were in the snapshot");
  sb.session.restore(core);
  const after = sb.session.snapshot();
  assert.equal((after.storyThreads ?? []).length, (core.storyThreads ?? []).length, "thread count changed across restore");
});

// --- Scenario: diversity & non-mirroring (player-independent, reproducible) ----------------------

Given("a deep-profile season started with seed {string} and player vocation echoed", function (this: BbWorld, label: string) {
  this.dpSandbox = dpStart(this, label, "A Player From Phoenix");
});

Given("a second deep-profile season started with seed {string} and a different player", function (this: BbWorld, label: string) {
  this.dpSandboxB = dpStart(this, label, "An Entirely Different Person");
});

Then("both seasons produce the same public deep profiles", function (this: BbWorld) {
  const a = this.dpSandbox!.session.getGameState().house.map((h) => `${h.biography}|${JSON.stringify(h.physicalCharacteristics)}`);
  const b = this.dpSandboxB!.session.getGameState().house.map((h) => `${h.biography}|${JSON.stringify(h.physicalCharacteristics)}`);
  assert.deepEqual(b, a, "the same seed produced different deep casts depending on the player");
});

Then("neither cast biography echoes the player's authored profile", function (this: BbWorld) {
  for (const h of this.dpSandbox!.session.getGameState().house) {
    assert.ok(!/phoenix/i.test(h.biography ?? ""), "a cast biography mirrored the player's stated origin");
  }
});

// --- Scenario: the write-back seam --------------------------------------------------------------

When("an authored profile is written back for a houseguest", function (this: BbWorld) {
  const sb = this.dpSandbox!;
  const id = sb.session.getGameState().house[0]!.id;
  this.dpWriteResult = sb.session.recordCastProfile({
    houseguestId: id,
    biography: "An authored multi-sentence backstory. It has real depth.",
    physicalCharacteristics: {
      heightBuild: "tall and broad-shouldered", skinTone: "deep brown skin", hair: "a close-cropped fade",
      facialFeatures: "a square jaw", distinguishingMark: "none notable", ageLook: "thirties presence", style: "sharp and put-together",
    },
    secrets: [`${DP_SENTINEL}-authored-secret`],
    trueGoals: [`${DP_SENTINEL}-authored-goal`],
    weakness: `${DP_SENTINEL}-authored-weakness`,
    dayOnePerception: `${DP_SENTINEL}-authored-perception`,
  });
});

Then("the write-back is accepted and reports its public and hidden field names", function (this: BbWorld) {
  const r = this.dpWriteResult!;
  assert.equal(r.accepted, true, "the write-back was not accepted");
  assert.ok(r.publicFields.includes("biography") && r.publicFields.includes("physicalCharacteristics"), "public fields not reported");
  assert.ok(r.hiddenFields.includes("secrets") && r.hiddenFields.includes("weakness"), "hidden field names not reported");
});

Then("the write-back result never echoes a hidden value", function (this: BbWorld) {
  const blob = JSON.stringify(this.dpWriteResult);
  assert.ok(!blob.includes(`${DP_SENTINEL}-authored-secret`), "the write-back result echoed a hidden secret value");
  assert.ok(!blob.includes(`${DP_SENTINEL}-authored-weakness`), "the write-back result echoed a hidden weakness value");
});
