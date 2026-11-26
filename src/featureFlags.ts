import { defaultOnFrom } from './domain/flagDefaults';

/**
 * #1843 — Single source of truth for all opt-in behavioral-fidelity and sleep-economy
 * feature flags reported by `/health`'s `bootFlags()` block.
 *
 * Before this file, the flag definitions were duplicated across:
 *   - `src/adapters/mcp/HttpMcpServer.ts` (the inline `bootFlags()` function)
 *   - `tests/integration/httpServer.test.ts` (the hardcoded guard-test array)
 *
 * Now both consume this registry, so adding/removing a flag edits exactly one place.
 */

/**
 * How `process.env` values are coerced to boolean.
 *
 * - `strict` — only `=== '1'` is true; anything else (unset, '0', 'false') is false.
 * - `loose` — `'1'`, `'true'`, `'on'` are all true; used for flags whose runtime getter also
 *   accepts human-readable truth strings (seededTieSurfacing, timeOfDay).
 * - `inverted` — ANY value except `'0'` is true; used for flags that default ON (timePerConversation,
 *   socialFatigue).
 */
export type ParserKind = 'strict' | 'loose' | 'inverted' | 'defaultOn';

/** One entry in the canonical flag registry. */
export interface FeatureFlagDef {
  /**
   * The `process.env` variable name (e.g. `'ORWELL_CAMPAIGNS'`).
   */
  envKey: string;
  /**
   * The camelCase key exported by `bootFlagsFromEnv()` and expected in the `/health` JSON body.
   */
  key: string;
  /**
   * Which parser to apply — see `ParserKind` docs.
   */
  parser: ParserKind;
}

/**
 * All flags in display (and deployment-doc) order.
 *
 * ADDING A NEW FLAG: append it here and it will automatically appear in `/health` and the guard
 * test. DELETING: remove the entry and the contract shrinks cleanly.
 *
 * ⚠  The envKey must match what the engine's adapter actually reads at runtime (case-sensitive).
 *    See `GameSessionAdapter` module consts for the definitive list of env var names.
 */
export const FEATURE_FLAGS: FeatureFlagDef[] = [
  // B50-accuse layer. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_ACCUSE_COST', key: 'accuseCost', parser: 'defaultOn' },
  // A65 / ORW-97: the engine refuses an ordinary advanceGame before the schedule says an event is due (typed `held`). ON by default; applies only to a game a person is playing (`live.playedGame`), so headless drivers are untouched; the FE reads `held`.
  { envKey: 'ORWELL_ADVANCE_GATE', key: 'advanceGate', parser: 'defaultOn' },
  // B7 M1b: who approaches the player reads the NPC's memory of them (favor/owed promise => seek out; grudge => avoid). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_APPROACH_MEMORY', key: 'approachMemory', parser: 'defaultOn' },
  // B4 / #2017: casual assurances ("you're safe with me") recorded on scenes. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_ASSURANCES', key: 'assurances', parser: 'defaultOn' },
  // ORW-723 (Ryne: "Depends on the person. For sure."): a vote promise's pull comes from the voter's own loyalty, honesty and bond to the nominee (not a fixed weight); loyal honest friends keep it, schemers often break it. Needs ORWELL_ASSURANCES. Played games only. `=0` restores the fixed weight byte for byte.
  { envKey: 'ORWELL_ASSURANCE_PULL', key: 'assurancePull', parser: 'defaultOn' },
  // ORW-624: the audience outside - a simulated public that judges from what would make the edit; felt as the crowd at a walk-out, a fan reward, America's Favorite. `=0` = no public.
  { envKey: 'ORWELL_AUDIENCE', key: 'audience', parser: 'defaultOn' },
  // ORW-691 (B1-4 / 0194): a bad night's sleep is reachable - the old bar (a rest deficit of 0.25) is exactly a 2am bed, which no houseguest ever reaches (the latest bed is just under it), so the cause never fired; a houseguest up past 1am now has one. A played game only. `=0` = the old bar.
  { envKey: 'ORWELL_BAD_SLEEP_REACH', key: 'badSleepReach', parser: 'defaultOn' },
  // ORW-688: a houseguest who just traded a secret, or who was burned (a broken deal, an exposed secret, a betrayal), trades less, and the appetite comes back with the days; scales the fire chance after the draws, so the dedicated stream is unchanged. Played games only. `=0` = today's volume.
  { envKey: 'ORWELL_BARTER_APPETITE', key: 'barterAppetite', parser: 'defaultOn' },
  // A65: the engine-side schedule gate - an ordinary advanceGame before the next milestone is due returns a typed `held` and commits nothing. ON by default (see ORWELL_ADVANCE_GATE below); `=0` turns it off.
  // Bedtime gate: `turnIn` in the morning or afternoon is refused with a typed `held` (nothing commits). ON by default.
  { envKey: 'ORWELL_BEDTIME_GATE', key: 'bedtimeGate', parser: 'defaultOn' },
  // ORW-672 / 0201: the BED RUSH - no bed is claimed before the champagne circle closes, then everyone is released and races for the bedrooms; a claim needs reaching the room, and the player always keeps a real choice. A played game only. `=0` restores the walk-in-order claim.
  { envKey: 'ORWELL_BED_RUSH', key: 'bedRush', parser: 'defaultOn' },
  // 0181 / ORW-568 (theme 3 slice 4, part 1): a bond's life - a real feeling for someone holds a houseguest back from cutting them (a bounded vote / nomination / alliance-break term) and shakes them after they do (the existing mood, scaled). Needs the bond record. A played game only. `=0` opts out.
  { envKey: 'ORWELL_BOND_FEELINGS', key: 'bondFeelings', parser: 'defaultOn' },
  // 0175 / ORW-552 (Theme 3 Core 1): the bond record per pair (warmth, debts, resentment, strain, history, commitment), folded from what happened; nothing decides from it yet. `=0` = the edge-only bond read.
  // ORW-605: one scene weighs differently per holder (their warmth-proneness), per pair (history) and per house (the bonding lean) in the bond record. A played game only. `=0` restores the flat base fold.
  { envKey: 'ORWELL_BOND_RATES', key: 'bondRates', parser: 'defaultOn' },
  { envKey: 'ORWELL_BOND_RECORD', key: 'bondRecord', parser: 'defaultOn' },
  { envKey: 'ORWELL_BOOTH_RECEIPTS', key: 'boothReceipts', parser: 'defaultOn' },
  // ORW-212 / ORW-210: calm, non-magnetic NPC movement on the player-facing view (fewer simultaneous moves, a lower ordinary move chance, the player no longer pulls destinations, the scene-hold keeps only the houseguests the player is talking to). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_CALM_PRESENCE', key: 'calmPresence', parser: 'defaultOn' },
  { envKey: 'ORWELL_CAMPAIGNS',              key: 'campaigns',              parser: 'defaultOn' },
  // B7 / #2017 M4: campaign targets also read grudges and beliefs. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_CAMPAIGN_MEMORY', key: 'campaignMemory', parser: 'defaultOn' },
  // 0050 / the standing rule "ask gender or pronouns, don't assume": while the player's pronouns are not on file, the casting interview's status carries a one-line board fact so the producer asks ONCE in its own voice; a skip is recorded as "unstated" and ends the ask. A stated answer the model did not file is recorded by the front end from the player's own words. Never inferred. `=0` restores the old casting context byte for byte.
  { envKey: 'ORWELL_CASTING_PRONOUN_ASK', key: 'castingPronounAsk', parser: 'defaultOn' },
  // 0197 / ORW-631: catching a misdirection - a lead a houseguest gave the player about where someone is is recorded (engine-only: where the person really was, whether it was meant to mislead) and resolved by what the player later sees; a lead that did not pan out is handed to the narrator as a plain observed fact. Played games only. `=0` turns it off (byte-identical).
  { envKey: 'ORWELL_CATCH_MISDIRECTION', key: 'catchMisdirection', parser: 'defaultOn' },
  // ORW-715 (Fable season playtest W1-1): the ceremony facts the narrator was missing - whether the veto holder's decision has been made yet (and, once made, which way it went and who came down), and who is still on the floor of a staged competition. Without them a narrator invented a veto result a day early, got the announced one wrong, and put an eliminated houseguest back into the final round. Facts to the narrator only; no outcome changes. A played game only. `=0` = today's prompt, byte for byte.
  { envKey: 'ORWELL_CEREMONY_FACTS', key: 'ceremonyFacts', parser: 'defaultOn' },
  // A52 / ORW-23 (Ryne card 19: the narrator does not improvise disclosures): in a played game `npcVoice.knows` is only what the player also holds (engine-delivered or witnessed together); a declined press carries `deflect`. ON by default; `=0` turns it off.
  // 0151 / ORW-330 (theme 2 slice 4a): a houseguest who trusts the player may pass on one belief per day, hedged by their certainty (engine-decided, own side stream, no outcome moves). Default-ON; `=0` opts out.
  { envKey: 'ORWELL_CLAIMS_TO_PLAYER', key: 'claimsToPlayer', parser: 'defaultOn' },
  // 0203 / ORW-646 (Theme 4): coming clean, nuanced - a houseguest may own a lie before it is caught (costs less than being caught), loop an ally in on a lie told to someone else, and the player may do either in their own words. Played games only; `=0` turns it off (byte-identical).
  { envKey: 'ORWELL_COMING_CLEAN', key: 'comingClean', parser: 'defaultOn' },
  { envKey: 'ORWELL_COMP_INTENT',            key: 'compIntent',             parser: 'defaultOn' },
  { envKey: 'ORWELL_COMP_MECHANICS_PLUS',    key: 'compMechanicsPlus',      parser: 'defaultOn' },
  { envKey: 'ORWELL_COMP_MIXED',             key: 'compMixed',              parser: 'defaultOn' },
  // The houseguests who are not in a running staged competition cheer, taunt or sulk through it (played games only). ON by default; `=0` turns it off.
  { envKey: 'ORWELL_COMP_REACTIONS',          key: 'compReactions',          parser: 'defaultOn' },
  { envKey: 'ORWELL_CONFESSIONAL_DEPTH',     key: 'confessionalDepth',      parser: 'defaultOn' },
  // ORW-650 (0133): watching from the couch, richer - an evicted player who keeps watching gets the season's real public moments (ceremonies, competition results), never anything hidden. ON by default; `=0` keeps the skeleton digests only.
  { envKey: 'ORWELL_COUCH_WATCH', key: 'couchWatch', parser: 'defaultOn' },
  // ORW-767 (0207): a showmance reaches the player by being TOLD. A houseguest who saw a romance scene (or was told of one) may pass the pair to the player in their own words, hedged by how sure they are; the player then knows the pair as a belief with a source (never as the truth), and the narrator's showmance list and the pace record's seen-by read it. `=0` opts out (byte-identical).
  { envKey: 'ORWELL_COUPLE_TOLD', key: 'coupleTold', parser: 'defaultOn' },
  // ORW-685 / 0152 (T2-14; ORW-687 adds the mirror: a houseguest may ask the PLAYER "who told you that?" about a claim the player passed on, and reads the player's own answer against the engine's record of who really told them): a liar asked "who told you that?" about a lie they planted may play it off (say they saw it, or refuse to say) or let the cover slip, a visible stumble scaled by how good an actor they are (their cunning and how rattled they are), decided on a keyed side stream and recorded once. Played games only. ON by default; `=0` turns it off.
  { envKey: 'ORWELL_COVER_SLIPS', key: 'coverSlips', parser: 'defaultOn' },
  // B48-credibility layer. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_CREDIBILITY', key: 'credibility', parser: 'defaultOn' },
  // ORW-271 slice 1: the append-only per-night day ledger (a floor entry at each turnIn + the FE-driven recordDaySummary write-back) for a played game. ON by default; `=0` turns it off.
  { envKey: 'ORWELL_DAY_CONDENSE', key: 'dayCondense', parser: 'defaultOn' },
  // ORW-614 (P-12): the player can answer a standing deal offer with terms of their own (a counter through `makeDeal`); the offer closes as countered and the houseguest's own consent read decides. Played games only. `=0` = accept or decline only.
  { envKey: 'ORWELL_DEAL_COUNTER', key: 'dealCounter', parser: 'defaultOn' },
  { envKey: 'ORWELL_DEAL_DEPTH',             key: 'dealDepth',              parser: 'defaultOn' },
  // 0186 / ORW-552 (theme 3 slice 14): a deal exposed - a partner who learns their final two is not the only one loses trust in the double-dealer; a partner's HOH win or a double eviction reopens open deals on new terms. A played game only. `=0` opts out.
  { envKey: 'ORWELL_DEAL_EXPOSURE', key: 'dealExposure', parser: 'defaultOn' },
  // B7 / #2017 M3: open protective deals also feed the HOH's nominations. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_DEAL_NOMS', key: 'dealNoms', parser: 'defaultOn' },
  // 0178 / ORW-552 (Theme 3 slice 1): two-faced deals - each NPC's secret plan for a deal it agreed to (keep / this week / break at a moment / flip at the vote / cut at the final three), carried out at its moment. `=0` = no plans.
  { envKey: 'ORWELL_DEAL_PLANS', key: 'dealPlans', parser: 'defaultOn' },
  { envKey: 'ORWELL_DEAL_WITNESSES', key: 'dealsWitnesses', parser: 'defaultOn' },
  // ORW-737: the engine decides what a houseguest DECLARES to the player about a future vote, nomination or veto (a closed will-keep / wont-commit stance; the narrator voices only that), and the eviction-night list of who promised to keep the player comes from the real assurance ledger. ON by default; `=0` turns it off.
  { envKey: 'ORWELL_DECLARED_STANCE', key: 'declaredStance', parser: 'defaultOn' },
  // A8: the NPC desire clock (an NPC whose want crossed its threshold cuts in). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_DESIRE_CLOCK', key: 'desireClock', parser: 'defaultOn' },
  // ORW-668 / 0210 C2: production visibly calls a houseguest to the Diary Room and the house sees them go and come back (who, how long, how they looked; never what was said); the player is invited, never sent. A played game only; changes no outcome. `=0` opts out.
  { envKey: 'ORWELL_DIARY_CALLS', key: 'diaryCalls', parser: 'defaultOn' },
  { envKey: 'ORWELL_DISCLOSURE_ENGINE', key: 'disclosureEngine', parser: 'defaultOn' },
  // ORW-685 / A52 (T2-14; ORW-687 extends it to the 0092 drip and the orientation disclosure, which never gets a `slants` fact): the spin the disclosure engine already rolls (a cunning teller slants what they disclose) now reaches the player: a truthful confidence told with a slant is recorded at a lower confidence (the same SPIN constants a houseguest-to-houseguest telling uses) and the narrator is handed a third-person `slants` fact. Needs ORWELL_DISCLOSURE_ENGINE. Played games only. ON by default; `=0` turns it off.
  { envKey: 'ORWELL_DISCLOSURE_SPIN', key: 'disclosureSpin', parser: 'defaultOn' },
  // 0196 / ORW-630: a pressed houseguest the engine has decided will not answer also gets HOW they dodge (what they do with the question, how their carriage reads, whether they hand it back), decided on a keyed side stream from their character, bond and the stakes, saved, and handed to the narrator as a third-person fact. A played game only. `=0` turns it off.
  { envKey: 'ORWELL_DODGING', key: 'dodging', parser: 'defaultOn' },
  // B32 / #2017 E5: chat betrayal/conflict feed the emotional arc and temperament drift gets a negativity bias (clash x1.5, bond x0.75) so hardening is reachable. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  // ORW-705 PT-10 (PO ruling 2026-11-19): a player who woke at their own early hour (bed + 8h, before the house's wake-up call) can `turnIn` to doze back to bed - the clock moves to the wake-up call and no later; a still-tired early-waking houseguest (the hidden rest meter) dozes back too and is out of the awake set until the call. A played game only. ON by default; `=0` restores the refusal.
  { envKey: 'ORWELL_DOZE_BACK_TO_BED', key: 'dozeBackToBed', parser: 'defaultOn' },
  { envKey: 'ORWELL_DRIFT_FIX', key: 'driftFix', parser: 'defaultOn' },
  // B51 / AMEND 3b: the HOH's / veto holder's own drive (target adds, build protects) feeds its nomination and veto-save scores. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_DRIVE_DECISIONS', key: 'driveDecisions', parser: 'defaultOn' },
  // ORW-691 (B1-5 / 0200): YOUR EDIT also reads the replacement a veto save brings, the house meetings and the schemes (weighted since it shipped, never emitted). Read-only, after the crown, no fold. `=0` = the old cut.
  { envKey: 'ORWELL_EDIT_MOMENTS', key: 'editMoments', parser: 'defaultOn' },
  // ORW-87 / B7 remainder: the NPC final HOH's Final-3 eviction and the secret-veto replacement read the NPC's memory ledger (grudge/favor), for a played game only. ON by default; `=0` turns it off.
  { envKey: 'ORWELL_ENDGAME_MEMORY', key: 'endgameMemory', parser: 'defaultOn' },
  // 0193 / ORW-623: the endgame changes the rules of trust - at four left, "can I beat you?" pushes nominations and the vote, tilts reassurances toward faking, and final twos get tested out loud. `=0` = off.
  { envKey: 'ORWELL_ENDGAME_TRUST', key: 'endgameTrust', parser: 'defaultOn' },
  // 0184 part 2b / ORW-564: a close pair fakes distance in public - their time together is caught only on a roll, and the house reads them as no closer than it has seen. `=0` = off.
  { envKey: 'ORWELL_FAKED_DISTANCE', key: 'fakedDistance', parser: 'defaultOn' },
  // ORW-740b (ADR 0009, 2026-11-20): the narrator is handed the room the engine stages the next event in (ceremonies in the living room, competitions in the backyard) and, while one runs, the room the house is gathered in, instead of a fixed "the living room" for every event. `=0` = the old wording.
  { envKey: 'ORWELL_EVENT_ROOM_FACT', key: 'eventRoomFact', parser: 'defaultOn' },
  // 0195 / ORW-628: what the evicted take with them - their deals, favors and assurances leave with them (a held favor may pass to their closest ally), and the house reacts. `=0` = off.
  { envKey: 'ORWELL_EVICTED_TAKE', key: 'evictedTake', parser: 'defaultOn' },
  { envKey: 'ORWELL_FAVORS', key: 'favors', parser: 'defaultOn' },
  { envKey: 'ORWELL_FINAL_HOH_THREE_PART',   key: 'finalHohThreePart',      parser: 'defaultOn' },
  // B27: the forgiveness trait (a seeded ~1-in-6 grudge-keeper whose real betrayals keep a floor; everyone else's favors fade fast). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_FORGIVENESS', key: 'forgiveness', parser: 'defaultOn' },
  { envKey: 'ORWELL_GOAL_MOOD',               key: 'goalMood',               parser: 'defaultOn' },
  // ORW-625: plans that last longer than an hour - each goal's stored short plan, carried across hours and days, dropped only for a reason. `=0` = the hour re-rolls each step.
  { envKey: 'ORWELL_GOAL_PLANS', key: 'goalPlans', parser: 'defaultOn' },
  // ORW-546 (0169): off-screen gossip feeds beliefs - a heard rumor carries its teller and a conviction, counts as a soft grievance in decisions, and moves feelings in proportion. ON by default (PO: "if it's built, turn it on"); `=0` restores the record-only rumor.
  { envKey: 'ORWELL_GOSSIP_BELIEFS', key: 'gossipBeliefs', parser: 'defaultOn' },
  { envKey: 'ORWELL_GOSSIP_CONSEQUENCE',      key: 'gossipConsequence',      parser: 'defaultOn' },
  // B10 / B11 / #2017: information spreads only by co-presence, by the holder's choice (share / slip / hold) instead of automatic graph diffusion. ON by default; `=0` turns it off.
  { envKey: 'ORWELL_GOSSIP_COPRESENCE', key: 'gossipCopresence', parser: 'defaultOn' },
  // #1397 / ORW-589: character-mediated gossip drift. Also drives the same-room retelling drift (from the 2nd retelling, a hedge in the teller's voice and a fractional distortion) and the room's awake people counting as the audience. Played games only for the same-room part. `=0` is byte-identical.
  { envKey: 'ORWELL_GOSSIP_DRIFT',           key: 'gossipDrift',            parser: 'defaultOn' },
  // 0183 / ORW-566 (Theme 3 slice 7 a-b): close pairs keep a private debrief spot after ceremonies, alliances are named from the house's own authored words, a third houseguest who sees a habit starts to suspect the pair. Played games only. `=0` is the kill switch.
  { envKey: 'ORWELL_GROUP_IDENTITY', key: 'groupIdentity', parser: 'defaultOn' },
  // 0176 / ORW-561 (theme 3 slice 10, part 1): homophily - houseguests who are alike (look, age, region, job, temperament) bond a little faster and sour slower, a mismatched pair the reverse. A played game only. `=0` opts out.
  // 0172 / ORW-603, ORW-611 (Theme 3 slice 6): alliances hold hidden roles, an inner circle, a private cut order, a spy or a shadow group, and can crack; a pitch shows only the roster the player was told; plans aimed at the player are acted on. A played game only. `=0` opts out.
  { envKey: 'ORWELL_GROUP_ROLES', key: 'groupRoles', parser: 'defaultOn' },
  // 0182 / ORW-569 (theme 3 slice 5, PR 1): the grudge book - a hidden record of who holds a grudge against whom and why, fading but never zero. Nothing decides from it yet. A played game only; needs ORWELL_BOND_RECORD. `=0` opts out.
  { envKey: 'ORWELL_GRUDGES', key: 'grudges', parser: 'defaultOn' },
  { envKey: 'ORWELL_HANGOUT',               key: 'hangOut',                parser: 'defaultOn' },
  // B7 M4b: an NPC Houseguest's-Choice holder's sixth-player pick reads their memory/beliefs/owed deals beside the bond. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_HC_MEMORY', key: 'hcMemory', parser: 'defaultOn' },
  // ORW-101 / spec 0005 PO expansion: the NPC Houseguest's-Choice holder picks the strongest STRATEGIC sixth veto player for their game this week (role-aware, from hidden edges + comp stats), not merely their strongest bond. ON by default; `=0` turns it off.
  { envKey: 'ORWELL_HC_STRATEGY', key: 'hcStrategy', parser: 'defaultOn' },
  // B24 / #2017 14.5(5): what an NPC is TOLD about the player in a recorded chat scene (`recordInteraction.heardAboutMe`) writes a belief claim for each named listener at the teller's reliability, sometimes wrong by construction (seeded, bounded). Needs ORWELL_NPC_BELIEFS. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_HEARD_ABOUT_ME', key: 'heardAboutMe', parser: 'defaultOn' },
  // ORW-692 (Fable bug scan B1-8): the herd's writer. A houseguest working to get a house nominee out, in a scene with another houseguest in a vote week, is HEARD doing it (the partner, and bystanders in the room on their own keyed roll), so the voices the herd counts (`heard-rumor` going-after, this week) can really arise. Needs ORWELL_NPC_BELIEFS and ORWELL_HOUSE_NORMS. A played game only. `=0` restores the old read byte for byte.
  { envKey: 'ORWELL_HERD_VOICES', key: 'herdVoices', parser: 'defaultOn' },
  // 0173 (theme 3 slice 11): status and the HOH court - a hidden pecking order and informal leaders (never shown), houseguests seeking out the new HOH (the ones in danger most, the player-HOH too), a power vacuum when a leader leaves, and the third-person goal actions (campaign against, wedge, lobby for, count votes) moving the listener's read of the named person. A played game only. `=0` opts out.
  { envKey: 'ORWELL_HOH_COURT', key: 'hohCourt', parser: 'defaultOn' },
  // ORW-620 (spec 0192): late-night talks among the houseguests still awake, catchable by a player who stays up; sleepers never scheme. ON by default; `=0` turns it off.
  // ORW-629 (spec 0199): the HOH room is opened to the whole house; a rare snub the house reads as rude; a mask that slips by how well a guest can act; photos and a letter reveal one true backstory fact. ON by default; `=0` turns it off.
  { envKey: 'ORWELL_HOH_ROOM', key: 'hohRoom', parser: 'defaultOn' },
  { envKey: 'ORWELL_HOMOPHILY', key: 'homophily', parser: 'defaultOn' },
  // ORW-667 / 0210 C1: the host of eviction night - a seeded manner and the public facts of the night, handed to the narrator on a played eviction; changes no outcome. `=0` = no host block.
  { envKey: 'ORWELL_HOST', key: 'host', parser: 'defaultOn' },
  // 0168 / ORW-551 (house culture slice 1): a played season draws a loose seeded blend of a few culture leans, stored engine-only; nothing reads it yet, so no dial moves. `=0` opts out.
  { envKey: 'ORWELL_HOUSE_CULTURE', key: 'houseCulture', parser: 'defaultOn' },
  { envKey: 'ORWELL_HOUSE_LIFE',              key: 'houseLife',              parser: 'defaultOn' },
  // 0156 / ORW-330 (theme 2 slice 7a): house meetings - an accusation in front of the house, the accused answers, each listener decides who to believe. NPCs call at most one a week; the player's call is slice 7b.
  { envKey: 'ORWELL_HOUSE_MEETINGS', key: 'houseMeetings', parser: 'defaultOn' },
  // 0180 / ORW-552 (Theme 3 slice 12 part 1): house norms - the house shuns a houseguest (or the player) it KNOWS broke their word (each observer's own held beliefs). `=0` = no shunning.
  { envKey: 'ORWELL_HOUSE_NORMS', key: 'houseNorms', parser: 'defaultOn' },
  // ORW-654 / 0206: the SELF-GUIDED TOUR - once the player has walked in they explore the house freely, the houseguests mostly gather in the open common area with a few wandering, and the first entry into each room hands the narrator that room's card (the season's own name and look for it). The champagne circle is called after the tour. A played game only. `=0` restores the held premiere.
  { envKey: 'ORWELL_HOUSE_TOUR', key: 'houseTour', parser: 'defaultOn' },
  { envKey: 'ORWELL_JUROR_PROFILES',          key: 'jurorProfiles',          parser: 'defaultOn' },
  { envKey: 'ORWELL_JURY_HOUSE',             key: 'juryHouse',              parser: 'defaultOn' },
  // B26-jury layer. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_JURY_MEMORY', key: 'juryMemory', parser: 'defaultOn' },
  // 0202 / ORW-645: leverage in two registers - a houseguest who holds a secret about someone may lean on them blunt (an explicit demand) or sneaky (quiet pressure), or simply keep it; the player can lean either way too (a `manner` on makeDeal's leverage). Played games only. ON by default; `=0` turns it off, byte-identical.
  { envKey: 'ORWELL_LEVERAGE_PLAYS', key: 'leveragePlays', parser: 'defaultOn' },
  // B23 / #2017 14.5(3): a lie exposed (a believed bluff caught by a real expose/trade, a landed accuseTie) writes a `lied-to-me` belief claim at the evidence's confidence; a believed bluff is stored as a belief too. Needs ORWELL_NPC_BELIEFS. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_LIES_CAUGHT', key: 'liesCaught', parser: 'defaultOn' },
  // B6 / #2017: NPC-to-NPC lobbying of the HOH (a bounded pitch tilt in the nomination score). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_LOBBYING', key: 'lobbying', parser: 'defaultOn' },
  // ORW-652 (Ryne 11-17): a double eviction plays as ONE long night in a played game - the second cycle (instant HOH, hurried nominations, rushed veto, second eviction) charges a fraction of its hours, never rolls the day, and no schedule or bedtime hold interrupts it; the narrator is told the night's shape each turn. ON by default; `=0` turns it off, byte-identical.
  { envKey: 'ORWELL_LONG_NIGHT', key: 'longNight', parser: 'defaultOn' },
  // ORW-653 / 0205: MEET THE CAST - the champagne circle's toast speakers are officially introduced one by one and each forms a first impression of the player (a small hidden fold); the narrator is handed their visible manner as facts. A played game only. `=0` = the old circle.
  { envKey: 'ORWELL_MEET_THE_CAST', key: 'meetTheCast', parser: 'defaultOn' },
  // B25-friends layer. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_MEMORY_FRIENDS', key: 'memoryFriends', parser: 'defaultOn' },
  // B22: houseguests who HEARD a promise (a casual assurance) remember its keeping / breaking too, at a lower weight. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_MEMORY_PROMISES', key: 'memoryPromises', parser: 'defaultOn' },
  // ORW-710 (Vault Wall): during the premiere's entrances the state read and the narrator's roster carry only the houseguests who have walked in (the player's met set); the rest are a count, with no name or card, until their own entrance. `=0` ships the whole cast as before.
  { envKey: 'ORWELL_MET_ONLY_ROSTER', key: 'metOnlyRoster', parser: 'defaultOn' },
  // B30 / #2017 E4a: who seeks the player out reads the NPC's visible emotional state (needs ORWELL_NPC_TELLS). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_MOOD_APPROACH', key: 'moodApproach', parser: 'defaultOn' },
  { envKey: 'ORWELL_MOOD_CAMPAIGN', key: 'moodCampaign', parser: 'defaultOn' },
  // 0194 / ORW-626: more things give a houseguest a mood cause (a lie found out, a betrayal learned, a close friend gone, a bad night's sleep, a win, a loss); engine-only, told only when they choose
  { envKey: 'ORWELL_MOOD_CAUSES', key: 'moodCauses', parser: 'defaultOn' },
  // 0185 / ORW-567 (theme 3 slice 15): mood contagion - a shocking eviction rattles the evictee's close allies most and the house a little; a big win lifts the winner's circle a little. Moves the existing mood only. A played game only. `=0` opts out.
  { envKey: 'ORWELL_MOOD_CONTAGION', key: 'moodContagion', parser: 'defaultOn' },
  // ORW-343 (Ryne audit card 17, 2026-11-04): the cast card shows each houseguest's mood word as the player last saw it. ON by default; `=0` turns it off.
  { envKey: 'ORWELL_MOOD_CUE', key: 'moodCue', parser: 'defaultOn' },
  // B31 / #2017 E4b: visible mood shifts NPC deal consent (protection accepted more when rattled) and campaign formation (a rattled NPC forms none). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_MOOD_DEAL', key: 'moodDeal', parser: 'defaultOn' },
  // B30 / #2017 E4a: a visibly rattled veto holder rescues the nominee they are close to (needs ORWELL_NPC_TELLS). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_MOOD_VETO', key: 'moodVeto', parser: 'defaultOn' },
  // A22: NPC approaches during the Day-1 social morning after the toast. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_MORNING_APPROACH', key: 'morningApproach', parser: 'defaultOn' },
  { envKey: 'ORWELL_MULTI_NIGHT_FATIGUE',    key: 'multiNightFatigue',      parser: 'defaultOn' },
  { envKey: 'ORWELL_MYTH_MAKING',            key: 'mythMaking',             parser: 'defaultOn' },
  // 0148 / ORW-417 (Ryne 2026-11-15): the player's daytime nap (`nap` lever). ON by default; `=0` makes the lever refuse 'not available' (byte-identical).
  { envKey: 'ORWELL_NAP', key: 'nap', parser: 'defaultOn' },
  { envKey: 'ORWELL_NARRATION_USAGE', key: 'narrationUsage', parser: 'defaultOn' },
  // 0179 / ORW-552 (Theme 3 slice 9): the house's shape in the co-presence spread - brokers carry news across cliques, weak ties carry across, loners hear late. `=0` = the spread reads no shape.
  { envKey: 'ORWELL_NETWORK_SPREAD', key: 'networkSpread', parser: 'defaultOn' },
  { envKey: 'ORWELL_NIGHT_OWLS', key: 'nightOwls', parser: 'defaultOn' },
  // B49 / PO ruling card 24: the hard per-season counts (NPC confide lies 2, player exposes 3, trades 5) stop being a design rule - ON leaves only a high safety valve and an escalating, recipient-scaled REPETITION COST on each further expose/trade/lie by the same actor. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_NO_HARD_CAPS', key: 'noHardCaps', parser: 'defaultOn' },
  // ORW-692 (Fable bug scan B1-10): the assurance vote shield's NPC-to-NPC writer. A nominee who calls in a favor or bargains with a houseguest who will vote is answered with an assurance on the ledger (kind vote, the engine's own sincerity), so a kept one can shield them at the vote. Needs ORWELL_ASSURANCES. A played game only. `=0` restores the old read byte for byte.
  { envKey: 'ORWELL_NPC_ASSURANCES', key: 'npcAssurances', parser: 'defaultOn' },
  // #2017 S0a: the NPC belief store. Default-ON (PO ruling 2026-11-04, Ryne: "turn it on"); `=0`/`false`/`off` opts out, `ORWELL_FLAGS_OFF=1` forces off.
  { envKey: 'ORWELL_NPC_BELIEFS', key: 'npcBeliefs', parser: 'defaultOn' },
  // B3 / #2017 (+B3b vote term): the HOH nominates / the house votes from its BELIEF about who is targeting it (needs ORWELL_NPC_BELIEFS). Default-ON with it (PO 2026-11-04).
  { envKey: 'ORWELL_NPC_BELIEF_NOMS', key: 'npcBeliefNoms', parser: 'defaultOn' },
  // 0170 (Theme 3 slice 2): the house seals several NPC-to-NPC pacts a week, each side with its own secret plan, and an HOH's nominations read their own plan. ON by default; `=0` restores the single legacy pact.
  { envKey: 'ORWELL_NPC_DEALS', key: 'npcDeals', parser: 'defaultOn' },
  // Anti-sycophancy: the ENGINE decides whether an NPC agrees to a player's proposed deal (from the NPC's own read of the player); a refusal records nothing. Default-ON; `=0` restores today's record-every-deal behaviour.
  { envKey: 'ORWELL_NPC_DEAL_CONSENT', key: 'npcDealConsent', parser: 'defaultOn' },
  { envKey: 'ORWELL_NPC_DEAL_OFFERS',        key: 'npcDealOffers',          parser: 'defaultOn' },
  { envKey: 'ORWELL_NPC_MEMORY',             key: 'npcMemory',              parser: 'defaultOn' },
  { envKey: 'ORWELL_NPC_MEMORY_SPEECH', key: 'npcMemorySpeech', parser: 'defaultOn' },
  // B2 / #2017: read the NPC memory standalone so remembered betrayals/favors visibly sway votes + nominations. Default-ON (PO: "memories should be turned on", 2026-11-04) after the 3-arm PO-band re-measure.
  { envKey: 'ORWELL_NPC_MEMORY_STANDALONE', key: 'npcMemoryStandalone', parser: 'defaultOn' },
  // B2 follow-on: write the memories a season actually produces (remembered nominations, withheld vetoes, kept deals). Default-ON with the standalone read.
  { envKey: 'ORWELL_NPC_MEMORY_WRITERS', key: 'npcMemoryWriters', parser: 'defaultOn' },
  { envKey: 'ORWELL_NPC_MINDS_ENDGAME',       key: 'npcMindsEndgame',        parser: 'defaultOn' },
  // A49 / #2017 E1a: npcVoice hands the narrator each PRESENT houseguest's observable tells (top 2, words only). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_NPC_TELLS', key: 'npcTells', parser: 'defaultOn' },
  // ORW-407 slices 1-2: the open ledger - a commitment, group pact, plan or claim (about someone or something) said to or by the player, or overheard by them, is kept as free text, can be marked kept, broken or withdrawn, and is shown back when the people it concerns are present. ON by default ("built means on"); `=0` turns it off.
  { envKey: 'ORWELL_OPEN_LEDGER', key: 'openLedger', parser: 'defaultOn' },
  // 0191 / ORW-574 (Fable T1-6): in a PLAYED game an NPC's decisions read the decider's own view (what they saw, were told, believe, and the public record), never another houseguest's hidden edges or stats. `=0` = the hidden reads, byte-identical.
  { envKey: 'ORWELL_OWN_VIEW', key: 'ownView', parser: 'defaultOn' },
  // 0163 / ORW-539: the HOH's floater and duo reads see the bonds the HOH could see (scenes they were in or watched, allied-with beliefs), blended with the truth. `=0` = the hidden-truth read.
  { envKey: 'ORWELL_PERCEIVED_BONDS', key: 'perceivedBonds', parser: 'defaultOn' },
  // ORW-37 / B40: lasting game philosophies - each NPC plays one philosophy (a seeded draw conditioned on archetype) that sets the nomination style they play. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_PHILOSOPHIES', key: 'philosophies', parser: 'defaultOn' },
  // 0172 / ORW-611: a houseguest's goal step aimed at the player is recorded (a player-witnessed event once it surfaces), answerable by talking to them or striking a deal, and a hostile one the player ignores sours that houseguest's read of them. Played games only. ON by default; `=0` turns it off, byte-identical.
  { envKey: 'ORWELL_PLAYER_AIMED', key: 'playerAimed', parser: 'defaultOn' },
  { envKey: 'ORWELL_PLAYER_DOSSIER', key: 'playerDossier', parser: 'defaultOn' },
  // ORW-614 (P-11): flirt, strategy and gossip scenes move a houseguest's mood and memory like the four scene kinds that already did (the player's scenes and those between houseguests read one table). Played games only. `=0` = those kinds move nothing.
  { envKey: 'ORWELL_PLAYER_SCENE_MOVES', key: 'playerSceneMoves', parser: 'defaultOn' },
  { envKey: 'ORWELL_PREMIERE_ENTRANCES',   key: 'premiereEntrances',      parser: 'defaultOn' },
  // ORW-705 / PT-10: in a played game an entrance or toast release is billed by the player's message alone (one message-step), not that step plus a 9-minute premiere step on top (14 minutes a message). `=0` = the old double bill.
  { envKey: 'ORWELL_PREMIERE_ONE_STEP', key: 'premiereOneStep', parser: 'defaultOn' },
  // ORW-669 / 0210 C3: in the player's own Diary Room the producer may raise a said-vs-did contradiction from the player's own recorded public record (a promise, then an act against the same houseguest); facts to the narrator, no outcome or relationship change, nothing reaches any houseguest. A played game only. `=0` opts out.
  { envKey: 'ORWELL_PRODUCER_PUSHBACK', key: 'producerPushback', parser: 'defaultOn' },
  { envKey: 'ORWELL_PRODUCER_READ', key: 'producerRead', parser: 'defaultOn' },
  // 0187 / ORW-586: promises BIND: an open-ledger entry may carry a typed term the engine judges from board facts (kept/broken + trust fold); a model may only withdraw it. Needs ORWELL_ASSURANCES. `=0` turns it off.
  { envKey: 'ORWELL_PROMISE_TERMS', key: 'promiseTerms', parser: 'defaultOn' },
  // 0025 reactive twists: default-ON (PO ruling 2026-11-03, "I want to know if this breaks the game"; the FE `secret-veto` card is built, #2015). `=0`/`false`/`off`
  // opts out and `ORWELL_FLAGS_OFF=1` forces it off, like every default-on flag. There is deliberately no God-Mode dial entry: the sealed twist plan is fixed at
  // `createCharacter`, so a mid-season dial would do nothing.
  { envKey: 'ORWELL_REACTIVE_TWISTS',        key: 'reactiveTwists',         parser: 'defaultOn' },
  // 0184 / ORW-564 (theme 3 slice 8, part 1): reputations - what each houseguest has heard or seen of another's lying and turning on people (softened by promises kept to them) scales how far they believe that houseguest and how willing they are to deal with them. Hidden. A played game only; needs ORWELL_BOND_RECORD. `=0` opts out.
  // ORW-639 (Fable stacking audit S-10): the replacement nominee is picked with the same deal, pre-show tie, lobbying and kept-assurance terms as the original nominations (they were dropped before). A played game only; `=0` opts out.
  { envKey: 'ORWELL_REPLACEMENT_TERMS', key: 'replacementTerms', parser: 'defaultOn' },
  { envKey: 'ORWELL_REPUTATION', key: 'reputation', parser: 'defaultOn' },
  // 0211 / ORW-649 (Ryne approved 2026-11-17): the reunion on finale night - after the crown the retrospective also carries the confrontations, the lies that come out and the alliances to explain, as facts the narrator voices. Read-only: a played, finished game only; `=0` = none.
  { envKey: 'ORWELL_REUNION', key: 'reunion', parser: 'defaultOn' },
  // ORW-223 slice 1 (Showrunner memory part B): the room canon ledger - the narrated texture of a room is recorded as canon and listed in the Show Brief. ON by default ("built means on"); `=0` turns it off.
  { envKey: 'ORWELL_ROOM_CANON', key: 'roomCanon', parser: 'defaultOn' },
  // ORW-621 (spec 0198): the houseguests in the player's own room take their goal steps there, in the player's view (a bounded few; the player is never moved or spoken for). ON by default; `=0` turns it off.
  { envKey: 'ORWELL_ROOM_LIFE', key: 'roomLife', parser: 'defaultOn' },
  // 0209 / ORW-651 (Ryne approved 2026-11-17): each houseguest's routines (a time, a place, an act, composed from the character) shape where they are and what they do in a free hour, replacing the named-habit pull; the player learns one by seeing it on three separate days. Played games only; `=0` = the old habit branch.
  { envKey: 'ORWELL_ROUTINES', key: 'routines', parser: 'defaultOn' },
  // ORW-743 (0204 part 2): when a fact about the player is closing in, the narrator is told one bit (people are talking about the player) and the player may say it first in their own words (submitDecision say-it-first). ON by default; `=0` = no card.
  { envKey: 'ORWELL_SAY_IT_FIRST', key: 'sayItFirst', parser: 'defaultOn' },
  // ORW-688: a scene or thread rumor carries who it is ABOUT, so barter (0099), leverage (0202) and the night it all comes out (0204) can match it; an old save's rumors are backfilled from their own fields. Played games only. ON by default; `=0` leaves rumors subject-less (byte-identical).
  { envKey: 'ORWELL_RUMOR_SUBJECTS', key: 'rumorSubjects', parser: 'defaultOn' },
  // ORW-578 (b): a reason an NPC gave aloud at a public act is kept as a witnessed event (the said kind in words only; never the real reason). ON by default; `=0` turns it off.
  { envKey: 'ORWELL_SAID_ALOUD_MEMORY', key: 'saidAloudMemory', parser: 'defaultOn' },
  { envKey: 'ORWELL_SCHEME_TARGETS',         key: 'schemeTargets',          parser: 'defaultOn' },
  // 0208 / ORW-662,663 (Theme B, Ryne approved 2026-11-18): seasons remember. A finished, played season's houseguests are archived per player, and a RETURN may cast one back (softened feelings, their own account); `=0` archives nothing and casts none.
  // 0208 / ORW-664 (Theme B slice B2, Ryne approved 2026-11-18): a returning player's reputation walks in deeper - the house's heard record of their broken word at season end (0184 standing, a bounded mean) feeds the treachery the next cast reads on day one, and the narrator is told the name they carry. Only when the player returns as the same character (0104); a new start gets nothing. `=0` is today's 0104 alone.
  { envKey: 'ORWELL_SEASON_MEMORY', key: 'seasonMemory', parser: 'defaultOn' },
  { envKey: 'ORWELL_SECRET_BARTER',          key: 'secretBarter',           parser: 'defaultOn' },
  // ORW-614 (P-11): houseguests may trade a secret ABOUT the player among themselves, the same hidden told-by transfer as any subject; nothing reaches the player except through a later in-game pathway with a source. Played games only. `=0` = the player is never a barter subject.
  { envKey: 'ORWELL_SECRET_BARTER_PLAYER', key: 'secretBarterPlayer', parser: 'defaultOn' },
  // ORW-647 (spec 0204): the night it all comes out - a fact enough houseguests hold breaks in front of the awake house, or its own subject blows it up when pressured; consequences land through the bond, belief and grudge stores. ON by default; `=0` turns it off.
  { envKey: 'ORWELL_SECRET_BREAKS', key: 'secretBreaks', parser: 'defaultOn' },
  { envKey: 'ORWELL_SECRET_PACING',          key: 'secretPacing',           parser: 'defaultOn' },
  { envKey: 'ORWELL_SEEDED_TIE_SURFACING',   key: 'seededTieSurfacing',    parser: 'defaultOn' },
  { envKey: 'ORWELL_SHOWMANCES',             key: 'showmances',             parser: 'defaultOn' }, // 0207 / Theme A
  // ORW-736 (0207, PO ruling: a showmance is a slow build over weeks, not a switch): each pair's stages need days together and chemistry accrued, can stall or fade, are noticed in steps, and a public couple forms only late. Played games only; `=0` = the old affinity-threshold stages.
  { envKey: 'ORWELL_SHOWMANCE_PACING',       key: 'showmancePacing',        parser: 'defaultOn' },
  { envKey: 'ORWELL_SHOWRUNNER',             key: 'showrunner',             parser: 'defaultOn' },
  { envKey: 'ORWELL_SHOWRUNNER_REWEIGHT',    key: 'showrunnerReweight',     parser: 'defaultOn' }, // ORW-270: measured fair, default ON
  { envKey: 'ORWELL_SOCIAL_FATIGUE',         key: 'socialFatigue',          parser: 'inverted' },
  // 0184 part 2a / ORW-564: social roles (snake, floater, villain, peacemaker, jokester, therapist, outcast) read from what each houseguest saw and was told, and voiced as gossip claims. `=0` = no roles.
  { envKey: 'ORWELL_SOCIAL_ROLES', key: 'socialRoles', parser: 'defaultOn' },
  { envKey: 'ORWELL_SOUL_DEPTH',             key: 'soulDepth',              parser: 'defaultOn' },
  { envKey: 'ORWELL_STRATEGIC_CADENCE',      key: 'strategicCadence',       parser: 'defaultOn' },
  // A54 / #2017 M5: npcVoice hands the narrator what the NPC remembers about the player (top 3 plain facts) + an engine-decided, rate-limited bringUp. ON by default (see ORWELL_NPC_MEMORY_SPEECH below); `=0` turns it off.
  // B29 / #2017 E3: observers react to a visible tell (comfort / exploit / avoid; needs ORWELL_NPC_TELLS). ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_TELL_REACTIONS', key: 'tellReactions', parser: 'defaultOn' },
  // 0176 / ORW-561 (theme 3 slice 10, part 2): territory - a hidden tenure map (hours per room), a mild pull toward people who share your top room, and a small capped bond nudge for roommates and shared-room pairs. A played game only. `=0` opts out.
  { envKey: 'ORWELL_TERRITORY', key: 'territory', parser: 'defaultOn' },
  // ORW-37 half 2 / B41: a pre-show tie's nature shapes decisions between the two people it binds (family shields in nominations and keeps in the vote; a rival is pushed); decision terms only, never competition odds. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_TIE_BEHAVIOR', key: 'tieBehavior', parser: 'defaultOn' },
  { envKey: 'ORWELL_TIE_REVEAL',              key: 'tieReveal',              parser: 'defaultOn' },
  { envKey: 'ORWELL_TIME_OF_DAY',            key: 'timeOfDay',              parser: 'defaultOn' },
  { envKey: 'ORWELL_TIME_PER_CONVERSATION',  key: 'timePerConversation',    parser: 'inverted' },
  { envKey: 'ORWELL_TRAITORS_FURY', key: 'traitorsFury', parser: 'defaultOn' },
  { envKey: 'ORWELL_TRAJECTORIES',           key: 'trajectories',           parser: 'defaultOn' },
  // 0188 / ORW-619: the trap - a suspicious houseguest tells one person a made-up secret and watches whether it comes back (the player can be trapped too). `=0` = no traps.
  { envKey: 'ORWELL_TRAPS', key: 'traps', parser: 'defaultOn' },
  // 0174 (Theme 3 slice 13): balanced triads drift friends together, and a close vote's deciding ballot is courted by both camps (hidden; the kingmaker unseals in the retrospective). ON by default; `=0` opts out, byte-identical.
  { envKey: 'ORWELL_TRIADS', key: 'triads', parser: 'defaultOn' },
  { envKey: 'ORWELL_TRIGGERS',               key: 'triggers',               parser: 'defaultOn' },
  // B7 / #2017 M1: the NPC veto save also reads memory / beliefs / owed deals. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_VETO_MEMORY', key: 'vetoMemory', parser: 'defaultOn' },
  // ORW-877 (the T2-12 front-end half of ORW-594): once a session hands its narration back (recordNarrationUse), a tell decided at the prompt build is held and joins the player's knowledge only if the narration voiced it. ON by default; `=0` tells at the prompt build as before.
  { envKey: 'ORWELL_VOICED_CLAIMS', key: 'voicedClaims', parser: 'defaultOn' },
  // ORW-771 (owner-ruled): a Continue press through the played eviction vote carries a sealed `voteBeat` fact block (who walks into / back from the Diary Room this press, the room, and on the result press that the tally is read with names) so the narrator voices a short beat. Presentation only: no clock, no rng, no ballot content. ON by default; `=0` restores the banner-only press byte for byte.
  { envKey: 'ORWELL_VOTE_BEAT', key: 'voteBeat', parser: 'defaultOn' },
  // B5 / #2017: vote counting - an evict campaign forms only while the actor believes the count is in doubt. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_VOTE_COUNT', key: 'voteCount', parser: 'defaultOn' },
  { envKey: 'ORWELL_VOTE_DEDUCTION',         key: 'voteDeduction',          parser: 'defaultOn' },
  // 0154 / ORW-330 slice 5b: after an eviction NPC voters tell one NPC how they voted ("I voted to keep you"), true or a lie, engine-decided on its own seeded stream. Needs ORWELL_NPC_BELIEFS. `=0` turns it off.
  { envKey: 'ORWELL_VOTE_TALK', key: 'voteTalk', parser: 'defaultOn' },
  // ORW-473 amendment (0192): the walk-in rule also catches a talk among three or more, not only a pair. Played games only. ON by default; `=0` limits it to a pair.
  { envKey: 'ORWELL_WALKIN_GROUPS', key: 'walkinGroups', parser: 'defaultOn' },
  // A10: want-driven NPC movement. ON by default since 2026-11-05 (PO: "if it's built, turn it on"); `=0` turns it off.
  { envKey: 'ORWELL_WANT_MOVEMENT', key: 'wantMovement', parser: 'defaultOn' },
  // ORW-275: week chapters - the played-game turnIn that crosses a week boundary (bed on eviction night) carries a Vault-free `weekChapter` recap. ON by default; `=0` turns it off.
  { envKey: 'ORWELL_WEEK_CHAPTERS', key: 'weekChapters', parser: 'defaultOn' },
  { envKey: 'ORWELL_WIPEOUT_REEL',            key: 'wipeoutReel',            parser: 'defaultOn' },
  // 0200 / ORW-632: your edit - after the crown, the season as TV would have cut it (episode facts, hero and villain edits, how the player came across); rides the post-season retrospective. `=0` = none.
  { envKey: 'ORWELL_YOUR_EDIT', key: 'yourEdit', parser: 'defaultOn' },
  // 0211 / ORW-648 (Ryne approved 2026-11-17): the story of you and them - each houseguest's own view of the player is sampled weekly (read-only, no rng) and after the crown the retrospective carries each story as facts. A played game only; `=0` = no samples, no stories.
  { envKey: 'ORWELL_YOUR_STORY', key: 'yourStory', parser: 'defaultOn' },
];

/** The parsers, keyed by kind, to avoid re-creating closures on every call. */
function strict(v: string | undefined): boolean  { return v === '1'; }
function loose(v: string | undefined): boolean   { return v === '1' || v === 'true' || v === 'on'; }
// ON unless explicitly '0' — exactly the engine's own read (`!== "0"`), so unset reports ON like the engine runs.
function inverted(v: string | undefined): boolean { return v !== '0'; }

// The ONE parser (shared with the engine's own flag reads, src/domain/flagDefaults.ts) — /health can never diverge from it.
function defaultOn(v: string | undefined): boolean { return defaultOnFrom(v, process.env.ORWELL_FLAGS_OFF); }

const PARSERS: Record<ParserKind, (v: string | undefined) => boolean> = {
  strict,
  loose,
  inverted,
  defaultOn,
};

/**
 * Reads every known feature flag from `process.env` and returns a flat `Record<string, boolean>`
 * with the camelCase keys as used by `/health`.
 *
 * This is the single function HTTP transports and health endpoints should call; it avoids the
 * duplication risk of each consumer maintaining its own inline `strict`/`loose`/`inverted` closures.
 *
 * NOTE: this reflects the process's BOOT env; the God-Mode `setBehavioralFlags` dial can override
 * a layer per-sandbox at runtime, so this is the deploy default, not necessarily a given live
 * sandbox's current setting.
 */
export function bootFlagsFromEnv(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const { envKey, key, parser } of FEATURE_FLAGS) {
    result[key] = PARSERS[parser](process.env[envKey]);
  }
  return result;
}

/**
 * Returns just the camelCase key names of all registered feature flags — useful in tests to avoid
 * a hardcoded literal array that drifts out of sync with the registry.
 */
export function bootFlagKeys(): string[] {
  return FEATURE_FLAGS.map((f) => f.key);
}
