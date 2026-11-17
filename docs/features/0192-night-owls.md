# 0192 - Night owls

Card: ORW-620 (approved by Ryne 2026-11-17, Fable idea "missed in design" #3). Executable spec: `0192-night-owls.feature`. Unit gates: `tests/unit/nightOwls.test.ts`.
Flag: `ORWELL_NIGHT_OWLS` (default ON, `=0` kill switch). Played games only (`live.playedGame`); a headless game and flag-off are byte-identical (no `nightOwl` field on the hour view).

## What it is

Today a slept-through night is nearly empty. Now, in the `night` and `late-night` hours, the few houseguests still awake (per-character bedtimes, ADR 0006) sometimes seek each other out: a
whispered scheme, a confession, a bonding talk, or a fight. Sleepers never take part (ORW-572: the hour view holds only the awake, and a step names only people in it). The engine decides; the narrator only voices.

## How

- `chooseHourAction` (`src/engine/houseLife.ts`), after goals, the court, a showmance, pair habits, rituals and habits, and before ordinary life: when `HourView.nightOwl` is present, the time of day is night or
  late-night and at most `HOUSE_LIFE.nightOwlMaxOthers` (5) other houseguests are up, a keyed roll `hour:...:owl` below `nightOwlPull` (0.28, x1.3 in the small hours) turns the free hour into a talk.
  A bounded, keyed pull (no shared rng draw): the A10 want-movement flag once failed juryReach seed 18 above about 1.5, so this stays small and replaces only a free hour, never a goal hour.
- The partner is the best-scoring awake houseguest (affinity + a keyed jitter + a small lean toward whoever already has company up, `nightOwlGatherLean`); the actor goes to the partner's room.
- The talk is built from the holder's own state with no menu: a goal they are driven by (its own step, so this is the scheming), else a fight (dislike, temper, a low mood: the same friction shape as ordinary life),
  else a confession (`homesick-talk`) when low, else bonding (`bed-talk` / `tell-stories`; another awake houseguest in that room joins, so a trio can form).
- Every talk is a hidden house-life event (witness set = the people in it, never the player; `houseLife.nightOwl = true`, engine-only). A player who walks into the room later meets it through the existing walk-in
  rule (ORW-473); nothing is decided for the player.
- The player who stays up (`HourView.nightOwl.playerUp`) can be the partner. The houseguest then comes to them through the desire clock's own approach path (`goalApproaches` with goal `night-owl`) and its guards
  (trust floor, avoidant tie, cooldown); a player who has turned in is never a candidate.

No short lists, no prompt text, no allowlist entry: the kinds are chosen by the holder's state, never dealt from a list.
