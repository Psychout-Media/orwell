# A-12 lever-call probe

Measures how often the narrator model calls the lever a beat requires (tool_choice=auto), per scenario, using the
real engine prompts and the game build's real tool schemas. Stateless; one request per trial.

```
npx tsx dev/scripts/lever_probe/export_scenarios.ts > scenarios.json     # no key, no network
export DEEPSEEK_API_KEY=...   # from the environment ONLY; never write it to a file
frontend/.venv/bin/python dev/scripts/lever_probe/probe.py scenarios.json --trials 6
frontend/.venv/bin/python dev/scripts/lever_probe/probe.py scenarios.json --tool-choice required   # an any-tool baseline, not an expected-lever floor
```

A hard spend cap (`--cap-usd`, default 1.5) aborts the run. Never write the key to a file. Add `--model` / `--base`
to probe another endpoint.

## Results (2026-11-03, deepseek-flash via api.deepseek.com, tool_choice=auto, FIRST round only, 8 trials/scenario)

| scenario (expected lever) | base | + tail-reminder |
|---|---|---|
| hoh-competition (advanceGame) | 7/8 | 8/8 |
| nominations (advanceGame) | 8/8 | 8/8 |
| veto-ceremony (advanceGame) | 0/8 (7 prose) | 8/8 |
| eviction (advanceGame) | 1/8 (7 npcVoice) | 4/8 (4 prose) |
| deal (makeDeal) | 0/8 (npcVoice first) | 6/8 |
| confide (confide) | 3/8 (npcVoice first) | 1/8 |

Cost: ~$0.31 per 48-call pass (~$0.86 across all three runs incl. the 6-trial baseline). Caveats: first round only — a
call to `npcVoice`/`getGameState` before the lever is a miss here but not in the real multi-round loop; n=8 is a
signal, not a rate; the closed-set beats are covered in production by forced `tool_choice` (`requiredLever`) for models that honor it — `deepseek-flash` is on the forced-`tool_choice` denylist, so for it the textual fallback applies and these numbers are the relevant ones.
`tail-reminder` appends a one-paragraph "call the lever FIRST" system message after the hard-constraints block.

### Multi-round pass (lever must land within 3 rounds; stubbed tool results; n=10; `--rounds 3 --variant scoped`)

`scoped` = the reminder only on the deal / veto-ceremony / eviction beats (never confide).

| scenario | base | scoped |
|---|---|---|
| veto-ceremony (advanceGame) | 3/10 | 10/10 |
| eviction (advanceGame) | 4/10 | 8/10 |
| deal (makeDeal) | 5/10 | 5/10 |
| confide (confide) | 5/10 | 5/10 (reminder not applied) |

Cost: $0.58 base + $0.47 scoped. **Verdict: mixed — no prompt change shipped.** The reminder lifts the closed-set
ceremony beats (which production already forces with `tool_choice` via `requiredLever`), but does not lift the social
`makeDeal` beat once the model gets multiple rounds, and confide is unaffected. Re-run after a model change:
`frontend/.venv/bin/python dev/scripts/lever_probe/probe.py scenarios.json --trials 10 --rounds 3 --variant scoped`.

**Validity caveat (found in review):** the `deal` and `confide` rows above were measured with the prompt left over from
the last closed-set phase the walk reached (eviction), not the social moment. `export_scenarios.ts` now requests the
`social` moment for them (and fails loudly if a scenario is missing); those two rows should be re-measured before they
are relied on. The closed-set rows (advance beats) are unaffected. The tool menu is a curated subset of production's.
