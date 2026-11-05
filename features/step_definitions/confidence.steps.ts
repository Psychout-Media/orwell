import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { buildSandbox } from "../../tests/support/sandbox";
import { PLAYER } from "../../src/domain/ids";
import { RelationshipModel } from "../../src/engine/relationships";
import { CONFIDENCE } from "../../src/engine/confidenceConstants";
import type { GameHouse, HiddenElement } from "../../src/engine/characterFactory";
import type { ConfideResult } from "../../src/ports/GameSession";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0075 — trust-gated confidences. Role-only (the-player, a houseguest, an ally, a near-stranger,
 * a schemer). Drives the REAL `GameSessionAdapter.confide` authority + the `npcVoice.mayConfide` hint, with
 * the confidence-recording pathway wired exactly as the composition root wires it (`registry.setOnConfide`),
 * so a disclosure actually becomes the player's knowledge through the in-game `told-by` pathway (0002). The
 * engine decides every disclosure (whether/how-much/true-or-lie); the model only voices what it is handed —
 * so an UNdisclosed secret can never appear, and a lie never carries a real secret of anyone.
 */

interface CState {
  cSession?: GameSessionAdapter;
  cSb?: ReturnType<typeof buildSandbox>;
  cId?: EntityId;
  cSecret?: HiddenElement;
  cRes?: ConfideResult;
  cRes2?: ConfideResult;
  cVoiceJson?: string;
  cWarmthBefore?: number;
  cEdgeBefore?: { trust: number; affinity: number; threat: number };
  cWarmResults?: ConfideResult[];
}
const cf = (w: BbWorld): CState => w as unknown as CState;

const relOf = (s: GameSessionAdapter): RelationshipModel => (s as unknown as { rel: RelationshipModel }).rel;
const houseOf = (s: GameSessionAdapter): GameHouse => (s as unknown as { house: GameHouse }).house;
const confideStateOf = (s: GameSessionAdapter): Record<string, { truthful: boolean }> =>
  (s as unknown as { confideState: Record<string, { truthful: boolean }> }).confideState;
const lieCountOf = (s: GameSessionAdapter): number => (s as unknown as { lieCount: number }).lieCount;

/** Mirror the composition root's confidence pathway (registry.ts `setOnConfide`) so a disclosure records
 *  as the player's knowledge — the step world wires the server by hand, not via the root. */
function wireConfide(session: GameSessionAdapter, sb: ReturnType<typeof buildSandbox>): void {
  session.setOnConfide((npcId, content, confidence) => {
    const factId = `confide:${npcId}:${sb.engine.events.count()}`;
    sb.engine.knowledge.seedBelief(
      npcId,
      { content, originalContent: content, factId, confidence: 0.9, hops: 0, distortion: 0, source: npcId },
      "origin",
    );
    const fact = sb.engine.knowledge.surfaceInformationTo(
      PLAYER, { content, subject: npcId, confidence }, `told-by:${npcId}`,
    );
    return fact !== null;
  });
}

function started(w: BbWorld, seed: number): void {
  const sb = buildSandbox(seed);
  const session = new GameSessionAdapter();
  wireConfide(session, sb);
  session.createCharacter({ playerName: "The Player", seed });
  cf(w).cSession = session;
  cf(w).cSb = sb;
}

/** The first houseguest carrying a sealed secret (role-only — no name from any corpus). */
function firstSecretNpc(s: GameSessionAdapter): { id: EntityId; secret: HiddenElement } {
  const npc = houseOf(s).npcs.find((n) => (n.character.hiddenElements ?? []).length > 0)!;
  return { id: npc.id, secret: npc.character.hiddenElements![0]! };
}

/** Set both directed edges between the player and a houseguest (test-only Vault-internal setup). */
function setEdges(s: GameSessionAdapter, id: EntityId, v: { trust: number; affinity: number; threat: number }): void {
  for (const [a, b] of [[id, PLAYER], [PLAYER, id]] as const) {
    const e = relOf(s).edge(a, b);
    e.trust = v.trust; e.affinity = v.affinity; e.threat = v.threat;
  }
  // AMEND 0075 item 4: `confide()` is engine-refused outside a scene, so every Given that sets up a confiding ally also puts them in the player's room (the one scenario about ABSENCE moves them apart afterwards).
  seatWithPlayer(s, id);
}
function seatWithPlayer(s: GameSessionAdapter, id: EntityId): void {
  const p = (s as unknown as { presence?: Map<string, string> }).presence;
  if (p) { p.set(PLAYER, "kitchen"); p.set(id, "kitchen"); }
}

/** Bank `n` open pacts — the 0039 goodwill the disclosure motive reads (one open pact ≈ 0.2 goodwill). */
function addDeals(s: GameSessionAdapter, id: EntityId, n: number): void {
  for (let i = 0; i < n; i++) s.makeDeal({ with: id, kind: "final-two", terms: "ride or die" });
}

/** A manipulator the player reads as a high threat with no warmth — the strategic (lie) pull. */
function setupLiar(s: GameSessionAdapter, id: EntityId): void {
  houseOf(s).npcs.find((n) => n.id === id)!.character.archetype = "mastermind";
  setEdges(s, id, { trust: 0, affinity: 0, threat: 0.95 });
}

const warmthSum = (s: GameSessionAdapter, id: EntityId): number => {
  const a = relOf(s).edge(id, PLAYER); const b = relOf(s).edge(PLAYER, id);
  return a.trust + a.affinity + b.trust + b.affinity;
};

// ── Background ───────────────────────────────────────────────────────────────────────────────────

Given("a started season with the player in the house", function (this: BbWorld) {
  started(this, 1);
});

// ── Rule: A confidence requires a reason, and never crosses without one ────────────────────────────

Given("a houseguest the player has no bond or favor with", function (this: BbWorld) {
  const s = cf(this).cSession!;
  const { id, secret } = firstSecretNpc(s);
  setEdges(s, id, { trust: 0.1, affinity: 0.1, threat: 0.1 }); // a near-stranger, and no banked favors
  cf(this).cId = id; cf(this).cSecret = secret;
});

When("the player presses them to open up", function (this: BbWorld) {
  cf(this).cRes = cf(this).cSession!.confide(cf(this).cId!) ?? undefined;
});

Then("no secret is disclosed", function (this: BbWorld) {
  assert.equal(cf(this).cRes!.disclosed, false);
});

Then("the player learns nothing the houseguest has not said in the room", function (this: BbWorld) {
  const known = cf(this).cSb!.engine.knowledge.knownTo(PLAYER);
  assert.ok(!known.some((f) => f.content.includes(cf(this).cSecret!.detail)));
});

Then("the houseguest's sealed secret never appears on any player-facing surface", function (this: BbWorld) {
  const voice = JSON.stringify(cf(this).cSession!.npcVoice(cf(this).cId!));
  assert.ok(!voice.includes(cf(this).cSecret!.detail));
});

Given("an ally whose mutual bond and banked favors place the disclosure motive in the partial band", function (this: BbWorld) {
  const s = cf(this).cSession!;
  const npc = houseOf(s).npcs.find((n) => (n.character.hiddenElements ?? []).length > 0)!;
  // Plant a STRUCTURED secret so the partial tier's blur demonstrably drops specifics — the generated
  // one-line motives have no clause/number for the redactor to strip (test-only scaffolding, role-only).
  npc.character.hiddenElements![0] = {
    kind: "secret-motive",
    detail: "is carrying a secret from home: a debt of 40000 they have admitted to no one",
  };
  setEdges(s, npc.id, { trust: 0.95, affinity: 0.95, threat: 0.05 });
  addDeals(s, npc.id, 2); // two open pacts ⇒ the motive lands in the partial band
  cf(this).cId = npc.id; cf(this).cSecret = npc.character.hiddenElements![0]!;
});

When("the player draws them out in a scene", function (this: BbWorld) {
  cf(this).cRes = cf(this).cSession!.confide(cf(this).cId!)!;
});

Then("the houseguest discloses a partial, hedged version of the secret", function (this: BbWorld) {
  assert.equal(cf(this).cRes!.tier, "partial");
  assert.equal(cf(this).cRes!.truthful, true);
});

Then("the full sealed premise does not cross", function (this: BbWorld) {
  assert.notEqual(cf(this).cRes!.content, cf(this).cSecret!.detail);
  const known = cf(this).cSb!.engine.knowledge.knownTo(PLAYER);
  assert.ok(!known.some((f) => f.content === cf(this).cSecret!.detail)); // never the whole premise verbatim
});

When("the player has banked further goodwill so the motive reaches the full band", function (this: BbWorld) {
  addDeals(cf(this).cSession!, cf(this).cId!, 1); // a third open pact ⇒ the full band
});

When("the player draws them out again", function (this: BbWorld) {
  cf(this).cRes2 = cf(this).cSession!.confide(cf(this).cId!)!;
});

Then("the houseguest discloses the whole secret in their own words", function (this: BbWorld) {
  assert.equal(cf(this).cRes2!.tier, "full");
  assert.equal(cf(this).cRes2!.content, cf(this).cSecret!.detail);
});

Then("that secret is now the player's recorded knowledge", function (this: BbWorld) {
  const known = cf(this).cSb!.engine.knowledge.knownTo(PLAYER);
  assert.ok(known.some((f) => f.content.includes(cf(this).cSecret!.detail)));
});

// ── Rule: The engine decides and records; the model only voices ───────────────────────────────────

Given("an ally whose disclosure motive is in the full band", function (this: BbWorld) {
  const s = cf(this).cSession!;
  const { id, secret } = firstSecretNpc(s);
  setEdges(s, id, { trust: 0.92, affinity: 0.92, threat: 0.05 }); // headroom so the bond bump is observable
  addDeals(s, id, 3);
  cf(this).cId = id; cf(this).cSecret = secret;
});

When("the engine fires a confidence in the player's scene", function (this: BbWorld) {
  cf(this).cWarmthBefore = warmthSum(cf(this).cSession!, cf(this).cId!);
  cf(this).cRes = cf(this).cSession!.confide(cf(this).cId!)!;
});

Then("the disclosure is recorded as a player-witnessed event with content lineage", function (this: BbWorld) {
  const known = cf(this).cSb!.engine.knowledge.knownTo(PLAYER);
  const fact = known.find((f) => f.content.includes(cf(this).cSecret!.detail));
  assert.ok(fact, "the disclosure is the player's recorded knowledge");
  assert.match(fact!.pathway ?? "", /told-by/); // the in-game told-by pathway is the content lineage
});

Then("the secret is Journal-visible to the player", function (this: BbWorld) {
  const known = cf(this).cSb!.engine.knowledge.knownTo(PLAYER);
  assert.ok(known.some((f) => f.content.includes(cf(this).cSecret!.detail)));
});

Then("the confiding deepens the bond between the player and the ally", function (this: BbWorld) {
  assert.ok(warmthSum(cf(this).cSession!, cf(this).cId!) > cf(this).cWarmthBefore!, "the bond deepened");
});

Then("no number is ever shown to the player", function (this: BbWorld) {
  assert.doesNotMatch(JSON.stringify(cf(this).cRes), /0\.\d/); // no relationship scalar ever crosses
});

Given("an ally who has not yet confided", function (this: BbWorld) {
  const s = cf(this).cSession!;
  const { id, secret } = firstSecretNpc(s);
  setEdges(s, id, { trust: 0.95, affinity: 0.95, threat: 0.05 });
  addDeals(s, id, 3); // the motive + a precipitating event are present — but `confide` is NOT called
  cf(this).cId = id; cf(this).cSecret = secret;
});

When("the model fetches the houseguest's voice for a scene", function (this: BbWorld) {
  cf(this).cVoiceJson = JSON.stringify(cf(this).cSession!.npcVoice(cf(this).cId!));
});

Then("the voice carries no sealed secret content", function (this: BbWorld) {
  assert.ok(!cf(this).cVoiceJson!.includes(cf(this).cSecret!.detail));
});

Then("at most a Vault-safe reason-to-open-up hint when the motive and a fresh precipitating event are present", function (this: BbWorld) {
  const hint = cf(this).cSession!.npcVoice(cf(this).cId!)!.mayConfide;
  // The Given sets BOTH the motive and a precipitating pact, so the hint must be PRESENT (was `if (hint)`, which passed with no hint at all).
  assert.ok(hint && hint.ready === true, "the motive + a fresh precipitating event offer the hint");
  {
    assert.ok(!JSON.stringify(hint).includes(cf(this).cSecret!.detail)); // never the secret
    assert.doesNotMatch(JSON.stringify(hint), /0\.\d/); // never a number
  }
});

// ── Rule: Earned and anchored — never a cold pop-up ───────────────────────────────────────────────

Given("an ally whose disclosure motive would otherwise allow a confidence", function (this: BbWorld) {
  const s = cf(this).cSession!;
  const { id, secret } = firstSecretNpc(s);
  setEdges(s, id, { trust: 1, affinity: 1, threat: 0.05 }); // motive clears on warmth alone — but NO pacts
  cf(this).cId = id; cf(this).cSecret = secret;
});

Given("the player is not in a scene with that ally", function (this: BbWorld) {
  // AMEND 0075 (S13): a REAL absence - no precipitating pact AND the ally is in a different room than the player (the engine now refuses confide() without co-presence).
  (cf(this).cSession as unknown as { presence: Map<string, string> }).presence = new Map<string, string>([[PLAYER, "kitchen"], [cf(this).cId!, "bedroom"]]);
});

Then("no reason-to-open-up hint is offered for that ally", function (this: BbWorld) {
  assert.equal(cf(this).cSession!.npcVoice(cf(this).cId!)!.mayConfide, undefined);
});

Then("no off-screen process starts a confidence scene on its own", function (this: BbWorld) {
  // A real negative (was: an empty Given + "the secret is not in the player's knowledge", true for any input): pressing a confidence with NO scene returns no disclosure at all,
  // and the secret is still absent from what the player knows afterwards.
  const res = cf(this).cSession!.confide(cf(this).cId!);
  assert.deepEqual(res, { disclosed: false, tier: "none", truthful: true }, "confide outside a scene discloses nothing");
  const known = cf(this).cSb!.engine.knowledge.knownTo(PLAYER);
  assert.ok(!known.some((f) => f.content.includes(cf(this).cSecret!.detail)), "nothing surfaced unprompted");
});

Given("an ally the player just did an in-game favor for", function (this: BbWorld) {
  const s = cf(this).cSession!;
  // The emergent hint is present ONLY for an ACTIVE houseguest — find one with a secret, set up the
  // earned bond + the fresh favor (an open pact), and confirm the hint surfaces.
  for (const npc of houseOf(s).npcs) {
    if (!(npc.character.hiddenElements ?? []).length) continue;
    setEdges(s, npc.id, { trust: 0.95, affinity: 0.95, threat: 0.05 });
    addDeals(s, npc.id, 1); // the favor — a fresh precipitating scene
    if (s.npcVoice(npc.id)!.mayConfide) {
      cf(this).cId = npc.id; cf(this).cSecret = npc.character.hiddenElements![0]!; return;
    }
  }
  throw new Error("no active ally available to precipitate an emergent confidence");
});

When("the player is in a scene with that ally", function () {
  // The open pact between them is the live-scene proxy; the read happens in the Then.
});

Then("the voice carries a reason-to-open-up hint naming the earned reason", function (this: BbWorld) {
  const hint = cf(this).cSession!.npcVoice(cf(this).cId!)!.mayConfide!;
  assert.equal(hint.ready, true);
  const reasonWords: string[] = Object.values(CONFIDENCE.reasons);
  assert.ok(reasonWords.includes(hint.reason)); // an earned reason word, never a number
});

Then("the confidence reads as prompted by what just happened", function (this: BbWorld) {
  const hint = cf(this).cSession!.npcVoice(cf(this).cId!)!.mayConfide!;
  assert.ok(typeof hint.reason === "string" && hint.reason.length > 0);
});

// ── Rule: Houseguests can lie ─────────────────────────────────────────────────────────────────────

Given("a houseguest who reads the player as useful but threatening", function (this: BbWorld) {
  const s = cf(this).cSession!;
  const { id, secret } = firstSecretNpc(s);
  setupLiar(s, id);
  cf(this).cId = id; cf(this).cSecret = secret;
});

Given("whose disclosure motive is carried by strategy, not closeness", function () {
  // `setupLiar` already configures the strategic pull dominating the (absent) genuine one.
});

When("the engine fires a confidence", function (this: BbWorld) {
  cf(this).cRes = cf(this).cSession!.confide(cf(this).cId!)!;
});

Then("the disclosed content is a fabricated admission, not a real secret of any houseguest", function (this: BbWorld) {
  const res = cf(this).cRes!;
  assert.equal(res.disclosed, true);
  assert.equal(res.truthful, false);
  const fabrications = Object.values(CONFIDENCE.fabrications).flat();
  assert.ok(fabrications.includes(res.content!), "an engine-authored fabrication");
  const realSecrets = houseOf(cf(this).cSession!).npcs.flatMap(
    (n) => (n.character.hiddenElements ?? []).map((h) => h.detail),
  );
  assert.ok(!realSecrets.includes(res.content!), "never a real secret of anyone (a lie is not a leak)");
});

Then("the player surface shows the claim with no truth marker and no tell", function (this: BbWorld) {
  const known = cf(this).cSb!.engine.knowledge.knownTo(PLAYER).find((f) => f.content === cf(this).cRes!.content);
  assert.ok(known, "the claim is the player's knowledge");
  assert.ok(!("truthful" in (known as object)), "no truth/lie marker on the player surface");
});

Then("the player's resulting belief is recorded as untrue in the hidden layer", function (this: BbWorld) {
  assert.equal(confideStateOf(cf(this).cSession!)[cf(this).cId!]!.truthful, false);
});

Given("the player believes a false confidence", function (this: BbWorld) {
  const s = cf(this).cSession!;
  const { id, secret } = firstSecretNpc(s);
  setupLiar(s, id);
  const lie = s.confide(id)!;
  assert.equal(lie.truthful, false); // a lie is planted and believed
  cf(this).cId = id; cf(this).cSecret = secret; cf(this).cRes = lie;
});

When("a genuine pathway later delivers the contradicting truth", function (this: BbWorld) {
  const s = cf(this).cSession!; const id = cf(this).cId!;
  // The bond is genuinely earned; the houseguest now tells the real thing — a true pathway.
  setEdges(s, id, { trust: 0.95, affinity: 0.95, threat: 0.05 });
  addDeals(s, id, 3);
  cf(this).cEdgeBefore = { ...relOf(s).edge(PLAYER, id) }; // the player's read of the liar, before the catch
  cf(this).cRes2 = s.confide(id)!;
  assert.equal(cf(this).cRes2!.truthful, true);
});

Then("the player's belief flips to the truth", function (this: BbWorld) {
  const known = cf(this).cSb!.engine.knowledge.knownTo(PLAYER);
  assert.ok(known.some((f) => f.content.includes(cf(this).cSecret!.detail)));
});

Then("acting on the lie deals the liar a betrayal-grade trust blow", function (this: BbWorld) {
  const after = relOf(cf(this).cSession!).edge(PLAYER, cf(this).cId!);
  const before = cf(this).cEdgeBefore!;
  assert.ok(after.trust < before.trust - 0.15, "trust drops betrayal-grade");
  assert.ok(after.threat > before.threat, "threat rises");
});

Given("a full season is played", function (this: BbWorld) {
  const s = cf(this).cSession!;
  for (const npc of houseOf(s).npcs) {
    if (!(npc.character.hiddenElements ?? []).length) continue;
    setupLiar(s, npc.id);
    s.confide(npc.id); // drive a strategic opening from every would-be liar
  }
  // The control: warm, non-manipulating friends with sealed secrets are pressed too - they can only ever tell the truth.
  cf(this).cWarmResults = [];
  for (const npc of houseOf(s).npcs) {
    if (!(npc.character.hiddenElements ?? []).length || confideStateOf(s)[npc.id]) continue;
    npc.character.archetype = "floater";
    setEdges(s, npc.id, { trust: 0.95, affinity: 0.95, threat: 0.05 });
    const r = s.confide(npc.id);
    if (r) (cf(this).cWarmResults ??= []).push(r);
  }
});

Then("the number of false confidences never exceeds the season cap", function (this: BbWorld) {
  assert.ok(lieCountOf(cf(this).cSession!) <= CONFIDENCE.maxLiesPerSeason);
  // ...AND non-manipulators never lie (the cap alone held even if everyone lied up to it).
  for (const r of cf(this).cWarmResults ?? []) assert.ok(r.truthful, "a warm non-manipulator never tells a false confidence");
});
