import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import { spreadBetween, type SpreadDeps } from "../../src/engine/copresenceSpread";
import { ToldLedger } from "../../src/engine/heldFacts";
import { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import type { NetworkRoles } from "../../src/engine/networkSpread";

/**
 * Feature 0179 - the house's shape in the spread (Theme 3 slice 9). The house is a REAL registry sandbox: its bonds are set through the relationship model, and
 * the roles the spread reads come from the adapter's own `networkRoles()` (the house graph derived from the bond read). The telling is the real co-presence
 * spread (`spreadBetween`), each trial on a fresh knowledge store and told ledger, with the house's real edges. TEST-ONLY seams: the relationship model, the day's cached house graph.
 * Roles only: two cliques, a broker, a loner.
 */
type Bag = { sb?: UserSandbox; a?: string[]; b?: string[]; broker?: string; loner?: string; withShape?: number; without?: number; toLoner?: number; toFriend?: number };
const bag = (w: unknown): Bag => ((w as { net0179?: Bag }).net0179 ??= {});
const session = (w: unknown) => bag(w).sb!.session as GameSessionAdapter;
const rel = (w: unknown) => (bag(w).sb!.session as unknown as { rel: { edge(a: string, b: string): { trust: number; affinity: number; threat: number; reliability: number } } }).rel;
let n = 0;
const TRIALS = 300;

Given("a played season whose house has two close cliques, a broker tied into both, and a loner", function () {
  const sb = new GameSessionRegistry().sandboxFor(`net0179-${n++}`);
  sb.session.setNetworkSpreadEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed: 10 });
  const b = bag(this); b.sb = sb;
  const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
  b.a = npcs.slice(0, 3); b.b = npcs.slice(3, 6); b.broker = npcs[6]; b.loner = npcs[7];
  const r = rel(this);
  for (const x of npcs) for (const y of npcs) if (x !== y) Object.assign(r.edge(x, y), { trust: 0.25, affinity: 0.25, threat: 0.1, reliability: 0.3 });
  const close = (x: string, y: string) => { for (const [p, q] of [[x, y], [y, x]]) Object.assign(r.edge(p!, q!), { trust: 0.6, affinity: 0.6 }); };
  for (const g of [b.a, b.b]) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) close(g[i]!, g[j]!);
  for (const m of [...b.a.slice(0, 2), ...b.b.slice(0, 2)]) close(b.broker!, m);
  close(b.loner!, b.a[2]!); // one close friend, no clique: a loner by the graph, and as close to that friend as the friend's clique mates (so only the shape differs)
  // TEST-ONLY seam: the house graph is derived once a day, and seeking (which now reads the shape) already derived today's from the opening bonds; derive it afresh from these
  (sb.session as unknown as { houseGraphCache?: unknown }).houseGraphCache = undefined;
  const roles = sb.session.networkRoles()!;
  assert.ok(roles.isBroker(b.broker!), "the house graph does not read the broker as a broker");
  assert.ok(roles.isLoner(b.loner!), "the house graph does not read the loner as a loner");
});

/** How many of TRIALS fresh meetings end with `holder` passing a fact about `subject` to `listener`. */
function passes(w: unknown, holder: string, listener: string, subject: string, network: NetworkRoles | undefined): number {
  const r = rel(w);
  let count = 0;
  for (let t = 0; t < TRIALS; t++) {
    const knowledge = new InMemoryKnowledgeService(new InMemoryEventStore());
    knowledge.seedBelief(holder, { content: "news about a houseguest", factId: `f${t}`, subject, confidence: 0.8, hops: 0, distortion: 0, source: holder }, "witnessed");
    const deps: SpreadDeps = {
      knowledge, told: new ToldLedger(), rngFor: () => new SeededRandom(1000 + t),
      trust: (a, b) => r.edge(a, b).trust, affinity: (a, b) => r.edge(a, b).affinity, threat: (a, b) => r.edge(a, b).threat,
      style: () => "social", volatility: () => 0.3, audienceOf: () => 0, ...(network ? { network } : {}),
    };
    if (spreadBetween(holder, listener, deps).some((x) => x.transmitted)) count++;
  }
  return count;
}

When("the broker, holding news about someone in the first clique, meets someone from the second clique many times over", function () {
  const b = bag(this); const roles = session(this).networkRoles()!;
  b.withShape = passes(this, b.broker!, b.b![0]!, b.a![0]!, roles);
  b.without = passes(this, b.broker!, b.b![0]!, b.a![0]!, undefined);
});

Then("they pass it on more often than they would in a house with no shape", function () {
  const b = bag(this);
  assert.ok(b.withShape! > b.without!, `with the house's shape ${b.withShape} of ${TRIALS}, without ${b.without}`);
});

When("a clique member, holding news, meets the loner many times over, and meets a clique friend as many times", function () {
  const b = bag(this); const roles = session(this).networkRoles()!;
  const holder = b.a![2]!;
  b.toLoner = passes(this, holder, b.loner!, b.b![2]!, roles);
  b.toFriend = passes(this, holder, b.a![0]!, b.b![2]!, roles);
});

Then("they pass it to the loner less often than to the friend", function () {
  const b = bag(this);
  assert.ok(b.toLoner! < b.toFriend!, `to the loner ${b.toLoner} of ${TRIALS}, to the friend ${b.toFriend}`);
});

Then("no player or admin view carries a clique, a broker, a loner or a role", async function () {
  const sb = bag(this).sb!;
  const out = JSON.stringify([
    await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}),
    await sb.mcp.admin.callTool("inspectNonVaultState", {}),
  ]);
  assert.ok(!/\bbroker|\bloner|cliques|networkRoles|brokerBridge|weakTie/i.test(out), "the house's shape reached a player or admin view");
});
