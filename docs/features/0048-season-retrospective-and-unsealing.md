# 0048 — Season retrospective & the Vault unsealing

> **Status:** **Built** (queue **B56**, green 2026-06-10). The **biggest fun payoff**
> the corpus never discusses: when the season is over, **open the Vault** and tell the player the *real*
> story they could never see — the off-screen scheming, the confessionals, the twist that never fired —
> plus an arc **recap** built from the event record, and a clean **finished → new-season** lifecycle
> (0021's archive deferral). The Wall stays absolute **during** play; this is its one **sanctioned,
> structurally-gated exception** — post-season only, because there is no longer a game to spoil.
> **Executable spec:** [`0048-season-retrospective-and-unsealing.feature`](./0048-season-retrospective-and-unsealing.feature)

## 1. Product decision (made — the design's crux)

**Yes: the Vault unseals post-season.** Gated, narrowly:
- **Only after the winner event has fired** (the season is in a **terminal finished state**).
- **Only for that finished season** (not a live one, not another user's).
- **Player-triggered** (you choose to "see how it really went down").

This does **not** weaken mandate #2. The Wall exists so **spoilers can't ruin a game in progress** — "the
model cannot leak what it never receives," and even God Mode is walled *during* play. Once the season is
**over**, there is no game left to spoil, so revealing the hidden story is the *payoff*, not a leak. The gate
is enforced **in code** (the finished-season state), exactly like the rest of the Wall — never by prompt.

## 2. What exists today (the gap this closes)

- **No finished-season state.** The loop crowns a winner but there's no explicit **terminal** state or a
  clean "start a new season" path (0021 left the archive lifecycle out of scope).
- **The hidden story dies with the season.** Off-screen scheming (0038), NPC confessionals (0040), and any
  reserve twist that never fired (0025) are Vault-only and **never surfaced** — even after the game ends.
- **No recap.** There is no end-of-season summary of the player's arc built from the **event record** (the
  durable truth, principle #7), as opposed to narrator memory.

## 3. Scope

**In:** (1) an explicit **finished-season terminal state** + a clean **new-season** path (ties to the reset
guard); (2) an **arc recap** generated from the **event record** (highlights: the player's wins, betrayals,
big moves — from stores, not the narrator); (3) the **unsealed hidden story** exposed via a **dedicated
post-season read** (the one sanctioned Vault read), **structurally gated** on the terminal state — off-screen
scheming, confessionals, the unfired twist.

**Out:** the player-facing recap UI (**C17**, front-end — this specs the engine read it consumes); changing
the Wall **during** play (unchanged — still absolute); the live loop/endgame (0045–0047).

## 4. Design

- **Terminal state + lifecycle.** On the winner event the season enters a **`finished`** terminal state
  (persisted, 0030). A **new-season** path resets the sandbox cleanly (route through the admin
  `manageSandbox reset` / the `createCharacter` reset guard) — one active game per user (0021) preserved.
- **Recap from the record (principle #7).** A `seasonRecap()` read assembles the arc **from the EventStore**
  (witnessed + ceremony events): HOH reigns, nominations, vetoes, evictions, the player's deals
  (kept/broken), the win/loss. **Not** narrator memory — the stores are the source of truth. Vault-free
  (it's the public record).
- **The unseal (the gated exception).** A **dedicated post-season read** — `unsealVault()` /
  `seasonRetrospective()` — that returns the **hidden** story (off-screen scheming 0038, confessionals 0040,
  the unfired reserve twist 0025). It is the **only** sanctioned Vault read, and it is **structurally gated**:
  it returns nothing (or refuses) unless the season is `finished`. Implemented **engine-side** (it may import
  `VaultStore`); the outward exposure is a **post-season-only** tool/route the engine gates on the terminal
  state — so no outward module gains an *unconditional* Vault handle (dependency-cruiser: the gated tool is
  the single, explicit, reviewed seam; the live player/admin surfaces still never read the Vault).
- **Canary scoping.** The 0001 sentinel canary asserts **no Vault content leaks while the season is live**
  (pre-finale) — it must stay green. Post-finale unsealing is the **sanctioned** exception, asserted by a
  *separate* test (sentinels appear **only** after the terminal state, **only** via the unseal read, **only**
  for that finished season, **never** for a live or other user's game).

## 5. Contracts (stack-agnostic)

```
season terminal state: "finished" (set on the winner event; persisted 0030)
seasonRecap(): arc highlights assembled from the EventStore (Vault-free; stores not narrator — principle #7)
unsealVault(): the hidden story (off-screen scheming 0038 + confessionals 0040 + unfired twist 0025)
   — the ONE sanctioned Vault read; STRUCTURALLY GATED on state === "finished"; player-triggered; this season only
new-season: a clean reset path (admin manageSandbox reset / createCharacter guard) — one active game/user (0021)
invariant: while live, the Vault is sealed (0001 canary green); unsealing is impossible pre-finale, in code
```

## 6. Definition of Done

- [ ] **Sealed while live (the wall holds):** the 0001 sentinel canary stays **green** throughout a live
      season — `unsealVault()` returns nothing pre-finale, enforced by state, not prompt.
- [ ] **Unsealed post-season:** after the winner event, `unsealVault()` returns the hidden story (off-screen
      scheming + confessionals + any unfired twist) — **only** for that finished season, **never** for a live
      or another user's game (cross-user isolation, 0021).
- [ ] **Recap from stores:** `seasonRecap()` is assembled from the **event record**, not narrator memory
      (principle #7) — Vault-free; reproducible.
- [ ] **Lifecycle:** the finished state is explicit + persisted; a new season starts cleanly (reset guard);
      one active game per user holds.
- [ ] Name-agnostic; `0048` added to `cucumber.cjs`; `npm test` + `npm run test:arch` green (the gated Vault
      read is the single reviewed seam — no *unconditional* outward Vault import).

## 7. Dependencies & traceability

Completes the **0021** finished-season lifecycle; reads the hidden stories of **0038** (off-screen),
**0040** (confessionals), **0025** (reserve twists); the recap reads the **0002/EventStore** record
(principle #7); under **0001** (the Wall — sealed during play, sanctioned-open after), persisted by **0030**.
Pairs with **C17** (the front-end recap/unseal surface). The one place the absolute Wall intentionally opens —
because once the season is done, the only thing left to do with the secret is *enjoy* it.

## 8. Implementer-ready (Definition of Ready)

**Touch points (exact):**
- `src/engine/liveSeason.ts` / `sessionSnapshot.ts` — a `finished` terminal flag set on the winner event,
  persisted in `SessionCore` (0030).
- **New** `seasonRecap()` (Vault-free, from `EventStore`) + **new** `unsealVault()` (engine-side, reads
  `VaultStore`/the hidden event+soul stores) — both on the engine; the latter **gated** on `finished`.
- Outward exposure: a **post-season-only** read tool/route (the front-end C17 consumes it). It must be the
  **single reviewed** Vault-reading seam — `npm run test:arch` stays green because the live player/admin
  surfaces still carry **no** Vault import; the gated read is explicitly allowlisted + state-gated.
- New-season: route reset through the admin `manageSandbox("reset")` + the `createCharacter` reset guard.

**Build order / deps:** best after the endgame can actually finish (**0045**) and the hidden stories exist
(**0038/0040/0025** — built/partial). **Test targets:** `tests/unit/retrospective.test.ts` +
`docs/features/0048-*.feature` → `cucumber.cjs`, **plus** the scoped canary tests (live = sealed; finished =
unsealed, this-season-only, isolated).
**Open decision: resolved (§1)** — post-season, after-winner, this-season, player-triggered. If the owner
ever wants it off, the gate is one flag.

## Amendment 2026-11-18 - the player's promise record (ORW-602)
`dealPlans.yourPromises` (the post-crown retrospective's record of what the player promised) lists each promise once and by meaning, adds the player's casual assurances, and marks who settled each row (`judgedBy`: the engine, or the narrator for a free-text line). Same crown gate, no new tool, no number, no hidden plan. See `0187-promises-bind.md`, amendment 2026-11-18 (ORW-602).
