# Full feature audit — 2026-10-25

Six read-only auditors (five by feature band, one cross-cutting) audited every feature against `main`
at `344a09e6`. Their detailed reports are saved here so they survive a container reset:

- `band_A_0001-0025.md` · `band_B_0026-0050.md` · `band_C_0051-0075.md` · `band_D_0076-0100.md` ·
  `band_E_0101-0132.md`
- `crosscutting.md` — feature-flag inventory, tool wiring, decision kinds end to end, CI and docs.

The band reports are a **snapshot as of `344a09e6`**, kept unedited: line numbers and findings
describe the code on that day, and many were fixed since. **This README is the live tracker** —
where they disagree, trust the table below.

## Status of every finding (reconciled 2026-11-02)

Fixed by #1908 (A), #1910 (B), #1911 (C), #1912 (D), #1914 (Tier 1), #1915 (a11y).

### Tier 0 — fix first

| # | Finding | Status |
|---|---|---|
| 1 | Deal offers freeze the game (0123) | ✅ #1911 (offers now live in chat, never a card) |
| 2 | `main` red; Vault sentinel sweeps crash on `playerDossier` | ✅ #1908 |
| 3 | `notorietySummary` exposes reputation numbers | ✅ #1908 (legend-only projection; PO ruling: legend lines public) |
| 4 | Knowledge-wall backstop empties on an engine blip | ✅ #1910 |
| 5 | Eviction night forces an all-nighter | ✅ #1912 |
| 6 | Clock goes dark after an engine restart | ✅ #1912 |
| 7 | Required check not enforced | ⏳ Owner action: enable branch protection |
| 8 | Balance never measured on the deploy profile; instrument broken | ✅ measured + instrument fixed (#1911). Result: too easy → difficulty work (in progress) |

### Tier 1 — built, but not reaching players

| # | Finding | Status |
|---|---|---|
| 9 | NPC mood / read-of-player / rivalry cues dropped before the narrator (0084/0088/0096) | ✅ #1919 |
| 10 | Off-screen scene prose generated but never shown (0070) — paid AI calls wasted | ❌ Open |
| 11 | NPC long-term memory stored but never read (0024); its tests assert nothing | ❌ Open |
| 12 | `confront` (0094) off and can't be turned on | ⏸ Off by PO ruling (keep built-but-off features off) |
| 13 | Campaigns only tilt eviction votes (0085) | ❌ Open |
| 14 | Retrospective panel hides exit interviews, pull-quote reel, player confessionals | ❌ Open |
| 15 | Booth Receipts mostly can't fire; raw ids | ✅ #1914 |
| 16 | `playerReceipts` / `playerDossier` advertised but not callable | ✅ #1910 |
| 17 | Wipeout reel, generated comps, memory callbacks switched off | ⏸ Off by PO ruling |
| 18 | Secret veto / battle-back off; turning on would freeze | ✅ freeze fixed (#1911), FE chain + engine boundary now test-pinned (A-4: `secretVetoBoundary.test.ts`, `test_0025_secret_veto_relay.py`; a missing `use` is refused at the MCP boundary); ⏸ still off by PO ruling — before enabling: narrator guidance for the secret-veto pause, flag registration in featureFlags.ts / the God-Mode dial, and a juryReach/calibration re-check |

### Tier 2 — correctness and follow-ups

| Finding | Status |
|---|---|
| Two-window live mirror failing in CI | ✅ #1910 |
| HUD may lag (beatSeq test regression) | ✅ #1910 — stale test shape, behavior was fine |
| 0130: model can't submit exit interview | ✅ #1911 |
| 0130: harness sends the answer in the wrong field | ✅ #1911 |
| 0130: auto-advance after the goodbye stops one step early | ❌ Open |
| One admin toggle changes every player's game, not one sandbox | ❌ Open |
| Admin "configure"/"override" report success but change nothing (0016) | ❌ Open |
| Telegram play can't decide or advance (0072) | ❌ Open (off unless a bot token is set) |
| Finale juror `heldBelief` hints at ballots | ✅ #1914 (PO ruling: removed) |
| 0095: accusing a tie affects absent houseguests; a correct accusation can score as a miss; trigger eruptions always count the player as a witness | ❌ Open |
| CI installs unpinned FE libraries | ✅ #1910 |
| `/health` misreports two settings | ✅ #1914 |
| #1782 veto-ceremony setting is an empty placeholder | ❌ Open (remove until real) |

### Tier 3 — prevention and docs

| Finding | Status |
|---|---|
| One master check for decision kinds | ✅ #1911 |
| Tests that test code the live game doesn't use (0003, 0008, 0019, 0023); 0024/0072 tests assert nothing | ❌ Open |
| CLAUDE.md stale (golden path, models, 0115–0132) | ✅ #1914 |
| PO ledger disagrees with the feature index on ~11 features | ✅ Build-status column synced 2026-11-02 (PO decisions untouched; 0010 smoke status needs the owner) |
| Seven late-July features have no spec | ❌ Open |
| Cleanup: real-time-mode leftovers, dead code (`foreshadow.ts`), missing icons, stray bytes in one core file | ❌ Open |

### Decisions for the PO

| Decision | Status |
|---|---|
| Are notoriety legend lines public? | ✅ Yes (2026-11-01) |
| Finale jurors may hint at believed votes? | ✅ No (2026-11-02) |
| 0097 / 0098: frozen or reopened? (0098 conflicts with "player input never changes a seeded outcome") | ❓ Open |
| 0129 jury house overlaps the built hidden jury house — scope before building | ❓ Open |
| 0046: pre-jury evictee fast-forwards to the season-end reveal? | ❓ Open |
| 0005: the approved strategic Houseguest's Choice was never built — still wanted? | ❓ Open |
| 0049: house presence & lingering | ❓ Open |
| Diary tools switch on/off with their features? | ❓ Open |
