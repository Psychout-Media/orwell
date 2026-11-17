# 0182 - The grudge book (Theme 3 slice 5, ORW-569) - PR 1 of 3

Status: PR 1 built. Engine-only; nothing new is shown and nothing decides from it yet. Flag `ORWELL_GRUDGES` (default ON, `=0` opts out), played games only, needs `ORWELL_BOND_RECORD`.

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

## Left for later PRs
PR 3: bitter jurors and the played-game measurement lane.

## Gates
BDD `0182-grudges.feature` and `tests/unit/grudges.test.ts` (pure book, each fold source, flag-off byte-identity, persistence, wall).
