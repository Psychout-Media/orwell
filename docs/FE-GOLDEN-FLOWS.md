# FE golden flows (ORW-191)

The acceptance suite the front-end rebuild (React + TypeScript + Vite) must pass unchanged. Recorded against today's UI. Each flow drives the page through the DOM contract below only: no `window.chatModule`, no module internals, no source greps. Real engine, real front end, scripted stub narrator, real Chromium; no model, no cost.

## Flows and where they live
- **Send a message, stream the reply, settle:** `frontend/tests/test_orw191_golden_flows.py` (steps 1-2).
- **Reload restores the transcript once, in order:** same file (step 3). Live-vs-reload bubble parity in depth: `test_a58_golden_render_live_vs_reload.py`.
- **Reload with a queued (offline) message delivers it exactly once:** same file (step 4). Internals-level outbox pins: `test_891_reload_durable_outbox.py`.
- **Two-window mirror, including a new turn arriving live:** same file (step 5). Mid-generation join: `test_m0_3_midgen_join.py`; CI job `mirror-parity`.
- **Confirm a decision card:** `test_0025_secret_veto_card_e2e.py` and `test_n12_decision_submit_timeout.py` (real pages). Card contract: `#orwell-decision-card`, choice chips, Confirm disabled until a choice, the at-most-once `idempotency_key` on submit, "Locked in" on resolve.

## DOM contract used by the suite
- Composer: `#message` (enabled when ready; cleared on send; Enter sends).
- Transcript: `#chat-history`, with `.msg.msg-user` and `.msg.msg-ai` bubbles (a hidden bubble has `style.display = none`).
- Settled reply: an assistant bubble whose text is complete and which holds `.msg-footer button` actions.
- Offline queue: the browser's own offline switch; a queued message shows as a user bubble, is not sent while offline, survives a reload, and is delivered exactly once on reconnect.

## Notes
- The flows pass ~11 of 12 local runs; the one miss was a 40 s wait for a reply to settle with a second window open (page A, turn three). CI runs browser tests with `--reruns 1`. If this recurs, look at the second-window attach (ORW-21) before loosening the wait.
- A rebuild that cannot satisfy a hook above must provide an equivalent contract hook and update this file in the same PR.
