# 0016 — LLM model selection: GLM-4.7 narrator (reasoning-low), Qwen 3.6 (27B) utility, Seedream portraits

> **Status:** **Accepted** (PO direction, 2026-06-29 — the model-selection research thread).
> **Re-amended (2026-07-13 / 2026-07-14 — reverted the narrator to `z-ai/glm-4.7`):** the owner
> reverted the SHIPPED narrator default back to **`z-ai/glm-4.7`** (2026-07-13, live prod
> debug-bundle audit) and the **golden fixture** back to **`z-ai/glm-4.7`** too (2026-07-14 — the
> gate must test what prod runs; the interim glm-5.2 golden decoupling was papered-over debt, now
> removed). **Utility corrected to `qwen/qwen3.6-27b` (2026-07-21).** The historical retarget note below
> is preserved for context but is superseded on the narrator model by this revert.
> **Utility slug corrected (2026-07-21 — live prod debug bundle):** the previously-shipped utility slug
> **`qwen/qwen3.6-flash` is NOT served on OpenRouter**, so every OOB utility/faithfulness call fell
> through `resolve_endpoint` to an arbitrary first-enabled model — which, being slow/broken, hung the
> casting-finalize burst ("the front-end does not respond during casting"). The OOB utility default is
> corrected to the SERVED **`qwen/qwen3.6-27b`**. Same PR hardens `resolve_endpoint` with a
> narrator↔utility MUTUAL fallback so an unavailable configured model can never again silently resolve
> to an arbitrary one.
> **Amended (2026-07-07 / 2026-07-09 — the two-tier retarget, SUPERSEDED on narrator by the revert above
> AND on the utility SLUG by the 2026-07-21 correction above):** the owner retargeted the pair to
> **narration = `z-ai/glm-5.2`** and **utility = `qwen/qwen3.6-flash`** (Qwen 3.6 on OpenRouter,
> `deepseek/deepseek-v4-flash` as the cloud alternate). On **2026-07-09 the owner
> confirmed the OOB defaults should BE the pair** (not merely this deployment's settings), so
> `DEFAULT_SETTINGS.default_model`/`utility_model` and the OOBE-reset defaults now carry it (M0-6).
> **(The utility slug `qwen/qwen3.6-flash` named here is NOT served on OpenRouter and was corrected to
> the served `qwen/qwen3.6-27b` on 2026-07-21 — see the note above.)** Everything else in this ADR stands: the narrator reasoning posture stays **`low`**
> (GLM-4.7 is the same interleaved-thinking family), the portrait default is **unchanged**
> (`google/gemini-3.1-flash-image` OOB; the Seedream provider is built as an OPTIONAL provider, #1156, used only when fal.ai is explicitly configured as the image model), and the
> per-class reasoning budgets are the cost lever for the utility tier's reason-by-default behavior
> (~266 reasoning tokens on a trivial call — the JSON classes run "off").
> **Source:** a six-lane research sweep (mainstream-hosted + open-weight candidates, community/practitioner
> sentiment, tool-calling & creative-writing benchmarks, current pricing, and self-host feasibility on the
> operator's **2× RTX 2080 Ti**, 44 GB Turing box) reconciled against the project's own audit log + GitHub
> issues — the narrator tool-under-call cluster (#1105/#1033/#549/#1127…), the reasoning-leak cluster
> (#873/#1047/#1143), the cast-authoring strict-JSON failures (#1002/#1007), and the portrait/pronoun
> mismatch (#1140).
> **Amends:** ADR [`0010`](./0010-token-economy-architecture.md) — the owner-ratified
> `reasoning_budget.narration` effort moves **`medium` → `low`** (rationale below). Every other 0010 ruling
> stands; the per-class reasoning architecture is unchanged and is exactly the seam this rides.
> **Builds on / bounded by:** the **Vault Wall** (mandate #2) and **anti-sycophancy** (mandate #3) — both
> unchanged; ADR 0003 (the conversation is the game), ADR 0005 (split authority by openness). This is a
> **provider/config** decision: no new Vault reader, no authority over outcomes, the engine/closed set is
> untouched — not one byte of gameplay logic changes.

## Context

The OOB narrator was `deepseek/deepseek-v4-pro`. It is cheap and, by independent benchmark, a strong
tool-caller (τ²-bench telecom ~96%) — yet the project's own telemetry shows it **fails this harness on the
two axes that matter most**:

1. **Tool-calling, structurally.** DeepSeek V4 runs in thinking mode by default and **rejects
   `tool_choice="required"`** (HTTP 400 *"Thinking mode does not support this tool_choice"*); in real agent
   runs it then chooses **not** to call the tool ~40 % of the time, replying with free text, and ~11 % of the
   time emits a tool call as unparseable plain text in `content` (deepseek-ai/DeepSeek-V3 #1376, #1244). This
   is the structural root of the harness's measured **~0 % spontaneous tool-call rate** and the reason ~12 FE
   guardrails exist to compensate.
2. **Creative regression.** DeepSeek V4 added a positivity bias that *softens conflict* and loses
   character-voice attribution past ~12 K tokens — directly degrading the betrayal/scheming drama and the
   ~16 distinct voices that **are** behavioral fidelity (mandate #1).

Constraints that shape the choice: **cost-sensitive — the Claude API is ruled out**; the operator self-hosts
on a **2× RTX 2080 Ti (44 GB, Turing)** box, where every *frontier* open-weight tool-caller is far too large
but a ~30B-A3B MoE runs fast. Separately, the utility lane failed (#1002/#1007: DeepSeek emitted prose, not
JSON → 0/15 cast profiles authored), and portraits mismatch the narrated gender/pronouns (#1140).

## Decision

### A. Narrator — `z-ai/glm-4.7` (OpenRouter), reasoning **`low`**

GLM-4.7 is the cheapest model that **fixes the structural tool-call bug** while *upgrading* the writing: it
is the #1 open-weight creative writer, uncensored (won't soften betrayal), has the best open JSON/tool-schema
discipline, and — unlike DeepSeek — its tool-calling **rides on interleaved thinking** (it reasons *before
each tool call / action*). It therefore honors `tool_choice` and has no "thinking blocks forced calls"
defect.

Because GLM-4.7's tool *decisions* ARE its interleaved thinking, the narrator runs reasoning **`low`**, not
`off`: a small budget is precisely what lets it decide *which* engine tool to call; `off` would strip that
mechanism and regress "call the tool when we need to." `low` keeps it at modest cost/latency (GLM-4.6's old
thinking-loop stalls are fixed in 4.7). → `DEFAULT_SETTINGS.reasoning_budget["narration"] = "low"` (the
`token_policy.py` model-agnostic *code* default stays `medium`; the shipped GLM-4.7 *preset* is `low`).

Reasoning hygiene is preserved structurally (mandate #2): GLM-via-OpenRouter returns reasoning on the
separate channel the FE already splits on (`json.thinking`). **Pin the provider** and assert reasoning is
actually suppressed/sized — reasoning control is flaky on some OpenRouter sub-providers (e.g. Cerebras).

The narrator's reasoning effort is now editable **in the Default Chat Model settings card**
(`set-narratorReasoning`), kept in lockstep with the Token Economy "Narration" select — both write
`reasoning_budget.narration`.

### B. Utility — `qwen/qwen3.6-27b`

The background JSON lane (cast authoring / prewarm / zeitgeist / summarization / naming) runs a cheap,
fast, non-reasoning Qwen 3.6 tier that honors `response_format`. It is its **own** `utility_model` key —
it does **not** inherit the narrator swap. Background classes already run reasoning `off`.

**Current OOB default = `qwen/qwen3.6-27b`** (corrected 2026-07-21 — live prod debug bundle). The
previously-shipped slug **`qwen/qwen3.6-flash` is NOT served on OpenRouter**, so every OOB
utility/faithfulness call fell through `resolve_endpoint` to an arbitrary first-enabled model — which,
being slow/broken, hung the casting-finalize burst ("the front-end does not respond during casting").
The same correction PR hardens `resolve_endpoint` with a narrator↔utility MUTUAL fallback so an
unavailable configured model can never again silently resolve to an arbitrary one.

*(Superseded history: the original 2026-06-29 decision named `z-ai/glm-4.7-flash` — cheap
($0.06 / $0.40 per 1M; free on Z.ai-direct), 30B-A3B — for this lane; the 2026-07-07/09 two-tier retarget
then moved it to a hosted Qwen 3.6 Flash. Both are superseded on the exact slug by the 2026-07-21
correction above. Self-hosting the same class on the operator's box — Qwen3-30B-A3B-Instruct @ Q6 via
`llama-server`, `enable_thinking=False` at template-apply — remains a documented zero-cost option.)*

### C. Portrait — Seedream v5 Lite Sequential via fal.ai · *built as an optional provider (#1156)*

The #1140 fix is **reference-image conditioning**: generate one canonical headshot per houseguest, persist
it, and regenerate *against* it so face + gender stay stable instead of re-rolling from text. Seedream v5
Lite "Sequential" is the chosen model. It is **not on OpenRouter** (OpenRouter's newest Seedream is 4.5, and
OpenRouter has **frozen** the `/chat/completions` image path the current Gemini portraits use — new image
models live behind a separate `/api/v1/images` endpoint). So this requires a **new fal.ai provider client**
(`fal-ai/bytedance/seedream/v5/lite/edit`; references via `image_urls`; ~$0.035/img). Tracked as a separate
feature build; the OOB `image_model` stays `google/gemini-2.5-flash-image` until it lands.

### D. `tool_choice` force-call at critical beats · *follow-up build*

GLM-4.7 honoring `tool_choice` unlocks a capability DeepSeek V4 blocked: at the closed-set beats where a
missed engine call is catastrophic (HOH result, nominations, veto, eviction), the FE can send
`tool_choice="required"` (or a named function) to **force** the call instead of relying on the model's whim +
reactive guardrails. This is **additive** — the model's good spontaneous interleaved calling is primary, the
forced call is the guarantee on top, and the existing FE error-correction (`_auto_record_scene`, the
stall-nudge, the forced `advanceGame`) is the third net. The `tool_choice` param is *currently deliberately
never sent* (2026-06-21 OpenRouter conformance audit); this build adds it, scoped to the critical beats.

## Rationale

- **Why not just keep cheaper DeepSeek:** the `tool_choice` defect is identical on V4-Flash and V4-Pro, so
  "cheaper DeepSeek" keeps the bug. GLM-4.7 fixes it for ~2× the *output* price (still ~10× under Claude
  Sonnet), and the cheap utility tier (now `qwen/qwen3.6-27b`; see Decision B) is near-free.
- **Why `low`, not `off` (the load-bearing call):** GLM ≠ DeepSeek. DeepSeek's thinking *blocked* tools (a
  bug); GLM's thinking *drives* tools (interleaved — a feature). Disabling it recreates the under-call
  problem we're escaping. This reverses the earlier "thinking-off" lean, which had wrongly carried the
  DeepSeek lesson across.
- **Why not Kimi / Gemini-Flash (the other cheap options):** Kimi leaks reasoning *and raw tool-call tokens*
  into the visible channel on **sparse** toolsets — a bullseye on this harness's Vault Wall; Gemini Flash
  cannot disable thinking and leaks reasoning into the body, and scores ~15 % on multi-turn tool calls. Both
  fail this harness's hard gates regardless of price.

## Consequences / follow-ups

- **Built with this ADR:** the narrator reasoning posture (`low`), the utility default (originally
  `z-ai/glm-4.7-flash`; **now `qwen/qwen3.6-27b`** per Decision B, corrected 2026-07-21), the
  narrator-area reasoning control, and the source-pin tests
  (`frontend/tests/test_adr0010_settings_ui.py`, `test_default_model_resolution.py`,
  `test_adr0010_admin_token_economy.py`). The narrator default-string swap (`deepseek/deepseek-v4-pro` →
  `z-ai/glm-4.7`) lands alongside (parallel work).
- **Follow-up PRs:** (C) the fal.ai Seedream v5 Lite provider (**built**, #1156: `frontend/src/orwell_fal_image.py`, `orwell_portraits.py`; opt-in, alongside the OpenRouter default) + the per-houseguest reference-persistence
  pipeline; (D) the `tool_choice` force-call at critical beats.
- **Owed live verification** (features 0107/0108, real-model golden path): GLM reasoning never reaches the
  public bubble; `tool_choice` + thinking interop on the pinned provider; and an A/B of narration quality +
  tool-call rate vs the DeepSeek incumbent (with DeepSeek V3.2 as a same-ecosystem craft control).

## Amendment 2026-11-02 — DeepSeek's own API is the new-install default (PO ruling)

**Config-only; the engine/closed set is untouched.** For NEW installs the default provider is DeepSeek's
own OpenAI-compatible API (`https://api.deepseek.com`), narrator **and** utility `deepseek-flash`
(`DEFAULT_SETTINGS`). This supersedes the OpenRouter OOB pair above as the *default*; OpenRouter stays a
fully selectable provider, the portrait default stays `google/gemini-3.1-flash-image` (DeepSeek has no image
API), and **persisted stores keep whatever they carry** — nothing is migrated or overwritten.

- **First-boot seed:** if `DEEPSEEK_API_KEY` is set and the `model_endpoints` table is empty, the front-end
  creates one shared DeepSeek endpoint through the normal `ModelEndpoint` row (key `EncryptedText`) and
  sets only `default_endpoint_id` (`frontend/src/deepseek_seed.py`). Any existing endpoint ⇒ no-op, with one exception: a lone, incomplete seed (a single
  shared DeepSeek endpoint whose default was never bound) is re-bound, never re-created or rewritten.
- **Thinking is sent OFF** on the DeepSeek host (`{"thinking": {"type": "disabled"}}`): DeepSeek defaults
  thinking ON, and with `tools` on the wire a thinking turn 400s unless `reasoning_content` is echoed back —
  the agent loop is a tool loop, so it is disabled at the wire (`llm_core._apply_deepseek_thinking_off`).
- **Forced `tool_choice: required` is gated by the known-rejecter DENYLIST** (`_TOOL_CHOICE_REJECTERS`, not
  a GLM allow-list — any non-listed model, e.g. GLM or an OpenAI model, still receives the forced rung).
  `deepseek-flash` joins the denylist (DeepSeek documents no `required`/forced-function support, and V4
  rejected it), so on DeepSeek the textual twin (P2-16) applies instead of the wire force.
- **Model names:** the legacy `deepseek-chat`/`deepseek-reasoner` were slated for discontinuation
  2026-07-24; the current ids are `deepseek-flash` (V4.1 Flash) and `deepseek-v4-pro`.
- **Portraits fail soft:** a DeepSeek host does not count as image-capable, so a DeepSeek-only box skips
  portraits silently.
- **Existing installs keep their effective models:** because `DEFAULT_SETTINGS` now says `deepseek-flash`,
  boot runs `pin_legacy_model_defaults` — an install that already has endpoints, none on DeepSeek, and no
  *saved* `default_model`/`utility_model` (e.g. right after an OOBE reset) gets the prior OOB pair
  (`z-ai/glm-4.7` + `qwen/qwen3.6-27b`) persisted for exactly the missing keys. Fresh installs and DeepSeek
  installs are untouched. The seed itself is lock-guarded (two workers cannot both create the endpoint) and
  recoverable (a lone seeded endpoint with an unbound default is re-bound on the next boot).
- **Owed live verification:** narration quality and the tool-call rate on `deepseek-flash` vs the GLM-4.7
  incumbent (the A/B above) — this amendment only changes the default.

