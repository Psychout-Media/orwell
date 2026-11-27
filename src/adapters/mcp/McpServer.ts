import { toolsFor, DEBUG_VAULT_TOOL_NAMES } from "../../surfaces/tools/registry";
import { EngineRefusal } from "../../domain/errors";
import { runInToolCall } from "../../ports/BeatCause";
import type { OutwardChannel, ToolDescriptor } from "../../surfaces/tools/registry";
import type { PlayerSurface } from "../../surfaces/player/PlayerSurface";
import type { AdminPort } from "../../surfaces/admin/AdminPort";
import type { SummaryService } from "../../services/SummaryService";
import type { EngineCommands, RecordInteractionReq, SurfaceReq, DiaryRoomReq, RecordImageBeatReq } from "../../ports/EngineCommands";
import type { EntityId } from "../../domain/ids";
import type { GameSession, ConfideResult, CreateCharacterReq, UpdateCastingReq, PreSeedCastReq, PreSeedNextSeasonReq, RecordCastProfileReq, RecordCastIdentityReq, RecordCastGenesisReq, RecordWorldSnapshotReq, RecordNpcTraitsReq, RecordNpcReflectionsReq, RecordHouseCultureReq, RecordGroupIdentityReq, RecordAllianceNameReq, RecordRoomCanonReq, RecordNarrationUseReq, RecordOpenLedgerReq, ResolveOpenLedgerReq, RecordLookExtrasReq, RecordProducerProfileReq, RecordCompetitionFictionReq, MomentPromptReq, RecallSceneMemoriesReq, RunCompetitionReq, SubmitDecisionReq, MakeDealReq, FormAllianceReq, JoinAllianceReq, RecordOffscreenSceneTextureReq, ExposeSecretReq, AskToTalkAloneReq, TradeSecretReq, BehavioralFlags, RecordDaySummaryReq, RecordEpisodeTitlesReq } from "../../ports/GameSession";


/** Tools that are deliberately NOT in the advertised player channel allowlist (out-of-band
 * dispatch-only), but which the player MCP channel must still route when called by name.
 * These are FE/narration-guard infra tools, not game-driving levers: they are unadvertised
 * (not in `listTools()`) but still reachable through `callTool()`. The pattern mirrors
 * `DEBUG_VAULT_TOOL_NAMES` for the admin channel, but these are Vault-free player-infra tools,
 * not debug Vault readers.
 * @see registry.ts INFRA_LEVERS — the same tools are excluded from `PLAYER_AGENT_LEVERS`.
 */
export const INFRA_TOOL_NAMES: ReadonlySet<string> = new Set(["sealedFromHouse", "knowledgeScopeManifest", "beatLog", "pipelineCast"]);
/**
 * The engine's permissioned outward MCP API (0009). It mounts ONLY the
 * allowlisted tools for its channel, sources read/narrate tools from the visible
 * projection, and reaches the engine for action tools solely through the
 * Vault-free `EngineCommands` port. It imports no Vault types, no vector index,
 * and no engine root — verified by dependency-cruiser. The concrete stdio/HTTP
 * MCP transport is a thin shell over this router (deferred); calls are async so a
 * live (async) LLM narrator slots in without changing the boundary.
 */
export interface McpDeps {
  player: PlayerSurface;
  admin: AdminPort;
  summary: SummaryService;
  commands: EngineCommands;
  session: GameSession;
  /** A29 - the closed-set beatSeq now (optional: test harnesses that never wire it get no token echo). */
  beatSeqNow?: () => number;
}

/**
 * Per-tool argument shape checks (audit E31/D10/R6): malformed args used to cast blindly into the
 * adapters and die as 500 "internal error"s deep inside the engine (R6's live repro: a STRING
 * `witnessSet` was iterated char-by-char — "non-living houseguest: p"). Each check throws a
 * DELIBERATE `EngineRefusal` naming the offending field, which the HTTP edge maps to a 400.
 * Checks are minimal required-field/shape guards — the engine's own domain validation (legality,
 * liveness) stays where it is.
 */
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Matches the canonical EntityId form: "player" or "npc:<digits>". */
const ENTITY_ID_PATTERN = /^(?:player|npc:\d+)$/;
const isEntityId = (v: unknown): v is string => typeof v === "string" && ENTITY_ID_PATTERN.test(v);
/** Array where every entry is a valid EntityId. */
const isEntityIdArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => isEntityId(x));

function requireShape(name: string, args: Record<string, unknown>): void {
  const refuse = (field: string, want: string): never => {
    throw new EngineRefusal(`invalid args for ${name}: "${field}" must be ${want}`);
  };
  // 0065 — shape-guard the OPTIONAL sync-spine fields the SAME way E31/D10/R6 guards every other
  // optional arg (a malformed value would otherwise cast blindly into the adapter): `expectedBeatSeq`
  // must be a number when present (the CAS token, Part A); `idempotencyKey` a string when present
  // (the at-most-once retry key, Part B). Absent ⇒ unchanged (fully opt-in).
  const guardSyncFields = (allowIdempotency: boolean): void => {
    if (args["expectedBeatSeq"] !== undefined && typeof args["expectedBeatSeq"] !== "number") {
      refuse("expectedBeatSeq", "a number when present");
    }
    if (allowIdempotency && args["idempotencyKey"] !== undefined
      && (typeof args["idempotencyKey"] !== "string" || args["idempotencyKey"] === "")) {
      // A non-empty string when present: an empty key identifies no operation, so accepting it would let
      // unrelated calls falsely de-dup under one ledger entry (matches the `content` non-empty-string guard).
      refuse("idempotencyKey", "a non-empty string when present");
    }
  };
  switch (name) {
    case "createCharacter":
      // 0208 / ORW-663: the player's own choice at a new season: a clean slate ("new") or a return that brings their reputation and may cast a returner. Unknown values are refused (typed), absent = today's behaviour.
      if (args["start"] !== undefined && args["start"] !== "new" && args["start"] !== "return") refuse("start", "'new' or 'return' when present");
      // ORW-739: `returnAs` = the season number of one of the player's own previous characters (the engine resolves it; a number that names none is refused, typed).
      if (args["returnAs"] !== undefined && (typeof args["returnAs"] !== "number" || !Number.isInteger(args["returnAs"]) || args["returnAs"] < 1)) refuse("returnAs", "a season number (a positive whole number) when present");
      break;
    case "recordInteraction":
      guardSyncFields(true); // 0065 Part A CAS + Part B at-most-once idempotencyKey (A10/#591 — the FE re-drives a fold-bearing scene after a stale-409; the key makes that at-most-once, so a concurrent re-drive can't double-fold)
      if (!isEntityId(args["initiator"])) refuse("initiator", "a houseguest id ('player' or 'npc:<n>')");
      if (!isEntityIdArray(args["witnessSet"])) refuse("witnessSet", "an array of houseguest ids ('player' or 'npc:<n>')");
      if (!isStr(args["content"])) refuse("content", "a non-empty string");
      if (args["kind"] !== undefined && typeof args["kind"] !== "string") refuse("kind", "a string when present");
      if (args["toward"] !== undefined && !isEntityIdArray(args["toward"])) refuse("toward", "an array of houseguest ids ('player' or 'npc:<n>') when present");
      // Phase 2 — the LLM's per-scene felt duration in minutes; the engine clamps it.
      if (args["feltMinutes"] !== undefined && typeof args["feltMinutes"] !== "number") refuse("feltMinutes", "a number of minutes when present");
      if (args["assurance"] !== undefined) {
        const a = args["assurance"];
        if (typeof a !== "object" || a === null || Array.isArray(a)) refuse("assurance", "an object when present");
        const as = a as Record<string, unknown>;
        if (as["kind"] !== "safe" && as["kind"] !== "vote" && as["kind"] !== "loyal") refuse("assurance", "{ kind: 'safe' | 'vote' | 'loyal' } when present");
        if (as["sincerity"] !== undefined && typeof as["sincerity"] !== "number") refuse("assurance", "a numeric sincerity when present");
      }
      if (args["promise"] !== undefined) {
        const pr = args["promise"];
        if (typeof pr !== "object" || pr === null || Array.isArray(pr)) refuse("promise", "an object when present");
        const ps = pr as Record<string, unknown>;
        if (typeof ps["what"] !== "string" || ps["what"] === "") refuse("promise", "{ what: a non-empty string } when present");
        if (ps["subject"] !== undefined && !isEntityId(ps["subject"])) refuse("promise", "a houseguest id for `subject` when present");
        if (ps["from"] !== undefined && !isEntityId(ps["from"])) refuse("promise", "a houseguest id for `from` when present");
      }
      if (args["statement"] !== undefined) {
        const st = args["statement"];
        if (typeof st !== "object" || st === null || Array.isArray(st)) refuse("statement", "an object when present");
        const ss = st as Record<string, unknown>;
        const cleanForm = ss["retracts"] === true || ss["tellsAbout"] !== undefined; // 0203 / ORW-646: coming clean names no kind
        if (ss["retracts"] !== undefined && ss["retracts"] !== true) refuse("statement", "`retracts` is true when present");
        if (ss["tellsAbout"] !== undefined && (!isEntityId(ss["tellsAbout"]) || ss["retracts"] === true)) refuse("statement", "a houseguest id for `tellsAbout` when present (and not with `retracts`)");
        if (!isEntityId(ss["to"]) || (cleanForm ? (ss["about"] !== undefined && !isEntityId(ss["about"])) : !isEntityId(ss["about"]))) refuse("statement", "{ to, about: houseguest ids, kind: a claim kind } when present");
        if (!cleanForm && (typeof ss["kind"] !== "string" || ss["kind"] === "")) refuse("statement", "{ kind: a non-empty string } when present");
        if (ss["object"] !== undefined && !isEntityId(ss["object"])) refuse("statement", "a houseguest id for `object` when present");
        if (ss["label"] !== undefined && (typeof ss["label"] !== "string" || ss["label"] === "" || ss["label"].length > 32)) refuse("statement", "a short role word for `label` when present"); // 0184 part 2a
      }
      if (args["heardAboutMe"] !== undefined) {
        const h = args["heardAboutMe"];
        if (typeof h !== "object" || h === null || Array.isArray(h)) refuse("heardAboutMe", "an object when present");
        const hs = h as Record<string, unknown>;
        if (hs["nature"] !== "targeting" && hs["nature"] !== "betrayal") refuse("heardAboutMe", "{ nature: 'targeting' | 'betrayal' } when present");
        if (hs["from"] !== undefined && !isEntityId(hs["from"])) refuse("heardAboutMe", "a houseguest id for `from` when present");
      }
      // 0005: the optional generative-consequence descriptor. Shape-guard only (R6 class: a string
      // where an array/object is expected dies deep in the fold) — the engine owns the magnitude and
      // degrades gracefully on an unknown direction, so domain validation stays there, not here.
      if (args["consequence"] !== undefined) {
        const c = args["consequence"];
        if (typeof c !== "object" || c === null || Array.isArray(c)) refuse("consequence", "an object when present");
        const cons = c as Record<string, unknown>;
        if (cons["edges"] !== undefined) {
          if (!Array.isArray(cons["edges"])) refuse("consequence.edges", "an array when present");
          for (const e of cons["edges"] as unknown[]) {
            if (typeof e !== "object" || e === null || Array.isArray(e)) refuse("consequence.edges[]", "objects with a toward + direction");
            const edge = e as Record<string, unknown>;
            if (!isStr(edge["toward"])) refuse("consequence.edges[].toward", "a houseguest id (string)");
            if (!isStr(edge["direction"])) refuse("consequence.edges[].direction", "a direction (string)");
            if (edge["emphasis"] !== undefined && typeof edge["emphasis"] !== "string") refuse("consequence.edges[].emphasis", "a string when present");
          }
        }
        // Phase 1 (player-offense) — the THIRD-PARTY sibling of `edges`: `holder`'s opinion of
        // `about` moves. Same shape-guard-only discipline (parity with `edges` above); the witness
        // gate + engine-owned magnitude live in `foldThirdPartyConsequence`, not here.
        if (cons["aboutEdges"] !== undefined) {
          if (!Array.isArray(cons["aboutEdges"])) refuse("consequence.aboutEdges", "an array when present");
          for (const e of cons["aboutEdges"] as unknown[]) {
            if (typeof e !== "object" || e === null || Array.isArray(e)) refuse("consequence.aboutEdges[]", "objects with a holder + about + direction");
            const edge = e as Record<string, unknown>;
            if (!isStr(edge["holder"])) refuse("consequence.aboutEdges[].holder", "a houseguest id (string)");
            if (!isStr(edge["about"])) refuse("consequence.aboutEdges[].about", "a houseguest id (string)");
            if (!isStr(edge["direction"])) refuse("consequence.aboutEdges[].direction", "a direction (string)");
            if (edge["emphasis"] !== undefined && typeof edge["emphasis"] !== "string") refuse("consequence.aboutEdges[].emphasis", "a string when present");
          }
        }
        if (cons["rationale"] !== undefined && typeof cons["rationale"] !== "string") refuse("consequence.rationale", "a string when present");
      }
      return;
    case "beatLog":
      // ORW-439: the caller's last-seen counter, required: a missing/non-numeric token would silently read as 0 and hide a gap.
      if (typeof args["sinceBeatSeq"] !== "number" || !Number.isFinite(args["sinceBeatSeq"])) refuse("sinceBeatSeq", "a finite number");
      return;
    case "whereabouts":
      // ORW-386: the optional house-search switch must be a boolean when present.
      if (args["search"] !== undefined && typeof args["search"] !== "boolean") refuse("search", "a boolean when present");
      if (args["lookingFor"] !== undefined && (typeof args["lookingFor"] !== "string" || (args["lookingFor"] as string).length > 80)) refuse("lookingFor", "a short string when present"); // ORW-462
      return;
    case "getMomentPrompt": {
      // Showrunner memory — the OPTIONAL Show Brief request (ORWELL_SHOW_BRIEF on the FE). Shape-guard only; the
      // engine re-validates every field and builds the brief from its own Vault-free view. Absent ⇒ unchanged.
      if (args["zeroClocks"] !== undefined && typeof args["zeroClocks"] !== "boolean") refuse("zeroClocks", "a boolean when present");
      if (args["entranceVoiced"] !== undefined && typeof args["entranceVoiced"] !== "boolean") refuse("entranceVoiced", "a boolean when present"); // ORW-997
      const b = args["brief"];
      if (b === undefined) return;
      if (typeof b !== "object" || b === null || Array.isArray(b)) refuse("brief", "an object when present");
      const br = b as Record<string, unknown>;
      if (br["seen"] !== undefined && (typeof br["seen"] !== "object" || br["seen"] === null || Array.isArray(br["seen"]))) {
        refuse("brief.seen", "an object when present");
      }
      if (br["askedAbout"] !== undefined && (!isStrArray(br["askedAbout"]) || br["askedAbout"].length > 32)) {
        refuse("brief.askedAbout", "an array of at most 32 houseguest ids when present");
      }
      if (br["lastShown"] !== undefined && (typeof br["lastShown"] !== "string" || br["lastShown"].length > 4000)) {
        refuse("brief.lastShown", "a string of at most 4000 characters when present");
      }
      return;
    }
    case "surfaceInformationTo": {
      guardSyncFields(false); // 0065 Part A — optional expectedBeatSeq
      if (!isStr(args["entity"])) refuse("entity", "an entity id (string)");
      const fact = args["fact"];
      if (typeof fact !== "object" || fact === null || !isStr((fact as Record<string, unknown>)["content"])) {
        refuse("fact.content", "a non-empty string");
      }
      if (!isStr(args["pathway"])) refuse("pathway", "a pathway string");
      return;
    }
    case "diaryRoom":
      if (!isStr(args["entry"])) refuse("entry", "a non-empty string");
      return;
    case "advanceGame":
      guardSyncFields(true); // 0065 Parts A+B — optional expectedBeatSeq + idempotencyKey
      if (args["toastBatches"] !== undefined && (typeof args["toastBatches"] !== "number" || !Number.isInteger(args["toastBatches"]) || args["toastBatches"] < 1 || args["toastBatches"] > 4)) refuse("toastBatches", "an integer from 1 to 4 when present"); // ORW-997
      return;
    case "submitDecision":
      guardSyncFields(true); // 0065 Parts A+B — optional expectedBeatSeq + idempotencyKey
      if (!isStr(args["kind"])) refuse("kind", "a decision kind (string)");
      if (args["choice"] !== undefined && !isStrArray(args["choice"])) refuse("choice", "an array of houseguest ids when present");
      // 0025: the secret veto is a one-time, irreversible-if-played safety. The engine reads a missing /
      // non-boolean `use` as a falsy HOLD (and then does not re-offer it this week), so a client that
      // omits the boolean would silently decline the player's safety. Refuse it at the boundary instead;
      // the pending stays open (nothing was dispatched).
      if (args["kind"] === "secret-veto" && typeof args["use"] !== "boolean") {
        refuse("use", "a boolean when kind is secret-veto (true plays the secret veto, false holds it)");
      }
      return;
    case "turnIn":
      guardSyncFields(true); // 0065 Parts A+B — optional expectedBeatSeq + idempotencyKey (a mutating progression tool)
      return;
    case "nap":
      guardSyncFields(true); // 0148 - optional expectedBeatSeq + idempotencyKey (a mutating lever, like turnIn)
      if (args["hours"] !== undefined && (typeof args["hours"] !== "number" || !Number.isFinite(args["hours"]))) refuse("hours", "a number of hours (0.5-3) when present");
      return;
    case "hangOut":
      guardSyncFields(false); // optional expectedBeatSeq
      if (args["maxBeats"] !== undefined && (typeof args["maxBeats"] !== "number" || !Number.isInteger(args["maxBeats"]) || args["maxBeats"] < 1)) {
        refuse("maxBeats", "a positive integer (capped at 8 by the engine)");
      }
      if (args["maxMinutes"] !== undefined && (typeof args["maxMinutes"] !== "number" || !Number.isFinite(args["maxMinutes"]) || args["maxMinutes"] <= 0)) refuse("maxMinutes", "a positive number of in-game minutes (capped at 180 by the engine)");
      if (args["untilBandEnd"] !== undefined && typeof args["untilBandEnd"] !== "boolean") refuse("untilBandEnd", "a boolean when present");
      if (args["untilEvent"] !== undefined && typeof args["untilEvent"] !== "boolean") refuse("untilEvent", "a boolean when present");
      if (args["untilClock"] !== undefined && (typeof args["untilClock"] !== "number" || !Number.isFinite(args["untilClock"]) || args["untilClock"] < 0 || args["untilClock"] >= 24)) refuse("untilClock", "an hour of the day from 0 up to 24 (22.5 = 10:30pm) when present");
      return;
    case "moveTo":
      guardSyncFields(false); // 0065 Part A — optional expectedBeatSeq
      return;
    case "searchForHouseguest": // ORW-934
      if (!isStr(args["name"])) refuse("name", "the houseguest's name (string)");
      if (args["maxLegs"] !== undefined && (typeof args["maxLegs"] !== "number" || !Number.isInteger(args["maxLegs"]) || args["maxLegs"] < 1)) refuse("maxLegs", "a whole number of legs, at least 1, when present");
      guardSyncFields(true); // CAS + at-most-once: the walk bills the clock and moves the player, so a re-drive of the same search must not walk twice
      return;
    case "resolvePlayerMove":
      if (!isStr(args["text"])) refuse("text", "a non-empty string (the player's own message)");
      if (args["skip"] !== undefined && (!Array.isArray(args["skip"]) || !(args["skip"] as unknown[]).every((x) => x === "move" || x === "bed"))) refuse("skip", "an array of \"move\" and/or \"bed\" when present");
      guardSyncFields(true); // optional expectedBeatSeq + idempotencyKey
      return;
    case "noteMessage":
      if (!isStr(args["messageId"])) refuse("messageId", "a non-empty string (the player message's stable id)");
      return;
    case "moveHouseguest":
      // ADR 0009 — record a narrated NPC relocation: a houseguest id + a room name (both strings).
      if (!isStr(args["id"])) refuse("id", "a houseguest id (string)");
      if (!isStr(args["room"])) refuse("room", "a room name (string)");
      return;
    case "makeDeal":
      guardSyncFields(true); // 0065 Part A CAS + Part B at-most-once idempotencyKey (A10/#591 — makeDeal folds a leverage/trade squeeze + creates a deal; the key makes a stale-409 re-drive at-most-once)
      if (!isStr(args["with"])) refuse("with", "a houseguest id (string)");
      if (!isStr(args["kind"])) refuse("kind", "a deal kind (string)");
      if (!isStr(args["terms"])) refuse("terms", "a non-empty string");
      // B55 - the optional direction of an ACTIVE-obligation deal (who promises): exactly "offer" or "ask" when present.
      if (args["direction"] !== undefined && args["direction"] !== "offer" && args["direction"] !== "ask") refuse("direction", '"offer" or "ask" when present');
      // 0142 - the optional third houseguest of a protect-third deal: a houseguest id (string) when present (the engine refuses a protect-third without a valid one).
      if (args["third"] !== undefined && !isStr(args["third"])) refuse("third", "a houseguest id (string) when present");
      // 0142 - the optional bundled promises of a package deal: an array when present (the engine gates each part and refuses a malformed package).
      if (args["parts"] !== undefined && !Array.isArray(args["parts"])) refuse("parts", "a list of two promises when present");
      // ORW-614 (P-12) - the optional id of the standing offer this deal counters: a string when present.
      if (args["countersOffer"] !== undefined && !isStr(args["countersOffer"])) refuse("countersOffer", "an offer id (string) when present");
      // 0109 / #1993 — the optional negotiated term must be an object when present; the ENGINE bounds its
      // contents (a junk `weeks` is ignored there), so only the container shape is refused at the boundary.
      if (args["term"] !== undefined && (typeof args["term"] !== "object" || args["term"] === null || Array.isArray(args["term"]))) {
        refuse("term", "an object ({ weeks?, vague? }) when present");
      }
      return;
    case "askJuror": // 0129 slice 3
      guardSyncFields(true);
      if (!isStr(args["jurorId"])) refuse("jurorId", "a juror's houseguest id (string)");
      return;
    case "formAlliance": // 0107
      guardSyncFields(false);
      if (!isStr(args["name"])) refuse("name", "an alliance name (string)");
      if (!Array.isArray(args["members"])) refuse("members", "a list of houseguest ids");
      return;
    case "joinAlliance": // 0107 Phase B
      guardSyncFields(false);
      if (!isStr(args["allianceId"])) refuse("allianceId", "an alliance id (string)");
      if (args["name"] !== undefined && !isStr(args["name"])) refuse("name", "a name (string) or omitted"); // ORW-509
      return;
    case "confide":
      guardSyncFields(true); // 0065 Part A CAS + Part B at-most-once idempotencyKey (A10/#591 — confide folds the bond bump / lie ledger; the key makes a stale-409 re-drive at-most-once)
      if (!isStr(args["npcId"])) refuse("npcId", "a houseguest id (string)");
      return;
    case "accuseTie": // 0095
      guardSyncFields(false); // 0065 Part A — optional expectedBeatSeq
      if (!isStr(args["aId"])) refuse("aId", "a houseguest id (string)");
      if (!isStr(args["bId"])) refuse("bId", "a houseguest id (string)");
      return;
    case "callInFavor": // 0142
      guardSyncFields(false);
      if (!isStr(args["npcId"])) refuse("npcId", "a houseguest id (string)");
      if (args["ask"] !== undefined && typeof args["ask"] !== "string") refuse("ask", "a deal kind (string)"); // the engine decides which kinds exist (an unknown one returns null)
      return;
    case "confront": // 0094
      guardSyncFields(false); // 0065 Part A — optional expectedBeatSeq
      if (!isStr(args["npcId"])) refuse("npcId", "a houseguest id (string)");
      if (!isStr(args["factId"])) refuse("factId", "a learned fact id (string)");
      return;
    case "askToTalkAlone": // ORW-727b
      guardSyncFields(true); // CAS + at-most-once: it moves two people, so a re-drive of the same ask must not move them twice
      if (!isStr(args["npcId"])) refuse("npcId", "a houseguest id (string)");
      if (args["room"] !== undefined && typeof args["room"] !== "string") refuse("room", "a room name (string) when present");
      if (args["private"] !== undefined && typeof args["private"] !== "boolean") refuse("private", "a boolean when present");
      return;
    case "exposeSecret":
      // 0093 — out a learned secret. EITHER a real `factId` (a string) OR a `bluff` (a boolean) with a
      // `subject`. The engine validates ownership / the season cap; this is the shape guard only.
      guardSyncFields(true); // 0065 Part A CAS + Part B at-most-once idempotencyKey (A10/#591 — exposeSecret folds a house-wide standing hit + spends the secret; the key makes a re-drive at-most-once)
      if (args["bluff"] === true) {
        if (!isStr(args["subject"])) refuse("subject", "a houseguest id (string) for a bluff");
      } else if (!isStr(args["factId"])) {
        refuse("factId", "a learned fact id (string), or set bluff:true with a subject");
      }
      return;
    case "tradeSecret":
      // 0099 — trade a held secret to a recipient. `toNpcId` required; EITHER a real `factId` OR a `bluff`.
      guardSyncFields(true); // 0065 Part A CAS + Part B at-most-once idempotencyKey (A10/#591 — tradeSecret folds the recipient warmth/sour + trade cap; the key makes a re-drive at-most-once)
      if (!isStr(args["toNpcId"])) refuse("toNpcId", "a recipient houseguest id (string)");
      if (args["bluff"] === true) {
        if (!isStr(args["subject"])) refuse("subject", "a houseguest id (string) for a bluff");
      } else if (!isStr(args["factId"])) {
        refuse("factId", "a learned fact id (string), or set bluff:true with a subject");
      }
      return;
    case "runCompetition":
      if (args["type"] !== undefined && typeof args["type"] !== "string") refuse("type", "a string when present");
      if (args["participantIds"] !== undefined && !isStrArray(args["participantIds"])) {
        refuse("participantIds", "an array of houseguest ids when present");
      }
      return;
    case "recallSceneMemories":
      // Feature #1394 — both fields optional (absent ⇒ the adapter returns { moments: [] }); shape-guard
      // only so a malformed value can't cast blindly into the recall closure.
      if (args["withIds"] !== undefined && !isEntityIdArray(args["withIds"])) {
        refuse("withIds", "an array of houseguest ids ('player' or 'npc:<n>') when present");
      }
      if (args["cue"] !== undefined && typeof args["cue"] !== "string") refuse("cue", "a string when present");
      return;
    case "playerDossier":
      // Feature #1793: optional subjectId of any type — mirror the optional-arg read-tool pattern.
      return;
    case "playerReceipts":
      // #1800 — no-arg read tool.
      return;
    case "npcVoice":
    case "getPortraitPrompt":
      if (!isStr(args["id"])) refuse("id", "a houseguest id (string)");
      return;
    case "markHouseguestMet": // PREMIERE meet-everyone (#380) — takes a houseguest id
      if (!isStr(args["id"])) refuse("id", "a houseguest id (string)");
      // #1318 — optional source: only the FE regex belt passes "belt" (meet-list only, not a hot read);
      // any other/absent value is a genuine "player" read. Reject an unknown value rather than silently
      // treating it as a hot read.
      if (args["via"] !== undefined && args["via"] !== "belt" && args["via"] !== "player") {
        refuse("via", 'either "player" or "belt" when present');
      }
      return;
    case "recordImageBeat":
      guardSyncFields(false); // BE-5 — optional expectedBeatSeq (0065 Part A parity with the other write-backs)
      if (!isStr(args["houseguestId"])) refuse("houseguestId", "a houseguest id (string)");
      if (!isStr(args["imageRef"])) refuse("imageRef", "a non-empty string");
      return;
    case "recordCastProfile":
      // 0058/0065: the FE authoring write-back. Only `houseguestId` is structurally required; every
      // authored field is optional (the engine keeps the prior/seeded value for any omitted field) and
      // domain-validated (non-player-mirroring) inside the adapter, not here.
      if (!isStr(args["houseguestId"])) refuse("houseguestId", "a houseguest id (string)");
      // The optional LLM-authored replacement display name — a string when present; the adapter
      // domain-validates it (reasonable two-token name, non-colliding) and falls back to the corpus
      // name if it doesn't pass, so a malformed name never fails the whole call.
      if (args["name"] !== undefined && typeof args["name"] !== "string") refuse("name", "a string when present");
      // The optional LLM-authored PUBLIC occupation (#849) — a string when present; the adapter ignores
      // a blank value (the seeded `vocation` stands) and keeps it in lockstep with the biography, so a
      // malformed value never fails the whole call.
      if (args["vocation"] !== undefined && typeof args["vocation"] !== "string") refuse("vocation", "a string when present");
      // ORW-388: the optional writer-authored identity concept — a string when present; the adapter replaces a stored one or fills a missing one (ORW-431b), capped, single line, refused if it names the player.
      if (args["identityConcept"] !== undefined && typeof args["identityConcept"] !== "string") refuse("identityConcept", "a string when present");
      // ORW-563: the optional re-picked style family LABEL (the cast gate swaps a strong-outlier look); the adapter takes only a known label no other houseguest holds.
      if (args["presentation"] !== undefined && typeof args["presentation"] !== "string") refuse("presentation", "a string when present");
      // The optional LLM-authored VOICE fingerprint (0084 / the expressive-e2e authoring widening) — an
      // object when present (a string/array where an object is expected is the R6 class that dies deep in
      // the fold). Its field-level shape (whole-or-nothing, bounded strings) is validated inside the
      // adapter; a malformed profile is dropped there (the seeded voice stands) — never a whole-call failure.
      if (args["voice"] !== undefined
        && (typeof args["voice"] !== "object" || args["voice"] === null || Array.isArray(args["voice"]))) {
        refuse("voice", "an object when present");
      }
      return;
    case "recordCastIdentity":
      // #544: the FE cast-identity write-back. `facets` is the per-houseguest map of PROPOSED descriptive
      // facets — OPTIONAL (like recordWorldSnapshot's `slices`): refuse ONLY if present and not an object
      // (a string/array where an object is expected is the R6 class that dies deep in the fold). An absent
      // `facets` is a clean no-op (the deterministic floor stands), so a leak/sentinel sweep that calls the
      // tool with `{}` never 400s. Each houseguest's own facet shape (which values are recognized) is
      // validated + REPAIRED inside the adapter against the diversity targets, not here.
      if (args["facets"] !== undefined
        && (typeof args["facets"] !== "object" || args["facets"] === null || Array.isArray(args["facets"]))) {
        refuse("facets", "an object mapping houseguest id → proposed facets when present");
      }
      return;
    case "recordCastGenesis":
      // 0116: the FE cast-genesis skeleton write-back. `npcs` is the whole-cast proposal array; `ties` is
      // the optional tie graph. Both are OPTIONAL-tolerant like recordCastIdentity's `facets` /
      // recordWorldSnapshot's `slices`: refuse ONLY if PRESENT and not an array (the R6 class that would
      // cast blindly into the envelope), so a leak/sentinel sweep calling the tool with `{}` is a clean
      // no-op, never a 400. Each NPC's own field shape is validated + clamped + repaired inside the envelope.
      if (args["npcs"] !== undefined && !Array.isArray(args["npcs"])) refuse("npcs", "an array of proposed NPC skeletons when present");
      if (args["ties"] !== undefined && !Array.isArray(args["ties"])) refuse("ties", "an array of proposed ties when present");
      return;
    case "preSeedCast":
      // 0065: optional explicit seed (tests/replays); default is real entropy minted in the adapter.
      if (args["seed"] !== undefined && typeof args["seed"] !== "number") refuse("seed", "a number when present");
      return;
    case "preSeedNextSeason":
      // 0065 (advance-warm): optional explicit seed (tests/replays) + an OPTIONAL `profile` deep-author
      // write-back (same shape as recordCastProfile — its `houseguestId` is the only structurally-required
      // field when present; every other field is optional + domain-validated inside the adapter, not here).
      if (args["seed"] !== undefined && typeof args["seed"] !== "number") refuse("seed", "a number when present");
      if (args["profile"] !== undefined) {
        const p = args["profile"];
        if (typeof p !== "object" || p === null || Array.isArray(p)) refuse("profile", "an object when present");
        if (!isStr((p as Record<string, unknown>)["houseguestId"])) refuse("profile.houseguestId", "a houseguest id (string)");
      }
      return;
    case "recordLookExtras":
      // ORW-369: look-only write-back; shape guard only, the engine cleans, clamps and guards.
      if (!isStr(args["houseguestId"])) refuse("houseguestId", "a houseguest id (string)");
      if (args["wardrobe"] !== undefined && !Array.isArray(args["wardrobe"])) refuse("wardrobe", "an array when present");
      if (args["onCamera"] !== undefined && typeof args["onCamera"] !== "string") refuse("onCamera", "a string when present");
      if (args["photoHair"] !== undefined && typeof args["photoHair"] !== "string") refuse("photoHair", "a string when present");
      if (args["lookSignature"] !== undefined && typeof args["lookSignature"] !== "string") refuse("lookSignature", "a string when present");
      if (args["style"] !== undefined && typeof args["style"] !== "string") refuse("style", "a string when present");
      if (args["clear"] !== undefined && !Array.isArray(args["clear"])) refuse("clear", "an array when present");
      return;
    case "recordOpenLedger":
      // ORW-407: shape guard only; the engine re-validates every field and rejects extra keys.
      if (!isStr(args["text"])) refuse("text", "the narrated words (string)");
      if (!isStr(args["speaker"])) refuse("speaker", "a speaker id (string)");
      if (!Array.isArray(args["addressedTo"])) refuse("addressedTo", "an array of ids");
      if (typeof args["kind"] !== "string") refuse("kind", "a free-text kind (string; empty falls back to \"claim\")");
      if (args["parties"] !== undefined && !Array.isArray(args["parties"])) refuse("parties", "an array of ids when present");
      if (args["about"] !== undefined && !isStr(args["about"])) refuse("about", "free text when present");
      if (args["claim"] !== undefined) { // 0155: the structured claim, when the entry is one (the engine re-validates it)
        const c = args["claim"] as Record<string, unknown> | null;
        if (!c || typeof c !== "object" || Array.isArray(c) || !isStr(c["kind"]) || !isStr(c["subject"]) || (c["object"] !== undefined && !isStr(c["object"]))) refuse("claim", "{kind, subject, object?} strings when present");
      }
      return;
    case "resolveOpenLedger":
      // ORW-407 slice 2: shape guard only; the engine re-validates.
      if (!isStr(args["entryId"])) refuse("entryId", "an open-ledger entry id (string)");
      if (!isStr(args["status"])) refuse("status", "kept, broken or withdrawn");
      if (typeof args["note"] !== "string") refuse("note", "a free-text note (string; may be empty)");
      return;
    case "recordNarrationUse":
      // ORW-510: shape guard only (one string); the engine bounds and reads it.
      if (!isStr(args["text"])) refuse("text", "the visible narration of one turn (string)");
      return;
    case "recordRoomCanon":
      // ORW-223: the FE room-canon write-back. Shape-guard only (both fields strings); the engine re-validates the room,
      // the length and every content rule, and rejects extra keys.
      if (!isStr(args["roomId"])) refuse("roomId", "a room id (string)");
      if (!isStr(args["feature"])) refuse("feature", "a one-line feature (string)");
      return;
    case "recordDaySummary": {
      if (!Number.isFinite(args["day"] as number) || typeof args["day"] !== "number") refuse("day", "a number");
      if (!isStr(args["text"])) refuse("text", "a string");
      if (args["tier"] !== undefined && args["tier"] !== "day" && args["tier"] !== "week") refuse("tier", "'day' or 'week' when present");
      const cd = args["coversDays"];
      if (cd !== undefined && !(Array.isArray(cd) && cd.length === 2 && cd.every((n) => typeof n === "number" && Number.isFinite(n)))) refuse("coversDays", "a [from,to] number pair when present");
      return;
    }
    case "recordEpisodeTitles": {
      // ORW-807: `titles` must be an array of { week: number, title: string }; each title is cleaned and capped inside the adapter.
      const t = args["titles"];
      if (!Array.isArray(t) || !t.every((x) => x !== null && typeof x === "object" && typeof (x as { week?: unknown }).week === "number" && Number.isFinite((x as { week: number }).week) && isStr((x as { title?: unknown }).title))) refuse("titles", "an array of { week: number, title: string }");
      return;
    }
    case "recordNpcTraits":
      // ORW-319: `traits` must be an array of objects with a string id; each value is validated inside the adapter (closed sets).
      if (!Array.isArray(args["traits"])) refuse("traits", "an array");
      for (const t of args["traits"] as unknown[]) if (typeof t !== "object" || t === null || typeof (t as Record<string, unknown>)["id"] !== "string") refuse("traits[]", "objects with a string id");
      return;
    case "recordNpcReflections":
      // ORW-320: `reflections` must be an array of objects with a string id, a numeric night and a string reflection; the engine validates deeper and refuses until the season is finished.
      if (!Array.isArray(args["reflections"])) refuse("reflections", "an array");
      for (const r of args["reflections"] as unknown[]) {
        const o = r as Record<string, unknown> | null;
        if (typeof o !== "object" || o === null || typeof o["id"] !== "string" || typeof o["night"] !== "number" || typeof o["reflection"] !== "string") refuse("reflections[]", "objects with a string id, a numeric night and a string reflection");
      }
      return;
    case "recordGroupIdentity":
      // ORW-566 part c: a string group id is required; every word is optional and refused only when present and not a string (validated deeper in the adapter).
      if (!isStr(args["groupId"])) refuse("groupId", "a string");
      for (const k of ["name", "ritual", "signal", "insideJoke"]) if (args[k] !== undefined && typeof args[k] !== "string") refuse(k, "a string when present");
      return;
    case "recordAllianceName":
      // ORW-566 part c2: both fields are plain strings; a malformed call is refused at the boundary (never a reason about a ticket).
      if (!isStr(args["ticket"])) refuse("ticket", "a string");
      if (typeof args["name"] !== "string") refuse("name", "a string");
      return;
    case "recordHouseCulture":
      // ORW-319: every part OPTIONAL; refuse only a present part of the wrong shape (validated deeper in the adapter).
      if (args["spots"] !== undefined && !Array.isArray(args["spots"])) refuse("spots", "an array when present");
      if (args["rituals"] !== undefined && !Array.isArray(args["rituals"])) refuse("rituals", "an array when present");
      if (args["runningJoke"] !== undefined && !isStr(args["runningJoke"])) refuse("runningJoke", "a string when present");
      return;
    case "recordWorldSnapshot":
      // 0062: the FE zeitgeist write-back. `slices` is OPTIONAL — refuse only if present and not an
      // object (a string/array where an object is expected is the R6 class that dies deep in the merge);
      // each slice's own shape (bounded, public flavor) is sanitized inside the adapter, not here.
      if (args["slices"] !== undefined) {
        const s = args["slices"];
        if (typeof s !== "object" || s === null || Array.isArray(s)) refuse("slices", "an object when present");
      }
      return;
    case "recordProducerProfile": {
      // #1626 (increment 3): the FE producer-deepening write-back. EVERY field is an OPTIONAL string (the
      // engine keeps the seeded value for any omitted field, and validates/strips forbidden vocabulary in
      // the adapter) — refuse ONLY a PRESENT non-string field (the R6 class that would cast blindly), so a
      // leak/sentinel sweep calling the tool with `{}` is a clean no-op, never a 400.
      for (const f of ["archetype", "demeanor", "disposition", "wit", "quirk", "backstory", "name"]) {
        if (args[f] !== undefined && typeof args[f] !== "string") refuse(f, "a string when present");
      }
      return;
    }
    case "recordCompetitionFiction":
      // #1400: the FE competition-fiction write-back. `comp`/`week` identify the staging comp (staleness
      // guards); `theme`/`premise` are the authored flavor; `eliminations` is the ORDERED per-drop
      // fiction the engine validates against the fixed drop order. Shape-guard the required fields so a
      // malformed value refuses by name (E31/R6) rather than casting blindly into the adapter; the HARD
      // drop-order match itself is the adapter's `validateCompetitionFiction` gate, not here.
      if (!isStr(args["comp"])) refuse("comp", "a competition kind (string)");
      if (typeof args["week"] !== "number") refuse("week", "a number");
      if (!isStr(args["theme"])) refuse("theme", "a non-empty string");
      if (!isStr(args["premise"])) refuse("premise", "a non-empty string");
      if (!Array.isArray(args["eliminations"])) refuse("eliminations", "an array of { id, fiction } entries");
      return;
    case "competitionStagingView":
      // #1400: read-only projection with no required args — no shape guard needed.
      return;
    case "pipelineCast":
      // ORW-969: read-only, no args.
      return;
    case "getOffscreenSceneSkeletons":
      // 0070: read-only call with no required args — no shape guard needed.
      return;
    case "recordOffscreenSceneTexture":
      // 0070: FE prose write-back. Requires `eventId` (a hidden event id) and `content` (non-empty voiced
      // prose). Refuses any forbidden fields that would pierce the closed set: `witnessSet`, `hidden`,
      // and any field starting with "relationship" are not permitted — they must never cross this boundary.
      if (!isStr(args["eventId"])) refuse("eventId", "a non-empty string (hidden event id)");
      if (!isStr(args["content"])) refuse("content", "a non-empty string (voiced prose)");
      if (args["witnessSet"] !== undefined) refuse("witnessSet", "not accepted — texture write-back is content-only");
      if (args["hidden"] !== undefined) refuse("hidden", "not accepted — texture write-back is content-only");
      if (Object.keys(args).some((k) => k.startsWith("relationship"))) {
        refuse("relationship*", "not accepted — texture write-back is content-only");
      }
      return;
    case "setBehavioralFlags": {
      // B2: every field is an OPTIONAL boolean (a malformed present value is the R6 class that would
      // otherwise cast blindly into the adapter's setters) — an absent field is fine (that layer stays
      // untouched), a present non-boolean is refused by name.
      const boolFields = ["campaigns", "trajectories", "triggers", "secretPacing", "juryHouse", "seededTieSurfacing", "mythMaking", "showrunner"];
      for (const f of boolFields) {
        if (args[f] !== undefined && typeof args[f] !== "boolean") refuse(f, "a boolean when present");
      }
      return;
    }
    default:
      return; // read tools and free-text tools take no required structure
  }
}

/** ORW-584: what the player channel may carry of a confide: whether they opened up, how much, and what was said. Never whether it was true. */
function playerConfideResult(r: ConfideResult | null): { disclosed: boolean; tier: ConfideResult["tier"]; content?: string } | null {
  if (!r) return null;
  return { disclosed: r.disclosed, tier: r.tier, ...(r.content !== undefined ? { content: r.content } : {}) };
}

export class McpServer {
  constructor(private readonly channel: OutwardChannel, private readonly deps: McpDeps) {}

  listTools(): readonly ToolDescriptor[] {
    return toolsFor(this.channel);
  }

  private allows(name: string): boolean {
    if (this.listTools().some((t) => t.name === name)) return true;
    // The owner-ruled DEBUG override of mandate #2: the live-Vault unseal (`producerVault`) is NOT in
    // the advertised allowlist — it is a separate, out-of-band debug capability the admin/God-Mode
    // channel alone may dispatch (by explicit name, fired behind an explicit FE "unseal"). The player
    // channel can never reach it.
    if (this.channel === "admin/God Mode" && DEBUG_VAULT_TOOL_NAMES.has(name)) return true;
    // Issue #1870: `sealedFromHouse` and `knowledgeScopeManifest` are Vault-free FE guard-support
    // tools (the narration guard reads them to strip content a houseguest should not know). They are
    // REMOVED from `PLAYER_TOOLS` (so `listTools()` does not advertise them), but the player channel
    // must STILL dispatch them by name (the existing switch-case handles both). This is the same
    // out-of-band dispatch pattern `producerVault` uses on the admin channel, except these stay
    // Vault-free — they never read the Vault, only the player's own knowledge projection.
    return this.channel === "player" && INFRA_TOOL_NAMES.has(name);
  }

  /**
   * A29 - the post-commit beatSeq echo. A tool that COMMITS (persists) bumps the closed-set beatSeq, but many returned no token, so the front-end's last-seen token went stale and its next
   * compare-and-swap call got a self-inflicted stale-beat 409 (markHouseguestMet, diaryRoom, moveHouseguest, ...). Here, for ANY tool whose call moved the counter, a plain-object result
   * that does not already carry a `beatSeq` gets the post-commit one. A read / a no-op leaves the counter alone, so its result is byte-identical; a result that already carries a token
   * (advanceGame, noteMessage, ...) is untouched; arrays / null / scalars are left as they are. Numeric, Vault-free.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const seq = this.deps.beatSeqNow;
    const before = seq ? seq() : undefined;
    // ORW-439 - the commit funnel reads this to name the tool behind each beat bump (diagnostic only; it changes no behaviour).
    const result = await runInToolCall(name, () => this.dispatchTool(name, args));
    if (seq && before !== undefined && result !== null && typeof result === "object" && !Array.isArray(result) && Object.getPrototypeOf(result) === Object.prototype && !("beatSeq" in (result as Record<string, unknown>))) {
      const after = seq();
      if (after !== before) return { ...(result as Record<string, unknown>), beatSeq: after };
    }
    return result;
  }

  private async dispatchTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.allows(name)) {
      throw new Error(`tool "${name}" is not available on channel "${this.channel}"`);
    }
    requireShape(name, args); // E31: deliberate 400s with field names, never a 500 from a blind cast
    switch (name) {
      case "createCharacter":
        return this.deps.session.createCharacter(args as unknown as CreateCharacterReq);
      case "updateCasting":
        return this.deps.session.updateCasting(args as unknown as UpdateCastingReq);
      case "preSeedCast":
        // 0065: pre-warm the player-independent cast before the interview ends (Vault-free roster + prompts out).
        return this.deps.session.preSeedCast(args as unknown as PreSeedCastReq);
      case "preSeedNextSeason":
        // 0065 (advance-warm): pre-warm the NEXT season's cast DURING the finale into a survivor holding store
        // (the active season is untouched; the cutover adopts it). Vault-free roster + prompts out.
        return this.deps.session.preSeedNextSeason(args as unknown as PreSeedNextSeasonReq);
      case "recordCastProfile":
        // 0058/0065: seal one houseguest's authored §3 profile (PUBLIC/HIDDEN split; never echoes a hidden value).
        return this.deps.session.recordCastProfile(args as unknown as RecordCastProfileReq);
      case "recordCastIdentity":
        // #544: validate + REPAIR the FE-proposed cast identity facets against the diversity targets, fold the
        // PUBLIC facets onto the byte-stable cast, re-ground skin tone, re-seal each private orientation. Vault-free out.
        return this.deps.session.recordCastIdentity(args as unknown as RecordCastIdentityReq);
      case "recordCastGenesis":
        // 0116: validate the whole-cast SKELETON proposal through the engine's envelope (banded stats / variance
        // floor / name validators / closed hidden-element kinds / tie-graph sanity / hidden-weight stripping) and
        // fold the committed skeleton onto the pre-warmed cast. Structured Vault-free violations out; pre-game only.
        return this.deps.session.recordCastGenesis(args as unknown as RecordCastGenesisReq);
      case "recordLookExtras":
        // ORW-369: store the two look fields for one existing houseguest, nothing else. Public fields only.
        return this.deps.session.recordLookExtras(args as unknown as RecordLookExtrasReq);
      case "recordOpenLedger":
        return this.deps.session.recordOpenLedger(args as unknown as RecordOpenLedgerReq);
      case "resolveOpenLedger":
        return this.deps.session.resolveOpenLedger(args as unknown as ResolveOpenLedgerReq);
      case "openLedgerHere":
        return this.deps.session.openLedgerHere();
      case "recordNarrationUse":
        // ORW-510: check a finished turn against the rolling record of what the narration already used, and fold it in (counts only back).
        return this.deps.session.recordNarrationUse(args as unknown as RecordNarrationUseReq);
      case "recordRoomCanon":
        // ORW-223: record a narrated room feature as canon (Vault-free; never an event, outcome or secret).
        return this.deps.session.recordRoomCanon(args as unknown as RecordRoomCanonReq);
      case "recordNpcTraits":
        // ORW-319: freeze each houseguest's model-read habits + aim hint (validated, write-once, engine-side).
        return this.deps.session.recordNpcTraits(args as unknown as RecordNpcTraitsReq);
      case "recordNpcReflections":
        // ORW-320: post-crown nightly reflections (refused until finished; validated; write-once per houseguest-night).
        return this.deps.session.recordNpcReflections(args as unknown as RecordNpcReflectionsReq);
      case "recordGroupIdentity":
        // ORW-566 part c: freeze the model's words for one group (validated, write-once per group id).
        return this.deps.session.recordGroupIdentity(args as unknown as RecordGroupIdentityReq);
      case "groupsAwaitingWords":
        // ORW-566 part c: the groups still waiting for words (ids and a room only).
        return this.deps.session.groupsAwaitingWords();
      case "recordAllianceName":
        // ORW-566 part c2: answer one sealed-prompt ticket (bare receipt for real and decoy alike).
        return this.deps.session.recordAllianceName(args as unknown as RecordAllianceNameReq);
      case "allianceNameTickets":
        // ORW-566 part c2: tonight's fixed-size batch of anonymous naming prompts.
        return this.deps.session.allianceNameTickets();
      case "recordHouseCulture":
        // ORW-319: freeze the season's house culture (validated, write-once).
        return this.deps.session.recordHouseCulture(args as unknown as RecordHouseCultureReq);
      case "recordWorldSnapshot":
        // 0062: freeze the FE-captured move-in zeitgeist (public flavor; never a game input). Idempotent.
        return this.deps.session.recordWorldSnapshot(args as unknown as RecordWorldSnapshotReq);
      case "recordProducerProfile":
        // #1626 (increment 3): fold the FE-authored producer DEEPENING overlay onto the seeded off-camera
        // producer (open-set voice prose; keeps the seeded name; strips any stat/soul vocabulary). Not a
        // board beat (background persist); reports accepted field NAMES only. Idempotent / fail-soft.
        return this.deps.session.recordProducerProfile(args as unknown as RecordProducerProfileReq);
      case "worldSnapshotView":
        // BE-103/TCG-16: the read counterpart of recordWorldSnapshot — was fully implemented in the
        // port + adapter but never wired here, so it was a dead endpoint (no registry entry, no dispatch
        // case). No args; null pre-game or when no snapshot was ever captured.
        return this.deps.session.worldSnapshotView();
      case "competitionStagingView":
        // #1400: the Vault-free "what to hand the model" staging read (flag-gated; null unless a comp
        // has resolved its roll). Not a model lever; drives the FE competition-fiction author.
        return this.deps.session.competitionStagingView();
      case "recordCompetitionFiction":
        // #1400: freeze the FE-authored competition fiction over the engine's fixed roll. The adapter's
        // `validateCompetitionFiction` HARD-validates every elimination against the fixed drop order;
        // a mismatch is rejected and the 0042 library floor stands. Presentation-only; no beatSeq bump.
        return this.deps.session.recordCompetitionFiction(args as unknown as RecordCompetitionFictionReq);
      case "getOffscreenSceneSkeletons":
        // 0070: return the Vault-free skeletons of the most-recent tick's off-screen scenes (ids + nature; no hidden content).
        return this.deps.session.getOffscreenSceneSkeletons();
      case "recordOffscreenSceneTexture":
        // 0070: enrich an already-recorded hidden off-screen scene with model-voiced prose. Content-only; closed set unchanged.
        return this.deps.session.recordOffscreenSceneTexture(args as unknown as RecordOffscreenSceneTextureReq);
      case "getGameState":
        return this.deps.session.getGameState();
      case "pipelineCast":
        // ORW-969: the full cast for server-side casting jobs (unadvertised infra read: INFRA_TOOL_NAMES).
        return this.deps.session.pipelineCast();
      case "gameStatus":
        return this.deps.session.gameStatus();
      case "stateDelta":
        // 0065 Part E — the beatSeq-keyed delta read. `sinceBeatSeq` is the caller's last-seen token;
        // an absent/non-number value reads as 0 (the engine then signals full-refresh when it's stale).
        return this.deps.session.stateDelta(
          typeof args["sinceBeatSeq"] === "number" ? args["sinceBeatSeq"] : 0,
        );
      case "beatLog":
        // ORW-439: which tool caused each beat bump after the caller's token (diagnostic read; tool names + counters + timestamps only).
        return this.deps.session.beatLog(args["sinceBeatSeq"] as number);
      case "playerTagline":
        return this.deps.session.playerTagline();
      case "finaleView":
        return this.deps.session.finaleView();
      case "getMomentPrompt":
        return this.deps.session.getMomentPrompt(args as unknown as MomentPromptReq);
      case "recallSceneMemories":
        // Feature #1394 — the Vault-free scene-memory recall (witnessed moments only; reads the player
        // projection). A pure read; the adapter returns { moments: [] } when there is nothing relevant.
        return this.deps.session.recallSceneMemories(args as unknown as RecallSceneMemoriesReq);
      case "runCompetition":
        return this.deps.session.runCompetition(args as unknown as RunCompetitionReq);
      case "advanceGame":
        // 0065 — optional expectedBeatSeq (CAS) + idempotencyKey (at-most-once) ride the args.
        return this.deps.session.advanceGame(args as { expectedBeatSeq?: number; idempotencyKey?: string; toastBatches?: number });
      case "submitDecision":
        return this.deps.session.submitDecision(args as unknown as SubmitDecisionReq);
      case "requestSelfEviction":
        // 0061 step 1: raise the OOC self-evict confirmation (no state change; the house never hears it).
        return this.deps.session.requestSelfEviction();
      case "raiseSpectatorChoice":
        // E-1: re-raise the spectator-choice card for a watching evictee (card-only binding intact).
        return this.deps.session.raiseSpectatorChoice(args["expectedBeatSeq"] as number | undefined);
      case "cancelSelfEviction":
        // 0061: decline the confirmation — the player plays on, ACTIVE and unchanged.
        return this.deps.session.cancelSelfEviction();
      case "turnIn":
        // ADR 0006: the player's bedtime lever — ends their night, rolls to the next morning.
        // 0065 — optional expectedBeatSeq (CAS) + idempotencyKey (at-most-once) ride the args, so a
        // retried/duplicate turnIn replays verbatim instead of re-stamping the rest penalty.
        return this.deps.session.turnIn(args as { expectedBeatSeq?: number; idempotencyKey?: string });
      case "nap":
        return this.deps.session.nap(args as { hours?: number; expectedBeatSeq?: number; idempotencyKey?: string });
      case "hangOut":
        return this.deps.session.hangOut(args as { expectedBeatSeq?: number; maxBeats?: number; maxMinutes?: number; untilBandEnd?: boolean; untilClock?: number; untilEvent?: boolean });
      case "noteMessage":
        // Clock-per-message (Coordinator 2026-11-05): the FE announces each PLAYER MESSAGE once (idempotent per messageId); the announcement steps the in-game clock one message-step.
        return this.deps.session.noteMessage({ messageId: String(args["messageId"]) });
      case "makeDeal":
        return this.deps.session.makeDeal(args as unknown as MakeDealReq);
      case "formAlliance": // 0107
        return this.deps.session.formAlliance(args as unknown as FormAllianceReq);
      case "joinAlliance": // 0107 Phase B
        return this.deps.session.joinAlliance(args as unknown as JoinAllianceReq);
      case "confide":
        // 0075 — the trust-gated confidence: the engine decides + records; the model voices the result.
        // A10/#591 — the optional at-most-once idempotencyKey rides positionally (makeDeal/expose/trade
        // pick it up via their req cast; confide takes positional args, so thread it here).
        // ORW-584 (Vault Wall): the engine's own truth-record (`truthful`) never crosses to the narrator, or it could write a tell around a lie.
        // The port result keeps it (the engine reads it, and the replay cache stores it whole); only this player-channel boundary drops it.
        return playerConfideResult(this.deps.session.confide(
          args["npcId"] as EntityId,
          args["expectedBeatSeq"] as number | undefined,
          args["idempotencyKey"] as string | undefined,
        ));
      case "askJuror": // 0129 slice 3 — the engine gates + picks + records; the model voices the result
        return this.deps.session.askJuror(
          args["jurorId"] as EntityId,
          args["expectedBeatSeq"] as number | undefined,
          args["idempotencyKey"] as string | undefined,
        );
      case "accuseTie":
        // 0095 — the pre-show-tie accusation: the engine checks the sealed layer + decides + records;
        // the model only voices the result (landed/missed).
        return this.deps.session.accuseTie(
          args["aId"] as EntityId, args["bId"] as EntityId, args["expectedBeatSeq"] as number | undefined,
        );
      case "callInFavor":
        // 0142 - the engine prices whether the houseguest honors a favor they owe the player.
        return this.deps.session.callInFavor(
          args["npcId"] as EntityId, args["ask"] as Parameters<GameSession["callInFavor"]>[1], args["expectedBeatSeq"] as number | undefined,
        );
      case "confront":
        // 0094 — the closed-set confrontation: the engine classifies the cited belief + resolves the
        // outcome against reality; the model only voices the result (landed/misfired).
        return this.deps.session.confront(
          args["npcId"] as EntityId, args["factId"] as string, args["expectedBeatSeq"] as number | undefined,
        );
      case "askToTalkAlone":
        // ORW-727b - the closed-set private word: the engine picks the room, asks the houseguest's own consent and places both; the model only voices the typed result.
        return this.deps.session.askToTalkAlone(args as unknown as AskToTalkAloneReq);
      case "exposeSecret":
        // 0093 — out a learned secret: the engine validates ownership + resolves the bounded fallout + records the pathway.
        return this.deps.session.exposeSecret(args as unknown as ExposeSecretReq);
      case "tradeSecret":
        // 0099 — trade a held secret to a third party: the engine values it to the recipient + resolves + records.
        return this.deps.session.tradeSecret(args as unknown as TradeSecretReq);
      case "getVisibleStateFor":
        return this.deps.player.getVisibleState();
      case "renderScene":
        return this.deps.player.produce(args["mode"] === "dialogue" ? "NPC dialogue" : "scene narration");
      case "socialRead":
        return this.deps.player.socialRead(args["target"] as EntityId | undefined);
      case "playerDossier":
        return this.deps.session.playerDossier(args.subjectId as EntityId | undefined);
      case "playerReceipts":
        return this.deps.session.playerReceipts();
      case "socialInitiatives":
        return this.deps.session.socialInitiatives();
      case "whereabouts":
        return this.deps.session.whereabouts(args["search"] === true ? { search: true, ...(typeof args["lookingFor"] === "string" && args["lookingFor"].trim() ? { lookingFor: args["lookingFor"] } : {}) } : undefined); // ORW-386: the house search rides the same read
      case "moveTo":
        // 0065 Part A — optional expectedBeatSeq CAS token rides the args.
        return this.deps.session.movePlayer(
          String(args["room"] ?? ""),
          typeof args["expectedBeatSeq"] === "number" ? args["expectedBeatSeq"] : undefined,
        );
      case "searchForHouseguest":
        // ORW-934 - the engine walks the search leg by leg; the narrator voices the returned legs as one passage
        return this.deps.session.searchForHouseguest({
          name: String(args["name"]),
          ...(typeof args["maxLegs"] === "number" ? { maxLegs: args["maxLegs"] } : {}),
          ...(typeof args["expectedBeatSeq"] === "number" ? { expectedBeatSeq: args["expectedBeatSeq"] } : {}),
          ...(typeof args["idempotencyKey"] === "string" && args["idempotencyKey"] !== "" ? { idempotencyKey: args["idempotencyKey"] } : {}),
        });
      case "resolvePlayerMove":
        // ORW-419 - the FE-driven intent-first move (infra lever; the engine resolves the player's own words before the narrator).
        return this.deps.session.resolvePlayerMove({
          text: String(args["text"]),
          ...(typeof args["previousReply"] === "string" && args["previousReply"] !== "" ? { previousReply: args["previousReply"].slice(0, 6000) } : {}),
          ...(typeof args["expectedBeatSeq"] === "number" ? { expectedBeatSeq: args["expectedBeatSeq"] } : {}),
          ...(typeof args["idempotencyKey"] === "string" && args["idempotencyKey"] !== "" ? { idempotencyKey: args["idempotencyKey"] } : {}),
          ...(Array.isArray(args["skip"]) ? { skip: (args["skip"] as unknown[]).filter((x): x is "move" | "bed" => x === "move" || x === "bed") } : {}),
        });
      case "moveHouseguest":
        // ADR 0009 — record a narrated NPC relocation (open-set; legal-only). Vault-free result.
        return this.deps.session.recordHouseguestMove(String(args["id"] ?? ""), String(args["room"] ?? ""));
      // PREMIERE meet-everyone (feature #380 follow-on): read who's still to introduce / mark a meeting.
      case "premiereIntros":
        return this.deps.session.premiereIntros();
      case "markHouseguestMet":
        return this.deps.session.markHouseguestMet(
          args["id"] as EntityId,
          args["via"] === "belt" ? { via: "belt" } : undefined,
        );
      case "seasonRecap":
        return this.deps.session.seasonRecap();
      case "recordDaySummary":
        return this.deps.session.recordDaySummary(args as unknown as RecordDaySummaryReq);
      case "recordEpisodeTitles":
        return this.deps.session.recordEpisodeTitles(args as unknown as RecordEpisodeTitlesReq);
      case "dayLedger":
        return this.deps.session.dayLedger();
      case "dailyRecap":
        return this.deps.session.dailyRecap();
      case "hallOfFame":
        return this.deps.session.hallOfFame();
      case "seasonRetrospective":
        return this.deps.session.seasonRetrospective();
      case "npcVoice":
      {
        const v = this.deps.session.npcVoice(args["id"] as EntityId);
        if (v !== null) return v;
        // ORW-1067: a null voice carries its reason: an ambiguous name returns the candidates to choose from, never a silent miss.
        const l = this.deps.session.voiceLookup(String(args["id"]));
        return l.status === "ambiguous"
          ? { error: "ambiguous", reason: "more than one houseguest matches that name; ask again with one of the candidates", candidates: l.candidates }
          : { error: "unknown", reason: "no houseguest matches that id or name" };
      }
      case "sealedFromHouse":
        return this.deps.session.sealedFromHouse();
      case "knowledgeScopeManifest":
        return this.deps.session.knowledgeScopeManifest();
      case "getPortraitPrompt":
        return this.deps.session.getPortraitPrompt(args["id"] as EntityId);
      case "askProducers":
        return this.deps.player.ask(String(args["question"] ?? ""));
      case "endOfSessionSummary":
        return this.deps.summary.endOfSession();
      case "recordInteraction":
        return this.deps.commands.recordInteraction(args as unknown as RecordInteractionReq);
      // E20: no "resolveCompetition" case — it is off the allowlist, so `allows()` refuses it
      // before dispatch; runCompetition (the live-house session resolver) is the one authority.
      case "surfaceInformationTo":
        return this.deps.commands.surfaceInformationTo(args as unknown as SurfaceReq);
      case "diaryRoom":
        return this.deps.commands.diaryRoom(args as unknown as DiaryRoomReq);
      case "recordImageBeat":
        // BE-5 — `args` may carry the optional `expectedBeatSeq` CAS token (guarded above); the cast
        // through `RecordImageBeatReq` (not a bare `{houseguestId,imageRef}` shape) lets it flow through.
        return this.deps.commands.recordImageBeat(args as unknown as RecordImageBeatReq);
      case "inspectNonVaultState":
        return this.deps.admin.inspect();
      case "overrideMechanic":
        return this.deps.admin.overrideMechanic(args as unknown as { mechanic: string; value: unknown });
      case "configure":
        return this.deps.admin.configure(args as Record<string, unknown>);
      case "manageSandbox":
        return this.deps.admin.manageSandbox(args["op"] as "create" | "reset" | "save" | "load" | undefined);
      case "sandboxHealth":
        return this.deps.admin.health();
      case "advanceToFinale":
        // L38 (admin/God-Mode only — gated by `allows()` above): drive the season to a crowned
        // winner so the post-season retrospective can unseal. Vault-free summary out; reads no Vault.
        return this.deps.admin.advanceToFinale();
      case "producerVault":
        // DEBUG (admin/God-Mode only — gated by `allows()` above): the owner-ruled OVERRIDE of mandate
        // #2 — UNSEAL the LIVE Vault for operator debugging. The ONE Vault-reading tool; fired only
        // behind an explicit FE "unseal". Reuses the session's retrospective render (scrubbed prose).
        return this.deps.session.producerVaultDump();
      case "setTimeOfDay":
        // ADR 0006 (admin/God-Mode only): the FE settings switch flips the in-game clock at runtime.
        return this.deps.admin.setTimeOfDay(
          args["enabled"] === true || args["enabled"] === "true" || args["enabled"] === 1 || args["enabled"] === "on",
        );
      case "setBehavioralFlags":
        // B2 (admin/God-Mode only): the FE settings dial flips the living-house layers at runtime.
        // `requireShape` above already refused any present-but-non-boolean field.
        return this.deps.admin.setBehavioralFlags(args as unknown as BehavioralFlags);
      case "getBehavioralFlags":
        // B2: the read-side companion — the CURRENT resolved on/off state of every flag.
        return this.deps.admin.behavioralFlags();
      default:
        throw new Error(`unhandled tool "${name}"`);
    }
  }
}
