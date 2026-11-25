# spec-only: gated by frontend/tests/test_0112_llm_observability.py; this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
Feature: 0112 — LLM-call observability (Vault-free trace tagging + opt-in external forwarding)
  Every LLM call emits a Vault-free trace record (the token-ledger facts PLUS the 0065 beatSeq/phase
  correlation keys) and, when enabled, tags the provider request with the same keys so OpenRouter Broadcast —
  or an opt-in OTLP/Langfuse sink — can forward correlatable traces off-box. The engine keeps the entire
  closed set and never participates; the FE owns the provider and the sink. Everything is opt-in, fail-soft,
  and byte-identical when unconfigured. This is always-on production live-verify telemetry for the exact gap
  the stubbed gates leave open — never a player-facing surface, never a Vault hole.

  # HARD: roles only, no names. Trace fields are engine ids + closed-set/projection facts only.

  Scenario: the trace record is Vault-free across every call class
    Given a live game emitting LLM calls of each call class
    When a trace record is built for a call
    Then the record carries only closed-set and projection facts — model, call class, beatSeq, phase, token
      counts, applied max tokens, cost, finish reason, tool-call-seen, latency, the canonical session and user
    And the record contains no soul, trust, threat, affinity, hidden-target, relationship, or confessional key
    And the record builder reads neither the Vault store nor the soul provider

  Scenario: provider request tagging is additive and byte-identical when absent
    Given observability is disabled
    When the provider request payload is built for an LLM call
    Then the payload is byte-identical to the pre-feature payload and carries no metadata key
    When observability is enabled
    Then the same payload gains a Vault-free metadata object with the session, beatSeq, phase, and call class
    And no other field of the payload changes

  Scenario: the sink is opt-in with a no-op default
    Given no observability endpoint is configured
    Then the resolved trace sink is the no-op adapter and nothing is shipped
    And the game plays exactly as it does today

  Scenario: a failing sink never harms the turn
    Given observability is enabled with a sink that errors or times out on every emit
    When the player takes a turn
    Then the turn completes and its reply is unaffected
    And the emit failure is swallowed — no exception propagates and the turn is not delayed

  Scenario: the trace correlates to the engine beat it served (ties to 0065)
    Given a live game that issues a monotonic beatSeq and a phase on each read or advance
    When an LLM call is made to narrate a given beat
    Then its trace record's beatSeq and phase equal the values the engine issued for that turn

  Scenario: privacy mode gates content; metrics always flow
    Given observability is enabled in metrics-only mode
    When a trace record is emitted
    Then it carries the metrics and correlation keys but no prompt and no completion content
    When observability is set to full mode
    Then the record additionally carries the prompt and completion
    And full mode is an explicit operator opt-in, defaulting off

  Scenario: sampling is deterministic by session
    Given observability is enabled with a sampling rate below one
    When many calls are emitted across sessions
    Then whether a session is sampled is a deterministic function of its id
    And a sampling rate of zero emits nothing while a rate of one emits every call

  Scenario: model-vs-engine divergence is expressible from the record alone (the F16 reach)
    Given a trace record whose completion asserts an eviction result
    And the record's phase is not an eviction phase
    Then the divergence is detectable from the record's own fields
    And the metadata makes the alert a query in the sink, not a live eviction drive

  Scenario: the observability path adds no player-facing or admin-facing surface
    Given the reduced game build
    Then no player surface and no admin surface exposes trace data or the sink configuration as game content
    And the only operator touch points are the observability settings, read per request

  Scenario: the trace path never depends on the Vault (structural boundary)
    Given the dependency boundary report over the trace-emitting modules
    Then no module on the trace path imports the Vault store, the vector index, or the soul provider
