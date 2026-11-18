# 0190 - The audience outside (ORW-624)

Summary: a simulated viewing public forms its own opinion of every houseguest, the player included, from what would make the TV edit. You never see a number. You feel it: the crowd as an evictee walks out, a small fan reward, and America's Favorite after the crown. Ryne OK'd the design on 2026-11-17 ("Things you think would make the edit of the show"). Vault design note: "Audience Outside Design". Flag `ORWELL_AUDIENCE`, default ON. Played games only. Engine-only.

## Edit-worthiness, the one shared score
- `editWorthiness(moment)` (`src/engine/editWorthiness.ts`) scores how much a moment would make the edit, from a closed list of moment kinds:
  - a comp win, a veto save or keep, a replacement, a nomination, an eviction;
  - a blindside (the evictee had been publicly called a pawn);
  - a blow-up, a betrayal, a house meeting, a showmance, a scheme.
- A twist (a close count) and a crowd in the room raise it.
- A's "your edit" (ORW-632) reads the same score, so the two agree.

## The public's view (`src/engine/audience.ts`)
- **What moves it:** each moment moves the public's view of whoever did it and whoever it happened to. Wins and saves are liked, betrayals and blow-ups disliked, and sympathy goes to the blindsided and the betrayed. Each move is scaled by the moment's edit-worthiness and by the season's own seeded taste.
- **The wall (the Auditor's call):** during play the public sees only what the house saw: the week's public record (`weekDigests`, the public tally, the HOH's public stated reasons) and the scenes the player witnessed. So the crowd can never pinpoint a secret. Hidden edit-worthy moments fold into a separate full view that is read only after the crown.

## How it is felt
1. **The walk out.** After each eviction the evictee leaves to cheers, a mixed reaction, boos, or near silence (someone barely on screen). It is a scene the house hears; the narrator voices it in its own words.
2. **A fan reward** in weeks 4 and 8: the public's favorite still in the house wins the viewers' vote and a reward from home. Never safety, never a vote.
3. **America's Favorite** in the post-crown retrospective, from the full view (the recap may count hidden moments).

## The player in both directions
- The player is judged by the same moments as anyone (their wins, saves and blow-ups).
- The player hears the crowd at every walk-out and can read it, like the house does.

## Follow-up (ORW-624): the walk out, the exit interview, the fan reward
- **The walk out comes first.** The crowd is decided as the evictee's exit interview begins: the audience folds the week so far (the ceremony state is still live), and the evictee walks out. The exit interview beat carries the crowd they walked out to, so the narrator can play their tone against it. The stance itself stays derived from the manner of the eviction (0130), never from the crowd.
- **The walk out happens once per eviction.** The after-eviction step reuses the decided crowd. Evictions are folded by key, so a twist night's second eviction folds too.
- **A player-evictee hears their own crowd** before their exit interview, as an event for them alone. The house hears its own line through the door, and a juror never gets the house's news (0129).
- **The house reads the viewers' favorite as a jury threat.** A fan reward is a public moment: each houseguest's threat read of the winner rises, more as they play the social game. The player can be the winner, and the house then fears the player more. An NPC winner is told to the player as the house event it is; the player's own read is theirs to form.
- **Retrospective:** each exit interview row keeps the crowd.
- Per the Coordinator, houseguests sense the crowd only at the public fan-reward moments, never from the walk out's cheers or boos.

Tests: `tests/unit/audience.test.ts`, `tests/unit/audienceCrowd.test.ts`, `0190-the-audience-outside.feature`.
