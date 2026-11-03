# 0088 — A living, current read of the player (your reputation, shifting in real time)

> **Status:** ✅ **BUILT.** Tracks issue **#864**. The cue reaches the model both ways: pulled via `npcVoice`, and pushed with the present-company cues (`presentKnowledgeForPrompt` carries `currentRead` beside `mood`) into the moment prompt.
> **Gate:** engine (Vitest + a property/distribution gate + the dependency-cruiser Vault
> boundary, which runs as the Vitest test `tests/architecture/vault-boundary.test.ts` inside the engine lane's `test:ci` — the standalone `npm run test:arch` CLI is not a separate CI step + BDD `0088-living-current-read.feature`) and front-end (the voicing path consumes the new
> Vault-safe `currentRead` carriage cue through `getMomentPrompt`/`npcVoice`, pytest-gated).
> **Depends on:** 0001 (the Vault Wall — the read is hidden state, surfaced behavior-only), 0002/0017/0026
> (the directed, graded, asymmetric NPC→player relationship edge this read is *computed from* — the
> `RelationshipModel` + its constants), 0023 (the consequence & memory fold — the edge already moves
> live from every recorded happening), 0041 + `emotionalArc` (the soul colouring the carriage of that
> read), 0058 (deep profiles — the **frozen** `dayOnePerception` this feature is explicitly *distinct
> from*), 0084 (the `mood` carriage cue — the **direct template**: a Vault-safe affect word read from
> the soul; this is its sibling, a Vault-safe *read-of-you* word from the NPC→player edge). **Sibling of**
> 0084 (mood is how they feel; the current read is how they feel **about you**) and 0086 (drives — a
> houseguest's own agenda colours how they read you). **Bounded by:** mandate #2 (Vault Wall — never a
> number, never to admin, the player **infers**), mandate #3 (anti-sycophancy — the read is *computed*
> from the recorded history, never narrated into being to please the player), and mandate #4
> (non-degradation — the read deepens over a season; the day-one read is preserved, never overwritten).

> **Owner direction (Tracks #864):**
> *"Each houseguest still reads me the way they did on day one, even deep into a season — it never
> changes. I want them to actually read me **now**: my reputation should shift in real time based on
> what I've done, and I should feel it — not as a number, just in how they treat me."*

## The problem this fixes

A houseguest is **born with** a Vault-sealed `dayOnePerception` (0058): a short clause ("friendly,
harmless, and socially useful — not a threat yet") plus signed leans that nudge the move-in
NPC→player edge. It is, correctly, **frozen** — it is the *first impression*, part of the static
deep profile, seed-stable and player-independent (`src/engine/deepProfile.ts`,
`PERCEPTION_POOL`).

But that frozen clause is the **only** structured "how this NPC reads the player" artifact the engine
exposes by name. The NPC→player **edge** in the `RelationshipModel` genuinely *does* evolve live — every
recorded scene, ceremony act, deal honor, and betrayal folds its hidden impact into trust / affinity /
threat (0023, the live folds in `EngineCommandsAdapter`/`GameSessionAdapter`). The dynamism is real and
persisted. **What's missing is that the living read is never surfaced as "how they're reading YOU right
now."** So:

1. The model, when it reaches for a houseguest's perception of the player, has only the **frozen**
   day-one clause to lean on (via the deep-profile recall / `humanize` "their day-one read of you —")
   — so a houseguest the player has spent six weeks earning, or betraying, can still come across as
   reading them exactly the way they did at move-in. The reputation the player has actually built is
   invisible to the voicer.
2. The most satisfying retention beat in a social game — **feeling your reputation turn** — has no
   carrier. The numbers move; the *behaviour* the player sees doesn't reliably move with them.

This is a **missing fact, not missing UI** (ADR 0003): the living read already exists in the store; it
just isn't *queried and handed to the model to voice*. We do **not** add a panel, a meter, or a number —
the chat is the game.

## The core idea — a frozen first impression PLUS a living current read

Two distinct, co-existing artifacts, both Vault-sealed, both surfaced **only behaviorally**:

| | **`dayOnePerception` (0058 — kept)** | **`currentRead` (this feature — new)** |
|---|---|---|
| When | move-in, once | recomputed live as events fold |
| Source | seeded `PERCEPTION_POOL` clause + leans | **derived from the live NPC→player edge** (trust/affinity/threat) shaded by the holder's disposition + soul |
| Mutates? | **never** (it is the first impression — preserved) | **yes** — drifts with what the player has done |
| Stored | Vault deep profile | **not stored as a label** — derived on the spot from the edge (ADR 0002: labels are organic, never persisted); only the edge persists |
| Surfacing | behavior-only, never a number | behavior-only, never a number |

Crucially, the current read is **not a new hidden number and not a stored label**. It is a *projection
of an edge that already evolves and already persists* — exactly the ADR 0002 rule that an "ally / threat"
label is read off the graded signals **through the holder's own framing, never stored**. This feature
adds the *reading function* and the *Vault-safe carriage cue*, nothing new to seal.

## The mechanic

### 1. The reading — engine-owned, hidden magnitude

A pure reader (`currentReadOf(npc → player)`) folds the live edge's graded signals **through the holder's
`Character` disposition** (a paranoid holder tips toward "wary" on the same history a trusting one reads
as "warming") and the holder's soul state (a rattled soul reads even neutral conduct more sharply). It is
the sibling of `relationshipLabel` (already in `relationships.ts`), but oriented at the player and
**delta-aware**: it captures not just *where* the read sits but *which way it has moved* since a recent
anchor — because "your reputation **shifting**" is the point. All magnitudes are the existing
`RELATIONSHIP_CONSTANTS` plus a small new `CURRENT_READ` band table (the `THREAD`/`GOSSIP`/`DRIVE`
sibling — one tunable home, the B59 grep gate covers it). No raw signal value leaves the engine.

### 2. The surfacing — behavior-only, never a number (the Vault-safe carriage cue)

The read reaches the model exactly the way 0084's `mood` does: as a **short, Vault-safe word/phrase** on
the per-NPC voicing projection — *observable conduct toward the player*, never the hidden cause and never
a number. Two read-only fields on `NpcVoiceView` (sibling of `mood` / `mayConfide`):

- **`currentRead.toward`** — the *standing* carriage word: how this houseguest currently **treats** the
  player ("warm and open", "cooling", "guarded", "sizing you up", "wary"). A behaviour label, derived,
  never the underlying signals.
- **`currentRead.drift`** — the *movement* cue: `"warming"` / `"cooling"` / `"steady"` since a recent
  anchor — so the model can play a reputation **turning** (the houseguest who used to be easy now keeps
  it short), which is the felt experience #864 asks for.

The model voices these as **how the NPC carries themselves toward the player** — a cooler greeting, less
eye contact, a guard going up, an easy laugh that used to be there and isn't. It is **never** stated as
"they trust you 0.3" and **never** as the engine asserting how the *player* feels (mandate #3 / 0017 —
paranoia and loyalty are the human's to form; the player **infers** the read from conduct). The
`momentPrompts` lever instructs: *voice the carriage, never announce the read; never invent a swing the
cue didn't carry.*

The **day-one clause stays available too**, distinct: a houseguest can read the player warmly *now* and
still carry the wary first impression in their recall — the gap between them is itself drama (they liked
you at first and have cooled; they were wary and you won them over).

### 3. Distinct from the frozen day-one read (non-degradation)

The `dayOnePerception` is **never overwritten** (#4): it remains the sealed first impression, preserved
across saves, still seeding the move-in edge. The current read is a *second* lens over the *evolved*
edge. Both persist correctly because the **edge** persists (0023/0007 — `RelationshipModel.serialize`
already round-trips every directed signal, and it deepens, never thins). A restored game produces the
same current read because it produces the same edge.

## Engine seams (where this lands)

- `src/engine/relationships.ts` — a new pure reader `currentReadOf(signals, disposition, soulState?, anchor?)`
  returning `{ toward: string; drift: "warming" | "cooling" | "steady" }`. A sibling of
  `relationshipLabel`: derived on the spot from graded signals **through the holder's disposition**, never
  a stored label. Pure, no I/O, no Vault handle (handed the already-read signals).
- `src/engine/relationshipConstants.ts` (or a small `currentReadConstants.ts` sibling, the
  `THREAD`/`GOSSIP` pattern) — the `CURRENT_READ` band table: the carriage-word thresholds and the
  drift epsilon (how big a move counts as warming/cooling vs. steady). One tunable home (B59 grep gate).
- `GameSessionAdapter.npcVoice` — populate the optional, read-only **`currentRead`** on `NpcVoiceView`
  from the live `this.rel` NPC→player edge + the holder's disposition + soul. Reuses state the adapter
  already holds; engine-side only; **no new Vault read** (the edge is engine state, not Vault content,
  but the projection still scrubs to a word). To compute `drift`, the adapter keeps a small Vault-only
  per-NPC **anchor** of the read at a recent reference point (e.g. start of the current week),
  persisted in the snapshot (a derived convenience, never a label, never crossed).
- `src/engine/momentPrompts.ts` — the `social`/`npcVoice` moment lever gains the `currentRead` guidance:
  voice the carriage as observable conduct; play a `drift` as a reputation turning; never a number,
  never an assertion of how the player feels, never a swing the cue didn't carry.
- `src/ports/GameSession.ts` — the `NpcVoiceView.currentRead?` field + its doc (Vault-safe: a carriage
  word + a drift word only; no signal, no number, no cause).

> **No new outward surface.** This rides the existing `npcVoice` projection (the sanctioned,
> per-NPC-bounded voicing seam) — exactly where `mood` (0084) and `mayConfide` (0075) already live. No
> HUD, no meter, no panel (ADR 0003).

## Engine-owned hidden magnitude vs. behavior-only surfacing

The **magnitude** (where trust/affinity/threat actually sit, and how far they moved) is engine-owned,
hidden, and seeded — it lives in the `RelationshipModel` edge and never crosses the wall. The
**surfacing** is a Vault-safe *word* (`toward` + `drift`) that says only how the houseguest **acts**
toward the player. The player reads conduct and **infers** the relationship — the engine never tells them
the number and never tells them how they themselves feel. This is the same split that makes the whole
consequence loop legal (0023): the change is real, recorded, and invisible; only the later behaviour is
visible.

## Vault Wall (mandate #2 — symmetric: player AND admin)

- **No number ever** reaches the player — `currentRead` carries words, not signals.
- **No hidden cause** crosses — the read says *how they treat you*, never *why* (the why lives in the
  folded events the player may or may not have a pathway to).
- **Walled from admin / God Mode too.** The current read is a projection of hidden relationship state;
  it is exposed **only** through the player-facing voicing path as a carriage word. No admin/God-Mode
  surface gains the underlying signals (the existing dependency-cruiser boundary + the "admin allowlist
  is Vault-free" guarantees hold unchanged — this feature adds no `readsVault` tool and no admin field).
- **The player infers** (mandate #3 / 0017): the engine never asserts "you trust them" or "they trust
  you 0.4"; it only voices observable conduct. Paranoia and loyalty stay the human's to form.

## Determinism / calibration-neutrality

`currentReadOf` is a **pure read** — it takes no rng and changes no edge, soul, vote, or outcome. It
cannot perturb the seeded calibration spine: the same seed + same history ⇒ same edges ⇒ same carriage
words. The `drift` anchor is a derived convenience that is *read* and *snapshotted*, never an input to any
roll. So `juryReach` / the UAT / the eviction distribution are **byte-identical** with this feature
present (the surfacing is additive; an absent `currentRead` field ⇒ byte-identical behaviour for a
pre-0088 save). Anti-sycophancy: the carriage never reads more warmly for the player than the seeded edge
dictates — there is no path that "rewards" the human with a friendlier read than they earned.

## ADR 0003 fit (the conversation is the game)

This is a textbook ADR-0003 fix: the living read is a **fact already in the store** that the engine was
failing to *query and hand to the model*. We add no UI and remove nothing the player plays through — we
hand the model the read-of-you it was missing, as texture to voice, never a script. It makes the chat
*more* the game (the cast reacts to the reputation you've actually built) without turning any of it into a
dashboard.

## Acceptance criteria

1. A houseguest's **current read of the player evolves**: after the player accumulates favorable
   conduct toward an NPC (recorded scenes folding warmth), that NPC's `currentRead.toward` reads warmer
   than at move-in; after adverse conduct, cooler — distinct from the unchanged `dayOnePerception`.
2. The current read is **distinct from, and does not overwrite, the day-one read**: the sealed
   `dayOnePerception` is unchanged across the season and a save round-trip; the two can disagree, and
   that gap is itself voiceable.
3. **No number ever** appears on `npcVoice` / `currentRead` / any projection — a sentinel sweep over the
   assembled voicing prompt finds no signal value and no float; the read is a word.
4. **Walled from admin:** no admin / God-Mode surface exposes the underlying NPC→player signals; the
   dependency-cruiser boundary and the admin-allowlist-is-Vault-free guarantee stay green.
5. **The player infers:** the surfacing carries observable conduct only; the engine never asserts how the
   player feels and never labels the relationship for them.
6. **Drift is felt:** when the NPC→player edge moves enough since the anchor, `currentRead.drift` reads
   `warming`/`cooling` (else `steady`) — so the model can play a reputation turning.
7. **Determinism / calibration-neutral:** same seed + same history ⇒ same carriage words; `juryReach` /
   UAT byte-identical with the feature present; an absent `currentRead` on an old save ⇒ byte-identical.
8. **Anti-sycophancy:** the read never surfaces warmer than the seeded edge dictates; no free warmth for
   the human.

## Open questions / defaults (resolve at build)

1. **The `drift` anchor cadence.** What "recent reference point" to diff against — the read at the start
   of the current week, the last time this NPC was voiced to the player, or a short rolling window?
   Start: **per-week anchor** (a reputation turn reads over a week, not a single line), tuned against the
   UAT once live.
2. **The carriage-word vocabulary + bands.** The exact `toward` words and the trust/affinity/threat
   thresholds that pick them (and the drift epsilon). Start from the `relationshipLabel` shape
   (ally/acquaintance/enemy) expanded into player-facing carriage words; tune for texture, never a flat
   knob.
3. **Player→NPC vs. NPC→player.** This feature surfaces the **NPC→player** read (how the cast reads the
   player — the reputation #864 is about). The engine also computes `player→NPC`, but the player's *own*
   reads stay human-driven and are **not** asserted back to them (0017). Default: surface NPC→player only.
4. **Interaction with `mayConfide` / `mood` / drives.** The current read, the mood, and a drive all
   colour the same scene; ensure they compose (a warming read + a rattled mood = warm but on edge) rather
   than one flattening the others. Recommend: keep them orthogonal cues the voicer blends.
5. **Confidence gating.** Early, low-`confidence` edges are *hunches* (0002). Should a very-low-confidence
   read suppress the cue (the NPC hasn't formed a read yet) or surface a tentative one? Start: suppress
   `drift` below the knowledge threshold (no firm turn yet), still allow a soft `toward`.

## Traceability

Tracks **#864**. `docs/decisions/0002-relationship-model.md` (directed/graded/asymmetric edges; labels
organic, never stored; "whether NPC→player edges are tracked the same way — they should be"); 0017/0026
(the relationship math + constants); 0023 (the live consequence fold that moves the edge); 0041 +
`src/engine/emotionalArc.ts` (the soul colouring carriage); 0058 + `src/engine/deepProfile.ts`
(`dayOnePerception` — the frozen first impression this is distinct from); 0084 +
`docs/features/0084-character-voice-and-mood.md` (the `mood` carriage cue this mirrors). ADR
`docs/decisions/0003` (the conversation is the game — a fact to voice, not a panel).
