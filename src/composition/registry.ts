import { buildEngineCore } from "./engineRoot";
import type { EngineCore } from "./engineRoot";
import { buildOutwardChannels } from "./outwardRoot";
import { InMemoryGameStateRepository } from "../adapters/inmemory/InMemoryGameStateRepository";
import { EngineCommandsAdapter } from "../adapters/engine/EngineCommandsAdapter";
import { GameSessionAdapter } from "../adapters/engine/GameSessionAdapter";
import { McpServer } from "../adapters/mcp/McpServer";
import { PLAYER } from "../domain/ids";
import { SeededRandom } from "../adapters/random/SeededRandom";
import { hashSeed } from "../engine/characterFactory";
import {
  DEEP_PROFILE_KIND, STORY_THREAD_KIND, deepProfileVaultId, deepProfileToVaultContent, storyThreadToVaultContent,
} from "../engine/deepProfile";
import { preGameTieToVaultContent, showmanceToVaultContent } from "../engine/seededRelationships";
import { SEEDED_TIE_SURFACING } from "../engine/seededRelationshipConstants";
import {
  PRIVATE_ORIENTATION_KIND, privateOrientationVaultId, privateOrientationToVaultContent,
} from "../engine/diversity";
import { diffuseGossip, makeSocialGraph, GOSSIP, spreadReliableReputation } from "../engine/gossip";
import { reliableFactId, reliableHonorerFrom } from "../domain/deal";
import { recallWitnessedMoments } from "../engine/memoryCallback";
import type { EntityId } from "../domain/ids";
import type { PlayerSurface } from "../surfaces/player/PlayerSurface";
import type { AdminPort } from "../surfaces/admin/AdminPort";
import type { SummaryService } from "../services/SummaryService";
import type { UserSaveStore } from "../ports/UserSaveStore";
import type { UserNotorietyStore } from "../ports/UserNotorietyStore";
import { InMemoryUserNotorietyStore } from "../adapters/engine/FileUserNotorietyStore";
import { deriveNotoriety } from "../engine/notoriety";
import type { BehavioralFlags, PreSeedNextSeasonReq, PreSeedNextSeasonView } from "../ports/GameSession";
import { SNAPSHOT_VERSION, snapshotCompatible } from "../engine/sessionSnapshot";
import type { SessionSnapshot } from "../engine/sessionSnapshot";

/**
 * Per-user game sandboxes (feature 0021). Each authenticated user gets ONE active
 * game in a fully isolated sandbox — its own engine core (events, Vault, knowledge,
 * relationships), GameSession, outward surfaces, and MCP servers. Many users run
 * at once, each a separate object graph, so NO call on behalf of user A can ever
 * reach user B's state. This is a second isolation axis, orthogonal to the Vault
 * Wall (which still holds inside every sandbox).
 *
 * Lives in the composition layer (it wires the engine root, which holds the Vault);
 * the outward HTTP transport never imports this — it receives a Vault-free resolver.
 */
export interface UserSandbox {
  engine: EngineCore;
  player: PlayerSurface;
  admin: AdminPort;
  summary: SummaryService;
  session: GameSessionAdapter;
  commands: EngineCommandsAdapter;
  mcp: { player: McpServer; admin: McpServer };
  /** Project the live session's PUBLIC facts onto the admin state (B58/audit E5) — roles only. */
  syncAdmin: () => void;
}

function buildUserSandbox(user = "default"): UserSandbox {
  const engine = buildEngineCore();
  const adminState = new InMemoryGameStateRepository({ week: 1, phase: "setup", houseguests: [] });
  const outward = buildOutwardChannels({
    player: PLAYER, events: engine.events, knowledge: engine.knowledge, adminState,
  });
  // A PER-USER rng (B60/audit E12): the command seam's folds/overhears were identical across every
  // sandbox (a shared SeededRandom(1)) — now each user's stream is their own.
  const commands = new EngineCommandsAdapter(
    engine.events, engine.knowledge, engine.relationships, new SeededRandom(hashSeed(`commands:${user}`)),
  );
  const session = new GameSessionAdapter(engine.relationships);
  // Wire the engine-only soul store (0024) into the live session so consequential beats + off-screen
  // scenes deepen each NPC's arc and ground their later voice (the 0041 linchpin).
  session.setSoul(engine.soul);
  // Name resolution for outward prose (non-Vault: names are public): the player surface uses this
  // so socialRead names the houseguest instead of echoing a raw `npc:N` id into the read.
  outward.player.setNameResolver((id) => session.publicName(id));
  // The PLAYER-FACING CONTENT scrub (audit R4-03 / C-01): the visible projection's event/knowledge
  // content also interpolates raw ids + pathway slugs — wire the live public roster so the narrator
  // receives names ("Ada and Bo are getting close"), never `npc:8 and npc:14 are … · more or less#7`.
  outward.visible.setRoster(() => session.publicRoster());
  // Validated references (B39): a recorded interaction may only name LIVING houseguests — the session
  // knows who's still in the house (player + non-evicted NPCs).
  commands.setLivingProvider(() => session.livingIds());
  // 0065 Part A — the command port enforces the compare-and-swap stale-write guard against the SAME
  // monotonic beatSeq the session owns/persists, and composes its typed `stale-beat` refusal with the
  // session's Vault-free board. Both readers are Vault-free (a counter + ceremony-level public status).
  commands.setBeatSeqProvider(() => session.beatSeqNow());
  commands.setBoardProvider(() => session.gameStatus());
  // House presence (0049): recorded scenes are grounded in the live occupancy — co-present
  // houseguests witness them; occupants of adjacent rooms may overhear (both directions).
  commands.setPresenceProvider(() => session.occupancy());
  // ADR 0006: someone who has turned in for the night neither witnesses nor overhears a player scene.
  commands.setAwakeProvider(() => session.awakeIds());
  // Phase 2 (duration-based clock): a recorded social scene that proposed how long it FELT hands its
  // bounded duration to the session, which the orchestrator's per-turn clock advance then consumes — so
  // the day's clock tracks the play the player actually did, not a flat floor. Self-gated on the running
  // clock (inert in the seeded sims). Pacing-only: no fold, no number crosses to the player.
  // 0077 Phase 2: the live sub-zone reader, so co-presence witnessing in a big room (the backyard, the
  // lounge) is earshot-scoped — the far end of the yard is not auto-witnessed. Unwired ⇒ pre-0077 behavior.
  commands.setZoneProvider((id) => session.currentZone(id));
  // Phase 2 of "the player can play offense" (0085 follow-on): a LANDED evict-shaped pitch the player
  // makes (recordInteraction's aboutEdges, Phase 1) folds into the player's OWN persistent campaign,
  // mirroring formCampaigns/advanceCampaign/campaignTilt — self-gated by the session's own campaign flag.
  commands.setPlayerCampaignFold((target, holder) => session.foldPlayerCampaignMove(target, holder));
  // #1419 — the player-side social-fatigue fold: a recorded scene's INITIATOR moves the needle
  // ASYMMETRICALLY when sleep-deprived (WARMING folds dampened, SOURING amplified — "harder to scheme
  // if you aren't sleeping"). Reads the session's Vault-free rest-deficit valence; returns {1,1} (a
  // no-op) unless the master clock is running, social fatigue is on, AND the initiator is tired — so a
  // clock-off / rested game is byte-identical, and no number ever crosses to the player.
  commands.setFatigueValence((id) => session.socialFoldValence(id));
  // #1318 — a recorded player↔NPC scene registers a GENUINE premiere hot read, so the asymmetric first-
  // power gate unlocks on real engagement rather than a name merely name-dropped in the move-in narration
  // (which only the FE regex belt marks, meet-list-only). The session no-ops this outside the premiere.
  commands.setPlayerReadSink((npcIds) => session.notePremiereReads(npcIds));
  // #1792 — Producer Read: a substantive recorded interaction computes an ExchangeAccounting fact,
  // stashed for the ONE-SHOT moment-prompt delivery. Gate: checked at call time (below), so OFF
  // ⇒ nothing is stashed ⇒ byte-identical.
  // The sink is ALWAYS wired and gated at CALL time (not at sandbox build), so the runtime dial / a per-session setter
  // can turn the layer off after the sandbox exists; OFF ⇒ `computeExchangeAccounting` is pure and nothing is stashed.
  commands.setProducerReadSink((acc) => { if (session.producerReadEnabledNow()) session.stashExchangeAccounting(acc); });
  // L27/L27b/0024: every recorded social scene is indexed into each houseguest's SEMANTIC recall
  // memory, so later story/narrative is built from the store recalled (ADR 0003), never the chat
  // window. Routed through the session's `recordSceneMemory` — NOT engine.soul.recordToSoul directly —
  // so the summary lands in the houseguest's PERSISTED `soul.memory` mirror too (L27b): the vector
  // index is derived state that `rebuildSoulIndex` re-derives ONLY from the persisted mirror, so a
  // scene recorded N turns ago stays recall-able IN FULL across a restart (it used to vanish on
  // restore — the event record survived but the NPC could no longer recall the scene).
  commands.setSoulMemo((hg, content) => session.recordSceneMemory(hg, content));
  // Per-NPC voicing (B65 / ADR 0003 §8): the session projects ONE houseguest's legitimate
  // knowledge + hunches so the narrator can voice them without inventing or omnisciently leaking.
  session.setNpcKnowledgeProviders({
    known: (id) => engine.knowledge.knownTo(id),
    suspicions: (id) => engine.knowledge.suspicionsOf(id),
  });
  // The season record (0048/B56): the recap reads the PUBLIC record; the retrospective reads the
  // hidden side THROUGH the session's finished-state gate (the one sanctioned Vault seam).
  session.setRecordProviders({
    events: () => engine.events.queryAll(),
    hidden: () => engine.vault.readHidden(),
  });
  // 0065 Part E — the delta feed's O(Δ) providers. `count` anchors each beat checkpoint at commit time
  // (O(1) log length). `visibleEventsSince` slices the immutable log TAIL from the checkpoint's count and
  // runs the SAME witness-filter + roster scrub the player surface uses — so the delta is Vault-free by
  // construction (hidden events the player never witnessed are dropped) and never re-scans the whole log.
  // The shape mapped here is the player-facing `DeltaEventView` (id/ts/type/content), not the raw event.
  session.setDeltaProviders({
    count: () => engine.events.count(),
    visibleEventsSince: (fromCount) =>
      outward.visible.visibleEventsSince(PLAYER, fromCount).map((e) => ({
        id: e.id, ts: e.ts, type: e.type as string, content: e.content,
      })),
  });
  // Feature #1394 — narrator memory callbacks. THE MANDATE LINE: recall reads ONLY the player's
  // Vault-free visible projection (`outward.visible.getVisibleStateFor(PLAYER).visibleEvents` — the
  // outward `VisibleStateService`, which by dependency-cruiser has NO Vault handle at all, and whose
  // events are already witness-filtered to the player + roster-scrubbed). It CANNOT surface Vault
  // content because it never receives any; the recall only narrows that Vault-free pool to the scene's
  // NPC(s) and ranks it semantically against the cue, in the SAME embedding space the soul index uses
  // (`engine.embed`, fastembed at runtime). Deliberately NOT `engine.soul.recall` — that runs over the
  // FULL hidden soul (confessionals, hidden leanings) and is Vault content. See the leak test.
  session.setSceneRecall((npcIds, cue) =>
    recallWitnessedMoments({
      events: outward.visible.getVisibleStateFor(PLAYER).visibleEvents,
      npcIds,
      cue,
      embed: engine.embed,
    }).moments,
  );
  // Reserve twists (0025/B53): the loaded schedule is SEALED into the Vault — the audit copy no
  // player or admin surface can reach (0001 holds structurally), and 0048's unsealing payoff.
  session.setOnSeal((reserve) => {
    for (const t of reserve) {
      engine.vault.writeHidden({
        id: `twist:${engine.vault.readHidden({ kind: "reserved-twist" }).length}`,
        kind: "reserved-twist",
        content: `sealed reserve twist: ${t.kind}, fires week ${t.fireAtBeat}`,
      });
    }
  });
  // Deep character profiles (feature 0058): SEAL each NPC's HIDDEN profile + story threads into the
  // Vault — the audit copy no player OR admin surface can reach (0001), and the 0048 unsealing payoff.
  // This is the SAME hidden-seal seam the reserve twists use — engine-only by construction. The
  // SOUL indexing (full-fidelity recall, L27b) is done by the adapter's seedDeepProfiles into each
  // NPC's authoritative soul.memory (so it persists + re-indexes on restore); the PUBLIC facets fold
  // onto the byte-stable Character separately (they cross to the player).
  session.setOnSealProfiles((profiles, threads) => {
    for (const { id, profile } of profiles) {
      engine.vault.writeHidden({
        id: deepProfileVaultId(id), kind: DEEP_PROFILE_KIND, subject: id, content: deepProfileToVaultContent(id, profile),
      });
    }
    for (const t of threads) {
      engine.vault.writeHidden({ id: t.id, kind: STORY_THREAD_KIND, subject: t.sourceId, content: storyThreadToVaultContent(t) });
    }
  });
  // L28b — the AUTHORED write-back re-seals ONE houseguest: REPLACE that subject's prior profile +
  // thread records (idempotent, no stale/duplicated records) via the engine-only Vault upsert.
  session.setOnResealProfile((id, profile, threads) => {
    // #1067 — scope the deep-profile re-seal to the EXACT record id. `DEEP_PROFILE_KIND` and
    // `PRIVATE_ORIENTATION_KIND` are BOTH `"hidden-attribute"`, so a `{kind,subject}`-only replace would
    // ALSO delete this houseguest's private-orientation record (a Vault non-degradation regression the
    // 0031 checkpoint correctly refused — surfaced once the live authoring path actually persisted). The
    // id selector touches ONLY `deep-profile:<id>`, leaving the co-kind orientation untouched.
    engine.vault.replaceHidden({ id: deepProfileVaultId(id), kind: DEEP_PROFILE_KIND, subject: id }, [
      { id: deepProfileVaultId(id), kind: DEEP_PROFILE_KIND, subject: id, content: deepProfileToVaultContent(id, profile) },
    ]);
    // Story threads (`hidden-thread`) are this subject's alone (no co-kind collision) and there are MANY
    // per subject, so this stays a {kind,subject} replace of the whole set.
    engine.vault.replaceHidden(
      { kind: STORY_THREAD_KIND, subject: id },
      threads.map((t) => ({ id: t.id, kind: STORY_THREAD_KIND, subject: t.sourceId, content: storyThreadToVaultContent(t) })),
    );
  });
  // 0059 — SEAL the hidden seeded relationship layer (pre-game ties + showmances) into the Vault: the
  // engine-only audit copy no player OR admin surface can reach (0001), like the reserve twists (0025).
  session.setOnSealSeededRels((rels) => {
    for (let i = 0; i < rels.ties.length; i++) {
      const t = rels.ties[i]!;
      engine.vault.writeHidden({ id: `seeded-tie:${i}`, kind: "seeded-relationship", subject: t.a, content: preGameTieToVaultContent(t) });
    }
    for (let i = 0; i < rels.showmances.length; i++) {
      const s = rels.showmances[i]!;
      engine.vault.writeHidden({ id: `seeded-showmance:${i}`, kind: "seeded-relationship", subject: s.a, content: showmanceToVaultContent(s) });
    }
  });
  // 0063 — SEAL each HIDDEN private orientation (closeted / not-yet-out) into the Vault: the engine-only
  // audit copy no player OR admin surface can reach (0001), exactly like the seeded relationships above.
  // A publicly-out orientation is NEVER sealed here — it rides on the byte-stable Character (public facet).
  session.setOnSealPrivateOrientations((entries) => {
    for (const { id, orientation } of entries) {
      engine.vault.writeHidden({
        id: privateOrientationVaultId(id), kind: PRIVATE_ORIENTATION_KIND, subject: id,
        content: privateOrientationToVaultContent(id, orientation),
      });
    }
  });
  // 0059/L40 — a showmance that becomes VISIBLE is a PUBLIC house fact: record it as a player-witnessed
  // (non-hidden) event so it enters the player's knowledge and the narrator may voice the romance.
  session.setOnShowmanceSurfaced((sm) => engine.events.record({
    id: `showmance:${sm.a}:${sm.b}:${engine.events.count()}`,
    ts: engine.events.count(),
    type: "house-event",
    initiator: sm.a,
    witnessSet: [PLAYER, sm.a, sm.b],
    hidden: false,
    content: `${sm.aName} and ${sm.bName} have grown close — the house is starting to notice a showmance`,
  }));
  // 0060 — the story-thread scheduler's SURFACING seams. The session holds no events/knowledge handle;
  // it hands a Vault-SAFE class-keyed paraphrase (never the premise — `threadRumor`) and the registry
  // runs the in-game pathway. This is the SAME hidden→pathway machinery gossip/overhears already use,
  // so nothing crosses but a belief with source + confidence (§7).
  //  (a) NPC↔NPC (the common case): diffuse the paraphrase along the affinity graph (0038) — most of
  //      the time it stays among the NPCs; the player catches it only if a chain terminates at them.
  session.setOnThreadGossip((origin, rumor, subject) => {
    const core = session.snapshot();
    if (!core.house) return;
    const evicted = new Set(core.live?.evictionOrder ?? []);
    // Diffuse NPC↔NPC along the affinity graph — NPC nodes ONLY (the player is never a node here; the
    // rare to-player pathway is the separate anchored seam below). `diffuseGossip` seeds the ORIGIN's
    // belief first, so even on a cold graph this NPC-directed surfacing leaves a real NPC-side belief
    // (the rumor exists in the house), then it spreads with the normal low transmit/decay/drift. This
    // is the engine-only hidden layer; nothing crosses to the player here.
    // #1913 — the AWAKE house only (ADR 0006): a houseguest who has gone to bed neither retells nor hears a
    // rumor at night. Clock off ⇒ `awakeAmong` is the identity ⇒ byte-identical.
    const npcIds: EntityId[] = session.awakeAmong(core.house.npcs.map((n) => n.id).filter((id) => !evicted.has(id)));
    if (!npcIds.includes(origin)) return; // a sleeping origin neither hears nor starts a rumor tonight
    const edges: Array<readonly [EntityId, EntityId]> = [];
    for (let i = 0; i < npcIds.length; i++) {
      for (let j = i + 1; j < npcIds.length; j++) {
        if (engine.relationships.edge(npcIds[i]!, npcIds[j]!).affinity > GOSSIP.affinityEdge) {
          edges.push([npcIds[i]!, npcIds[j]!] as const);
        }
      }
    }
    // Always diffuse: `diffuseGossip` seeds the ORIGIN's belief unconditionally (independent of the
    // graph), so even a cold graph leaves the origin holding the rumor — the NPC-side surfacing never
    // silently vanishes; it just doesn't spread far this tick.
    diffuseGossip({
      knowledge: engine.knowledge,
      graph: makeSocialGraph(edges),
      rng: new SeededRandom(hashSeed(`${core.seed ?? user}:thread-gossip:${subject}:${core.week}`)),
      origin,
      fact: { content: rumor },
      rounds: GOSSIP.rounds,
      transmitProb: GOSSIP.transmitProb,
      decay: GOSSIP.decay,
    });
  });
  // 0121 R1 — the diffusing "keeps their word" REPUTATION reward. When a deal is KEPT (the deal-depth layer
  // gates the callback), the honorer's partner (`other`) spreads a Vault-free reputation NPC→NPC along the
  // affinity graph (0038); each third party who HEARS it leans slightly toward the honorer as a safer deal
  // partner — the positive `GOSSIP_HEARD.reliable` receipt fold, subjects=[honorer]. The dedicated seeded
  // rng keeps the diffusion's draws off the main season/vote stream (only the intended edge fold lands);
  // the whole seam is unreachable with the flag off ⇒ byte-identical to the calibration spine.
  session.setDealReputationSink((honorer, other) => {
    const core = session.snapshot();
    if (!core.house) return;
    // Idempotency (seed ONCE): a season-long deal honored at every ceremony must not re-diffuse / re-fold the
    // whisper — if the deal partner already credits the honorer as reliable (a prior honoring, or a diffusion
    // that already reached them), skip. The knowledge layer IS the watermark; no extra persisted state.
    if (engine.knowledge.knownTo(other).some((k) => k.factId === reliableFactId(honorer))) return;
    const evicted = new Set(core.live?.evictionOrder ?? []);
    // #1913 — the AWAKE house only (ADR 0006): a houseguest who has gone to bed neither retells nor hears a
    // rumor at night. Clock off ⇒ `awakeAmong` is the identity ⇒ byte-identical.
    const npcIds: EntityId[] = session.awakeAmong(core.house.npcs.map((n) => n.id).filter((id) => !evicted.has(id)));
    if (!npcIds.includes(other)) return; // the partner is asleep — the reputation seeds on a later honoring
    const edges: Array<readonly [EntityId, EntityId]> = [];
    for (let i = 0; i < npcIds.length; i++) {
      for (let j = i + 1; j < npcIds.length; j++) {
        if (engine.relationships.edge(npcIds[i]!, npcIds[j]!).affinity > GOSSIP.affinityEdge) {
          edges.push([npcIds[i]!, npcIds[j]!] as const);
        }
      }
    }
    const rng = new SeededRandom(hashSeed(`${core.seed ?? user}:deal-reputation:${honorer}:${core.week}:${engine.events.count()}`));
    // Diffuse the Vault-free "keeps their word" belief NPC→NPC under a STABLE `reliable:<honorer>` lineage (so
    // a holder's belief resolves back to the honorer for the deal-willingness read), and give every third
    // party who hears it a small AFFINITY-ONLY whisper toward the honorer (`GOSSIP_HEARD.reliable`; single
    // subject, dedicated rng — no main-stream re-phase). The DEAL consequence is the explicit willingness lean
    // (`mintNpcDeal`), read from this belief. Only reachable under the deal-depth flag ⇒ off = byte-identical.
    spreadReliableReputation({
      knowledge: engine.knowledge,
      rel: engine.relationships,
      graph: makeSocialGraph(edges),
      rng,
      honorer,
      other,
      content: `${session.publicName(honorer)} keeps their word`,
      candidates: npcIds,
      factId: reliableFactId(honorer),
    });
  });
  // 0121 R1 — the read side: which honorers a holder credits as "keeps their word" (the diffusing
  // `reliable:<honorer>` belief), read by the NPC deal-willingness lean in `mintNpcDeal`. A knowledge-layer
  // read (never a Vault read); returns empty unless the deal-depth layer seeded a reputation this game.
  session.setReliabilityReader((holder) => {
    const credited = new Set<EntityId>();
    for (const f of engine.knowledge.knownTo(holder)) {
      const h = f.factId ? reliableHonorerFrom(f.factId) : undefined;
      if (h) credited.add(h);
    }
    return credited;
  });
  //  (b) TO the player (rare): seed the paraphrase onto an NPC confidant, then surface it `told-by:<npc>`
  //      so the E9 content-lineage check accepts it as a BELIEF (source + confidence) — never an invented
  //      fact. An unanchored attempt is correctly downgraded to a suspicion by 0002. Returns whether the
  //      player actually came to hold the belief (the scheduler counts it once against the season cap).
  session.setOnThreadSurfaceToPlayer((subject, rumor) => {
    const core = session.snapshot();
    if (!core.house) return false;
    const evicted = new Set(core.live?.evictionOrder ?? []);
    // A living NPC confidant who is NOT the subject relays it (someone with a real pathway to the player).
    // #1913 — the relaying confidant must be AWAKE (ADR 0006); clock off ⇒ `awakeAmong` is the identity.
    const confidant = session.awakeAmong(core.house.npcs.map((n) => n.id)).find((id) => id !== subject && !evicted.has(id));
    if (!confidant) return false;
    const factId = `thread-belief:${subject}:${engine.events.count()}`;
    // The confidant first HOLDS the rumor (an origin belief), so the told-by pathway is content-anchored.
    engine.knowledge.seedBelief(confidant, { content: rumor, originalContent: rumor, factId, confidence: 0.6, hops: 1, distortion: 1, source: confidant }, "origin");
    const fact = engine.knowledge.surfaceInformationTo(PLAYER, { content: rumor, subject, confidence: 0.5 }, `told-by:${confidant}`);
    return fact !== null;
  });
  // 0059 §5 — a sealed pre-game TIE surfaces TO THE PLAYER (rare): the SAME anchored-pathway machinery the
  // thread seam uses. A living NPC confidant (not in the pair) first HOLDS the Vault-free observation
  // ("those two seem unusually tight"), then it surfaces `told-by:<npc>` as a content-anchored BELIEF —
  // correctly the player's KNOWLEDGE (a soft read they form paranoia around), never the sealed `nature`,
  // never Vault content. An unanchored attempt is downgraded to a suspicion by 0002. Returns whether the
  // player came to hold it (the scheduler counts it once against the season cap). `subject` is the pair's
  // `a` (the cap is keyed on it). Same low confidence as a behavioral read, never a confirmed fact.
  session.setOnTieSurfaceToPlayer((subject, observation) => {
    const core = session.snapshot();
    if (!core.house) return false;
    const evicted = new Set(core.live?.evictionOrder ?? []);
    // #1913 — the relaying confidant must be AWAKE (ADR 0006); clock off ⇒ `awakeAmong` is the identity.
    const confidant = session.awakeAmong(core.house.npcs.map((n) => n.id)).find((id) => id !== subject && !evicted.has(id));
    if (!confidant) return false;
    const factId = `tie-belief:${subject}:${engine.events.count()}`;
    engine.knowledge.seedBelief(confidant, { content: observation, originalContent: observation, factId, confidence: 0.6, hops: 1, distortion: 1, source: confidant }, "origin");
    const fact = engine.knowledge.surfaceInformationTo(PLAYER, { content: observation, subject, confidence: SEEDED_TIE_SURFACING.surfacedConfidence }, `told-by:${confidant}`);
    return fact !== null;
  });
  // 0075 — a houseguest CONFIDES in the player (the engine already decided whether/how much/true). The
  // teller IS the subject (`told-by:<npc>`): the NPC holds the content (their own secret, or the lie
  // they're asserting), then it surfaces to the player as a content-anchored belief — correctly the
  // player's KNOWLEDGE (Journal-visible), never Vault content. A lie records the same way (the player
  // believes it); only the engine knows it is false.
  session.setOnConfide((npcId, content, confidence) => {
    const factId = `confide:${npcId}:${engine.events.count()}`;
    engine.knowledge.seedBelief(npcId, { content, originalContent: content, factId, confidence: 0.9, hops: 0, distortion: 0, source: npcId }, "origin");
    const fact = engine.knowledge.surfaceInformationTo(PLAYER, { content, subject: npcId, confidence }, `told-by:${npcId}`);
    return fact !== null;
  });
  // 0129 slice 3 — a JUROR tells the player something they already hold. The telling is content-anchored: the
  // juror's own fact (looked up by lineage id in THEIR knowledge) surfaces to the player `told-by:<juror>`.
  // A fact the juror does not hold cannot be surfaced (no lookup hit ⇒ null). Never a Vault read.
  session.setOnJurorTell((jurorId, factId, confidence) => {
    const held = engine.knowledge.knownTo(jurorId).find((f) => f.factId === factId);
    if (!held) return null;
    const fact = engine.knowledge.surfaceInformationTo(PLAYER, { content: held.content, ...(held.subject ? { subject: held.subject } : {}), confidence }, `told-by:${jurorId}`);
    return fact ? held.content : null;
  });
  // 0093/0099 — secrets as power. The player's own knowledge READER (so a wielded `factId` is validated
  // against what the player legitimately holds — the Vault bright line; a non-learned secret is rejected,
  // no minting). Returns the player's facts with id + content + subject + lineage factId. 0094 (distorted
  // gossip consequences) additively widens this with the belief-reliability fields ALREADY on every
  // `KnowledgeFact` (`distortion`/`confidence`) — no new store, no new seam, just a wider projection of
  // the same reader `confront` also validates a cited `factId` against.
  session.setPlayerKnowledgeReader(() =>
    engine.knowledge.knownTo(PLAYER).map((f) => ({
      id: f.id, content: f.content, subject: f.subject, factId: f.factId, pathway: f.pathway,
      distortion: f.distortion, confidence: f.confidence, hops: f.hops,
    })),
  );
  // 0093/0099 — surface an EXPOSED/TRADED secret INTO a houseguest's knowledge through the in-game
  // pathway (the player is the source). The recipient first HOLDS the content (a seeded origin belief so
  // the told-by/overheard pathway is content-anchored, E9), then it surfaces as their KNOWLEDGE — never a
  // Vault read. Mirrors `setOnConfide`. Returns whether they came to hold it.
  session.setOnSurfaceToHouseguest((npcId, content, subject, pathway, confidence) => {
    const factId = `secret-power:${npcId}:${engine.events.count()}`;
    engine.knowledge.seedBelief(npcId, { content, originalContent: content, factId, confidence: 0.9, hops: 0, distortion: 0, source: PLAYER }, "origin");
    const fact = engine.knowledge.surfaceInformationTo(npcId, { content, subject, confidence }, pathway);
    return fact !== null;
  });
  // Weekly-loop beats (0011) are player-witnessed events: record them so they enter the
  // player's knowledge and the durable snapshot (never hidden — the player lived them).
  session.setOnEvent((ev) => engine.events.record({
    id: `season:${engine.events.count()}`,
    ts: engine.events.count(),
    type: "house-event",
    initiator: ev.participants[0] ?? PLAYER,
    witnessSet: [PLAYER, ...ev.participants.filter((p) => p !== PLAYER)],
    hidden: false,
    content: ev.content,
  }));
  // One-off witnessed events (a deal made / a promise broken, 0039). Hidden iff the player is NOT
  // a witness — so a player-party deal is their knowledge, never the Vault.
  session.setOnPlayerEvent((content, witnessSet, type = "deal") => {
    const id = `deal:${engine.events.count()}`;
    engine.events.record({
      id, ts: engine.events.count(), type,
      initiator: witnessSet[0] ?? PLAYER, witnessSet: [...witnessSet],
      hidden: !witnessSet.includes(PLAYER), content,
    });
    return id;
  });
  const deps = { player: outward.player, admin: outward.admin, summary: outward.summary, commands, session };
  // B58/audit E5: the admin's inspectable state mirrors the LIVE session's public facts (week,
  // phase, roles-only roster) — refreshed on every persisted mutation, never a never-updated stub.
  const syncAdmin = (): void => {
    const core = session.snapshot();
    const prev = adminState.getAdminVisibleState();
    const seat = (id: string): string => (core.live?.evictionOrder ?? []).includes(id) ? "evicted" : "active";
    adminState.setAdminVisibleState({
      ...prev,
      week: core.week,
      phase: core.phase,
      houseguests: core.house
        ? [
            { role: "player", status: seat(core.house.player.id) },
            ...core.house.npcs.map((n) => ({ role: "npc", status: seat(n.id) })),
          ]
        : [],
    });
  };
  return {
    engine,
    player: outward.player,
    admin: outward.admin,
    summary: outward.summary,
    session,
    commands,
    mcp: { player: new McpServer("player", deps), admin: new McpServer("admin/God Mode", deps) },
    syncAdmin,
  };
}

/** Export the user's full durable snapshot: session core + engine detail (events + hidden beliefs + knowledge). */
function exportSnapshot(sb: UserSandbox): SessionSnapshot {
  return {
    ...sb.session.snapshot(),
    snapshotVersion: SNAPSHOT_VERSION,
    events: sb.engine.events.queryAll(),
    relationships: sb.engine.relationships.serialize().edges,
    // The whole knowledge layer (B40) — facts + suspicions + counters — so a restart resumes it.
    // Through the port seam (E63): `serialize`/`load` are on `KnowledgeService`, no concrete cast.
    knowledge: sb.engine.knowledge.serialize(),
    // The Vault's hidden records (B53/audit I7) — sealed twists et al. survive a restart too.
    vault: sb.engine.vault.readHidden(),
  };
}

/**
 * R3 (incremental snapshot) — a per-user cache of the last exported `SessionSnapshot`, keyed on a
 * monotonic `rev` the registry bumps on EVERY mutation (the single `commit` seam) and on every
 * sandbox replacement (restore/reset/resume). The integrity spine exports the snapshot repeatedly —
 * the candidate of a commit, the baseline of the next, the supplementary off-screen tick's baseline,
 * and again on each `getGameState` poll — and most of those exports observe the SAME underlying state.
 * Returning the SAME object when the state hasn't changed since the last export means:
 *   (a) the O(events)/O(edges)/O(facts) serialization runs once per actual state change, not per call;
 *   (b) `toGameState`'s WeakMap memo (keyed on snapshot identity) hits, so the projection that feeds
 *       the checkpoint's isSuperset/counts/playerSweep is computed once, not re-derived per export.
 * Correctness: the cached snapshot is an IMMUTABLE point-in-time capture (its `events` array is the
 * frozen log copy; its other fields are freshly serialized plain data). It is only ever READ. The rev
 * is bumped BEFORE any mutation's commit re-exports, so a cache entry can never outlive the state it
 * captured. On any doubt (a path that didn't bump the rev) the worst case is a fresh export — never a
 * stale one — because the rev only ever advances and a miss recomputes from live state.
 */
interface SnapshotCacheEntry {
  /** The mutation rev (commit + explicit invalidation + sandbox replacement) at capture time. */
  rev: number;
  /**
   * The EventStore length at capture time — a cheap O(1) SECOND key that catches a direct event append
   * that did NOT route through `commit`/`invalidateSnapshot` (the only production paths that mutate events
   * are commit-wired or inside the orchestrator's invalidated `applyFn`; this guards a direct
   * `engine.events.record` — e.g. a test or a future seam — from ever reading back a pre-append capture).
   */
  events: number;
  snap: SessionSnapshot;
}

/**
 * Rebuild a fresh sandbox from a durable snapshot — resume the game, don't reset it. An UNKNOWN
 * (future) schema version is rejected (throws) rather than silently mis-restored (B40/audit C4); a
 * versionless legacy save migrates forward (it simply had no persisted knowledge layer).
 */
function importSnapshot(sb: UserSandbox, snap: SessionSnapshot): void {
  if (!snapshotCompatible(snap)) throw new Error(`incompatible snapshot version: ${snap.snapshotVersion}`);
  sb.session.restore(snap);
  // Through the port seam (E63): `restoreRecord`/`load` are on the EventStore/KnowledgeService ports,
  // no concrete `as InMemory*` cast — a relational adapter (SQLite) satisfies the same resume path.
  for (const e of snap.events) sb.engine.events.restoreRecord(e); // ids/ts/hidden preserved exactly
  sb.engine.relationships.load(snap.relationships);
  if (snap.knowledge) sb.engine.knowledge.load(snap.knowledge);
  for (const r of snap.vault ?? []) sb.engine.vault.writeHidden(r); // the producer's secrets resume sealed
  // 0065 Part E — the events are now loaded: seed the delta ring's BASELINE at the resumed beatSeq so the
  // first delta a resumed session serves (keyed on the resumed token) slices its tail instead of looping
  // on full-refresh. (`restore` clears the ring; events arrive only above, after it.)
  sb.session.seedDeltaBaseline();
}

export class GameSessionRegistry {
  /** Default cap on RESIDENT sandboxes (R4): beyond it, the least-recently-used unloads to disk. */
  private static readonly DEFAULT_MAX_RESIDENT = 64;

  private readonly sandboxes = new Map<string, UserSandbox>();
  private readonly maxResident: number;

  /** R3 — per-user mutation revision; bumped on every commit and every sandbox replacement. */
  private readonly rev = new Map<string, number>();
  /**
   * The God-Mode behavioral-flag dial each user's admin set (#1925). A sandbox can be REBUILT while the
   * engine keeps running: an idle LRU unload + resume, or a rollback `restore`. The dial's overrides live
   * on the session instance, so without this they would silently reset on every rebuild. Re-applied in
   * `wireHooks` (the one step every build/resume/restore path runs). In-memory on purpose: the dial is a
   * live-only operator setting that resets on an ENGINE restart, as the tool documents.
   */
  private readonly behavioralFlagsByUser = new Map<string, BehavioralFlags>();
  /** 0016: the live count knobs (reserve twists / tie + showmance budgets) a user's admin set, re-applied to a rebuilt sandbox. */
  private readonly liveKnobsByUser = new Map<string, Record<string, unknown>>();
  /** 0016: EVERYTHING the admin submitted (including unsupported / invalid knobs), so a rebuilt sandbox's inspectable config is not silently dropped. */
  private readonly adminConfigByUser = new Map<string, Record<string, unknown>>();
  /** R3 — per-user last-export cache (`{ rev, snap }`); reused while the rev is unchanged. */
  private readonly snapshotCache = new Map<string, SnapshotCacheEntry>();

  /**
   * 0065 (advance-warm) — the per-user NEXT-season HOLDING STORE that survives the sandbox rotation. The
   * cutover (`resetUser`) discards the running sandbox's adapter, so a next-season warm CANNOT live there;
   * it lives HERE, at the registry/per-user level. Each entry is a DETACHED scratch `GameSessionAdapter`
   * (no live house, no Vault/soul hooks) used purely as a pre-game cast buffer — NOT a second running game
   * (the "one active game per user" invariant holds: this hosts no gameplay, only a warmed cast). At the
   * confirmed cutover the scratch's `PrewarmCast` is injected into the FRESH sandbox and the buffer is
   * dropped. Mirrored onto the LIVE sandbox's snapshot for engine-restart durability (rehydrated on resume).
   */
  private readonly nextSeasonScratch = new Map<string, GameSessionAdapter>();

  /**
   * An optional durable store (0030) makes the live game survive an engine restart:
   * `sandboxFor` recalls the user's saved game on first build, and every mutation
   * saves it. With no store, the registry is purely in-memory (the prior behavior).
   */
  /**
   * 0104 — account-level NOTORIETY store (per-user; never a cross-user read, R3). Defaults to a shared
   * in-memory store so the feature works in tests/runtime without explicit wiring; the durable
   * `FileUserNotorietyStore` is injected by the runtime when a save store is composed. SEPARATE from
   * `saveStore` so the season-restart save rotation never touches it (account reputation survives the
   * cutover by construction, R4).
   */
  private readonly notorietyStore: UserNotorietyStore;

  constructor(
    private readonly saveStore?: UserSaveStore,
    opts: { maxResident?: number; notorietyStore?: UserNotorietyStore } = {},
  ) {
    this.maxResident = Math.max(1, opts.maxResident ?? GameSessionRegistry.DEFAULT_MAX_RESIDENT);
    this.notorietyStore = opts.notorietyStore ?? new InMemoryUserNotorietyStore();
  }

  /** R3 — invalidate the user's cached snapshot: advance the rev so the next export recomputes. */
  private bumpRev(user: string): void {
    this.rev.set(user, (this.rev.get(user) ?? 0) + 1);
  }

  /**
   * R3 — PUBLIC cache invalidation for mutations that bypass the `commit` seam. The orchestrator's
   * off-screen tick (`applyFn`) mutates the sandbox directly (records scenes, moves relationships,
   * deepens souls) WITHOUT firing `onPersist`, then asks for the candidate snapshot — so it must
   * invalidate first, or `snapshot` would hand back the pre-tick capture. Bumping the rev guarantees
   * the next `snapshot` re-exports from live state (a miss is always correct; only a false HIT would
   * be a bug, and the rev can only move forward).
   */
  invalidateSnapshot(user: string): void {
    this.bumpRev(user);
  }

  /**
   * 0065 (advance-warm) — the per-user NEXT-season warm orchestrator (wired into each sandbox's
   * `onNextSeasonWarm`). Generates/authors a fresh next-season cast into a DETACHED scratch adapter that
   * survives the cutover rotation, then DURABLY mirrors it onto the live sandbox so it survives an engine
   * restart too. The ACTIVE season is never read or mutated — the scratch is a standalone pre-game adapter.
   *
   * Idempotent: the scratch is created once per user and re-warmed idempotently (`preSeedCast` returns the
   * already-warmed cast on a seed-less re-call; an authoring call lands on the held cast). Rehydrates the
   * scratch from the live sandbox's durable mirror on the first call after a resume.
   */
  private warmNextSeason(user: string, req: PreSeedNextSeasonReq): PreSeedNextSeasonView {
    let scratch = this.nextSeasonScratch.get(user);
    if (!scratch) {
      scratch = new GameSessionAdapter();
      // Rehydrate from the durable mirror if an advance-warm was begun before a restart (so a resume
      // continues the same held cast rather than re-warming a different seed).
      const held = this.sandboxes.get(user)?.session.takeNextSeasonWarm();
      if (held) scratch.adoptHeldPrewarm(held);
      this.nextSeasonScratch.set(user, scratch);
    }
    const view = scratch.warmNextSeasonScratch(req);
    // Mirror the freshly-warmed (possibly authored) holding store onto the LIVE sandbox so it persists in
    // this sandbox's snapshot and survives an engine restart. CRUCIAL: this is NOT a gameplay beat — it
    // must NOT bump `beatSeq` (the closed-set sync counter the FE reconciles on) or run the non-degradation
    // checkpoint, or a BACKGROUND advance-warm would look like a board mutation to the player's client and
    // trip a phantom desync. So it does NOT route through `commit`: it sets the durable mirror, invalidates
    // the R3 snapshot cache (so the next read re-exports the mirror), and BLIND-saves (0030) — leaving the
    // active season's beatSeq + every player-facing projection byte-identical (the NO-EARLY-CUTOVER gate).
    const store = scratch.exportHeldPrewarm();
    const live = this.sandboxes.get(user);
    if (live && store) {
      live.session.holdNextSeasonWarm(store);
      this.invalidateSnapshot(user); // R3 — the durable mirror changed; the next export must recompute
      this.saveUser(user);           // durable save (0030) WITHOUT a beat bump / integrity checkpoint
    }
    return view;
  }

  /**
   * 0065 (advance-warm) — CAPTURE the held next-season cast at the START of the cutover, BEFORE the dead
   * sandbox is discarded. Prefers the live scratch buffer; falls back to the dead sandbox's durable mirror
   * (a resume that never re-warmed in this process still adopts the cast it warmed before the restart).
   * Always CONSUMES the scratch buffer (a partial/failed warm must not strand a stale store onto a later
   * season). Returns the captured store (or null), for `resetUser` to inject into the fresh sandbox.
   */
  private captureNextSeasonWarm(user: string): SessionSnapshot["nextSeasonWarm"] | null {
    const scratch = this.nextSeasonScratch.get(user);
    const store = scratch?.exportHeldPrewarm() ?? this.sandboxes.get(user)?.session.takeNextSeasonWarm() ?? null;
    this.nextSeasonScratch.delete(user);
    return store;
  }

  /**
   * Wire the per-user hooks every sandbox needs (B41/B58): the commit hook (checkpoint-then-save),
   * the live admin mirror, the REAL admin reset delegate, the ONE restart door for the player
   * channel, and the Vault-free health provider.
   */
  private wireHooks(user: string, sb: UserSandbox): void {
    const persist = (): void => {
      sb.syncAdmin(); // the admin's inspectable state tracks the live game (B58/E5)
      this.commit(user);
    };
    sb.session.setOnPersist(persist); // save-on-mutation (0030) / checkpoint-then-save (B41)
    sb.commands.setOnPersist(persist);
    // R-BND (#628): fail-soft FE-driven enrichments (0062 zeitgeist, 0070 off-screen texture) persist
    // DURABLY but must NOT bump the closed-set `beatSeq` or run the integrity checkpoint — they change
    // PROSE only, not the board, and a background bump would trip a phantom single-tab stale-409 (the
    // A-S3 fold-drop). So this mirrors the next-season-warm precedent: syncAdmin + invalidate the R3
    // snapshot cache (the durable mirror changed) + a blind save — never `commit`.
    sb.session.setOnBackgroundPersist((): void => {
      sb.syncAdmin();
      this.invalidateSnapshot(user);
      this.saveUser(user);
      // #1067 — a background enrichment replaced live state OUTSIDE the `commit` seam (e.g. the season-start
      // `recordCastProfile` authoring upgrade of the seeded-floor profile). RE-SEED the orchestrator's
      // non-degradation baseline to this freshly-saved state — the SAME `seedBaseline` discipline a
      // resume-from-disk uses (audit E6/R3) for a state set from outside `commit`. Without it the next
      // player-turn commit would compare the authored candidate against the STALE floor baseline and refuse
      // the turn as degradation (the #1067 live-verify losses). This never weakens non-degradation: the
      // background save already persisted a legitimate superset of the floor, and re-baselining only makes
      // FUTURE commits check against the richer authored state (strictly stronger going forward).
      this.onBackgroundCommit?.(user);
    });
    sb.admin.setResetDelegate(() => {
      this.resetUser(user); // the admin reset re-onboards the REAL game (B58/E5; B36/C12 route here)
    });
    // ONE sanctioned restart door (audit E1/D1/R1): a confirmed player-channel restart
    // (`createCharacter` + `confirmRestart` — the FE's reset path) converges on the SAME
    // `resetUser` the admin door uses — orchestrator baseline forgotten, dead season's saves
    // rotated, a clean sandbox — and season 2 is created THERE. Two doors, one hinge.
    sb.session.setOnRestart((req) => {
      const fresh = this.resetUser(user);
      // 0104 — the DIEGETIC opt-in (R4): the player returns as the SAME character (`carriesNotoriety`,
      // set by the adapter from `keepCharacter`) ⇒ carry their accumulated NOTORIETY into the new cast's
      // day-one reads. A NEW character carries NOTHING ⇒ `seedFirstImpressions` is byte-identical (the
      // clean slate). Per-user read (R3): `read(user)` returns ONLY this physical user's own reputation,
      // never another user's. `resetUser` (above) already derived + accumulated the DEAD season's
      // notoriety, so a returning player's reputation reflects the season they just finished.
      if (req.carriesNotoriety) fresh.session.setNotoriety(this.notorietyStore.read(user));
      return fresh.session.createCharacter(req);
    });
    // 0065 (advance-warm) — the NEXT-season warm routes to the registry-level holding store (the running
    // sandbox can't host it; it's discarded at the cutover). The scratch buffer + durable mirror live
    // here; `createCharacter`/`resetUser` adopt it at the cutover. The ACTIVE season is never touched.
    sb.session.setOnNextSeasonWarm((req) => this.warmNextSeason(user, req));
    sb.admin.setHealthProvider(() => this.healthProvider?.(user) ?? null);
    // L38: the God-Mode "fast-forward to finale (debug)" lever DRIVES the live session to a crowned
    // winner (auto-resolving the player's pendings with legal defaults) so the post-season Vault
    // retrospective (0048) opens through its own gate. Vault-free by construction — the session
    // returns only the public summary (winner NAME, weeks, placement); it reads no Vault, and each
    // driven beat commits through the SAME checkpointed `onPersist` a live decision does.
    sb.admin.setFastForwardProvider(() => sb.session.advanceToFinale());
    // ADR 0006: the FE settings switch flips the in-game clock at runtime through this Vault-free delegate
    // — a process-global override on the engine adapter (no restart). The composition layer is the legal
    // seam to reach the adapter (the OUTWARD admin surface never imports it; dependency-cruiser holds).
    sb.admin.setTimeOfDayDelegate((enabled) => GameSessionAdapter.setTimeOfDayEnabled(enabled));
    // B2 (2026-07-05 activation lane): the God-Mode dial for the "living house" behavioral-fidelity
    // layers — a per-sandbox delegate reaching THIS user's session, exactly like `setFastForwardProvider`
    // above (never the static/process-global pattern `setTimeOfDay` uses, since campaigns/trajectories/
    // juryHouse are per-session instance state — `setBehavioralFlags` itself owns the fan-out to whichever
    // mechanism each individual flag actually uses).
    sb.admin.setBehavioralFlagsDelegate((flags) => {
      // Remember only the fields actually named (absent ⇒ untouched), so a rebuilt sandbox keeps the dial.
      const named = Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined)) as BehavioralFlags;
      this.behavioralFlagsByUser.set(user, { ...(this.behavioralFlagsByUser.get(user) ?? {}), ...named });
      sb.session.setBehavioralFlags(flags);
    });
    sb.admin.setBehavioralFlagsProvider(() => sb.session.behavioralFlagsSnapshot());
    // 0016: God-Mode `configure` / `overrideMechanic` reach the LIVE session through this per-sandbox, Vault-free delegate (counts only).
    sb.admin.setLiveKnobsDelegate((knobs) => {
      this.adminConfigByUser.set(user, { ...(this.adminConfigByUser.get(user) ?? {}), ...knobs });
      const r = sb.session.applyAdminKnobs(knobs);
      if (r.applied.length) {
        this.liveKnobsByUser.set(user, { ...(this.liveKnobsByUser.get(user) ?? {}), ...Object.fromEntries(r.applied.map((k) => [k, knobs[k]])) });
      }
      return r;
    });
    const rememberedKnobs = this.liveKnobsByUser.get(user);
    if (rememberedKnobs) sb.session.applyAdminKnobs(rememberedKnobs);
    const rememberedConfig = this.adminConfigByUser.get(user);
    if (rememberedConfig) sb.admin.restoreConfigProjection(rememberedConfig);
    // A rebuilt sandbox (LRU resume / rollback restore) re-applies this user's remembered dial.
    const rememberedFlags = this.behavioralFlagsByUser.get(user);
    if (rememberedFlags) sb.session.setBehavioralFlags(rememberedFlags);
    sb.syncAdmin();
  }

  /** The user's isolated sandbox — created on first use, RESUMED from durable storage on return. */
  sandboxFor(user: string): UserSandbox {
    let sb = this.sandboxes.get(user);
    if (!sb) {
      sb = buildUserSandbox(user);
      if (this.saveStore?.hasSave(user)) {
        const snap = this.saveStore.loadLatest(user);
        // Resume from the durable save — but an incompatible/corrupt snapshot must REJECT into a fresh
        // sandbox (B40/B35), never crash the resume. The bad save is left on disk for inspection.
        if (snap) {
          try {
            importSnapshot(sb, snap); // resume instead of fresh setup (the welcome-overlay fix)
          } catch {
            // G12: a refused resume may already have flooded the shared soul-index lane
            // (`rebuildSoulIndex` runs before the part that threw) — drop the dead graph's
            // queued embeds so they never crowd the fresh sandbox's.
            sb.engine.soul.discardPending();
            // PERS-NEW-2 (#592): a future/incompatible-version save PARSES fine, so the corrupt belt
            // never quarantines it — and the fresh sandbox's saves would then prune the user's own
            // higher-schema save out of retention. Quarantine it off the live version path so it
            // survives, recoverable on a downgrade. (Only on incompatibility — a different resume
            // throw is a genuine fault we leave in place for inspection.)
            if (!snapshotCompatible(snap)) this.saveStore?.quarantineIncompatible?.(user);
            sb = buildUserSandbox(user);
          }
        }
      }
      this.wireHooks(user, sb);
      this.sandboxes.set(user, sb);
      this.bumpRev(user); // R3 — a freshly built/resumed object graph; never reuse a prior life's cache
    } else {
      // LRU touch (R4): Map iteration is insertion-ordered — re-inserting keeps the oldest first.
      this.sandboxes.delete(user);
      this.sandboxes.set(user, sb);
    }
    this.unloadIdle(user);
    return sb;
  }

  /**
   * Idle-sandbox LRU unload (audit R4): resident sandboxes were never evicted — +1.6MB RSS per
   * user, permanently. With a durable store, a sandbox provably rebuilds from its save, so beyond
   * `maxResident` the least-recently-used ones are saved and dropped from memory; their next
   * request resumes from disk. Without a store nothing unloads (an in-memory game has no disk to
   * come back from). The engine is synchronous through every mutation, so an unload can never
   * interleave a half-applied turn.
   */
  private unloadIdle(current: string): void {
    if (!this.saveStore) return;
    while (this.sandboxes.size > this.maxResident) {
      const next = this.sandboxes.entries().next().value;
      if (next === undefined || next[0] === current) return; // never unload the sandbox being served
      this.saveUser(next[0]); // park the latest state before dropping the object graph
      // G12: the parked graph's queued soul-index work is derived state for indexes about to be
      // garbage (the resume re-derives them) — drop it from the shared breathing lane.
      next[1].engine.soul.discardPending();
      this.sandboxes.delete(next[0]);
      // R3 — release the unloaded user's cached export (it pins the whole event log in RAM) and its
      // rev; a later resume rebuilds the sandbox (rev bumps) and re-exports fresh.
      this.snapshotCache.delete(next[0]);
      this.rev.delete(next[0]);
    }
  }

  /**
   * The per-mutation commit hook. By default it is a blind save-on-mutation (0030). When the runtime
   * wires the orchestrator (B41/audit E3), `setCommit` routes it through a checkpoint-then-save so the
   * fail-closed integrity check (0031) runs on EVERY player turn, not just watcher ticks.
   */
  private commitDelegate?: (user: string) => void;

  /** Route per-mutation persistence through a checkpointed commit (the orchestrator's player-turn). */
  setCommit(fn: (user: string) => void): void {
    this.commitDelegate = fn;
  }

  /** Invoked after every mutation (the wired `onPersist`): the orchestrator's commit, or a blind save. */
  private commit(user: string): void {
    // R3 — a mutation just landed: the cached export (if any) is now stale. Bump BEFORE the delegate
    // re-exports the candidate, so this commit's candidate caches at the new rev and the cache can
    // never hand back a snapshot older than the live state.
    this.bumpRev(user);
    // 0065 Part A — the single commit funnel both adapters route their `onPersist` through: bump the
    // session's monotonic beat counter ONCE per committed mutation, BEFORE the delegate exports the
    // candidate snapshot (so the new value is persisted). A commit the integrity checkpoint then
    // refuses is rolled back via `restore(baseline)`, which resets the counter from the baseline
    // snapshot — so a refused/failed commit never leaves the counter advanced.
    this.sandboxes.get(user)?.session.bumpBeatSeq();
    if (this.commitDelegate) this.commitDelegate(user);
    else this.saveUser(user);
  }

  /** Persist the user's current sandbox to durable storage (a no-op without a store). A caller
   *  that already exported the snapshot passes it (R3) — never re-serialize the same state. */
  saveUser(user: string, snap?: SessionSnapshot): void {
    const sb = this.sandboxes.get(user);
    if (sb && this.saveStore) this.saveStore.saveFor(user, snap ?? exportSnapshot(sb));
  }

  /**
   * The user's full in-memory snapshot (session core + engine detail). Orchestrator/0031.
   * R3 — reuse the last export while no mutation has landed (same `rev`): the candidate/baseline/
   * off-screen-tick/poll exports of a quiet stretch all return ONE immutable object, so the O(events)
   * serialization runs once per real change and `toGameState`'s identity memo hits. The cached object
   * is a point-in-time capture, only ever read — a stale entry is impossible (the rev advances ahead
   * of any re-export). `sandboxFor` runs first (it may resume/replace the sandbox, which resets rev).
   */
  snapshot(user: string): SessionSnapshot {
    const sb = this.sandboxFor(user);
    const rev = this.rev.get(user) ?? 0;
    const events = sb.engine.events.count();
    const cached = this.snapshotCache.get(user);
    if (cached && cached.rev === rev && cached.events === events) return cached.snap;
    const snap = exportSnapshot(sb);
    this.snapshotCache.set(user, { rev, events, snap });
    return snap;
  }

  /**
   * Replace the user's sandbox with a CLEAN one rebuilt from a snapshot — used to
   * roll back a failed integrity checkpoint (0031) without leaving the aborted
   * advance's events behind. The durable save is untouched by this call.
   */
  restore(user: string, snap: SessionSnapshot): UserSandbox {
    // G12: the rolled-back graph's queued soul-index work dies with it — the clean rebuild
    // below re-floods the shared lane from the snapshot, breathing (one embed per macrotask).
    this.sandboxes.get(user)?.engine.soul.discardPending();
    const sb = buildUserSandbox(user);
    importSnapshot(sb, snap);
    this.wireHooks(user, sb);
    this.sandboxes.set(user, sb);
    this.bumpRev(user); // R3 — the sandbox object graph was replaced; any cached export is stale
    return sb;
  }

  /** The users with a live in-memory sandbox (the watcher iterates these). */
  usernames(): string[] {
    return [...this.sandboxes.keys()];
  }

  /** Number of distinct user sandboxes currently held (concurrency visibility). */
  userCount(): number {
    return this.sandboxes.size;
  }

  /**
   * The ONE sanctioned restart door (audit E1/D1/R1): start a fresh game for the user — replaces
   * ONLY their own sandbox (others untouched). Both restart surfaces converge here (the admin's
   * `manageSandbox("reset")` delegate and the player channel's confirmed `createCharacter`), and
   * the reset is COMPLETE: the dead season's durable saves rotate off the live path (so an engine
   * restart can never resurrect it — R1) and the orchestrator forgets its baseline/faults/health
   * via `onReset` (so season 2's first commit isn't a "degradation" against a finished season — E1).
   */
  resetUser(user: string): UserSandbox {
    // 0104 — DERIVE + accumulate the dead season's NOTORIETY BEFORE the sandbox is dropped (this is the
    // only point the finished season still exists — the same cutover `captureNextSeasonWarm` rides). It
    // reads ONLY the dead season's OPEN-SET outcome (placement / comp wins / eviction roles / jury reach
    // — no Vault handle, R1), accumulates monotonically into the per-USER store (R3 — keyed to this
    // physical user, never a cross-user read), and is BEST-EFFORT/FAIL-SOFT: a failure to record
    // notoriety must NEVER block the season cutover or the next game (it is wrapped + swallowed). A
    // season that did not actually finish yields no outcome ⇒ nothing accumulated.
    try {
      const outcome = this.sandboxes.get(user)?.session.openSetOutcome();
      if (outcome) this.notorietyStore.accumulate(user, deriveNotoriety(outcome));
    } catch { /* notoriety is a retention nicety — never let it wedge a reset */ }
    // G12: the dead season's queued (derived) soul-index work must not crowd the shared
    // breathing lane the new season seeds through — discard it with the sandbox it served.
    this.sandboxes.get(user)?.engine.soul.discardPending();
    // 0065 (advance-warm) — CAPTURE any held next-season cast BEFORE the dead sandbox is dropped (the
    // scratch buffer lives here; the durable mirror rides on the dead sandbox still in the map). This is
    // the cutover the advance-warm was prepared for. Captured now; injected onto the fresh sandbox below.
    const advanceWarm = this.captureNextSeasonWarm(user);
    this.saveStore?.resetUser?.(user); // rotate the dead season's saves off the live path (R1)
    this.onReset?.(user); // invalidate the orchestrator's baseline/health/rng for this user (E1)
    const sb = buildUserSandbox(user);
    this.wireHooks(user, sb);
    // 0065 (advance-warm) — ADOPT the captured cast onto the FRESH (clean, pre-game) sandbox so the
    // immediately-following `createCharacter` ships the warmed (FE-authored) cast. The fresh sandbox's
    // own durable mirror starts clean — the advance-warm is consumed exactly once at its cutover.
    if (advanceWarm) sb.session.adoptHeldPrewarm(advanceWarm);
    this.sandboxes.set(user, sb);
    this.snapshotCache.delete(user); // R3 — free the dead season's pinned export before season 2
    this.bumpRev(user); // R3 — a fresh season's clean sandbox; any cached export is dead-season state
    return sb;
  }

  /** Reset hook (E1): the runtime wires this to `Orchestrator.forgetUser`. */
  private onReset?: (user: string) => void;

  setOnReset(fn: (user: string) => void): void {
    this.onReset = fn;
  }

  /** Background-commit hook (#1067): the runtime wires this to `Orchestrator.seedBaseline` so a
   *  fail-soft background enrichment (e.g. the season-start cast-authoring upgrade) re-seeds the
   *  non-degradation baseline to the freshly-saved state — exactly like a resume-from-disk. */
  private onBackgroundCommit?: (user: string) => void;

  setOnBackgroundCommit(fn: (user: string) => void): void {
    this.onBackgroundCommit = fn;
  }

  /** Vault-free per-user health (B58/E5+E6) — composed by the runtime over the orchestrator. */
  private healthProvider?: (user: string) => unknown;

  setHealthProvider(fn: (user: string) => unknown): void {
    this.healthProvider = fn;
  }

  /** A Vault-free channel resolver for the HTTP transport (keeps the outward layer Vault-free). */
  resolver(): (channel: "player" | "admin", user: string) => McpServer {
    return (channel, user) => {
      const sb = this.sandboxFor(user);
      return channel === "player" ? sb.mcp.player : sb.mcp.admin;
    };
  }
}
