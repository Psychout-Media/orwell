# 0075 — Trust-gated confidences (a houseguest opens up to you)

> **Status:** 🟢 **BUILT (engine), 2026-06-24** — the player-driven `confide` lever ships end-to-end:
> the pure decision core (`src/engine/confidence.ts` + `confidenceConstants.ts`), the live
> `GameSession.confide` authority + the Vault-safe `mayConfide` hint on `npcVoice`
> (`GameSessionAdapter`), the four-place MCP wiring + the `confide` moment-prompt lever, the
> persisted disclosure-tier + lie-count ledger (non-degradation), and the confidence-recording
> pathway (`registry.setOnConfide` → `surfaceInformationTo`). **Gate:** `tests/unit/confidence.test.ts`
> (pure) + `tests/unit/confideBoundary.test.ts` (the MCP-boundary + the load-bearing Vault-wall test).
> Gated/opt-in by construction — `confide` fires only on the player lever and `mayConfide` takes no
> rng, so the seeded calibration spine is byte-identical. **Built since (2026-06-27, for #564):** (a) the
> full `.feature` is wired into `cucumber.cjs` (9 scenarios, `features/step_definitions/confidence.steps.ts`);
> (b) the **passive lie-catch** — a later truthful pathway flips the player's belief to the truth and folds
> a betrayal-grade blow on the player→liar edge in place of the warm bond bump (spec open-Q #4), gated by
> `confideBoundary.test.ts` + the BDD scenarios. **The FE agent-loop guardrail shipped** and error-corrects a `confide`
> under-call (0055 sibling): `frontend/tests/test_0075_confide_guardrail.py` (13 tests). **Engine-enforced scene gate (AMEND 2026-11-04):**
> `confide()` refuses when the player is not in the same room as that houseguest (`tests/unit/confideCoPresence.test.ts`) - "never a cold pop-up" no longer rests on the prompt/FE.
> **Depends on:** 0001 (Vault Wall), 0002
> (event visibility & pathway propagation / `surfaceInformationTo`), 0017/0026 (relationship math),
> 0023 (consequence & memory fold), 0039 (deals — the favor/goodwill ledger), 0041 (soul / emotional
> state — vulnerability), 0058 (deep profiles — the sealed secrets), 0060 (story-thread scheduler +
> the `isPlayerConfidant` confidant path it generalizes). **Bounded by:** mandate #2 (Vault Wall —
> the engine decides the disclosure, the model never authors it) and mandate #3 (anti-sycophancy —
> the bond/goodwill that unlocks a confidence is computed and seeded, never narrated into being).

> **Owner direction (2026-06-22, this session):**
> 1. *"The NPC needs to have a **reason** to tell you. An in-game favor, good will, a good
>    relationship, something. **That reason should decide how and how much of the secret is told.**"*
> 2. *"**Both** [emergent and player-driven]. But I just **don't want a conversation to randomly pop
>    up** and it feel unprompted."*
> 3. *"**Yes** — I think NPCs should be able to **lie** to the player."*

## Why

Today a houseguest's sealed secret reaches the player only **indirectly and impersonally**:
the 0060 scheduler surfaces a thread off-screen and it diffuses as a vague, distorted rumor
(`threadRumor` / `GOSSIP`'s `RUMOR_GLOSS`), or — at best, on the 2026-06-20 confidant path —
as a richer *"\<name\> confided in you — you came away believing they're sitting on something
heavy"* belief that still **never carries the actual secret** (it is keyed only to the public
source class; the verbatim premise never crosses).

So the most human, most *Big Brother* beat in the game does not exist: an ally you have genuinely
earned **sitting you down and telling you the real thing** — and the corresponding gut-punch, a
houseguest you trusted **planting a lie**. This feature makes a confidence a first-class,
engine-mediated, **earned** disclosure whose depth scales with the reason behind it, and which can
be true or a trap.

## The bright line this feature has to respect (read first)

A direct confession looks, at a glance, like it *breaks* the Vault Wall — the player learns real
secret state. It does not, and the reason is the whole architecture (§ "The event/visibility model"
in `CLAUDE.md`, ADR 0002):

> **Visibility is per-event metadata, and a secret legitimately becomes the player's knowledge the
> moment it reaches them through a modeled in-game pathway.** A houseguest *telling* the player is
> exactly such a pathway.

The Wall is preserved by three structural facts, none of which is prompt wording:

1. **The engine decides, not the model.** Whether a confidence fires, *which* secret, *how much* of
   it, and *whether it is true* are all computed by the engine from sealed state + the relationship
   model. The model is handed the text to voice — it never selects a secret and never invents one
   (the `momentPrompts` "never invent biography beyond the card" rule already forbids the
   alternative).
2. **The disclosure is recorded as a player-witnessed knowledge event.** The instant it fires, the
   engine writes it through `surfaceInformationTo` (0002, with genuine content lineage, audit E9)
   so it is correctly *the player's knowledge* (Journal-visible), not Vault content. This is the
   0023 consequence loop working: a happening → recorded → folded → persisted.
3. **The model is never given an *undisclosed* secret.** `npcVoice` still carries no sealed
   content. The only secret text the model ever sees is the one the engine has *already chosen to
   disclose and recorded as disclosed* — it cannot leak what it is not handed.

A lie is the same machinery: the engine discloses **false** content (engine-authored from the
public archetype, never a real secret of anyone) and records the player's resulting belief with a
hidden `reliability`/`truthful=false` flag in the Vault. The player sees a claim; the engine knows
it is false; a later genuine pathway can contradict it (catching the lie). No sealed truth crosses.

## The mechanic

### 1. The *reason* — a computed motivation to disclose (the gate)

A houseguest confides only when they have a **reason**. The reason is an engine-computed,
Vault-hidden scalar `disclosureMotive(npc → player) ∈ [0,1]`, derived ONLY from existing signals
(no new hidden authoring), combining two kinds of pull:

- **Genuine closeness** — the mutual bond: `npc→player` trust + affinity *and* `player→npc` trust +
  affinity (a confidence wants the warmth to run both ways), read off the 0026 relationship edges.
  Generalizes the existing `isPlayerConfidant` (`THREAD.confidantBondThreshold`).
- **Banked goodwill / owed favor** — concrete in-game debt: the player kept a **deal** (0039,
  the `reliability` evidence signal), saved them off the block, voted with them, used the veto on
  them, or comforted them in a rattled-soul beat (0041). Each is already a recorded event with a
  relationship fold; this feature reads the *ledger* of them, it does not invent a new one.

A third, **non-bonding** pull drives the *lie* path (below): **strategic motive** — a houseguest
who reads the player as useful-but-threatening (high `threat`, manipulative archetype:
villain / mastermind / flirt) may *perform* a confidence to manufacture intimacy.

`disclosureMotive` is **never shown** (anti-sycophancy / Vault). It only chooses *whether* and
*how much*. All magnitudes live in one tunable `CONFIDENCE` constants module (the `THREAD`/`GOSSIP`
sibling pattern; the B59 grep gate covers it).

### 2. The disclosure ladder — the reason decides *how much* (owner steer #1)

The reason's strength maps to a **graduated** disclosure, not a binary. Higher motive ⇒ more of the
secret, less hedging:

| Motive band | What the engine discloses (and hands the model to voice) | Source |
|---|---|---|
| below `tease` | **nothing** — no confidence available this scene | — |
| `tease` | a *guarded admission there is something* — the public class gloss, hedged (today's `confidantThreadRumor` texture) | class-keyed |
| `partial` | a **partial, hedged** version of the real secret — the gist with specifics blurred ("money's been… tight, tighter than I let on") | the sealed premise, redacted |
| `full` | the **whole secret, in the houseguest's own words** — the real thing, recorded as the player's knowledge | the sealed premise |

The redaction at `partial` is engine-side string work over the sealed premise (a deterministic
"blur" that drops the sharpest specifics), so even the partial tier never hands the model the full
text it didn't earn. Only the `full` tier crosses the complete secret — and only because the reason
was strong enough that, in fiction, this person *would* tell you.

### 3. Triggering — earned and anchored, **never a cold pop-up** (owner steer #2)

Both paths are gated on the player **already being in a live 1:1-ish scene with that houseguest** —
which is exactly the precondition for the engine knowing it's their moment. A confidence is never a
scene that "randomly pops up."

- **Player-driven (`confide` lever).** When the player presses an ally to open up ("what's really
  going on with you?", "you can tell me"), the model calls **`confide(npcId)`**. The engine
  evaluates `disclosureMotive`, picks the tier, selects/redacts (or fabricates, for a lie) the
  content, **records it** via `surfaceInformationTo`, folds the vulnerability bond bump (0023), and
  returns `{ disclosed, tier, content }` for the model to voice. A motive below `tease` returns
  `{ disclosed: false }` — and the model plays the deflection ("not yet / they change the subject"),
  itself a small, real beat.
- **Emergent — but precipitated, never random.** `npcVoice` (already called *before* the model
  voices anyone in a scene — so it only fires *inside* an active scene) gains a **read-only,
  Vault-safe `mayConfide` hint**: `{ ready: true, reason: "you kept them off the block", warmth:
  "high" }` — the *reason*, never the secret. It appears ONLY when the motive clears AND a
  **precipitating event** is fresh (a favor in the last beat or two, a rattled-soul moment, a deal
  just struck) — so the model leans into a confidence that the scene has *earned*, and it reads as
  prompted by what just happened, not a non-sequitur. The model then drives it through the same
  `confide` lever so the disclosure is engine-decided and recorded (never narrated free-hand).

> **The no-cold-open guarantee is structural:** `mayConfide` is attached to `npcVoice`, which the
> model only calls when the player is already engaging that houseguest. There is no scheduler path
> that *starts* a confidence scene out of nowhere — the off-screen 0060 scheduler still does its
> own NPC↔NPC / vague-rumor surfacing, untouched; this feature only enriches scenes the player is
> already in.

### 4. Lies (owner steer #3)

When `disclosureMotive` is carried by the **strategic** pull rather than genuine closeness (high
threat read + a manipulative archetype, low mutual warmth), the engine may disclose a **fabricated**
secret instead of a real one:

- The fabricated content is **engine-authored from the public archetype** (a plausible-sounding
  but false admission), so **no real secret of anyone crosses** — a lie is not a leak.
- The player's resulting knowledge is recorded with a hidden `truthful: false` + a low `reliability`
  (Vault-side). The player surface shows only the claim; **no tell, no number, no "they're lying"
  marker** — judging it is the human's job (anti-sycophancy; the feeling is theirs, 0017).
- A lie **folds real consequence**: believing it can move the player's own reads and later
  decisions; and if a genuine pathway later contradicts it, the contradiction surfaces (the player
  *catches* the lie), dealing the liar a betrayal-grade trust blow when the player acts on it.
- Lies are **rare and capped** (a house of pathological liars is noise, not drama) — a per-season
  cap in `CONFIDENCE`, sibling to `THREAD.maxSurfacedPerSeason`.

## Engine seams (where this lands)

- `src/engine/confidence.ts` *(new)* — pure: `disclosureMotive(...)`, the tier map, the premise
  **redactor** (`full`/`partial` blur), and the **fabricator** (archetype-driven false admission).
  No I/O, no Vault handle — it is handed the already-read signals.
- `src/engine/confidenceConstants.ts` *(new)* — the single `CONFIDENCE` tunable (bands, the favor
  weights, the strategic-lie gate, the per-season lie cap). The `THREAD`/`GOSSIP` sibling.
- `GameSessionAdapter`:
  - `npcVoice` gains the optional, read-only **`mayConfide`** hint (Vault-safe: reason + warmth
    word only; no secret, no number). Reuses the sealed `deepProfiles` + `rel` + deals + soul it
    already holds — all engine-side.
  - a new action **`confide(npcId)`** on the `GameSession` port / `PLAYER_TOOLS`: evaluates,
    selects/redacts/fabricates, **records via `surfaceInformationTo`** (content lineage, E9), folds
    the 0023 consequence, increments the lie cap when applicable, returns `{ disclosed, tier,
    content }`. It is the single authority — like `runCompetition`, the model previews/voices, the
    engine decides + commits.
- `src/engine/momentPrompts.ts` — the `social` moment + the lever manifest gain `confide` (when to
  call it; that the engine decides whether they actually open up; never invent a confession the
  lever didn't return). The `mayConfide` reason is voiced as texture, never stated as a number.
- **FE follow-on (0055 sibling):** the agent loop already error-corrects the model's tool
  under-calling. A small guardrail — when `npcVoice.mayConfide.ready` is true and the player's turn
  is clearly pressing the ally to open up — can call `confide` itself so an earned confidence is
  never silently dropped. (Spec'd here; built FE-side, pytest-gated.)

## Persistence (0007/0030 — non-degradation)

- Each secret/thread gains a sealed, monotonic **`disclosedToPlayer`** state (`none` / `partial` /
  `full`) so a secret is never re-confided at a *lower* tier than already reached, and a restored
  game remembers exactly what the player has been told.
- The per-season **lie count** persists in the snapshot (sibling to `surfacedThreadCount`).
- The disclosed knowledge itself is an ordinary recorded 0002 event — already durable; it deepens,
  never thins.

## Testability (role-only; HARD rules)

- **Vault Wall (the load-bearing test):** an undisclosed secret never appears on `npcVoice`,
  `mayConfide`, or any projection; a `full`-tier disclosure appears in the player's knowledge
  **only after** `confide` recorded it; a sentinel sweep over the assembled prompt + `mayConfide`
  finds no sealed premise pre-disclosure and no number ever.
- **Reason gates depth:** rising `disclosureMotive` (more favors/closer bond) monotonically raises
  the tier; below `tease`, `confide` returns `{ disclosed: false }`.
- **No cold open:** with the player *not* in a scene with the houseguest, no `mayConfide` and no
  disclosure path exists; `mayConfide` requires a fresh precipitating event.
- **Lies:** a fabricated confidence carries no real secret of any houseguest (cross-check against
  the sealed store); the player surface shows no truth marker; a later contradicting pathway flips
  the belief and folds the betrayal blow; lies are capped per season.
- **Anti-sycophancy:** no number crosses; `confide` never fires more generously for the player than
  the seeded motive dictates (the engine never "rewards" the human with a free secret).
- **Determinism:** seeded — same seed + same history ⇒ same tier + same (true/false) choice.

## Open questions / defaults (resolve at build)

1. **Player-authored confidences (out of scope v1).** The player confiding in an NPC and *that*
   mattering (the NPC can repeat it / weaponize it) is a natural sequel — deferred to keep v1 to
   NPC→player.
2. **Default bands:** start `tease ≈ confidantBondThreshold (0.7)`, `partial ≈ 0.8`, `full ≈ 0.9`
   of the combined motive, tuned against the UAT once live.
3. **Lie cap:** default ≤2/season (mirrors 0059's "≤2 ties / ≤2 showmances" sparseness).
4. **Catching a lie:** ✅ **BUILT (v1, 2026-06-27).** A later truthful pathway from the houseguest who
   lied flips the player's belief to the truth (recorded at the higher truthful confidence) and folds a
   betrayal-grade blow on the player→liar edge (`IMPACT.betrayal`) in place of the warm bond bump — the
   player lever only, so the seeded calibration spine is byte-identical (the fold does the same 4 jitter
   draws the old bond bump did). The blow lands **exactly once**: the catch flips `confideState[npc]` to
   truthful, so any later press at the same-or-lower tier is absorbed by the monotonic re-tell guard (no
   double-penalty). Gate: `confideBoundary.test.ts` + the BDD `0075` lie-catch scenario. A louder "you realize \<name\> lied to you" beat (a different
   pathway delivering the truth, an explicit catch announcement) remains a possible enrichment.
