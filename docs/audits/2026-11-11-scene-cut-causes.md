# ORW-273 - why 5 of 92 narrator replies were scene-cut (live run 2026-11-06/07)

Evidence: `~/orwell-playtest/reports/session-20261106-2339.md` (counts only), `live/prod-20261107.log` (the same prod window, 05:43-06:37 UTC), and the 2026-11-10 rehearsal `rehearsal-20261110-2258/fe.log` (which, unlike the prod log, records the cut text). No prod access, no model calls. The prod cut lines of 11-06/07 predate the logging of the cut text, so the two "other" cuts cannot be classified from the evidence on hand.

Already covered before this card: #2313 (ORW-249 slice 1: ceremony scripts ride the prompt only once the engine has committed them), #2329 (ORW-252: a competition that is not due is withheld from the prompt), #2315/#2336 (the competition is voiced from the rounds the engine walked, paused mid-way).

## Per class

| Class (count) | Cause | Verdict |
|---|---|---|
| Nomination ahead of the engine (1; the prod log shows 2 at 06:11 and 06:26) | Stale beat in the prompt. Both cuts sit directly after `production holds nominations - not due yet`: the engine had NOT committed nominations but the moment prompt still carried the key-ritual script, so the model played it. | Fixed upstream by #2313 (script absent until the nominees are committed, replaced by a "has NOT happened" line). Guard behavior is correct; no change. |
| Competition result ahead of the engine (2) | Two sub-causes. (a) Model ran ahead of a paused competition (rehearsal 23:01: engine walked 2 rounds, 4 remained, narrator announced "the last houseguest standing is the first Head of Household"). (b) False positives in the A-9 screen: the pre-resolve walks rounds BEFORE the turn baseline is captured, so before == live and the narrator voicing the engine's own rounds ("The yard erupts") read as "competition did not progress"; also a pronoun matched the named-elimination regex ("He goes down hard on the plank"). | (a) Normal: a winner announced while the engine paused is a true catch, and the pause tail already forbids it. (b) FIXED in this PR (below). |
| Other (2) | Not classifiable: the prod log of that window has no cut text. Since 2026-11-04 the cut log (`data/scene_cuts.jsonl`) and the warning line carry phase + text, so the next session can be classified. | Open, evidence-gated. Re-measure on a current session. |
| Presence wall strip (1) | The narrator placed a houseguest the engine does not have in the room (`presence-wall: dropped a phantom placement`). Fires 8 times in the prod window; a sentence strip, not a cut. | Normal: the wall working as designed; the hard-roster work (#2312, #2314, #2324) addresses the cause. |
| "Live feeds cut away" hole (2) | A whole-scene cut with nothing else shown leaves only the cutaway line. A one-shot in-turn re-voice already exists (`_scene_cut_retry_directive`, 2026-11-04). | Text fixed (below); hole mitigated by the re-voice. |
| Blank-turn re-prompt x3, double-blank minimal beat x3 | The model emitted reasoning-only content; guards re-prompt once then show the engine-board fallback line. | Normal because the guard is the designed recovery; the minimal beat states board facts only. Not a closed-set sync issue. |
| 3 "technical interlude" replies, 7 failed (4xx) calls | Provider stream errors / 4xx. The report cannot say which model. #2346 (ORW-270) now logs provider failures and a client beacon. | Not fixable from this evidence; re-measure with the #2346 logging. |

## Fixes in this PR (frontend only, closed-set claims only, no prompt growth)

1. `_unsettled_competition_result` stands down on round-level cues when the pre-resolve walked competition rounds this turn (`compWalked` on the baseline signature, set where the walk is logged, consumed at baseline capture). Only a winner / crown / title claim still cuts, so "commit before voice" for the result is intact. A named elimination in an unwalked, unsettled competition is still cut.
2. Pronouns and determiners are no longer read as a houseguest name in the elimination regex.
3. Cutaway line text: removed "the empty backyard", which asserted a room state (the yard is full during a competition). The line now names no room state and no hidden state.

Tests: `frontend/tests/test_orw273_comp_walk_cut.py` (failing first), plus the A-9, A2, A79, A89, 0065, N16, ORW-232 and ORW-10 suites.

## Not done

A held-reply-until-commit rung was not added: every cut seen is either already covered by the prompt gates (#2313/#2329) or is the guard correctly catching a model that ran ahead of a paused competition; none showed an engine commit landing late. Cut rate per 100 messages was not re-measured (no current session available without live runs).
