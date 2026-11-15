# Big Brother Simulation — System Specification (v3)

**Purpose.** A build specification for porting an existing, LLM-run *Big Brother*
simulation into a web application — **BDD/TDD-driven, on a hexagonal architecture.**
Captures the **rules, target architecture, behavioral mandate, and engine/narrator
behavior** of the simulation.

**Companion document:** `CLAUDE_CODE_INSTRUCTIONS.md` — the build brief and the
complete decision log. Claude Code will write the actual spec files; these two
documents are its source-of-truth input.

**What this document intentionally does NOT contain.** The live secret game-state (the
populated Producer's Vault). It is, by design, never exposed — the human running this
project has never read it and **must never be able to** (spoilers ruin the game above
all else). The Vault is specified here as a *walled-off, permissioned data layer*; its
actual contents are designed/migrated separately under access control.

---

## Refinements since v3 (this build — Orwell)

The v3 spec below remains the domain baseline; these accepted refinements (in `docs/decisions/`
and `docs/features/`) supersede or extend it where they conflict:

- **Name & shape.** The project is now **Orwell** (repo `Psychout-Media/orwell`), and the game is
  **folded into the main chat** — a vendored Orwell front-end (`frontend/`, Python) drives play
  through the engine's permissioned MCP tools. The engine is game-master; the chat is the window.
- **Mechanics refinements** (`docs/decisions/0001`, `0002`): drop Luck → soul **emotional
  modifier**; **Character/Soul** split; **organic relationship model** (directed, graded,
  computed — no binary ally/enemy flags); veto **"Houseguest's Choice"** chip.
- **The consequence & memory loop (0023)** — the MVP-1 backbone: every happening is recorded,
  **folds its hidden impact into the relationship/soul layer** (the player's actions change how
  houseguests feel about them, invisibly), and **persists to long-term memory**, recalled in full
  on return. **Built and wired into the live game** (0023, with durable persistence via 0030 and
  the orchestrator's integrity checkpoint via 0031) — formerly the biggest gap, now closed.
- **Human-driven player reads (0017/0020):** the engine computes relationship edges but **never
  shows the player a number** or asserts their feelings — surfaces show facts + observable
  behavior; the player **infers** trust/threat. Paranoia is the human's to form.
- **Per-user sandboxes (0021):** one active game per **physical-world user**, unlimited users
  concurrently, fully isolated — **cross-user isolation** is a first-class guarantee alongside the
  Vault Wall.
- **Tight per-moment narration (0018):** the narrator gets a managed, engine-owned per-moment
  system prompt — a tight operating manual + **lever manifest** (it knows how to access and pull
  every engine tool); the engine decides outcomes, the narrator voices them.
- **Feature set:** priority specs in `docs/features/` (now through 0050; most are built — the
  `README.md` status index there is authoritative); the index and `docs/IMPLEMENTATION_QUEUE.md`
  track status + implementer prompts.

The §12 BDD invariants below still hold except where a `docs/decisions/` record or a
`docs/features/NNNN` spec refines them; the §16 open decisions are **all resolved** (§16 keeps
the history with pointers).

**Deliberate design notes (recorded so they aren't mistaken for gaps):**

- The fixed **16-cast / jury-of-9 / Final-2** format is **canon** — not a placeholder awaiting
  configurability. Core structure never varies; only reserve production twists (0025) may.
- The **last-evicted-juror jury tie-break** is **unreachable in the untwisted format** (a jury of
  9 casts an odd number of votes). It exists for the **returning-juror twist** family, where a
  juror re-enters the game and the jury can become even.
- **Walk-outs / quits** are not modeled; they are **optional future scope**, not an omission.

---

## 1. High-level concept

An immersive, serialized single-player *Big Brother* simulation. The system is **game
master, narrator, and the voice of all NPC houseguests**.

**The core mandate (read this first).** Everything that happens in a real *Big Brother*
episode — the drama, the nuance, the hidden conversations, the off-screen scheming the
cameras catch but the player wasn't in the room for — **must happen in this
simulation.** Historically this game has **not been nearly detailed or nuanced enough
about human behavior.** Raising that fidelity is a primary objective, and the test
suite must verify behavioral richness, not just mechanical correctness (see §6, §12).

- **Replayable by design.** No fixed protagonist. Each new game is a new save with a
  freshly **created player character** and a **brand-new house of randomly-named NPCs.**
- **Character creation runs at first runtime (OOBE)** and defines the player.
  - **Only the player's profile is human-authored.** All **NPC profiles are generated**,
    kept **within plausible Big Brother contestant bounds** (see §7).
  - *Illustrative example only* (one human's creation output): a camp director whose
    public persona masks a hidden behavioral-science background. **Not a fixed element;**
    the player's name and persona vary per game and may change.
- **Format:** 16 houseguests, jury of 9, Final 2.
- **Fidelity rule:** outcomes follow simulation logic + houseguest profiles +
  per-moment randomness (temperature, §8), **never narrative convenience.**

---

## 2. System roles (engine responsibilities)

These likely split into a **deterministic simulation engine** (rules, eligibility,
weighted outcomes, state) and a **narrative layer** (LLM voicing houseguests, rendering
scenes), with the engine as source of truth and the LLM constrained by it.

1. Run the weekly loop; enforce all eligibility/legality rules.
2. Compute competition outcomes from stats/archetypes + per-moment temperature — not story.
3. **Simulate the full social life of the house**, including off-screen NPC-to-NPC
   interactions the player never witnesses (§6).
4. Drive NPC behavior and **initiate** scenes per narrative/strategic logic, **and**
   respond to **player-initiated** scenes — initiation is bidirectional (§10).
5. Maintain a per-NPC **knowledge state**; propagate information through legitimate
   in-game pathways (§6).
6. Voice each houseguest per their generated soul/profile + temperature, **evolving**
   over the game (§7, §8, §10); render scenes at the requested fidelity.
7. **Persist all game state to external, permissioned stores and retrieve it
   selectively** (§2.1, §4) — not by holding everything in a chat context window.
8. Enforce the **Vault Wall** and per-dataset permissions on every player-facing output.

### 2.1 Why externalize state (problem statement)

The prior single-chatbot approach has failure modes the rebuild must fix:

- **Sycophancy** — predictable, non-creative, agreeable play.
- **Context-window overload** — a single window degrades over time, losing integral
  rules (e.g., Vault secrecy, disclosed only once at the start) and state (players,
  social network, alliances, in-flight conversations).
- **Detail regression** — as the context degraded, **each Vault update lost detail**.
  The rebuild must do the **opposite**: detail must be non-degrading and should
  **accumulate and deepen** over the game (§9).

**Fix:** record and persist every relevant dynamic externally; load only the **relevant
slice** into any given query/agent call.

---

## 3. Weekly game loop

1. **HOH competition** → Head of Household crowned.
2. **Nominations** → two houseguests nominated.
3. **Veto competition** → contested by a randomly drawn set of players.
4. **Veto ceremony** → veto holder may use it; HOH names a replacement if used.
5. **Eviction** → houseguests vote; one is evicted (HOH typically breaks ties).
6. Repeat. Pre-jury, then a **jury of 9**, a **Final 2**, and a jury vote.

**Pacing:** each in-game day contains at least one meaningful event.

---

## 4. Persistence & data architecture (hybrid — confirmed to start)

The **conceptual roles** below are correct; the **implementation** is changing.

| Layer | Name | Audience | Purpose | Target implementation |
|---|---|---|---|---|
| Core | **Game Bible** | Shared (rules) | Permanent rules + engine parameters | **Code** — the deterministic domain core |
| Hidden | **Producer's Vault** | **Engine-only** | Off-screen/hidden events, hidden attributes, confessionals, hidden threads | Permissioned store (DB / md / vector) |
| Player | **Player's Journal** | Player-facing | Player's save / accessible record | Permissioned store |

**Confirmed approach:** a **hybrid**, given the hexagonal architecture.

- **Code** for the domain core (rules, eligibility, comp resolution, votes, jury).
- **A queryable DB** for relational runtime state — the social graph, alliances, votes,
  per-NPC knowledge, event/interaction record — so context can be retrieved as a slice
  rather than dumped wholesale.
- **Character souls/profiles**: storage format is **open** — md and/or **vector-based**.
  The human is open to a vector approach for this use case (semantic similarity over
  personalities, behavioral memory, conversation recall).
- **MCP server(s)** as the permissioned tool interface between the narrative LLM and the
  engine/state, so the model only ever receives what a tool returns.

**Principles:**

- Distinct datasets, **distinct permissions**, enforced in code / at the tool boundary —
  not by asking the model to self-censor.
- **Selective retrieval:** assemble per-call context; never dump everything.
- **Versioning:** Vault and Journal stores are versioned **together**; detail must not
  regress between versions (§9).

---

## 5. The Vault Wall (HARD REQUIREMENT)

The central integrity mechanism — the analog of never seeing producers' notes or other
houseguests' confessionals on the real show.

**Requirement.** No Producer's Vault content — hidden attributes, confessional text,
hidden threads, off-screen events the player never witnessed, or any *inference uniquely
derived from* that content — may reach the player through **any** player-facing surface
(scene narration, NPC dialogue, system messages, logs, **or end-of-session summaries**).
Summaries may confirm only that updated saves exist.

**Enforcement is structural, not prompt-based.** Player-facing channels/tools must be
**incapable** of reading Vault data.

**Decision (resolved): God Mode is walled from the Vault, even for the admin.** The
Gameplay Administrator does **not** read the Vault at runtime under any circumstances —
Vault contents are **spoilers**, and avoiding spoilers matters above all else for
gameplay. God Mode (§10) is administrative control (configure, override mechanics,
inspect **non-Vault** state, manage the sandbox) — never Vault disclosure.

*(Dev-time authoring of Vault schemas/generators by an engineer is a separate concern
from the running game; the running game never surfaces Vault contents to anyone.)*

**Out of scope by design:** the Vault's actual contents and internal structure.

---

## 6. Behavioral fidelity & the event/visibility model

This section is the heart of the v3 revision.

### 6.1 The mandate

The simulation must generate and track the **full social texture** of a *Big Brother*
house: alliances forming and fracturing, scheming, gossip, showmances, betrayals,
private strategy talks, and **hidden conversations among NPCs the player is not present
for**. Mechanically-correct but behaviorally-thin gameplay is a failure state.

### 6.2 Visibility is a per-event property (correction)

There is a **single, full interaction/event record**. **Visibility is metadata on each
event**, not a property of which store it happens to live in. Each event carries:

- a **witness set** (which houseguests, and whether the player, were present), and
- a **hidden flag** / visibility classification.

**Player-witnessed interactions are NOT secret** and are **not "off-screen events."** A
prior Vault wrongly logged interactions the player was in the room for as off-screen/
secret — they are neither. They belong to the player's knowledge (Journal-visible). The
Vault holds **only genuinely off-screen/hidden** content: events the player did not
witness, plus hidden attributes and confessionals.

### 6.3 Off-screen simulation

NPCs must act when the player is absent. The engine simulates NPC-to-NPC scenes
(witness set excludes the player), recording them as hidden until/unless surfaced.

### 6.4 Information propagation

Hidden information can become known to the player **only through legitimate in-game
pathways** — an NPC tells them, they overhear, they catch someone, etc. When that
happens, the relevant fact enters the player's knowledge state and ceases to be secret
*to the player*. This is how a player "learns the gossip" without breaking the Vault Wall.

---

## 7. Character model — deep, hidden, evolving

> **Status: provisional and intentionally ambitious.** The human wants this **as deep as
> possible** and notes prior models were too thin. Open to refinement and to a
> vector-based representation. See §16.

- **Authorship.** Only the **player's** profile is human-authored (OOBE). **All NPC
  profiles are generated**, constrained to **plausible Big Brother contestant
  archetypes** (reality-TV-plausible backgrounds, motivations, quirks — not arbitrary).
- **Depth.** Each character carries **tons of hidden elements** — hidden motivations,
  fears, secrets, relationships, strategic leanings — far beyond what the player sees.
- **Rare surfacing.** Hidden elements surface **only rarely**, via gameplay and the
  per-moment temperature roll (§8), never dumped.
- **Evolution.** Profiles **continually evolve** over the course of the game as
  experiences accumulate.
- **Public vs. hidden divergence.** A character's **public persona may match its hidden
  attributes or differ wildly** — both are valid and desirable for drama.
- **Soul / voice.** Each character has a soul/profile (md and/or vector-backed) that,
  combined with temperature, drives a distinct, evolving voice — **no fixed house style.**

---

## 8. Randomness & per-moment temperature

- **Design intent:** **each gameplay moment rolls a "temperature" across ALL involved
  variables** — not a single global knob. Involved variables can include: competition
  outcomes, dialogue/expression, NPC initiative (whether someone approaches), which
  hidden element (if any) surfaces, alliance shifts, emotional volatility, etc.
- The randomness source must be **seedable** so behavior is deterministically testable
  (property/distribution tests over many seeded runs).
- Temperature governs **variance and surprise**, but never overrides hard rules
  (eligibility, the Vault Wall) or archetype-grounded outcome weighting.

*(Exact mathematical model — distributions, per-variable weighting, how temperature is
rolled and bounded — is a decision to confirm, §16.)*

---

## 9. Detail must deepen, not degrade (requirement)

Historically, each Vault update **lost** detail and quality. The rebuild must guarantee
the **opposite**:

- Persistence must **never lose** behavioral detail across saves/versions.
- Generation must **keep enriching** — characters, relationships, and history should
  **accumulate depth** as the game proceeds.
- This is both an **architecture guarantee** (externalized, durable state) and a
  **generation directive** (deepen, don't thin). Tests should assert non-degradation
  (§12).

---

## 10. Communication channels & pacing

Three distinct channels:

- **Administrator / God Mode** — meta channel. When the Gameplay Administrator addresses
  the game, it enters **God Mode** for that interaction (configure, override, inspect
  **non-Vault** state, manage the sandbox), then exits. Each running game is its own
  **sandbox**. **Never** surfaces Vault contents (§5).
- **Player-level** — the player's out-of-character strategy/directives, within their
  legitimate in-game agency.
- **In-character** — dialogue/actions in the fiction.

**Bidirectional scenes:** both the player and NPCs initiate and receive conversations;
neither initiates all of them.

**Scene fidelity is player-directed** — compressed beats vs. full scenes.

**Voice** is per-character (soul + temperature) and **evolves**; no fixed house style.

---

## 11. Suggested domain model (provisional)

- **PlayerCharacter** — authored at OOBE; public persona + optional hidden attributes;
  no fixed identity. *(The original "name may change" mid-game promise is **not implemented**
  and is dropped as a requirement: the name varies per game/save, but is stable within one
  game.)*
- **Houseguest**
  - *PublicProfile* (Journal-visible): randomized display name, public persona, status,
    publicly-known relationships.
  - *PrivateProfile* (**Vault-only**): deep hidden attributes, motivations, secrets,
    archetype, confessionals, hidden threads — generated within BB-plausible bounds.
  - **Soul/voice** reference (md and/or vector) + temperature.
- **Event / Interaction** — timestamped; **witness set**; **visibility/hidden flag**;
  **initiator** (player or NPC); content. The single source for both Journal and Vault projections.
- **KnowledgeState** (per houseguest, incl. player) — facts that entity may legitimately
  act on; grows via propagation (§6.4).
- **Relationship / edge** — *(as built — `docs/decisions/0002` + feature 0026 supersede the
  original "type + strength" shape)*: a **directed, graded, asymmetric** belief held per
  houseguest (trust / affinity / threat / alignment / reliability / confidence), **computed from
  event history** — never a stored label or binary ally/enemy flag — plus a **known-by set**
  (public vs hidden).
- **Season** → **Weeks**; **Week** (HOH, nominees, veto holder, veto used?, replacement,
  evictee, phase); **Competition** (type, eligible set, stat + temperature weighting,
  result); **Nomination**, **VetoCeremony**, **Eviction**, **Vote**, **Jury**,
  **FinalTwo**, **JuryVote**.
- **TemperatureRoll** — per-moment roll across involved variables (§8).
- **Save** — { domain-core version, Vault store, Journal store }; Vault & Journal
  versioned together; detail non-degrading (§9).

---

## 12. Key invariants as BDD scenarios (NAME-AGNOSTIC)

> **Hard testing rule:** reference **roles**, never houseguest or player names.

```gherkin
Feature: Vault Wall — secret data never reaches the player

  Scenario: No Vault content on any player-facing surface
    Given a fully populated Producer's Vault
    When the engine produces any player-facing output (scene, dialogue, log, or summary)
    Then it contains no hidden attributes, confessionals, hidden threads,
      or off-screen events the player did not witness
    And no inference uniquely derivable from Vault content

  Scenario: God Mode does not expose the Vault, even to the admin
    Given an administrator interacting in God Mode
    When the administrator inspects game state
    Then no Producer's Vault content is returned
```

```gherkin
Feature: Event visibility

  Scenario: A player-witnessed interaction is not secret
    Given an interaction whose witness set includes the player
    Then that interaction is part of the player's knowledge
    And it is not classified as off-screen or hidden

  Scenario: Off-screen NPC interactions are simulated and hidden
    Given a stretch of game time
    Then NPC-to-NPC interactions occur with witness sets that exclude the player
    And they remain hidden from the player until surfaced by an in-game pathway

  Scenario: Information propagates only through in-game pathways
    Given a hidden interaction the player did not witness
    When an NPC who witnessed it tells the player about it
    Then that fact enters the player's knowledge state
    And until such a pathway occurs, the player has no access to it
```

```gherkin
Feature: Behavioral fidelity

  Scenario: The house has rich social life beyond the player
    Given an active game
    Then alliances, gossip, scheming, and private conversations occur among NPCs
    And a meaningful portion happens off-screen relative to the player

  Scenario: Hidden character elements surface rarely
    Given houseguests with deep hidden attributes
    When gameplay proceeds over many moments
    Then hidden elements are revealed only occasionally, not dumped
```

```gherkin
Feature: Generation constraints

  Scenario: NPC profiles stay within plausible Big Brother bounds
    When a new house is generated
    Then each NPC profile is internally consistent
    And falls within plausible reality-TV contestant archetypes
    And only the player's profile originates from human authoring (OOBE)
```

```gherkin
Feature: Randomness and temperature

  Scenario: Each moment rolls temperature across involved variables
    Given a gameplay moment with multiple involved variables
    Then a temperature roll is applied across those variables
    And with a fixed seed the outcome is reproducible
    And hard rules (eligibility, the Vault Wall) are never overridden by temperature
```

```gherkin
Feature: Competition legality

  Scenario: The outgoing Head of Household cannot defend the crown
    Given a houseguest is the outgoing HOH for the current week
    When the next HOH competition begins
    Then that houseguest is not in the eligible participant set

  Scenario: The veto winner is not a valid replacement nominee
    Given a houseguest has won the Power of Veto this week
    When the HOH selects a replacement nominee
    Then the veto winner is excluded from the selectable set

  Scenario: Outcomes follow archetype and temperature, not narrative need
    Given an endurance competition and a houseguest whose profile does not support endurance
    When outcomes are computed across many seeded runs
    Then that houseguest's win rate reflects stats and temperature, not story convenience
```

```gherkin
Feature: Replayability and naming

  Scenario: Each new game generates a new, randomly-named house
    When a new game is started
    Then a player character is produced via character creation
    And the house is populated with newly generated, randomly-named houseguests
    And no identity carries over from any previous game
```

```gherkin
Feature: Persistence integrity

  Scenario: Persisted detail does not degrade across saves
    Given a game with accumulated behavioral detail
    When the game is saved and reloaded across versions
    Then no previously-persisted detail is lost
    And the Vault store and Journal store versions incremented together

  Scenario: Each in-game day has a meaningful event
    When an in-game day completes
    Then at least one of {HOH comp, nominations, veto comp, veto ceremony, eviction,
      or a significant house event} occurred
```

---

## 13. Sample saves (FORMAT ONLY)

The human will provide sample saves to convey **formatting/structure only**. Their
**content must not** be treated as canonical, seed, or test data. All fixtures and tests
use **generated, name-agnostic** data.

---

## 14. Legacy implementation (being replaced)

Word-document-based; **superseded** by §4. Kept only as a migration reference: Node.js +
`docx`; `pandoc --track-changes=all`; `validate.py`; Vault dark-red / Journal dark-blue
color schemes.

---

## 15. Explicitly excluded from this document

The populated Producer's Vault, its internal structure, any live secret save-state, and
any inference derived from hidden information. Excluded **on purpose** — preserving the
Vault Wall is the point.

---

## 16. Decisions to confirm with the human — ALL RESOLVED

Kept for history; every item below is decided (cross-check `CLAUDE.md` "Open decisions
(remaining)" and `docs/decisions/`):

1. **Soul/profile storage** — ✅ resolved: **markdown + vector** behind `SoulProvider`
   (feature 0024); evolution persisted per 0007/0041 (the dynamic soul deepens; the static
   character is byte-stable).
2. **Temperature model** — ✅ resolved: shape in feature 0006 / `docs/decisions/0001`; constants
   firmed into `src/domain/temperatureConstants.ts` (feature 0028). Only fine-tuning remains.
3. **Vector approach** — ✅ resolved: adopted, engine-only (`VectorIndex`); embedding provider is
   **fastembed, local ONNX** per ADR `docs/decisions/0004` (deterministic fake in tests; the
   fastembed adapter itself is built (since 2026-06-11, E86a) — runtime uses fastembed by default, with the deterministic fake as the test/fallback adapter (ADR 0004)).
4. **Veto-draw rules, jury procedure, twists** — ✅ resolved: six-player veto with the
   "Houseguest's Choice" chip (`docs/decisions/0001`, feature 0005); jury choreography by
   feature 0037; reserve twists Vault-sealed (feature 0025).
5. **Non-degradation test strategy** — ✅ resolved: superset + monotonic-count + lossless
   round-trip (feature 0007).
