import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import { voteChoice } from "../../src/engine/liveSeason";

/**
 * Feature 0180 part 1 - house norms (Theme 3 slice 12). Drives the REAL adapter through a registry sandbox: the observer's beliefs are the live belief store,
 * the shunning is the adapter's own overnight fold, and the read is the live relationship model. TEST-ONLY seams: the live season (beliefs, played flag), the
 * relationship model read, the overnight fold, and (for the culture scenario only) the culture dials. Roles only: an observer, a houseguest, the player.
 */
type Edge = { trust: number; affinity: number };
type Seam = {
  live: { playedGame?: boolean; week: number; beliefs?: Record<string, BeliefClaim[]> };
  rel: { edge(a: string, b: string): Edge };
  foldNormsOvernight(): void;
  cultureMult(d: string): number;
};
type Bag = { sb?: UserSandbox; observer?: string; subject?: string; before?: Edge; houses?: Array<{ sb: UserSandbox; observer: string; subject: string; before: Edge }> };
const bag = (w: unknown): Bag => ((w as { norms0180?: Bag }).norms0180 ??= {});
const seam = (sb: UserSandbox) => sb.session as unknown as Seam;
let n = 0;

function played(): UserSandbox {
  const sb = new GameSessionRegistry().sandboxFor(`norms0180-${n++}`);
  sb.session.setHouseNormsEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed: 12 });
  seam(sb).live.playedGame = true;
  return sb;
}
const claim = (holder: string, kind: BeliefClaim["kind"], subject: string, object?: string): BeliefClaim =>
  ({ id: `${holder}|${kind}|${subject}|${object ?? ""}|1`, holder, kind, subject, ...(object ? { object, nature: "lying" } : {}), value: true, origin: "told", confidence: 0.8, week: 1 }) as BeliefClaim;

/** The observer holds that `subject` lied to `victims` (the observer themself counts as one, through lied-to-me). */
function holds(sb: UserSandbox, observer: string, subject: string, victims: number): void {
  const others = sb.session.livingIds().filter((id) => id !== observer && id !== subject && id !== PLAYER);
  const held = [claim(observer, "lied-to-me", subject), ...others.slice(0, victims - 1).map((v) => claim(observer, "heard-rumor", subject, v))];
  const live = seam(sb).live;
  live.beliefs = { ...(live.beliefs ?? {}), [observer]: [...(live.beliefs?.[observer] ?? []), ...held] };
}
function cast(w: unknown, subjectIsPlayer: boolean, victims: number): void {
  const b = bag(w);
  const npcs = b.sb!.session.livingIds().filter((id) => id !== PLAYER);
  b.observer = npcs[0]; b.subject = subjectIsPlayer ? PLAYER : npcs[1];
  holds(b.sb!, b.observer!, b.subject!, victims);
  b.before = { ...seam(b.sb!).rel.edge(b.observer!, b.subject!) };
}

Given("a played season with house norms on", function () { bag(this).sb = played(); });
Given("an observer who holds that a houseguest lied to two different people", function () { cast(this, false, 2); });
Given("an observer who holds that a houseguest lied to one person", function () { cast(this, false, 1); });
Given("an observer who holds that the player lied to two different people", function () { cast(this, true, 2); });
Given("a houseguest who lied to two people, with no one holding it", function () {
  const b = bag(this);
  b.subject = b.sb!.session.livingIds().filter((id) => id !== PLAYER)[1];
  b.before = { ...seam(b.sb!).rel.edge(b.sb!.session.livingIds().filter((id) => id !== PLAYER)[0]!, b.subject!) };
  // the truth of the lies lives only in the hidden record; no belief store entry names them
});

When("the night passes", function () { const s = seam(bag(this).sb!) as Seam & { foldDissentOvernight?: () => void }; s.foldNormsOvernight(); s.foldDissentOvernight?.(); });

Then("the observer's read of that houseguest cools", function () {
  const b = bag(this); const now = seam(b.sb!).rel.edge(b.observer!, b.subject!);
  assert.ok(now.affinity < b.before!.affinity && now.trust < b.before!.trust, `the read did not cool (${JSON.stringify(b.before)} -> ${JSON.stringify(now)})`);
  b.before = { ...now };
});
Then("the observer's read of the player cools", function () {
  const b = bag(this); const now = seam(b.sb!).rel.edge(b.observer!, PLAYER);
  assert.ok(now.affinity < b.before!.affinity && now.trust < b.before!.trust, "the house did not shun the player for broken words it knows of");
});
Then("the next night, with nothing new, it does not cool again", function () {
  const b = bag(this);
  seam(b.sb!).foldNormsOvernight();
  const now = seam(b.sb!).rel.edge(b.observer!, b.subject!);
  assert.equal(now.affinity, b.before!.affinity);
  assert.equal(now.trust, b.before!.trust);
});
Then("the observer's read of that houseguest is unchanged", function () {
  const b = bag(this); const now = seam(b.sb!).rel.edge(b.observer!, b.subject!);
  assert.equal(now.affinity, b.before!.affinity);
  assert.equal(now.trust, b.before!.trust);
});
Then("no one's read of that houseguest cools", function () {
  const b = bag(this);
  const applied = (seam(b.sb!).live as { normsApplied?: Record<string, number> }).normsApplied ?? {};
  assert.ok(!Object.keys(applied).some((k) => k.endsWith(`|${b.subject}`)), "someone shunned a houseguest for a lie nobody holds");
});

Given("an observer who holds that a houseguest lied to two different people, in an honest, loyal house and again in a house of liars", function () {
  const b = bag(this);
  b.houses = [[1.5, 0.5], [0.5, 1.5]].map(([loyalty, lying]) => {
    const sb = played();
    seam(sb).cultureMult = (d: string) => (d === "loyalty" ? loyalty! : d === "lying" ? lying! : 1); // TEST-ONLY seam: the culture dials
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    holds(sb, npcs[0]!, npcs[1]!, 2);
    return { sb, observer: npcs[0]!, subject: npcs[1]!, before: { ...seam(sb).rel.edge(npcs[0]!, npcs[1]!) } };
  });
});
When("the night passes in each house", function () { for (const h of bag(this).houses!) seam(h.sb).foldNormsOvernight(); });
Then("the honest house's observer cools more", function () {
  const [honest, liars] = bag(this).houses!.map((h) => h.before.affinity - seam(h.sb).rel.edge(h.observer, h.subject).affinity);
  assert.ok(honest! > liars!, `honest house cooled ${honest}, house of liars ${liars}`);
});

Then("no player or admin view carries a norm, a count of broken words or the shunning", async function () {
  const sb = bag(this).sb!;
  const out = JSON.stringify([
    await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
    await sb.mcp.admin.callTool("inspectNonVaultState", {}),
  ]);
  assert.ok(!/normsApplied|houseNorms|knownBreaches|shun/i.test(out), "the house norms reached a player or admin view");
});

// ---- Part 2: bandwagons and dissent ----
type VoteSeam = Seam & { ctx(): unknown; live: Seam["live"] & { voteRecord?: Array<{ week: number; evictee: string; voteOf: Record<string, string> }> }; foldDissentOvernight(): void };
type HerdBag = { voter?: string; fn?: [string, string]; dissenter?: string; holder?: string; before?: Edge };
const herd = (w: unknown): HerdBag => ((w as { herd0180?: HerdBag }).herd0180 ??= {});
const rumorOf = (holder: string, subject: string, object: string, nature: string, week: number): BeliefClaim =>
  ({ id: `${holder}|heard-rumor|${subject}|${object}|${week}|${nature}`, holder, kind: "heard-rumor", subject, object, nature, value: true, origin: "told", confidence: 0.7, week }) as BeliefClaim;

Given("a voter torn between two nominees", function () {
  const sb = bag(this).sb!; const h = herd(this);
  const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
  h.voter = npcs[0]; h.fn = [npcs[1]!, npcs[2]!];
  const r = seam(sb).rel as unknown as { edge(a: string, b: string): { trust: number; affinity: number; threat: number } };
  for (const [n, threat] of [[h.fn[0], 0.30], [h.fn[1], 0.33]] as const) Object.assign(r.edge(h.voter!, n), { trust: 0.5, affinity: 0.5, threat });
  for (const n of h.fn) Object.assign(r.edge(n, h.voter!), { trust: 0.5, affinity: 0.5, threat: 0.1 });
  const s = seam(sb) as unknown as VoteSeam;
  assert.equal(voteChoice(h.voter!, h.fn, s.ctx() as never), h.fn[1], "the setup is not a close call leaning to the second nominee");
});
When("they have heard that most of the house is going after one of them", function () {
  const sb = bag(this).sb!; const h = herd(this); const live = seam(sb).live;
  const others = sb.session.livingIds().filter((id) => id !== PLAYER && id !== h.voter && !h.fn!.includes(id)).slice(0, 3);
  live.beliefs = { ...(live.beliefs ?? {}), [h.voter!]: others.map((o) => rumorOf(h.voter!, o, h.fn![0], "going-after", live.week)) };
});
Then("they vote with the house", function () {
  const sb = bag(this).sb!; const h = herd(this);
  assert.equal(voteChoice(h.voter!, h.fn!, (seam(sb) as unknown as VoteSeam).ctx() as never), h.fn![0], "the waverer did not join the house");
});
Then("a voter with a strong reason of their own keeps it", function () {
  const sb = bag(this).sb!; const h = herd(this);
  const r = seam(sb).rel as unknown as { edge(a: string, b: string): { threat: number } };
  r.edge(h.voter!, h.fn![1]).threat = 0.95;
  assert.equal(voteChoice(h.voter!, h.fn!, (seam(sb) as unknown as VoteSeam).ctx() as never), h.fn![1], "the herd overturned a strong reason");
});

function lopsided(w: unknown, playerDissents: boolean): void {
  const sb = bag(w).sb!; const h = herd(w); const s = seam(sb) as unknown as VoteSeam;
  const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
  const [holder, survivor, a, b, c, other] = npcs;
  const evictee = "npc:gone";
  h.holder = holder; h.dissenter = playerDissents ? PLAYER : other;
  s.live.voteRecord = [{ week: s.live.week, evictee, voteOf: { [holder!]: evictee, [a!]: evictee, [b!]: evictee, [c!]: evictee, [h.dissenter!]: survivor! } }];
  s.live.beliefs = { ...(s.live.beliefs ?? {}), [holder!]: [rumorOf(holder!, h.dissenter!, evictee, "voted-to-keep", s.live.week)] };
  h.before = { ...s.rel.edge(holder!, h.dissenter!) };
}
Given("a lopsided eviction where one houseguest voted the other way, and a majority voter heard about it", function () { lopsided(this, false); });
Given("a lopsided eviction where the player voted the other way, and a majority voter heard about it", function () { lopsided(this, true); });
Then("the majority voter's read of the dissenter cools, once", function () {
  const sb = bag(this).sb!; const h = herd(this); const s = seam(sb) as unknown as VoteSeam;
  const after = { ...s.rel.edge(h.holder!, h.dissenter!) };
  assert.ok(after.affinity < h.before!.affinity, "the dissent went unnoticed");
  s.foldDissentOvernight(); s.foldDissentOvernight();
  assert.equal(s.rel.edge(h.holder!, h.dissenter!).affinity, after.affinity, "the same dissent was held against them twice");
});
Then("the majority voter's read of the player cools", function () {
  const sb = bag(this).sb!; const h = herd(this);
  assert.ok(seam(sb).rel.edge(h.holder!, PLAYER).affinity < h.before!.affinity, "the player's dissent went unnoticed");
});

// ---- Part 3: scapegoats ----
type GoatSeam = Seam & { ctx(): { beliefTiltFor?: (s: string, d: string) => number }; emotionalReadOf(id: string): number; beatSeq: number };
type GoatBag = { goat?: string; withGrievance?: string; without?: string; other?: string };
const goat = (w: unknown): GoatBag => ((w as { goat0180?: GoatBag }).goat0180 ??= {});
function grievancesAgainst(w: unknown, subjectIsPlayer: boolean): void {
  const sb = bag(w).sb!; const g = goat(w); const live = seam(sb).live;
  const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
  g.goat = subjectIsPlayer ? PLAYER : npcs[npcs.length - 1];
  const holders = npcs.filter((id) => id !== g.goat).slice(0, Math.ceil(npcs.length / 2));
  g.withGrievance = holders[0]; g.without = npcs.find((id) => id !== g.goat && !holders.includes(id)); g.other = npcs.find((id) => id !== g.goat && id !== g.withGrievance && id !== g.without);
  live.beliefs = Object.fromEntries(holders.map((h) => [h, [{ id: `${h}|lied-to-me|${g.goat}||${live.week}`, holder: h, kind: "lied-to-me", subject: g.goat!, value: true, origin: "witnessed", confidence: 0.8, week: live.week } as BeliefClaim]]));
}
const lean = (w: unknown, subject: string, decider: string): number => (seam(bag(w).sb!) as unknown as GoatSeam).ctx().beliefTiltFor?.(subject, decider) ?? 0;
const baseline = (w: unknown, subject: string, decider: string): number => {
  const s = seam(bag(w).sb!) as unknown as GoatSeam & { scapegoatLeanFor(a: string, b: string): number };
  return lean(w, subject, decider) - s.scapegoatLeanFor(subject, decider);
};
Given("half the house holds a grievance against one houseguest", function () { grievancesAgainst(this, false); });
Given("half the house holds a grievance against the player", function () { grievancesAgainst(this, true); });
When("the week turns hard, with most of the house rattled", function () {
  const s = seam(bag(this).sb!) as unknown as GoatSeam;
  s.emotionalReadOf = () => 0.2; // TEST-ONLY seam: the house's moods
  s.beatSeq += 1; // a new beat: the house's read refreshes
});
Then("a houseguest deciding a nomination or a vote leans toward that houseguest, and toward no one else", function () {
  const g = goat(this);
  assert.ok(lean(this, g.goat!, g.withGrievance!) > baseline(this, g.goat!, g.withGrievance!), "no lean toward the scapegoat");
  assert.equal(lean(this, g.other!, g.withGrievance!), baseline(this, g.other!, g.withGrievance!), "the lean reached someone who is not the scapegoat");
});
Then("a houseguest without a grievance of their own leans less than one with", function () {
  const g = goat(this);
  const withG = lean(this, g.goat!, g.withGrievance!) - baseline(this, g.goat!, g.withGrievance!);
  const without = lean(this, g.goat!, g.without!) - baseline(this, g.goat!, g.without!);
  assert.ok(without > 0 && without < withG, `with a grievance ${withG}, without ${without}`);
});
Then("no one's decisions lean toward them as a scapegoat", function () {
  const s = seam(bag(this).sb!) as unknown as { scapegoatLeanFor(a: string, b: string): number; emotionalReadOf(id: string): number; beatSeq: number };
  s.emotionalReadOf = () => 0.7; s.beatSeq += 1; // a calm house
  const g = goat(this);
  assert.equal(s.scapegoatLeanFor(g.goat!, g.withGrievance!), 0);
});
Then("a houseguest deciding a nomination or a vote leans toward the player", function () {
  const g = goat(this);
  assert.ok(lean(this, PLAYER, g.withGrievance!) > baseline(this, PLAYER, g.withGrievance!), "the house did not lean toward the player as its scapegoat");
});
