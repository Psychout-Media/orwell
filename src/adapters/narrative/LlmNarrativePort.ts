import type { StreamingNarrativePort } from "../../ports/StreamingNarrativePort";
import type { NarrationContext } from "../../ports/NarrativePort";
import {
  loadNarratorConfig,
  providerPath,
  type NarratorConfig,
  type NarratorProvider,
} from "./narratorConfig";

/**
 * The real narrator (feature 0027): a provider-agnostic LLM behind
 * `StreamingNarrativePort`, replacing the echo stub. It is handed ONLY the
 * Vault-free `NarrationContext`, so it is Vault-free by construction; it returns
 * *text*, never state, so it can never change an engine-decided outcome.
 *
 * The HTTP call is behind an injectable `NarratorTransport` so the provider
 * routing is testable offline and resilience (timeout / bounded retries / safe
 * fallback) is deterministic. In the deployed fold the front-end's `llm_core`
 * realizes the same port over MCP with true SSE streaming (0027 §6, §8).
 */

/** A built, provider-shaped request — the only thing the transport sees. */
export interface ProviderRequest {
  provider: NarratorProvider;
  url: string;
  model: string;
  system: string;
  user: string;
  apiKey: string | undefined;
}

/** The seam over the actual network call; default is {@link FetchNarratorTransport}. */
export interface NarratorTransport {
  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<string>;
}

const DEFAULT_PERSONA =
  "You are the voice of the Big Brother house — narrator, game master, and every houseguest. " +
  "Voice the given moment in character. The engine decides every outcome; you only narrate it.";

/** System framing = the managed moment prompt (0018) when present, else a plain persona. */
export function composeSystem(context: NarrationContext): string {
  const moment = context.systemPrompt?.trim();
  return moment && moment.length > 0 ? moment : DEFAULT_PERSONA;
}

/** The user turn = the Vault-free beats to voice. Reads ONLY the context. */
export function composeUser(context: NarrationContext): string {
  const beats = context.visibleEvents.map((e) => `- [${e.type}] ${e.content}`).join("\n");
  const known = context.knowledge.map((k) => `- (${k.pathway}) ${k.content}`).join("\n");
  return [
    `Narrate this ${context.mode} for the player. Voice only what is given here; never invent an outcome.`,
    beats ? `Witnessed:\n${beats}` : "",
    known ? `Known to the player:\n${known}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Pure: assemble the provider request from config + Vault-free context. */
export function buildProviderRequest(cfg: NarratorConfig, context: NarrationContext): ProviderRequest {
  return {
    provider: cfg.provider,
    url: cfg.endpoint + providerPath(cfg.provider),
    model: cfg.model,
    system: composeSystem(context),
    user: composeUser(context),
    apiKey: cfg.apiKey,
  };
}

/** Pure: the provider-specific request body. */
export function buildBody(req: ProviderRequest): unknown {
  if (req.provider === "anthropic") {
    return { model: req.model, system: req.system, max_tokens: 1024, messages: [{ role: "user", content: req.user }] };
  }
  // ollama (/api/chat) and openai-compatible (/chat/completions) share the messages shape.
  return {
    model: req.model,
    stream: false,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
  };
}

/** Pure: the provider-specific headers. The key comes only from the (env-sourced) request. */
export function buildHeaders(req: ProviderRequest): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (req.provider === "anthropic") {
    if (req.apiKey) headers["x-api-key"] = req.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (req.provider === "openai") {
    if (req.apiKey) headers["authorization"] = `Bearer ${req.apiKey}`;
  }
  return headers;
}

/** Pure: pull the narration text out of a provider response shape. */
export function extractText(provider: NarratorProvider, json: unknown): string {
  const j = (json ?? {}) as Record<string, unknown>;
  if (provider === "anthropic") {
    const content = j["content"];
    return Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? "").join("") : "";
  }
  if (provider === "openai") {
    const choices = j["choices"];
    const first = Array.isArray(choices) ? (choices[0] as { message?: { content?: string } }) : undefined;
    return first?.message?.content ?? "";
  }
  const message = j["message"] as { content?: string } | undefined;
  if (message?.content) return message.content;
  return typeof j["response"] === "string" ? (j["response"] as string) : "";
}

/**
 * A plain, deterministic, Vault-free fallback line for a hard narration failure.
 * The beat was already resolved by the engine — narration is presentation — so a
 * failure degrades to this line and changes NO game state.
 */
export function safeFallbackLine(context: NarrationContext): string {
  return `[${context.mode}] The house settles into a quiet beat.`;
}

/** Default transport: a single fetch POST, response parsed to one delta (front-end SSE streams live). */
export class FetchNarratorTransport implements NarratorTransport {
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async *stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<string> {
    const res = await this.fetchFn(req.url, {
      method: "POST",
      headers: buildHeaders(req),
      body: JSON.stringify(buildBody(req)),
      signal,
    });
    if (!res.ok) throw new Error(`narrator provider HTTP ${res.status}`);
    yield extractText(req.provider, await res.json());
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const backoffMs = (attempt: number): number => Math.min(1000, 10 * 2 ** attempt);

export class LlmNarrativePort implements StreamingNarrativePort {
  constructor(
    private readonly cfg: NarratorConfig,
    private readonly transport: NarratorTransport = new FetchNarratorTransport(),
  ) {}

  async *narrateStream(context: NarrationContext): AsyncIterable<string> {
    const req = buildProviderRequest(this.cfg, context);
    let everYielded = false;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
      try {
        for await (const delta of this.transport.stream(req, controller.signal)) {
          if (delta.length === 0) continue; // A86: an empty delta is not a narration - never count it as "voiced" (it used to make a blank reply look like success)
          everYielded = true;
          yield delta;
        }
        if (everYielded) return; // clean completion with something voiced
        // A86: the provider answered but said NOTHING: treat it as a failed attempt (bounded retry, then the safe fallback), not a silent blank narration.
        if (attempt < this.cfg.maxRetries) await delay(backoffMs(attempt));
      } catch {
        if (everYielded) return; // mid-stream failure: keep what was voiced, stop
        if (attempt < this.cfg.maxRetries) await delay(backoffMs(attempt));
      } finally {
        clearTimeout(timer); // A86: also when the consumer stops early (iterator.return()) - no leaked abort timer
      }
    }
    // Hard failure, nothing voiced → safe fallback (the engine already settled the beat).
    yield safeFallbackLine(context);
  }

  async narrate(context: NarrationContext): Promise<string> {
    let full = "";
    for await (const delta of this.narrateStream(context)) full += delta;
    return full;
  }
}

/** Compose the engine-side real narrator from env (provider/model/key) + default transport. */
export function buildStreamingNarrator(
  env: Record<string, string | undefined> = process.env,
  transport?: NarratorTransport,
): StreamingNarrativePort {
  return new LlmNarrativePort(loadNarratorConfig(env), transport);
}
