# Front-end rebuild: scope and the reconciled "deferred" list (ORW-182)

Status: reconciled 2026-11-11 against GitHub (verified with `gh`) and the repo. This file is the written definition the 2026-11-06 audit (report D, section 5 Q1) found missing. The GitHub tracker #1946 ("Deferred to FE rebuild") and #1934 were the sources; both are stale in the ways below and should be edited to point here.

## What the rebuild is

The player-facing tier (`frontend/`, today FastAPI + vanilla JS) is rebuilt as React + TypeScript + Vite (Kevin, 2026-11-06). The engine, the MCP player channel and the Vault Wall do not change. The rebuild consumes only the same Vault-free projections (`frontend/INTEGRATION.md`). In scope: chat rendering and streaming, the gadget rail and windows (0054, the `OrwellWindow` kit), sheets and modals on dvh/transform, the send outbox, two-window mirror (ADR 0008/0012/0015), the gateway adapters (0072). Out of scope: any engine rule, the ports, the store tiers.

## The reconciled list (what #1946 called "Deferred to FE rebuild")

| Item | What it really is | Disposition |
|---|---|---|
| 0072 gateway (Telegram cannot submit decisions or advance; its BDD is vacuous) | FE/gateway work, real | Stays on the rebuild backlog. Note the feature index marks 0072 built (#504); the gap is decision/advance support and a non-vacuous BDD. |
| #1916 reasoning text contrast 3.48:1 | Not reproducing: the XFAIL was removed 2026-11-05 and the matrix now measures 13.1-15.7:1 | Close the issue as not reproducing (re-open only if the matrix regresses). Not a rebuild item. |
| #1413 (R2) collapse the live-vs-reload render paths (ADR 0015) | FE refactor, real, open | Rebuild backlog (the rebuild's single render path satisfies it). |
| #1814 (R1 tail, R3, R6, R7 umbrella) | Refactor umbrella; the FE-side parts fold into the rebuild, the rest is engine/CI | Split: FE items to the rebuild, engine/CI items stay with the refactor roadmap (`docs/REFACTOR-ROADMAP.md`). |
| #1815 (TUN-9, ADR 0016 Seedream portrait follow-on) | A portrait-provider item, not front-end. Already CLOSED; built as the optional fal.ai provider (#1156) | Remove from the list. |
| 0130 post-goodbye auto-advance (in #1934, not in #1946) | Fixed by #1945 (merged 2026-11-03) | Remove; nothing left to defer. |

## The rule on FE-only flags

#1934 said "FE-only flags are out of scope (FE rebuild)". That conflicts with the owner's rule that a feature counts as built only when it is ON by default. Decision CONFIRMED by the owner (relayed via the Coordinator, 2026-11-11: "built means on" covers every new feature, FE or engine): FE-only flags follow the same rule as engine flags. A default-ON flip of an FE flag is a normal FE change made now, not held for the rebuild; only flags whose feature is being replaced by the rebuild are retired with it. (Edit #1934 line 19 to match.)

## The rebuild's real backlog

0072 gateway decision/advance support and a real BDD; #1413 single render path; the FE items of #1814; the sheet component on transform with dvh units throughout (ORW-163 follow-up); 0054 gadget rail / window kit as components; the outbox and two-window mirror parity gates (F1-F5, `docs/audits/2026-06-27-ship-gate.md`) carried over as the acceptance bar.

## Follow-ups outside this file (need an issue edit, not a repo change)

Edit #1946 "Deferred to FE rebuild" to: 0072, #1413, #1814 (FE part). Close #1916 as not reproducing. Drop #1815 and 0130. Edit #1934 line 19 and lines 29-30 to match this file.
