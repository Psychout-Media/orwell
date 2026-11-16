import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { recordClaim, type BeliefClaim } from "../../src/engine/beliefStore";
import { decideSourceAnswer, protectChance } from "../../src/engine/claimSource";
import type { ClaimLog } from "../../src/engine/spokenClaims";

/**
 * Feature 0152 - "who told you that?" (theme 2 slice 4b, ORW-330). Drives the REAL adapter through a per-user registry sandbox. The claims are made
 * with `tellClaim` (the core, slice 1) and by seeding the speaker's belief store with a recorded source; the player's words go through
 * `resolvePlayerMove`, the pre-narration seam. TEST-ONLY seams: the live season (engine-only claims and beliefs), the relationship model and the
 * presence map (to put the speaker in the player's room). Roles only: the player, a speaker (the NPC who told the player), a source, a bystander.
 */

type Live = { claims?: ClaimLog; beliefs?: Record<string, BeliefClaim[]> };
type Bag = { sb?: UserSandbox; s?: GameSessionAdapter; npcs?: string[]; holder?: string; source?: string; first?: string; before?: string };
const bag = (w: unknown): Bag => ((w as { who0152?: Bag }).who0152 ??= {});
const sess = (w: unknown) => bag(w).s!;
const live = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const rel = (s: GameSessionAdapter) => (s as unknown as { rel: { edge(a: string, b: string): { trust: number; affinity: number } } }).rel;
const presence = (s: GameSessionAdapter) => (s as unknown as { presence: Map<string, string> }).presence;
const noteOf = (s: GameSessionAdapter) => (s as unknown as { claimSourceNote: string | null }).claimSourceNote;
const known = (s: GameSessionAdapter) => ((s as unknown as { playerKnowledgeReader?: () => Array<{ content: string; pathway?: string }> }).playerKnowledgeReader?.() ?? []);
const nameOf = (s: GameSessionAdapter, id: string) => (s as unknown as { nameOf(id: string): string }).nameOf(id);
const ASK = "Who told you that?";
let n = 0;

function ask(w: unknown, text = ASK): string | null {
  sess(w).resolvePlayerMove({ text });
  return noteOf(sess(w));
}
/** The belief a speaker holds, recorded the way slice 1 writes it: from a second houseguest, a told belief with that source. */
function seed(s: GameSessionAdapter, holder: string, source: string | undefined, subject: string, origin: BeliefClaim["origin"] = "told") {
  recordClaim((live(s).beliefs ??= {}), {
    holder, kind: "targets-me", subject, object: holder, value: true, origin, ...(source ? { source } : {}), confidence: 0.7, week: 1,
  });
}

Given("a started season with who-told-you on", function () {
  const sb = new GameSessionRegistry().sandboxFor(`who0152-${n++}`);
  sb.session.setNpcBeliefsEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed: 7 });
  const b = bag(this);
  b.sb = sb; b.s = sb.session;
  b.npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
  assert.ok(b.npcs.length >= 4, "too few houseguests");
});

/** Put `holder` in the player's room, awake, having told the player a claim; returns whether the engine took it. */
function holderTellsPlayer(w: unknown, holder: string, subject: string): boolean {
  const s = sess(w);
  const here = presence(s).get(PLAYER)!;
  presence(s).set(holder, here);
  const told = s.tellClaim({ speaker: holder, listener: PLAYER, kind: "targets-you", subject, isTrue: false, intent: "mislead" });
  return told !== undefined && s.awakeAmong([holder]).includes(holder);
}

// ---- Scenario 1 ----

Given("an NPC told the player a claim they heard from a second NPC", function () {
  const [a, b, c, d] = bag(this).npcs!;
  const s = sess(this);
  assert.ok(s.tellClaim({ speaker: b!, listener: a!, kind: "targets-you", subject: c!, isTrue: true, intent: "warn" }), "the second NPC told the first");
  bag(this).holder = a; bag(this).source = b; bag(this).first = c;
  assert.ok(holderTellsPlayer(this, a!, c!), `the NPC is in the room and awake (${d})`);
});

When("the player asks who told them", function () {
  bag(this).before = ask(this) ?? "";
});

Then("the engine decides whether the NPC names the second NPC or protects them", function () {
  const s = sess(this);
  const note = bag(this).before!;
  const name = nameOf(s, bag(this).source!);
  assert.ok(note, "the engine handed the narrator no answer");
  const names = note.includes(`names ${name}`);
  const protects = note.includes("will not say who");
  assert.ok(names !== protects, `exactly one of name / protect: ${note}`);
  assert.ok(!note.includes("saw it themself"), "the NPC did not witness it");
});

Then("the same inputs always give the same answer", function () {
  const again = ask(this);
  assert.equal(again, bag(this).before, "asking again gave a different answer");
  const i = { seed: 7, holder: "h", claimId: "claim:1", origin: "told" as const, source: "s", sourceAffinity: 0.5, sourceTrust: 0.5, playerTrust: 0.5 };
  assert.equal(decideSourceAnswer(i), decideSourceAnswer({ ...i }));
});

Then("a houseguest fond of the source and unsure of the player protects them more often than one who dislikes the source", function () {
  const base = { seed: 7, holder: "h", origin: "told" as const, source: "s" };
  let fond = 0; let cold = 0;
  for (let k = 0; k < 400; k++) {
    if (decideSourceAnswer({ ...base, claimId: `claim:${k}`, sourceAffinity: 0.9, sourceTrust: 0.9, playerTrust: 0.2 }) === "protect") fond++;
    if (decideSourceAnswer({ ...base, claimId: `claim:${k}`, sourceAffinity: 0.1, sourceTrust: 0.1, playerTrust: 0.8 }) === "protect") cold++;
  }
  assert.ok(fond > cold + 60, `fond protects ${fond}/400, dislikes the source ${cold}/400`);
  assert.ok(fond < 400 && cold > 0 - 1, "never certain either way");
  assert.ok(protectChance({ sourceAffinity: 1, sourceTrust: 1, playerTrust: 0 }) < 1 && protectChance({ sourceAffinity: 0, sourceTrust: 0, playerTrust: 1 }) > 0);
});

// ---- Scenario 2 ----

Given("an NPC's recorded source for a claim is not who actually started it", function () {
  const s = sess(this);
  const [, , , , ...rest] = bag(this).npcs!;
  const ids = bag(this).npcs!;
  const starter = ids[0]!; const recorded = ids[1]!; const subject = ids[2]!;
  const candidates = [ids[3]!, ...rest];
  // the real starter lied to a bystander, not to the holder; the holder's belief carries a DIFFERENT recorded source
  s.tellClaim({ speaker: starter, listener: candidates[candidates.length - 1]!, kind: "targets-you", subject, isTrue: false, intent: "mislead" });
  let chosen: string | undefined;
  for (const holder of candidates) {
    rel(s).edge(holder, recorded).affinity = 0; rel(s).edge(holder, recorded).trust = 0; rel(s).edge(holder, PLAYER).trust = 1;
    seed(s, holder, recorded, subject);
    const told = s.tellClaim({ speaker: holder, listener: PLAYER, kind: "targets-you", subject, isTrue: false, intent: "mislead" });
    assert.ok(told);
    const would = decideSourceAnswer({ seed: 7, holder, claimId: told.id, origin: "told", source: recorded, sourceAffinity: 0, sourceTrust: 0, playerTrust: 1 });
    if (would === "name") { chosen = holder; break; }
  }
  assert.ok(chosen, "no houseguest names a disliked source at this seed");
  presence(s).set(chosen!, presence(s).get(PLAYER)!);
  assert.ok(s.awakeAmong([chosen!]).includes(chosen!), "awake");
  Object.assign(bag(this), { holder: chosen, source: recorded, first: starter });
});

Then("the NPC names the source they recorded, and the narrator is not told it is mistaken", function () {
  const s = sess(this);
  const note = ask(this) ?? "";
  assert.ok(note.includes(`names ${nameOf(s, bag(this).source!)}`), note);
  assert.ok(!note.includes(nameOf(s, bag(this).first!)), "the note named who really started it");
  assert.ok(!/mistak|wrong|false|lie|lied|untrue|isTrue|intent|mislead|claim:/i.test(note), `the note leaks the truth: ${note}`);
});

// ---- Scenario 3 ----

Given("an NPC tells the player something they witnessed themselves", function () {
  const [a, , c] = bag(this).npcs!;
  seed(sess(this), a!, undefined, c!, "witnessed");
  assert.ok(holderTellsPlayer(this, a!, c!), "the NPC is in the room and awake");
  Object.assign(bag(this), { holder: a, first: c });
});

Then("the NPC says they saw it, and names no one", function () {
  const s = sess(this);
  const note = bag(this).before!;
  assert.ok(note.includes("saw it themself"), note);
  for (const id of bag(this).npcs!) if (id !== bag(this).holder) assert.ok(!note.includes(nameOf(s, id)), `the note names ${id}`);
  assert.ok(!known(s).some((k) => k.pathway?.startsWith("told-by:") && /told them that/.test(k.content)), "a source was surfaced");
});

// ---- Scenario 4 ----

Given("the player asks who told an NPC something and the NPC names a source", function () {
  const s = sess(this);
  const ids = bag(this).npcs!;
  const recorded = ids[1]!; const subject = ids[2]!;
  let chosen: string | undefined;
  for (const holder of [ids[0]!, ...ids.slice(3)]) {
    rel(s).edge(holder, recorded).affinity = 0; rel(s).edge(holder, recorded).trust = 0; rel(s).edge(holder, PLAYER).trust = 1;
    assert.ok(s.tellClaim({ speaker: recorded, listener: holder, kind: "targets-you", subject, isTrue: true, intent: "warn" }));
    rel(s).edge(holder, recorded).affinity = 0; rel(s).edge(holder, recorded).trust = 0;
    const told = s.tellClaim({ speaker: holder, listener: PLAYER, kind: "targets-you", subject, isTrue: true, intent: "warn" });
    assert.ok(told);
    if (decideSourceAnswer({ seed: 7, holder, claimId: told.id, origin: "told", source: recorded, sourceAffinity: 0, sourceTrust: 0, playerTrust: 1 }) === "name") { chosen = holder; break; }
  }
  assert.ok(chosen, "no houseguest names a disliked source at this seed");
  presence(s).set(chosen!, presence(s).get(PLAYER)!);
  Object.assign(bag(this), { holder: chosen, source: recorded, first: subject });
  bag(this).before = JSON.stringify({ b: live(s).beliefs, c: live(s).claims, e: [chosen, recorded, PLAYER].map((x) => [rel(s).edge(chosen!, x).trust, rel(s).edge(chosen!, x).affinity]) });
  assert.ok((ask(this) ?? "").includes("names "), "the NPC names a source");
});

Then("the player now knows that source told the NPC, as something the NPC said", function () {
  const s = sess(this);
  const holder = bag(this).holder!;
  const fact = known(s).find((k) => k.pathway === `told-by:${holder}`);
  assert.ok(fact, "the player was given no told-by fact");
  assert.ok(fact.content.includes(nameOf(s, bag(this).source!)) && fact.content.includes(nameOf(s, holder)) && fact.content.includes("told them that"), fact.content);
  ask(this); // asking again adds nothing
  assert.equal(known(s).filter((k) => k.pathway === `told-by:${holder}`).length, 1, "asking twice duplicated the knowledge");
});

Then("no houseguest's belief about the player's own claims changes because of the asking", function () {
  const s = sess(this);
  const [holder, source] = [bag(this).holder!, bag(this).source!];
  const after = JSON.stringify({ b: live(s).beliefs, c: live(s).claims, e: [holder, source, PLAYER].map((x) => [rel(s).edge(holder, x).trust, rel(s).edge(holder, x).affinity]) });
  assert.equal(after, bag(this).before, "asking moved a belief, a claim or an edge");
});
