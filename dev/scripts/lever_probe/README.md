# A-12 lever-call probe

Measures how often the narrator model calls the lever a beat requires (tool_choice=auto), per scenario, using the
real engine prompts and the game build's real tool schemas. Stateless; one request per trial.

```
npx tsx dev/scripts/lever_probe/export_scenarios.ts > scenarios.json     # no key, no network
DEEPSEEK_API_KEY=... python3 dev/scripts/lever_probe/probe.py scenarios.json --trials 6   # key from env ONLY
python3 dev/scripts/lever_probe/probe.py scenarios.json --tool-choice required            # floor
```

A hard spend cap (`--cap-usd`, default 1.5) aborts the run. Never write the key to a file. Add `--model` / `--base`
to probe another endpoint.
