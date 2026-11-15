import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { BASE_GAME_MASTER_PROMPT } from "../../src/engine/momentPrompts";
import { VOICE_ARCHETYPE_BIAS, VOICE_ARCHETYPE_SIGNATURES, generateVoice } from "../../src/engine/voice";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0084 — character voice & grounded mood. Role-only: the cast, an NPC, two-of-an-archetype.
 * Drives the REAL `GameSessionAdapter` (factory cast + `npcVoice` projection + snapshot/restore), so
 * these are integration proofs on top of the pure `voice0084.test.ts` unit gate.
 */

interface CVState {
  cvSession?: GameSessionAdapter;
  cvIds?: EntityId[];
  cvVoiceById?: Map<EntityId, unknown>;
  cvMoodBefore?: string;
  cvVoiceBefore?: string;
}
const cv = (w: BbWorld): CVState => w as unknown as CVState;

function started(seed: number): { session: GameSessionAdapter; ids: EntityId[] } {
  const session = new GameSessionAdapter();
  session.createCharacter({ playerName: "The Player", seed });
  const core = session.snapshot();
  const ids = (core.house?.npcs ?? []).map((n) => n.id);
  return { session, ids };
}

/** Mutate one NPC's soul scalars/history through the public snapshot/restore round-trip (test-only). */
/** ORW-335: land REAL beats on a houseguest's soul through the engine's own arc (`inflect` -> `evolveEmotion`), not a hand-set scalar. */
function beats(session: GameSessionAdapter, id: EntityId, event: string, n: number): void {
  const inflect = (session as unknown as { inflect(id: EntityId, e: string): void }).inflect.bind(session);
  for (let i = 0; i < n; i++) inflect(id, event);
}

function setSoul(session: GameSessionAdapter, id: EntityId, patch: { emotionalState?: number; volatility?: number; emotionalHistory?: number[] }): void {
  const core = session.snapshot();
  const npc = core.house!.npcs.find((n) => n.id === id)!;
  Object.assign(npc.soul, patch);
  session.restore(core);
}

Given("a started season with a generated cast", function (this: BbWorld) {
  const { session, ids } = started(2026);
  cv(this).cvSession = session;
  cv(this).cvIds = ids;
});

Then("every houseguest carries a voice fingerprint with a register, rhythm, and stress tell", function (this: BbWorld) {
  const s = cv(this).cvSession!;
  for (const id of cv(this).cvIds!) {
    const v = s.npcVoice(id)!.persona.voice!;
    assert.ok(v, "voice present");
    assert.ok(v.register && v.rhythm && v.stressTell, "register/rhythm/stressTell present");
  }
});

Then("no two houseguests in the cast have an identical voice fingerprint", function (this: BbWorld) {
  const s = cv(this).cvSession!;
  const prints = cv(this).cvIds!.map((id) => JSON.stringify(s.npcVoice(id)!.persona.voice));
  assert.equal(new Set(prints).size, prints.length, "all voices distinct");
});

Then("the cast spans a range of registers and rhythms, not one default", function (this: BbWorld) {
  const s = cv(this).cvSession!;
  const voices = cv(this).cvIds!.map((id) => s.npcVoice(id)!.persona.voice!);
  assert.ok(new Set(voices.map((v) => v.register)).size >= 3, "≥3 registers");
  assert.ok(new Set(voices.map((v) => v.rhythm)).size >= 3, "≥3 rhythms");
});

Given("two houseguests share an archetype", function (this: BbWorld) {
  // Pick a pair sharing an archetype that actually HAS a voice leaning (a lean-less archetype is uncorrelated by
  // design, so it could not show correlation either way); walk seeds until a season casts such a pair.
  for (let seed = 2026; seed < 2066; seed++) {
    const { session, ids } = seed === 2026 ? { session: cv(this).cvSession!, ids: cv(this).cvIds! } : started(seed);
    const byArch = new Map<string, EntityId[]>();
    for (const id of ids) {
      const a = session.npcVoice(id)!.persona.archetype!;
      (byArch.get(a) ?? byArch.set(a, []).get(a)!).push(id);
    }
    const pair = [...byArch.entries()].find(([a, g]) => g.length >= 2 && VOICE_ARCHETYPE_BIAS[a]);
    if (pair) {
      cv(this).cvSession = session;
      cv(this).cvIds = pair[1].slice(0, 2);
      return;
    }
  }
  assert.fail("no generated cast has two houseguests of one lean-bearing archetype");
});

Then("their voice fingerprints are correlated with that archetype", function (this: BbWorld) {
  const s = cv(this).cvSession!;
  for (const id of cv(this).cvIds!) {
    const view = s.npcVoice(id)!;
    const arch = view.persona.archetype!;
    const voice = view.persona.voice!;
    const lean = VOICE_ARCHETYPE_BIAS[arch];
    assert.ok(lean, `the archetype '${arch}' has a voice lean to be correlated with`);
    // The archetype's core dials win ~80% of the time each; a voice matching NONE of them is not archetype-correlated.
    const matches = Object.entries(lean).filter(([dial, value]) => (voice as unknown as Record<string, string>)[dial] === value).length;
    assert.ok(matches >= 1, `${id} (${arch}) matches none of its archetype's voice leanings`);
    // One voice proves little (a generic voice can match a dial by luck), so sample the generator itself: EVERY biased dial
    // must land on the archetype's lean far more often than a free pick would (~80% by design vs ~1/4 free).
    const N = 400;
    const hits = new Map<string, number>(Object.keys(lean).map((d) => [d, 0]));
    for (let i = 0; i < N; i++) {
      const v = generateVoice(new SeededRandom(7000 + i), arch) as unknown as Record<string, string>;
      for (const [dial, value] of Object.entries(lean)) if (v[dial] === value) hits.set(dial, hits.get(dial)! + 1);
    }
    for (const [dial, n] of hits) assert.ok(n / N >= 0.7, `the '${arch}' lean on '${dial}' won only ${Math.round((100 * n) / N)}% of ${N} generated voices (designed ~80%)`);
    // ...and the prose signature is dealt from the archetype's own pool, not a generic one.
    const pool = VOICE_ARCHETYPE_SIGNATURES[arch];
    if (pool) assert.ok(pool.includes(voice.signature), `${id} (${arch}) signature '${voice.signature}' is not from the archetype's pool`);
  }
});

Then("they are not identical to each other", function (this: BbWorld) {
  const s = cv(this).cvSession!;
  const [a, b] = cv(this).cvIds!;
  assert.notEqual(JSON.stringify(s.npcVoice(a!)!.persona.voice), JSON.stringify(s.npcVoice(b!)!.persona.voice));
});

When("the voicing projection for a houseguest is read", function (this: BbWorld) {
  // Plant a sentinel into hidden state; voicing must never surface it.
  const s = cv(this).cvSession!;
  const core = s.snapshot();
  core.house!.npcs[0]!.character.hiddenElements.push({ kind: "secret-motive", detail: "SENTINEL-0084-VOICE" });
  s.restore(core);
  cv(this).cvIds = [core.house!.npcs[0]!.id];
});

Then("it carries the voice fingerprint", function (this: BbWorld) {
  const s = cv(this).cvSession!;
  assert.ok(s.npcVoice(cv(this).cvIds![0]!)!.persona.voice, "voice present");
});

Then("it carries no hidden soul scalar, secret, or motive", function (this: BbWorld) {
  const s = cv(this).cvSession!;
  const blob = JSON.stringify(s.npcVoice(cv(this).cvIds![0]!));
  assert.ok(!blob.includes("SENTINEL-0084-VOICE"), "no sentinel");
  assert.ok(!/secret-motive/.test(blob), "no hidden kind");
});

Then("it carries no number", function (this: BbWorld) {
  const s = cv(this).cvSession!;
  // The voice fingerprint + mood are word-only; numbers in the projection (age) are separate persona
  // facts — assert the voice + mood specifically carry no digit.
  const view = s.npcVoice(cv(this).cvIds![0]!)!;
  assert.ok(!/[0-9]/.test(JSON.stringify(view.persona.voice)), "voice has no number");
  if (view.mood !== undefined) assert.ok(!/[0-9]/.test(view.mood), "mood has no number");
});

// --- Byte-stable identity ---

Given("a houseguest with a voice fingerprint", function (this: BbWorld) {
  const { session, ids } = started(55);
  cv(this).cvSession = session;
  cv(this).cvIds = [ids[0]!];
  cv(this).cvVoiceBefore = JSON.stringify(session.npcVoice(ids[0]!)!.persona.voice);
});

When("the cast is snapshotted and restored", function (this: BbWorld) {
  const s = cv(this).cvSession!;
  const revived = new GameSessionAdapter();
  revived.restore(s.snapshot());
  cv(this).cvSession = revived;
});

Then("that houseguest's voice fingerprint is identical", function (this: BbWorld) {
  const s = cv(this).cvSession!;
  assert.equal(JSON.stringify(s.npcVoice(cv(this).cvIds![0]!)!.persona.voice), cv(this).cvVoiceBefore);
});

When("many consequential beats evolve that houseguest's soul", function (this: BbWorld) {
  const s = cv(this).cvSession!;
  const id = cv(this).cvIds![0]!;
  cv(this).cvMoodBefore = s.npcVoice(id)!.mood;
  // ORW-335: a hard stretch of REAL beats through the engine's emotional arc (was a hand-set soul scalar, which proved nothing about evolution).
  beats(s, id, "blindside", 3);
  beats(s, id, "betrayed", 3);
});

Then("their voice fingerprint is unchanged", function (this: BbWorld) {
  const s = cv(this).cvSession!;
  assert.equal(JSON.stringify(s.npcVoice(cv(this).cvIds![0]!)!.persona.voice), cv(this).cvVoiceBefore);
});

Then("only their mood has moved", function (this: BbWorld) {
  const s = cv(this).cvSession!;
  assert.notEqual(s.npcVoice(cv(this).cvIds![0]!)!.mood, cv(this).cvMoodBefore);
});

// --- Mood grounded in the soul ---

Given("a houseguest whose soul has moved toward distress", function (this: BbWorld) {
  const { session, ids } = started(77);
  cv(this).cvSession = session;
  cv(this).cvIds = [ids[0]!];
  setSoul(session, ids[0]!, { emotionalState: 0.12, volatility: 0.5, emotionalHistory: [0.5, 0.4, 0.3, 0.12] });
});

When("the voicer is given that houseguest to voice", function (this: BbWorld) {
  cv(this).cvMoodBefore = cv(this).cvSession!.npcVoice(cv(this).cvIds![0]!)!.mood;
});

Then("the mood handed to the voicer is a distress affect, not a pleasant default", function (this: BbWorld) {
  assert.match(cv(this).cvMoodBefore ?? "", /shaken|rattled|worn|hollow|subdued/);
  assert.doesNotMatch(cv(this).cvMoodBefore ?? "", /ease|riding high/);
});

Then("the mood is an observable affect word, never a number", function (this: BbWorld) {
  assert.doesNotMatch(cv(this).cvMoodBefore ?? "", /[0-9]/);
});

Given("a houseguest worn down by many weeks of house dynamics", function (this: BbWorld) {
  const { session, ids } = started(88);
  cv(this).cvSession = session;
  cv(this).cvIds = [ids[0]!];
  // A baseline dragged low over the season; the current moment is neutral-calm.
  setSoul(session, ids[0]!, { emotionalState: 0.46, volatility: 0.4, emotionalHistory: [0.3, 0.25, 0.2, 0.22, 0.18, 0.24] });
});

When("the houseguest has a calm, uneventful moment", function (this: BbWorld) {
  cv(this).cvMoodBefore = cv(this).cvSession!.npcVoice(cv(this).cvIds![0]!)!.mood;
});

Then("their mood still reads as worn rather than resetting to a neutral default", function (this: BbWorld) {
  assert.match(cv(this).cvMoodBefore ?? "", /worn|hollow|subdued/);
  assert.notEqual(cv(this).cvMoodBefore, "even");
});

Then("a houseguest who has had a long safe run reads as lasting ease in the same calm moment", function (this: BbWorld) {
  const s = cv(this).cvSession!;
  const id = cv(this).cvIds![0]!;
  setSoul(s, id, { emotionalState: 0.54, volatility: 0.4, emotionalHistory: [0.7, 0.75, 0.8, 0.78, 0.82, 0.76] });
  assert.match(s.npcVoice(id)!.mood ?? "", /ease|riding high/);
});

Given("a betrayed NPC whose betrayal is hidden from the player", function (this: BbWorld) {
  const { session, ids } = started(91);
  cv(this).cvSession = session;
  cv(this).cvIds = [ids[0]!];
  const core = session.snapshot();
  core.house!.npcs.find((n) => n.id === ids[0])!.character.hiddenElements.push({ kind: "secret-motive", detail: "BETRAYAL-CAUSE-SENTINEL" });
  session.restore(core);
  setSoul(session, ids[0]!, { emotionalState: 0.2, volatility: 0.85, emotionalHistory: [0.6, 0.5, 0.3, 0.2] });
});

When("the player reads that houseguest in a scene", function (this: BbWorld) {
  cv(this).cvVoiceBefore = JSON.stringify(cv(this).cvSession!.npcVoice(cv(this).cvIds![0]!));
});

Then("the houseguest's mood reflects the shift", function (this: BbWorld) {
  assert.match(cv(this).cvSession!.npcVoice(cv(this).cvIds![0]!)!.mood ?? "", /shaken|rattled|on edge|worn/);
});

Then("the read never names the hidden cause of the mood", function (this: BbWorld) {
  assert.ok(!(cv(this).cvVoiceBefore ?? "").includes("BETRAYAL-CAUSE-SENTINEL"));
});

Then("the player is left to infer why for themselves", function (this: BbWorld) {
  // All the player gets is an affect: the mood is ONLY the carriage vocabulary, and no field of the read carries a cause.
  const view = cv(this).cvSession!.npcVoice(cv(this).cvIds![0]!)!;
  assert.match(
    view.mood ?? "",
    /^(worn but |at ease but |shaken, )?(hollowed out|worn down|subdued|muted|even|steady|settled|at ease|riding high)(, on edge)?$/,
    "the mood is a bare affect word",
  );
  assert.ok(!/cause|reason|why|betray|motive/i.test(Object.keys(view).join(" ")), "no cause-shaped field on the read");
  const blob = JSON.stringify(view);
  assert.ok(!blob.includes("BETRAYAL-CAUSE-SENTINEL") && !/secret-motive/.test(blob), "the hidden cause is not in the read");
});

Given("a houseguest with a settled baseline mood", function (this: BbWorld) {
  const { session, ids } = started(33);
  cv(this).cvSession = session;
  cv(this).cvIds = [ids[0]!];
  setSoul(session, ids[0]!, { emotionalState: 0.5, volatility: 0.4, emotionalHistory: [0.5, 0.5, 0.5] });
  cv(this).cvMoodBefore = session.npcVoice(ids[0]!)!.mood;
});

When("a costly beat lands on that houseguest", function (this: BbWorld) {
  beats(cv(this).cvSession!, cv(this).cvIds![0]!, "blindside", 3); // ORW-335: real beats through the arc, not a hand-set scalar
});

Then("their mood word changes from the baseline", function (this: BbWorld) {
  assert.notEqual(cv(this).cvSession!.npcVoice(cv(this).cvIds![0]!)!.mood, cv(this).cvMoodBefore);
});

Then("it later settles back as the soul mean-reverts", function (this: BbWorld) {
  // ORW-335: quiet stretches through the engine's own mean reversion (was: the baseline re-written by hand and compared with itself).
  const s = cv(this).cvSession!, id = cv(this).cvIds![0]!;
  const shaken = s.npcVoice(id)!.mood;
  beats(s, id, "calm", 40);
  assert.notEqual(s.npcVoice(id)!.mood, shaken, "the arc moved the mood back off the distressed word");
  assert.equal(s.npcVoice(id)!.mood, cv(this).cvMoodBefore, "and it settled back to the baseline word");
});

// --- Determinism + lever contract ---

Given("two seasons generated from the same seed", function (this: BbWorld) {
  cv(this).cvSession = started(404).session;
  (cv(this) as { cvSession2?: GameSessionAdapter }).cvSession2 = started(404).session;
});

Then("the two casts have identical voice fingerprints", function (this: BbWorld) {
  const a = cv(this).cvSession!;
  const b = (cv(this) as { cvSession2?: GameSessionAdapter }).cvSession2!;
  const va = (a.snapshot().house?.npcs ?? []).map((n) => JSON.stringify(n.character.voice));
  const vb = (b.snapshot().house?.npcs ?? []).map((n) => JSON.stringify(n.character.voice));
  assert.deepEqual(va, vb);
});

When("the moment prompt for a focal houseguest is built", function () {
  // BASE_GAME_MASTER_PROMPT is the lever surface; nothing to capture.
});

Then("it instructs the voicer to voice the houseguest's given mood", function () {
  assert.match(BASE_GAME_MASTER_PROMPT, /VOICE THE GIVEN `mood`/);
});

Then("it instructs the voicer to use the voice as a consistent texture, never a catchphrase or bit", function () {
  assert.match(BASE_GAME_MASTER_PROMPT, /TEXTURE, not a bit/);
  assert.match(BASE_GAME_MASTER_PROMPT, /catchphrase/);
});
