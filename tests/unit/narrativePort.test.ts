import { describe, it, expect } from "vitest";
import type { NarrationContext } from "../../src/ports/NarrativePort";
import { DeterministicNarrator } from "../../src/adapters/narrative/DeterministicNarrator";
import { loadNarratorConfig } from "../../src/adapters/narrative/narratorConfig";
import {
  LlmNarrativePort,
  buildProviderRequest,
  buildBody,
  buildHeaders,
  extractText,
  safeFallbackLine,
  type NarratorTransport,
} from "../../src/adapters/narrative/LlmNarrativePort";
import { PLAYER, npc } from "../../src/domain/ids";

const ctx: NarrationContext = {
  forEntity: PLAYER,
  mode: "scene",
  visibleEvents: [
    { id: "e1", ts: 1, type: "house-event", initiator: npc(1), witnessSet: [PLAYER, npc(1)], hidden: false, content: "A house meeting was called." },
  ],
  knowledge: [],
  systemPrompt: "You are the house.",
};

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("0027 — NarrativePort LLM adapter (voices, never decides)", () => {
  it("the deterministic narrator streams to exactly the full narration", async () => {
    const narrator = new DeterministicNarrator(3);
    const full = await narrator.narrate(ctx);
    const chunks = await collect(narrator.narrateStream(ctx));
    expect(chunks.join("")).toBe(full); // streaming == full
    expect(chunks.length).toBeGreaterThan(1); // genuinely chunked
    expect(await narrator.narrate(ctx)).toBe(full); // deterministic
  });

  it("config comes from env (ORWELL_* primary, BBAI_* fallback); no secret default", () => {
    const def = loadNarratorConfig({});
    expect(def.provider).toBe("ollama");
    expect(def.apiKey).toBeUndefined(); // never a literal in source

    const cfg = loadNarratorConfig({
      ORWELL_NARRATOR_PROVIDER: "anthropic",
      ORWELL_NARRATOR_ENDPOINT: "https://example.test",
      ORWELL_NARRATOR_MODEL: "m1",
      ORWELL_NARRATOR_API_KEY: "from-env",
    });
    expect(cfg).toMatchObject({ provider: "anthropic", endpoint: "https://example.test", model: "m1", apiKey: "from-env" });

    expect(loadNarratorConfig({ BBAI_NARRATOR_MODEL: "fallback" }).model).toBe("fallback"); // silent BBAI_* fallback
    expect(loadNarratorConfig({ ORWELL_NARRATOR_PROVIDER: "bogus" }).provider).toBe("ollama"); // unknown → safe default
  });

  it("builds provider-agnostic requests (routing, headers, body) from the same context", () => {
    for (const provider of ["ollama", "anthropic", "openai"] as const) {
      const req = buildProviderRequest(
        { provider, endpoint: "http://h", model: "m", apiKey: "K", timeoutMs: 1, maxRetries: 0 },
        ctx,
      );
      expect(req.url.startsWith("http://h")).toBe(true);
      const headers = buildHeaders(req);
      const body = buildBody(req) as Record<string, unknown>;
      if (provider === "anthropic") {
        expect(headers["x-api-key"]).toBe("K");
        expect(headers["authorization"]).toBeUndefined();
        expect(body["system"]).toBeTypeOf("string");
      } else if (provider === "openai") {
        expect(headers["authorization"]).toBe("Bearer K");
        expect((body["messages"] as Array<{ role: string }>)[0]!.role).toBe("system");
      } else {
        expect(headers["authorization"]).toBeUndefined(); // local ollama needs no key
        expect(body["stream"]).toBe(false);
      }
    }
  });

  it("extracts narration text from each provider's response shape", () => {
    expect(extractText("anthropic", { content: [{ text: "a" }, { text: "b" }] })).toBe("ab");
    expect(extractText("openai", { choices: [{ message: { content: "hi" } }] })).toBe("hi");
    expect(extractText("ollama", { message: { content: "yo" } })).toBe("yo");
    expect(extractText("ollama", {})).toBe(""); // tolerant of an empty shape
  });

  it("a provider failure degrades to the safe fallback (bounded retries) and changes no state", async () => {
    const erroring: NarratorTransport = {
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("provider timed out");
      },
    };
    const port = new LlmNarrativePort(
      { provider: "ollama", endpoint: "http://h", model: "m", apiKey: undefined, timeoutMs: 50, maxRetries: 0 },
      erroring,
    );
    expect(await port.narrate(ctx)).toBe(safeFallbackLine(ctx)); // plain, deterministic, Vault-free
  });

  it("retries up to the bound, then succeeds; the stream concatenates to narrate", async () => {
    let calls = 0;
    const flaky: NarratorTransport = {
      async *stream() {
        calls++;
        if (calls < 2) throw new Error("transient");
        yield "Once ";
        yield "upon";
      },
    };
    const port = new LlmNarrativePort(
      { provider: "ollama", endpoint: "http://h", model: "m", apiKey: undefined, timeoutMs: 50, maxRetries: 2 },
      flaky,
    );
    expect(await port.narrate(ctx)).toBe("Once upon");
    expect(calls).toBe(2); // one retry consumed
  });

  it("only voices the engine's text — it returns text, never a winner/state mutation", async () => {
    // A 'hallucinating' provider claims a bogus result; the port still only returns text.
    const hallucinating: NarratorTransport = {
      async *stream() {
        yield "And the winner is nobody at all.";
      },
    };
    const port = new LlmNarrativePort(
      { provider: "ollama", endpoint: "http://h", model: "m", apiKey: undefined, timeoutMs: 50, maxRetries: 0 },
      hallucinating,
    );
    const text = await port.narrate(ctx);
    expect(typeof text).toBe("string"); // a string — no handle to game state exists on the port
  });
});

// ── A86: LlmNarrativePort edge cases (empty reply, mid-stream failure, timeout/retry, maxRetries=0, early consumer stop). ───────────────────────────────────────────────────────────────────
import { vi } from "vitest";
import type { ProviderRequest } from "../../src/adapters/narrative/LlmNarrativePort";

const baseCfg = loadNarratorConfig({ ORWELL_NARRATOR_PROVIDER: "openai", ORWELL_NARRATOR_ENDPOINT: "https://example.test", ORWELL_NARRATOR_MODEL: "m" });
const portWith = (over: { maxRetries?: number; timeoutMs?: number }, transport: NarratorTransport) =>
  new LlmNarrativePort({ ...baseCfg, maxRetries: over.maxRetries ?? 0, timeoutMs: over.timeoutMs ?? 1000 }, transport);
const scripted = (attempts: Array<() => AsyncGenerator<string>>): NarratorTransport & { calls: number } => {
  const t = { calls: 0, stream(_r: ProviderRequest, _s: AbortSignal) { return attempts[Math.min(t.calls++, attempts.length - 1)]!(); } };
  return t;
};

describe("A86 - the narrator adapter's resilience edges", () => {
  it("an upstream reply with EMPTY text is not a narration: it falls back to the safe line (it used to yield \"\" and silently narrate nothing)", async () => {
    const t = scripted([async function* () { yield ""; }]);
    const port = portWith({ maxRetries: 0 }, t);
    const chunks = await collect(port.narrateStream(ctx));
    expect(chunks).toEqual([safeFallbackLine(ctx)]);
    expect(await port.narrate(ctx)).toBe(safeFallbackLine(ctx));
  });

  it("an empty reply is retried (bounded) and a later real reply is voiced", async () => {
    const t = scripted([async function* () { yield ""; }, async function* () { yield "Voiced."; }]);
    const port = portWith({ maxRetries: 2 }, t);
    expect(await collect(port.narrateStream(ctx))).toEqual(["Voiced."]);
    expect(t.calls).toBe(2);
  });

  it("an empty delta BEFORE a real one is not voiced, and the stream still equals narrate()", async () => {
    const t = scripted([async function* () { yield ""; yield "Real"; yield ""; yield " text"; }]);
    const port = portWith({ maxRetries: 0 }, t);
    const chunks = await collect(port.narrateStream(ctx));
    expect(chunks).toEqual(["Real", " text"]);
    expect(await portWith({ maxRetries: 0 }, scripted([async function* () { yield ""; yield "Real"; yield ""; yield " text"; }])).narrate(ctx)).toBe(chunks.join(""));
  });

  it("a mid-stream failure keeps what was voiced and does NOT retry or append the fallback", async () => {
    const t = scripted([async function* () { yield "Half a "; throw new Error("socket reset"); }, async function* () { yield "SHOULD NOT APPEAR"; }]);
    const port = portWith({ maxRetries: 3 }, t);
    const chunks = await collect(port.narrateStream(ctx));
    expect(chunks).toEqual(["Half a "]);
    expect(t.calls).toBe(1);
    expect(await portWith({ maxRetries: 3 }, scripted([async function* () { yield "Half a "; throw new Error("x"); }])).narrate(ctx)).toBe("Half a ");
  });

  it("maxRetries = 0 goes straight to the fallback on the first failure (one attempt)", async () => {
    const t = scripted([async function* () { throw new Error("HTTP 500"); }]);
    const port = portWith({ maxRetries: 0 }, t);
    expect(await collect(port.narrateStream(ctx))).toEqual([safeFallbackLine(ctx)]);
    expect(t.calls).toBe(1);
  });

  it("failures retry up to maxRetries (attempts = maxRetries + 1), then the fallback; a success on the last attempt wins", async () => {
    const fail = async function* (): AsyncGenerator<string> { throw new Error("HTTP 503"); };
    const all = scripted([fail]);
    expect(await collect(portWith({ maxRetries: 2 }, all).narrateStream(ctx))).toEqual([safeFallbackLine(ctx)]);
    expect(all.calls).toBe(3);
    const last = scripted([fail, fail, async function* () { yield "Third time."; }]);
    expect(await collect(portWith({ maxRetries: 2 }, last).narrateStream(ctx))).toEqual(["Third time."]);
    expect(last.calls).toBe(3);
  });

  it("the timeout aborts via the signal and counts as a failed attempt (retried up to maxRetries, then the fallback)", async () => {
    let aborted = 0;
    const hang: NarratorTransport & { calls: number } = {
      calls: 0,
      stream(_r, signal) {
        hang.calls++;
        return (async function* () {
          await new Promise<void>((_res, rej) => signal.addEventListener("abort", () => { aborted++; rej(new Error("aborted")); }));
          yield "never";
        })();
      },
    };
    const out = await collect(portWith({ maxRetries: 1, timeoutMs: 20 }, hang).narrateStream(ctx));
    expect(out).toEqual([safeFallbackLine(ctx)]);
    expect(hang.calls).toBe(2);
    expect(aborted).toBe(2);
  });

  it("the abort timer is cleared when the consumer stops early (no leaked timer)", async () => {
    vi.useFakeTimers();
    try {
      const t = scripted([async function* () { yield "one"; yield "two"; }]);
      const it = portWith({ maxRetries: 0, timeoutMs: 60_000 }, t).narrateStream(ctx)[Symbol.asyncIterator]();
      expect((await it.next()).value).toBe("one");
      expect(vi.getTimerCount(), "the abort timer is pending while streaming").toBe(1);
      await it.return?.();
      expect(vi.getTimerCount(), "stopping early must clear the abort timer").toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
