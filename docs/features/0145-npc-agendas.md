# 0145 - NPC agendas: lasting goals (ORW-253 slice 1)

> **Status:** slice 1 core BUILT (pure engine module + unit gate). Wiring onto the live season (persist, re-check on events, nightly mull,
> admin-free) is the overseer half of slice 1. **Design:** vault "NPC Minds Design Theme 1", approved by Ryne 2026-11-12 ("Yes I approve.
> Let's get started."). **Scenarios:** `0145-npc-agendas.feature`. **Tests:** `tests/unit/agenda.test.ts`.

## What it is
Every houseguest holds a small, lasting agenda (`src/engine/agenda.ts`, tunables in `agendaConstants.ts`):
- **Season goals:** a main aim from the character (win by comps, win by being liked, run the house, reach jury, last alliance standing,
  prove I'm not a floater), plus goals that emerge: protect a pre-show friend, keep a secret, revenge after a deep betrayal, and a
  long con (strategic types only, not all of them).
- **Week goals** (up to three): get someone out, stay safe, pull someone in, keep an ally safe, win power, find something out.
- Each goal stores the target, **why** (pointers to the real threat read, bond, memory, board fact, secret or carry-over that caused it),
  a closed **success test** the engine evaluates, a **commitment** and a **status**.

## The person, not only the type
Leanings and stubbornness come from the archetype PLUS the houseguest's own strategy style, game philosophy and susceptibility to
persuasion, plus a small personal seeded offset (`seasonLeanOf`, `stubbornnessOf`). Two houseguests of one archetype can want different
things and hold on differently. Reading the free-text backstory (biography, identity concept, vocation) is model work: slice 5 lets the
utility model propose a season aim from the backstory, bounded to the closed goal kinds and adjudicated by the engine (ADR 0022).

## The rules it keeps
- **Goals outlive moods.** A held goal is replaced only when it settles (achieved or failed), when a new goal beats it by the holder's
  stubbornness margin, or when the holder gives up overnight. Stubbornness belongs to the person (see above).
- **Week close:** unmet week goals fail; next week's goals form on a clean board; a failed target carries over with a bonus.
- **Night:** inner processing only (ORW-256): no-progress goals fade by (1 - stubbornness); below the floor they are dropped; keeping a
  secret is never given up.
- **Holder's view only:** every input is the holder's own reads and the public board.
- **Secret (Vault class):** listed in the dependency-cruiser VAULT denylist as well as the engine layer. The only planned reader outside
  the engine is the post-season retrospective ("the house you never saw", Ryne 2026-11-12). Motives are never hinted; they drive actions.
- **Non-degradation:** resolved goals move to `history`, append-only (`isAgendaSuperset`).
- **Deterministic, spine-neutral:** no shared rng (a local hash of season seed and holder), read by nothing in slice 1, so no seeded
  outcome moves. Slice 2 makes decisions read it at full strength (Ryne: goals count as much as the threat read).

## Ryne's answers this encodes (2026-11-12)
Goals full strength (slice 2); secrets worth protecting = yes; long cons = yes, strategic or mastermind types only; the house you never
saw = yes (retrospective, later slice); small wants = later; motives: no hints, actions are the evidence.

## Slice 2 core: goals move decisions, and reasons are stored (`agendaDecisions.ts`)
- `goalPull(agenda, candidate, board, mates)`: signed pull on one candidate, FULL STRENGTH (Ryne 2026-11-12: goals count as much as the
  threat read; `REASONS.goalWeight = 1.0`, same 0..1 scale, not a small capped tilt). Get-them-out and revenge push against; keep-them-safe
  and protect-my-person shield; pull-them-in and an alliance aim shield at half; a long con shields the mark before its stage and cuts
  them after it. Names the goal that pulled hardest.
- `explainDecision(real, speaker, seed, day)`: the REAL reason (goal + terms + tactic, Vault-class) gives a STATED reason from a closed
  set (biggest threat, came after me, loyal to my side, pawn, kept my word, didn't trust you, had it planned, nothing personal, house
  wanted it) with a candor the engine records: truth, part-truth or cover. Candor comes from archetype and style; reasons that reveal a
  plan or grudge are admitted less; a backdoor HOH always says "pawn". Only `voiceableReason` (kind + subject) may reach the narrator.
- Gate: `tests/unit/agendaDecisions.test.ts` (11 cases, 6 mutants each go red). The overseer half wires `goalPull` into nominations,
  replacement, veto and votes (with ORW-305's term breakdown as `terms`) and hands the stated reason to the narrator in place of the
  "invent the HOH's reason" instruction.

## Not in slice 1
Decisions reading the agenda and stored reasons (slice 2); the hour-by-hour actions and next step (slice 3); memory sentences and mood
causes (slice 4); model words (slice 5); jury and final HOH from character (slice 6); house culture (slice 3/5).
