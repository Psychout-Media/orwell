# A9 live premiere check (flag ON) — ≤ ~25 turns, cents-scale. Stage with:
#   export ORWELL_PREMIERE_ENTRANCES=1; MERGE_BRANCHES=overseer-a/a9-premiere-entrances ./stage.sh   (DeepSeek key only inside stage.sh's subshell; images OFF; stop.sh when done)
Checks (screenshot the first entrance, a mid entrance, the toast, the first morning):
1. CAST: finalize with a name; the premiere opens on entrances, NOT the old circle: ONE arrival vignette per turn (a line + a vibe + a reaction), no 15-name roll-call dump.
2. The player's position in the order varies by seed (record playerPosition from the board: `premiereIntros().entrance.playerPosition` via /api/orwell/state or the engine log).
3. Say something social between arrivals (greet, ask who someone is): the arrival cadence waits for a lull of 1–2 messages; typing "next" releases the next arrival at once; saying nothing special for 2 messages releases it.
4. No "meet everyone" gate: ask to start the HOH early → "production hasn't called it yet" (P2b), not a roll-call demand.
5. After the 15th arrival: the living-room toast — host first (generic voice, no real names), then speeches in batches; the player is invited to give theirs (and may ignore it).
6. After the toast: the 48-message Day-1 morning clock (#2070/#2079) — send ~5 social messages and confirm no HOH comp card; do NOT play 48.
7. No ids / raw numbers / hidden info in any bubble (grep the transcript for `npc:`, `trust`, `affinity`).
8. Count: turns from cast-finalize to toast-done (target ≲ 25 with a lulling player), strips/cuts per turn.

## Hang-out rerun (after #2079 + #2086 are on main)
Stage: `export ORWELL_PREMIERE_ENTRANCES=1 ORWELL_HANGOUT=1 ORWELL_DESIRE_CLOCK=1; ./stage.sh` (unset MERGE_BRANCHES), then TMPDIR=/home/ryne/.cache/a9chrome-tmp `python3 a9drive.py $RUN` with `cp script-hangout-premiere.txt $RUN/script.txt`. Watch the log for each stop reason (event-due, npc-approach with a desire, observed, pulled, bedtime) and for any narrator claim that contradicts the board ("the competition's already been run" while daySchedule.due is false) -> if it reproduces, extend the role-claim/circuit-breaker guard.
- A15 live check plan: stage with MERGE_BRANCHES='overseer-a/a15-hangout-pscale overseer-a/toast-voice-hold overseer-a/daybreak-voice' + ORWELL_HANGOUT_P_SCALE=6 ORWELL_DESIRE_CLOCK=1; script-a15.txt
