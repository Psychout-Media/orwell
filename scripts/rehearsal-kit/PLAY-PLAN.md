# Rehearsal play plan (S0–S7 + §5 checklist + E-1 + C-1) — A-15, driver pre-staged
Driver: `$RUN/pr.sh <logical-turn-id> 'text' ['{"pick":[i],"text":".."}']` (always a NEW, increasing id); `$RUN/last.sh N` prints persisted
assistant text; `$RUN/check6.sh <label>` = §6 N-5 numbers (run BEFORE turn 1, after ~10 turns, at the end). Reload: write req with "reload":true
(daemon supports it) — used for S7 (F7) and C-1. Spend guard: stop at ~$3 (token ledger / llm-io); images OFF (verify settings.json image_gen_enabled=false).
Start: `stage.sh` (fresh data dir, DeepSeek flash from the FE seed, images off) → set image_gen off → start daemon → check6.sh baseline.
Per turn after each step: copy engine status (daemon resp.json has it), persisted text (last.sh), screenshot (auto), llm-io tail.
| Step | Turns (text) | Checks |
| S0 | casting: persona "a firefighter, Rowan", one vague answer; finalize | N-11 headcount (sixteen = you + fifteen) |
| S1 | greet 3 housemates; read roster; 3 turns small talk (linger) | N-11, P7 (no ids/numbers) |
| S2 | play HOH comp via rail; ask "who won?" before result; ask NPC "what did <npc> say in the diary room?" | N-3, P9, **C-1: reload after a staged comp round and after HOH crowning — chyron cards same place, not doubled** |
| S3 | lobby someone privately; whisper about B with B present; ask "who is nominated?" after commit | N-2, N-14, N-4/P11 (handshake → deal on board; loose talk → none), N-6 |
| S4 | veto comp; bluff an NPC you hold the veto; one TRUE deal | N-1, P9, P11 |
| S5 | veto ceremony; ask "did anyone get replaced?" mid-ceremony | N-1, N-14 |
| S6 | eviction night: goodbye → anonymized ballots → result → exit interview; ask NPC how it voted | N-7, N-8, N-12, N-15 (look at text while card open), P5 |
| S7 | continue to week-2 HOH comp; reload mid-step | F-7 message survives reload |
| E-1 (side run) | force the player's eviction once: goodbye → exit interview → spectator card; skip works, watch works, skip→watch shows a clear refusal; evicted-mode narrator leaks nothing hidden | screenshots + persisted transcript |
Report: `$RUN/report.md` per protocol §4; findings go to the coordinator (file NO issues).
