import type { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * Shared sentinel planting + per-tool argument table, extracted (ORW-299) from tests/property/liveSentinel.property.test.ts so the
 * player-perspective sentinel (tests/property/playerPerspective.property.test.ts) reuses the SAME planting instead of duplicating it.
 */

/** Plant a unique sentinel into every kind of hidden state the live game holds; return them all. */
export function plantLiveSentinels(reg: GameSessionRegistry, user: string, seed: number): string[] {
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
  // (1c-2) ORW-312 / 0145 - the NPC AGENDA (`live.agendas`, ENGINE-ONLY Vault-class): a resolved goal in a few houseguests' history carries the sentinel in its free-text `endNote` and in a cause `ref`
  // (the two string fields a leaky projection could echo). A played game keeps the history (append-only), so the sentinel survives the whole sweep.
  const agendaTag = mk("agenda");
  const agendas = (live.agendas ??= {});
  npcs.forEach((hg, i) => {
    if (i % 2 === 1) return;
    const target = npcs[(i + 1) % npcs.length]!.id;
    agendas[hg.id] = {
      owner: hg.id, goals: [], formedForWeek: 0,
      history: [{ id: `${hg.id}:week:get-them-out:${target}:d1`, owner: hg.id, horizon: "week", kind: "get-them-out", target, why: [{ kind: "memory", about: target, ref: agendaTag, weight: 1 }],
        test: { kind: "evicted", who: target }, commitment: 1, status: "failed", formedDay: 1, formedWeek: 1, resolvedDay: 1, endNote: agendaTag }],
    };
  });
  // (1c-3) ORW-314 / 0145 slice 2 - the agenda now DRIVES decisions, so a unique token rides a LIVE goal id (the engine consumes the goal for real in nominations / the veto / votes and copies its id into the
  // decision's real-reason record) and a planted stated-reason record's goal id + term name. The real reason, the goal, the terms and the candor are Vault-class: only a stated reason's kind + subject may
  // reach the narrator, so the token must be on NO player, prompt or admin surface.
  const goalIdTag = mk("agendagoal");
  const termTag = mk("reasonterm");
  const holder0 = npcs[0]!.id;
  agendas[holder0]!.goals.push({ id: goalIdTag, owner: holder0, horizon: "season", kind: "get-them-out", target: npcs[1]!.id, why: [{ kind: "memory", about: npcs[1]!.id, weight: 1 }], test: { kind: "evicted", who: npcs[1]!.id }, commitment: 1, status: "active", formedDay: 1, formedWeek: 1 });
  (live.statedReasons ??= []).push({
    week: live.week, day: 1, decider: holder0, decision: "nominate", public: true,
    real: { decision: "nominate", decider: holder0, choice: npcs[1]!.id, goalKind: "get-them-out", goalId: goalIdTag, terms: [{ name: termTag as never, value: 0.9 }], tactic: "direct" },
    stated: { kind: "nothing-personal", about: npcs[1]!.id, candor: "cover" },
  });
  // (1c-4) ORW-320 - the post-crown nightly reflections (`live.npcMindsAuthored.reflections`, Vault-class): a planted reflection must reach NO surface before the crown (the retrospective is the only reader, behind `finished`).
  const reflectionTag = mk("reflection");
  ((live.npcMindsAuthored ??= {}).reflections ??= {})[npcs[0]!.id] = [{ night: 1, text: reflectionTag }];

  // (1c-4) 0142 idea 4 - an NPC that WEIGHED breaking a deal: the temptation terms (a term NAME + a goal id) ride a `deal-break` why/stated record (never public, never voiced) and a `deal-renegotiate`
  // stated record (public while its offer stands: only its kind + subject may be voiced). The real reason, the goal and the terms are Vault-class and must reach no player, prompt or admin surface.
  const breakTerm = mk("dealbreakterm");
  const breakGoal = mk("dealbreakgoal");
  (live.decisionWhy ??= []).push({ kind: "deal-break", by: holder0, week: live.week, options: [{ option: PLAYER, role: "chosen", total: 0.4, terms: [[breakTerm, 0.4]] }] });
  for (const decision of ["deal-break", "deal-renegotiate"] as const) {
    live.statedReasons.push({
      week: live.week, day: 1, decider: holder0, decision, public: decision === "deal-renegotiate",
      real: { decision, decider: holder0, choice: PLAYER, goalKind: "get-them-out", goalId: breakGoal, terms: [{ name: breakTerm as never, value: 0.4 }] },
      stated: { kind: "nothing-personal", about: PLAYER, candor: "cover" },
    });
  }
  // (1e) ORW-305 - the NPC decision WHY record (`live.decisionWhy`, HIDDEN + ENGINE-ONLY): a unique token rides a breakdown's TERM NAME, its option REF and its tactic/rule, beside the real
  // records the engine appends every NPC decision. Nothing reads it back, so it persists whole for the season; no player, prompt or admin surface may carry any of the three.
  const whyTerm = mk("whyterm");
  const whyRef = mk("whyref");
  const whyRule = mk("whyrule");
  (live.decisionWhy ??= []).push({
    kind: "vote", by: npcs[0]!.id, week: live.week, tactic: whyRule, rule: whyRule,
    options: [
      { option: whyRef, role: "chosen", total: 0.5, terms: [[whyTerm, 0.5]], inputs: { [whyTerm]: 1 } },
      { option: npcs[1]!.id, role: "runner-up", total: 0.25, terms: [[`${whyTerm}-2`, 0.25]] },
    ],
  });
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

export const args = (name: string, seed: number): Record<string, unknown> => {
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
    case "callInFavor": return { npcId: npc(1) };
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
    // ORW-319: the cast-time model-words write-backs (validated closed sets, write-once; bare counts/status out).
    case "recordNpcTraits": return { traits: [{ id: npc(1), habits: ["gym-rat", "early-riser"], aimHint: "win-by-comps", aimWhy: "a former sprinter" }] };
    // ORW-320: a post-crown write-back; mid-season the engine refuses it (nothing stored, bare counts out).
    case "recordNpcReflections": return { reflections: [{ id: npc(1), night: 1, reflection: "I lay awake thinking about the week." }] };
    case "recordHouseCulture": return { spots: [{ room: "backyard", nickname: "the Deck" }], runningJoke: "the missing spatula" };
    case "recordDaySummary": return { day: 1, text: "A quiet day in the house." };
    case "recordRoomCanon": return { roomId: "kitchen", feature: "a worn butcher-block counter" };
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

