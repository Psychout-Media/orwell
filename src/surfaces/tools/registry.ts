export type OutwardChannel = "player" | "admin/God Mode";

/**
 * A tool exposed to an outward channel. `readsVault` is the literal `false`: the
 * type itself forbids registering a Vault-reading tool in these registries, so
 * the capability allowlist cannot grow a Vault reader without a compile error.
 */
export interface ToolDescriptor {
  name: string;
  channel: OutwardChannel;
  readsVault: false;
  description: string;
}

export const PLAYER_TOOLS: readonly ToolDescriptor[] = [
  // Onboarding + per-moment narration framing (Vault-free game-session port).
  { name: "updateCasting", channel: "player", readsVault: false, description: "Record casting-interview answers as they land (0050) — any subset of fields, any number of times pre-game (notes accumulate). Returns where the interview stands: what's on file, what's missing, the engine-picked next step, and whether casting is ready to finalize." },
  { name: "createCharacter", channel: "player", readsVault: false, description: "End the casting interview and start the season (0050): finalizes from everything updateCasting recorded (args may fill gaps or override; the recorded name is required). Returns the Vault-free game state with the player's casting card." },
  { name: "getGameState", channel: "player", readsVault: false, description: "Current Vault-free game state: phase, the player's card, and the house roster (names)." },
  { name: "gameStatus", channel: "player", readsVault: false, description: "Vault-free public status for the status panel: week/phase/HOH/nominees/veto (ceremony-level facts only)." },
  { name: "stateDelta", channel: "player", readsVault: false, description: "WHAT CHANGED since your last beatSeq ({sinceBeatSeq}): the player-visible events appended, the ceremony field diffs (HOH/noms/veto/phase/week), and any finished/winner flip — plus the current board (0065 Part E). Vault-free and O(Δ). An unknown/too-old token returns { fullRefresh: true } (fetch getGameState instead); an up-to-date token returns an empty delta." },
  { name: "playerTagline", channel: "player", readsVault: false, description: "A snarky, state-aware one-line Big Brother hero tagline for the player (Vault-free; reflects current standing)." },
  { name: "finaleView", channel: "player", readsVault: false, description: "Vault-free projection of an in-progress finale for the finale panel: finalists, stage, and the votes revealed so far (null when no finale is staging)." },
  { name: "getMomentPrompt", channel: "player", readsVault: false, description: "The managed system prompt to inject for the current moment (persona + framing; Vault-free)." },
  { name: "recallSceneMemories", channel: "player", readsVault: false, description: "Feature #1394 — the 0–2 WITNESSED past moments involving the houseguest(s) the player is in a scene with ({withIds}), ranked by relevance to the scene cue ({cue}), for the narrator to reference ('you told me on day 3 you'd never write my name down'). Reads ONLY the player's visible projection — witnessed/journal-visible events, NEVER the Vault. FE-driven framing infra (the front-end weaves it into the moment prompt); returns { moments: [] } when there is no relevant history. Not a model lever." },
  { name: "getVisibleStateFor", channel: "player", readsVault: false, description: "Visible events + the player's own knowledge." },
  { name: "renderScene", channel: "player", readsVault: false, description: "Narrate a moment from the visible projection." },
  { name: "socialRead", channel: "player", readsVault: false, description: "Honest, Vault-free read of the room or a houseguest; may hint, never names off-screen events." },
  { name: "socialInitiatives", channel: "player", readsVault: false, description: "Which houseguests want to approach the player now (relationship-driven; names + a coarse motive category (bond | probe) the narrator voices in its own words — never a number)." },
  { name: "whereabouts", channel: "player", readsVault: false, description: "Where the player stands in the house (0049): their room, who is in it, and who is in each room within SIGHTLINE (eyeshot — the open great room/yard or a hallway mouth; 0077 Phase 2) — names only, never motives, numbers, or rooms out of sight." },
  { name: "moveTo", channel: "player", readsVault: false, description: "The player WALKS to a room they named ({room}). Valid rooms: kitchen, living room, backyard, bedroom A, bedroom B, HOH room, bathroom, storage room (the diary room is its own beat). Name resolution is FORGIVING — case/space/hyphen-insensitive plus natural aliases (\"living room\"/\"lounge\", \"backyard\"/\"yard\", \"HOH\", \"pantry\"); a bare \"bedroom\" resolves to the player's own bedroom — so it never silently fails. The player is a person — they direct their own movement; call this whenever the player heads somewhere, then voice the new room from the returned whereabouts (the engine holds them there; NPCs move around them)." },
  { name: "premiereIntros", channel: "player", readsVault: false, description: "PREMIERE ONLY (#380): the meet-everyone progress — who the player has met and who is STILL to introduce before the first HOH, each with their OBSERVABLE public persona (archetype/strategy/background/age/presentation/demeanor — never the soul, a number, or how the player feels). While the staged entrances run, `complete` is false and `remaining` holds one anonymous placeholder per houseguest who has not arrived yet; from the toast on everyone is met. Null outside the premiere." },
  { name: "markHouseguestMet", channel: "player", readsVault: false, description: "PREMIERE ONLY (#380): mark a houseguest ({id}) as INTRODUCED/met the instant they have introduced their public self. Idempotent; the engine tracks who's met. First power becomes REACHABLE once a couple of genuine hot reads form and nobody is left invisible (0111) — you do NOT need every one of the 15 formally introduced first; the stragglers get met in motion. Returns the updated meet-everyone progress (null outside the premiere)." },
  { name: "moveHouseguest", channel: "player", readsVault: false, description: "Record a NARRATED houseguest relocation (ADR 0009): an NPC ({id}) walks to a room ({room}) the narration just sent them to, so the board agrees with the prose (no visible historic conflict). Open-set only — never perturbs seeded outcomes. Room resolution is forgiving (like moveTo); a no-op if they are already there; REFUSED (illegal) for the player (use moveTo), an unknown/evicted houseguest, or a non-walkable/unknown room. Primarily the front-end records this FROM the narration; the model need not call it directly." },
  { name: "seasonRecap", channel: "player", readsVault: false, description: "The season's public arc from the event record (0048): reigns, ceremonies, evictions, deals — Vault-free, stores not memory." },
  { name: "dailyRecap", channel: "player", readsVault: false, description: "0102 — the most recently CLOSED in-game day's 'day in review' digest (materialized once, at the turnIn that closed it): witnessed highlights + gossip already surfaced, plus an optional non-committal forward tease. Vault-free, reproducible; null before any day has closed. Usually delivered inline on turnIn's result — call this only to re-fetch it." },
  { name: "seasonRetrospective", channel: "player", readsVault: false, description: "POST-SEASON ONLY (0048): the finished season's unsealed hidden story — off-screen scheming, confessionals, the twists. Returns null while a season is live (gated on the terminal state in code)." },
  { name: "npcVoice", channel: "player", readsVault: false, description: "The knowledge-bounded voicing projection for ONE active houseguest (B65): persona + room/co-presence + what THEY legitimately know + hunches + organic stances (labels, never numbers). The model cannot voice what they never learned." },
  { name: "getPortraitPrompt", channel: "player", readsVault: false, description: "The Vault-free image-generation prompt for ONE houseguest's portrait (0051): built from PUBLIC appearance + authored storyline facets + the per-season photorealistic style anchor. Serves the live house, or pre-game the WARMED pre-seed cast (0065/ADR 0013 — the authored shoot reads the store as it stands). Null for an unknown id / no cast. No stat/soul/hidden element ever reaches the prompt." },
  { name: "askProducers", channel: "player", readsVault: false, description: "Direct interrogation; never confirms/denies Vault content." },
  { name: "endOfSessionSummary", channel: "player", readsVault: false, description: "Confirms only that updated save(s) exist." },
  // Action tools (0009): request in, Vault-free result out (engine performs them).
  // E20: `resolveCompetition` (caller-supplied stats + seed) is REMOVED — a second, seed-shoppable
  // resolver one call away from the player channel. `runCompetition` is the single outcome authority.
  { name: "recordInteraction", channel: "player", readsVault: false, description: "Record a player-witnessed interaction (the witness set must include the player); returns its id. Optionally pass { consequence } to propose the scene's shape: { edges } for whose opinion of the INITIATOR moves, and { aboutEdges: [{ holder, about, direction, emphasis }] } for the classic THIRD-PARTY pitch — 'I told Lorenzo that Maeve is the real threat' floats holder=Lorenzo's opinion of about=Maeve. Only honored for a holder actually IN the witness set (you can't move an off-screen opinion), and the game decides the amount — a pitch can land soft, hard, or backfire depending on how much the holder trusts you; it is never an auto-success." },
  { name: "runCompetition", channel: "player", readsVault: false, description: "PREVIEW the current competition beat's already-decided winner (the weekly loop crowns the same one when advanceGame resolves the beat — never a second resolver); returns the winner (name) plus the drawn comp's name/format/narrative scaffold — never a stat or score." },
  { name: "surfaceInformationTo", channel: "player", readsVault: false, description: "Move a hidden fact into knowledge via a recorded in-game pathway." },
  { name: "diaryRoom", channel: "player", readsVault: false, description: "Record a player Diary-Room entry: the player's own OOC knowledge, with no in-game pathway to any houseguest." },
  { name: "playerDossier", channel: "player", readsVault: false, description: "Your own Diary-Room reads, grouped per houseguest — your words only, never engine truth. Optionally pass {subjectId} to narrow to one houseguest." },
  { name: "playerReceipts", channel: "player", readsVault: false, description: "The Diary-Room screening room: candidate contradictions drawn ONLY from your own record (deals, votes, DR statements) — your words, never engine truth or hidden state." },
  { name: "advanceGame", channel: "player", readsVault: false, description: "Advance the weekly loop by one beat (HOH→noms→veto→ceremony→eviction→finale); stops and returns a pending decision when it's the player's turn to choose." },
  { name: "submitDecision", channel: "player", readsVault: false, description: "Resolve the player's pending binding decision — whatever kind the engine is blocked on; the pending decision itself names its kind and legal options — and continue the loop. (For a confirmed self-eviction (0061), submit { kind: 'self-evict', confirmed: true } — ONLY after the player's OWN explicit confirmation (their confirm card); never fire a confirmed self-evict off an in-character or unconfirmed line.)" },
  { name: "raiseSpectatorChoice", channel: "player", readsVault: false, description: "E-1: a WATCHING pre-jury evictee (0133) asks to switch to SKIP — re-raise the spectator-choice card so they confirm on the card (card-only binding intact; skip is irreversible, typed refusal in skip mode). FE-driven; the model never commits the choice itself." },
  { name: "requestSelfEviction", channel: "player", readsVault: false, description: "Step 1 of a player self-eviction (0061): the player expressed an OOC intent to LEAVE/quit. Raise the confirmation (names the irreversible stakes) and change NO state — the house never hears it, and nothing evicts until the player explicitly confirms via submitDecision({ kind:'self-evict', confirmed:true }). FE-driven; never call this off an in-character throwaway line." },
  { name: "cancelSelfEviction", channel: "player", readsVault: false, description: "Cancel a raised self-eviction confirmation (0061): the player decided to stay. Clears the confirmation; they remain ACTIVE and in the house, unchanged." },
  { name: "turnIn", channel: "player", readsVault: false, description: "The player's bedtime lever (ADR 0006): the player CHOOSES to turn in for the night. Ends their night where it stands (an early night ⇒ rested for tomorrow's comp; outlasting the house into late-night ⇒ running on empty) and rolls the house to the next morning. The player is never auto-slept — only this call retires them. The result may carry a Vault-free dailyRecap (0102) — the day that just closed, plus an optional non-committal forward tease — voice it as a short in-fiction beat when present, invent nothing when absent. FE-driven; a no-op when the clock isn't running." },
  { name: "hangOut", channel: "player", readsVault: false, description: "\"Hang out until X\" (flag ORWELL_HANGOUT, FE-driven from the player's intent to wait/chill/socialize until something happens): a bounded run (<= 8) of short 15-30 in-game-minute beats that stops at the FIRST of: the scheduled event coming due (the clock is clamped to it, so nothing fires early or is skipped), the player being pulled (diary room / production), an NPC approaching, something noteworthy observed, or bedtime. The engine decides the stop reason (stopReason + public detail); voice the passage of time briefly, then the stop. Flag off or clock off => ok:false, nothing changed." },
  { name: "noteMessage", channel: "player", readsVault: false, description: "FE-driven clock infra (not a model lever): announce ONE player message ({messageId}, the message's stable id) so the in-game clock bills one message-step (~5 minutes) per PLAYER MESSAGE, however many tool calls it makes - including a plain chat line with none. Idempotent per messageId (a retry bills nothing). Returns { accepted }." },
  { name: "makeDeal", channel: "player", readsVault: false, description: "Propose a deal to a houseguest (safety / vote / final-two / target-other). The ENGINE decides whether THEY agree, from their own read of the player: it returns the deal, or { refused: true, reason, narratable } - voice the refusal in character, never assume yes and never narrate a handshake that was not recorded. An agreed deal is a tracked promise; the engine reconciles it against later binding actions and a broken promise hurts. When the handshake names a term (\"this week only\", \"for two weeks\"), pass term: { weeks } (weeks counts the current week); if the term was left unspoken, term: { vague: true }. The ENGINE bounds it and owns how hard a break hurts — omit term for an ordinary deal." },
  { name: "formAlliance", channel: "player", readsVault: false, description: "Name an alliance with a set of houseguests (0107). Membership is bond-gated — those not close enough decline. Naming it cements the bloc and banks a little favor with the people in it." },
  { name: "joinAlliance", channel: "player", readsVault: false, description: "Accept an NPC's pitch and join an alliance they offered you (0107). Only a live pitch you're close enough to the founder for; pass the alliance id from gameStatus.alliancePitches." },
  { name: "confide", channel: "player", readsVault: false, description: "Feature 0075 — when the player presses an ALLY they're already in a 1:1 scene with to open up ('what's really going on with you?', 'you can tell me'), call confide({ npcId }). The ENGINE decides whether they actually open up, how much of their secret they share, and whether it's the truth or a lie — you never invent a confession. Returns { disclosed, tier, content }: VOICE the returned content as that houseguest confiding; if disclosed is false, play the deflection (they're not ready / change the subject). Never state a tier or whether it's true — judging that is the player's. npcVoice may carry a mayConfide hint that they're ready." },
  { name: "confront", channel: "player", readsVault: false, description: "Feature 0094 — when the player CONFRONTS a houseguest over something they LEARNED (a scheme, a betrayal-in-progress) that involves that houseguest, call confront({ npcId, factId }) with the learned fact's id. The ENGINE decides whether the outcome matches the player's belief or diverges from it — you never invent the outcome. Returns { landed }: on true, play the confrontation as the player expects; on false, it misfired — play the confronted houseguest's genuine, hurt/defensive reaction (NEVER say the player's information was wrong or state any reason). No number, no tell either way." },
  { name: "accuseTie", channel: "player", readsVault: false, description: "Feature 0095 — when the player presses a suspicion that two houseguests knew each other BEFORE the show ('you two knew each other before this, didn't you?'), call accuseTie({ aId, bId }). The ENGINE checks whether a real pre-show connection exists — you never invent or confirm one yourself. Returns { landed }: on true, voice the pair's reaction and the house's shift (never state WHY it's true, never a number); on false, it's just an ordinary wrong guess — play it as a normal social beat, with NO tell distinguishing a miss from a hit beyond the fiction. Rare — most pairs have no such tie." },
  { name: "exposeSecret", channel: "player", readsVault: false, description: "Feature 0093 — when the player OUTS a houseguest's secret they LEARNED, to the house ('everyone should know what they're hiding'), call exposeSecret({ factId }) with the learned fact's id (from the player's own knowledge). The ENGINE resolves the bounded fallout: it damages how the house reads the subject AND recoils on the player (outing is read as ruthless — the subject turns on them). Returns { exposed }: voice the house reeling, never a number. A non-learned secret is REJECTED. To BLUFF (out a secret the player did NOT learn — a gamble) pass { bluff: true, subject }: the engine never tells you whether the claim was actually true." },
  { name: "askJuror", channel: "player", readsVault: false, description: "Feature 0129 — ONLY while the player sits on the JURY: when they ask a fellow juror what they know ('what did you see in there?', 'who do you think is lying?'), call askJuror({ jurorId }). The ENGINE decides whether that juror tells (their regard for the player gates it) and WHICH single thing they share — only something THEY legitimately witnessed or were told. Returns { told, bearing, content }: if told, VOICE the content as that juror, in their own manner; if not, play the deflection (a closed face, 'not now'). Never invent what a juror knows; never state the bearing word as a number or a verdict. A juror has no way back into the house — nothing they say changes the live game." },
  { name: "tradeSecret", channel: "player", readsVault: false, description: "Feature 0099 — when the player TRADES a secret they LEARNED about a THIRD party to another houseguest for a one-off concession (a comp throw, a name for a name), call tradeSecret({ factId, toNpcId, askKind }). The ENGINE values the secret TO THE RECIPIENT (a rival's secret is gold to that rival's enemy, worthless to their ally) and decides whether they bite — the recipient now KNOWS the secret. Returns { accepted }: voice the deal, never a number. A non-learned secret is REJECTED. To bluff, pass { bluff: true, subject }. For a STANDING deal sweetened by a secret, use makeDeal with { leverage } (a secret about the partner) or { tradedSecret } (a secret about a third party) instead." },
  { name: "recordImageBeat", channel: "player", readsVault: false, description: "Record that an in-character image was shown to the player (0051) — a player-witnessed image-shown event so it has memory ('recorded or it didn't happen'). Returns its id." },
  // FE-driven authoring/pre-warm seams (0058/0065) — NOT model levers (the FE producer-LLM drives them).
  { name: "preSeedCast", channel: "player", readsVault: false, description: "FE-driven (0065): pre-warm the player-INDEPENDENT cast off the season seed BEFORE the casting interview ends, so the FE can deeply author it and the portrait prompts read the finished store. Returns the Vault-free roster + the cast portrait prompts; mints + persists the season seed (which createCharacter then adopts). Idempotent; durable. Not a model lever." },
  { name: "preSeedNextSeason", channel: "player", readsVault: false, description: "FE-driven (0065 advance-warm): pre-warm the NEXT season's cast DURING the current season's finale, off a NEW seed, into a per-user holding store that survives the cutover rotation (preSeedCast is refused mid-season; this is its mid-season counterpart). The ACTIVE season is untouched; the confirmed next-season cutover ADOPTS the held cast. Optionally deep-authors one held houseguest ({ profile }), like recordCastProfile. Returns the Vault-free roster + portrait prompts. Idempotent; durable. Not a model lever." },
  { name: "recordCastProfile", channel: "player", readsVault: false, description: "FE-driven write-back (0058/0065): seal one houseguest's authored §3 profile — the PUBLIC biography + structured physical facet (cross to the player) SPLIT from the HIDDEN secrets/true-goals/weakness/Day-1 read (Vault-sealed). Reports accepted field NAMES only, never a hidden value; refuses a player-mirroring profile. Lands on the pre-warmed cast pre-game, the live house once a season runs. Not a model lever." },
  { name: "recordCastIdentity", channel: "player", readsVault: false, description: "FE-driven write-back (#544, the AI half of the 0063 diversity floor): the FE producer-LLM PROPOSES the whole cast's DESCRIPTIVE identity facets ({ facets: { <id>: { ethnicity, genderPresentation, orientation, out, age } } }) targeting U.S.-population rates; the ENGINE validates + REPAIRS the proposal against the proportional targets (floors/caps), re-grounds skin tone from the FINAL heritage, folds the PUBLIC facets onto the byte-stable cast, and re-seals each PRIVATE orientation into the Vault. Never accepts a hidden game weight (the seeded Day-1 read / competition leans stay engine-owned). Calibration-neutral; idempotent; with no proposal the deterministic floor stands. Lands on the pre-warmed cast pre-game or the live house. Not a model lever." },
  { name: "recordCastGenesis", channel: "player", readsVault: false, description: "FE-driven write-back (0116, phase 2): the FE producer-LLM PROPOSES the whole 15-NPC SKELETON ({ npcs: [{ id, name, identity, archetype, vocation, hometown, demeanor, background, biography, presentation, stats:{physical,mental,social}, hiddenElements:[{kind,detail}] }], ties:[{a,b,nature}] }) steered by a seeded season brief and player-BLIND; the ENGINE validates it through the envelope it owns — banded stat clamp (no model number escapes), the cast-wide variance floor, name validators (uniqueness / plausibility / legacy-Bible deny-list / player-collision), the closed hidden-element kinds + C9 gates, tie-graph sanity, hidden-game-weight stripping — and folds the committed skeleton onto the PRE-WARMED cast (preSeedCast must have run). Identity is open-set (recorded faithfully); power is closed-set (engine-owned). Returns structured Vault-free violations for the bounded re-roll. Pre-game only; refused once a season runs. With no proposal the deterministic floor stands. Not a model lever." },
  { name: "recordWorldSnapshot", channel: "player", readsVault: false, description: "FE-driven write-back (0062): freeze the move-in zeitgeist — the PUBLIC, shared real-world flavor the whole cast moved in WITH (an optional subset of public slices: screen/music/sports/news/internet/mood). The FE owns the concrete web-search capture (like the 0051 image port); the engine persists it as the single FROZEN artifact and RECALLS it (never re-searches) all season. Empty slices keep the fallback's value (non-degradation). Public flavor only — no Vault, no game input. Not a model lever." },
  { name: "recordRoomCanon", channel: "player", readsVault: false, description: "FE-driven write-back (ORW-223): record one narrated texture feature of a known room ({roomId, feature}, at most 120 chars) as append-only canon, so the Show Brief can list it and later turns stay consistent. Rejects anything that is not a minor room detail (events, outcomes, secrets, places, devices, relationships, numbers). Vault-free; touches no hidden state. Not a model lever." },
  { name: "worldSnapshotView", channel: "player", readsVault: false, description: "BE-103: the Vault-free read of the frozen move-in zeitgeist (0062) — the same PUBLIC, shared real-world flavor recordWorldSnapshot captured (public slices + the off-screen-channel rendered block), so the narrator can weave it into the current moment. Null pre-game or when no snapshot was ever captured." },
  { name: "recordProducerProfile", channel: "player", readsVault: false, description: "FE-driven write-back (#1626, increment 3): DEEPEN the off-camera casting producer persona — author a richer backstory / temperament / disposition / wit / quirk (any subset; open-set public voice prose). The FE owns the utility-LLM authoring; the engine folds it onto the seeded producer as the source of truth, ACCUMULATING (a field the model omits keeps the seeded value; a later authoring never loses a facet). The seeded NAME is NEVER changed (the byline stays byte-stable). Vault-free by construction — no stat/number/hidden field is accepted, and any stat/soul vocabulary is stripped. Reports accepted field NAMES only; an empty/all-rejected payload leaves the seeded producer standing. Not a model lever." },
  // 0070: off-screen society texture enrichment — the FE voices prose for already-recorded hidden off-screen
  // scenes and writes it back. Vault-free (public participant ids + nature only out; prose only in).
  { name: "getOffscreenSceneSkeletons", channel: "player", readsVault: false, description: "0070: the Vault-free skeletons of the off-screen scenes recorded in the most recent tick — public participant ids, room, and nature only. The texture write-back (recordOffscreenSceneTexture) addresses these by id. Returns [] before a game starts or when no off-screen scenes have been recorded this tick. Not a model lever." },
  { name: "recordOffscreenSceneTexture", channel: "player", readsVault: false, description: "FE-driven write-back (0070): enrich the prose content of an already-recorded hidden off-screen scene with model-voiced texture. Content-only — cannot create events, alter witness sets, flip the hidden flag, or carry relationship numbers. Idempotent; fail-soft (absent driver ⇒ deterministic template stands). Not a model lever." },
  // #1400: generative competition design — the model authors each comp's theme/staging/per-round fiction
  // OVER the engine's ALREADY-FIXED roll. Vault-free (names + the public drop ORDER + public flavor).
  { name: "competitionStagingView", channel: "player", readsVault: false, description: "#1400 READ (FE-driven, flag-gated): the 'what to hand the model' projection for the currently-staging competition — comp/type/field/the FIXED winner/the FIXED drop order/the 0042 library scaffold — so the FE can author a theme + per-round fiction MATCHED to the already-decided outcome. Null unless generative competitions are enabled AND a comp has resolved its roll. Vault-free (names + the public drop ORDER, never a score/number). Not a model lever." },
  { name: "recordCompetitionFiction", channel: "player", readsVault: false, description: "#1400 WRITE-BACK (FE-driven, flag-gated): record the model-authored competition fiction (theme + premise + per-round elimination fiction) AFTER the roll commits. The engine VALIDATES (hard) that every elimination named maps to the fixed drop order EXACTLY; on any mismatch it is REJECTED and the deterministic 0042 library floor stands (the model can never rename who goes or in what order). Presentation-only — never perturbs the winner/order/any seeded roll. Not a model lever." },
];

export const ADMIN_TOOLS: readonly ToolDescriptor[] = [
  { name: "inspectNonVaultState", channel: "admin/God Mode", readsVault: false, description: "Inspect non-Vault game state." },
  { name: "overrideMechanic", channel: "admin/God Mode", readsVault: false, description: "Override a non-Vault mechanic in the sandbox; returns updated non-Vault state." },
  { name: "configure", channel: "admin/God Mode", readsVault: false, description: "Set non-Vault tunables (temperature/relationship config, reserve-twist COUNT — never twist content)." },
  { name: "manageSandbox", channel: "admin/God Mode", readsVault: false, description: "Sandbox lifecycle for this sandbox only (create | reset | save | load)." },
  { name: "sandboxHealth", channel: "admin/God Mode", readsVault: false, description: "Vault-free sandbox health (B58): week/phase, last advance, integrity status, recent faults, circuit state — metadata only, never game content." },
  { name: "advanceToFinale", channel: "admin/God Mode", readsVault: false, description: "DEBUG (L38): fast-forward THIS sandbox's live season to a crowned winner — drives the deterministic loop, auto-resolving the player's pending decisions with legal defaults, so the post-season retrospective (0048) unseals legitimately. Reads NO Vault; returns only a Vault-free summary (winner name, weeks played, the player's final placement)." },
  { name: "setTimeOfDay", channel: "admin/God Mode", readsVault: false, description: "ADR 0006: turn the in-game time-of-day clock + nightly sleep economy ON or OFF at runtime (the FE settings switch flips it here — no engine restart). { enabled: boolean }. A process-global override of the ORWELL_TIME_OF_DAY env default; resets on restart (the FE re-applies the persisted setting on boot). Vault-free." },
  { name: "setBehavioralFlags", channel: "admin/God Mode", readsVault: false, description: "B2: turn one or more 'living house' behavioral-fidelity layers ON or OFF at runtime — no engine restart. { campaigns?, trajectories?, triggers?, secretPacing?, juryHouse?, seededTieSurfacing?, mythMaking?, showrunner?: boolean } — each field optional; absent ⇒ that layer's current setting is untouched. Overrides the ORWELL_CAMPAIGNS/ORWELL_TRAJECTORIES/ORWELL_TRIGGERS/ORWELL_SECRET_PACING/ORWELL_JURY_HOUSE/ORWELL_SEEDED_TIE_SURFACING/ORWELL_MYTH_MAKING/ORWELL_SHOWRUNNER env defaults for this sandbox; resets on restart — a live-only operator dial (frontend/routes/admin_health_routes.py POST /api/admin/ops/behavioral-flags via orwell_engine.set_behavioral_flags, gap-audit G6/#1840), NOT a persisted setting re-applied on boot the way setTimeOfDay is. Every layer is calibration-proven-neutral-when-off. Vault-free." },
  { name: "getBehavioralFlags", channel: "admin/God Mode", readsVault: false, description: "B2: read the CURRENT resolved on/off state of every behavioral-fidelity flag (env default or a prior setBehavioralFlags override), so the admin dial can render truthfully. Vault-free." },
];

/**
 * A DEBUG tool that DELIBERATELY reads the Vault — the owner-ruled override of mandate #2 (admin/God
 * Mode is otherwise walled from the Vault). It is a SEPARATE type from `ToolDescriptor` ON PURPOSE: the
 * `readsVault: false` literal guard above stays intact for every normal tool, so a Vault reader can
 * ONLY ever live in the one quarantined, grep-able `DEBUG_VAULT_TOOLS` list below — never silently in
 * the player/admin allowlists. `channel` is pinned to admin/God Mode (never the player).
 */
export interface DebugVaultToolDescriptor {
  name: string;
  channel: "admin/God Mode";
  readsVault: true;
  description: string;
}

/**
 * The ONLY Vault-reading tools in the system — the owner-ruled DEBUG override of mandate #2. Admin/God-
 * Mode channel only, fired only behind an explicit FE "unseal", and kept OUT of the agent lever manifest
 * (`DEBUG_VAULT_TOOL_NAMES`). Adding anything here is a conscious decision to breach the Vault Wall for
 * an operator-debug surface; it must never reach the player channel.
 */
export const DEBUG_VAULT_TOOLS: readonly DebugVaultToolDescriptor[] = [
  { name: "producerVault", channel: "admin/God Mode", readsVault: true, description: "DEBUG — owner-ruled override of mandate #2: UNSEAL this sandbox's LIVE hidden Vault layer (off-screen scheming, NPC confessionals, secret threads/ties, the sealed reserve twists, and the real eviction ballots) for operator debugging, WITHOUT the post-season gate. The ONE live Vault reveal — admin only, fired behind an explicit FE 'unseal'. Returns the same scrubbed, name-resolved view as the post-season retrospective; null when no game exists." },
];

/** The debug Vault-reader tool names — quarantined from the agent lever manifest + the no-leak sweeps. */
export const DEBUG_VAULT_TOOL_NAMES: ReadonlySet<string> = new Set(DEBUG_VAULT_TOOLS.map((t) => t.name));

/**
 * The ADVERTISED Vault-free allowlist for a channel — UNCHANGED by the debug override. The producer's
 * vault (mandate #2 override) is DELIBERATELY NOT here: it is a separate, out-of-band debug capability
 * the admin channel dispatches by explicit name (see `DEBUG_VAULT_TOOLS` + `McpServer.allows`), never an
 * advertised tool. Keeping this list pure means every "admin allowlist is Vault-free" guarantee holds.
 */
export function toolsFor(channel: OutwardChannel): readonly ToolDescriptor[] {
  return channel === "player" ? PLAYER_TOOLS : ADMIN_TOOLS;
}

/**
 * Pure infrastructure, NOT game-driving levers — excluded from the agent's lever
 * manifest in the base game-master prompt (0018): `getMomentPrompt` supplies the
 * prompt itself, `endOfSessionSummary` just confirms a save exists.
 */
// (E20: resolveCompetition is gone from the channel entirely — runCompetition has been the single
// competition authority since B37; an un-advertised-but-callable second resolver was still a seam.)
const INFRA_LEVERS: ReadonlySet<string> = new Set(["getMomentPrompt", "endOfSessionSummary", "playerTagline", "finaleView", "getPortraitPrompt", "recordImageBeat",
  // Feature #1394: `recallSceneMemories` is FE framing infrastructure — the front-end weaves the
  // recalled witnessed moments into the moment prompt (like `getMomentPrompt`/`stateDelta`), NOT a
  // game-driving lever the GM model pulls. Excluded from the base prompt's lever manifest so the
  // manifest↔registry drift test stays green.
  "recallSceneMemories",
  // 0065 Part E: `stateDelta` is FE/harness infrastructure (the per-turn "what changed since" feed the
  // FE weaves into the moment context) — NOT a game-driving lever the model pulls. Excluded from the
  // base prompt's lever manifest so the manifest↔registry drift test stays green.
  "stateDelta",
  // 0058/0065: the cast pre-warm + authoring write-back are FE-driven seams (the producer-LLM authors
  // the cast, the FE pre-warms it before portraits), NOT game-driving levers the GM model pulls — so
  // they stay OUT of the base prompt's lever manifest (the manifest↔registry drift test stays green).
  // `preSeedNextSeason` (0065 advance-warm) is the same family: an FE-driven finale-day warm of the NEXT
  // season's cast into the holding store, never a GM lever.
  "preSeedCast", "preSeedNextSeason", "recordCastProfile",
  // #544 (the AI half of the 0063 diversity floor): `recordCastIdentity` is an FE-driven seam (the producer-
  // LLM proposes the cast's descriptive identity facets; the engine validates/repairs/folds), NOT a
  // game-driving lever the GM model pulls — so it stays OUT of the base prompt's lever manifest (the
  // manifest↔registry drift test stays green), exactly like recordCastProfile.
  "recordCastIdentity",
  // 0116 (model-authored cast genesis): `recordCastGenesis` is an FE-driven seam (the producer-LLM proposes
  // the whole cast skeleton; the engine validates/clamps/repairs/folds), NOT a game-driving lever the GM
  // model pulls — so it stays OUT of the base prompt's lever manifest, exactly like recordCastIdentity.
  "recordCastGenesis",
  // 0062: the move-in zeitgeist write-back is an FE-driven seam (the front-end owns the concrete
  // web-search capture and freezes it onto the season), NOT a game-driving lever the GM model pulls —
  // so it stays OUT of the base prompt's lever manifest (the manifest↔registry drift test stays green).
  "recordWorldSnapshot",
  // ORW-223: the room-canon write-back is an FE-driven seam (the front-end extracts a narrated room feature and writes it back), NOT a model lever - out of the base prompt manifest.
  "recordRoomCanon",
  // #1626 (increment 3): `recordProducerProfile` is an FE-driven seam (the FE utility-LLM authors a richer
  // producer persona; the engine folds it onto the seeded off-camera producer), NOT a game-driving lever
  // the GM model pulls — so it stays OUT of the base prompt's lever manifest, exactly like recordWorldSnapshot.
  "recordProducerProfile",
  // Clock-per-message (2026-11-05): `noteMessage` is FE clock infra (the front-end announces each player message so the clock bills one step per message) - NOT a model lever.
  "noteMessage",
  // 0061: `cancelSelfEviction` is the confirmation card's own Cancel action (FE-driven), NOT a model
  // lever. `requestSelfEviction` IS advertised (below): on a clear OOC intent the model raises the
  // confirmation — which changes NO state — and the player's explicit confirm (the card) is what binds.
  "cancelSelfEviction",
  // E-1: `raiseSpectatorChoice` re-opens the spectator-choice CARD for a watching evictee (FE-driven: the visible control / a skip-intent belt) — not a model lever.
  "raiseSpectatorChoice",
  // ADR 0006: `turnIn` is the FE-driven bedtime lever (the "head to bed" affordance that surfaces in
  // the late-night edge cases), NOT an always-on base-manifest model lever — so it stays OUT of the
  // base prompt's lever manifest (the manifest↔registry drift test stays green), like cancelSelfEviction.
  "turnIn",
  // "Hang out until X": FE-driven from the player's wait/chill intent (the FE calls it and hands the narrator the engine-decided stop reason), NOT a base-manifest model lever.
  "hangOut",
  // PREMIERE meet-everyone (#380): both are PREMIERE-only levers fully documented in the `premiere`
  // moment fragment (the meet-everyone flow + markHouseguestMet are spelled out there with their
  // who's-left list woven in), NOT always-on base-manifest levers — so they ride the moment, like
  // finaleView rides the finale. Excluding them keeps the base prompt untouched (drift test stays green).
  "premiereIntros", "markHouseguestMet",
  // ADR 0009: `moveHouseguest` records a NARRATED NPC relocation — primarily an FE/belt-driven lever
  // (the model narrates the open texture; the engine records it), NOT an always-on base-manifest model
  // lever, like `turnIn`. Excluding it keeps the base prompt untouched (the manifest↔registry drift test
  // stays green).
  "moveHouseguest",
  // 0070: off-screen society texture enrichment. Both tools are FE-driven (the hermes subagent voices prose
  // then writes it back); neither is a game-driving lever the GM model pulls — so they stay OUT of the base
  // prompt's lever manifest (the manifest↔registry drift test stays green).
  "getOffscreenSceneSkeletons", "recordOffscreenSceneTexture",
  // A0 knowledge-wall: `sealedFromHouse` is FE-guard support (the narration guard reads it to strip a
  // houseguest voicing the player's Diary-Room content), NOT a game-driving lever the GM model pulls —
  // so it stays OUT of the base prompt's lever manifest (the manifest↔registry drift test stays green).
  "sealedFromHouse",
  // ADR 0019 Layer 3: `knowledgeScopeManifest` is FE-guard support (the narration guard reads it to
  // drop a houseguest voicing a fact no pathway gave them), NOT a game-driving lever — so it stays OUT
  // of the base prompt's lever manifest, exactly like `sealedFromHouse`.
  "knowledgeScopeManifest",
  // BE-103: `worldSnapshotView` is the read counterpart of the FE-driven `recordWorldSnapshot` write-
  // back (0062) — background flavor context, not a game-driving decision lever the GM model pulls — so
  // it stays OUT of the base prompt's lever manifest, exactly like `recordWorldSnapshot` itself.
  "worldSnapshotView",
  // #1400: generative competition design — BOTH the staging READ and the fiction WRITE-BACK are FE-driven
  // seams (the FE producer-LLM authors the comp fiction over the engine's fixed roll and writes it back),
  // NOT game-driving levers the GM model pulls — so they stay OUT of the base prompt's lever manifest
  // (the manifest↔registry drift test stays green), exactly like `recordWorldSnapshot`/`worldSnapshotView`.
  "competitionStagingView", "recordCompetitionFiction"]);

/**
 * The game-driving player levers the agent should know how to pull. This is the
 * single source of truth the base prompt's lever manifest must stay in sync with
 * (0018) — the manifest↔registry drift test fails if any of these is unnamed.
 */
export const PLAYER_AGENT_LEVERS: readonly string[] =
  PLAYER_TOOLS.filter((t) => !INFRA_LEVERS.has(t.name)).map((t) => t.name);
