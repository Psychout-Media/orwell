# 0200 - Your edit (ORW-632)

**Status: built (2026-11-17). Ryne approved the design. Flag `ORWELL_YOUR_EDIT` (default ON; `=0` = none). BDD `0200-your-edit.feature` + `tests/unit/yourEdit.test.ts`.**

After the crown the game shows the season as TV would have cut it: an episode for each week, who the cut made a hero and who a villain, and how the player came across.

## Where it lives
It rides the post-season retrospective (`seasonRetrospective()`, the 0048 door), as a `yourEdit` field. No new tool, read or projection: the same crown gate (a season that is not finished returns nothing), the same one sanctioned unsealing. It reads only what that retrospective already unseals (the recorded scenes and the week records); it adds no ballot attribution. Played games only (`live.playedGame`). Engine module `src/engine/yourEdit.ts` is pure, and is on the dependency-cruiser Vault list.

## The score is the audience's
Moments are scored by `editWorthiness` (`src/engine/editWorthiness.ts`, shared with the audience outside, 0190): imported, not re-implemented, so the recap and the audience agree. The week's moments come from one shared map (`weekMoments`, also used by the audience); scenes use the same kinds (`sceneMoment`). An episode keeps the top three moments of its week by that score.

## Hero and villain (a closed-set measure, deterministic, bounded)
For each houseguest, the player included and in the same way:

- contribution of a moment = `editWorthiness(m)` x sign. The sign for the one who did it: win +1, save +1, betrayal -1, blow-up -1, blindside -0.5, scheme -0.5, spark +0.5. For the one it happened to: blindside +1, betrayal +1, blow-up +0.5, replacement +0.5, save +0.5, spark +0.5. (Table `YOUR_EDIT.actor` / `.subject`.)
- a promise kept adds `keptWorth` (0.25) to both parties; a deal broken counts as a betrayal moment against the other party.
- `edit = net / (sum of |contribution| + prior)`, so it lies strictly between -1 and 1 and a houseguest with one small moment stays near 0.
- hero: `edit >= 0.3`, on screen (total at least 0.8) and a **clean word** (never broke a deal, never betrayed). Villain: `edit <= -0.3` and on screen. Otherwise mixed, or a background figure. Up to three of each are named.

The measure never leaves the module; only the band word and the facts behind it do.

## The player, honestly
`you` carries the band and the player's own deeds as counts (deals kept and broken, deals broken on them, blindsides dealt and received, betrayals, comp wins, the jury's split). It comes from engine records and is never flattering by default: a broken word keeps a hero edit out of reach for anyone.

## Titles and edit lines are authored live, no lists
The engine hands facts (each episode's top moments with names, the week's head of house and evictee, whether the count was close; each hero's and villain's `because` facts; the player's deeds). The narrator voices the titles and edit lines from them (rules in the seasonRetrospective bullet of the narrator prompt: facts only, no reuse of wording, nothing invented, no number). The engine's `title` and `line` are the composed offline floor for no model: built from the week, the moment's kind and the names (so the names carry the variety), with no dealt pool. The prompt carries rules only, no sample titles or closed menus; `ci/check_short_lists.py` stays at 0 violations with no allowlist entry.

## Front end
The retrospective window renders the floor lines under "Your edit" (render-only, textContent, no number). The host model receives `yourEdit` in the `seasonRetrospective` result (the field is not popped). No new FE tool, so no lever wiring.

## Deferred (ORW-807 for the authored titles; ORW-825 for the rest)
Writing the narrator's authored titles back to the engine so the window shows them too (a four-place write-back); floater and comic-relief edits. (Alliances in the edit were built under ORW-747: `episodes[].alliances` and `you.alliances`, facts only. The audience's favorite rides the same retrospective as `americasFavorite`, ORW-624.)

## Amendment 2026-11-19 (ORW-691, B1-5): the cut now emits replacements, house meetings and schemes
The weights for `replacement`, `house-meeting` and `scheme` existed (`YOUR_EDIT.actor/.subject`, `EDIT_BASE`) but nothing produced those kinds, so they never reached an episode or a hero/villain band. The edit (only the edit; the audience still reads the old kinds) now reads: the replacement a veto save brought (kept on the week digest as `replacement`, written only when one was named), each house meeting (caller as actor, accused as subject, the room as the crowd) and a strategy scene as a scheme (`EDIT_SCENE_KIND`, behind `sceneMoment(..., moreKinds)`). Read-only, after the crown, no fold, no rng. Flag `ORWELL_EDIT_MOMENTS` (default ON; `=0` is the old cut, byte-identical). Test: `tests/unit/orw691YourEditKinds.test.ts`.

## Amendment 2026-11-27 (ORW-1098): at most one moment of each kind per episode
Over 14 played seasons every episode was three blow-ups: a public blow-up scores about 1.0 and a week has about three, so no comp win, veto, replacement, nomination, eviction or showmance ever reached an episode. With the fuller cut on (`ORWELL_EDIT_MOMENTS`, default ON), an episode now keeps the best moment of each kind, top three kinds by the same score (a week keeps fewer when it had fewer kinds). The score, the hero and villain measure and the player's counts are unchanged. Spec 0200 named no mix; this rule is the minimal one that keeps blow-ups (still first when they score highest) and guarantees variety, and it is awaiting Ryne's confirmation (card comment tagged "Ryne: confirm"). `=0` is the old top three, byte-identical. Test: `tests/unit/orw691YourEditKinds.test.ts`.
