# 0171 - Counters, favors and the favor economy (Theme 3 slice 3) - BUILT

Executable spec: `0171-favor-economy.feature` (wired into `cucumber.cjs`). Flag `ORWELL_FAVORS`, default ON (`=0` opts out; OFF is byte-identical). Played games only: a headless seeded sim carries no hook.

## What it adds
- **Counters** come from the houseguest's weekly goal (`campaigns.ts` / `agendaPullOf`). `src/engine/favorCounters.ts` (pure) weighs an offer against it: accept, counter (ask for the rival they want gone, or a vote) or refuse, with a round number. Rounds are capped by `FAVOR.maxCounterRounds` (3). Seeded side stream `${seed}:favors:${deal}:${week}:${round}`. A counter in play rides the existing single standing `dealOffer` slot (`counter: { round, ask }`); the narrator voices it from facts through the existing standing-offer path. No new model-callable lever, no new prompt text.
- **Favor ledger** (`src/engine/favors.ts`): append-only, snapshotted as `core.favors`, `seq` recomputed on load. A favor is made when a swap to a lighter deal is accepted (the houseguest who asked owes the player) and when a counter is taken (the player owes the houseguest). NPC-to-NPC counters call `negotiate` and `GameSessionAdapter.recordFavor` once slice 2 (`npcDeals.ts`) lands.
- **Called in at a close vote**: when the nominees are final, a houseguest off the block passes a favor to a close ally on it, and a favor held by a nominee is called in if `voteStillInDoubt` says the count is close. The debtor answers BEFORE any ballot (one seeded roll from loyalty, the bond and the threat they read). Honored = repaid + a bounded shield at that vote. Refused = the holder's trust in the debtor drops, and each witness's at the existing deal witness factor (`DEAL_BREAK_CREDIBILITY.witnessFactor`). Never a ballot attribution.
- **Bond debt**: the ledger is the source of truth; `bondReader()` reads it through `setFavorDebtSource` (signed, `+` = the other owes the holder).

## Vault
A favor between two NPCs is hidden (its events exclude the player). The player's own favors are the player's knowledge. No view carries a row, a count or a figure; the hidden refusal's wording differs from any later public wording (no Vault echo).

## Open owner questions
- Cap on counter rounds: 3 chosen.
- The player's own debts are never called in against them (their vote is theirs); an NPC asking the player for a favor is not built. Should it be, and is a refusal remembered the same way?
- A favor the player is owed is called on their behalf when they are on the block at a close vote (an automatic standing claim, never a lever). Is that right, or should the player decide?
