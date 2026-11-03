# Build Brief & Handoff for Claude Code — Big Brother Simulation Web App

> **This is the source-of-truth handoff.** It captures everything decided so far and
> tells you how to build the system. The companion `bb-sim-spec.md` holds the detailed
> domain spec. **You (Claude Code) will write the actual spec files**; treat these two
> documents as your input, confirm the open items in §15, then proceed BDD/TDD-first.

---

## 1. Product goals (non-negotiable)

1. **Behavioral fidelity above all.** The simulation must reproduce the **full social
   texture of a real *Big Brother* episode** — drama, nuance, hidden conversations,
   off-screen scheming among NPCs the player isn't present for. Mechanically-correct but
   behaviorally-thin gameplay is a failure. *(This is the #1 priority correction.)*
2. **Replayable.** New player character + new randomly-named house each save. No fixed protagonist.
3. **Fix the old approach's failures:** sycophancy; context-window overload; and
   **detail regression** (the Vault used to thin out over time — reverse it, §7).
4. **Externalize state** into persistent, **permissioned** stores; load **selectively**.
5. **Vault Wall** enforced **structurally** — the model cannot leak what it never receives.

---

## 2. Architecture directives (hexagonal)

**Domain core (pure, no I/O).** The Game Bible as code: HOH/nomination/veto/eviction
loop, eligibility, **stat-+-temperature-weighted** competition resolution, votes, jury,
win conditions, daily-event invariant. Fully unit-testable, dependency-free.

**Ports (interfaces), at minimum:**
- `GameStateRepository`
- `VaultStore` (engine-only — no player-facing or admin-facing adapter may depend on it)
- `JournalStore`
- `EventStore` (the full interaction record; visibility is per-event metadata)
- `KnowledgeService` (per-NPC/player knowledge + information propagation)
- `NarrativePort` (the LLM)
- `RandomnessSource` (**seedable**)
- `Clock` / `Scheduler`
- `CharacterFactory` (generates the random house; runs player OOBE)
- `SoulProvider` (loads character soul/profile — md and/or vector)

**Adapters:**
- **DB adapter(s)** for relational state, the social graph, and the event record.
- **Soul storage**: md and/or **vector** (open — see §5, §15).
- **MCP server(s)** exposing **permissioned tools** to the narrative LLM (e.g.
  `getVisibleStateFor(entity)`, `recordInteraction`, `resolveCompetition`,
  `surfaceInformationTo(player, fact, pathway)`).
- **LLM adapter** behind `NarrativePort`.

**Permission boundary.** Enforce Vault isolation at the port/tool layer. Player-facing
**and admin/God-Mode-facing** surfaces must be **physically unable** to read Vault data.
Do **not** rely on prompt wording.

**Sandboxing.** Each running game is isolated (own state namespace/instance). God Mode is
an **admin-only port**, distinct from player input.

**Recommended stack (confirm in §15):** TypeScript/Node *or* Python; SQLite → Postgres
for state (consider a graph model for relationships); optional vector store for souls/
behavioral memory; MCP server(s) for the LLM↔engine boundary. Keep the **domain core
dependency-free** regardless of choices.

---

## 3. The three channels → ports

- **Administrator / God Mode** — admin-only command port. Configure, override mechanics,
  inspect **non-Vault** state, manage the sandbox. Active only during an admin
  interaction. **Walled from the Vault even for the admin** (spoilers — §1.3 of the spec, §6 here).
- **Player-level** — out-of-character directives within the player's agency.
- **In-character** — narrative interactions.

**Bidirectional scenes:** model an agenda/scheduler where NPCs hold goals (from their
profile) that trigger them to approach the player, **and** the player can initiate.
Neither side initiates everything.

---

## 4. Behavioral fidelity & the event/visibility model (build this carefully)

- **Single event record.** All interactions go into one `EventStore`. **Visibility is
  per-event metadata** — a **witness set** and a **hidden flag** — *not* a function of
  which store the data lives in.
- **Player-witnessed = not secret.** If the player is in the witness set, the event is
  the player's knowledge (Journal-visible). **Do not** mislabel witnessed events as
  off-screen/secret (this was a concrete past bug).
- **Simulate off-screen life.** Generate NPC-to-NPC scenes with witness sets that
  exclude the player; persist them as hidden.
- **Propagation only via in-game pathways.** A hidden fact reaches the player only when
  an NPC tells them, they overhear, etc. Implement this in `KnowledgeService`; the Vault
  Wall stays intact because surfacing is an explicit, modeled event.
- **Tests must verify richness**, not just mechanics (see spec §12 behavioral-fidelity scenarios).

---

## 5. Character generation & souls

- **Only the player's profile is human-authored** (first-run OOBE). **All NPC profiles
  are generated** by `CharacterFactory`, constrained to **plausible Big Brother
  contestant archetypes** — internally consistent, reality-TV-plausible.
- **Deep & hidden:** generate **tons of hidden elements** per character (motivations,
  fears, secrets, leanings). Public persona may **match or wildly diverge** from hidden attributes.
- **Rare surfacing & evolution:** hidden elements surface **rarely** (gated by the
  temperature roll, §6); profiles **evolve** as the game proceeds.
- **Storage open:** souls may be md and/or **vector-backed**; the human is open to a
  vector approach (semantic personality similarity, behavioral memory, conversation recall).
- **Do not hard-code** any persona, name, or the example camp-director character.

---

## 6. Randomness & per-moment temperature

- **Design intent:** **each gameplay moment rolls temperature across ALL involved
  variables** (outcomes, expression, NPC initiative, which secret surfaces, alliance
  shifts, volatility, …) — not one global knob.
- Use the **seedable** `RandomnessSource` so distributions are testable.
- Temperature governs variance/surprise but **never** overrides hard rules (eligibility,
  Vault Wall) or archetype-grounded outcome weighting.
- Exact math (distributions, per-variable weights, bounds, surfacing-rate) → confirm (§15).

---

## 7. Persistence, selective context & non-degradation

- Persist **every relevant dynamic**: social graph, alliances, the full event record,
  per-entity knowledge, votes, comp history, evolving souls.
- Per agent call, assemble **only the relevant slice** (this NPC's knowledge + relevant
  edges + recent/relevant events). Use DB queries + optional vector retrieval.
- **Non-degradation is a requirement.** Detail must **never be lost** across saves and
  should **accumulate/deepen** over the game (the old Vault thinned out — do the opposite).
- **Versioning:** Vault and Journal versioned **together**.

---

## 8. Anti-sycophancy requirements

- **Outcomes are decided by the deterministic core + seeded randomness.** The LLM
  *narrates*; it does **not** decide or bend results to please the player.
- **Distinct, agenda-driven NPCs** via generated deep profiles + temperature; off-screen
  scheming and bidirectional initiation create real friction.
- **Ground truth lives in the stores;** the narrative agent **queries** it rather than
  "remembering" and appeasing.
- **No fixed house style** — voice evolves per soul + temperature.

---

## 9. BDD/TDD workflow (follow strictly)

1. Translate `bb-sim-spec.md` §12 invariants into **failing `.feature` files first**;
   implement to green; refactor.
2. Priority order:
   **Vault isolation (incl. God Mode) → event visibility & propagation → behavioral
   fidelity → replayability/naming → competition eligibility → outcomes by
   stats+temperature → persistence non-degradation → daily-event.**
3. Domain core under **fast unit tests** with the seedable `RandomnessSource`.
4. **Property-based tests** for randomness/temperature distributions and for "behavioral
   richness" thresholds.
5. **`.feature` files are executable specs, and CI treats them as engine changes.** They live
   under `docs/features/`, but the CI path filter counts `docs/features/**/*.feature` as engine
   (so a scenario-only edit runs the BDD gate rather than skipping as a docs-only PR). Keep
   scenario edits paired with their step code in `features/step_definitions/`.

---

## 10. Testing rules (HARD)

- **No names in tests.** Roles only (HOH, nominee, evictee, veto winner, NPC, player).
- **Sample saves = FORMAT ONLY.** Never ingest their content as canonical/seed/test data.
- A player-facing (or admin) path isn't "done" until a test proves it returns **no** Vault data.
- Test that off-screen NPC life **exists** and that witnessed events are **not** secret.

---

## 11. Definition of done (per slice)

- Passing, **name-agnostic** feature test for the invariant.
- **Vault isolation** verified on the relevant surface (player and admin).
- Domain logic unit-tested with **seeded** randomness.
- No Vault read reachable from player-facing or admin-facing adapters/tools.

---

## 12. Suggested milestones

| # | Milestone |
|---|---|
| M1 | Domain core (loop + eligibility + stat/temperature outcomes), unit-tested, **no I/O** |
| M2 | Ports + in-memory adapters; **Vault isolation** + **God-Mode isolation** features green |
| M3 | `EventStore` + visibility model + `KnowledgeService` propagation; event-visibility features green |
| M4 | Persistence adapters (DB + soul store) + selective retrieval + non-degradation tests |
| M5 | MCP tool boundary + narrative LLM integration (permissioned) |
| M6 | `CharacterFactory`: random house generation within BB bounds + player OOBE; replayability green |
| M7 | Off-screen simulation + bidirectional scheduler + per-moment temperature + evolving souls |
| M8 | God Mode / admin port + sandboxing; polish; anti-sycophancy & behavioral-richness tuning |

---

## 13. Hard "do nots"

- Do **not** hold game state in a chat context window as the source of truth.
- Do **not** hard-code any protagonist, houseguest name, or persona.
- Do **not** reference names in tests.
- Do **not** rely on prompt wording to keep the Vault secret — enforce in code.
- Do **not** let the narrative layer decide or alter outcomes.
- Do **not** expose Vault contents to **anyone** at runtime, including the admin/God Mode.
- Do **not** mislabel player-witnessed events as off-screen/secret.
- Do **not** ingest sample-save **content** as data.
- Do **not** let persisted detail degrade over time.

---

## 14. Complete decision log (everything captured so far)

Authoritative record of decisions and corrections from the design conversation.

**Concept & replayability**
- Immersive serialized single-player BB sim; system is GM, narrator, and voice of all NPCs.
- Classic format: 16 houseguests, jury of 9, Final 2; standard weekly loop.
- **No fixed protagonist.** Each new game = new save: created player + new randomly-named house.
- **Character creation at first-run OOBE** defines the player. The camp-director/behavioral-
  science persona is **only an example**, not a fixed element; player name/persona vary and may change.

**Behavioral fidelity (top priority)**
- The sim must reproduce the **full social texture** of a real BB episode — drama, nuance,
  hidden conversations, off-screen scheming. Past versions were **too thin**; fix this.
- **Tests must verify behavioral richness**, not only mechanics.

**Event / visibility model (correction)**
- One full interaction/event record; **visibility is per-event metadata** (witness set +
  hidden flag), not a property of which store it lives in.
- **Player-witnessed interactions are NOT secret / NOT off-screen** (past bug: they were
  wrongly logged in the Vault as off-screen events).
- The Vault holds **only genuinely off-screen/hidden** content.
- Hidden info reaches the player **only via in-game pathways** (told, overheard); then it
  enters the player's knowledge.

**Vault Wall**
- Confirmed absolute: no Vault content (or derived inference) on any player-facing surface,
  including summaries.
- **Resolved decision:** **God Mode is walled from the Vault, even for the admin** —
  spoilers ruin gameplay above all else; the human has never read the Vault and must not be able to.
- Enforced **structurally** at the tool/port boundary, not via prompts.

**Persistence & architecture**
- **Hexagonal**, **BDD/TDD-driven**.
- Conceptual roles of the 3 docs are correct; implementation changes: **Game Bible → code**;
  **Vault & Journal → permissioned stores** (DB / md / vector).
- **Hybrid persistence confirmed to start.** Queryable DB for relational state; **souls may
  be md and/or vector-based** (human open to a **vector approach**).
- Distinct datasets, **explicit per-dataset permissions** in code.
- **Selective retrieval** — load only the relevant slice per query/agent call.
- **Detail must not degrade** — must accumulate/deepen; the old Vault thinned out, reverse it.
- Versioning: Vault & Journal bumped together.

**Channels & scenes**
- Three channels: **Administrator/God Mode** (sandbox, walled from Vault), **player-level**
  (OOC strategy), **in-character**.
- **Bidirectional scenes:** both player and NPCs initiate and receive; neither does all of it.
- Scene fidelity is **player-directed** (compressed vs full).

**Characters & voice**
- **Only the player's profile is human-authored**; **all NPC profiles are generated**,
  within **plausible BB contestant bounds**.
- **As deep as possible**: tons of hidden elements; surface **rarely**; **evolve** over the game.
- Public persona may **match or wildly diverge** from hidden attributes.
- **No fixed house style;** voice = soul + temperature, evolving.

**Randomness**
- **Per-moment temperature roll across ALL involved variables.**
- Seedable for deterministic tests; never overrides hard rules or archetype weighting.

**Operating rules (engine)**
- Outcomes by stats/archetype + temperature, never narrative convenience.
- Information integrity (per-NPC knowledge; events carry witnesses).
- Organic tension only (no switch-flipped drama on meta-feedback); God Mode is the meta exception.
- No premature finality; veto draw random (no player agency over chip pulls).
- Outgoing HOH ineligible for next HOH; veto winner can't be replacement nominee.
- Daily pacing: ≥1 meaningful event per in-game day.

**Testing & data**
- **Name-agnostic tests** (roles only); **sample saves are FORMAT ONLY** (never content).

---

## 15. Decisions still to confirm with the human — ALL RESOLVED

Every open item is now decided; the list is kept with pointers (cross-check `CLAUDE.md`
"Open decisions (remaining)"):

1. **Soul/profile storage** — ✅ resolved: markdown + vector behind `SoulProvider`
   (feature 0024; evolution persisted per 0007/0041).
2. **Temperature model** — ✅ resolved: shape in feature 0006 / `docs/decisions/0001`;
   constants firmed in `src/domain/temperatureConstants.ts` (feature 0028).
3. **Vector approach** — ✅ resolved: adopted, engine-only; embedding provider is
   **fastembed, local ONNX** per ADR `docs/decisions/0004` (deterministic fake in tests;
   the fastembed adapter itself is built (since 2026-06-11, E86a) — runtime uses fastembed by default, with the deterministic fake as the test/fallback adapter (ADR 0004)).
4. **Veto-draw rules, jury procedure, twists** — ✅ resolved: six-player veto +
   "Houseguest's Choice" (`docs/decisions/0001`, 0005); jury choreography (0037);
   reserve twists Vault-sealed (0025).
5. **Non-degradation test strategy** — ✅ resolved: superset + monotonic counts +
   lossless round-trip (feature 0007).
6. **Tech stack** — ✅ resolved: TypeScript / Node 22 engine; Python/FastAPI front-end;
   in-memory + file stores today, SQLite→Postgres deferred behind the ports (`CLAUDE.md`).
