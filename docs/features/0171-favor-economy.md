# 0171 - Counters, favors and the favor economy (Theme 3 slice 3) - BUILT

Executable spec: `0171-favor-economy.feature` (wired into `cucumber.cjs`). Flag `ORWELL_FAVORS`, default ON (`=0` opts out; OFF is byte-identical). Played games only: a headless seeded sim carries no hook.

## What it adds
- **Counters** come from the houseguest's weekly goal (`campaigns.ts` / `agendaPullOf`). `src/engine/favorCounters.ts` (pure) weighs an offer against it: accept, counter (ask for the rival they want gone, or a vote) or refuse, with a round number. Rounds are capped by `FAVOR.maxCounterRounds` (3). Seeded side stream `${seed}:favors:${deal}:${week}:${round}`. A counter in play rides the existing single standing `dealOffer` slot (`counter: { round, ask }`); the narrator voices it from facts through the existing standing-offer path. No new model-callable lever, no new prompt text.
- **Favor ledger** (`src/engine/favors.ts`): append-only, snapshotted as `core.favors`, `seq` recomputed on load. A favor is made when a swap to a lighter deal is accepted (the houseguest who asked owes the player) and when a counter is taken (the player owes the houseguest). **NPC-to-NPC counters are wired when 0170 merges.** Today `negotiate` (the multi-round, pure part) and `recordFavor` have no caller in the live game: the in-house parts are wired (the player swap-offer counter, the favor ledger, the vote-time call-in, the bond debt) but NPC-to-NPC deals do not exist on main until slice 2 (#2937) lands. The pure functions and their tests stay; the wiring is a short follow-up right after #2937 merges. (ORW-825)
- **Called in at a close vote**: when the nominees are final, a houseguest off the block passes a favor to a close ally on it, and a favor held by a nominee is called in if `voteStillInDoubt` says the count is close. The debtor answers BEFORE any ballot (one seeded roll from loyalty, the bond and the threat they read). Honored = repaid + a bounded shield at that vote. Refused = the holder's trust in the debtor drops, and each witness's at the existing deal witness factor (`DEAL_BREAK_CREDIBILITY.witnessFactor`). Never a ballot attribution.
- **Bond debt**: the ledger is the source of truth; `bondReader()` reads it through `setFavorDebtSource` (signed, `+` = the other owes the holder).

## Vault
A favor between two NPCs is hidden (its events exclude the player). The player's own favors are the player's knowledge. No view carries a row, a count or a figure; the hidden refusal's wording differs from any later public wording (no Vault echo).

## Open owner questions
- Cap on counter rounds: 3 chosen.
- The player's own debts are never called in against them (their vote is theirs); an NPC asking the player for a favor is not built. Should it be, and is a refusal remembered the same way? (ORW-825)
- A favor the player is owed is called on their behalf when they are on the block at a close vote (an automatic standing claim, never a lever). Is that right, or should the player decide?

## Reworked after the pre-merge review
- **One favor bank.** The 0142 bank (`live.owedFavors`) is folded into the ledger on restore and on first read (one open entry per banked favor, legacy rows dropped only after they are copied). The `callInFavor` lever works through the ledger (the spent favor stays on it as repaid or refused), and the bond debt reads the one bank.
- **A counter is a condition.** Accepting "if X goes up" (or "if X stays off the block") records a waiting condition in `live.favorConditions`; it is booked as a favor only if it is true at that week's eviction, otherwise it lapses unbooked. All goal-derived counters are surfaced: a rival goes up (`target`), someone they keep is held safe (`protect`). The words are authored live from those facts.
- **The engine never calls in a favor the player holds.** Only the player's `callInFavor` does. NPC-held favors are engine-called at a close vote.
- **Favors both ways.** An NPC nominee calls in a favor the player owes through the one standing offer slot (accept repays it; decline or silence is a refusal that costs trust). A nominee who reads the player warmly may ask for a new favor (granting puts them in the player's debt).
- **A refusal** is witnessed by those present and awake (those who had heard it promised weigh it at the deal witness factor); the event's witness set includes the refused person, and the player only if present; hidden and public wordings differ. `applyRefusalToWronged` holds everything the wronged side takes (trust, a memory, a grudge in the grudge book, the bond-record break fold) in one place so ORW-597's learned-of-the-break gate can wrap it. Honoring is scaled by the house's loyalty dial.
- **Left over:** a call-in on the player is voiced at the tally, which can fall after the player's own ballot (the answer then binds from the next vote deal); the legacy bank is not rebuilt if the flag is later turned off.
