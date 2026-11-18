# 0182 - The grudge book (Theme 3 slice 5, ORW-569) - PR 1 of 3

Status: PR 1 (book), PR 2 (revenge and repair) and PR 3 (bitter jurors) built. Engine-only; nothing new is shown. Flag `ORWELL_GRUDGES` (default ON, `=0` opts out), played games only, needs `ORWELL_BOND_RECORD`.

## What it does
A houseguest who was wronged keeps a grudge against the one who did it, with a memory of what kind of wrong it was. The memory fades with the weeks but never reaches zero. Later PRs read it (revenge goals and repair in PR 2, bitter jurors in PR 3); in this one it only records.

## The book (`src/engine/grudges.ts`, tunables in the `GRUDGES` block)
- One row per directed pair `holder|subject` in `live.grudges` (hidden, engine-only, saved with the season, never projected). Optional, so old saves load.
- A row holds a closed engine kind (cut by an ally, deal broken, vote against, lied to, blindsided), the week and day, a severity, a peak, how much has eased, and a ref key. The kind is never text.
- Monotone, never deleted: severity, peak and eased only grow. A stronger or newer wrong replaces the kind and time.
- Freshness = floor + (1 - floor) x 0.5^(age / half-life), the floor a share of the peak. Easing lowers it but never below the floor. Easing is capped (partly, never fully).
- Half-life: culture loyalty lengthens it, paranoia a little, and a grudge-keeper (the existing forgiveness trait) more.

## What folds in (`foldGrudges`, next to the bond fold; no rng, idempotent by its own seen-marks)
Only records that already exist, at the severity they already carry: a friend's nomination or replacement and a broken deal or assurance (the memory ledger); a broken deal (the deal ledger); the eviction manner an evictee holds (blindsided, betrayed, disrespected) and an unevicted houseguest's alliance betrayal; claims of being lied to or voted against. The player is never a holder.

## Read
`grudgeOf(holder, subject)` on the adapter: kind, freshness, severity, peak, or null. Engine-only, not on any port, tool or projection.

## PR 2: revenge and repair (decisions; no new text)
- Revenge: the agenda view's grudge salience combines the memory ledger's read with the book's weight (freshness x severity x `GRUDGES.revengeWeight`) as a probabilistic-or, leaned by the house's loyalty and paranoia dials (1/1.35..1.35). The existing revenge bar (0.6) is the only chance: a fresher grudge crosses sooner, a repaired one reads fainter (the memory read is scaled by the eased share) and no longer opens a goal. No new rng.
- Repair, each deduped by a `repair:` mark and eased through the book's cap (0.6 of the peak) and mirrored into the bond record's `foldRepair` (wronged toward wrongdoer; the bond's peak resentment stays): a kept promise (`REPAIR.kept`), the wrongdoer's own bonding scene with the wronged within a few days (`REPAIR.scene`, once per pair and week), a shared enemy (`REPAIR.enemy`, once per pair, third and week). Scaled by the holder's forgiveness nature and inversely by the house's loyalty.
- Hesitation (slice 4) only reads resentment: a repair raises it slowly, a grudge adds no bonus.

## PR 3: bitter jurors (a decision; no new text)
- A juror who holds a grudge against a finalist leans away from them at the finale: `juryGrudgeFor(juror, finalist)` = -(`JURY_GRUDGE.scale` x freshness x severity), clamped to `JURY_GRUDGE.max` (0.2, sized under |betrayed| x the manner weight = 0.48, the same rule as the jury-house cap). A fresh grudge hits hardest; repair shrinks it; the floor of the book keeps it above zero.
- No double count. The jury vote already reads the manner of the juror's eviction (betrayed -0.6, blindsided -0.5, x 0.8) and the memory ledger (a nominated-by-friend memory, +-0.15). The grudge adds only what those do not cover: `bitterJurorExtra(raw, covered)` = -max(0, |raw| - covered), where `covered` is the weighted negative manner term plus the negative memory term for the same juror and finalist. So a juror whose only wrong is already a manner grievance gets nothing extra, and grudge plus covered never exceeds the larger of the two.
- An ally's cut adds nothing at the finale, by design: manner (betrayed -0.48) and the nominated-by-friend memory already cover it and the grudge cap is 0.2. The term bites on wrongs they do not count: a broken deal, a caught lie.
- Knowing: a broken deal folds a grudge only for a party still in the house (an evicted houseguest cannot learn of a later break; no memory-ledger entry is folded for an evicted holder either). When `DealLedger.learnOfBreak` (ORW-597) lands, `holderKnowsOfBreak` takes its place.
- A smaller newer wrong never resets an older, larger grudge's clock (week, day, kind); only a wrong at least as severe takes over the row. `JURY_GRUDGE.scale` equals `max` so the term never saturates and every ease (a mend) shows in the vote and the agenda read.
- Provider only for a played game with the book on (`playedGame && grudgesOn()`); headless calibration sims carry no hook and are byte-identical. No rng. The player is never a holder; NPC jurors may hold a grudge against the player.
- Played-game lane: `scripts/probes/bitterJurorsPlayed.ts` plays chat-paced seeded games to the finale with the flag on and off (active vs passive) and reports finalist share, win rate, finale margin and votes away from a grudged finalist. The retune dial, if the lane moves win rates, is `JURY_GRUDGE.scale` only (never `gameRespect`).

## Gates
BDD `0182-grudges.feature` and `tests/unit/grudges.test.ts` (pure book, each fold source, flag-off byte-identity, persistence, wall).

## ORW-607 part 2: the bond record's resentment split (played games, behind the same flag)

A wrong the book records (a deal broken, a favor refused) is no longer also folded into the bond record's resentment: it lives only in the book, on its `wrongWeight` curve. The record keeps the strain, the history and its own resentment from everyday friction (conflict scenes), on its own nightly fade. Every reader of a pair's grudge (feelings, hesitation, guilt, jealousy, the rivalry strand, the pair's kind and strength) reads ONE grievance: the book's weight plus the record's friction resentment, summed once and clamped to 0..1 (`grievanceOf`; the peak likewise from the book's peak). Repair eases the book's wrong once and the record's friction at its half rate. A wronged player (the book never holds a player's grudge), headless games and the flag off keep the old record fold byte for byte. Dial: `BOND.wrongShare` (1 = the book's curve exactly).
