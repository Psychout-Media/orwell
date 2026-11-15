import { Before, Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { RelationshipModel } from "../../src/engine/relationships";
import { confessionalFor, type Confessional } from "../../src/engine/confessionals";
import { generateVoice } from "../../src/engine/voice";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { VoiceProfile } from "../../src/domain/voiceProfile";
import { answerPending } from "../support/answerPending";
import { livePlayerSurfaces } from "../support/liveSweep";
import { playSeasonOutcome, type SeasonOutcome } from "../support/seasonOutcome";

/**
 * Feature 0090 — per-archetype voice (extends 0084). Role-only: a blunt-archetype houseguest, a warm-archetype houseguest,
 * two-of-an-archetype, a confessor, the player. Voice output is SEEDED, so every claim is a property over many seeds or a
 * comparison between two runs of the real engine — never one pinned string. The live claims drive the REAL registry sandbox
 * (`createCharacter` -> `advanceGame`), where `GameSessionAdapter` threads each confessor's voice into the ceremony
 * confessionals it records (`ctxFor`); "voice off" is the same seeded season with the voice fingerprints removed from the cast
 * (the absent-voice templated fallback — there is no voice flag).
 */

/** A scenario tagged @pending describes unbuilt behaviour: skip it (its steps below are placeholders that never run). */
Before({ tags: "@pending" }, function () {
  return "skipped";
});

interface Live { sb: UserSandbox; confessionals: Array<{ initiator: string; witnessSet: string[]; hidden: boolean; content: string }> }
interface VState {
  vSb?: UserSandbox;
  vRows?: Array<{ blunt: Confessional; warm: Confessional; bluntT: Confessional; warmT: Confessional }>;
  vPairs?: Array<[unknown, unknown]>;
  vCasts?: string[][];
  vBefore?: Map<EntityId, string>;
  vMoodBefore?: Map<EntityId, string>;
  vSoulBefore?: Map<EntityId, number>;
  vProbe?: string;
  vTwinVoices?: string;
  vVoiced?: Live[];
  vBare?: Live[];
  vSecond?: Live[];
  vTwoVoice?: Array<{ a: Confessional; b: Confessional; relBefore: string; relAfter: string }>;
  vOutcomes?: Array<[SeasonOutcome, SeasonOutcome]>;
}
const vs = (w: BbWorld): VState => w as unknown as VState;

let users = 0;
/** Each sandbox's full registry save (engine snapshot + event record), for the save/restore scenario. */
const saves = new WeakMap<UserSandbox, () => unknown>();
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
const OTHERS = [npc(1), npc(2), npc(3)];
/** The confessor npc(1)'s ENGINE read: npc(2) is the real target, npc(3) the real ally. */
function grounded(): RelationshipModel {
  const rel = new RelationshipModel(0.5);
  rel.edge(npc(1), npc(2)).threat = 0.9;
  rel.edge(npc(1), npc(3)).trust = 0.9;
  rel.edge(npc(1), npc(3)).affinity = 0.8;
  return rel;
}
/** The 0040 measured-pool target/ally lines (the shared templated phrasing an un-voiced confessor uses). */
const TEMPLATED = /I need .+? gone — they're my biggest threat|every road to the end runs through .+?, and they have to go|is the one I'm watching — they're playing everybody|is the name I write down|I'm still reading the room/;
const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

function sandbox(seed: number, opts: { stripVoices?: boolean } = {}): UserSandbox {
  const reg = new GameSessionRegistry();
  const user = `orw0090-${seed}-${++users}`;
  const sb = reg.sandboxFor(user);
  saves.set(sb, () => reg.snapshot(user));
  sb.session.createCharacter({ playerName: "The Player", seed });
  if (opts.stripVoices) {
    const core = sb.session.snapshot();
    for (const n of core.house!.npcs) delete (n.character as { voice?: VoiceProfile }).voice;
    sb.session.restore(core);
  }
  return sb;
}
const npcIds = (sb: UserSandbox): EntityId[] => sb.session.snapshot().house!.npcs.map((n) => n.id);
const voiceOf = (sb: UserSandbox, id: EntityId): string => JSON.stringify(sb.session.npcVoice(id)!.persona.voice ?? null);
/** Every voice-bearing projection of the cast: the full fingerprint (`npcVoice`) and the roster's dial clause (`getGameState`). */
const castVoices = (sb: UserSandbox): string =>
  JSON.stringify([npcIds(sb).map((id) => sb.session.npcVoice(id)!.persona.voice), sb.session.getGameState().house.map((h) => (h as { voice?: string }).voice ?? null)]);

/** Drive a headless season `beats` advances and return its recorded confessional events (in order). */
function drive(sb: UserSandbox, beats = 60): Live {
  for (let i = 0; i < beats; i++) {
    const v = sb.session.advanceGame();
    if (v.pending) { const req = answerPending(v.pending); if (req) sb.session.submitDecision(req); }
    if (v.finished) break;
  }
  const confessionals = sb.engine.events.queryAll().filter((e) => e.type === "confessional")
    .map((e) => ({ initiator: e.initiator, witnessSet: [...e.witnessSet], hidden: e.hidden, content: e.content }));
  return { sb, confessionals };
}

// ── Background ───────────────────────────────────────────────────────────────────────────────────

Given("a started season whose houseguests all carry a voice fingerprint", function (this: BbWorld) {
  const sb = sandbox(2026);
  for (const id of npcIds(sb)) assert.ok(sb.session.npcVoice(id)!.persona.voice, `${id} has no voice fingerprint`);
  vs(this).vSb = sb;
});

// ── Rule: two archetypes read as distinct voices ──────────────────────────────────────────────────

Given("a blunt-archetype houseguest and a warm-archetype houseguest with the same engine-grounded target and ally", function (this: BbWorld) {
  vs(this).vRows = [];
});

When("each records a confessional", function (this: BbWorld) {
  const rel = grounded();
  vs(this).vRows = SEEDS.map((seed) => {
    const bluntVoice = generateVoice(new SeededRandom(seed), "comp-beast");
    const warmVoice = generateVoice(new SeededRandom(seed + 5000), "social-butterfly");
    // Each confessor's phrasing rng is its own (as the live `ctxFor` keys it per houseguest); the templated twin uses the same rng.
    return {
      blunt: confessionalFor(npc(1), OTHERS, rel, { rng: new SeededRandom(seed), voice: bluntVoice }),
      warm: confessionalFor(npc(1), OTHERS, rel, { rng: new SeededRandom(seed + 5000), voice: warmVoice }),
      bluntT: confessionalFor(npc(1), OTHERS, rel, { rng: new SeededRandom(seed) }),
      warmT: confessionalFor(npc(1), OTHERS, rel, { rng: new SeededRandom(seed + 5000) }),
    };
  });
});

Then("their confessionals are voiced in distinguishable diction and cadence", function (this: BbWorld) {
  const rows = vs(this).vRows!;
  const blunt = rows.map((r) => r.blunt.content); const warm = rows.map((r) => r.warm.content);
  // Cadence: the warm voice rambles, the blunt voice clips — by a wide margin, across every seed.
  assert.ok(mean(warm.map(words)) >= 2 * mean(blunt.map(words)), `warm ${mean(warm.map(words))} words vs blunt ${mean(blunt.map(words))}`);
  // Diction: the two archetypes draw from (nearly) disjoint phrasings.
  const warmSet = new Set(warm);
  const shared = new Set(blunt.filter((c) => warmSet.has(c)));
  assert.ok(shared.size <= 0.2 * new Set(blunt).size, `${shared.size} of ${new Set(blunt).size} blunt phrasings also came from the warm voice`);
});

Then("neither falls back to the single shared templated line", function (this: BbWorld) {
  const rows = vs(this).vRows!;
  const off = (k: "blunt" | "warm", t: "bluntT" | "warmT"): number => rows.filter((r) => r[k].content !== r[t].content).length / rows.length;
  assert.ok(off("blunt", "bluntT") >= 0.9, `the blunt voice matched the templated line on ${Math.round(100 * (1 - off("blunt", "bluntT")))}% of seeds`);
  assert.ok(off("warm", "warmT") >= 0.9, `the warm voice matched the templated line on ${Math.round(100 * (1 - off("warm", "warmT")))}% of seeds`);
  for (const r of rows) {
    assert.match(r.bluntT.content, TEMPLATED, "the un-voiced twin is the templated phrasing (the comparison is meaningful)");
    assert.match(r.warmT.content, TEMPLATED, "the warm un-voiced twin is the templated phrasing too"); // ORW-437
  }
});

Then("both still name the same engine-grounded target and ally", function (this: BbWorld) {
  for (const r of vs(this).vRows!) {
    for (const c of [r.blunt, r.warm]) {
      assert.equal(c.target, npc(2)); assert.equal(c.ally, npc(3));
      assert.ok(c.content.includes(npc(2)) && c.content.includes(npc(3)), `the voiced line dropped the target or ally: ${c.content}`);
    }
  }
});

// @pending placeholders (the scenario is skipped by the Before hook above; these never run).
Given("two houseguests of clearly different archetypes", function () { return "pending"; });
When("the engine composes each one's hidden secrets, true goals, and blind spot", function () { return "pending"; });
Then("the two profiles read in distinguishable voices, not identical templated tails", function () { return "pending"; });

// ── Rule: same archetype still differs ────────────────────────────────────────────────────────────

Given("two houseguests of one archetype across many generated casts", function (this: BbWorld) {
  const pairs: Array<[unknown, unknown]> = []; const casts: string[][] = [];
  for (let seed = 1; seed <= 12; seed++) {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed });
    const npcs = s.snapshot().house!.npcs;
    casts.push(npcs.map((n) => JSON.stringify(s.npcVoice(n.id)!.persona.voice)));
    const byArch = new Map<string, unknown[]>();
    for (const n of npcs) (byArch.get(n.character.archetype) ?? byArch.set(n.character.archetype, []).get(n.character.archetype)!).push(s.npcVoice(n.id)!.persona.voice);
    for (const g of byArch.values()) for (let i = 1; i < g.length; i++) pairs.push([g[0], g[i]]);
  }
  assert.ok(pairs.length >= 5, `only ${pairs.length} same-archetype pairs across the casts`);
  vs(this).vPairs = pairs; vs(this).vCasts = casts;
});

Then("their voice fingerprints differ on at least their free dials, signature, or lexicon", function (this: BbWorld) {
  for (const [a, b] of vs(this).vPairs!) assert.notEqual(JSON.stringify(a), JSON.stringify(b), "two houseguests of one archetype share one voice");
});

Then("no two houseguests in any of those casts share an identical voice fingerprint", function (this: BbWorld) {
  for (const cast of vs(this).vCasts!) assert.equal(new Set(cast).size, cast.length, "a cast holds two identical voice fingerprints");
});

// ── Rule: voice is identity ───────────────────────────────────────────────────────────────────────

Given("the cast's generated voice fingerprints", function (this: BbWorld) {
  const sb = vs(this).vSb!;
  vs(this).vProbe = castVoices(sb);
});

When("the game in progress is saved and restored", function (this: BbWorld) {
  const sb = vs(this).vSb!;
  drive(sb, 40); // a game in progress, not a fresh cast
  vs(this).vProbe = castVoices(sb);
  const saved = JSON.parse(JSON.stringify(saves.get(sb)!())); // the full save round-trips through serialisation
  const revived = new GameSessionRegistry();
  vs(this).vSb = revived.restore(`orw0090-restored-${++users}`, saved);
});

Then("every houseguest's voice fingerprint is byte-identical", function (this: BbWorld) {
  assert.equal(castVoices(vs(this).vSb!), vs(this).vProbe);
});

Given("a season whose houseguests' souls change over many beats", function (this: BbWorld) {
  const sb = vs(this).vSb!;
  const ids = npcIds(sb);
  const soul = (id: EntityId): number => sb.session.snapshot().house!.npcs.find((n) => n.id === id)!.soul.emotionalState;
  vs(this).vBefore = new Map(ids.map((id) => [id, voiceOf(sb, id)]));
  vs(this).vMoodBefore = new Map(ids.map((id) => [id, sb.session.npcVoice(id)!.mood ?? ""]));
  vs(this).vSoulBefore = new Map(ids.map((id) => [id, soul(id)]));
  drive(sb, 120);
  const moved = ids.filter((id) => soul(id) !== vs(this).vSoulBefore!.get(id));
  assert.ok(moved.length > 0, "no houseguest's soul changed over the beats (the scenario would prove nothing)");
});

Then("every houseguest's voice fingerprint stays byte-identical across those beats", function (this: BbWorld) {
  const sb = vs(this).vSb!;
  for (const [id, before] of vs(this).vBefore!) assert.equal(voiceOf(sb, id), before, `${id}'s voice drifted`);
});

Then("only the observable delivery carriage moves with their mood", function (this: BbWorld) {
  const sb = vs(this).vSb!;
  const changed = [...vs(this).vMoodBefore!].filter(([id, m]) => (sb.session.npcVoice(id)?.mood ?? "") !== m);
  assert.ok(changed.length > 0, "no houseguest's mood word moved");
  for (const [id] of changed) assert.ok(!/[0-9]/.test(sb.session.npcVoice(id)!.mood ?? ""), "the mood carriage is a word, never a number");
});

// ── Rule: Vault-safe ──────────────────────────────────────────────────────────────────────────────

const VSENT = "SENTINEL-0090-VOICE";
const RELVAL = 0.123457;

Given("houseguests with sealed secrets and hidden relationship reads", function (this: BbWorld) {
  const sb = sandbox(31);
  const twin = sandbox(31);
  const core = sb.session.snapshot();
  for (const n of core.house!.npcs) {
    n.character.hiddenElements.push({ kind: "secret-motive", detail: `${VSENT}-${n.id}` });
    n.soul.memory.push(`${VSENT}-soul`);
    n.soul.emotionalState = 0.0123; n.soul.volatility = 0.987;
  }
  sb.session.restore(core);
  const rel = (sb.session as unknown as { rel: RelationshipModel }).rel;
  for (const id of npcIds(sb)) for (const [a, b] of [[id, PLAYER], [PLAYER, id]] as const) { const e = rel.edge(a, b); e.trust = RELVAL; e.affinity = RELVAL; e.threat = RELVAL; }
  // The sweep bites: the planted hidden state is really in the engine.
  assert.ok(JSON.stringify(sb.session.snapshot()).includes(VSENT));
  vs(this).vSb = sb;
  vs(this).vTwinVoices = castVoices(twin);
});

When("the voice projection and the player-visible voice clause are read", function (this: BbWorld) {
  vs(this).vProbe = castVoices(vs(this).vSb!);
});

Then("they contain no sealed secret, no soul number, and no relationship value", function (this: BbWorld) {
  const out = vs(this).vProbe!;
  assert.ok(!out.includes(VSENT), "a sealed secret reached the voice");
  // The roster's dial clause is built from the closed dial vocabulary only: no digit can appear there. (The full fingerprint's
  // free-text lexicon may legitimately hold a public filler like "100%", so it is checked for the planted values instead.)
  const clauses = JSON.parse(out)[1] as Array<string | null>;
  for (const c of clauses) assert.ok(c && !/[0-9]/.test(c), `a number reached the player-visible voice clause: ${c}`);
  assert.ok(!out.includes(String(RELVAL)) && !out.includes("0.0123") && !out.includes("0.987"));
});

Then("the voice is generated only from public facets, never the hidden profile", function (this: BbWorld) {
  // The same seeded cast WITHOUT the hidden plants voices identically: the voice is not a function of any hidden state.
  assert.equal(vs(this).vProbe, vs(this).vTwinVoices);
});

Given("confessors record confessionals voiced in their own voices", function (this: BbWorld) {
  vs(this).vVoiced = [5, 9].map((seed) => drive(sandbox(seed)));
  vs(this).vBare = [5, 9].map((seed) => drive(sandbox(seed, { stripVoices: true })));
  for (const l of vs(this).vVoiced!) assert.ok(l.confessionals.length > 0, "no confessional was recorded");
});

Then("each confessional is witnessed by its confessor alone and never reaches the player in play", function (this: BbWorld) {
  for (const l of vs(this).vVoiced!) {
    const surfaces = livePlayerSurfaces(l.sb);
    for (const c of l.confessionals) {
      assert.deepEqual(c.witnessSet, [c.initiator], "a confessional has a witness besides its confessor");
      assert.notEqual(c.initiator, PLAYER);
      assert.equal(c.hidden, true);
      assert.ok(!surfaces.includes(c.content), "a confessional reached a player surface");
    }
  }
});

Then("only its phrasing changed, not its witness set or its hidden flag", function (this: BbWorld) {
  const shape = (l: Live) => l.confessionals.map((c) => [c.initiator, c.witnessSet, c.hidden]);
  let rephrased = 0;
  vs(this).vVoiced!.forEach((l, i) => {
    const bare = vs(this).vBare![i]!;
    assert.deepEqual(shape(l), shape(bare), "voicing changed which confessionals exist, who witnessed them, or their hidden flag");
    rephrased += l.confessionals.filter((c, j) => c.content !== bare.confessionals[j]!.content).length;
  });
  assert.ok(rephrased > 0, "no confessional's phrasing changed with the voice (the voice never reached the prose)");
});

// ── Rule: phrasing, never facts; deterministic ────────────────────────────────────────────────────

Given("a confessor with a fixed engine-grounded target and ally", function (this: BbWorld) {
  vs(this).vTwoVoice = [];
});

When("the confessional is voiced under two different voice fingerprints", function (this: BbWorld) {
  const archetypes = ["comp-beast", "social-butterfly", "mastermind", "floater", "villain", "underdog", "flirt", "loyalist"];
  vs(this).vTwoVoice = SEEDS.map((seed) => {
    const rel = grounded();
    const relBefore = JSON.stringify(rel.serialize());
    const va = generateVoice(new SeededRandom(seed), archetypes[seed % archetypes.length]!);
    const vb = generateVoice(new SeededRandom(seed + 77), archetypes[(seed + 3) % archetypes.length]!);
    const a = confessionalFor(npc(1), OTHERS, rel, { rng: new SeededRandom(seed), voice: va });
    const b = confessionalFor(npc(1), OTHERS, rel, { rng: new SeededRandom(seed), voice: vb });
    return { a, b, relBefore, relAfter: JSON.stringify(rel.serialize()) };
  });
  assert.ok(vs(this).vTwoVoice!.some((r) => r.a.content !== r.b.content), "the two voicings never differed in phrasing");
});

Then("both versions name the same target and the same ally", function (this: BbWorld) {
  for (const r of vs(this).vTwoVoice!) {
    assert.equal(r.a.target, r.b.target); assert.equal(r.a.ally, r.b.ally);
    assert.equal(r.a.target, npc(2)); assert.equal(r.a.ally, npc(3));
  }
});

Then("no closed-set value is moved by the change in phrasing", function (this: BbWorld) {
  for (const r of vs(this).vTwoVoice!) {
    assert.equal(r.relAfter, r.relBefore, "voicing a confessional moved a relationship value");
    const { content: _a, ...restA } = r.a; const { content: _b, ...restB } = r.b;
    assert.deepEqual(restA, restB, "voicing changed a structured confessional field");
  }
});

Given("two casts generated from the same seed", function (this: BbWorld) {
  vs(this).vVoiced = [13, 21].map((seed) => drive(sandbox(seed)));
  vs(this).vSecond = [13, 21].map((seed) => drive(sandbox(seed)));
});

Then("every houseguest's voice fingerprint matches across the two casts", function (this: BbWorld) {
  vs(this).vVoiced!.forEach((l, i) => assert.equal(castVoices(l.sb), castVoices(vs(this).vSecond![i]!.sb)));
});

Then("their voiced confessional phrasing matches across the two casts", function (this: BbWorld) {
  vs(this).vVoiced!.forEach((l, i) => {
    assert.ok(l.confessionals.length > 0, "no confessional was recorded");
    assert.deepEqual(l.confessionals.map((c) => c.content), vs(this).vSecond![i]!.confessionals.map((c) => c.content));
  });
});

Given("the same seeded seasons with and without the houseguests' voice fingerprints", function (this: BbWorld) {
  vs(this).vVoiced = [5, 9].map((seed) => drive(sandbox(seed)));
  vs(this).vBare = [5, 9].map((seed) => drive(sandbox(seed, { stripVoices: true })));
});

Then("the engine-authored confessional prose without voices falls back to its templated phrasing", function (this: BbWorld) {
  for (const l of vs(this).vBare!) {
    assert.ok(l.confessionals.length > 0);
    for (const c of l.confessionals) assert.match(c.content, TEMPLATED, `an un-voiced confessional left the templated phrasing: ${c.content}`);
  }
  const voicedOff = vs(this).vVoiced!.flatMap((l) => l.confessionals).filter((c) => !TEMPLATED.test(c.content)).length;
  assert.ok(voicedOff > 0, "with voices on, every confessional was still templated (the comparison proves nothing)");
});

Then("the seeded competition and jury outcome is unchanged", function (this: BbWorld) {
  for (const seed of [5, 9]) {
    const on = playSeasonOutcome(sandbox(seed).session);
    const off = playSeasonOutcome(sandbox(seed, { stripVoices: true }).session);
    assert.deepEqual(off, on, `seed ${seed}: removing the voices moved a competition, eviction or jury outcome`);
  }
});
