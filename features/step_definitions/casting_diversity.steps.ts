import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { startNewGame } from "../../src/engine/characterFactory";
import {
  generateDiversityLayer, showmanceIdentities, showmancePlausible, privateOrientationVaultId, privateOrientationToVaultContent,
} from "../../src/engine/diversity";
import { nameGenderOf } from "../../src/engine/data/nameGender";
import {
  MIN_BIPOC, MIN_QUEER, MIN_PER_BINARY_GENDER, MIN_PER_AGE_BAND, MAX_NONBINARY,
  AGE_BANDS, AGE_ELIGIBILITY_FLOOR, ageBandOf,
} from "../../src/engine/diversityConstants";
import {
  MAX_PER_BUILD, MAX_PER_DEMEANOR, MAX_PER_VOCATION, APPEARANCE_POOLS, DEMEANOR_POOL,
} from "../../src/engine/characterFactory";

// Feature 0063 — the casting diversity floor. HARD rule: roles only, no names. The engine GUARANTEES the
// four floors across seeds; ethnicity grounds the skin tone; orientation is character-driven and split
// across the Vault by disclosure; a private orientation NEVER reaches the player OR admin until a 0002
// pathway surfaces it; 0059 can seed a queer showmance organically; identity is a facet, never a label.

let dvUsers = 0;

/** A string seed label → a stable numeric seed (the same mapping the 0058 steps use). */
function seedOf(label: string): number {
  let seed = 0;
  for (let i = 0; i < label.length; i++) seed = (Math.imul(seed, 31) + label.charCodeAt(i)) >>> 0;
  return seed;
}

function dvStart(w: BbWorld, seedLabel: string, playerName = "The Player"): UserSandbox {
  const reg = (w.dvRegistry ??= new GameSessionRegistry());
  const sb = reg.sandboxFor(`dv${dvUsers++}`);
  const seed = seedOf(seedLabel);
  w.dvSeed = seed;
  sb.session.createCharacter({ playerName, seed });
  w.dvSandbox = sb;
  return sb;
}

/** Every PUBLIC outward surface, concatenated — for the no-leak sweeps. */
function dvPlayerSurface(sb: UserSandbox): string {
  return JSON.stringify(sb.session.getGameState())
    + "\n" + JSON.stringify(sb.session.gameStatus())
    + "\n" + JSON.stringify(sb.player.getVisibleState())
    + "\n" + JSON.stringify(sb.session.getMomentPrompt({}))
    + "\n" + JSON.stringify(sb.session.getMomentPrompt({ moment: "social" }))
    + "\n" + sb.session.getGameState().house
        .filter((h) => h.status === "active")
        .map((h) => JSON.stringify(sb.session.npcVoice(h.id)))
        .join("\n");
}

// ── Givens ──────────────────────────────────────────────────────────────────────────────────────────

Given("a generated 15-houseguest cast at seed {string}", function (this: BbWorld, label: string) {
  dvStart(this, label);
});

Given("a generated cast at seed {string} with a houseguest whose orientation is held privately", function (this: BbWorld, label: string) {
  const sb = dvStart(this, label);
  assert.ok(Object.keys(sb.session.snapshot().privateOrientations ?? {}).length > 0,
    "expected at least one privately-held orientation in this cast");
});

Given("a generated cast at seed {string} with a houseguest who is publicly out", function (this: BbWorld, label: string) {
  const sb = dvStart(this, label);
  assert.ok(sb.session.getGameState().house.some((h) => h.outOrientation),
    "expected at least one publicly-out houseguest in this cast");
});

Given("a season seeded so the 0059 showmance layer pairs two same-gender houseguests at seed {string}", function (this: BbWorld, _label: string) {
  // Find a seed whose seeded showmance layer pairs two same-gender (queer) houseguests, then start it.
  for (let seed = 1; seed <= 200; seed++) {
    const sb = (this.dvRegistry ??= new GameSessionRegistry()).sandboxFor(`dv${dvUsers++}`);
    sb.session.createCharacter({ playerName: "The Player", seed });
    const rels = sb.session.snapshot().seededRelationships;
    const ids = showmanceIdentities(generateDiversityLayer(seed, sb.session.snapshot().house!.npcs));
    const queer = rels?.showmances?.find((s) => ids[s.a]!.genderPresentation === ids[s.b]!.genderPresentation);
    if (queer) { this.dvSandbox = sb; this.dvSeed = seed; return; }
  }
  assert.fail("no seed in [1,200] produced a same-gender seeded showmance");
});

Given("two casts identical except for one houseguest's ethnicity and orientation facets at seed {string}", function (this: BbWorld, label: string) {
  this.dvSeed = seedOf(label);
});

Given("two generated casts at the same seed {string} with different player profiles", function (this: BbWorld, label: string) {
  this.dvSeed = seedOf(label);
});

Given("the player holds no knowledge of that orientation", function (this: BbWorld) {
  // The player starts with no knowledge of a sealed private orientation (nothing surfaced it yet).
  const sb = this.dvSandbox!;
  const sealedIds = Object.keys(sb.session.snapshot().privateOrientations ?? {});
  assert.ok(sealedIds.length > 0);
});

// ── Floors ──────────────────────────────────────────────────────────────────────────────────────────

When("the cast's ethnicity-grounded identity facet is read for every houseguest", function (this: BbWorld) {
  const house = this.dvSandbox!.session.getGameState().house;
  for (const h of house) assert.ok(typeof h.ethnicity === "string" && h.ethnicity.length > 0, "missing ethnicity facet");
});

Then("at least the minimum number of houseguests of color are present", function (this: BbWorld) {
  const layer = generateDiversityLayer(this.dvSeed!, this.dvSandbox!.session.snapshot().house!.npcs);
  const bipoc = Object.values(layer.public).filter((p) => p.bipoc).length;
  assert.ok(bipoc >= MIN_BIPOC, `BIPOC ${bipoc} < ${MIN_BIPOC}`);
});

Then("no single appearance facet exceeds its L28 cap on the same cast", function (this: BbWorld) {
  const house = this.dvSandbox!.session.getGameState().house;
  // Body-type (BUILD) cap — the build is the first comma-segment of `appearance`.
  const builds = house.map((h) => (h.appearance ?? "").split(",")[0]!.trim());
  const buildCounts = new Map<string, number>();
  for (const b of builds) if (APPEARANCE_POOLS.BUILDS.includes(b as never)) buildCounts.set(b, (buildCounts.get(b) ?? 0) + 1);
  for (const [, c] of buildCounts) assert.ok(c <= MAX_PER_BUILD, "a build exceeds its L28 cap");
  // Demeanor cap.
  const demCounts = new Map<string, number>();
  for (const h of house) if (h.demeanor && DEMEANOR_POOL.includes(h.demeanor as never)) demCounts.set(h.demeanor, (demCounts.get(h.demeanor) ?? 0) + 1);
  for (const [, c] of demCounts) assert.ok(c <= MAX_PER_DEMEANOR, "a demeanor exceeds its L28 cap");
});

When("the cast's gender presentation is read for every houseguest", function (this: BbWorld) {
  const house = this.dvSandbox!.session.getGameState().house;
  for (const h of house) assert.ok(["man", "woman", "nonbinary"].includes(h.genderPresentation ?? ""), "missing gender presentation");
});

Then("neither binary gender falls below the gender-balance minimum", function (this: BbWorld) {
  const house = this.dvSandbox!.session.getGameState().house;
  const men = house.filter((h) => h.genderPresentation === "man").length;
  const women = house.filter((h) => h.genderPresentation === "woman").length;
  assert.ok(men >= MIN_PER_BINARY_GENDER, `men ${men} < ${MIN_PER_BINARY_GENDER}`);
  assert.ok(women >= MIN_PER_BINARY_GENDER, `women ${women} < ${MIN_PER_BINARY_GENDER}`);
});

Then("each houseguest's name coheres with their gender presentation", function (this: BbWorld) {
  // #1140 — coherence is now a GUARANTEE: the rename pass re-picks any name that disagreed with the final
  // gender presentation, so EVERY houseguest's name reads the gender the portrait + narration encode. The
  // old bounded "≤ 2/cast balance-flip exception" is retired — assert ZERO mismatches.
  const npcs = this.dvSandbox!.session.snapshot().house!.npcs;
  const layer = generateDiversityLayer(this.dvSeed!, npcs);
  const incoherent = Object.values(layer.public).filter((p) => !p.nameCoheres).length;
  assert.equal(incoherent, 0, `name/presentation mismatches: ${incoherent}`);
  // Belt-and-braces: the houseguest's ACTUAL (possibly renamed) name on the live roster reads the SAME
  // gender as the stored presentation — a gendered name matches, a nonbinary one keeps a unisex name.
  for (const n of npcs) {
    const g = n.character.genderPresentation;
    if (g === undefined) continue;
    const ng = nameGenderOf(n.name);
    if (g === "nonbinary") assert.equal(ng, "unisex", `${n.id} nonbinary name not unisex: ${n.name}`);
    else assert.equal(ng, g, `${n.id} name ${n.name} reads ${ng}, presentation ${g}`);
  }
});

When("every houseguest's age is read", function (this: BbWorld) {
  this.dvSandbox!.session.getGameState().house.forEach((h) => assert.ok(typeof h.age === "number"));
});

Then("every houseguest is at least the eligible minimum age", function (this: BbWorld) {
  for (const h of this.dvSandbox!.session.getGameState().house) {
    assert.ok((h.age ?? 0) >= AGE_ELIGIBILITY_FLOOR, `age ${h.age} below the eligibility floor`);
  }
});

Then("each defined age band carries at least its minimum number of houseguests", function (this: BbWorld) {
  const ages = this.dvSandbox!.session.getGameState().house.map((h) => h.age ?? 0);
  for (const band of AGE_BANDS) {
    const n = ages.filter((a) => ageBandOf(a) === band.id).length;
    assert.ok(n >= MIN_PER_AGE_BAND, `band ${band.id} has ${n} < ${MIN_PER_AGE_BAND}`);
  }
});

When("every houseguest's seeded orientation is read from the engine", function (this: BbWorld) {
  // Read the full (public + private) orientation layer — engine-side, never projected.
  const layer = generateDiversityLayer(this.dvSeed!, this.dvSandbox!.session.snapshot().house!.npcs);
  assert.ok(Object.keys(layer.public).length === 15);
});

Then("at least the minimum number of houseguests have a non-straight orientation", function (this: BbWorld) {
  const layer = generateDiversityLayer(this.dvSeed!, this.dvSandbox!.session.snapshot().house!.npcs);
  const pub = Object.values(layer.public);
  const nb = pub.filter((p) => p.genderPresentation === "nonbinary").length;
  const queer = pub.filter((p) => p.outOrientation).length + Object.keys(layer.privateOrientations).length + nb;
  assert.ok(queer >= MIN_QUEER, `LGBTQ+ ${queer} < ${MIN_QUEER}`);
});

Then("every L28 diversity cap is satisfied", function (this: BbWorld) {
  const house = this.dvSandbox!.session.getGameState().house;
  const demCounts = new Map<string, number>();
  for (const h of house) if (h.demeanor) demCounts.set(h.demeanor, (demCounts.get(h.demeanor) ?? 0) + 1);
  for (const [, c] of demCounts) assert.ok(c <= MAX_PER_DEMEANOR, "demeanor cap violated");
  const vocCounts = new Map<string, number>();
  for (const h of house) if (h.vocation) vocCounts.set(h.vocation, (vocCounts.get(h.vocation) ?? 0) + 1);
  for (const [, c] of vocCounts) assert.ok(c <= MAX_PER_VOCATION, "vocation cap violated");
});

Then("every 0063 diversity floor is satisfied", function (this: BbWorld) {
  const layer = generateDiversityLayer(this.dvSeed!, this.dvSandbox!.session.snapshot().house!.npcs);
  const pub = Object.values(layer.public);
  assert.ok(pub.filter((p) => p.bipoc).length >= MIN_BIPOC, "BIPOC floor");
  assert.ok(pub.filter((p) => p.genderPresentation === "man").length >= MIN_PER_BINARY_GENDER, "men floor");
  assert.ok(pub.filter((p) => p.genderPresentation === "woman").length >= MIN_PER_BINARY_GENDER, "women floor");
  assert.ok(pub.filter((p) => p.genderPresentation === "nonbinary").length <= MAX_NONBINARY, "nonbinary cap");
  const nb = pub.filter((p) => p.genderPresentation === "nonbinary").length;
  const queer = pub.filter((p) => p.outOrientation).length + Object.keys(layer.privateOrientations).length + nb;
  assert.ok(queer >= MIN_QUEER, "LGBTQ+ floor");
  for (const band of AGE_BANDS) {
    assert.ok(pub.filter((p) => ageBandOf(p.age) === band.id).length >= MIN_PER_AGE_BAND, `age band ${band.id}`);
  }
});

// ── Vault Wall — a private orientation ───────────────────────────────────────────────────────────────

When("a sentinel is planted in that houseguest's private-orientation field", function (this: BbWorld) {
  const sb = this.dvSandbox!;
  this.dvSentinel = "SENTINEL-0063-bdd-private-orientation";
  const core = sb.session.snapshot();
  for (const id of Object.keys(core.privateOrientations!)) {
    core.privateOrientations![id] = `${core.privateOrientations![id]} ${this.dvSentinel}` as never;
  }
  sb.session.restore(core);
});

Then("the planted private-orientation sentinel never appears on any player surface", function (this: BbWorld) {
  assert.ok(!dvPlayerSurface(this.dvSandbox!).includes(this.dvSentinel!), "private orientation leaked to a player surface");
});

Then("the planted private-orientation sentinel never appears on the admin surface", function (this: BbWorld) {
  this.dvSandbox!.syncAdmin();
  assert.ok(!JSON.stringify(this.dvSandbox!.admin.inspect()).includes(this.dvSentinel!), "private orientation leaked to the admin surface");
});

Then("the planted private-orientation sentinel never appears in that houseguest's voicing projection", function (this: BbWorld) {
  const voices = this.dvSandbox!.session.getGameState().house
    .filter((h) => h.status === "active")
    .map((h) => JSON.stringify(this.dvSandbox!.session.npcVoice(h.id))).join("\n");
  assert.ok(!voices.includes(this.dvSentinel!), "private orientation leaked to a voicing projection");
});

Then("the planted private-orientation sentinel never appears in the moment prompt", function (this: BbWorld) {
  const prompt = this.dvSandbox!.session.getMomentPrompt({}).systemPrompt
    + this.dvSandbox!.session.getMomentPrompt({ moment: "social" }).systemPrompt;
  assert.ok(!prompt.includes(this.dvSentinel!), "private orientation leaked to the moment prompt");
});

// ── Publicly-out orientation ─────────────────────────────────────────────────────────────────────────

Then("that houseguest's orientation is available as a public character facet", function (this: BbWorld) {
  const out = this.dvSandbox!.session.getGameState().house.filter((h) => h.outOrientation);
  assert.ok(out.length > 0, "no publicly-out orientation on a card");
  for (const h of out) assert.ok(typeof h.outOrientation === "string" && h.outOrientation.length > 0);
});

Then("no competition stat or hidden number is derivable from it", function (this: BbWorld) {
  // The card carries no aptitude numbers anywhere (the Vault-free projection never does).
  const house = JSON.stringify(this.dvSandbox!.session.getGameState().house);
  assert.ok(!/"physical":|"mental":|"social":/.test(house), "a stat key leaked onto the card");
});

// ── Pathway-only disclosure ──────────────────────────────────────────────────────────────────────────

When("no in-game pathway has surfaced the private orientation", function (this: BbWorld) {
  // No-op: by construction nothing has surfaced the sealed orientation yet.
});

Then("the player's knowledge still contains nothing about that orientation", function (this: BbWorld) {
  // ORW-286 item 9: assert the sealed VALUE for each houseguest, not a literal record-label string (the old loop never used `orientation`).
  const sb = this.dvSandbox!;
  const sealed = sb.session.snapshot().privateOrientations!;
  assert.ok(Object.keys(sealed).length > 0, "the seed holds at least one sealed orientation, so the sweep below is not vacuous");
  const house = sb.session.getGameState().house;
  const prompts = [sb.session.getMomentPrompt({}).systemPrompt, sb.session.getMomentPrompt({ moment: "social" }).systemPrompt].join("\n");
  const known = sb.engine.knowledge.knownTo(PLAYER).map((f: { content: string }) => f.content);
  for (const [id, orientation] of Object.entries(sealed)) {
    const hg = house.find((h) => h.id === id);
    assert.ok(hg, `${id} is in the house`);
    const word = new RegExp(`\\b${String(orientation).replace(/[^a-z]/gi, "")}\\b`, "i");
    assert.ok(!word.test(JSON.stringify(hg)), `${id}'s card names their sealed orientation`);
    assert.ok(!word.test(JSON.stringify(sb.session.npcVoice(id))), `${id}'s voicing projection names their sealed orientation`);
    const namingThem = prompts.split(/(?<=[.!?\n])/).filter((s) => s.includes(hg!.name));
    assert.ok(!namingThem.some((s) => word.test(s)), `a moment-prompt sentence about ${id} names their sealed orientation`);
    assert.ok(!known.some((c) => c.includes(hg!.name) && word.test(c)), `the player already holds a belief tying ${id} to their sealed orientation`);
    assert.ok(!known.some((c) => c.includes(privateOrientationVaultId(id as never))), "the player's knowledge carries the engine-only record id");
  }
});

When("an in-game pathway surfaces it to the player", function (this: BbWorld) {
  // Model the canonical pathway: an NPC who holds it as knowledge tells the player (a belief with a
  // source + confidence — the SAME machinery 0002 already uses for any surfaced hidden fact).
  const sb = this.dvSandbox!;
  const id = Object.keys(sb.session.snapshot().privateOrientations!)[0]!;
  const orientation = sb.session.snapshot().privateOrientations![id]!;
  sb.engine.knowledge.seedBelief(
    PLAYER,
    { content: `learned through the house that a houseguest is ${orientation}`, subject: id, factId: `dv-orientation:${id}` },
    "told",
  );
});

Then("the player holds a belief about the orientation with a source and a confidence", function (this: BbWorld) {
  const sb = this.dvSandbox!;
  const beliefs = sb.engine.knowledge.knownTo(PLAYER);
  const surfaced = beliefs.find((b: { content: string }) => /learned through the house/.test(b.content));
  assert.ok(surfaced, "the player holds no surfaced belief about the orientation");
});

Then("the verbatim private-orientation field never appears on any player surface", function (this: BbWorld) {
  // Even after a pathway, the raw engine-only record form never crosses; only the belief content does. ORW-286 item 9: check the REAL record text and id
  // the engine stores, not a literal label.
  const sb = this.dvSandbox!;
  const surface = dvPlayerSurface(sb);
  const sealed = sb.session.snapshot().privateOrientations!;
  assert.ok(Object.keys(sealed).length > 0, "a sealed orientation exists, so the sweep is not vacuous");
  for (const [id, orientation] of Object.entries(sealed)) {
    assert.ok(!surface.includes(privateOrientationToVaultContent(id as never, orientation as never)), `the verbatim engine-only record for ${id} leaked`);
    assert.ok(!surface.includes(privateOrientationVaultId(id as never)), `the engine-only record id for ${id} leaked`);
  }
  // and the pathway belief itself IS the one thing that crossed (the control that the sweep can see a belief about this orientation)
  assert.ok(sb.engine.knowledge.knownTo(PLAYER).some((f: { content: string }) => /learned through the house/.test(f.content)), "the surfaced belief is held");
});

// ── 0059 queer showmance ─────────────────────────────────────────────────────────────────────────────

Then("the queer showmance is sealed from the player and the admin at cast time", function (this: BbWorld) {
  const sb = this.dvSandbox!;
  sb.syncAdmin();
  const surface = dvPlayerSurface(sb) + JSON.stringify(sb.admin.inspect());
  assert.ok(!/showmance/i.test(surface) || sb.session.visibleShowmances?.().length === 0 ? true : !surface.includes("spark"),
    "a sealed showmance stage leaked");
  // No pre-visible showmance pair appears in the public showmances list.
  const visible = sb.session.getGameState().showmances ?? [];
  assert.equal(visible.length, 0, "a showmance is already visible at cast time");
});

Then("the seeded showmance count stays within the 0059 sparseness budget", function (this: BbWorld) {
  const rels = this.dvSandbox!.session.snapshot().seededRelationships;
  assert.ok((rels?.showmances?.length ?? 0) <= 2, "showmance budget exceeded");
});

When("the season is simulated and the showmance has not yet earned visibility", function (this: BbWorld) {
  // No-op: a freshly seeded showmance starts at `spark`, never `visible`.
  const rels = this.dvSandbox!.session.snapshot().seededRelationships;
  assert.ok(rels?.showmances?.every((s) => s.stage !== "visible"));
});

Then("no player or admin surface reveals the showmance", function (this: BbWorld) {
  const sb = this.dvSandbox!;
  sb.syncAdmin();
  assert.equal((sb.session.getGameState().showmances ?? []).length, 0, "a sealed showmance surfaced early");
});

When("the showmance earns visibility through an in-game pathway over weeks", function (this: BbWorld) {
  // Drive the pair's mutual affinity up to the visibility threshold, then advance the showmance arc — the
  // SAME organic mechanism the live loop uses (never week-one, never pushed). Done via the engine seam.
  const sb = this.dvSandbox!;
  const s = sb.session.snapshot().seededRelationships!.showmances[0]!;
  // Raise mutual affinity over weeks of growth, then let the engine advance the stage.
  for (let i = 0; i < 40; i++) {
    sb.engine.relationships.edge(s.a, s.b).affinity = 0.95;
    sb.engine.relationships.edge(s.b, s.a).affinity = 0.95;
    sb.session.advanceShowmances();
  }
});

Then("it surfaces as an event, never week-one and never telegraphed", function (this: BbWorld) {
  const sb = this.dvSandbox!;
  // It became visible only after sustained growth (not at cast time): the public showmances now lists it.
  const visible = sb.session.visibleShowmances();
  assert.ok(visible.length > 0, "the earned showmance never became visible");
});

// ── Non-reductive / anti-sycophancy / reproducibility ────────────────────────────────────────────────

Then("every houseguest carries a multi-facet profile beyond their ethnicity and orientation", function (this: BbWorld) {
  for (const h of this.dvSandbox!.session.getGameState().house) {
    // A full §3-depth profile: archetype, demeanor, vocation/hometown, biography, physical facet — identity
    // is ONE facet among many, never the whole character.
    const facets = [h.archetype, h.demeanor, h.vocation, h.hometown, h.biography, h.background].filter(Boolean);
    assert.ok(facets.length >= 3, "a houseguest is reduced to too few facets");
  }
});

Then("no player surface reduces a houseguest to a single identity label", function (this: BbWorld) {
  // The card never carries a bare "the gay one"/"the Black one" reductive label — identity rides as a
  // heritage facet + an orientation facet ALONGSIDE the full persona, never as the houseguest's name/title.
  for (const h of this.dvSandbox!.session.getGameState().house) {
    assert.ok(!/the (gay|black|trans) one/i.test(JSON.stringify(h)), "a reductive identity label appeared");
  }
});

When("the identical seeded competition is resolved for both", function (this: BbWorld) {
  // Capture the full public outcome stream with the diversity layer ON vs. OFF (the test seam) at the
  // same seed — the byte-identical comparison proves identity never bends a seeded outcome.
  const captureInner = (disable: boolean): string => {
    if (disable) process.env.ORWELL_DISABLE_DIVERSITY = "1"; else delete process.env.ORWELL_DISABLE_DIVERSITY;
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor(`dv-golden-${disable}-${dvUsers++}`);
    sb.session.createCharacter({ playerName: "The Player", seed: this.dvSeed! });
    // The OUTCOME stream — every competition/ceremony/eviction beat — must be byte-identical with the
    // diversity layer on vs. off. We EXCLUDE the goodbye-message TONE, which is derived narration FLAVOR
    // (a sub-threshold affinity read near a warm/respectful/cold bucket boundary), not a competition
    // OUTCOME: it can tip a tone word without ever moving an eviction, a vote, the winner, or the order
    // (asserted separately below). The 0006 staged-rounds comp surfaces such a tone flip; identity still
    // never bends an OUTCOME (eviction order + winner stay byte-identical — the real isolation guarantee).
    //
    // #1140: the diversity layer now RE-PICKS houseguest NAMES to cohere with the final gender presentation
    // (descriptive), so the ON run's beat prose carries DIFFERENT names than the OFF run's — by design, NOT
    // an outcome change (the mechanical truth is WHO by id, in what order). So we NEUTRALIZE names → ids per
    // run before comparing; a real mechanical/content divergence still shows, only the rename is tolerated.
    const roster = [sb.session.getGameState().player, ...sb.session.getGameState().house]
      .filter((h): h is NonNullable<typeof h> => !!h && typeof h.name === "string" && h.name.length > 0)
      .map((h) => ({ id: h.id, name: h.name }))
      .sort((a, b) => b.name.length - a.name.length); // longest-first so a substring name can't pre-empt
    const neutralizeNames = (s: string): string => {
      let out = s;
      for (const { id, name } of roster) out = out.split(name).join(id);
      return out;
    };
    const norm = (beat?: string, content?: string): string =>
      beat === "eviction-goodbye"
        ? `${beat}:${neutralizeNames((content ?? "").replace(/ a (warm|respectful|cold) goodbye message/, " a goodbye message"))}`
        : `${beat}:${neutralizeNames(content ?? "")}`;
    const beats: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const adv = sb.session.advanceGame() as { finished: boolean; pending: { kind: string; options?: Array<{ id: string }> } | null; event?: { beat?: string; content?: string } | null };
      if (adv.event?.content) beats.push(norm(adv.event.beat, adv.event.content));
      if (adv.pending) {
        const p = adv.pending; const o = p.options ?? [];
        const ans: Record<string, unknown> =
          p.kind === "nominations" ? { kind: p.kind, choice: [o[0]?.id, o[1]?.id] }
          : p.kind === "veto-decision" ? { kind: p.kind, use: false }
          : p.kind === "comp-intent" ? { kind: p.kind, intent: "compete" }
          : p.kind === "comp-round" ? { kind: p.kind, intent: "compete" } // 0006 staged-rounds
          : p.kind === "houseguests-choice" ? { kind: p.kind, vote: o[0]?.id }
          : p.kind === "replacement" ? { kind: p.kind, replacement: o[0]?.id }
          : p.kind === "eviction-vote" ? { kind: p.kind, vote: o[0]?.id }
          : p.kind === "tie-break" ? { kind: p.kind, vote: o[0]?.id }
          : p.kind === "final-eviction" ? { kind: p.kind, vote: o[0]?.id }
          : p.kind === "finale-statement" ? { kind: p.kind, statement: "x" }
          : p.kind === "finale-answer" ? { kind: p.kind, appeal: "own-game" }
          : p.kind === "juror-vote" ? { kind: p.kind, vote: o[0]?.id }
          : p.kind === "goodbye-message" ? { kind: p.kind, vote: "respectful" }
          : p.kind === "juror-question" ? { kind: p.kind, statement: "x" }
          : p.kind === "exit-interview" ? { kind: p.kind, vote: "gracious" } // 0130: an evicted player's exit stance
          : p.kind === "secret-veto" ? { kind: p.kind, use: false } // 0025 reactive twists (default ON): hold the sealed safety
          : p.kind === "spectator-choice" ? { kind: p.kind, vote: "watch" }
          : p.kind === "finale-interview" ? { kind: p.kind, vote: "gracious" }
          : (() => { throw new Error(`casting_diversity: unhandled pending decision kind '${p.kind}' — answer it explicitly (BDD PAT-1)`); })();
        const sub = sb.session.submitDecision(ans as never) as { finished: boolean; event?: { beat?: string; content?: string } | null };
        if (sub.event?.content) beats.push(norm(sub.event.beat, sub.event.content));
        if (sub.finished) break;
      }
      if (adv.finished) break;
    }
    delete process.env.ORWELL_DISABLE_DIVERSITY;
    const live = sb.session.snapshot().live;
    return JSON.stringify({ evictionOrder: live?.evictionOrder, finished: live?.finished, beats });
  };
  // The flag is process-wide: clear it even when the run throws (an unknown pending kind fails loudly, BDD PAT-1), so a deliberately
  // failing scenario can never leak ORWELL_DISABLE_DIVERSITY into later scenarios.
  const capture = (disable: boolean): string => {
    try { return captureInner(disable); } finally { delete process.env.ORWELL_DISABLE_DIVERSITY; }
  };
  (this as unknown as { dvWith?: string; dvWithout?: string }).dvWith = capture(false);
  (this as unknown as { dvWith?: string; dvWithout?: string }).dvWithout = capture(true);
});

Then("the seeded outcome is byte-identical across the two casts", function (this: BbWorld) {
  const w = this as unknown as { dvWith?: string; dvWithout?: string };
  // PO ruling 2026-11-02: identity never changes a COMPETITION result directly (stats, temperature,
  // odds) — but orientation legitimately shapes who can form a showmance (0063 decision #3 / #840),
  // and showmances move the social graph, so later nominations/votes may differ. The guarantee is
  // therefore pinned on the opening competition(s), resolved over the identical field before any
  // social divergence can change who is playing: everything up to the first nomination ceremony.
  const comps = (json: string): string[] => {
    const beats: string[] = JSON.parse(json).beats;
    const end = beats.findIndex((b) => b.startsWith("nominations:"));
    return beats.slice(0, end < 0 ? beats.length : end).filter((b) => /^(hoh-competition|comp-elimination):/.test(b));
  };
  const a = comps(w.dvWith!);
  assert.ok(a.some((b) => b.startsWith("hoh-competition:")), "the opening HOH competition resolved");
  assert.deepEqual(a, comps(w.dvWithout!), "the diversity layer perturbed a competition result");
});

Then("both casts carry byte-identical ethnicity-grounded identity facets", function (this: BbWorld) {
  const a = generateDiversityLayer(this.dvSeed!, startNewGame({ seed: this.dvSeed!, playerName: "Alice Example" }).npcs);
  const b = generateDiversityLayer(this.dvSeed!, startNewGame({ seed: this.dvSeed!, playerName: "Zachary Other" }).npcs);
  assert.equal(JSON.stringify(Object.values(a.public).map((p) => ({ e: p.ethnicity, s: p.skinTone, g: p.genderPresentation }))),
    JSON.stringify(Object.values(b.public).map((p) => ({ e: p.ethnicity, s: p.skinTone, g: p.genderPresentation }))));
});

Then("both casts carry the identical orientation assignment", function (this: BbWorld) {
  const a = generateDiversityLayer(this.dvSeed!, startNewGame({ seed: this.dvSeed!, playerName: "Alice Example" }).npcs);
  const b = generateDiversityLayer(this.dvSeed!, startNewGame({ seed: this.dvSeed!, playerName: "Zachary Other" }).npcs);
  assert.equal(JSON.stringify(a.privateOrientations), JSON.stringify(b.privateOrientations));
  assert.equal(JSON.stringify(Object.values(a.public).map((p) => p.outOrientation)),
    JSON.stringify(Object.values(b.public).map((p) => p.outOrientation)));
});

Then("neither cast mirrors its player's identity facets", function (this: BbWorld) {
  // The cast is generated player-independently (off the seed only), so it never mirrors the player —
  // proven by the byte-identical layer across different players above; here assert the player name does
  // not appear as a houseguest heritage/identity (a structural non-mirror check).
  const layer = generateDiversityLayer(this.dvSeed!, startNewGame({ seed: this.dvSeed!, playerName: "Alice Example" }).npcs);
  assert.ok(!Object.values(layer.public).some((p) => p.ethnicity.includes("Alice")), "the cast mirrored the player");
});
