import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import type { McpServer } from "../../src/adapters/mcp/McpServer";
import type { AdvanceView } from "../../src/ports/GameSession";
import { PLAYER, npc } from "../../src/domain/ids";
import { answerPending } from "../../features/support/answerPending";
import { endHeldNight } from "../support/heldNight";
import { plantLiveSentinels, args } from "../support/liveSentinelPlanting";
import { PLAYER_PROJECTION_REGISTRY } from "../support/playerProjectionRegistry";

/**
 * ORW-299 - the PLAYER-PERSPECTIVE sentinel. Ryne (2026-11-10): "I am only concerned about things leaking from your limited perspective."
 * Every engine-made player-facing summary (daily recap + hint, week digest, week chapter, champagne toast / premiere intros, exit interview, the returning-cast
 * legend, producer read, dossier, receipts, journal/recall, deal + alliance views, room canon / day ledger, the staged ceremony step texts, ...) used to carry its own
 * leak test or none. This plays ONE seeded season on the FULL deployed flag profile (deploy/orwell-env-defaults.sh, the same source jurySequester.deployed reads),
 * plants unique tokens in (a) a hidden NPC-to-NPC scene the player never witnessed, (b) an NPC confessional, (c) a fact the player never heard (Vault secret + another
 * NPC's private knowledge), (d) a houseguest's undisclosed private orientation (Vault-sealed record + the engine-only map), PLUS everything liveSentinel plants (souls,
 * hidden elements, the memory / belief / assurance / told ledgers) - and reads EVERY player-facing projection at EVERY phase/week/pending-kind/ceremony step, and
 * every advanceGame result, asserting no token appears. Only the player's own limited knowledge may appear.
 *
 * The one sanctioned carrier: another NPC's OWN knowledge-layer token (`-npcknow-`) may ride the per-NPC voicing tools (npcVoice / getMomentPrompt / the knowledge
 * manifest / askJuror), or any surface once a recorded told/overheard pathway gave it to the player - exactly liveSentinel's existing exemption.
 * The ratchet (tests/unit/playerProjectionRatchet.test.ts) makes a NEW port projection join `PLAYER_PROJECTION_REGISTRY` (tests/support/playerProjectionRegistry.ts).
 *
 * MUTATION PROOF (run 2026-11-12, both reverted, never committed): (1) in GameSessionAdapter.buildRecapForDay, replacing the daily-recap highlights filter
 * `!e.hidden && (...)` with `true` turned this test RED at once: "LEAK: token SENTINEL-B42-event-2-57 reached player-facing surface turnIn at beat 24 phase=premiere ...
 * dailyRecap.highlights". (2) adding `mutationProbeSummary(): { text: string }` to the GameSession port without registering it turned the ratchet
 * (tests/unit/playerProjectionRatchet.test.ts) RED: "mutationProbeSummary ({ text: string }) is registered".
 */

// The FULL deployed flag profile, read from its single source BEFORE the engine modules load (adapters read env at module load).
const deployedProfile = execFileSync(
  "bash",
  ["-c", 'source "$1" && orwell_optin_env_defaults "$2"', "_", "deploy/orwell-env-defaults.sh", "/nonexistent/orwell-data"],
  { encoding: "utf8" },
)
  .split("\n").map((l) => l.trim()).filter((l) => l !== "")
  .map((l) => { if (!/^ORWELL_[A-Z0-9_]+=\S+$/.test(l)) throw new Error(`unexpected line: ${l}`); return l; })
  .filter((l) => !/^ORWELL_(EMBEDDINGS|EMBED_CACHE)=/.test(l));
for (const line of deployedProfile) { const i = line.indexOf("="); process.env[line.slice(0, i)] = line.slice(i + 1); }
const { GameSessionRegistry } = await import("../../src/composition/registry");

const KNOWLEDGE_LAYER_TAG = "-npcknow-";
const KNOWLEDGE_TOOLS = new Set(["npcVoice", "getMomentPrompt", "knowledgeScopeManifest", "askJuror"]);

describe("ORW-299 - the player-perspective sentinel across every player-facing summary", () => {
  it("no hidden scene / confessional / unheard fact / private orientation reaches any player-facing projection, at any phase", async () => {
    expect(deployedProfile.length).toBeGreaterThanOrEqual(20);
    const t0 = Date.now();
    // A handful of seeds: which pendings / recaps / chapters a given season reaches depends on whether the player is evicted early (spectator watch path) or survives, so the
    // seeds are chosen to cover both, and the aggregate coverage is asserted below.
    const total = { finishedSeeds: 0, ceremony: 0, recap: 0, chapter: 0, ledger: 0, dossier: 0, shapes: 0, pendingKinds: new Set<string>() };
    for (const seed of [2, 3, 4, 10, 11, 12, 13, 14]) {
      const r = await playSeed(seed);
      if (r.finished) total.finishedSeeds++;
      total.ceremony += r.ceremony; total.recap += r.recap; total.chapter += r.chapter; total.ledger += r.ledger; total.dossier += r.dossier; total.shapes += r.shapes;
      for (const k of r.pendingKinds) total.pendingKinds.add(k);
    }
    expect(total.finishedSeeds, "most seeds ran to a winner").toBeGreaterThanOrEqual(3);
    expect(total.ceremony, "staged ceremony step texts were produced and scanned").toBeGreaterThan(0);
    expect(total.ledger, "the day ledger had content").toBeGreaterThan(0);
    expect(total.recap, "a daily recap was produced and scanned").toBeGreaterThan(0);
    expect(total.chapter, "a week chapter was produced and scanned").toBeGreaterThan(0);
    for (const k of ["exit-interview", "nominations"]) expect(total.pendingKinds.has(k), `pending kind ${k} was reached`).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`ORW-299 sentinel: ${total.shapes} phase shapes, ${total.ceremony} ceremony steps, ${total.recap} recaps, ${total.chapter} chapters, dossier ${total.dossier}, pendings=[${[...total.pendingKinds].join(",")}], ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }, 600_000);
});

async function playSeed(seed: number) {
  {
    const reg = new GameSessionRegistry();
    const user = `persp-u${seed}`;
    const player = reg.resolver()("player", user) as McpServer;
    const admin = reg.resolver()("admin", user) as McpServer;
    await player.callTool("createCharacter", { playerName: "The Player", seed });
    await player.callTool("noteMessage", { messageId: "persp-open" }); // a PLAYED game: the clock / night / recap gates are live
    const sb = reg.sandboxFor(user);

    // (d) a houseguest's private orientation, undisclosed: the engine-only map (cast to carry a unique token) + its Vault-sealed record. Before plantLiveSentinels (its restore must not wipe).
    const extras: string[] = [];
    const mk = (tag: string): string => { const s = `SENTINEL-P299-${tag}-${seed}`; extras.push(s); return s; };
    const core = sb.session.snapshot();
    (core.privateOrientations ??= {})[npc(3)] = mk("orientation") as never;
    sb.session.restore(core);
    sb.engine.vault.writeHidden({ id: `p299:orient:${seed}`, kind: "hidden-attribute", subject: npc(3), content: `private orientation ${extras[0]}` });
    // (c) a fact the player never heard: a Vault secret about a houseguest + a fact only another NPC knows.
    sb.engine.vault.writeHidden({ id: `p299:secret:${seed}`, kind: "hidden-thread", subject: npc(4), content: `secret ${mk("secret")}` });
    // (a)+(b) the hidden NPC-to-NPC scene and the confessional are planted by plantLiveSentinels (-event-, -vault-); add a SECOND hidden scene and confessional of our own so the roles are explicit.
    sb.engine.events.record({ id: `p299:scene:${seed}`, ts: 9_100_000, type: "conversation", initiator: npc(3), witnessSet: [npc(3), npc(4)], hidden: true, content: `scheme ${mk("scene")}` });
    sb.engine.vault.writeHidden({ id: `p299:conf:${seed}`, kind: "confessional", subject: npc(3), content: `confessional ${mk("confessional")}` });
    const sentinels = [...plantLiveSentinels(reg, user, seed), ...extras];
    expect(sentinels.length).toBeGreaterThan(extras.length);

    const playerHolds = (s: string): boolean => sb.engine.knowledge.knownTo(PLAYER).some((f) => f.content.includes(s) && /^(told-by:|overheard)/.test(f.pathway));
    const swept = new Map<string, number>();
    const scan = (surface: string, value: unknown, where: string): void => {
      const blob = JSON.stringify(value ?? null);
      expect(blob, `${surface} returned undefined (unscannable)`).toBeTypeOf("string");
      swept.set(surface, (swept.get(surface) ?? 0) + 1);
      for (const s of sentinels) {
        if (s.includes(KNOWLEDGE_LAYER_TAG) && (KNOWLEDGE_TOOLS.has(surface) || playerHolds(s))) continue;
        if (blob.includes(s)) expect.fail(`LEAK: token ${s} reached player-facing surface ${surface} at ${where}: ...${blob.slice(Math.max(0, blob.indexOf(s) - 200), blob.indexOf(s) + 100)}`);
      }
    };
    const call = async (server: McpServer, name: string, where: string): Promise<unknown> => {
      let r: unknown;
      try { r = await server.callTool(name, args(name, seed)); } catch (err) { r = String(err instanceof Error ? err.message : err); }
      scan(name, r, where);
      return r;
    };

    // Every READ projection the player (or admin) can pull; mutating levers are swept by liveSentinel.property.test.ts.
    const PLAYER_READS = [
      "gameStatus", "getGameState", "stateDelta", "getMomentPrompt", "recallSceneMemories", "getVisibleStateFor", "renderScene", "socialRead", "socialInitiatives",
      "whereabouts", "premiereIntros", "seasonRecap", "dailyRecap", "dayLedger", "npcVoice", "playerTagline", "finaleView", "playerDossier", "playerReceipts",
      "worldSnapshotView", "competitionStagingView", "endOfSessionSummary", "getPortraitPrompt", "getOffscreenSceneSkeletons", "sealedFromHouse", "knowledgeScopeManifest",
    ];
    // Registry coverage: every registered projection that is read through a tool must be in the list (or be swept as an advance view below).
    for (const e of PLAYER_PROJECTION_REGISTRY) {
      if (e.coveredBy === "read") expect(PLAYER_READS.includes(e.tool ?? e.method), `registry says ${e.method} is a swept read but PLAYER_READS lacks it`).toBe(true);
    }
    const ADMIN_READS = ["inspectNonVaultState", "sandboxHealth", "getBehavioralFlags"];

    const tick = (): void => (sb.session as unknown as { advanceClockPerConversation(): void }).advanceClockPerConversation();
    const keys = new Set<string>();
    const startWhere = "start of game (premiere)";
    for (const n of PLAYER_READS) await call(player, n, startWhere);
    const seen = { ceremony: 0, recap: 0, chapter: 0, ledger: 0, dossier: 0, pendingKinds: new Set<string>() };
    let finished = false; let lastAdv: unknown = null; let sameSeq = 0; let lastSeq = -1; let stalled = false;
    for (let i = 0; i < 40000 && !finished; i++) {
      const adv = (await player.callTool("advanceGame", {})) as AdvanceView;
      const gs = (await player.callTool("getGameState", {})) as { phase?: string; week?: number };
      const where = `beat ${i} phase=${gs.phase} week=${gs.week} pending=${adv.pending?.kind ?? "-"}`;
      scan("advanceGame", adv, where);
      if (adv.ceremony) seen.ceremony++;
      if (adv.dailyRecap) seen.recap++;
      if (adv.weekChapter) seen.chapter++;
      if (adv.pending) seen.pendingKinds.add(adv.pending.kind);
      // the full read battery whenever the (phase, week, pending kind, ceremony) shape is new, i.e. at EVERY phase of the season
      const key = `${gs.phase}|${gs.week}|${adv.pending?.kind ?? "-"}|${adv.ceremony ? "cer" : "-"}|${adv.weekChapter ? "ch" : "-"}|${adv.dailyRecap ? "rc" : "-"}|${(adv as { held?: unknown }).held ? "held" : "-"}`;
      if (!keys.has(key)) {
        keys.add(key);
        for (const n of PLAYER_READS) {
          const r = await call(player, n, where);
          if (n === "dayLedger" && Array.isArray(r) && r.length) seen.ledger++;
          if (n === "playerDossier" && r && typeof r === "object" && Object.keys(r).length) seen.dossier++;
        }
        for (const n of ADMIN_READS) await call(admin, n, where);
        // The player also PLAYS: social levers (their results and the dossier / receipts / recall they feed) so those summaries have content to leak from. A refusal is fine; its text is scanned.
        if (keys.size % 20 === 1) for (const n of ["recordInteraction", "makeDeal", "confide", "callInFavor", "formAlliance", "diaryRoom", "askProducers"]) await call(player, n, where);
      }
      if ((adv as { held?: unknown }).held) await endHeldNight(async (n, a) => {
        // turnIn / noteMessage results are player-facing too: the bedtime turn-in carries the daily recap (+ hint) and the week chapter.
        const r = await player.callTool(n, a) as { dailyRecap?: unknown; weekChapter?: unknown } | null;
        if (n === "turnIn" || n === "noteMessage") { scan(n, r, where); if (r?.dailyRecap) seen.recap++; if (r?.weekChapter) seen.chapter++; }
        return r;
      }, "persp", tick);
      if (adv.pending && adv.pending.kind !== "ceremony-step") {
        const ans = answerPending(adv.pending);
        if (ans) scan("submitDecision", await player.callTool("submitDecision", ans as unknown as Record<string, unknown>), where);
      }
      finished = adv.finished; lastAdv = adv;
      // A driver stall (the engine holds an evening schedule beat the headless player cannot clear: observed on seed 5, beatSeq frozen) is reported, not looped on.
      sameSeq = adv.beatSeq === lastSeq ? sameSeq + 1 : 0; lastSeq = adv.beatSeq;
      if (sameSeq > 40) { stalled = true; break; }
    }
    if (stalled) console.log(`ORW-299: seed ${seed} stalled at beatSeq ${lastSeq} (driver could not clear): ${JSON.stringify(lastAdv).slice(0, 300)}`); // eslint-disable-line no-console
    // post-finish: the sanctioned retrospective unsealing is excluded (0048), everything else is swept once more against the terminal house.
    for (const n of PLAYER_READS) await call(player, n, "post-finish");
    await call(player, "seasonRecap", "post-finish");

    // The sweep must not be vacuous: the planted tokens sit in the live hidden state, and the surfaces actually produced content.
    const hidden = JSON.stringify(sb.session.snapshot()) + JSON.stringify(sb.engine.events.queryAll()) + JSON.stringify(sb.engine.vault.readHidden());
    for (const s of extras) expect(hidden.includes(s), `${s} no longer in the hidden state`).toBe(true);
    expect(keys.size, `seed ${seed}: swept at many distinct phases`).toBeGreaterThan(10);
    for (const n of PLAYER_READS) expect(swept.get(n) ?? 0, `${n} was never swept`).toBeGreaterThan(0);
    return { ...seen, shapes: keys.size, finished };
  }
}
