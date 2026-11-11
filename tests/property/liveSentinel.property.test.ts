import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { toolsFor } from "../../src/surfaces/tools/registry";
import type { McpServer } from "../../src/adapters/mcp/McpServer";
import type { AdvanceView } from "../../src/ports/GameSession";
import { PLAYER, npc } from "../../src/domain/ids";
import { answerPending } from "../../features/support/answerPending";

/**
 * Feature B42 / audit E8 — the sentinel canary must bite the LIVE game. The old sweep ran against a
 * STANDALONE adapter disconnected from the fixture, so the session tools (advanceGame, gameStatus,
 * getGameState, runCompetition, the finale, …) could never fire it. This wires the sweep to the same
 * object graph the resolver serves, plants sentinels into the live hidden state (NPC backstory + soul
 * text + souls + hidden events + Vault + NPC knowledge + the NPC memory ledger + the NPC belief store), and proves NO player/admin tool — across the
 * whole game including the finale — ever returns one. HARD rule: roles only — no names.
 */

/** Plant a unique sentinel into every kind of hidden state the live game holds; return them all. */
function plantLiveSentinels(reg: GameSessionRegistry, user: string, seed: number): string[] {
  const sb = reg.sandboxFor(user);
  // Both hidden NPC stores below are LIVE in the shipped game: the memory ledger (ORWELL_NPC_MEMORY + _STANDALONE + _WRITERS, default ON) and the belief
  // store (ORWELL_NPC_BELIEFS, read by ORWELL_NPC_BELIEF_NOMS, ON for the playtest). Turn every flag ON explicitly so the sweep plays the shipped
  // configuration regardless of the process env, and so the engine really READS (and rewrites) the planted rows while the game runs.
  sb.session.setNpcMemoryEnabled(true);
  sb.session.setNpcMemoryStandaloneEnabled(true);
  sb.session.setNpcMemoryWritersEnabled(true);
  sb.session.setNpcBeliefsEnabled(true);
  sb.session.setNpcBeliefNomsEnabled(true);
  // B44: the OPT-IN #2017 layers are turned ON as well, so the engine genuinely reads (and rewrites) the planted assurance ledger and told ledger while the sweep plays - a hidden store that
  // is planted but never consulted proves nothing. Each is a flag-off feature today; the canary has to be ready BEFORE any of them is flipped.
  sb.session.setAssurancesEnabled(true);
  sb.session.setLobbyingEnabled(true);
  sb.session.setVoteCountEnabled(true);
  sb.session.setVetoMemoryEnabled(true);
  sb.session.setDealNomsEnabled(true);
  sb.session.setCampaignMemoryEnabled(true);
  sb.session.setCopresenceEnabled(true);
  let n = 0;
  const sentinels: string[] = [];
  const mk = (tag: string): string => { const s = `SENTINEL-B42-${tag}-${seed}-${++n}`; sentinels.push(s); return s; };

  // (1) The generated house's HIDDEN string fields — the typed hidden elements (B50) + soul
  // memory — via snapshot→restore (the engine-side post-process of CharacterFactory output).
  // NOTE (B61): `background` is a curated PUBLIC facet (the narrator's voice anchor, projected
  // on the houseguest card by design) — the hidden material lives in `hiddenElements`.
  const core = sb.session.snapshot();
  for (const hg of core.house!.npcs) {
    hg.character.hiddenElements.push({ kind: "secret-motive", detail: mk("hidden") });
    hg.soul.memory.push(mk("soul"));
  }
  // (1b) The NPC MEMORY LEDGER (0024) and the NPC BELIEF STORE (#2017) — both ENGINE-ONLY season state on `LiveSeasonState` (`npcMemory`, `beliefs`). The ledger is
  // structured (kind / week / severity — no free text) and the belief claim's only free-text field is `nature`, so the sentinel rides the fields a leaky projection would
  // actually serialise: the ledger entry's `kind` (cast — there is no engine write path for free text; the real writers `remember` / `recordRumorClaim` take enums) and the
  // claim's `id` + `nature` + `kind`. Injected into the snapshot the same way the soul/hidden strings above are (`remember` / `beliefNomTiltFor` are private). Each row sits beside
  // a REAL-kind row so the engine genuinely consumes this holder's memory/beliefs in nominations and votes, and the sentinel rows are built to SURVIVE the ledger cap (a
  // future-dated, severity-1 entry never decays or evicts) and the belief compaction (confidence 1.0 is never the lowest) for the whole season.
  const live = core.live!;
  const ledger = (live.npcMemory ??= {});
  const store = (live.beliefs ??= {});
  const npcs = core.house!.npcs;
  npcs.forEach((hg, i) => {
    if (i % 2 === 1) return; // "some NPCs": every other houseguest holds the planted memory + belief
    const other = npcs[(i + 1) % npcs.length]!.id;
    const memTag = mk("memory");
    const row = (ledger[hg.id] ??= {});
    for (const subject of [other, PLAYER]) {
      (row[subject] ??= []).push(
        { kind: "nominated-by-hoh", week: live.week, severity: 0.6 },
        { kind: memTag as never, week: 9_999, severity: 1 },
      );
    }
    const claimTag = mk("belief");
    const rumorTag = mk("rumor");
    (store[hg.id] ??= []).push(
      { id: `${hg.id}|targets-me|${other}|${claimTag}|${live.week}`, holder: hg.id, kind: "targets-me", subject: other, object: hg.id, value: true, origin: "told", nature: claimTag, confidence: 1, week: live.week },
      { id: `${hg.id}|heard-rumor|${PLAYER}||${rumorTag}`, holder: hg.id, kind: "heard-rumor", subject: PLAYER, value: true, origin: "gossip", nature: "betrayal", source: other, confidence: 1, week: live.week },
    );
  });
  // (1c) B44 - the casual-assurance LEDGER (`live.assurances`, ENGINE-ONLY): its only free-text field is the row `id`, so the sentinel rides it (the engine resolves rows by id, so it is consumed
  // for real). One open 'safe' row per planted-memory holder, beside a normal row.
  const assuranceTag = mk("assurance");
  const asr = (live.assurances ??= { seq: 0, items: [] });
  npcs.forEach((hg, i) => {
    if (i % 2 === 1) return;
    const to = npcs[(i + 1) % npcs.length]!.id;
    asr.items.push({ id: i === 0 ? assuranceTag : `asr:planted-${i}`, from: hg.id, to, kind: "safe", week: live.week, sincerity: 1, source: "npc", status: "open" });
  });
  asr.seq = asr.items.length;
  sb.session.restore(core); // also rebuilds the soul recall index from the (now sentinel-bearing) memory
  // (1d) B44 - the B10/B11 co-presence TOLD ledger (engine-private; the fact id is the only free text). Planted AFTER the restore so a restore that rebuilds the ledger from the snapshot cannot wipe it.
  const toldTag = mk("told");
  sb.session.copresenceToldLedger().record(npcs[0]!.id, toldTag, PLAYER, "held");
  sb.session.copresenceToldLedger().record(npcs[0]!.id, toldTag, npcs[1]!.id, "held");

  // (2) The engine's hidden layer the player/admin projections must never surface.
  sb.engine.events.record({ id: `b42:hidden:${seed}`, ts: 9_000_000, type: "conversation", initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: `off-screen ${mk("event")}` });
  sb.engine.soul.recordToSoul(npc(1), mk("soulstore"));
  sb.engine.vault.writeHidden({ id: `b42:vault:${seed}`, kind: "confessional", content: mk("vault") });
  sb.engine.knowledge.seedBelief(npc(2), { content: mk("npcknow"), factId: `b42k:${seed}` }, "witnessed"); // another NPC's private knowledge
  // B44: with the co-presence layer ON, a houseguest's private fact may be told to the player by a legitimate scene pathway (that is the feature). The canary's claim is that a fact the holder DECIDED
  // TO HOLD never crosses, so record that decision in the told ledger for every possible listener: npc(2) holds `b42k` for the player and every NPC, and the sentinel must still never surface.
  for (const listener of [PLAYER, ...npcs.map((h) => h.id)]) if (listener !== npc(2)) sb.session.copresenceToldLedger().record(npc(2), `b42k:${seed}`, listener, "held");
  return sentinels;
}

const args = (name: string, seed: number): Record<string, unknown> => {
  switch (name) {
    case "getMomentPrompt": return { moment: "nominations" };
    case "getVisibleStateFor": return { entity: PLAYER };
    case "renderScene": return { mode: "scene" };
    case "socialRead": return { houseguest: npc(1) };
    case "askProducers": return { question: "is anyone working against me?" };
    case "recordInteraction": return { initiator: PLAYER, witnessSet: [PLAYER, npc(1)], content: "a chat" };
    case "runCompetition": return { type: "endurance" };
    case "surfaceInformationTo": return { entity: PLAYER, fact: { content: "x" }, pathway: "told-by:npc:1" };
    case "diaryRoom": return { entry: "my private read" };
    case "noteMessage": return { messageId: "sentinel-msg-1" }; // per-message clock lever: a non-empty id
    case "makeDeal": return { with: npc(1), kind: "safety", terms: "we ride together" };
    case "formAlliance": return { name: "The Test Alliance", members: [npc(1), npc(2)] }; // 0107
    case "joinAlliance": return { allianceId: "alliance:nope" }; // 0107 Phase B (no such pitch ⇒ null, never throws)
    // 0075: press a houseguest to confide — the returned content (whatever tier, even a fabricated
    // lie) must NEVER carry a planted sealed sentinel; the engine only ever discloses the secret it
    // chose + recorded, blurred/glossed to the tier, and a lie is engine-authored, not a real secret.
    case "confide": return { npcId: npc(1) };
    // 0129 slice 3: a juror id (the engine returns null while no jury exists; the per-beat sweep below asks every REAL juror).
    case "askJuror": return { jurorId: npc(1) };
    // 0095: accuse a pair of a prior connection. The sweep plants no seeded tie between npc(1)/npc(2),
    // so this exercises the MISS path (no sealed tie ⇒ no Vault read) — the result must never carry a
    // planted sealed sentinel either way (a hit would only ever echo the tie's own public nature/names).
    case "accuseTie": return { aId: npc(1), bId: npc(2) };
    // 0094: confront a houseguest over a learned belief. The sweep plants no player-held fact with this
    // id, so `confront` returns null (the Vault bright line — a non-learned belief is never minted); the
    // sweep proves the null return itself carries no sentinel.
    case "confront": return { npcId: npc(1), factId: `b42-no-such-fact:${seed}` };
    // 0093/0099: wield a secret. The sweep plants no learned fact, so a real factId would be rejected
    // (harmless) — instead exercise the BLUFF path (a fabricated claim that reads NOTHING from the Vault):
    // the result must NEVER carry a planted sealed sentinel (a bluff invents a claim; it never crosses a secret).
    case "exposeSecret": return { bluff: true, subject: npc(1) };
    case "tradeSecret": return { bluff: true, subject: npc(1), toNpcId: npc(2) };
    // B65: voice the NPC who HOLDS adjacent secrets — their soul/hidden-element/Vault sentinels and
    // every OTHER houseguest's knowledge sentinel must still never cross (the per-NPC bound).
    case "npcVoice": return { id: npc(1) };
    // 0051: portrait prompts are built from PUBLIC facets only — sweep them with a real id, and
    // record an image beat (a player-witnessed, Vault-free event) — neither may carry a sentinel.
    case "getPortraitPrompt": return { id: npc(1) };
    // PREMIERE meet-everyone (#380): mark a houseguest met — the returned reads carry PUBLIC facets
    // only, so no soul/hidden/Vault sentinel may cross (it's also a no-op once past the premiere).
    case "markHouseguestMet": return { id: npc(1) };
    // ADR 0009: record a narrated NPC relocation — a houseguest id + a room name. The result is a
    // Vault-free HouseguestMoveResult ({status, whereabouts}); no hidden state may cross.
    case "moveHouseguest": return { id: npc(1), room: "kitchen" };
    case "recordImageBeat": return { houseguestId: npc(1), imageRef: "img-ref" };
    // 0065: the FE authoring write-back (live house — the season is already running here) + the pre-warm
    // (a no-op refusal once started). Both are Vault-free by construction; the sweep proves the canary
    // never bites their outputs either.
    case "recordCastProfile": return { houseguestId: npc(1), biography: "A two-sentence public backstory. It has presentable parts." };
    // #544: the FE cast-identity write-back — a DESCRIPTIVE-only proposal on the live house. The sweep
    // folds it (validate/repair/re-ground/re-seal a private orientation) and proves the result
    // ({accepted, applied}) never echoes a soul/Vault/private-orientation sentinel.
    case "recordCastIdentity": return { facets: { [npc(1)]: { ethnicity: "Korean American", orientation: "gay", out: false, age: 41 } } };
    case "preSeedCast": return { seed: 1 };
    // 0062: the FE zeitgeist write-back — PUBLIC real-world flavor only (no Vault, no game input).
    // The sweep proves the canary never bites its output (an empty subset is a valid capture).
    case "recordWorldSnapshot": return { slices: {} };
    case "recordDaySummary": return { day: 1, text: "A quiet day in the house." };
    // 0070: the FE texture write-back addresses a planted HIDDEN off-screen event by id and writes
    // voiced prose — content-only. Point it at the real sentinel-bearing hidden event so the sweep
    // exercises the live write path; its result is a bare {ok} status that never echoes hidden content.
    case "recordOffscreenSceneTexture": return { eventId: `b42:hidden:${seed}`, content: "voiced off-screen prose" };
    // #1400: the FE competition-fiction write-back — presentation-only flavor over the fixed roll. Valid
    // shape so the arg-guard passes; an empty eliminations is rejected (no comp match), and the result is
    // a bare {accepted, reason} status that never echoes hidden content. `competitionStagingView` (the
    // read) takes no args (default {}) and carries only public names + the public drop order.
    case "recordCompetitionFiction": return { comp: "hoh-competition", week: 1, theme: "t", premise: "p", eliminations: [] };
    case "overrideMechanic": return { mechanic: "pace", value: 1 };
    case "configure": return { temperature: 1 };
    case "manageSandbox": return { action: "save" }; // never "reset" — that would wipe the sentinels
    default: return {};
  }
};

describe("B42 — the sentinel canary bites the live game (production path)", () => {
  it("no player or admin tool leaks a sentinel — across the whole game incl. the finale", async () => {
    let totalJurorsTold = 0;
    for (const seed of [2, 5]) {
      const reg = new GameSessionRegistry();
      const user = `u${seed}`;
      const player = reg.resolver()("player", user) as McpServer;
      const admin = reg.resolver()("admin", user) as McpServer;

      await player.callTool("createCharacter", { playerName: "The Player", seed });
      // #1400: exercise the generative-competition projections ON — so `competitionStagingView` returns
      // the fixed drop order mid-comp and the canary proves that Vault-free public presentation carries
      // no planted sentinel (the write-back result is a bare status; both are swept below).
      reg.sandboxFor(user).session.setGenCompetitionsEnabled(true);
      const sentinels = plantLiveSentinels(reg, user, seed);
      const swept = new Set<string>();

      // The canary only bites if the sentinels are GENUINELY in the live hidden state. Prove it: every
      // planted marker is present engine-side (house souls + the hidden event/Vault/soul/knowledge)…
      const engineSide = JSON.stringify(reg.sandboxFor(user).session.snapshot())
        + JSON.stringify(reg.sandboxFor(user).engine.events.queryAll())
        + JSON.stringify(reg.sandboxFor(user).engine.soul.soulOf(npc(1)))
        + JSON.stringify(reg.sandboxFor(user).engine.knowledge.knownTo(npc(2)))
        + JSON.stringify(reg.sandboxFor(user).engine.vault.readHidden())
        + JSON.stringify(reg.sandboxFor(user).session.copresenceToldLedger().snapshot()); // B44: the told ledger is engine-private state outside the snapshot on this branch
      for (const s of sentinels) expect(engineSide.includes(s), `seed ${seed}: ${s} was not actually planted`).toBe(true);
      // …and the memory ledger + belief store are planted AND the layers that read them are ON (the shipped config), so the game really consumes them.
      expect(sentinels.filter((s) => s.includes("-memory-")).length, "memory-ledger sentinels were planted").toBeGreaterThan(0);
      expect(sentinels.filter((s) => s.includes("-belief-") || s.includes("-rumor-")).length, "belief-store sentinels were planted").toBeGreaterThan(0);
      expect(reg.sandboxFor(user).session.npcMemoryEnabledNow(), "the NPC memory layer is ON").toBe(true);
      // B44: the assurance ledger + the told ledger are planted and the opt-in layers that read them are ON.
      expect(sentinels.filter((s) => s.includes("-assurance-")).length, "assurance-ledger sentinel was planted").toBeGreaterThan(0);
      expect(sentinels.filter((s) => s.includes("-told-")).length, "told-ledger sentinel was planted").toBeGreaterThan(0);
      expect(reg.sandboxFor(user).session.copresenceEnabledNow(), "the co-presence layer is ON").toBe(true);

      // ADR 0019 Layer 2 — the moment prompt now carries each PRESENT houseguest's OWN knowledge under a
      // labelled per-NPC block ("WHAT EACH HOUSEGUEST IN THE ROOM LEGITIMATELY KNOWS"). That is a
      // SANCTIONED, per-NPC-scoped surface — the SAME Vault-free knowledge `npcVoice(thatNPC)` already
      // returns to voice them, just baked in eagerly for the present houseguests (see the ADR's testability
      // note: a token witnessed only by B deliberately appears in `renderGameContext` under B's block).
      // So the sweep EXCISES that block before the sentinel scan: the `npcknow` sentinel (npc(2)'s own
      // witnessed knowledge) may legitimately ride it, exactly as it may ride `npcVoice(npc:2)`. Everything
      // else stays checked — the block only ever carries the knowledge layer (`knows`/`suspects`), so a
      // soul / hidden-element / hidden-event / Vault sentinel can never hide inside it (those are planted in
      // the soul/Vault/event layers, never the knowledge layer). The excision is TIGHT (header + its
      // indented continuation lines only), so any leak OUTSIDE the block — including an NPC's knowledge
      // surfacing in the roster/whereabouts prose, or on any non-prompt tool — is still caught.
      const excisePresentKnowledgeBlock = (prompt: string, marker: string): string => {
        const lines = prompt.split("\n");
        const start = lines.findIndex((l) => l.startsWith(marker));
        if (start < 0) return prompt;
        let end = start + 1;
        while (end < lines.length && /^\s/.test(lines[end]!)) end++;
        return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
      };
      // #1735 (A4): `getMomentPrompt` now also carries a SEPARATE `hardConstraints` field — the terminal
      // block meant to ride as the caller's own last message. It restates the SAME sanctioned per-
      // present-NPC knowledge (never a new source), under its own "KNOWLEDGE SCOPE" header, so it needs
      // the identical excision before the sentinel scan (the `npcknow` sentinel legitimately rides it,
      // exactly as it rides the `systemPrompt` block above and `npcVoice(npc:2)`).
      const scrubMomentPrompt = (result: Record<string, unknown>): Record<string, unknown> => {
        const out: Record<string, unknown> = { ...result };
        if (typeof out.systemPrompt === "string") {
          out.systemPrompt = excisePresentKnowledgeBlock(out.systemPrompt, "- WHAT EACH HOUSEGUEST IN THE ROOM LEGITIMATELY KNOWS");
        }
        if (typeof out.hardConstraints === "string") {
          out.hardConstraints = excisePresentKnowledgeBlock(out.hardConstraints, "- KNOWLEDGE SCOPE");
        }
        return out;
      };
      // ADR 0019 Layer 3 — `knowledgeScopeManifest` is FE-guard support: it deliberately hands the
      // front-end the "who-legitimately-knows-what" manifest (bounded facts + their holder names) so the
      // guard can DROP any narration in which a houseguest voices a fact no pathway gave them. It reads the
      // KNOWLEDGE layer only (`engine.knowledge`, the SAME outward-safe layer `npcVoice.knows` projects —
      // NEVER the Vault/soul), so the `npcknow` sentinel (npc(2)'s own witnessed knowledge) may legitimately
      // ride it, exactly as it rides `npcVoice(npc:2)`. Every OTHER sentinel class — soul, hidden element,
      // hidden event, Vault confessional — is planted OUTSIDE the knowledge layer and must still NEVER cross.
      const KNOWLEDGE_LAYER_TAG = "-npcknow-";
      const playerHoldsThroughPathway = (sentinel: string): boolean =>
        reg.sandboxFor(user).engine.knowledge.knownTo(PLAYER).some((f) => f.content.includes(sentinel) && /^(told-by:|overheard)/.test(f.pathway));
      const sentinelsFor = (name: string): string[] =>
        name === "knowledgeScopeManifest" ? sentinels.filter((s) => !s.includes(KNOWLEDGE_LAYER_TAG)) : sentinels;
      // askJuror may legitimately relay the JUROR's own knowledge layer (same as npcVoice) — the npcknow sentinel is exempt.
      const sweep = async (server: McpServer, name: string): Promise<void> => {
        swept.add(name);
        const result = await server.callTool(name, args(name, seed));
        // getMomentPrompt's systemPrompt + hardConstraints both carry the sanctioned per-present-NPC
        // knowledge block; excise both before the sentinel scan.
        const scrubbed = (name === "getMomentPrompt" && result && typeof result === "object")
          ? scrubMomentPrompt(result as Record<string, unknown>)
          : result;
        const blob = JSON.stringify(scrubbed);
        // A tool must return a JSON value — `undefined` crashed this sweep (#1901) and hid the rest.
        expect(blob, `seed ${seed}: tool ${name} returned undefined (no JSON) — unscannable`).toBeTypeOf("string");
        for (const s of sentinelsFor(name)) expect(blob.includes(s), `seed ${seed}: tool ${name} leaked ${s}`).toBe(false);
      };

      // Every NON-progression tool, with all houseguests still living (recordInteraction/makeDeal etc.).
      // raiseSpectatorChoice (E-1) legitimately REFUSES for a player with no spectator seat — its refusal text is still sentinel-checked.
      for (const t of toolsFor("player")) {
        if (t.name === "advanceGame" || t.name === "submitDecision") continue;
        if (t.name === "raiseSpectatorChoice") {
          swept.add(t.name);
          let payload: string;
          try { payload = JSON.stringify(await player.callTool(t.name, args(t.name, seed))); } catch (err) { payload = String(err instanceof Error ? err.message : err); }
          for (const sn of sentinels) expect(payload.includes(sn), `seed ${seed}: tool ${t.name} leaked ${sn}`).toBe(false);
        } else await sweep(player, t.name);
      }
      for (const t of toolsFor("admin/God Mode")) await sweep(admin, t.name);

      // Drive the loop to a winner, sweeping the live projections at EVERY beat — including the finale.
      let finished = false;
      const jurorPlanted = new Set<string>();
      let jurorsTold = 0;
      for (let i = 0; i < 6000 && !finished; i++) {
        const adv = (await player.callTool("advanceGame", {})) as AdvanceView;
        swept.add("advanceGame");
        for (const s of sentinels) expect(JSON.stringify(adv).includes(s), `seed ${seed}: advanceGame leaked ${s}`).toBe(false);
        // E19: the per-beat re-sweep includes the knowledge-bearing reads (npcVoice/socialRead/
        // whereabouts/seasonRecap) — they were previously swept only at week 1, before the house
        // evolved any hidden history worth leaking.
        for (const name of ["gameStatus", "getGameState", "getMomentPrompt", "playerTagline", "socialInitiatives", "getVisibleStateFor", "finaleView", "npcVoice", "socialRead", "whereabouts", "seasonRecap", "competitionStagingView"]) await sweep(player, name);
        // 0129: once the player holds a juror's seat, ask EVERY real juror (the canary must exercise askJuror's
        // output, not skip it) and scan what they tell — it may carry only the juror's own knowledge layer. A benign
        // marker is planted in each juror's OWN knowledge so a telling really happens (told ⇒ the marker, nothing else).
        const jh = ((await player.callTool("getGameState", {})) as { juryHouse?: { jurors: { id: string }[] } }).juryHouse;
        for (const j of jh?.jurors ?? []) {
          if (!jurorPlanted.has(j.id)) {
            jurorPlanted.add(j.id);
            reg.sandboxFor(user).engine.knowledge.seedBelief(j.id, { content: `JUROR-OWN-MARK ${j.id}`, factId: `b42j:${seed}:${j.id}` }, "witnessed");
          }
          const told = await player.callTool("askJuror", { jurorId: j.id });
          swept.add("askJuror");
          if ((told as { told?: boolean } | null)?.told) jurorsTold++;
          const blob = JSON.stringify(told);
          for (const s2 of (j.id === npc(2) ? sentinelsFor("knowledgeScopeManifest") : sentinels)) expect(blob.includes(s2), `seed ${seed}: askJuror leaked ${s2}`).toBe(false);
        }

        // Finale projection lock (no pre-reveal tally): while the finale stages, no winner crosses, and
        // the precomputed votes / script are never serialized — only the reveals shown so far.
        if (adv.finale && !adv.finished) {
          expect(adv.winner, `seed ${seed}: a finale winner leaked before the reveal`).toBeNull();
          const fjson = JSON.stringify(adv.finale);
          expect(/"votes"|"script"|"tally"|"lean"/i.test(fjson), `seed ${seed}: the finale tally/script leaked`).toBe(false);
        }

        if (adv.pending) {
          swept.add("submitDecision");
          const p = adv.pending;
          if (p.kind === "nominations") await player.callTool("submitDecision", { kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
          else if (p.kind === "veto-decision") await player.callTool("submitDecision", { kind: "veto-decision", use: false });
          else if (p.kind === "replacement") await player.callTool("submitDecision", { kind: "replacement", replacement: p.options[0]!.id });
          else if (p.kind === "finale-statement") await player.callTool("submitDecision", { kind: "finale-statement", statement: "I earned this." });
          else if (p.kind === "finale-answer") await player.callTool("submitDecision", { kind: "finale-answer", appeal: p.appeals![0]! });
          else if (p.kind === "juror-vote") await player.callTool("submitDecision", { kind: "juror-vote", vote: p.options[0]!.id });
          else await player.callTool("submitDecision", { kind: p.kind, vote: p.options[0]!.id });
        }
        finished = adv.finished;
      }
      expect(finished, `seed ${seed}: the game reached a winner`).toBe(true);
      // The memory + belief canaries must still be IN the live hidden state at the finish (not evicted / compacted / dropped), else the late sweeps proved nothing.
      const liveAtEnd = JSON.stringify(reg.sandboxFor(user).session.snapshot().live ?? null);
      for (const s of sentinels.filter((x) => /-(memory|belief|rumor)-/.test(x))) expect(liveAtEnd.includes(s), `seed ${seed}: ${s} did not survive in the live state to the finish`).toBe(true);
      totalJurorsTold += jurorsTold;

      // E19: one FULL post-finish sweep — every tool against the terminal house, where a season's
      // worth of hidden history exists to leak. Exclusions are principled, not convenient:
      //  - seasonRetrospective is the SANCTIONED post-season unsealing (0048) — it returns hidden
      //    content by design once the game is finished;
      //  - advanceGame was swept at every single beat above;
      //  - createCharacter/updateCasting are the start-of-game doors (swept pre-game) — calling
      //    them again would restart the sandbox and void the terminal state under sweep.
      // submitDecision is swept IN-LOOP when a decision arises; it is ALSO swept here (post-finish it
      // simply refuses — and the refusal text is sentinel-checked), so a player evicted early enough
      // to never reach an in-loop decision (a legitimate, fair loss — calibration-dependent) still
      // covers it. (It previously assumed the player always reaches a decision point.)
      const POST_FINISH_EXCLUDED = new Set(["seasonRetrospective", "advanceGame", "createCharacter", "updateCasting"]);
      // Action tools may deliberately REFUSE on a terminal house (e.g. recordInteraction naming an
      // evicted houseguest) — a refusal is a legitimate outcome, but its error text is still an
      // outward surface: it must be sentinel-free too.
      const sweepOrRefuse = async (server: McpServer, name: string): Promise<void> => {
        swept.add(name);
        let payload: string;
        try {
          const result = await server.callTool(name, args(name, seed));
          // ADR 0019 Layer 2 / #1735: excise the sanctioned per-present-NPC knowledge block from both
          // getMomentPrompt fields.
          const scrubbed = (name === "getMomentPrompt" && result && typeof result === "object")
            ? scrubMomentPrompt(result as Record<string, unknown>)
            : result;
          payload = JSON.stringify(scrubbed);
        } catch (err) {
          payload = String(err instanceof Error ? err.message : err); // the refusal text is the outward surface
        }
        expect(payload, `seed ${seed}: post-finish ${name} returned undefined (no JSON) — unscannable`).toBeTypeOf("string");
        for (const s of sentinelsFor(name)) {
          // B44: an NPC's private fact may legitimately reach the player through a RECORDED in-game pathway (a juror relays their knowledge through askJuror, a houseguest tells the player): then the
          // player's knowledge layer holds it with a told/overheard pathway, and any surface that voices "what the player already holds" may carry it. Anything WITHOUT such a recorded pathway is a leak.
          if (s.includes(KNOWLEDGE_LAYER_TAG) && playerHoldsThroughPathway(s)) continue;
          expect(payload.includes(s), `seed ${seed}: post-finish ${name} leaked ${s} ... ${payload.slice(Math.max(0, payload.indexOf(s) - 400), payload.indexOf(s) + 150)}`).toBe(false);
        }
      };
      for (const t of toolsFor("player")) if (!POST_FINISH_EXCLUDED.has(t.name)) await sweepOrRefuse(player, t.name);
      for (const t of toolsFor("admin/God Mode")) await sweepOrRefuse(admin, t.name);

      // Coverage: every player AND admin tool name was actually swept against the live graph.
      const allNames = [...toolsFor("player"), ...toolsFor("admin/God Mode")].map((t) => t.name);
      for (const name of allNames) expect(swept.has(name), `tool ${name} was never swept`).toBe(true);
    }
    // The canary must actually EXERCISE askJuror's output (a telling happened), not merely call it.
    expect(totalJurorsTold, "askJuror told at least once across the sweep seeds").toBeGreaterThan(0);
  });
});

/**
 * #1727 (A1, P0) — the source-confirmed live carrier: `renderGameContext`'s player line used to emit
 * `view.player.archetype`/`strategyStyle` RAW, labelled "public persona" — but those fields resolve to
 * `persona.archetype`/`persona.strategyStyle`, the player's SEALED casting self-description (their own
 * words, including the hidden strategic layer), when the interview recorded one. Measured live (GLM-4.7,
 * reasoning-off): NPCs voiced the sealed profession back 4/8 runs. This sentinel proves the fix holds —
 * a distinctive, sealed persona string never enters `getMomentPrompt`'s `systemPrompt` OR the new
 * `hardConstraints` block, on the FIRST turn or any later one.
 */
describe("#1727 (A1) — the sealed casting persona never enters the narration prompt", () => {
  it("a distinctive personaArchetype/personaStrategyStyle never appears in getMomentPrompt, any turn", async () => {
    const reg = new GameSessionRegistry();
    const user = "u-1727";
    const player = reg.resolver()("player", user) as McpServer;
    const SENTINEL_ARCHETYPE = "SENTINEL-1727-camp-counselor-network-of-spies";
    const SENTINEL_STRATEGY = "SENTINEL-1727-deeply-strategic-underneath-the-surface";
    await player.callTool("createCharacter", {
      playerName: "The Player",
      seed: 111,
      personaArchetype: SENTINEL_ARCHETYPE,
      personaStrategyStyle: SENTINEL_STRATEGY,
    });

    const sweepPrompt = async (): Promise<void> => {
      const mp = (await player.callTool("getMomentPrompt", {})) as { systemPrompt: string; hardConstraints?: string };
      expect(mp.systemPrompt.includes(SENTINEL_ARCHETYPE), "systemPrompt leaked the sealed persona archetype").toBe(false);
      expect(mp.systemPrompt.includes(SENTINEL_STRATEGY), "systemPrompt leaked the sealed persona strategy").toBe(false);
      if (mp.hardConstraints) {
        expect(mp.hardConstraints.includes(SENTINEL_ARCHETYPE), "hardConstraints leaked the sealed persona archetype").toBe(false);
        expect(mp.hardConstraints.includes(SENTINEL_STRATEGY), "hardConstraints leaked the sealed persona strategy").toBe(false);
      }
    };

    await sweepPrompt(); // the premiere turn — the highest-traffic turn in the audit's tape
    // A handful of further live turns — the pre-fix carrier rode EVERY moment prompt, not just finalize.
    for (let i = 0; i < 8; i++) {
      await player.callTool("advanceGame", {});
      await sweepPrompt();
    }
  });
});

/**
 * #1735 (A4) / #1732 (A3) — the terminal HARD-CONSTRAINTS block is a SEPARATE, additive field
 * (`MomentPromptView.hardConstraints`) the caller appends as its own last message. This structurally
 * proves it actually carries what the issues specify: scene occupancy, a present-NPC pronoun lock, and
 * the per-present-NPC knowledge scope — not just that it exists.
 */
describe("#1735 (A4) / #1732 (A3) — the terminal HARD-CONSTRAINTS block carries its three pins", () => {
  it("carries occupancy, a pronoun lock, and knowledge scope for a present houseguest", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("u-1735");
    sb.session.createCharacter({ playerName: "The Player", seed: 212 });
    sb.session.advanceGame(); // close the premiere champagne circle → ordinary free-roam whereabouts

    let presentId: string | null = null;
    for (let i = 0; i < 12 && !presentId; i++) {
      const wa = sb.session.whereabouts();
      if (wa && wa.present.length) { presentId = wa.present[0]!.id; break; }
      const dest = wa?.nearby.find((n) => n.present.length)?.room ?? wa?.nearby[0]?.room;
      if (!dest) break;
      sb.session.movePlayer(dest);
    }
    expect(presentId, "the scene must have a present houseguest to exercise the pins").not.toBeNull();

    const npcRow = sb.session.snapshot().house!.npcs.find((n) => n.id === presentId)!;
    sb.engine.knowledge.seedBelief(npcRow.id, { content: "SENTINEL_1735_KNOWLEDGE_SCOPE", factId: "hc:1735" }, "witnessed");

    const mp = sb.session.getMomentPrompt({});
    expect(mp.hardConstraints, "a live turn with a present houseguest must carry a terminal block").toBeDefined();
    const hc = mp.hardConstraints!;
    expect(hc.startsWith("HARD CONSTRAINTS")).toBe(true);

    // Occupancy pin (#1735 item 1): the present houseguest is named, imperatively, as who's with the
    // player, and the block forbids placing anyone else.
    expect(hc).toContain(npcRow.name);
    expect(/do NOT[\s\S]*place[\s\S]*voice[\s\S]*any other houseguest/i.test(hc)).toBe(true);

    // Knowledge scope (#1735 item 1): the freshly-planted fact rides the terminal block too.
    expect(hc).toContain("KNOWLEDGE SCOPE");
    expect(hc).toContain("SENTINEL_1735_KNOWLEDGE_SCOPE");

    // Pronoun lock (#1732): asserted when the present NPC carries a genderPresentation facet (the
    // diversity floor guarantees one on a fresh deterministic-floor cast).
    if (npcRow.character.genderPresentation) {
      expect(hc).toContain(`PRONOUN LOCK: ${npcRow.name} uses`);
    }
  });

  it("is absent pre-game (no game started yet)", () => {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("u-1735-pre");
    const mp = sb.session.getMomentPrompt({});
    expect(mp.hardConstraints).toBeUndefined();
  });
});

/**
 * A3 (0133 Sprint-2 item) - the sentinel canary must also bite the SPECTATOR / DIGEST path. A player evicted before the jury forms chooses `watch`; the engine then
 * runs whole player-less weeks and surfaces a condensed `weekDigests` projection (HOH / nominees / veto / evictee), and raises the finale interview at the end.
 * Plant sentinels into every kind of hidden state at the moment of the spectator choice and prove no read or advance in watch mode - including the digests and the
 * finale-interview card - ever returns one. Seeds are SEARCHED (the balance moves which seed evicts the player early). Roles only.
 */
describe("A3 - the sentinel canary bites the spectator / week-digest path (0133)", () => {
  it("watch mode: advanceGame, getGameState (weekDigests), gameStatus, the moment prompt and the finale interview never leak a sentinel", async () => {
    let exercised = false;
    for (let seed = 1; seed <= 60 && !exercised; seed++) {
      const reg = new GameSessionRegistry();
      const user = `u-a3-${seed}`;
      const player = reg.resolver()("player", user) as McpServer;
      await player.callTool("createCharacter", { playerName: "The Player", seed });
      // Auto-play until the player is evicted before the jury forms (the spectator-choice card).
      let card: AdvanceView["pending"] = null;
      for (let i = 0; i < 8000; i++) {
        const adv = (await player.callTool("advanceGame", {})) as AdvanceView;
        if (adv.pending?.kind === "spectator-choice") { card = adv.pending; break; }
        if (adv.pending) await player.callTool("submitDecision", answerPending(adv.pending) as unknown as Record<string, unknown>);
        if (adv.finished) break;
      }
      if (!card) continue;
      const sentinels = plantLiveSentinels(reg, user, seed);
      const leaks = (name: string, value: unknown): void => {
        const blob = JSON.stringify(value);
        for (const s of sentinels) expect(blob.includes(s), `seed ${seed}: spectator-path ${name} leaked ${s}`).toBe(false);
      };
      leaks("the spectator-choice card itself", card);
      await player.callTool("submitDecision", { kind: "spectator-choice", vote: "watch" });
      let digestsSeen = 0, interviewSeen = false, finished = false;
      for (let i = 0; i < 400 && !finished; i++) {
        const adv = (await player.callTool("advanceGame", {})) as AdvanceView & { weekDigests?: unknown[] };
        leaks("advanceGame", adv);
        const gs = (await player.callTool("getGameState", {})) as { weekDigests?: unknown[] };
        leaks("getGameState", gs);
        digestsSeen = Math.max(digestsSeen, gs.weekDigests?.length ?? 0, adv.weekDigests?.length ?? 0);
        leaks("gameStatus", await player.callTool("gameStatus", {}));
        leaks("getMomentPrompt", await player.callTool("getMomentPrompt", { moment: "social" }));
        if (adv.pending?.kind === "finale-interview") { interviewSeen = true; leaks("the finale-interview card", adv.pending); }
        if (adv.pending) await player.callTool("submitDecision", answerPending(adv.pending) as unknown as Record<string, unknown>);
        finished = adv.finished;
      }
      expect(finished, `seed ${seed}: the season finished in watch mode`).toBe(true);
      expect(digestsSeen, `seed ${seed}: the watch path actually produced week digests`).toBeGreaterThan(0);
      exercised = true;
      void interviewSeen; // the interview card is swept when it is raised (finale interview depends on the player not being a finalist)
    }
    expect(exercised, "a seed in 1..60 evicted the player before the jury formed").toBe(true);
  }, 600_000);
});
