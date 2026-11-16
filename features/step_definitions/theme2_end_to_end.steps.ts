import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import type { HouseMeeting } from "../../src/engine/houseMeeting";
import type { ClaimLog, SpokenClaim } from "../../src/engine/spokenClaims";

/**
 * Feature 0158 - theme 2 end to end (slice 9, ORW-330). ONE seeded game through the REAL adapter (registry sandbox), driving the same engine hooks the per-slice features drive:
 * `tellClaim` (0149), the moment prompt + `tellsYou` (0151), `resolvePlayerMove` (0152), `evictionCountPublic` (0154), `holdHouseMeeting` (0156). TEST-ONLY seams, as in those features:
 * the live season (engine-only claims, beliefs), the relationship model, the presence map. Roles only: the player, a liar, a houseguest (the one lied to), a third, a bystander.
 */
type Live = { week: number; playedGame?: boolean; claims?: ClaimLog; beliefs?: Record<string, BeliefClaim[]>; houseMeetings?: HouseMeeting[] };
type Bag = { sb: UserSandbox; s: GameSessionAdapter; npcs: string[]; liar: string; hg: string; third: string; fourth: string; fifth: string; targets?: SpokenClaim; keep?: SpokenClaim; views: string[]; tells: Array<Record<string, unknown>>; mtg?: HouseMeeting; believer?: string; doubter?: string };
const bag = (w: unknown): Bag => (w as { t2e2e?: Bag }).t2e2e!;
const live = (s: GameSessionAdapter) => (s as unknown as { live: Live }).live;
const rel = (s: GameSessionAdapter) => (s as unknown as { rel: { edge(a: string, b: string): { trust: number; affinity: number } } }).rel;
const presence = (s: GameSessionAdapter) => (s as unknown as { presence: Map<string, string> }).presence;
const known = (s: GameSessionAdapter) => ((s as unknown as { playerKnowledgeReader?: () => Array<{ content: string; pathway?: string }> }).playerKnowledgeReader?.() ?? []);
const nameOf = (s: GameSessionAdapter, id: string) => (s as unknown as { nameOf(id: string): string }).nameOf(id);
const held = (b: Bag, holder: string) => live(b.s).beliefs?.[holder] ?? [];
const planted = (b: Bag, holder: string, c: SpokenClaim) => held(b, holder).find((x) => x.id.endsWith(`|${c.id}`));
let n = 0;

/** Every narrator-side read the player channel has, taken now and kept: the Vault Wall check at the end reads them all. */
async function look(b: Bag): Promise<void> {
  b.views.push(JSON.stringify(b.s.getMomentPrompt({})), JSON.stringify(b.s.getGameState()), JSON.stringify(b.s.claimsThePlayerHeard()));
  b.views.push(JSON.stringify(await b.sb.mcp.player.callTool("getMomentPrompt", {})), JSON.stringify(await b.sb.mcp.player.callTool("getGameState", {})));
}

Given("one seeded season with claims, who-told-you, caught lies and house meetings all on", function () {
  const sb = new GameSessionRegistry().sandboxFor(`t2e2e-${n++}`);
  const s = sb.session;
  s.setNpcBeliefsEnabled(true); s.setClaimsToPlayerEnabled(true); s.setLiesCaughtEnabled(true); s.setHouseMeetingsEnabled(true);
  s.createCharacter({ playerName: "The Player", seed: 7 });
  live(s).playedGame = true;
  const npcs = s.livingIds().filter((id) => id !== PLAYER);
  assert.ok(npcs.length >= 6, "too few houseguests");
  const [liar, hg, third, fourth, fifth] = npcs as [string, string, string, string, string];
  (this as { t2e2e?: Bag }).t2e2e = { sb, s, npcs, liar, hg, third, fourth, fifth, views: [], tells: [] };
});

// ---- stage 1: a lie is told and believed (0149) ----

When("a liar tells a houseguest a lie about a third houseguest, and swears they voted to keep the houseguest", function () {
  const b = bag(this);
  rel(b.s).edge(b.hg, b.liar).trust = 0.9;            // the houseguest believes this liar
  b.targets = b.s.tellClaim({ speaker: b.liar, listener: b.hg, kind: "targets-you", subject: b.third, isTrue: false, intent: "mislead" });
  b.keep = b.s.tellClaim({ speaker: b.liar, listener: b.hg, kind: "voted-to-keep", subject: b.fourth, object: b.hg, isTrue: false, intent: "mislead" });
  assert.ok(b.targets && b.keep, "the engine refused a valid claim");
});
Then("the houseguest holds both as beliefs that can still be refuted", function () {
  const b = bag(this);
  for (const c of [b.targets!, b.keep!]) {
    const p = planted(b, b.hg, c);
    assert.ok(p, "the claim planted no belief");
    assert.equal(p.source, b.liar);
    assert.ok(!p.refuted, "the belief starts refuted");
  }
  assert.ok(!held(b, b.third).length, "a bystander who heard nothing holds a belief");
});

// ---- stage 2: a trusting houseguest confides in the player (0151) ----

When("the houseguest trusts the player and is with them, alongside another houseguest who does not", function () {
  const b = bag(this);
  rel(b.s).edge(b.hg, b.liar).affinity = 0; rel(b.s).edge(b.hg, b.liar).trust = 0; // after the lie, the houseguest no longer warms to the liar
  for (let i = 0; i < 300 && (!b.tells.some((t) => !("stranger" in t)) || i < 80); i++) {   // keep playing past the first confidence: the distrusting bystander gets its chances too
    b.s.noteMessage({ messageId: `t2e2e-${n}-${i}` });
    const here = presence(b.s).get(PLAYER)!;
    for (const id of b.npcs) presence(b.s).set(id, id === b.hg || id === b.fifth ? here : "storage-room");
    rel(b.s).edge(b.hg, PLAYER).trust = 0.95;
    rel(b.s).edge(b.fifth, PLAYER).trust = 0.2;          // the bystander in the room holds a belief too, but does not trust the player
    (live(b.s).beliefs ??= {})[b.fifth] = [{ id: `${b.fifth}|targets-me|${b.third}|seed`, holder: b.fifth, kind: "targets-me", subject: b.third, object: b.fifth, value: true, origin: "told", source: b.fourth, confidence: 0.8, week: live(b.s).week }];
    b.views.push(JSON.stringify(b.s.getMomentPrompt({})));
    const pk = (b.s as unknown as { presentKnowledgeForPrompt(): Array<{ id: string; tellsYou?: Record<string, unknown> }> }).presentKnowledgeForPrompt();
    for (const e of pk) if (e.tellsYou) { if (e.id === b.hg) b.tells.push(e.tellsYou); else b.tells.push({ stranger: e.id }); }
  }
});
Then("the narrator is handed what the trusting houseguest believes, with its certainty and nothing about whether it is true, and the other houseguest tells nothing", function () {
  const b = bag(this);
  assert.ok(b.tells.length >= 1, "a trusted houseguest alone with the player never confided");
  assert.ok(!b.tells.some((t) => "stranger" in t), "a houseguest who does not trust the player confided in them");
  const t = b.tells[0]!;
  assert.deepEqual(Object.keys(t).sort(), ["certainty", "kind", "object", "subject"]);
  assert.equal(t.kind, "going-after");
  assert.equal(t.subject, nameOf(b.s, b.third));
  const told = (live(b.s).claims?.items ?? []).filter((c) => c.speaker === b.hg && c.listener === PLAYER);
  assert.equal(told.length, 1, "the belief was not recorded as one claim the player heard");
  assert.ok(b.views.join("\n").includes("tellsYou"), "the prompt never carried the claim");
});

// ---- stage 3: who told you that? (0152) ----

When("the player asks the houseguest who told them", function () {
  const b = bag(this);
  b.s.resolvePlayerMove({ text: "Who told you that?" });
});
Then("the houseguest names the liar, and the player learns it as something the houseguest said", async function () {
  const b = bag(this);
  const note = (b.s as unknown as { claimSourceNote: string | null }).claimSourceNote ?? "";
  assert.ok(note.includes(`names ${nameOf(b.s, b.liar)}`), `the houseguest did not name the liar: ${note}`);
  assert.ok(!/true|false|lie|lied|mislead|intent|claim:/i.test(note), `the source note leaks the truth: ${note}`);
  const fact = known(b.s).find((k) => k.pathway === `told-by:${b.hg}`);
  assert.ok(fact, "the player was given no told-by fact");
  assert.ok(fact.content.includes(nameOf(b.s, b.liar)) && fact.content.includes("told them that"), fact.content);
  await look(b);
});

// ---- stage 4: the public count catches the lie (0154) ----

When("the public count shows every voter wanted the houseguest out", function () {
  const b = bag(this);
  const voters = [b.fourth, b.fifth, b.liar];
  b.s.evictionCountPublic({ evictee: b.hg, evictVotes: voters.length, voters });
});
Then("the vote claim is refuted, the houseguest believes the liar lied to them, and the liar's word counts for less with them", async function () {
  const b = bag(this);
  assert.equal(planted(b, b.hg, b.keep!)!.refuted, true, "the impossible vote claim was not refuted");
  assert.equal(held(b, b.hg).filter((c) => c.kind === "lied-to-me" && c.subject === b.liar && !c.refuted).length, 1, "the houseguest does not believe they were lied to");
  assert.ok(b.s.credibilityOf(b.hg, b.liar) < 1, "the liar's credibility did not drop");
  assert.equal(b.s.credibilityOf(b.third, b.liar), 1, "a houseguest who caught nothing lost trust too");
  await look(b);
});

// ---- stage 5: the house meeting (0156) ----

When("the houseguest calls the house together and accuses the liar of lying", function () {
  const b = bag(this);
  const [believer, doubter] = b.npcs.filter((id) => ![b.liar, b.hg].includes(id)).slice(0, 2) as [string, string];
  Object.assign(b, { believer, doubter });
  rel(b.s).edge(believer, b.hg).trust = 0.95; rel(b.s).edge(believer, b.liar).trust = 0.05;   // one listener trusts the accuser, one the accused
  rel(b.s).edge(doubter, b.hg).trust = 0.05; rel(b.s).edge(doubter, b.liar).trust = 0.95;
  for (const id of b.npcs) presence(b.s).set(id, presence(b.s).get(PLAYER)!); // the whole house is in the room, the player awake among them
  b.mtg = b.s.holdHouseMeeting({ caller: b.hg, accused: b.liar, claim: { kind: "lying-about", subject: b.liar } });
  assert.ok(b.mtg, "the engine refused a valid house meeting");
});
Then("the narrator gets the meeting as the speakers' words, and every listener's belief about the accusation is updated", async function () {
  const b = bag(this);
  const m = b.mtg!;
  const line = b.s.getMomentPrompt({}).systemPrompt.split("\n").find((l) => l.includes("HOUSE MEETING"));
  assert.ok(line, "the narrator got no house meeting line");
  const heard = (b.s as unknown as { houseMeetingThePlayerHeard(): Record<string, unknown> | undefined }).houseMeetingThePlayerHeard();
  assert.deepEqual(Object.keys(heard ?? {}).sort(), ["accused", "answer", "caller", "claim", ...(heard && "redirectTo" in heard ? ["redirectTo"] : [])].sort(), "the heard meeting carries only caller, accused, claim, answer and redirectTo");
  assert.ok(line.includes(nameOf(b.s, b.hg)) && line.includes(nameOf(b.s, b.liar)) && /denies it|admits it|turns it back/.test(line), line);
  const listeners = m.attendees.filter((id) => id !== PLAYER && id !== m.caller && id !== m.accused);
  assert.ok(listeners.length >= 4, "the house was not gathered");
  for (const l of listeners) assert.ok(held(b, l).some((c) => m.claimIds.some((id) => c.id.endsWith(`|${id}`))), `${l} holds no belief from the accusation`);
  // each listener settles from how much they trust each side: the believer comes out holding the accusation, the doubter doubting it (an admission confirms everyone)
  const mine = (id: string) => held(b, id).find((c) => m.claimIds.some((x) => c.id.endsWith(`|${x}`)))!;
  assert.ok(!mine(b.believer!).refuted && mine(b.believer!).confidence >= 0.5, "the listener who trusts the accuser does not hold the accusation");
  if (m.answer === "admit") assert.ok(!mine(b.doubter!).refuted, "an admission left a listener doubting");
  else assert.equal(mine(b.doubter!).refuted, true, "the listener who trusts the accused does not doubt the accusation");
  await look(b);
});

// ---- the Vault Wall, across every step ----

Then("at every step no narrator view carried a truth, an intent, a claim id or a ballot, and the player heard only what was told to them", function () {
  const b = bag(this);
  const shown = b.views.join("\n");
  assert.ok(b.views.length >= 10, "too few views were taken to mean anything");
  for (const [re, what] of [[/isTrue/, "a truth"], [/"intent"/, "an intent"], [/claim:\d/, "a claim id"], [/meeting:\d/, "a meeting id"], [/lied-to-me/, "a lied-to-me belief"], [/voteRecord|voteOf|"ballot/i, "a ballot"], [/mislead/, "a lie's purpose"]] as const) {
    assert.doesNotMatch(shown, re, `a narrator view carried ${what}`);
  }
  const log = live(b.s).claims?.items ?? [];
  const heard = b.s.claimsThePlayerHeard();
  assert.equal(heard.length, log.filter((c) => c.listener === PLAYER).length, "the player heard a different number of claims than were told to them");
  assert.ok(!heard.some((h) => h.kind === "voted-to-keep"), "the player was handed a vote claim told to someone else");
  for (const h of heard) assert.deepEqual(Object.keys(h).sort().filter((k) => !["day", "object"].includes(k)), ["kind", "speaker", "subject", "week"], "a heard claim carries extra fields");
  assert.ok(!heard.some((h) => h.speaker === b.liar && h.subject === b.third), "the liar's private lie to the houseguest reached the player's heard list");
});
