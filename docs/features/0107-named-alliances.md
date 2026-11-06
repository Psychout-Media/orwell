# 0107 — Named alliances

> **Status:** ✅ **BUILT — Phase A + B** (2026-06-26 — A: `src/engine/alliances.ts` + the player
> `formAlliance` seam, the cement into `detectBlocs`, the favor into the 0075 goodwill ledger, Vault-safe
> projection + persistence. B: NPCs autonomously NAME alliances off-screen (`formNpcAlliances` in the gated
> `campaignTick`) + **pitch the player** (`gameStatus.alliancePitches` + the `joinAlliance` seam), and the
> **betrayal-stakes fold** (`reconcileAllianceBetrayals` — a named betrayal bumps threat, fires a witnessed
> betrayal, and fractures the alliance). Gated by `alliances0107` + `alliancesNpc0107b`.)
> **Gate:** engine (Vitest + dependency-cruiser). **Depends on:** 0043 (the
> emergent bloc this cements), 0039 (the deal/goodwill ledger it feeds), 0002/0026 (the bonds it gates on),
> 0086 (the `build` drive that will drive NPC formation in Phase B). **Calibration:** every effect is
> 0/identity when no alliance is shared ⇒ `juryReach`/UAT **byte-identical** (re-verified within band).
> **From:** owner design discussion (2026-06-26).

> **Gate (A93):** 0107 has no Gherkin. Its gate is `tests/unit/alliances0107.test.ts` (the model, the three bounded effects, persistence) and `tests/unit/alliancesNpc0107b.test.ts` (NPC-named alliances, Phase B). There is no Vault-sentinel row for an NPC-only alliance (low risk: the store is engine-only and the player sees an alliance only when `knownTo` includes them).

## The idea — naming cements an alliance "in reality," real or not

The game already had two relationship layers: emergent, unnamed **blocs** (0043 — clustered from the live
graph, never stored) and explicit 2-party **deals** (0039). What was missing is the thing real _Big
Brother_ runs on: an **explicit, NAMED, multi-party alliance** the house treats as a *thing*. The owner's
insight is that **naming** is the mechanic — in the show, naming an alliance cements it whether or not the
bonds underneath are real. So a named alliance does three bounded things:

1. **CEMENT** — a small per-pair **tie boost** added to co-members' mutual bond in `detectBlocs`, so
   naming pulls a borderline cluster together and tightens it (and the bloc then bends noms/votes via the
   existing `blocTerm`). The boost is **bounded**, so a *hollow* alliance over weak bonds never reaches the
   bloc threshold — it stays words. The real bonds still rule.
2. **FAVOR** — a bounded **goodwill** bump toward each co-ally (added to the 0075 confidence ledger): the
   "easy way to bank a little good favor with the people in it."
3. **STAKES** *(Phase B)* — betraying a NAMED co-ally cuts deeper than breaking an unspoken bond (a
   multiplier on the reconciliation demerit). Putting it on record raises the cost of breaking it.

## Keeping it from being watered down (the owner's real worry)

The show drowns in meaningless alliances; three guardrails keep these meaningful:

- **The bonds rule (bond-gated join).** `formAlliance` enrolls a proposed member ONLY if their mutual
  bond with the founder clears `joinBondFloor` — the unbonded **decline**. You can't name everyone your
  ally; an alliance needs ≥2 willing members or it doesn't form.
- **Saturation dilutes.** Every effect scales down with how many alliances a member piles into
  (`saturationFalloff`) — a tight, exclusive pact beats a sprawling web of overlapping ones.
- **Hollow is allowed (and stays hollow).** The cement is capped, so naming a low-bond group banks the
  little favor but never fabricates a real bloc. The named layer and the true graph are deliberately
  separate — a named ally can still knife you, and you only find out through behavior.

## Owner rulings (2026-06-26)

1. **NPCs can pitch and name alliances too** (not player-only) — *Phase B*.
2. **No hard cap** on how many alliances a houseguest is in — the **soft saturation dilution** is the only
   limit.

## Engine seams

- **`src/engine/alliances.ts`** — the `Alliance` type, `ALLIANCE` constants, the pure effect functions
  (`allianceTieBoost` / `allianceFavor` / `allianceBetrayalScale`), `willingMembers` (the bond-gated
  join), and the `AllianceStore` (add / forMember / prune-on-eviction / serialize-load). Pure + Vault-only.
- **`src/engine/blocs.ts`** — `detectBlocs` gains an optional `tieBoost(a,b)` added to the effective
  mutual bond (clustering, defection, cohesion all read the cemented bond). Omitted ⇒ byte-identical.
- **`src/engine/liveSeason.ts`** — `SeasonCtx.allianceTie` threads the cement into `currentBlocs`.
- **`GameSessionAdapter`** — the `AllianceStore` field; the player `formAlliance` seam (bond-gated);
  `ctx().allianceTie` (the cement provider, 0 for every pair when no alliance exists); `goodwillFromDeals`
  += the favor; the Vault-safe `AllianceView` on `gameStatus`/`SeasonRecapView`; snapshot persistence.
- **MCP / registry** — `formAlliance` is a player tool (4-place wiring: port → adapter → registry →
  `McpServer` arg-guard + dispatch), with a base-prompt lever so the model names an alliance the moment
  the player and a group agree to one.

## Testability (role-only)

- **Cement / favor / stakes** are bounded, saturation-diluted, and **0/identity when unshared** (pure).
- **The cement raises a borderline bloc** — a pair just under the threshold clusters only once their
  alliance cements them; with no cement, `detectBlocs` is byte-identical.
- **Bond-gated join** — the founder is in; only members over the floor join; the distant decline; <2 ⇒
  no alliance.
- **Vault-safe** — the projection carries the NAME + member names, **never a cement/favor number**.
- **Persists** — a named alliance survives a snapshot/restore; the MCP boundary dispatches `formAlliance`.
- **Calibration byte-identical** — no alliance ⇒ the cement provider returns 0 ⇒ `juryReach` within band.

## Phase B (built)

- **NPCs name alliances off-screen** — `formNpcAlliances` runs in the gated `campaignTick`: a `build`-drive
  (0086) founder over real mutual bonds (the higher `npcAllyFloor`) names an alliance with their
  strongest-bonded allies (the player is never auto-enrolled). Bounded: one new alliance per tick, one
  foundership per NPC, deduped by member set; seeded on the dedicated campaign rng.
- **They pitch the player** — a founder bonded to the player past `pitchPlayerFloor` `reveal`s the alliance
  to them; it surfaces on `gameStatus.alliancePitches` (aware, not a member). The player accepts with
  **`joinAlliance(allianceId)`** (a player tool, 4-place MCP) — only a live pitch they're close enough to
  the founder for; a cold "add me" is refused.
- **Betraying a named ally cuts deeper** — `reconcileAllianceBetrayals` fires when a binding ADVERSE action
  (nominate / replace / vote-evict) hits a named co-ally: a bounded threat ▲ / affinity ▼ on the wronged →
  betrayer edge, a jury demerit, a witnessed betrayal event, and the betrayer **leaves** the alliance (it
  fractures). Gated by a shared alliance existing ⇒ none ⇒ no fold ⇒ byte-identical.

### Still open (future)

NPC↔NPC alliance *diffusion* (a third NPC learning of an alliance via gossip), and richer NPC pitch
cadence (an NPC re-pitching, or souring when the player declines).
