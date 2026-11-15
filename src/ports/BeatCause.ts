import { AsyncLocalStorage } from "node:async_hooks";

/**
 * ORW-439 - the cause context for the beat counter. DIAGNOSTIC ONLY.
 *
 * The outward MCP adapter runs every tool call inside `runInToolCall(name, fn)`; the engine's commit funnel
 * (`GameSessionAdapter.bumpBeatSeq`) reads `currentBeatCause()` to name the tool whose call caused the bump.
 * The context rides Node's AsyncLocalStorage, so it follows the call across awaits (several calls for one user
 * can be in flight and each keeps its own name) and into work the call scheduled (a deferred settle that lands
 * after the call returned is still attributed to the call that started it).
 *
 * It lives in `ports/` because both layers may import it: the outward adapter (which sets it) may not reach
 * the engine layer, and the engine adapter (which reads it) must not depend on the outward adapter.
 * It carries a tool NAME only: never arguments, never game state.
 */
export const OUTSIDE_A_TOOL_CALL = "outside-a-tool-call";

interface BeatCauseStore { readonly tool: string }
const storage = new AsyncLocalStorage<BeatCauseStore>();

/** Run `fn` with `tool` as the beat-bump cause. A nested call keeps the OUTERMOST tool (the one the caller dispatched). */
export function runInToolCall<T>(tool: string, fn: () => T): T {
  if (storage.getStore() !== undefined) return fn();
  return storage.run({ tool }, fn);
}

/** The tool whose call is running (or started the running work), or "outside-a-tool-call". */
export function currentBeatCause(): string {
  return storage.getStore()?.tool ?? OUTSIDE_A_TOOL_CALL;
}
